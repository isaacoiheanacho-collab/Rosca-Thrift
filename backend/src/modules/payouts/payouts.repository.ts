/**
 * Payouts repository — all SQL for payout_intents and platform_fee_intents.
 */

import type { PoolClient } from 'pg';
import { pool } from '../../db';

export type FeeIntentState = 'PENDING' | 'RECEIPT_UPLOADED' | 'CONFIRMED';
export type PayoutIntentState = 'PENDING' | 'FEE_PAID' | 'RECEIPT_UPLOADED' | 'CONFIRMED';

export interface PlatformFeeIntentRow {
  id: string;
  tenant_id: string;
  branch_id: string;
  tenure: number;
  cycle: number;
  reference: string;
  amount: bigint;
  currency: string;
  fee_bps: number;
  state: FeeIntentState;
  confirmed_by: string | null;
  confirmed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface PayoutIntentRow {
  id: string;
  tenant_id: string;
  branch_id: string;
  tenure: number;
  cycle: number;
  recipient_user_id: string;
  recipient_membership_id: string;
  recipient_slot: number;
  reference: string;
  gross_amount: bigint;
  tvc_adjustment: bigint;
  pot_after_tvc: bigint;
  platform_fee: bigint;
  net_amount: bigint;
  currency: string;
  tvc_bps: number;
  fee_bps: number;
  state: PayoutIntentState;
  fee_confirmed_by: string | null;
  fee_confirmed_at: Date | null;
  payout_confirmed_by: string | null;
  payout_confirmed_at: Date | null;
  fee_intent_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export class PayoutsRepository {
  // ---- Fee intents ----

  async findFeeIntent(
    tenantId: string,
    tenure: number,
    cycle: number,
  ): Promise<PlatformFeeIntentRow | null> {
    const result = await pool.query<PlatformFeeIntentRow>(
      `SELECT * FROM platform_fee_intents
       WHERE tenant_id = $1 AND tenure = $2 AND cycle = $3`,
      [tenantId, tenure, cycle],
    );
    return result.rows[0] ?? null;
  }

  async findFeeIntentById(id: string): Promise<PlatformFeeIntentRow | null> {
    const result = await pool.query<PlatformFeeIntentRow>(
      'SELECT * FROM platform_fee_intents WHERE id = $1',
      [id],
    );
    return result.rows[0] ?? null;
  }

  async insertFeeIntent(
    data: {
      tenantId: string;
      branchId: string;
      tenure: number;
      cycle: number;
      reference: string;
      amount: bigint;
      feeBps: number;
    },
    tx?: PoolClient,
  ): Promise<PlatformFeeIntentRow> {
    const runner = tx ?? pool;
    const result = await runner.query<PlatformFeeIntentRow>(
      `INSERT INTO platform_fee_intents
         (tenant_id, branch_id, tenure, cycle, reference, amount, fee_bps)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        data.tenantId,
        data.branchId,
        data.tenure,
        data.cycle,
        data.reference,
        data.amount,
        data.feeBps,
      ],
    );
    return result.rows[0]!;
  }

  async updateFeeIntentState(
    id: string,
    state: FeeIntentState,
    confirmedBy: string | null,
    tx?: PoolClient,
  ): Promise<PlatformFeeIntentRow> {
    const runner = tx ?? pool;
    const result = await runner.query<PlatformFeeIntentRow>(
      `UPDATE platform_fee_intents
       SET state = $2,
           confirmed_by = COALESCE($3, confirmed_by),
           confirmed_at = CASE WHEN $2 = 'CONFIRMED' THEN NOW() ELSE confirmed_at END
       WHERE id = $1
       RETURNING *`,
      [id, state, confirmedBy],
    );
    return result.rows[0]!;
  }

  async listFeeIntentsByBranch(
    branchId: string,
    options: { limit: number; offset: number; state?: FeeIntentState },
  ): Promise<{ intents: PlatformFeeIntentRow[]; total: number }> {
    const conditions: string[] = ['branch_id = $1'];
    const params: unknown[] = [branchId];

    if (options.state) {
      params.push(options.state);
      conditions.push(`state = $${params.length}`);
    }

    const where = `WHERE ${conditions.join(' AND ')}`;

    const countResult = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM platform_fee_intents ${where}`,
      params,
    );
    const total = Number(countResult.rows[0]?.count ?? '0');

    params.push(options.limit);
    const limitIdx = params.length;
    params.push(options.offset);
    const offsetIdx = params.length;

    const listResult = await pool.query<PlatformFeeIntentRow>(
      `SELECT * FROM platform_fee_intents ${where}
       ORDER BY created_at DESC
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params,
    );

    return { intents: listResult.rows, total };
  }

  /** All pending fee intents across all branches (super admin queue). */
  async listPendingFeeIntents(options: { limit: number; offset: number }): Promise<{
    intents: PlatformFeeIntentRow[];
    total: number;
  }> {
    const countResult = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM platform_fee_intents WHERE state = 'RECEIPT_UPLOADED'`,
    );
    const total = Number(countResult.rows[0]?.count ?? '0');

    const listResult = await pool.query<PlatformFeeIntentRow>(
      `SELECT * FROM platform_fee_intents
       WHERE state = 'RECEIPT_UPLOADED'
       ORDER BY created_at ASC
       LIMIT $1 OFFSET $2`,
      [options.limit, options.offset],
    );

    return { intents: listResult.rows, total };
  }

  // ---- Payout intents ----

  async findPayoutIntent(
    tenantId: string,
    tenure: number,
    cycle: number,
  ): Promise<PayoutIntentRow | null> {
    const result = await pool.query<PayoutIntentRow>(
      `SELECT * FROM payout_intents
       WHERE tenant_id = $1 AND tenure = $2 AND cycle = $3`,
      [tenantId, tenure, cycle],
    );
    return result.rows[0] ?? null;
  }

  async findPayoutIntentById(id: string): Promise<PayoutIntentRow | null> {
    const result = await pool.query<PayoutIntentRow>(
      'SELECT * FROM payout_intents WHERE id = $1',
      [id],
    );
    return result.rows[0] ?? null;
  }

  async insertPayoutIntent(
    data: {
      tenantId: string;
      branchId: string;
      tenure: number;
      cycle: number;
      recipientUserId: string;
      recipientMembershipId: string;
      recipientSlot: number;
      reference: string;
      grossAmount: bigint;
      tvcAdjustment: bigint;
      potAfterTvc: bigint;
      platformFee: bigint;
      netAmount: bigint;
      tvcBps: number;
      feeBps: number;
      feeIntentId: string;
    },
    tx?: PoolClient,
  ): Promise<PayoutIntentRow> {
    const runner = tx ?? pool;
    const result = await runner.query<PayoutIntentRow>(
      `INSERT INTO payout_intents
         (tenant_id, branch_id, tenure, cycle,
          recipient_user_id, recipient_membership_id, recipient_slot,
          reference, gross_amount, tvc_adjustment, pot_after_tvc,
          platform_fee, net_amount, tvc_bps, fee_bps, fee_intent_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       RETURNING *`,
      [
        data.tenantId,
        data.branchId,
        data.tenure,
        data.cycle,
        data.recipientUserId,
        data.recipientMembershipId,
        data.recipientSlot,
        data.reference,
        data.grossAmount,
        data.tvcAdjustment,
        data.potAfterTvc,
        data.platformFee,
        data.netAmount,
        data.tvcBps,
        data.feeBps,
        data.feeIntentId,
      ],
    );
    return result.rows[0]!;
  }

  async updatePayoutState(
    id: string,
    state: PayoutIntentState,
    opts: {
      feeConfirmedBy?: string | null;
      payoutConfirmedBy?: string | null;
    } = {},
    tx?: PoolClient,
  ): Promise<PayoutIntentRow> {
    const runner = tx ?? pool;
    const result = await runner.query<PayoutIntentRow>(
      `UPDATE payout_intents
       SET state = $2,
           fee_confirmed_by = COALESCE($3, fee_confirmed_by),
           fee_confirmed_at = CASE WHEN $3 IS NOT NULL THEN NOW() ELSE fee_confirmed_at END,
           payout_confirmed_by = COALESCE($4, payout_confirmed_by),
           payout_confirmed_at = CASE WHEN $4 IS NOT NULL THEN NOW() ELSE payout_confirmed_at END
       WHERE id = $1
       RETURNING *`,
      [id, state, opts.feeConfirmedBy ?? null, opts.payoutConfirmedBy ?? null],
    );
    return result.rows[0]!;
  }

  async listPayoutsByTenant(tenantId: string, limit = 100): Promise<PayoutIntentRow[]> {
    const result = await pool.query<PayoutIntentRow>(
      `SELECT * FROM payout_intents
       WHERE tenant_id = $1
       ORDER BY tenure DESC, cycle DESC
       LIMIT $2`,
      [tenantId, limit],
    );
    return result.rows;
  }

  async listPayoutsByRecipient(userId: string): Promise<PayoutIntentRow[]> {
    const result = await pool.query<PayoutIntentRow>(
      `SELECT * FROM payout_intents
       WHERE recipient_user_id = $1
       ORDER BY tenure DESC, cycle DESC`,
      [userId],
    );
    return result.rows;
  }

  async listPayoutsByBranch(
    branchId: string,
    options: { limit: number; offset: number; state?: PayoutIntentState },
  ): Promise<{ intents: PayoutIntentRow[]; total: number }> {
    const conditions: string[] = ['branch_id = $1'];
    const params: unknown[] = [branchId];

    if (options.state) {
      params.push(options.state);
      conditions.push(`state = $${params.length}`);
    }

    const where = `WHERE ${conditions.join(' AND ')}`;

    const countResult = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM payout_intents ${where}`,
      params,
    );
    const total = Number(countResult.rows[0]?.count ?? '0');

    params.push(options.limit);
    const limitIdx = params.length;
    params.push(options.offset);
    const offsetIdx = params.length;

    const listResult = await pool.query<PayoutIntentRow>(
      `SELECT * FROM payout_intents ${where}
       ORDER BY created_at DESC
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params,
    );

    return { intents: listResult.rows, total };
  }
}

export const payoutsRepository = new PayoutsRepository();