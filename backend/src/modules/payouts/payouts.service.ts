/**
 * Payouts service — business logic for the outbound payout flow.
 *
 * Sequence for one cycle:
 *   1. Rotation service generates payout_intent + fee_intent (on cycle start).
 *   2. Branch admin uploads fee receipt.
 *   3. Super admin confirms fee → payout_intent.state = FEE_PAID.
 *   4. Branch admin uploads payout receipt.
 *   5. Branch admin marks done → payout_intent.state = CONFIRMED.
 *   6. Ledger: debit tenant pool (payout amount), credit platform (fee amount).
 *   7. After payout confirmed, trigger cycle advancement (event-driven).
 */

import { logger } from '../../logger';
import { withTransaction } from '../../db';
import { AppError, ConflictError, NotFoundError } from '../../errors';
import { uploadObject } from '../../utils/s3';
import { record } from '../audit/audit.service';
import { ledgerService } from '../ledger/ledger.service';
import { usersRepository } from '../users/users.repository';
import { cycleAdvancementService } from '../tenants/cycle-advancement.service';
import { payoutsRepository, type PayoutIntentRow, type PlatformFeeIntentRow } from './payouts.repository';

export interface RequestMeta {
  ipAddress?: string;
  userAgent?: string;
}

export interface PayoutIntentDto {
  id: string;
  tenantId: string;
  branchId: string;
  tenure: number;
  cycle: number;
  recipientUserId: string;
  recipientName: string;
  recipientSlot: number;
  reference: string;
  grossPence: string;
  tvcAdjustmentPence: string;
  potAfterTvcPence: string;
  platformFeePence: string;
  netAmountPence: string;
  netAmountGbp: string;
  currency: string;
  tvcBps: number;
  feeBps: number;
  state: 'PENDING' | 'FEE_PAID' | 'RECEIPT_UPLOADED' | 'CONFIRMED';
  feeConfirmedAt: string | null;
  payoutConfirmedAt: string | null;
  feeIntentId: string | null;
  createdAt: string;
}

export interface PlatformFeeIntentDto {
  id: string;
  tenantId: string;
  branchId: string;
  tenure: number;
  cycle: number;
  reference: string;
  amountPence: string;
  amountGbp: string;
  currency: string;
  feeBps: number;
  state: 'PENDING' | 'RECEIPT_UPLOADED' | 'CONFIRMED';
  confirmedAt: string | null;
  createdAt: string;
}

async function payoutToDto(row: PayoutIntentRow): Promise<PayoutIntentDto> {
  const recipient = await usersRepository.findById(row.recipient_user_id);
  return {
    id: row.id,
    tenantId: row.tenant_id,
    branchId: row.branch_id,
    tenure: row.tenure,
    cycle: row.cycle,
    recipientUserId: row.recipient_user_id,
    recipientName: recipient?.full_name ?? 'Unknown',
    recipientSlot: row.recipient_slot,
    reference: row.reference,
    grossPence: row.gross_amount.toString(),
    tvcAdjustmentPence: row.tvc_adjustment.toString(),
    potAfterTvcPence: row.pot_after_tvc.toString(),
    platformFeePence: row.platform_fee.toString(),
    netAmountPence: row.net_amount.toString(),
    netAmountGbp: (Number(row.net_amount) / 100).toFixed(2),
    currency: row.currency,
    tvcBps: row.tvc_bps,
    feeBps: row.fee_bps,
    state: row.state,
    feeConfirmedAt: row.fee_confirmed_at?.toISOString() ?? null,
    payoutConfirmedAt: row.payout_confirmed_at?.toISOString() ?? null,
    feeIntentId: row.fee_intent_id,
    createdAt: row.created_at.toISOString(),
  };
}

function feeToDto(row: PlatformFeeIntentRow): PlatformFeeIntentDto {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    branchId: row.branch_id,
    tenure: row.tenure,
    cycle: row.cycle,
    reference: row.reference,
    amountPence: row.amount.toString(),
    amountGbp: (Number(row.amount) / 100).toFixed(2),
    currency: row.currency,
    feeBps: row.fee_bps,
    state: row.state,
    confirmedAt: row.confirmed_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  };
}

