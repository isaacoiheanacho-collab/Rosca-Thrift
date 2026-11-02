/**
 * Branches service.
 */

import { logger } from '../../logger';
import { env } from '../../config/env';
import { withTransaction } from '../../db';
import { pool } from '../../db';
import { AppError, ConflictError, NotFoundError } from '../../errors';
import { record } from '../audit/audit.service';
import { hashPassword } from '../../utils/password';
import { authRepository } from '../auth/auth.repository';
import { consentService } from '../consent/consent.service';
import {
  CONSENT_TYPES,
  CONSENT_VERSIONS,
  CONSENT_SLUGS,
} from '../consent/consent.constants';
import {
  DEFAULT_BRANCH_ABOUT,
  DEFAULT_BRANCH_TERMS,
  DEFAULT_BRANCH_PRIVACY,
} from './branch-content-defaults';
import {
  branchesRepository,
  type BranchBranding,
  type BranchRow,
  type BranchStatus,
  type OnboardingStatus,
} from './branches.repository';
import type {
  CreateBranchInput,
  OnboardBranchInput,
  UpdateBranchContentInput,
  UpdateBranchInput,
  UpdateBrandingInput,
  UpdateTrustAccountInput,
} from './branches.schemas';

export interface RequestMeta {
  ipAddress?: string;
  userAgent?: string;
}

export interface BranchDto {
  id: string;
  slug: string;
  name: string;
  adminName: string | null;
  adminKycStatus?: string;
  status: BranchStatus;
  trustAccountName: string | null;
  trustAccountSort: string | null;
  trustAccountNumber: string | null;
  trustAccountHolder: string | null;
  trustAccountComplete: boolean;
  contactEmail: string | null;
  contactPhone: string | null;
  branding: BranchBranding;
  aboutText: string | null;
  branchTermsVersion: string;
  branchPrivacyVersion: string;
  onboardingStatus: OnboardingStatus;
  onboardingRequestedAt: string | null;
  onboardingReviewedAt: string | null;
  onboardingRejectionReason: string | null;
  createdAt: string;
}

export interface PublicBranchDto {
  slug: string;
  name: string;
  status: BranchStatus;
  branding: BranchBranding;
  aboutText: string;
  branchTerms: string;
  branchPrivacy: string;
  branchTermsVersion: string;
  branchPrivacyVersion: string;
  platformTermsVersion: string;
  platformPrivacyVersion: string;
}

export interface PublicBranchStatusDto {
  slug: string;
  name: string;
  onboardingStatus: OnboardingStatus;
  contactPhone: string | null;
}

export interface BranchOnboardingDto {
  branchId: string;
  slug: string;
  status: OnboardingStatus;
  message: string;
}

/**
 * Map a branch row to its DTO.
 *
 * The row may optionally include:
 *   - `admin_name`       — when it came from BranchesRepository.list()
 *                          (which joins users by branch_id + role).
 *   - `admin_kyc_status` — when it came from BranchesRepository.list()
 *                          (which joins the admin's most recent kyc_submissions row).
 */
function toDto(
  row: BranchRow & { admin_name?: string | null; admin_kyc_status?: string },
): BranchDto {
  const trustComplete = !!(
    row.trust_account_name &&
    row.trust_account_sort &&
    row.trust_account_number &&
    row.trust_account_holder
  );

  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    adminName: row.admin_name ?? null,
    adminKycStatus: row.admin_kyc_status ?? 'NOT_SUBMITTED',
    status: row.status,
    trustAccountName: row.trust_account_name,
    trustAccountSort: row.trust_account_sort,
    trustAccountNumber: row.trust_account_number,
    trustAccountHolder: row.trust_account_holder,
    trustAccountComplete: trustComplete,
    contactEmail: row.contact_email,
    contactPhone: row.contact_phone,
    branding: row.branding ?? {},
    aboutText: row.about_text,
    branchTermsVersion: row.branch_terms_version,
    branchPrivacyVersion: row.branch_privacy_version,
    onboardingStatus: row.onboarding_status,
    onboardingRequestedAt: row.onboarding_requested_at?.toISOString() ?? null,
    onboardingReviewedAt: row.onboarding_reviewed_at?.toISOString() ?? null,
    onboardingRejectionReason: row.onboarding_rejection_reason,
    createdAt: row.created_at.toISOString(),
  };
}

