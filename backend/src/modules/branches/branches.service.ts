/**
 * Branches service — business logic for branch management.
 */

import { logger } from '../../logger';
import { env } from '../../config/env';
import { AppError, ConflictError, NotFoundError } from '../../errors';
import { record } from '../audit/audit.service';
import { branchesRepository, type BranchRow, type BranchStatus } from './branches.repository';
import type {
  CreateBranchInput,
  UpdateBranchInput,
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
  status: BranchStatus;
  trustAccountName: string | null;
  trustAccountSort: string | null;
  trustAccountNumber: string | null;
  trustAccountHolder: string | null;
  trustAccountComplete: boolean;
  contactEmail: string | null;
  contactPhone: string | null;
  createdAt: string;
}

function toDto(row: BranchRow): BranchDto {
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
    status: row.status,
    trustAccountName: row.trust_account_name,
    trustAccountSort: row.trust_account_sort,
    trustAccountNumber: row.trust_account_number,
    trustAccountHolder: row.trust_account_holder,
    trustAccountComplete: trustComplete,
    contactEmail: row.contact_email,
    contactPhone: row.contact_phone,
    createdAt: row.created_at.toISOString(),
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

  async list(options: { limit: number; offset: number; status?: BranchStatus }): Promise<{
    branches: BranchDto[];
    total: number;
  }> {
    const { branches, total } = await branchesRepository.list(options);
    return { branches: branches.map(toDto), total };
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
}

export const branchesService = new BranchesService();