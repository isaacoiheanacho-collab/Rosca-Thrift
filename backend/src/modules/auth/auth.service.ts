/**
 * Auth service — business logic for registration, login, token refresh, logout.
 *
 * Rules enforced here:
 *  - Registration is atomic (user row + first refresh token in one transaction).
 *  - Every successful and failed auth attempt is written to audit_logs.
 *  - Refresh tokens are rotated: each use issues a new token and revokes the old.
 *  - If a revoked refresh token is presented again → all user sessions revoked
 *    (OAuth 2.0 BCP for theft detection).
 */

import { randomUUID } from 'node:crypto';
import { withTransaction } from '../../db';
import { logger } from '../../logger';
import { hashPassword, verifyPassword } from '../../utils/password';
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  refreshTokenExpiryDate,
} from '../../utils/jwt';
import { sha256 } from '../../utils/hash';
import { record, AuditAction } from '../audit/audit.service';
import { authRepository, type UserRow } from './auth.repository';
import {
  AccountSuspendedError,
  EmailTakenError,
  InvalidCredentialsError,
  PhoneTakenError,
  TokenExpiredError,
  TokenInvalidError,
  TokenReusedError,
} from './auth.errors';
import type { LoginInput, RefreshInput, RegisterInput } from './auth.schemas';

export interface PublicUser {
  id: string;
  email: string | null;
  phone: string | null;
  fullName: string;
  role: 'SAVER' | 'ADMIN';
  status: 'PENDING' | 'VERIFIED' | 'SUSPENDED';
  createdAt: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface AuthResult {
  user: PublicUser;
  tokens: AuthTokens;
}

export interface RequestMeta {
  ipAddress?: string;
  userAgent?: string;
}

function toPublicUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    email: row.email,
    phone: row.phone,
    fullName: row.full_name,
    role: row.role,
    status: row.status,
    createdAt: row.created_at.toISOString(),
  };
}

function assertNotSuspended(user: UserRow): void {
  if (user.status === 'SUSPENDED') throw new AccountSuspendedError();
}

export class AuthService {
  async register(input: RegisterInput, meta: RequestMeta): Promise<AuthResult> {
    if (input.email && (await authRepository.emailExists(input.email))) {
      throw new EmailTakenError();
    }

    if (input.phone && (await authRepository.phoneExists(input.phone))) {
      throw new PhoneTakenError();
    }

    const passwordHash = await hashPassword(input.password);

    const result = await withTransaction(async (tx) => {
      const user = await authRepository.insertUser(
        {
          email: input.email ?? null,
          phone: input.phone ?? null,
          passwordHash,
          fullName: input.fullName,
        },
        tx,
      );

      const tokens = await this.issueTokens(user, meta, tx);

      await record(
        {
          actorId: user.id,
          action: AuditAction.USER_REGISTERED,
          entityType: 'user',
          entityId: user.id,
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
          metadata: { email: user.email, phone: user.phone },
        },
        tx,
      );

      return { user, tokens };
    });

    logger.info({ userId: result.user.id }, 'User registered');

    return {
      user: toPublicUser(result.user),
      tokens: result.tokens,
    };
  }

  async login(input: LoginInput, meta: RequestMeta): Promise<AuthResult> {
    const user = await authRepository.findUserByEmailOrPhone(input.email, input.phone);

    if (!user) {
      await record({
        actorId: null,
        action: AuditAction.LOGIN_FAILED,
        entityType: 'user',
        metadata: {
          email: input.email,
          phone: input.phone,
          reason: 'user_not_found',
        },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });

      throw new InvalidCredentialsError();
    }

    const passwordOk = await verifyPassword(input.password, user.password_hash);

    if (!passwordOk) {
      await record({
        actorId: user.id,
        action: AuditAction.LOGIN_FAILED,
        entityType: 'user',
        entityId: user.id,
        metadata: { reason: 'bad_password' },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });

      throw new InvalidCredentialsError();
    }

    assertNotSuspended(user);

    const tokens = await withTransaction(async (tx) => {
      const issuedTokens = await this.issueTokens(user, meta, tx);

      await record(
        {
          actorId: user.id,
          action: AuditAction.USER_LOGGED_IN,
          entityType: 'user',
          entityId: user.id,
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
        },
        tx,
      );

      return issuedTokens;
    });

    logger.info({ userId: user.id }, 'User logged in');

    return {
      user: toPublicUser(user),
      tokens,
    };
  }