export class PayoutsService {
  async getPayoutById(id: string): Promise<PayoutIntentDto> {
    const row = await payoutsRepository.findPayoutIntentById(id);
    if (!row) throw new NotFoundError('Payout intent');
    return payoutToDto(row);
  }

  async getFeeIntentById(id: string): Promise<PlatformFeeIntentDto> {
    const row = await payoutsRepository.findFeeIntentById(id);
    if (!row) throw new NotFoundError('Fee intent');
    return feeToDto(row);
  }

  async listPayoutsByBranch(
    branchId: string,
    options: {
      limit: number;
      offset: number;
      state?: 'PENDING' | 'FEE_PAID' | 'RECEIPT_UPLOADED' | 'CONFIRMED';
    },
  ): Promise<{ intents: PayoutIntentDto[]; total: number }> {
    const { intents, total } = await payoutsRepository.listPayoutsByBranch(branchId, options);
    const dtos = await Promise.all(intents.map(payoutToDto));
    return { intents: dtos, total };
  }

  async listPayoutsByTenant(tenantId: string): Promise<PayoutIntentDto[]> {
    const rows = await payoutsRepository.listPayoutsByTenant(tenantId, 100);
    return Promise.all(rows.map(payoutToDto));
  }

  async listPayoutsByRecipient(userId: string): Promise<PayoutIntentDto[]> {
    const rows = await payoutsRepository.listPayoutsByRecipient(userId);
    return Promise.all(rows.map(payoutToDto));
  }

  async listPendingFeeIntents(options: { limit: number; offset: number }): Promise<{
    intents: PlatformFeeIntentDto[];
    total: number;
  }> {
    const { intents, total } = await payoutsRepository.listPendingFeeIntents(options);
    return { intents: intents.map(feeToDto), total };
  }