function toPublicDto(row: BranchRow): PublicBranchDto {
  return {
    slug: row.slug,
    name: row.name,
    status: row.status,
    branding: row.branding ?? {},
    aboutText: row.about_text ?? DEFAULT_BRANCH_ABOUT,
    branchTerms: row.branch_terms ?? DEFAULT_BRANCH_TERMS,
    branchPrivacy: row.branch_privacy ?? DEFAULT_BRANCH_PRIVACY,
    branchTermsVersion: row.branch_terms_version,
    branchPrivacyVersion: row.branch_privacy_version,
    platformTermsVersion: CONSENT_VERSIONS.TERMS,
    platformPrivacyVersion: CONSENT_VERSIONS.PRIVACY,
  };
}

export class BranchesService {
  async create(
    input: CreateBranchInput,
    createdBy: string,
    meta: RequestMeta,
  ): Promise<BranchDto> {
    const total = await branchesRepository.count();
    if (total >= env.MAX_TENANTS) {
      throw new AppError({
        code: 'BRANCH_LIMIT_REACHED',
        httpStatus: 409,
        message: `Platform has reached the maximum of ${env.MAX_TENANTS} branches`,
      });
    }

    const existing = await branchesRepository.findBySlug(input.slug);
    if (existing) {
      throw new ConflictError('Branch slug is already taken', 'BRANCH_SLUG_TAKEN');
    }

    const row = await branchesRepository.insert({
      slug: input.slug,
      name: input.name,
      contactEmail: input.contactEmail ?? null,
      contactPhone: input.contactPhone ?? null,
      createdBy,
      onboardingStatus: 'APPROVED',
    });

    await record({
      actorId: createdBy,
      action: 'BRANCH_CREATED',
      entityType: 'branch',
      entityId: row.id,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      metadata: { slug: row.slug, name: row.name },
    });

    logger.info({ branchId: row.id, slug: row.slug }, 'Branch created');
    return toDto(row);
  }

  /**
   * Public self-serve onboarding.
   * Creates a PENDING branch and a BRANCH_ADMIN user.
   */
  async onboard(
    input: OnboardBranchInput,
    meta: RequestMeta,
  ): Promise<BranchOnboardingDto> {
    if (input.consents.terms.version !== CONSENT_VERSIONS.TERMS) {
      throw new AppError({
        code: 'CONSENT_VERSION_MISMATCH',
        httpStatus: 400,
        message: 'Your Terms version is out of date. Refresh and try again.',
      });
    }
    if (input.consents.privacy.version !== CONSENT_VERSIONS.PRIVACY) {
      throw new AppError({
        code: 'CONSENT_VERSION_MISMATCH',
        httpStatus: 400,
        message: 'Your Privacy version is out of date. Refresh and try again.',
      });
    }

    const existingBranch = await branchesRepository.findBySlug(input.branch.slug);
    if (existingBranch) {
      throw new ConflictError('Branch slug is already taken', 'BRANCH_SLUG_TAKEN');
    }

    const existingUser = await authRepository.findUserByPhone(input.admin.phone);
    if (existingUser) {
      throw new ConflictError('Phone number is already registered', 'AUTH_PHONE_TAKEN');
    }

    const passwordHash = await hashPassword(input.admin.password);

    const { branch, adminId } = await withTransaction(async (tx) => {
      // Create branch first with createdBy = null
      const createdBranch = await branchesRepository.insert(
        {
          slug: input.branch.slug,
          name: input.branch.name,
          contactEmail: input.branch.contactEmail,
          contactPhone: input.branch.contactPhone ?? null,
          createdBy: null,
          onboardingStatus: 'PENDING',
          onboardingNote: input.branch.note ?? null,
        },
        tx,
      );

      // Create the admin user
      const admin = await authRepository.insertUser(
        {
          phone: input.admin.phone,
          email: null,
          passwordHash,
          fullName: input.admin.fullName,
          role: 'BRANCH_ADMIN',
          branchId: createdBranch.id,
        },
        tx,
      );

      // Backfill created_by
      await branchesRepository.setCreatedBy(createdBranch.id, admin.id, tx);

      return { branch: createdBranch, adminId: admin.id };
    });

    await consentService.recordAcceptance({
      userId: adminId,
      consentType: CONSENT_TYPES.TERMS,
      documentVersion: CONSENT_VERSIONS.TERMS,
      documentSlug: CONSENT_SLUGS.TERMS,
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    });
    await consentService.recordAcceptance({
      userId: adminId,
      consentType: CONSENT_TYPES.PRIVACY,
      documentVersion: CONSENT_VERSIONS.PRIVACY,
      documentSlug: CONSENT_SLUGS.PRIVACY,
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    });

    await record({
      actorId: adminId,
      action: 'BRANCH_ONBOARDING_REQUESTED',
      entityType: 'branch',
      entityId: branch.id,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      metadata: { slug: branch.slug, name: branch.name },
    });

    logger.info(
      { branchId: branch.id, slug: branch.slug, adminId },
      'Branch onboarding requested — awaiting super admin review',
    );

    return {
      branchId: branch.id,
      slug: branch.slug,
      status: 'PENDING',
      message:
        'Your branch application has been submitted. ' +
        'A platform administrator will review it shortly. ' +
        'You will be notified by SMS when approved. ' +
        'Once approved, verify your phone number to log in.',
    };
  }