  async refresh(input: RefreshInput, meta: RequestMeta): Promise<AuthResult> {
    // 1. Verify JWT signature + type.
    let payload;

    try {
      payload = verifyRefreshToken(input.refreshToken);
    } catch (err) {
      if (err instanceof Error && err.name === 'TokenExpiredError') {
        throw new TokenExpiredError();
      }

      throw new TokenInvalidError();
    }

    // 2. Find the database record by its hash.
    const tokenHash = sha256(input.refreshToken);
    const record_ = await authRepository.findRefreshTokenByHash(tokenHash);

    if (!record_) {
      throw new TokenInvalidError('Refresh token not recognised');
    }

    // 3. Reuse detection — an already-revoked token implies possible theft.
    if (record_.revoked_at) {
      logger.warn(
        { userId: record_.user_id },
        'Refresh token reuse detected — revoking all',
      );

      await authRepository.revokeAllUserTokens(record_.user_id);

      await record({
        actorId: record_.user_id,
        action: AuditAction.TOKEN_REUSED,
        entityType: 'refresh_token',
        entityId: record_.id,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });

      throw new TokenReusedError();
    }

    // 4. Check persisted expiry as well as JWT expiry.
    if (record_.expires_at.getTime() < Date.now()) {
      throw new TokenExpiredError();
    }

    // 5. Load the user and check account status.
    const user = await authRepository.findUserById(payload.sub);

    if (!user) {
      throw new TokenInvalidError('User no longer exists');
    }

    assertNotSuspended(user);

    // 6. Rotate: issue a replacement, then revoke and link the old token.
    const result = await withTransaction(async (tx) => {
      const newTokens = await this.issueTokens(user, meta, tx);
      const newHash = sha256(newTokens.refreshToken);
      const newRow = await authRepository.findRefreshTokenByHash(newHash);

      await authRepository.revokeRefreshToken(record_.id, newRow?.id ?? null, tx);

      await record(
        {
          actorId: user.id,
          action: AuditAction.TOKEN_REFRESHED,
          entityType: 'refresh_token',
          entityId: record_.id,
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
        },
        tx,
      );

      return { user, tokens: newTokens };
    });

    return {
      user: toPublicUser(result.user),
      tokens: result.tokens,
    };
  }

  async logout(input: RefreshInput, meta: RequestMeta): Promise<void> {
    const tokenHash = sha256(input.refreshToken);
    const row = await authRepository.findRefreshTokenByHash(tokenHash);

    // Logout is intentionally idempotent.
    if (!row || row.revoked_at) {
      return;
    }

    await withTransaction(async (tx) => {
      await authRepository.revokeRefreshToken(row.id, null, tx);

      await record(
        {
          actorId: row.user_id,
          action: AuditAction.LOGOUT,
          entityType: 'refresh_token',
          entityId: row.id,
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
        },
        tx,
      );
    });
  }

  // ---- internals ----

  private async issueTokens(
    user: UserRow,
    meta: RequestMeta,
    tx: Parameters<Parameters<typeof withTransaction>[0]>[0],
  ): Promise<AuthTokens> {
    const accessToken = signAccessToken(user.id, user.role);
    const refreshToken = signRefreshToken(user.id, user.role);
    const tokenHash = sha256(refreshToken);

    await authRepository.insertRefreshToken(
      {
        userId: user.id,
        tokenHash,
        expiresAt: refreshTokenExpiryDate(),
        userAgent: meta.userAgent ?? null,
        ipAddress: meta.ipAddress ?? null,
      },
      tx,
    );

    return { accessToken, refreshToken };
  }
}

export const authService = new AuthService();

// Re-export for convenience
export { randomUUID };