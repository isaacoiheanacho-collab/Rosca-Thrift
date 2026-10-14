/**
 * Payouts service — business logic for the outbound payout flow.
 *
 * Sequence for one cycle:
 *   1. Rotation service generates payout_intent + fee_intent (on cycle start).
 *   2. Branch admin uploads fee receipt.
 *   3. Super admin confirms fee → payout_intent.state = FEE_PAID.
 *      OR super admin rejects fee → fee_intent.state = PENDING (retry).
 *   4. Branch admin uploads payout receipt.
 *   5. Branch admin marks done → payout_intent.state = CONFIRMED.
 *      OR branch admin marks failed → payout_intent.state = FAILED.
 *   6. Ledger: debit tenant pool (payout amount), credit platform (fee amount).
 *   7. After payout confirmed, trigger cycle advancement (event-driven).
 *
 * Failed payouts: a FAILED payout can be retried. Retry creates a NEW
 * payout_intent (with retry_of_payout_id pointing to the original) but
 * REUSES the original fee intent — the branch does not pay the fee twice
 * for the same cycle. New retry payout starts at FEE_PAID.
 */

import { logger } from '../../logger';
import { withTransaction, pool } from '../../db';
import { AppError, ConflictError, NotFoundError } from '../../errors';
import { uploadObject } from '../../utils/s3';
import { record } from '../audit/audit.service';
import { ledgerService } from '../ledger/ledger.service';
import { usersRepository } from '../users/users.repository';
import { branchesRepository } from '../branches/branches.repository';
import { cycleAdvancementService } from '../tenants/cycle-advancement.service';
import { notificationsService } from '../notifications/notifications.service';
import {
  payoutsRepository,
  type PayoutIntentRow,
  type PlatformFeeIntentRow,
  type PayoutIntentState,
} from './payouts.repository';
import { payoutFailuresRepository } from './payout-failures.repository';

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
  state: PayoutIntentState;
  feeConfirmedAt: string | null;
  payoutConfirmedAt: string | null;
  feeIntentId: string | null;
  failedAt: string | null;
  failureReason: string | null;
  retryOfPayoutId: string | null;
  retryCount: number;
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

export interface FailedPayoutDto extends PayoutIntentDto {
  tenantName: string | null;
  branchName: string;
  failureReasonSafe: string;
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
    failedAt: row.failed_at?.toISOString() ?? null,
    failureReason: row.failure_reason,
    retryOfPayoutId: row.retry_of_payout_id,
    retryCount: row.retry_count,
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
  // ─────────────────────────────────────────────────────────────
  // Read APIs
  // ─────────────────────────────────────────────────────────────

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
      state?: PayoutIntentState;
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

  async listFailedPayouts(options: {
    limit: number;
    offset: number;
    onlyUnretried?: boolean;
  }): Promise<{ intents: FailedPayoutDto[]; total: number }> {
    const { intents, total } = await payoutsRepository.listFailedPayouts(options);

    const dtos: FailedPayoutDto[] = [];
    for (const row of intents) {
      const dto = await payoutToDto(row);
      const tenant = await pool.query<{ name: string | null }>(
        `SELECT name FROM tenants WHERE id = $1`,
        [row.tenant_id],
      );
      const branch = await branchesRepository.findById(row.branch_id);

      dtos.push({
        ...dto,
        tenantName: tenant.rows[0]?.name ?? null,
        branchName: branch?.name ?? 'Branch',
        failureReasonSafe: row.failure_reason ?? 'Payout could not be completed',
      });
    }

    return { intents: dtos, total };
  }

  // ─────────────────────────────────────────────────────────────
  // Fee flow
  // ─────────────────────────────────────────────────────────────

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

    try {
      const branch = await branchesRepository.findById(fee.branch_id);
      await notificationsService.notifyFeeReceiptUploaded({
        tenantId: fee.tenant_id,
        branchId: fee.branch_id,
        cycle: fee.cycle,
        feeIntentId: fee.id,
        branchName: branch?.name ?? 'Branch',
      });
    } catch (err) {
      logger.error({ err, feeIntentId: fee.id }, 'Fee upload notification failed');
    }