  /**
   * Branch admin uploads proof of platform fee payment.
   * Transitions fee_intent from PENDING → RECEIPT_UPLOADED.
   */
  async uploadFeeReceipt(
    feeIntentId: string,
    branchId: string,
    input: {
      claimedAmount: bigint;
      claimedReference: string;
      claimedSenderName: string;
      claimedNote?: string;
    },
    file: { buffer: Buffer; mimetype: string; originalname: string; size: number },
    actorId: string,
    meta: RequestMeta,
  ): Promise<PlatformFeeIntentDto> {
    const fee = await payoutsRepository.findFeeIntentById(feeIntentId);
    if (!fee) throw new NotFoundError('Fee intent');
    if (fee.branch_id !== branchId) {
      throw new AppError({
        code: 'AUTH_BRANCH_SCOPE',
        httpStatus: 403,
        message: 'Not permitted for this branch',
      });
    }
    if (fee.state === 'CONFIRMED') {
      throw new ConflictError('Fee already confirmed', 'FEE_ALREADY_CONFIRMED');
    }

    const objectKey = `receipts/fees/${fee.branch_id}/${fee.id}/${Date.now()}-${file.originalname}`;
    await uploadObject(objectKey, file.buffer, file.mimetype, {
      actorId,
      branchId: fee.branch_id,
      purpose: 'platform-fee',
    });

    const payout = await payoutsRepository.findPayoutIntent(
      fee.tenant_id,
      fee.tenure,
      fee.cycle,
    );
    if (!payout) {
      throw new AppError({
        code: 'PAYOUT_NOT_FOUND_FOR_FEE',
        httpStatus: 500,
        message: 'Orphan fee intent — payout missing',
      });
    }

    await withTransaction(async (tx) => {
      await tx.query(
        `INSERT INTO receipts
           (purpose, payout_id, uploaded_by, branch_id,
            object_key, file_name, mime_type, size_bytes,
            claimed_amount, claimed_reference, claimed_sender_name, claimed_note)
         VALUES ('PLATFORM_FEE', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          payout.id,
          actorId,
          fee.branch_id,
          objectKey,
          file.originalname,
          file.mimetype,
          BigInt(file.size),
          input.claimedAmount,
          input.claimedReference,
          input.claimedSenderName,
          input.claimedNote ?? null,
        ],
      );

      await payoutsRepository.updateFeeIntentState(fee.id, 'RECEIPT_UPLOADED', null, tx);
    });

    await record({
      actorId,
      action: 'FEE_RECEIPT_UPLOADED',
      entityType: 'platform_fee_intent',
      entityId: fee.id,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      metadata: { objectKey, claimedAmount: input.claimedAmount.toString() },
    });

    logger.info({ feeIntentId: fee.id, actorId }, 'Fee receipt uploaded');
    const refreshed = await payoutsRepository.findFeeIntentById(fee.id);
    return feeToDto(refreshed!);
  }

  /**
   * Super admin confirms platform fee received.
   * Transitions fee PENDING → CONFIRMED and payout → FEE_PAID.
   * Credits the platform maintenance ledger account.
   */
  async confirmFee(
    feeIntentId: string,
    adminId: string,
    adminNote: string | null,
    meta: RequestMeta,
  ): Promise<{ fee: PlatformFeeIntentDto; payout: PayoutIntentDto }> {
    const fee = await payoutsRepository.findFeeIntentById(feeIntentId);
    if (!fee) throw new NotFoundError('Fee intent');
    if (fee.state === 'CONFIRMED') {
      throw new ConflictError('Fee already confirmed', 'FEE_ALREADY_CONFIRMED');
    }

    const payout = await payoutsRepository.findPayoutIntent(
      fee.tenant_id,
      fee.tenure,
      fee.cycle,
    );
    if (!payout) throw new NotFoundError('Payout intent');

    await withTransaction(async (tx) => {
      await payoutsRepository.updateFeeIntentState(fee.id, 'CONFIRMED', adminId, tx);
      await payoutsRepository.updatePayoutState(
        payout.id,
        'FEE_PAID',
        { feeConfirmedBy: adminId },
        tx,
      );

      await ledgerService.creditPlatformFee(
        {
          tenantId: fee.tenant_id,
          branchId: fee.branch_id,
          reference: fee.reference,
          amount: fee.amount,
          description: `Platform fee confirmed by super admin for cycle ${fee.cycle}`,
          createdBy: adminId,
        },
        tx,
      );
    });

    await record({
      actorId: adminId,
      action: 'FEE_CONFIRMED',
      entityType: 'platform_fee_intent',
      entityId: fee.id,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      metadata: {
        tenantId: fee.tenant_id,
        cycle: fee.cycle,
        amount: fee.amount.toString(),
        adminNote,
      },
    });

    logger.info(
      { feeIntentId: fee.id, payoutIntentId: payout.id, adminId },
      'Fee confirmed, payout unlocked',
    );

    const refreshedFee = await payoutsRepository.findFeeIntentById(fee.id);
    const refreshedPayout = await payoutsRepository.findPayoutIntentById(payout.id);
    return { fee: feeToDto(refreshedFee!), payout: await payoutToDto(refreshedPayout!) };
  }

  /**
   * Branch admin uploads proof of payout to recipient.
   * Transitions payout FEE_PAID → RECEIPT_UPLOADED.
   */
  async uploadPayoutReceipt(
    payoutId: string,
    branchId: string,
    input: {
      claimedAmount: bigint;
      claimedReference: string;
      claimedRecipientName: string;
      claimedNote?: string;
    },
    file: { buffer: Buffer; mimetype: string; originalname: string; size: number },
    actorId: string,
    meta: RequestMeta,
  ): Promise<PayoutIntentDto> {
    const payout = await payoutsRepository.findPayoutIntentById(payoutId);
    if (!payout) throw new NotFoundError('Payout intent');
    if (payout.branch_id !== branchId) {
      throw new AppError({
        code: 'AUTH_BRANCH_SCOPE',
        httpStatus: 403,
        message: 'Not permitted for this branch',
      });
    }
    if (payout.state === 'CONFIRMED') {
      throw new ConflictError('Payout already confirmed', 'PAYOUT_ALREADY_CONFIRMED');
    }
    if (payout.state === 'PENDING') {
      throw new ConflictError(
        'Platform fee not yet confirmed — payout not unlocked',
        'PAYOUT_FEE_NOT_CONFIRMED',
      );
    }

    const objectKey = `receipts/payouts/${payout.branch_id}/${payout.id}/${Date.now()}-${file.originalname}`;
    await uploadObject(objectKey, file.buffer, file.mimetype, {
      actorId,
      branchId: payout.branch_id,
      purpose: 'payout',
    });

    await withTransaction(async (tx) => {
      await tx.query(
        `INSERT INTO receipts
           (purpose, payout_id, uploaded_by, branch_id,
            object_key, file_name, mime_type, size_bytes,
            claimed_amount, claimed_reference, claimed_sender_name, claimed_note)
         VALUES ('PAYOUT', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          payout.id,
          actorId,
          payout.branch_id,
          objectKey,
          file.originalname,
          file.mimetype,
          BigInt(file.size),
          input.claimedAmount,
          input.claimedReference,
          input.claimedRecipientName,
          input.claimedNote ?? null,
        ],
      );

      await payoutsRepository.updatePayoutState(payout.id, 'RECEIPT_UPLOADED', {}, tx);
    });

    await record({
      actorId,
      action: 'PAYOUT_RECEIPT_UPLOADED',
      entityType: 'payout_intent',
      entityId: payout.id,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      metadata: { objectKey, claimedAmount: input.claimedAmount.toString() },
    });

    logger.info({ payoutId: payout.id, actorId }, 'Payout receipt uploaded');
    const refreshed = await payoutsRepository.findPayoutIntentById(payout.id);
    return payoutToDto(refreshed!);
  }

