/**
 * Auth service - phone-first with OTP.
 *
 * Flow:
 *  1. register(phone, password, fullName) → creates user (PENDING) + sends OTP
 *  2. verifyPhone(phone, code) → marks phone_verified_at, status=VERIFIED → returns tokens
 *  3. login(phone, password) → if not verified, requires verify-phone first
 *  4. forgotPassword(phone) → sends reset OTP
 *  5. resetPassword(phone, code, newPassword) → changes password, revokes all sessions
 */

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
import { createAndSendOtp, verifyOtp } from '../../utils/otp';
import { record, AuditAction } from '../audit/audit.service';
import { authRepository, type UserRow, type UserRole } from './auth.repository';
import {
  AccountSuspendedError,
  InvalidCredentialsError,
  PhoneTakenError,
  TokenExpiredError,
  TokenInvalidError,
  TokenReusedError,
} from './auth.errors';
import { AppError } from '../../errors';
import type {
  ForgotPasswordInput,
  LoginInput,
  RefreshInput,
  RegisterInput,
  ResetPasswordInput,
  VerifyPhoneInput,
} from './auth.schemas';

export interface PublicUser {
  id: string;
  phone: string;
  email: string | null;
  fullName: string;
  role: UserRole;
  status: 'PENDING' | 'VERIFIED' | 'SUSPENDED';
  phoneVerified: boolean;
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
    phone: row.phone,
    email: row.email,
    fullName: row.full_name,
    role: row.role,
    status: row.status,
    phoneVerified: row.phone_verified_at !== null,
    createdAt: row.created_at.toISOString(),
  };
}

function assertNotSuspended(user: UserRow): void {
  if (user.status === 'SUSPENDED') throw new AccountSuspendedError();
}

function assertPhoneVerified(user: UserRow): void {
  if (!user.phone_verified_at) {
    throw new AppError({
      code: 'AUTH_PHONE_NOT_VERIFIED',
      httpStatus: 403,
      message: 'Phone number is not verified',
    });
  }
}

export class AuthService {
  async register(
    input: RegisterInput,
    meta: RequestMeta,
  ): Promise<{ userId: string; phone: string; otpSent: boolean }> {
    if (await authRepository.phoneExists(input.phone)) {
      throw new PhoneTakenError();
    }

    const passwordHash = await hashPassword(input.password);
    const isAdminPhone = !!process.env.ADMIN_PHONE && process.env.ADMIN_PHONE === input.phone;
    const role: UserRole = isAdminPhone ? 'ADMIN' : 'SAVER';

    const user = await withTransaction(async (tx) => {
      const u = await authRepository.insertUser(
        {
          phone: input.phone,
          email: input.email ?? null,
          passwordHash,
          fullName: input.fullName,
          role,
        },
        tx,
      );
      await record(
        {
          actorId: u.id,
          action: AuditAction.USER_REGISTERED,
          entityType: 'user',
          entityId: u.id,
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
          metadata: { phone: u.phone, role: u.role },
        },
        tx,
      );
      return u;
    });

    const otpResult = await createAndSendOtp(input.phone, 'signup', meta.ipAddress);
    logger.info({ userId: user.id, phone: user.phone }, 'User registered, OTP dispatched');

    return { userId: user.id, phone: user.phone, otpSent: otpResult.ok };
  }

  async verifyPhone(input: VerifyPhoneInput, meta: RequestMeta): Promise<AuthResult> {
    const user = await authRepository.findUserByPhone(input.phone);
    if (!user) throw new InvalidCredentialsError();
    assertNotSuspended(user);

    const verify = await verifyOtp(input.phone, 'signup', input.code);
    if (!verify.ok) {
      throw new AppError({
        code: 'AUTH_OTP_INVALID',
        httpStatus: 400,
        message: verify.error ?? 'Invalid or expired code',
      });
    }

    const updated = await authRepository.markPhoneVerified(user.id);
    const tokens = await withTransaction(async (tx) => {
      const t = await this.issueTokens(updated, meta, tx);
      await record(
        {
          actorId: updated.id,
          action: 'PHONE_VERIFIED',
          entityType: 'user',
          entityId: updated.id,
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
        },
        tx,
      );
      return t;
    });

    return { user: toPublicUser(updated), tokens };
  }