    const refreshed = await payoutsRepository.findFeeIntentById(fee.id);
    return feeToDto(refreshed!);
  }

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

    try {
      await notificationsService.notifyFeeConfirmed({
        tenantId: fee.tenant_id,
        branchId: fee.branch_id,
        cycle: fee.cycle,
        payoutIntentId: payout.id,
        reference: payout.reference,
      });
    } catch (err) {
      logger.error({ err, feeIntentId: fee.id }, 'Fee confirmed notification failed');
    }

    const refreshedFee = await payoutsRepository.findFeeIntentById(fee.id);
    const refreshedPayout = await payoutsRepository.findPayoutIntentById(payout.id);
    return { fee: feeToDto(refreshedFee!), payout: await payoutToDto(refreshedPayout!) };
  }

  async rejectFee(
    feeIntentId: string,
    adminId: string,
    reason: string,
    meta: RequestMeta,
  ): Promise<PlatformFeeIntentDto> {
    const fee = await payoutsRepository.findFeeIntentById(feeIntentId);
    if (!fee) throw new NotFoundError('Fee intent');
    if (fee.state === 'CONFIRMED') {
      throw new ConflictError(
        'Cannot reject a confirmed fee',
        'FEE_ALREADY_CONFIRMED',
      );
    }
    if (fee.state !== 'RECEIPT_UPLOADED') {
      throw new ConflictError(
        'Only receipts awaiting verification can be rejected',
        'FEE_NOT_PENDING_VERIFICATION',
      );
    }

    const updated = await payoutsRepository.updateFeeIntentState(
      fee.id,
      'PENDING',
      null,
    );

    await record({
      actorId: adminId,
      action: 'FEE_REJECTED',
      entityType: 'platform_fee_intent',
      entityId: fee.id,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      metadata: {
        tenantId: fee.tenant_id,
        cycle: fee.cycle,
        reason,
      },
    });

    logger.info(
      { feeIntentId: fee.id, adminId, reason },
      'Fee rejected, awaiting re-upload',
    );

    try {
      await notificationsService.notifyFeeRejected({
        tenantId: fee.tenant_id,
        branchId: fee.branch_id,
        cycle: fee.cycle,
        feeIntentId: fee.id,
        reason,
      });
    } catch (err) {
      logger.error({ err, feeIntentId: fee.id }, 'Fee rejected notification failed');
    }

    return feeToDto(updated);
  }

  // ─────────────────────────────────────────────────────────────
  // Payout flow
  // ─────────────────────────────────────────────────────────────

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
    if (payout.state === 'FAILED') {
      throw new ConflictError(
        'Payout is marked failed — retry it to issue a new payout intent',
        'PAYOUT_IS_FAILED',
      );
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

    try {
      const recipient = await usersRepository.findById(payout.recipient_user_id);
      await notificationsService.notifyPayoutReceiptUploaded({
        tenantId: payout.tenant_id,
        branchId: payout.branch_id,
        cycle: payout.cycle,
        payoutIntentId: payout.id,
        recipientName: recipient?.full_name ?? 'A member',
        recipientSlot: payout.recipient_slot,
        netAmount: payout.net_amount,
      });
    } catch (err) {
      logger.error({ err, payoutId: payout.id }, 'Payout receipt notification failed');
    }

    const refreshed = await payoutsRepository.findPayoutIntentById(payout.id);
    return payoutToDto(refreshed!);
  }

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
    if (payout.state === 'FAILED') {
      throw new ConflictError(
        'Payout is marked failed — retry it to issue a new payout intent',
        'PAYOUT_IS_FAILED',
      );
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

  // ─────────────────────────────────────────────────────────────
  // Failure + retry
  // ─────────────────────────────────────────────────────────────

  async markPayoutFailed(
    payoutId: string,
    branchId: string | null,
    reason: string,
    notes: string | null,
    actorId: string,
    meta: RequestMeta,
  ): Promise<PayoutIntentDto> {
    const payout = await payoutsRepository.findPayoutIntentById(payoutId);
    if (!payout) throw new NotFoundError('Payout intent');

    if (branchId !== null && payout.branch_id !== branchId) {
      throw new AppError({
        code: 'AUTH_BRANCH_SCOPE',
        httpStatus: 403,
        message: 'Not permitted for this branch',
      });
    }

    if (payout.state === 'CONFIRMED') {
      throw new ConflictError(
        'Payout is already confirmed — cannot fail it',
        'PAYOUT_ALREADY_CONFIRMED',
      );
    }
    if (payout.state === 'FAILED') {
      throw new ConflictError('Payout is already marked failed', 'PAYOUT_ALREADY_FAILED');
    }

    await withTransaction(async (tx) => {
      await payoutsRepository.updatePayoutState(
        payout.id,
        'FAILED',
        { failedBy: actorId, failureReason: reason },
        tx,
      );

      await payoutFailuresRepository.insert(
        {
          payoutId: payout.id,
          tenantId: payout.tenant_id,
          branchId: payout.branch_id,
          reason,
          markedBy: actorId,
          notes,
        },
        tx,
      );
    });

    await record({
      actorId,
      action: 'PAYOUT_FAILED',
      entityType: 'payout_intent',
      entityId: payout.id,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      metadata: {
        tenantId: payout.tenant_id,
        cycle: payout.cycle,
        reason,
      },
    });

    logger.warn(
      { payoutId: payout.id, actorId, reason },
      'Payout marked failed',
    );

    try {
      await notificationsService.notifyPayoutFailed({
        tenantId: payout.tenant_id,
        branchId: payout.branch_id,
        cycle: payout.cycle,
        payoutIntentId: payout.id,
      });
    } catch (err) {
      logger.error({ err, payoutId: payout.id }, 'Payout failed notification failed');
    }

    const refreshed = await payoutsRepository.findPayoutIntentById(payout.id);
    return payoutToDto(refreshed!);
  }

  /**
   * Retry a FAILED payout. Creates a NEW payout_intent linked via
   * retry_of_payout_id. The original platform fee intent is REUSED — the
   * branch already paid the fee for this cycle, retry does not re-charge it.
   *
   * The new payout starts in state FEE_PAID (fee already settled), so the
   * branch admin can go straight to uploading a payout receipt.
   *
   * The original FAILED intent stays in the DB for audit.
   */
  async retryPayout(
    payoutId: string,
    branchId: string | null,
    actorId: string,
    meta: RequestMeta,
  ): Promise<PayoutIntentDto> {
    const original = await payoutsRepository.findPayoutIntentById(payoutId);
    if (!original) throw new NotFoundError('Payout intent');

    if (branchId !== null && original.branch_id !== branchId) {
      throw new AppError({
        code: 'AUTH_BRANCH_SCOPE',
        httpStatus: 403,
        message: 'Not permitted for this branch',
      });
    }

    if (original.state !== 'FAILED') {
      throw new ConflictError(
        'Only failed payouts can be retried',
        'PAYOUT_NOT_FAILED',
      );
    }

    const existingRetry = await pool.query<{ id: string }>(
      `SELECT id FROM payout_intents WHERE retry_of_payout_id = $1 LIMIT 1`,
      [original.id],
    );
    if (existingRetry.rows.length > 0) {
      throw new ConflictError(
        'A retry already exists for this failed payout',
        'PAYOUT_RETRY_EXISTS',
      );
    }

    if (!original.fee_intent_id) {
      throw new AppError({
        code: 'PAYOUT_NO_FEE_INTENT',
        httpStatus: 500,
        message: 'Original payout has no fee intent — cannot retry',
      });
    }

    // Capture into a local so TypeScript keeps the narrowing inside the
    // withTransaction callback below.
    const feeIntentId: string = original.fee_intent_id;

    const failure = await payoutFailuresRepository.findLatestForPayout(original.id);

    const retryReference = `${original.reference}-R${original.retry_count + 1}`;

    const created = await withTransaction(async (tx) => {
      const newPayout = await payoutsRepository.insertPayoutIntent(
        {
          tenantId: original.tenant_id,
          branchId: original.branch_id,
          tenure: original.tenure,
          cycle: original.cycle,
          recipientUserId: original.recipient_user_id,
          recipientMembershipId: original.recipient_membership_id,
          recipientSlot: original.recipient_slot,
          reference: retryReference,
          grossAmount: original.gross_amount,
          tvcAdjustment: original.tvc_adjustment,
          potAfterTvc: original.pot_after_tvc,
          platformFee: original.platform_fee,
          netAmount: original.net_amount,
          tvcBps: original.tvc_bps,
          feeBps: original.fee_bps,
          feeIntentId,
          retryOfPayoutId: original.id,
          retryCount: original.retry_count + 1,
        },
        tx,
      );

      await payoutsRepository.updatePayoutState(
        newPayout.id,
        'FEE_PAID',
        {
          feeConfirmedBy: original.fee_confirmed_by,
        },
        tx,
      );

      await payoutsRepository.bumpRetryCount(original.id, tx);

      if (failure) {
        await payoutFailuresRepository.attachRetry(failure.id, newPayout.id, tx);
      }

      return newPayout;
    });

    await record({
      actorId,
      action: 'PAYOUT_RETRY_CREATED',
      entityType: 'payout_intent',
      entityId: created.id,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      metadata: {
        originalPayoutId: original.id,
        newPayoutId: created.id,
        feeIntentId,
        cycle: original.cycle,
      },
    });

    logger.info(
      {
        originalPayoutId: original.id,
        newPayoutId: created.id,
        cycle: original.cycle,
        actorId,
      },
      'Payout retry created',
    );

    try {
      await notificationsService.notifyPayoutRetried({
        tenantId: original.tenant_id,
        branchId: original.branch_id,
        cycle: original.cycle,
        payoutIntentId: created.id,
      });
    } catch (err) {
      logger.error({ err, payoutId: created.id }, 'Payout retried notification failed');
    }

    const refreshed = await payoutsRepository.findPayoutIntentById(created.id);
    return payoutToDto(refreshed!);
  }
}

export const payoutsService = new PayoutsService();