  /**
   * Branch admin confirms payout complete.
   * Transitions payout → CONFIRMED. Debits tenant ledger.
   * Then triggers cycle advancement (event-driven).
   */
  async confirmPayout(
    payoutId: string,
    branchId: string,
    actorId: string,
    meta: RequestMeta,
  ): Promise<PayoutIntentDto> {
    const payout = await payoutsRepository.findPayoutIntentById(payoutId);
    if (!payout) throw new NotFoundError('Payout intent');
    if (payout.branch_id !== branchId) {
      throw new AppError({
        code: 'AUTH_BRANCH_SCOPE',
        httpStatus: 403,
        message: 'Not permitted for this branch',
      });
    }
    if (payout.state === 'CONFIRMED') {
      throw new ConflictError('Payout already confirmed', 'PAYOUT_ALREADY_CONFIRMED');
    }
    if (payout.state !== 'RECEIPT_UPLOADED') {
      throw new ConflictError(
        'Payout receipt must be uploaded first',
        'PAYOUT_RECEIPT_REQUIRED',
      );
    }

    await withTransaction(async (tx) => {
      await payoutsRepository.updatePayoutState(
        payout.id,
        'CONFIRMED',
        { payoutConfirmedBy: actorId },
        tx,
      );

      await ledgerService.debitPayout(
        {
          tenantId: payout.tenant_id,
          branchId: payout.branch_id,
          reference: payout.reference,
          amount: payout.net_amount,
          payoutId: payout.id,
          description: `Payout to slot ${payout.recipient_slot} for cycle ${payout.cycle}`,
          createdBy: actorId,
        },
        tx,
      );
    });

    await record({
      actorId,
      action: 'PAYOUT_CONFIRMED',
      entityType: 'payout_intent',
      entityId: payout.id,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      metadata: {
        tenantId: payout.tenant_id,
        cycle: payout.cycle,
        recipientSlot: payout.recipient_slot,
        netAmount: payout.net_amount.toString(),
      },
    });

    logger.info(
      { payoutId: payout.id, actorId, netAmount: payout.net_amount.toString() },
      'Payout confirmed, ledger debited',
    );

    // ─────────────────────────────────────────────────────────────
    // Event-driven cycle advancement:
    // After payout is confirmed, the current cycle is complete.
    // Advance the tenant to the next cycle (idempotent).
    // ─────────────────────────────────────────────────────────────
    try {
      const adv = await cycleAdvancementService.advanceIfCycleComplete(payout.tenant_id);
      logger.info(
        {
          tenantId: payout.tenant_id,
          advanced: adv.advanced,
          reason: adv.reason,
          previousCycle: adv.previousCycle,
          newCycle: adv.newCycle,
          tenantCompleted: adv.tenantCompleted,
        },
        'Payout confirmed, cycle advancement attempted',
      );
    } catch (err) {
      logger.error({ err, tenantId: payout.tenant_id }, 'Cycle advancement failed');
    }

    const refreshed = await payoutsRepository.findPayoutIntentById(payout.id);
    return payoutToDto(refreshed!);
  }
}

export const payoutsService = new PayoutsService();