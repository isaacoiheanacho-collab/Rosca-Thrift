/**
 * Cycle advancement service.
 *
 * Event-driven — no cron, no scheduler. Called from:
 *   1. payoutsService.confirmPayout     (after ledger debit)
 *   2. tenantsService.getMyTenant       (lazy check on dashboard load)
 *   3. contributionsService.getOrCreateCurrentIntent (lazy check)
 *
 * Logic:
 *   - Lock the tenant row (SELECT ... FOR UPDATE)
 *   - Check: status=ACTIVE
 *   - Check: current cycle's payout_intent.state = CONFIRMED
 *   - If both true: advance the cycle (increment, reset timestamps, gen intents)
 *   - If cycle was 12: mark tenant COMPLETED
 *   - If any check fails: silently do nothing (idempotent)
 *
 * NOTE: This service intentionally does NOT check cycle_ends_at / time.
 * The trigger is "payout confirmed for current cycle" — a human action.
 * The 30-day window is a business rule, not a technical gate.
 *
 * Concurrency: uses a transaction with SELECT FOR UPDATE so parallel calls
 * can't double-advance.
 */

import { logger } from '../../logger';
import { withTransaction } from '../../db';
import { tenantsRepository, type TenantRow } from './tenants.repository';
import { rotationService } from '../payouts/rotation.service';

export interface AdvancementResult {
  advanced: boolean;
  reason?: string;
  previousCycle?: number;
  newCycle?: number;
  tenantCompleted?: boolean;
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
}

export class CycleAdvancementService {
  async advanceIfCycleComplete(tenantId: string): Promise<AdvancementResult> {
    // Fast pre-check (no lock) to avoid opening a transaction for tenants that
    // obviously don't need advancement.
    const pre = await tenantsRepository.findById(tenantId);
    if (!pre) return { advanced: false, reason: 'tenant_not_found' };
    if (pre.status !== 'ACTIVE') return { advanced: false, reason: 'not_active' };

    // Transaction: lock, check, advance if conditions met.
    const txResult: TxResult = await withTransaction(async (tx) => {
      // Lock the tenant row
      const lockRes = await tx.query<TenantRow>(
        `SELECT * FROM tenants WHERE id = $1 FOR UPDATE`,
        [tenantId],
      );
      const tenant = lockRes.rows[0];
      if (!tenant) return { advanced: false, reason: 'tenant_not_found' };

      // Re-check inside the lock
      if (tenant.status !== 'ACTIVE') return { advanced: false, reason: 'not_active' };

      // Check the current cycle's payout_intent state
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
          'CycleAdvancement: no payout_intent for current cycle — cannot advance',
        );
        return { advanced: false, reason: 'no_payout_intent' };
      }
      if (payout.state !== 'CONFIRMED') {
        logger.info(
          { tenantId, cycle: tenant.current_cycle, state: payout.state },
          'CycleAdvancement: current payout not yet confirmed — waiting',
        );
        return { advanced: false, reason: 'payout_not_confirmed' };
      }

      // Idempotency guard: if cycle_advanced_at is newer than cycle_started_at,
      // someone already advanced this tenant.
      if (
        tenant.cycle_advanced_at &&
        tenant.cycle_started_at &&
        tenant.cycle_advanced_at.getTime() >= tenant.cycle_started_at.getTime()
      ) {
        return { advanced: false, reason: 'already_advanced' };
      }

      const previousCycle = tenant.current_cycle;
      const isFinalCycle = previousCycle >= CYCLES_PER_TENURE;

      if (isFinalCycle) {
        // Complete the tenure
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
          'CycleAdvancement: tenant COMPLETED (tenure finished)',
        );

        return {
          advanced: true,
          previousCycle,
          tenantCompleted: true,
        };
      }

      // Advance to next cycle
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

    // If we advanced, generate next cycle's intents in a separate call.
    // This is safe because ensureIntentsForCycle is itself idempotent.
    const result: AdvancementResult = { ...txResult };

    if (result.advanced && result.newCycle && !result.tenantCompleted) {
      try {
        const intents = await rotationService.ensureIntentsForCycle(
          tenantId,
          /* tenure */ 1, // TODO: multi-tenure not yet implemented; tenure=1 always
          result.newCycle,
        );
        result.newPayoutIntentId = intents.payoutIntentId;
        result.newFeeIntentId = intents.feeIntentId;

        logger.info(
          {
            tenantId,
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