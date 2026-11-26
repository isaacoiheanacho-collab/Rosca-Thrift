/**
 * Provisioning service.
 *
 * Called by the existing saver provisioning workflow.
 *
 * Flow (in priority order):
 *   1. If user already has an active membership -> do nothing.
 *   2. If the user's branch has a tenant in renewal REPLACING state
 *      -> assign them to that tenant's unfilled slot (renewal replacement).
 *   3. Else find the oldest FILLING tenant in their branch.
 *      - If none exists -> create a new tenant for the branch.
 *   4. Pick a random free slot within the selected configuration capacity.
 *   5. Insert membership.
 *   6. If tenant reaches its configured capacity -> mark tenant ACTIVE, set activated_at,
 *      set cycle columns, snapshot the tenure fee and TVC settings.
 *      (Payout + fee intents are NOT generated here — they are generated
 *       once all configured contributions for the cycle are confirmed, in
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
    const configurationId = selection.rows[0]?.circle_configuration_id ?? null;
    if (!configurationId) {
      throw new Error('No circle configuration selected for this saver. Select a circle configuration before provisioning.');
    }
    const configResult = await pool.query<{ member_capacity: number; contribution_amount: string; contribution_frequency: 'WEEKLY' | 'MONTHLY'; name: string }>(
      'SELECT member_capacity, contribution_amount::text, contribution_frequency, name FROM circle_configurations WHERE id = $1 AND branch_id = $2',
      [configurationId, branchId],
    );
    const config = configResult.rows[0];
    if (!config) throw new Error('Selected circle configuration does not belong to this branch');
    const schedule = config.contribution_frequency === 'WEEKLY'
      ? { contributionWindowDays: 5, cycleDurationDays: 7 }
      : { contributionWindowDays: 21, cycleDurationDays: 30 };

    // 2. Existing membership must belong to the saver’s selected group.
    // Never treat membership in another configuration as valid for this group.
    const existingResult = await pool.query<{
      tenant_id: string;
      slot_number: number;
      configuration_id: string;
    }>(
      `SELECT tm.tenant_id, tm.slot_number, t.configuration_id
       FROM tenant_memberships tm
       JOIN tenants t ON t.id = tm.tenant_id
       WHERE tm.user_id = $1 AND tm.status <> 'REMOVED'
       ORDER BY tm.joined_at DESC
       LIMIT 1`,
      [userId],
    );
    const existing = existingResult.rows[0];
    if (existing) {
      if (existing.configuration_id !== configurationId) {
        throw new Error(
          `Saver ${userId} has an active membership in configuration ${existing.configuration_id}, but selected configuration is ${configurationId}. Manual reconciliation is required.`,
        );
      }
      logger.debug({ userId, tenantId: existing.tenant_id, configurationId }, 'Already provisioned in selected group');
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
      // Count tenants in this configuration to generate its own sequential name (e.g., Orange 1)
      const countRes = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM tenants WHERE branch_id = $1 AND configuration_id = $2`,
        [branchId, configurationId]
      );
      const tenantCount = Number(countRes.rows[0]?.count ?? '0');
      
      // Tenant sequence is independent for each configuration.
      const tenantName = `${config.name} ${tenantCount + 1}`;

      try {
        tenant = await tenantsRepository.insert(branchId, configurationId, config.member_capacity, schedule.cycleDurationDays, schedule.contributionWindowDays, tenantName);
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
        return { slot: 0, activated: false, memberCount: used.length, full: true };
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
               cycle_ends_at = NOW() + ($3 * INTERVAL '1 day'),
               cycle_contribution_deadline_at = NOW() + ($4 * INTERVAL '1 day'),
               cycle_payout_at = NOW() + ($3 * INTERVAL '1 day'),
               current_tenure_fee_bps = $2,
               current_tenure_tvc_bps = 0,
               tenure_started_at = NOW()
           WHERE id = $1 AND status = 'FILLING'`,
          [tenant!.id, env.PLATFORM_FEE_BPS, schedule.cycleDurationDays, schedule.contributionWindowDays]
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

      return { slot, activated, memberCount, full: false };
    });

    if (result.full) {
      // A concurrent provisioner filled this tenant while this request waited
      // for its row lock. Retry lazily; the next tenant is created only now.
      return this.provisionUserToTenant(userId, branchId);
    }

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