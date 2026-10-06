/**
 * Provisioning service.
 *
 * Called when a saver becomes "fully verified" (phone verified + KYC approved).
 *
 * Flow:
 *   1. If user already has an active membership → do nothing.
 *   2. Find the oldest FILLING tenant in their branch.
 *      - If none exists → create a new tenant for the branch.
 *   3. Pick a random free slot (1-12).
 *   4. Insert membership.
 *   5. If tenant now has 12 members → mark tenant ACTIVE, set activated_at.
 *   6. Audit every step.
 *
 * Idempotent: safe to call multiple times.
 */

import { withTransaction } from '../../db';
import { logger } from '../../logger';
import { record } from '../audit/audit.service';
import { tenantsRepository, type TenantRow } from './tenants.repository';

export interface ProvisionResult {
  tenantId: string;
  slotNumber: number;
  tenantActivated: boolean;
  createdNewTenant: boolean;
  alreadyProvisioned: boolean;
}

function pickRandomFreeSlot(used: number[]): number | null {
  const free = Array.from({ length: 12 }, (_, i) => i + 1).filter((n) => !used.includes(n));
  if (free.length === 0) return null;
  return free[Math.floor(Math.random() * free.length)]!;
}

export class ProvisioningService {
  /**
   * Assign a user to a tenant in their branch.
   * Creates a new tenant if none is filling.
   * Activates the tenant when it reaches 12 members.
   */
  async provisionUserToTenant(
    userId: string,
    branchId: string,
  ): Promise<ProvisionResult> {
    // 1. Already provisioned?
    const existing = await tenantsRepository.findMembershipByUser(userId);
    if (existing) {
      logger.debug({ userId, tenantId: existing.tenant_id }, 'Already provisioned');
      return {
        tenantId: existing.tenant_id,
        slotNumber: existing.slot_number,
        tenantActivated: false,
        createdNewTenant: false,
        alreadyProvisioned: true,
      };
    }

    // 2. Find or create tenant
    let tenant: TenantRow | null = await tenantsRepository.findOpenByBranch(branchId);
    let createdNewTenant = false;

    if (!tenant) {
      tenant = await tenantsRepository.insert(branchId, null);
      createdNewTenant = true;
      await record({
        actorId: null,
        action: 'TENANT_CREATED',
        entityType: 'tenant',
        entityId: tenant.id,
        metadata: { branchId, reason: 'auto-provisioning' },
      });
      logger.info({ tenantId: tenant.id, branchId }, 'Tenant auto-created');
    }

    // 3. Assign slot inside a transaction so we never double-book
    const result = await withTransaction(async (tx) => {
      // Re-check slots within the transaction to avoid race conditions
      const usedSlotsRes = await tx.query<{ slot_number: number }>(
        `SELECT slot_number FROM tenant_memberships
         WHERE tenant_id = $1 AND status != 'REMOVED'`,
        [tenant!.id],
      );
      const used = usedSlotsRes.rows.map((r) => r.slot_number);

      const slot = pickRandomFreeSlot(used);
      if (slot === null) {
        throw new Error(`Tenant ${tenant!.id} unexpectedly full during provisioning`);
      }

      const membershipRes = await tx.query<{ id: string; slot_number: number }>(
        `INSERT INTO tenant_memberships (tenant_id, user_id, slot_number)
         VALUES ($1, $2, $3)
         RETURNING id, slot_number`,
        [tenant!.id, userId, slot],
      );
      const membership = membershipRes.rows[0]!;

      // Count members now
      const countRes = await tx.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM tenant_memberships
         WHERE tenant_id = $1 AND status != 'REMOVED'`,
        [tenant!.id],
      );
      const memberCount = Number(countRes.rows[0]?.count ?? '0');

      let activated = false;

      // Activate the tenant on the 12th member
      if (memberCount >= 12 && tenant!.status === 'FILLING') {
        await tx.query(
          `UPDATE tenants
           SET status = 'ACTIVE', activated_at = NOW()
           WHERE id = $1 AND status = 'FILLING'`,
          [tenant!.id],
        );
        activated = true;
      }

      // Audit membership
      await record(
        {
          actorId: null,
          action: 'TENANT_MEMBER_ASSIGNED',
          entityType: 'tenant_membership',
          entityId: membership.id,
          metadata: { tenantId: tenant!.id, userId, slotNumber: slot },
        },
        tx,
      );

      if (activated) {
        await record(
          {
            actorId: null,
            action: 'TENANT_ACTIVATED',
            entityType: 'tenant',
            entityId: tenant!.id,
            metadata: { memberCount },
          },
          tx,
        );
      }

      return { slot, activated, memberCount };
    });

    logger.info(
      {
        userId,
        tenantId: tenant.id,
        slotNumber: result.slot,
        memberCount: result.memberCount,
        activated: result.activated,
        createdNewTenant,
      },
      'User provisioned to tenant',
    );

    return {
      tenantId: tenant.id,
      slotNumber: result.slot,
      tenantActivated: result.activated,
      createdNewTenant,
      alreadyProvisioned: false,
    };
  }
}

export const provisioningService = new ProvisioningService();