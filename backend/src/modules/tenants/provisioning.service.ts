/**
 * Provisioning service.
 *
 * Called when a saver becomes "fully verified" (phone verified + KYC approved).
 *
 * Flow (in priority order):
 *   1. If user already has an active membership -> do nothing.
 *   2. If the user's branch has a tenant in renewal REPLACING state
 *      -> assign them to that tenant's unfilled slot (renewal replacement).
 *   3. Else find the oldest FILLING tenant in their branch.
 *      - If none exists -> create a new tenant for the branch.
 *   4. Pick a random free slot (1-12).
 *   5. Insert membership.
 *   6. If tenant now has 12 members -> mark tenant ACTIVE, set activated_at,
 *      set cycle columns, snapshot tenure rates.
 *      (Payout + fee intents are NOT generated here — they are generated
 *       once the cycle's 12 contributions are confirmed, in
 *       contributionsService.confirmContribution.)
 *   7. Audit every step.
 *
 * Idempotent: safe to call multiple times.
 */

import { withTransaction, pool } from '../../db';
import { env } from '../../config/env';
import { logger } from '../../logger';
import { record } from '../audit/audit.service';
import { usersRepository } from '../users/users.repository';
import { tenantsRepository, type TenantRow } from './tenants.repository';
import { tenureRenewalService } from './tenure-renewal.service';

export interface ProvisionResult {
  tenantId: string;
  slotNumber: number;
  tenantActivated: boolean;
  createdNewTenant: boolean;
  alreadyProvisioned: boolean;
  assignedAsReplacement?: boolean;
}

function pickRandomFreeSlot(used: number[], capacity: number): number | null {
  const free = Array.from({ length: capacity }, (_, i) => i + 1).filter((n) => !used.includes(n));
  if (free.length === 0) return null;
  return free[Math.floor(Math.random() * free.length)]!;
}