  async list(options: {
    limit: number;
    offset: number;
    status?: BranchStatus;
    onboardingStatus?: OnboardingStatus;
  }): Promise<{ branches: BranchDto[]; total: number }> {
    // 1. Fetch raw branches
    const { branches, total } = await branchesRepository.list(options);

    // 2. Map to DTO and force the KYC status to be one of our exact enums
    const dtos = branches.map((row) => {
      const dto = toDto(row);

      // Force uppercase and exact match
      const rawKyc = row.admin_kyc_status?.toUpperCase();

      if (rawKyc === 'PENDING') dto.adminKycStatus = 'PENDING';
      else if (rawKyc === 'APPROVED') dto.adminKycStatus = 'APPROVED';
      else if (rawKyc === 'REJECTED') dto.adminKycStatus = 'REJECTED';
      else dto.adminKycStatus = 'NOT_SUBMITTED';

      return dto;
    });

    return { branches: dtos, total };
  }

  async getById(id: string): Promise<BranchDto> {
    const row = await branchesRepository.findById(id);
    if (!row) throw new NotFoundError('Branch');
    return toDto(row);
  }

  async getBySlug(slug: string): Promise<BranchDto> {
    const row = await branchesRepository.findBySlug(slug);
    if (!row) throw new NotFoundError('Branch');
    return toDto(row);
  }

  async getPublicBySlug(slug: string): Promise<PublicBranchDto> {
    const row = await branchesRepository.findBySlug(slug);
    if (!row) throw new NotFoundError('Branch');

    if (row.status !== 'ACTIVE') {
      throw new AppError({
        code: 'BRANCH_NOT_ACTIVE',
        httpStatus: 403,
        message: 'This branch is not currently accepting members',
      });
    }

    if (row.onboarding_status !== 'APPROVED') {
      throw new AppError({
        code: 'BRANCH_NOT_APPROVED',
        httpStatus: 403,
        message: 'This branch is not yet live on the platform',
      });
    }

    // DUAL-APPROVAL GATE: the branch's KYC must also be approved before
    // savers can register. Onboarding alone proves nothing — the bank
    // verification is what makes the branch legally real.
    const kycRes = await pool.query<{ status: string }>(
      `SELECT k.status
       FROM kyc_submissions k
       JOIN users u ON u.id = k.user_id
       WHERE u.branch_id = $1 AND u.role = 'BRANCH_ADMIN'
       ORDER BY k.created_at DESC
       LIMIT 1`,
      [row.id],
    );
    const adminKycStatus = kycRes.rows[0]?.status;
    if (adminKycStatus !== 'APPROVED') {
      throw new AppError({
        code: 'BRANCH_NOT_KYC_VERIFIED',
        httpStatus: 403,
        message:
          'This branch is not yet fully verified. Please contact the branch admin directly.',
      });
    }

    return toPublicDto(row);
  }

  /**
   * Public branch status — always succeeds for any existing branch,
   * regardless of onboarding_status or branch status.
   *
   * This is used by the /join landing page's error state so the visitor
   * sees the branch's display name and the admin's public contact phone
   * even when the branch is still pending super-admin approval.
   */
  async getPublicStatusBySlug(slug: string): Promise<PublicBranchStatusDto> {
    const row = await branchesRepository.findBySlug(slug);
    if (!row) throw new NotFoundError('Branch');

    return {
      slug: row.slug,
      name: row.name,
      onboardingStatus: row.onboarding_status,
      contactPhone: row.contact_phone,
    };
  }

