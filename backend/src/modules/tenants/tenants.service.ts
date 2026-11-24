/**
 * Tenants service - business logic.
 *
 * Phase 1.4c: adds member listing + branch summary endpoints.
 * Phase 1.7:  lazy cycle advancement on dashboard load.
 * Phase 1.8:  tenure renewal - lazy check on dashboard load.
 */

import { logger } from '../../logger';
import { AppError, ConflictError, NotFoundError } from '../../errors';
import { record } from '../audit/audit.service';
import { usersRepository } from '../users/users.repository';
import { cycleAdvancementService } from './cycle-advancement.service';
import { tenureRenewalService } from './tenure-renewal.service';
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
  configurationId: string;
  memberCapacity: number;
  configurationName: string;
  contributionAmountPence: string;
  contributionFrequency: string;
  contributionWindowDays: number;
  cycleDurationDays: number;
  name: string | null;
  status: TenantStatus;
  currentCycle: number;
  currentTenure: number;
  memberCount: number;
  activatedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  renewalState: string;
  renewalVoteEndsAt: string | null;
  renewalFillEndsAt: string | null;
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

export interface BranchSummaryDto {
  branchId: string;
  totalTenants: number;
  filling: number;
  active: number;
  completed: number;
  totalMembers: number;
  tenants: TenantDto[];
}

async function toTenantDto(row: TenantRow): Promise<TenantDto> {
  const memberCount = await tenantsRepository.countMembers(row.id);
  const configResult = await (await import('../../db')).pool.query<{name:string;contribution_amount:string;contribution_frequency:string}>('SELECT name, contribution_amount::text, contribution_frequency FROM circle_configurations WHERE id = $1', [row.configuration_id]);
  const config = configResult.rows[0];
  return {
    id: row.id,
    branchId: row.branch_id,
    configurationId: row.configuration_id,
    memberCapacity: row.member_capacity_snapshot,
    configurationName: config?.name ?? 'Circle',
    contributionAmountPence: config?.contribution_amount ?? '0',
    contributionFrequency: config?.contribution_frequency ?? 'MONTHLY',
    contributionWindowDays: row.contribution_window_days_snapshot,
    cycleDurationDays: row.cycle_duration_days_snapshot,
    name: row.name,
    status: row.status,
    currentCycle: row.current_cycle,
    currentTenure: row.current_tenure,
    memberCount,
    activatedAt: row.activated_at?.toISOString() ?? null,
    completedAt: row.completed_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    renewalState: row.renewal_state,
    renewalVoteEndsAt: row.renewal_vote_ends_at?.toISOString() ?? null,
    renewalFillEndsAt: row.renewal_fill_ends_at?.toISOString() ?? null,
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
    // Lazy cycle-advancement trigger.
    try {
      await cycleAdvancementService.advanceForUser(userId);
    } catch (err) {
      logger.error({ err, userId }, 'Lazy cycle advancement failed');
    }

    // Lazy renewal-window trigger (vote close + fill window close).
    try {
      await tenureRenewalService.lazyCheckForUser(userId);
    } catch (err) {
      logger.error({ err, userId }, 'Lazy renewal check failed');
    }

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

  async listMyMembers(userId: string): Promise<TenantMemberDto[]> {
    const membership = await tenantsRepository.findMembershipByUser(userId);
    if (!membership) return [];
    const memberships = await tenantsRepository.findMembershipsByTenant(membership.tenant_id);
    return Promise.all(memberships.map((m) => membershipToDto(m, userId)));
  }

  async listTenantMembersForAdmin(tenantId: string): Promise<TenantMemberDto[]> {
    const memberships = await tenantsRepository.findMembershipsByTenant(tenantId);
    // We pass an empty string as the currentUserId since the admin isn't a member
    return Promise.all(memberships.map((m) => membershipToDto(m, '')));
  }

  async getSummaryForBranch(branchId: string): Promise<BranchSummaryDto> {
    const { tenants } = await tenantsRepository.findByBranch(branchId, {
      limit: 1000,
      offset: 0,
    });

    const dtos = await Promise.all(tenants.map(toTenantDto));

    const filling = dtos.filter((t) => t.status === 'FILLING').length;
    const active = dtos.filter((t) => t.status === 'ACTIVE').length;
    const completed = dtos.filter((t) => t.status === 'COMPLETED').length;
    const totalMembers = dtos.reduce((acc, t) => acc + t.memberCount, 0);

    return {
      branchId,
      totalTenants: dtos.length,
      filling,
      active,
      completed,
      totalMembers,
      tenants: dtos,
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

  async createTenantForBranch(
    branchId: string,
    actorId: string,
    meta: RequestMeta,
  ): Promise<TenantDto> {
    const legacy = await (await import('../../db')).pool.query<{id:string;member_capacity:number;cycle_duration_days:number;contribution_window_days:number}>("SELECT id, member_capacity, cycle_duration_days, contribution_window_days FROM circle_configurations WHERE branch_id = $1 AND is_legacy = TRUE LIMIT 1", [branchId]);
    if (!legacy.rows[0]) throw new NotFoundError('Legacy circle configuration');
    const tenant = await tenantsRepository.insert(branchId, legacy.rows[0].id, legacy.rows[0].member_capacity, legacy.rows[0].cycle_duration_days, legacy.rows[0].contribution_window_days, null);

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
    if (slotNumber < 1 || slotNumber > tenant.member_capacity_snapshot) {
      throw new ConflictError('Slot is outside this circle configuration capacity', 'TENANT_SLOT_OUT_OF_RANGE');
    }
    if (used.includes(slotNumber)) {
      throw new ConflictError(`Slot ${slotNumber} is taken`, 'TENANT_SLOT_TAKEN');
    }
    if (used.length >= tenant.member_capacity_snapshot) {
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

  async pickRandomFreeSlot(tenantId: string): Promise<number> {
    const used = await tenantsRepository.usedSlots(tenantId);
    if (used.length >= tenant.member_capacity_snapshot) {
      throw new AppError({
        code: 'TENANT_FULL',
        httpStatus: 409,
        message: 'Tenant is full',
      });
    }
    const free = Array.from({ length: tenant.member_capacity_snapshot }, (_, i) => i + 1).filter((n) => !used.includes(n));
    return free[Math.floor(Math.random() * free.length)]!;
  }
}

export const tenantsService = new TenantsService();