export class ProvisioningService {
  async provisionUserToTenant(userId: string, branchId: string): Promise<ProvisionResult> {
    // 1. Check if user is an admin. Admins do not get put into savings circles.
    const user = await usersRepository.findById(userId);
    if (!user || user.role !== 'SAVER') {
      logger.debug(
        { userId, role: user?.role },
        'Skipping tenant provisioning for non-saver'
      );

      return {
        tenantId: '',
        slotNumber: 0,
        tenantActivated: false,
        createdNewTenant: false,
        alreadyProvisioned: true,
      };
    }

    const selection = await pool.query<{ circle_configuration_id: string | null }>('SELECT circle_configuration_id FROM users WHERE id = $1', [userId]);
    let configurationId = selection.rows[0]?.circle_configuration_id ?? null;
    if (!configurationId) {
      const legacy = await pool.query<{ id: string }>("SELECT id FROM circle_configurations WHERE branch_id = $1 AND is_legacy = TRUE LIMIT 1", [branchId]);
      configurationId = legacy.rows[0]?.id ?? null;
    }
    if (!configurationId) throw new Error('No circle configuration selected for this saver');
    const configResult = await pool.query<{ member_capacity: number; contribution_amount: string; contribution_window_days: number; cycle_duration_days: number; name: string }>(
      'SELECT member_capacity, contribution_amount::text, contribution_window_days, cycle_duration_days, name FROM circle_configurations WHERE id = $1 AND branch_id = $2',
      [configurationId, branchId],
    );
    const config = configResult.rows[0];
    if (!config) throw new Error('Selected circle configuration does not belong to this branch');

    // 2. Already provisioned?
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

    // 3. Priority: renewing tenant waiting for a replacement?
    const replacing = await tenantsRepository.findReplacingByConfiguration(branchId, configurationId);
    if (replacing) {
      const result = await tenureRenewalService.tryAssignReplacement(branchId, userId, configurationId);
      if (result) {
        logger.info(
          { userId, tenantId: result.tenantId, slotNumber: result.slotNumber },
          'User provisioned as renewal replacement'
        );
        return {
          tenantId: result.tenantId,
          slotNumber: result.slotNumber,
          tenantActivated: false,
          createdNewTenant: false,
          alreadyProvisioned: false,
          assignedAsReplacement: true,
        };
      }
      // Fall through to normal provisioning if replacement couldn't be made
      // (e.g. no unfilled slots left).
    }

    // 4. Find or create FILLING tenant
    let tenant: TenantRow | null = await tenantsRepository.findOpenByConfiguration(branchId, configurationId);
    let createdNewTenant = false;

    if (!tenant) {
      // Count existing tenants to generate a sequential name (e.g., Tenant 01)
      const countRes = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM tenants WHERE branch_id = $1 AND configuration_id = $2`,
        [branchId, configurationId]
      );
      const tenantCount = Number(countRes.rows[0]?.count ?? '0');
      
      // Pad with zero: Tenant 01, Tenant 02
      const tenantName = `${config.name} ${String(tenantCount + 1).padStart(2, '0')}`;

      try {
        tenant = await tenantsRepository.insert(branchId, configurationId, config.member_capacity, config.cycle_duration_days, config.contribution_window_days, tenantName);
        createdNewTenant = true;
      } catch (error: any) {
        // Another concurrent provisioner may have created this stream's
        // filling tenant. Reuse it instead of creating a duplicate.
        if (error?.code !== '23505') throw error;
        tenant = await tenantsRepository.findOpenByConfiguration(branchId, configurationId);
        if (!tenant) throw error;
      }

      if (createdNewTenant) {
        await record({
          actorId: null,
          action: 'TENANT_CREATED',
          entityType: 'tenant',
          entityId: tenant.id,
          metadata: { branchId, configurationId, reason: 'auto-provisioning', tenantName },
        });
        logger.info({ tenantId: tenant.id, branchId, configurationId, tenantName }, 'Tenant auto-created');
      }
    }

    // 5. Assign slot inside a transaction so we never double-book
    const result = await withTransaction(async (tx) => {
      await tx.query('SELECT id FROM tenants WHERE id = $1 FOR UPDATE', [tenant!.id]);
      const usedSlotsRes = await tx.query<{ slot_number: number }>(
        `SELECT slot_number FROM tenant_memberships
         WHERE tenant_id = $1 AND status != 'REMOVED'`,
        [tenant!.id]
      );
      const used = usedSlotsRes.rows.map((r) => r.slot_number);

      const slot = pickRandomFreeSlot(used, tenant!.member_capacity_snapshot);
      if (slot === null) {
        throw new Error(`Tenant ${tenant!.id} unexpectedly full during provisioning`);
      }

      const membershipRes = await tx.query<{ id: string; slot_number: number }>(
        `INSERT INTO tenant_memberships (tenant_id, user_id, slot_number)
         VALUES ($1, $2, $3)
         RETURNING id, slot_number`,
        [tenant!.id, userId, slot]
      );
      const membership = membershipRes.rows[0]!;

      const countRes = await tx.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM tenant_memberships
         WHERE tenant_id = $1 AND status != 'REMOVED'`,
        [tenant!.id]
      );
      const memberCount = Number(countRes.rows[0]?.count ?? '0');

      let activated = false;

      if (memberCount >= tenant!.member_capacity_snapshot && tenant!.status === 'FILLING') {
        // Set activation + cycle + snapshot tenure rates
        await tx.query(
          `UPDATE tenants
           SET status = 'ACTIVE',
               activated_at = NOW(),
               current_tenure = 1,
               current_cycle = 1,
               cycle_started_at = NOW(),
               cycle_ends_at = NOW() + ($4 * INTERVAL '1 day'),
               cycle_contribution_deadline_at = NOW() + ($5 * INTERVAL '1 day'),
               cycle_payout_at = NOW() + ($4 * INTERVAL '1 day'),
               current_tenure_fee_bps = $2,
               current_tenure_tvc_bps = 0,
               tenure_started_at = NOW()
           WHERE id = $1 AND status = 'FILLING'`,
          [tenant!.id, env.PLATFORM_FEE_BPS, 0, config.cycle_duration_days, config.contribution_window_days]
        );
        activated = true;
      }

      await record(
        {
          actorId: null,
          action: 'TENANT_MEMBER_ASSIGNED',
          entityType: 'tenant_membership',
          entityId: membership.id,
          metadata: { tenantId: tenant!.id, userId, slotNumber: slot },
        },
        tx
      );

      if (activated) {
        await record(
          {
            actorId: null,
            action: 'TENANT_ACTIVATED',
            entityType: 'tenant',
            entityId: tenant!.id,
            metadata: {
              memberCount,
              feeBps: env.PLATFORM_FEE_BPS,
              tvcBps: 0,
            },
          },
          tx
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
      'User provisioned to tenant'
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