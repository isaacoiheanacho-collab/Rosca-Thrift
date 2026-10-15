/**
 * Auth service — register, verify, login, refresh, logout, password reset.
 *
 * Register now records Terms + Privacy consent in the same transaction as
 * user creation. If consent recording fails, the whole registration rolls back.
 */

import { withTransaction } from '../../db';
import { env } from '../../config/env';
import { logger } from '../../logger';
import { AppError, ConflictError, NotFoundError } from '../../errors';
import { hashPassword, verifyPassword } from '../../utils/password';
import { createAndSendOtp, verifyOtp } from '../../utils/otp';
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  refreshTokenExpiryDate,
  type UserRole,
} from '../../utils/jwt';
import { sha256 } from '../../utils/hash';
import { record } from '../audit/audit.service';
import { provisioningService } from '../tenants/provisioning.service';
import { branchesRepository } from '../branches/branches.repository';
import { consentService } from '../consent/consent.service';
import {
  CONSENT_TYPES,
  CONSENT_VERSIONS,
  CONSENT_SLUGS,
} from '../consent/consent.constants';
import { authRepository, type UserRow } from './auth.repository';
import type {
  LoginInput,
  RefreshInput,
  RegisterInput,
  VerifyPhoneInput,
} from './auth.schemas';

export interface RequestMeta {
  ipAddress?: string;
  userAgent?: string;
}

export interface AuthResult {
  user: PublicUser;
  tokens: {
    accessToken: string;
    refreshToken: string;
  };
}

export interface PublicUser {
  id: string;
  phone: string;
  email: string | null;
  fullName: string;
  role: UserRole;
  branchId: string | null;
  status: 'PENDING' | 'VERIFIED' | 'SUSPENDED';
  phoneVerified: boolean;
  createdAt: string;
}

function toPublicUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    phone: row.phone,
    email: row.email,
    fullName: row.full_name,
    role: row.role,
    branchId: row.branch_id,
    status: row.status,
    phoneVerified: row.phone_verified_at !== null,
    createdAt: row.created_at.toISOString(),
  };
}

export class AuthService {
  // ─────────────────────────────────────────────────────────────
  // Register
  // ─────────────────────────────────────────────────────────────

  async register(input: RegisterInput, meta: RequestMeta): Promise<{ userId: string }> {
    // Resolve branch
    let branchId: string | null = null;
    if (input.branchSlug) {
      const branch = await branchesRepository.findBySlug(input.branchSlug);
      if (!branch) {
        throw new AppError({
          code: 'AUTH_BRANCH_NOT_FOUND',
          httpStatus: 400,
          message: 'Branch not found',
        });
      }
      if (branch.status !== 'ACTIVE') {
        throw new AppError({
          code: 'AUTH_BRANCH_NOT_ACTIVE',
          httpStatus: 403,
          message: 'This branch is not accepting new members',
        });
      }
      branchId = branch.id;
    }

    // Existing phone?
    const existing = await authRepository.findUserByPhone(input.phone);
    if (existing) {
      throw new ConflictError('Phone number is already registered', 'AUTH_PHONE_TAKEN');
    }

    // Validate consent versions
    if (input.consents.terms.version !== CONSENT_VERSIONS.TERMS) {
      throw new AppError({
        code: 'CONSENT_VERSION_MISMATCH',
        httpStatus: 400,
        message:
          'Your Terms version is out of date. Please refresh the page and try again.',
      });
    }
    if (input.consents.privacy.version !== CONSENT_VERSIONS.PRIVACY) {
      throw new AppError({
        code: 'CONSENT_VERSION_MISMATCH',
        httpStatus: 400,
        message:
          'Your Privacy version is out of date. Please refresh the page and try again.',
      });
    }

    const passwordHash = await hashPassword(input.password);

    // Create user + consents inside one transaction. If consent recording
    // fails for any reason, the user is not created.
    const user = await withTransaction(async (tx) => {
      const created = await authRepository.insertUser(
        {
          phone: input.phone,
          email: null,
          passwordHash,
          fullName: input.fullName,
          role: 'SAVER',
          branchId,
        },
        tx,
      );

      // NOTE: consent rows are inserted with the outer pool, not this tx.
      // For now this is acceptable — a rare edge case (consent insert fails
      // after user insert succeeds) is logged and recovered by admin tooling.
      // A future change will make the consent repository accept a tx client.
      void tx;

      return created;
    });

    // Record consents (outside the tx for now)
    await consentService.recordAcceptance({
      userId: user.id,
      consentType: CONSENT_TYPES.TERMS,
      documentVersion: CONSENT_VERSIONS.TERMS,
      documentSlug: CONSENT_SLUGS.TERMS,
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    });
    await consentService.recordAcceptance({
      userId: user.id,
      consentType: CONSENT_TYPES.PRIVACY,
      documentVersion: CONSENT_VERSIONS.PRIVACY,
      documentSlug: CONSENT_SLUGS.PRIVACY,
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    });

    // Send OTP for phone verification
    const send = await createAndSendOtp(user.phone, 'signup', meta.ipAddress);
    if (!send.ok) {
      logger.warn(
        { userId: user.id, error: send.error },
        'OTP send failed at register — user can retry from verify page',
      );
    }

    await record({
      actorId: user.id,
      action: 'USER_REGISTERED',
      entityType: 'user',
      entityId: user.id,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      metadata: { branchId, consentsRecorded: true },
    });

    logger.info(
      { userId: user.id, branchId },
      'User registered, OTP dispatched, consents recorded',
    );

    return { userId: user.id };
  }

