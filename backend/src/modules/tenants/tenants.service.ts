/**
 * Tenants service — business logic.
 *
 * Phase 1.4a: read-only + manual status changes.
 * Auto-provisioning + slot assignment comes in Phase 1.4b.
 */

import { logger } from '../../logger';
import { AppError, ConflictError, NotFoundError } from '../../errors';
import { record } from '../audit/audit.service';
import { usersRepository } from '../users/users.repository';
import {
  tenantsRepository,
  type TenantMembershipRow,
  type TenantRow,
  type TenantStatus,
} from './tenants.repository';

export interface RequestMeta {
  ipAddress?: string;
  userAgent?: string;
}

export interface TenantDto {
  id: string;
  branchId: string;
  name: string | null;
  status: TenantStatus;
  currentCycle: number;
  memberCount: number;
  activatedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface TenantMemberDto {
  userId: string;
  fullName: string;
  slotNumber: number;
  status: 'ACTIVE' | 'COLLECTED' | 'REMOVED';
  joinedAt: string;
  collectedAt: string | null;
  isMe: boolean;
}

export interface MyTenantDto {
  tenant: TenantDto;
  mySlot: number;
  members: TenantMemberDto[];
}

async function toTenantDto(row: TenantRow): Promise<TenantDto> {
  const memberCount = await tenantsRepository.countMembers(row.id);
  return {
    id: row.id,
    branchId: row.branch_id,
    name: row.name,
    status: row.status,
    currentCycle: row.current_cycle,
    memberCount,
    activatedAt: row.activated_at?.toISOString() ?? null,
    completedAt: row.completed_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  };
}

async function membershipToDto(
  membership: TenantMembershipRow,
  currentUserId: string,
): Promise<TenantMemberDto> {
  const user = await usersRepository.findById(membership.user_id);
  return {
    userId: membership.user_id,
    fullName: user?.full_name ?? 'Unknown',
    slotNumber: membership.slot_number,
    status: membership.status,
    joinedAt: membership.joined_at.toISOString(),
    collectedAt: membership.collected_at?.toISOString() ?? null,
    isMe: membership.user_id === currentUserId,
  };
}

export class TenantsService {
  async getById(id: string): Promise<TenantDto> {
    const row = await tenantsRepository.findById(id);
    if (!row) throw new NotFoundError('Tenant');
    return toTenantDto(row);
  }

  async listByBranch(
    branchId: string,
    options: { limit: number; offset: number; status?: TenantStatus },
  ): Promise<{ tenants: TenantDto[]; total: number }> {
    const { tenants, total } = await tenantsRepository.findByBranch(branchId, options);
    const dtos = await Promise.all(tenants.map(toTenantDto));
    return { tenants: dtos, total };
  }

  async getMyTenant(userId: string): Promise<MyTenantDto | null> {
    const membership = await tenantsRepository.findMembershipByUser(userId);
    if (!membership) return null;

    const tenant = await tenantsRepository.findById(membership.tenant_id);
    if (!tenant) return null;

    const memberships = await tenantsRepository.findMembershipsByTenant(tenant.id);
    const members = await Promise.all(memberships.map((m) => membershipToDto(m, userId)));

    return {
      tenant: await toTenantDto(tenant),
      mySlot: membership.slot_number,
      members,
    };
  }

  async updateStatus(
    tenantId: string,
    status: TenantStatus,
    actorId: string,
    meta: RequestMeta,
  ): Promise<TenantDto> {
    const existing = await tenantsRepository.findById(tenantId);
    if (!existing) throw new NotFoundError('Tenant');

    if (existing.status === status) {
      throw new ConflictError(`Tenant is already ${status}`, 'TENANT_STATUS_UNCHANGED');
    }

    const updated = await tenantsRepository.updateStatus(tenantId, status, {
      activate: status === 'ACTIVE',
      complete: status === 'COMPLETED',
    });

    await record({
      actorId,
      action: 'TENANT_STATUS_CHANGED',
      entityType: 'tenant',
      entityId: tenantId,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      metadata: { from: existing.status, to: status },
    });

    logger.info({ tenantId, from: existing.status, to: status }, 'Tenant status changed');
    return toTenantDto(updated);
  }

  // ---- Provisioning (used by Phase 1.4b) ----

  async createTenantForBranch(
    branchId: string,
    actorId: string,
    meta: RequestMeta,
  ): Promise<TenantDto> {
    const tenant = await tenantsRepository.insert(branchId, null);

    await record({
      actorId,
      action: 'TENANT_CREATED',
      entityType: 'tenant',
      entityId: tenant.id,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      metadata: { branchId },
    });

    logger.info({ tenantId: tenant.id, branchId }, 'Tenant created');
    return toTenantDto(tenant);
  }

  async assignMember(
    tenantId: string,
    userId: string,
    slotNumber: number,
    actorId: string,
    meta: RequestMeta,
  ): Promise<TenantMembershipRow> {
    const tenant = await tenantsRepository.findById(tenantId);
    if (!tenant) throw new NotFoundError('Tenant');
    if (tenant.status !== 'FILLING') {
      throw new ConflictError('Tenant is not accepting members', 'TENANT_NOT_FILLING');
    }

    const used = await tenantsRepository.usedSlots(tenantId);
    if (used.includes(slotNumber)) {
      throw new ConflictError(`Slot ${slotNumber} is taken`, 'TENANT_SLOT_TAKEN');
    }
    if (used.length >= 12) {
      throw new ConflictError('Tenant is full', 'TENANT_FULL');
    }

    const membership = await tenantsRepository.insertMembership(tenantId, userId, slotNumber);

    await record({
      actorId,
      action: 'TENANT_MEMBER_ASSIGNED',
      entityType: 'tenant_membership',
      entityId: membership.id,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      metadata: { tenantId, userId, slotNumber },
    });

    logger.info({ tenantId, userId, slotNumber }, 'Member assigned to tenant');
    return membership;
  }

  // Placeholder for 1.4b — do not use yet
  async pickRandomFreeSlot(tenantId: string): Promise<number> {
    const used = await tenantsRepository.usedSlots(tenantId);
    if (used.length >= 12) {
      throw new AppError({
        code: 'TENANT_FULL',
        httpStatus: 409,
        message: 'Tenant is full',
      });
    }
    const free = Array.from({ length: 12 }, (_, i) => i + 1).filter((n) => !used.includes(n));
    return free[Math.floor(Math.random() * free.length)]!;
  }
}

export const tenantsService = new TenantsService();