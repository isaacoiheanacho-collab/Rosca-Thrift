/**
 * KYC service — submission (saver) + review (branch admin).
 *
 * Branch scope is enforced in the routes layer; this service trusts the
 * caller already verified the branch relationship.
 */

import { getPresignedDownloadUrl, uploadObject } from '../../utils/s3';
import { logger } from '../../logger';
import { AppError, ConflictError, NotFoundError } from '../../errors';
import { record } from '../audit/audit.service';
import { usersRepository } from '../users/users.repository';
import { kycRepository, type KycSubmissionRow } from './kyc.repository';
import type { SubmitKycInput } from './kyc.schemas';

export interface RequestMeta {
  ipAddress?: string;
  userAgent?: string;
}

export interface KycSubmissionDto {
  id: string;
  userId: string;
  branchId: string;
  legalName: string;
  selfieUrl: string;
  bankName: string;
  accountNumber: string;
  sortCode: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  rejectionReason: string | null;
  reviewedAt: string | null;
  createdAt: string;
}

async function toDto(row: KycSubmissionRow): Promise<KycSubmissionDto> {
  const selfieUrl = await getPresignedDownloadUrl(row.selfie_object_key, 300);
  return {
    id: row.id,
    userId: row.user_id,
    branchId: row.branch_id,
    legalName: row.legal_name,
    selfieUrl,
    bankName: row.bank_name,
    accountNumber: row.account_number,
    sortCode: row.sort_code,
    status: row.status,
    rejectionReason: row.rejection_reason,
    reviewedAt: row.reviewed_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  };
}

export class KycService {
  async submit(
    userId: string,
    input: SubmitKycInput,
    selfie: { buffer: Buffer; mimetype: string; originalname: string },
    meta: RequestMeta,
  ): Promise<KycSubmissionDto> {
    const user = await usersRepository.findById(userId);
    if (!user) throw new NotFoundError('User');
    if (!user.branch_id) {
      throw new AppError({
        code: 'KYC_NO_BRANCH',
        httpStatus: 403,
        message: 'User is not assigned to a branch',
      });
    }
    if (user.kyc_verified_at) {
      throw new ConflictError('KYC already approved', 'KYC_ALREADY_APPROVED');
    }

    const pending = await kycRepository.findPendingByUserId(userId);
    if (pending) {
      throw new ConflictError('A pending submission already exists', 'KYC_PENDING_EXISTS');
    }

    const objectKey = `kyc/${user.branch_id}/${userId}/${Date.now()}-${selfie.originalname || 'selfie'}`;
    await uploadObject(objectKey, selfie.buffer, selfie.mimetype, {
      userId,
      branchId: user.branch_id,
      type: 'kyc-selfie',
    });

    const row = await kycRepository.insert({
      userId,
      branchId: user.branch_id,
      legalName: input.legalName,
      selfieObjectKey: objectKey,
      bankName: input.bankName,
      accountNumber: input.accountNumber,
      sortCode: input.sortCode,
    });

    await record({
      actorId: userId,
      action: 'KYC_SUBMITTED',
      entityType: 'kyc_submission',
      entityId: row.id,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      metadata: { branchId: row.branch_id, legalName: row.legal_name, bankName: row.bank_name },
    });

    logger.info({ userId, submissionId: row.id, branchId: row.branch_id }, 'KYC submitted');
    return toDto(row);
  }

  async getMine(userId: string): Promise<KycSubmissionDto | null> {
    const row = await kycRepository.findLatestByUserId(userId);
    return row ? toDto(row) : null;
  }

  async list(options: {
    limit: number;
    offset: number;
    status?: 'PENDING' | 'APPROVED' | 'REJECTED';
    branchId?: string;
  }): Promise<{ submissions: KycSubmissionDto[]; total: number }> {
    const { submissions, total } = await kycRepository.list(options);
    const dtos = await Promise.all(submissions.map(toDto));
    return { submissions: dtos, total };
  }

  async getById(id: string): Promise<KycSubmissionDto> {
    const row = await kycRepository.findById(id);
    if (!row) throw new NotFoundError('KYC submission');
    return toDto(row);
  }

  async approve(
    submissionId: string,
    reviewerId: string,
    meta: RequestMeta,
  ): Promise<KycSubmissionDto> {
    const row = await kycRepository.findById(submissionId);
    if (!row) throw new NotFoundError('KYC submission');
    if (row.status !== 'PENDING') {
      throw new ConflictError('Submission is not pending', 'KYC_NOT_PENDING');
    }

    const updated = await kycRepository.approve(submissionId, reviewerId);
    await kycRepository.markUserKycVerified(row.user_id);

    await record({
      actorId: reviewerId,
      action: 'KYC_APPROVED',
      entityType: 'kyc_submission',
      entityId: submissionId,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      metadata: { userId: row.user_id, branchId: row.branch_id },
    });

    logger.info({ submissionId, reviewerId, branchId: row.branch_id }, 'KYC approved');
    return toDto(updated);
  }

  async reject(
    submissionId: string,
    reviewerId: string,
    reason: string,
    meta: RequestMeta,
  ): Promise<KycSubmissionDto> {
    const row = await kycRepository.findById(submissionId);
    if (!row) throw new NotFoundError('KYC submission');
    if (row.status !== 'PENDING') {
      throw new ConflictError('Submission is not pending', 'KYC_NOT_PENDING');
    }

    const updated = await kycRepository.reject(submissionId, reviewerId, reason);

    await record({
      actorId: reviewerId,
      action: 'KYC_REJECTED',
      entityType: 'kyc_submission',
      entityId: submissionId,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      metadata: { userId: row.user_id, branchId: row.branch_id, reason },
    });

    logger.info({ submissionId, reviewerId, branchId: row.branch_id }, 'KYC rejected');
    return toDto(updated);
  }
}

export const kycService = new KycService();