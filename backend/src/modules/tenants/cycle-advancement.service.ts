/**
 * Cycle advancement service.
 *
 * Event-driven - no cron, no scheduler. Called from:
 *   1. payoutsService.confirmPayout     (after ledger debit)
 *   2. tenantsService.getMyTenant       (lazy check on dashboard load)
 *   3. contributionsService.getOrCreateCurrentIntent (lazy check)
 *
 * Logic:
 *   - Lock the tenant row (SELECT ... FOR UPDATE)
 *   - Check: status=ACTIVE
 *   - Check: current cycle's payout_intent.state = CONFIRMED
 *   - If both true: advance the cycle (increment, reset timestamps, gen intents)
 *   - If cycle was 12: mark tenure COMPLETE and open renewal vote
 *   - If any check fails: silently do nothing (idempotent)
 *
 * Notifications:
 *   - After advancing to a new cycle: notify all tenant members
 *   - On cycle 12 completion: renewal service handles its own notifications
 */

import { logger } from '../../logger';
import { withTransaction } from '../../db';
import { tenantsRepository, type TenantRow } from './tenants.repository';
import { rotationService } from '../payouts/rotation.service';
import { tenureRenewalService } from './tenure-renewal.service';
import { notificationsService } from '../notifications/notifications.service';

export interface AdvancementResult {
  advanced: boolean;
  reason?: string;
  previousCycle?: number;
  newCycle?: number;
  tenantCompleted?: boolean;
  renewalOpened?: boolean;
  newPayoutIntentId?: string;
  newFeeIntentId?: string;
}

const CYCLES_PER_TENURE = 12;

interface TxResult {
  advanced: boolean;
  reason?: string;
  previousCycle?: number;
  newCycle?: number;
  tenantCompleted?: boolean;
  renewalOpened?: boolean;
}

export class CycleAdvancementService {
  async advanceIfCycleComplete(tenantId: string): Promise<AdvancementResult> {
    const pre = await tenantsRepository.findById(tenantId);
    if (!pre) return { advanced: false, reason: 'tenant_not_found' };
    if (pre.status !== 'ACTIVE') return { advanced: false, reason: 'not_active' };

    const txResult: TxResult = await withTransaction(async (tx) => {
      const lockRes = await tx.query<TenantRow>(
        `SELECT * FROM tenants WHERE id = $1 FOR UPDATE`,
        [tenantId],
      );
      const tenant = lockRes.rows[0];
      if (!tenant) return { advanced: false, reason: 'tenant_not_found' };

      if (tenant.status !== 'ACTIVE') return { advanced: false, reason: 'not_active' };

      const payoutRes = await tx.query<{ id: string; state: string }>(
        `SELECT id, state FROM payout_intents
         WHERE tenant_id = $1 AND tenure = $2 AND cycle = $3
         FOR UPDATE`,
        [tenant.id, tenant.current_tenure, tenant.current_cycle],
      );
      const payout = payoutRes.rows[0];
      if (!payout) {
        logger.warn(
          { tenantId, tenure: tenant.current_tenure, cycle: tenant.current_cycle },
          'CycleAdvancement: no payout_intent for current cycle - cannot advance',
        );
        return { advanced: false, reason: 'no_payout_intent' };
      }
      if (payout.state !== 'CONFIRMED') {
        logger.info(
          { tenantId, cycle: tenant.current_cycle, state: payout.state },
          'CycleAdvancement: current payout not yet confirmed - waiting',
        );
        return { advanced: false, reason: 'payout_not_confirmed' };
      }

      // Idempotency is enforced by the payout state check above.
      // Once we advance, the NEW cycle's payout is PENDING (freshly created),
      // so the next call will find it not CONFIRMED and will not double-advance.

      const previousCycle = tenant.current_cycle;
      const isFinalCycle = previousCycle >= CYCLES_PER_TENURE;

      if (isFinalCycle) {
        // Final cycle of the tenure: mark COMPLETED + open renewal.
        await tx.query(
          `UPDATE tenants
           SET status = 'COMPLETED',
               completed_at = NOW(),
               cycle_advanced_at = NOW()
           WHERE id = $1`,
          [tenant.id],
        );

        logger.info(
          { tenantId, tenure: tenant.current_tenure },
          'CycleAdvancement: tenure complete - opening renewal',
        );

        return {
          advanced: true,
          previousCycle,
          tenantCompleted: true,
          renewalOpened: true,
        };
      }

      const newCycle = previousCycle + 1;
      await tx.query(
        `UPDATE tenants
         SET current_cycle = $2,
             cycle_started_at = NOW(),
             cycle_ends_at = NOW() + INTERVAL '30 days',
             cycle_contribution_deadline_at = NOW() + INTERVAL '21 days',
             cycle_payout_at = NOW() + INTERVAL '30 days',
             cycle_advanced_at = NOW()
         WHERE id = $1`,
        [tenant.id, newCycle],
      );

      return {
        advanced: true,
        previousCycle,
        newCycle,
      };
    });

    const result: AdvancementResult = { ...txResult };

    if (result.renewalOpened) {
      try {
        await tenureRenewalService.openRenewalForTenant(tenantId);
        logger.info({ tenantId }, 'CycleAdvancement: renewal opened');
      } catch (err) {
        logger.error({ err, tenantId }, 'CycleAdvancement: failed to open renewal');
      }
      return result;
    }

    if (result.advanced && result.newCycle && !result.tenantCompleted) {
      // Generate next cycle's intents (idempotent)
      try {
        const tenant = await tenantsRepository.findById(tenantId);
        const tenureForIntents = tenant?.current_tenure ?? 1;

        const intents = await rotationService.ensureIntentsForCycle(
          tenantId,
          tenureForIntents,
          result.newCycle,
        );
        result.newPayoutIntentId = intents.payoutIntentId;
        result.newFeeIntentId = intents.feeIntentId;

        logger.info(
          {
            tenantId,
            tenure: tenureForIntents,
            newCycle: result.newCycle,
            payoutIntentId: intents.payoutIntentId,
            feeIntentId: intents.feeIntentId,
          },
          'CycleAdvancement: next cycle intents generated',
        );
      } catch (err) {
        logger.error(
          { err, tenantId, newCycle: result.newCycle },
          'CycleAdvancement: failed to generate next cycle intents',
        );
      }

      // Notify all tenant members (best-effort)
      try {
        const tenant = await tenantsRepository.findById(tenantId);
        if (tenant) {
          await notificationsService.notifyCycleAdvanced({
            tenantId,
            branchId: tenant.branch_id,
            newCycle: result.newCycle,
          });
        }
      } catch (err) {
        logger.error({ err, tenantId }, 'Cycle advanced notification failed');
      }
    }

    return result;
  }

  /**
   * Look up the tenant for a user, then attempt advancement.
   * Convenience wrapper for lazy triggers.
   */
  async advanceForUser(userId: string): Promise<AdvancementResult> {
    const membership = await tenantsRepository.findMembershipByUser(userId);
    if (!membership) return { advanced: false, reason: 'no_membership' };
    return this.advanceIfCycleComplete(membership.tenant_id);
  }
}

export const cycleAdvancementService = new CycleAdvancementService();