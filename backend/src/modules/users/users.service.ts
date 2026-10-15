/**
 * Users service — profile management, phone change flow, consent management.
 */

import { withTransaction } from '../../db';
import { logger } from '../../logger';
import { hashPassword, verifyPassword } from '../../utils/password';
import { createAndSendOtp, verifyOtp } from '../../utils/otp';
import { AppError, ConflictError, NotFoundError } from '../../errors';
import { authRepository } from '../auth/auth.repository';
import { record } from '../audit/audit.service';
import { consentService } from '../consent/consent.service';
import type { ConsentType } from '../consent/consent.constants';
import { usersRepository } from './users.repository';
import type { UserRow } from '../auth/auth.repository';
import type {
  ChangePasswordInput,
  RequestPhoneChangeInput,
  UpdateProfileInput,
  VerifyPhoneChangeInput,
} from './users.schemas';

export interface RequestMeta {
  ipAddress?: string;
  userAgent?: string;
}

export interface PublicUser {
  id: string;
  phone: string;
  email: string | null;
  fullName: string;
  role: 'SUPER_ADMIN' | 'BRANCH_ADMIN' | 'SAVER';
  branchId: string | null;
  status: 'PENDING' | 'VERIFIED' | 'SUSPENDED';
  phoneVerified: boolean;
  createdAt: string;
}

export interface ConsentDto {
  id: string;
  consentType: ConsentType;
  documentVersion: string;
  documentSlug: string;
  acceptedAt: string;
  withdrawnAt: string | null;
  withdrawalReason: string | null;
}

export function toPublicUser(row: UserRow): PublicUser {
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

function toConsentDto(row: {
  id: string;
  consent_type: ConsentType;
  document_version: string;
  document_slug: string;
  accepted_at: Date;
  withdrawn_at: Date | null;
  withdrawal_reason: string | null;
}): ConsentDto {
  return {
    id: row.id,
    consentType: row.consent_type,
    documentVersion: row.document_version,
    documentSlug: row.document_slug,
    acceptedAt: row.accepted_at.toISOString(),
    withdrawnAt: row.withdrawn_at?.toISOString() ?? null,
    withdrawalReason: row.withdrawal_reason,
  };
}

export class UsersService {
  async getMe(userId: string): Promise<PublicUser> {
    const user = await usersRepository.findById(userId);
    if (!user) throw new NotFoundError('User');
    return toPublicUser(user);
  }

  async updateProfile(
    userId: string,
    input: UpdateProfileInput,
    meta: RequestMeta,
  ): Promise<PublicUser> {
    if (input.email !== undefined && input.email !== null) {
      const taken = await usersRepository.emailExists(input.email, userId);
      if (taken) {
        throw new ConflictError('Email is already in use', 'USER_EMAIL_TAKEN');
      }
    }

    const updated = await usersRepository.updateProfile(userId, {
      ...(input.fullName !== undefined ? { fullName: input.fullName } : {}),
      ...(input.email !== undefined ? { email: input.email } : {}),
    });

    await record({
      actorId: userId,
      action: 'PROFILE_UPDATED',
      entityType: 'user',
      entityId: userId,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      metadata: { fields: Object.keys(input) },
    });

    logger.info({ userId }, 'Profile updated');
    return toPublicUser(updated);
  }

  async changePassword(
    userId: string,
    input: ChangePasswordInput,
    meta: RequestMeta,
  ): Promise<{ ok: true }> {
    const user = await usersRepository.findById(userId);
    if (!user) throw new NotFoundError('User');

    const ok = await verifyPassword(input.currentPassword, user.password_hash);
    if (!ok) {
      throw new AppError({
        code: 'USER_WRONG_PASSWORD',
        httpStatus: 401,
        message: 'Current password is incorrect',
      });
    }

    const newHash = await hashPassword(input.newPassword);

    await withTransaction(async (tx) => {
      await usersRepository.updatePassword(userId, newHash, tx);
      await record(
        {
          actorId: userId,
          action: 'PASSWORD_CHANGED',
          entityType: 'user',
          entityId: userId,
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
        },
        tx,
      );
    });

    await authRepository.revokeAllUserTokens(userId);
    logger.info({ userId }, 'Password changed, sessions revoked');
    return { ok: true };
  }

  async requestPhoneChange(
    userId: string,
    input: RequestPhoneChangeInput,
    meta: RequestMeta,
  ): Promise<{ ok: true }> {
    const currentUser = await usersRepository.findById(userId);
    if (!currentUser) throw new NotFoundError('User');

    if (currentUser.phone === input.newPhone) {
      throw new AppError({
        code: 'USER_SAME_PHONE',
        httpStatus: 400,
        message: 'New phone is the same as the current phone',
      });
    }

    const existing = await usersRepository.findByPhone(input.newPhone);
    if (existing) {
      throw new ConflictError('Phone is already in use', 'USER_PHONE_TAKEN');
    }

    const send = await createAndSendOtp(input.newPhone, 'verify_phone', meta.ipAddress);
    if (!send.ok) {
      throw new AppError({
        code: 'USER_OTP_SEND_FAILED',
        httpStatus: 502,
        message: send.error ?? 'Failed to send OTP',
      });
    }

    logger.info({ userId }, 'Phone change OTP dispatched');
    return { ok: true };
  }

  async verifyPhoneChange(
    userId: string,
    input: VerifyPhoneChangeInput,
    meta: RequestMeta,
  ): Promise<{ ok: true }> {
    const verify = await verifyOtp(input.newPhone, 'verify_phone', input.code);
    if (!verify.ok) {
      throw new AppError({
        code: 'USER_OTP_INVALID',
        httpStatus: 400,
        message: verify.error ?? 'Invalid or expired code',
      });
    }

    await withTransaction(async (tx) => {
      await usersRepository.updatePhone(userId, input.newPhone, tx);
      await record(
        {
          actorId: userId,
          action: 'PHONE_CHANGED',
          entityType: 'user',
          entityId: userId,
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
          metadata: { newPhone: input.newPhone },
        },
        tx,
      );
    });

    await authRepository.revokeAllUserTokens(userId);
    logger.info({ userId }, 'Phone changed, sessions revoked');
    return { ok: true };
  }

  // ─────────────────────────────────────────────────────────────
  // Consent management
  // ─────────────────────────────────────────────────────────────

  /** Latest consent per type — includes withdrawn ones. */
  async getMyConsents(userId: string): Promise<ConsentDto[]> {
    const rows = await consentService.latestForUser(userId);
    return rows.map(toConsentDto);
  }

  /** Full history for audit — user sees their own. */
  async getMyConsentHistory(userId: string): Promise<ConsentDto[]> {
    const rows = await consentService.listForUser(userId);
    return rows.map(toConsentDto);
  }

  /** Check whether the user is currently permitted to withdraw. */
  async canWithdrawConsent(userId: string): Promise<{
    allowed: boolean;
    reason?: string;
  }> {
    const result = await consentService.canWithdraw(userId);
    return {
      allowed: result.allowed,
      reason: result.reason,
    };
  }

  /** Withdraw a specific consent. Throws if precondition fails. */
  async withdrawConsent(
    userId: string,
    consentType: ConsentType,
    meta: RequestMeta,
  ): Promise<ConsentDto> {
    const row = await consentService.withdraw({
      userId,
      consentType,
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    });
    return toConsentDto(row);
  }
}

export const usersService = new UsersService();