  async update(
    id: string,
    input: UpdateBranchInput,
    actorId: string,
    meta: RequestMeta,
  ): Promise<BranchDto> {
    const existing = await branchesRepository.findById(id);
    if (!existing) throw new NotFoundError('Branch');

    const updated = await branchesRepository.update(id, {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.contactEmail !== undefined ? { contactEmail: input.contactEmail } : {}),
      ...(input.contactPhone !== undefined ? { contactPhone: input.contactPhone } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
    });

    await record({
      actorId,
      action: 'BRANCH_UPDATED',
      entityType: 'branch',
      entityId: id,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      metadata: { fields: Object.keys(input) },
    });

    logger.info({ branchId: id, fields: Object.keys(input) }, 'Branch updated');
    return toDto(updated);
  }

  async updateBranding(
    branchId: string,
    input: UpdateBrandingInput,
    actorId: string,
    meta: RequestMeta,
  ): Promise<BranchDto> {
    const existing = await branchesRepository.findById(branchId);
    if (!existing) throw new NotFoundError('Branch');

    const updated = await branchesRepository.updateBranding(branchId, input);

    await record({
      actorId,
      action: 'BRANCH_BRANDING_UPDATED',
      entityType: 'branch',
      entityId: branchId,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      metadata: { fields: Object.keys(input) },
    });

    logger.info({ branchId, fields: Object.keys(input) }, 'Branch branding updated');
    return toDto(updated);
  }

  async updateContent(
    branchId: string,
    input: UpdateBranchContentInput,
    actorId: string,
    meta: RequestMeta,
  ): Promise<BranchDto> {
    const existing = await branchesRepository.findById(branchId);
    if (!existing) throw new NotFoundError('Branch');

    const updated = await branchesRepository.updateContent(branchId, {
      ...(input.aboutText !== undefined ? { aboutText: input.aboutText } : {}),
      ...(input.branchTerms !== undefined ? { branchTerms: input.branchTerms } : {}),
      ...(input.branchPrivacy !== undefined ? { branchPrivacy: input.branchPrivacy } : {}),
      ...(input.branchTermsVersion !== undefined
        ? { branchTermsVersion: input.branchTermsVersion }
        : {}),
      ...(input.branchPrivacyVersion !== undefined
        ? { branchPrivacyVersion: input.branchPrivacyVersion }
        : {}),
    });

    await record({
      actorId,
      action: 'BRANCH_CONTENT_UPDATED',
      entityType: 'branch',
      entityId: branchId,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      metadata: { fields: Object.keys(input) },
    });

    logger.info({ branchId, fields: Object.keys(input) }, 'Branch content updated');
    return toDto(updated);
  }

  async updateTrustAccount(
    branchId: string,
    input: UpdateTrustAccountInput,
    actorId: string,
    meta: RequestMeta,
  ): Promise<BranchDto> {
    const existing = await branchesRepository.findById(branchId);
    if (!existing) throw new NotFoundError('Branch');

    const updated = await branchesRepository.updateTrustAccount(branchId, input);

    await record({
      actorId,
      action: 'BRANCH_TRUST_ACCOUNT_UPDATED',
      entityType: 'branch',
      entityId: branchId,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });

    logger.info({ branchId }, 'Branch trust account updated');
    return toDto(updated);
  }

  async approveOnboarding(
    branchId: string,
    actorId: string,
    meta: RequestMeta,
  ): Promise<BranchDto> {
    const existing = await branchesRepository.findById(branchId);
    if (!existing) throw new NotFoundError('Branch');

    if (existing.onboarding_status === 'APPROVED') {
      throw new ConflictError('Branch is already approved', 'BRANCH_ALREADY_APPROVED');
    }

    const updated = await branchesRepository.approveOnboarding(branchId, actorId);

    await record({
      actorId,
      action: 'BRANCH_ONBOARDING_APPROVED',
      entityType: 'branch',
      entityId: branchId,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });

    logger.info({ branchId, actorId }, 'Branch onboarding approved');
    return toDto(updated);
  }

  async rejectOnboarding(
    branchId: string,
    reason: string,
    actorId: string,
    meta: RequestMeta,
  ): Promise<BranchDto> {
    const existing = await branchesRepository.findById(branchId);
    if (!existing) throw new NotFoundError('Branch');

    if (existing.onboarding_status === 'REJECTED') {
      throw new ConflictError('Branch is already rejected', 'BRANCH_ALREADY_REJECTED');
    }

    const updated = await branchesRepository.rejectOnboarding(branchId, actorId, reason);

    await record({
      actorId,
      action: 'BRANCH_ONBOARDING_REJECTED',
      entityType: 'branch',
      entityId: branchId,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      metadata: { reason },
    });

    logger.warn({ branchId, actorId, reason }, 'Branch onboarding rejected');
    return toDto(updated);
  }
}

export const branchesService = new BranchesService();