  async login(input: LoginInput, meta: RequestMeta): Promise<AuthResult> {
    const user = await authRepository.findUserByPhone(input.phone);
    if (!user) {
      await record({
        actorId: null,
        action: AuditAction.LOGIN_FAILED,
        entityType: 'user',
        metadata: { phone: input.phone, reason: 'user_not_found' },
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
    assertPhoneVerified(user);

    const tokens = await withTransaction(async (tx) => {
      const t = await this.issueTokens(user, meta, tx);
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
      return t;
    });

    return { user: toPublicUser(user), tokens };
  }

  async forgotPassword(input: ForgotPasswordInput, meta: RequestMeta): Promise<{ ok: true }> {
    const user = await authRepository.findUserByPhone(input.phone);
    // Always return ok to prevent user enumeration
    if (!user) {
      logger.warn({ phone: input.phone }, 'forgot-password for unknown phone');
      return { ok: true };
    }
    if (user.status === 'SUSPENDED') {
      logger.warn({ userId: user.id }, 'forgot-password for suspended user');
      return { ok: true };
    }

    await createAndSendOtp(input.phone, 'reset', meta.ipAddress);
    logger.info({ userId: user.id }, 'Password reset OTP dispatched');
    return { ok: true };
  }

  async resetPassword(input: ResetPasswordInput, meta: RequestMeta): Promise<{ ok: true }> {
    const user = await authRepository.findUserByPhone(input.phone);
    if (!user) throw new InvalidCredentialsError();

    const verify = await verifyOtp(input.phone, 'reset', input.code);
    if (!verify.ok) {
      throw new AppError({
        code: 'AUTH_OTP_INVALID',
        httpStatus: 400,
        message: verify.error ?? 'Invalid or expired code',
      });
    }

    const passwordHash = await hashPassword(input.newPassword);
    await withTransaction(async (tx) => {
      await authRepository.updatePassword(user.id, passwordHash);
      await record(
        {
          actorId: user.id,
          action: 'PASSWORD_RESET',
          entityType: 'user',
          entityId: user.id,
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
        },
        tx,
      );
    });

    // Revoke all existing sessions after password reset
    await authRepository.revokeAllUserTokens(user.id);

    logger.info({ userId: user.id }, 'Password reset complete, sessions revoked');
    return { ok: true };
  }

  async refresh(input: RefreshInput, meta: RequestMeta): Promise<AuthResult> {
    let payload;
    try {
      payload = verifyRefreshToken(input.refreshToken);
    } catch (err) {
      if (err instanceof Error && err.name === 'TokenExpiredError') throw new TokenExpiredError();
      throw new TokenInvalidError();
    }

    const tokenHash = sha256(input.refreshToken);
    const existing = await authRepository.findRefreshTokenByHash(tokenHash);
    if (!existing) throw new TokenInvalidError('Refresh token not recognised');

    if (existing.revoked_at) {
      logger.warn({ userId: existing.user_id }, 'Refresh token reuse detected - revoking all');
      await authRepository.revokeAllUserTokens(existing.user_id);
      await record({
        actorId: existing.user_id,
        action: AuditAction.TOKEN_REUSED,
        entityType: 'refresh_token',
        entityId: existing.id,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });
      throw new TokenReusedError();
    }

    if (existing.expires_at.getTime() < Date.now()) throw new TokenExpiredError();

    const user = await authRepository.findUserById(payload.sub);
    if (!user) throw new TokenInvalidError('User no longer exists');
    assertNotSuspended(user);

    const result = await withTransaction(async (tx) => {
      const newTokens = await this.issueTokens(user, meta, tx);
      const newHash = sha256(newTokens.refreshToken);
      const newRow = await authRepository.findRefreshTokenByHash(newHash);
      await authRepository.revokeRefreshToken(existing.id, newRow?.id ?? null, tx);
      await record(
        {
          actorId: user.id,
          action: AuditAction.TOKEN_REFRESHED,
          entityType: 'refresh_token',
          entityId: existing.id,
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
        },
        tx,
      );
      return { user, tokens: newTokens };
    });

    return { user: toPublicUser(result.user), tokens: result.tokens };
  }

  async logout(input: RefreshInput, meta: RequestMeta): Promise<void> {
    const tokenHash = sha256(input.refreshToken);
    const row = await authRepository.findRefreshTokenByHash(tokenHash);
    if (!row || row.revoked_at) return;

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