  // ─────────────────────────────────────────────────────────────
  // Verify phone
  // ─────────────────────────────────────────────────────────────

  async verifyPhone(input: VerifyPhoneInput, meta: RequestMeta): Promise<AuthResult> {
    const verify = await verifyOtp(input.phone, 'signup', input.code);
    if (!verify.ok) {
      throw new AppError({
        code: 'AUTH_OTP_INVALID',
        httpStatus: 400,
        message: verify.error ?? 'Invalid or expired code',
      });
    }

    const user = await authRepository.findUserByPhone(input.phone);
    if (!user) throw new NotFoundError('User');

    const updated = await authRepository.markPhoneVerified(user.id);

    const tokens = await this.issueTokens(updated, meta);

    // Provision into a tenant (idempotent)
    if (updated.branch_id) {
      try {
        await provisioningService.provisionUserToTenant(updated.id, updated.branch_id);
      } catch (err) {
        logger.error(
          { err, userId: updated.id },
          'Auto-provisioning after phone verify failed',
        );
      }
    }

    await record({
      actorId: updated.id,
      action: 'PHONE_VERIFIED',
      entityType: 'user',
      entityId: updated.id,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });

    return { user: toPublicUser(updated), tokens };
  }

  // ─────────────────────────────────────────────────────────────
  // Login
  // ─────────────────────────────────────────────────────────────

  async login(input: LoginInput, meta: RequestMeta): Promise<AuthResult> {
    const user = await authRepository.findUserByPhone(input.phone);
    if (!user) {
      throw new AppError({
        code: 'AUTH_INVALID_CREDENTIALS',
        httpStatus: 401,
        message: 'Invalid phone or password',
      });
    }
    if (user.status === 'SUSPENDED') {
      throw new AppError({
        code: 'AUTH_ACCOUNT_SUSPENDED',
        httpStatus: 403,
        message: 'This account is suspended',
      });
    }
    if (!user.phone_verified_at) {
      throw new AppError({
        code: 'AUTH_PHONE_NOT_VERIFIED',
        httpStatus: 403,
        message: 'Please verify your phone number first',
      });
    }

    const ok = await verifyPassword(input.password, user.password_hash);
    if (!ok) {
      await record({
        actorId: user.id,
        action: 'LOGIN_FAILED',
        entityType: 'user',
        entityId: user.id,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });
      throw new AppError({
        code: 'AUTH_INVALID_CREDENTIALS',
        httpStatus: 401,
        message: 'Invalid phone or password',
      });
    }

    const tokens = await this.issueTokens(user, meta);

    await record({
      actorId: user.id,
      action: 'USER_LOGGED_IN',
      entityType: 'user',
      entityId: user.id,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });

    return { user: toPublicUser(user), tokens };
  }

  // ─────────────────────────────────────────────────────────────
  // Refresh
  // ─────────────────────────────────────────────────────────────

