/**
 * Rotation service — determines the recipient for a cycle and generates
 * the payout + fee intents.
 *
 * Rule (from project spec):
 *   - Slot number = collection cycle. Slot 1 collects in cycle 1, slot 12 in cycle 12.
 *   - Slot assignment is random (done at tenant activation).
 *   - Recipient is the member with slot_number = current cycle.
 */

import { logger } from '../../logger';
import { env } from '../../config/env';
import { withTransaction } from '../../db';
import { AppError, NotFoundError } from '../../errors';
import { buildPayoutReference, buildFeeReference } from '../../utils/reference';
import { tenantsRepository } from '../tenants/tenants.repository';
import { payoutsRepository } from './payouts.repository';
import { calculateTvc, calculateFee } from './tvc.service';

/** Circle size is fixed at 12 by design (enforced by schema check on slot_number). */
const CIRCLE_SIZE = 12;

export interface GenerateIntentsResult {
  payoutIntentId: string;
  feeIntentId: string;
  recipientUserId: string;
  recipientSlot: number;
  grossPence: string;
  tvcAdjustmentPence: string;
  platformFeePence: string;
  netToRecipientPence: string;
  created: boolean;
}

export class RotationService {
  /**
   * Ensure that for the given tenant + cycle, the payout + fee intents exist.
   * Idempotent — safe to call multiple times.
   */
  async ensureIntentsForCycle(
    tenantId: string,
    tenure: number,
    cycle: number,
  ): Promise<GenerateIntentsResult> {
    const tenant = await tenantsRepository.findById(tenantId);
    if (!tenant) throw new NotFoundError('Tenant');

    if (cycle < 1 || cycle > 12) {
      throw new AppError({
        code: 'PAYOUT_INVALID_CYCLE',
        httpStatus: 400,
        message: `Invalid cycle: ${cycle}`,
      });
    }

    // If payout intent already exists, return it
    const existing = await payoutsRepository.findPayoutIntent(tenantId, tenure, cycle);
    if (existing) {
      return {
        payoutIntentId: existing.id,
        feeIntentId: existing.fee_intent_id ?? '',
        recipientUserId: existing.recipient_user_id,
        recipientSlot: existing.recipient_slot,
        grossPence: existing.gross_amount.toString(),
        tvcAdjustmentPence: existing.tvc_adjustment.toString(),
        platformFeePence: existing.platform_fee.toString(),
        netToRecipientPence: existing.net_amount.toString(),
        created: false,
      };
    }

    // Find the recipient — slot number === cycle
    const memberships = await tenantsRepository.findMembershipsByTenant(tenantId);
    const recipient = memberships.find((m) => m.slot_number === cycle);
    if (!recipient) {
      throw new AppError({
        code: 'PAYOUT_NO_RECIPIENT',
        httpStatus: 409,
        message: `No member in slot ${cycle}`,
      });
    }

    // Compute amounts
    const gross = BigInt(env.CONTRIBUTION_PENCE) * BigInt(CIRCLE_SIZE);
    const tvc = calculateTvc(gross, cycle, tenant.current_tenure_tvc_bps);
    const fee = calculateFee(tvc.potAfterTvc, tenant.current_tenure_fee_bps);

    const payoutReference = buildPayoutReference(tenantId, cycle, tenure, cycle);
    const feeReference = buildFeeReference(tenantId, tenure);

    const result = await withTransaction(async (tx) => {
      const feeIntent = await payoutsRepository.insertFeeIntent(
        {
          tenantId: tenant.id,
          branchId: tenant.branch_id,
          tenure,
          cycle,
          reference: feeReference,
          amount: fee.fee,
          feeBps: tenant.current_tenure_fee_bps,
        },
        tx,
      );

      const payoutIntent = await payoutsRepository.insertPayoutIntent(
        {
          tenantId: tenant.id,
          branchId: tenant.branch_id,
          tenure,
          cycle,
          recipientUserId: recipient.user_id,
          recipientMembershipId: recipient.id,
          recipientSlot: recipient.slot_number,
          reference: payoutReference,
          grossAmount: gross,
          tvcAdjustment: tvc.adjustment,
          potAfterTvc: tvc.potAfterTvc,
          platformFee: fee.fee,
          netAmount: fee.net,
          tvcBps: tenant.current_tenure_tvc_bps,
          feeBps: tenant.current_tenure_fee_bps,
          feeIntentId: feeIntent.id,
        },
        tx,
      );

      return { payoutIntent, feeIntent };
    });

    logger.info(
      {
        tenantId,
        tenure,
        cycle,
        payoutIntentId: result.payoutIntent.id,
        feeIntentId: result.feeIntent.id,
        recipientSlot: recipient.slot_number,
        netToRecipient: fee.net.toString(),
      },
      'Payout + fee intents generated for cycle',
    );

    return {
      payoutIntentId: result.payoutIntent.id,
      feeIntentId: result.feeIntent.id,
      recipientUserId: recipient.user_id,
      recipientSlot: recipient.slot_number,
      grossPence: gross.toString(),
      tvcAdjustmentPence: tvc.adjustment.toString(),
      platformFeePence: fee.fee.toString(),
      netToRecipientPence: fee.net.toString(),
      created: true,
    };
  }
}

export const rotationService = new RotationService();