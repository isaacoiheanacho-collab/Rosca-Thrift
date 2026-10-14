/**
 * Payout failures repository.
 *
 * Two responsibilities:
 *   1. Write rows to payout_failures (append-only audit history)
 *   2. Read rows for admin views
 */

import type { PoolClient } from 'pg';
import { pool } from '../../db';

export interface PayoutFailureRow {
  id: string;
  payout_id: string;
  tenant_id: string;
  branch_id: string;
  reason: string;
  marked_by: string | null;
  marked_at: Date;
  retry_payout_id: string | null;
  notes: string | null;
  created_at: Date;
}

export interface PayoutFailureWithContext {
  id: string;
  payout_id: string;
  tenant_id: string;
  tenant_name: string | null;
  branch_id: string;
  branch_name: string;
  cycle: number;
  recipient_user_id: string;
  recipient_name: string;
  recipient_slot: number;
  reference: string;
  net_amount: bigint;
  reason: string;
  marked_by: string | null;
  marked_by_name: string | null;
  marked_at: Date;
  retry_payout_id: string | null;
  retry_state: string | null;
  notes: string | null;
}

export class PayoutFailuresRepository {
  async insert(
    data: {
      payoutId: string;
      tenantId: string;
      branchId: string;
      reason: string;
      markedBy: string | null;
      notes?: string | null;
    },
    tx?: PoolClient,
  ): Promise<PayoutFailureRow> {
    const runner = tx ?? pool;
    const result = await runner.query<PayoutFailureRow>(
      `INSERT INTO payout_failures
         (payout_id, tenant_id, branch_id, reason, marked_by, notes)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        data.payoutId,
        data.tenantId,
        data.branchId,
        data.reason,
        data.markedBy,
        data.notes ?? null,
      ],
    );
    return result.rows[0]!;
  }

  async attachRetry(
    failureId: string,
    retryPayoutId: string,
    tx?: PoolClient,
  ): Promise<void> {
    const runner = tx ?? pool;
    await runner.query(
      `UPDATE payout_failures SET retry_payout_id = $2 WHERE id = $1`,
      [failureId, retryPayoutId],
    );
  }

  async findById(id: string): Promise<PayoutFailureRow | null> {
    const result = await pool.query<PayoutFailureRow>(
      'SELECT * FROM payout_failures WHERE id = $1',
      [id],
    );
    return result.rows[0] ?? null;
  }

  /**
   * Latest failure for a specific payout intent.
   */
  async findLatestForPayout(payoutId: string): Promise<PayoutFailureRow | null> {
    const result = await pool.query<PayoutFailureRow>(
      `SELECT * FROM payout_failures
       WHERE payout_id = $1
       ORDER BY marked_at DESC
       LIMIT 1`,
      [payoutId],
    );
    return result.rows[0] ?? null;
  }

  /**
   * List all failures for a branch, newest first.
   * Joined with payout + user + tenant + branch context for admin views.
   */
  async listByBranch(
    branchId: string,
    options: { limit: number; offset: number; onlyUnretried?: boolean },
  ): Promise<{ failures: PayoutFailureWithContext[]; total: number }> {
    const conditions: string[] = ['pf.branch_id = $1'];
    const params: unknown[] = [branchId];

    if (options.onlyUnretried) {
      conditions.push('pf.retry_payout_id IS NULL');
    }

    const where = `WHERE ${conditions.join(' AND ')}`;

    const countResult = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM payout_failures pf ${where}`,
      params,
    );
    const total = Number(countResult.rows[0]?.count ?? '0');

    params.push(options.limit);
    const limitIdx = params.length;
    params.push(options.offset);
    const offsetIdx = params.length;

    const rows = await pool.query<PayoutFailureWithContext>(
      `SELECT
         pf.id,
         pf.payout_id,
         pf.tenant_id,
         t.name           AS tenant_name,
         pf.branch_id,
         b.name           AS branch_name,
         pi.cycle         AS cycle,
         pi.recipient_user_id,
         u.full_name      AS recipient_name,
         pi.recipient_slot,
         pi.reference,
         pi.net_amount,
         pf.reason,
         pf.marked_by,
         mu.full_name     AS marked_by_name,
         pf.marked_at,
         pf.retry_payout_id,
         rp.state         AS retry_state,
         pf.notes
       FROM payout_failures pf
         INNER JOIN payout_intents pi ON pi.id = pf.payout_id
         INNER JOIN tenants t         ON t.id  = pf.tenant_id
         INNER JOIN branches b        ON b.id  = pf.branch_id
         INNER JOIN users u           ON u.id  = pi.recipient_user_id
         LEFT JOIN  users mu          ON mu.id = pf.marked_by
         LEFT JOIN  payout_intents rp ON rp.id = pf.retry_payout_id
       ${where}
       ORDER BY pf.marked_at DESC
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params,
    );

    return { failures: rows.rows, total };
  }

  /**
   * Super admin: list across all branches.
   */
  async listAll(options: {
    limit: number;
    offset: number;
    onlyUnretried?: boolean;
  }): Promise<{ failures: PayoutFailureWithContext[]; total: number }> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (options.onlyUnretried) {
      conditions.push('pf.retry_payout_id IS NULL');
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countResult = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM payout_failures pf ${where}`,
      params,
    );
    const total = Number(countResult.rows[0]?.count ?? '0');

    params.push(options.limit);
    const limitIdx = params.length;
    params.push(options.offset);
    const offsetIdx = params.length;

    const rows = await pool.query<PayoutFailureWithContext>(
      `SELECT
         pf.id,
         pf.payout_id,
         pf.tenant_id,
         t.name           AS tenant_name,
         pf.branch_id,
         b.name           AS branch_name,
         pi.cycle         AS cycle,
         pi.recipient_user_id,
         u.full_name      AS recipient_name,
         pi.recipient_slot,
         pi.reference,
         pi.net_amount,
         pf.reason,
         pf.marked_by,
         mu.full_name     AS marked_by_name,
         pf.marked_at,
         pf.retry_payout_id,
         rp.state         AS retry_state,
         pf.notes
       FROM payout_failures pf
         INNER JOIN payout_intents pi ON pi.id = pf.payout_id
         INNER JOIN tenants t         ON t.id  = pf.tenant_id
         INNER JOIN branches b        ON b.id  = pf.branch_id
         INNER JOIN users u           ON u.id  = pi.recipient_user_id
         LEFT JOIN  users mu          ON mu.id = pf.marked_by
         LEFT JOIN  payout_intents rp ON rp.id = pf.retry_payout_id
       ${where}
       ORDER BY pf.marked_at DESC
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params,
    );

    return { failures: rows.rows, total };
  }
}

export const payoutFailuresRepository = new PayoutFailuresRepository();