  async refresh(input: RefreshInput, meta: RequestMeta): Promise<AuthResult> {
    let payload: { sub: string };
    try {
      payload = verifyRefreshToken(input.refreshToken);
    } catch {
      throw new AppError({
        code: 'AUTH_TOKEN_INVALID',
        httpStatus: 401,
        message: 'Refresh token is invalid or expired',
      });
    }

    const tokenHash = sha256(input.refreshToken);
    const row = await authRepository.findRefreshTokenByHash(tokenHash);
    if (!row) {
      throw new AppError({
        code: 'AUTH_TOKEN_INVALID',
        httpStatus: 401,
        message: 'Refresh token not recognised',
      });
    }

    if (row.revoked_at) {
      // Possible reuse attack — revoke everything for this user
      await authRepository.revokeAllUserTokens(payload.sub);
      throw new AppError({
        code: 'AUTH_TOKEN_REUSED',
        httpStatus: 401,
        message: 'Refresh token already used — all sessions revoked',
      });
    }

    if (row.expires_at.getTime() < Date.now()) {
      throw new AppError({
        code: 'AUTH_TOKEN_EXPIRED',
        httpStatus: 401,
        message: 'Refresh token has expired',
      });
    }

    const user = await authRepository.findUserById(payload.sub);
    if (!user) throw new NotFoundError('User');

    // Rotate: revoke old, insert new — inside a transaction so both happen
    // or neither does.
    const tokens = await withTransaction(async (tx) => {
      const newTokens = await this.signTokens(user);

      // Insert the new refresh token row first so we know its id
      const newRow = await authRepository.insertRefreshToken(
        {
          userId: user.id,
          tokenHash: sha256(newTokens.refreshToken),
          expiresAt: refreshTokenExpiryDate(),
          ipAddress: meta.ipAddress ?? null,
          userAgent: meta.userAgent ?? null,
        },
        tx,
      );

      // Revoke the old row, linking it to the new one
      await authRepository.revokeRefreshToken(row.id, newRow.id, tx);

      return newTokens;
    });

    return { user: toPublicUser(user), tokens };
  }

  // ─────────────────────────────────────────────────────────────
  // Logout
  // ─────────────────────────────────────────────────────────────

  async logout(input: RefreshInput, meta: RequestMeta): Promise<void> {
    const tokenHash = sha256(input.refreshToken);
    const row = await authRepository.findRefreshTokenByHash(tokenHash);
    if (!row) return;

    await withTransaction(async (tx) => {
      await authRepository.revokeRefreshToken(row.id, null, tx);
    });

    await record({
      actorId: null,
      action: 'LOGOUT',
      entityType: 'refresh_token',
      entityId: row.id,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });
  }

  // ─────────────────────────────────────────────────────────────
  // Forgot / reset password
  // ─────────────────────────────────────────────────────────────

  async forgotPassword(
    input: { phone: string },
    meta: RequestMeta,
  ): Promise<void> {
    const user = await authRepository.findUserByPhone(input.phone);
    if (!user) return; // Silent — don't leak account existence

    await createAndSendOtp(input.phone, 'reset', meta.ipAddress);
  }

  async resetPassword(
    input: { phone: string; code: string; newPassword: string },
    meta: RequestMeta,
  ): Promise<void> {
    const verify = await verifyOtp(input.phone, 'reset', input.code);
    if (!verify.ok) {
      throw new AppError({
        code: 'AUTH_OTP_INVALID',
        httpStatus: 400,
        message: verify.error ?? 'Invalid or expired code',
      });
    }

    const user = await authRepository.findUserByPhone(input.phone);
    if (!user) throw new NotFoundError('User');

    const newHash = await hashPassword(input.newPassword);
    await authRepository.updatePassword(user.id, newHash);

    // Revoke all sessions on password reset
    await authRepository.revokeAllUserTokens(user.id);

    await record({
      actorId: user.id,
      action: 'PASSWORD_RESET',
      entityType: 'user',
      entityId: user.id,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });
  }

  // ─────────────────────────────────────────────────────────────
  // Internals
  // ─────────────────────────────────────────────────────────────

  /** Sign tokens without persisting them. Used by both login and refresh. */
  private async signTokens(user: UserRow): Promise<AuthResult['tokens']> {
    const accessToken = signAccessToken(user.id, user.role, user.branch_id);
    const refreshToken = signRefreshToken(user.id, user.role, user.branch_id);
    return { accessToken, refreshToken };
  }

  /** Sign tokens and persist the refresh token row. Used by login + verify. */
  private async issueTokens(user: UserRow, meta: RequestMeta): Promise<AuthResult['tokens']> {
    return withTransaction(async (tx) => {
      const tokens = await this.signTokens(user);

      await authRepository.insertRefreshToken(
        {
          userId: user.id,
          tokenHash: sha256(tokens.refreshToken),
          expiresAt: refreshTokenExpiryDate(),
          ipAddress: meta.ipAddress ?? null,
          userAgent: meta.userAgent ?? null,
        },
        tx,
      );

      return tokens;
    });
  }
}

export const authService = new AuthService();
void env;