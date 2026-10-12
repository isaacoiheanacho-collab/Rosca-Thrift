/**
 * Tenure renewal repository — SQL for tenure_renewals + rebalance log.
 */

import type { PoolClient } from 'pg';
import { pool } from '../../db';

export type RenewalVote = 'PENDING' | 'YES' | 'NO';

export interface TenureRenewalRow {
  id: string;
  tenant_id: string;
  closing_tenure: number;
  next_tenure: number;
  user_id: string;
  membership_id: string;
  slot_number: number;
  vote: RenewalVote;
  voted_at: Date | null;
  replacement_user_id: string | null;
  replacement_membership_id: string | null;
  replaced_at: Date | null;
  moved_to_tenant_id: string | null;
  moved_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface RenewalMemberView {
  renewal_id: string;
  user_id: string;
  full_name: string;
  phone: string;
  slot_number: number;
  vote: RenewalVote;
  voted_at: Date | null;
  replacement_user_id: string | null;
  replacement_name: string | null;
  replaced_at: Date | null;
}

export class TenureRenewalRepository {
  async insertMany(
    rows: Array<{
      tenantId: string;
      closingTenure: number;
      nextTenure: number;
      userId: string;
      membershipId: string;
      slotNumber: number;
    }>,
    tx?: PoolClient,
  ): Promise<TenureRenewalRow[]> {
    if (rows.length === 0) return [];
    const runner = tx ?? pool;

    const values: unknown[] = [];
    const placeholders: string[] = [];
    let idx = 1;

    for (const r of rows) {
      placeholders.push(
        `($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++})`,
      );
      values.push(
        r.tenantId,
        r.closingTenure,
        r.nextTenure,
        r.userId,
        r.membershipId,
        r.slotNumber,
      );
    }

    const result = await runner.query<TenureRenewalRow>(
      `INSERT INTO tenure_renewals
         (tenant_id, closing_tenure, next_tenure, user_id, membership_id, slot_number)
       VALUES ${placeholders.join(', ')}
       ON CONFLICT (tenant_id, closing_tenure, membership_id) DO NOTHING
       RETURNING *`,
      values,
    );
    return result.rows;
  }

  async findByTenure(tenantId: string, closingTenure: number): Promise<TenureRenewalRow[]> {
    const result = await pool.query<TenureRenewalRow>(
      `SELECT * FROM tenure_renewals
       WHERE tenant_id = $1 AND closing_tenure = $2
       ORDER BY slot_number ASC`,
      [tenantId, closingTenure],
    );
    return result.rows;
  }

  async findMyVote(
    tenantId: string,
    closingTenure: number,
    userId: string,
  ): Promise<TenureRenewalRow | null> {
    const result = await pool.query<TenureRenewalRow>(
      `SELECT * FROM tenure_renewals
       WHERE tenant_id = $1 AND closing_tenure = $2 AND user_id = $3`,
      [tenantId, closingTenure, userId],
    );
    return result.rows[0] ?? null;
  }

  async castVote(
    renewalId: string,
    vote: 'YES' | 'NO',
    tx?: PoolClient,
  ): Promise<TenureRenewalRow> {
    const runner = tx ?? pool;
    const result = await runner.query<TenureRenewalRow>(
      `UPDATE tenure_renewals
       SET vote = $2, voted_at = NOW()
       WHERE id = $1 AND vote = 'PENDING'
       RETURNING *`,
      [renewalId, vote],
    );
    return result.rows[0]!;
  }

  async markReplaced(
    renewalId: string,
    newUserId: string,
    newMembershipId: string,
    tx?: PoolClient,
  ): Promise<TenureRenewalRow> {
    const runner = tx ?? pool;
    const result = await runner.query<TenureRenewalRow>(
      `UPDATE tenure_renewals
       SET replacement_user_id = $2,
           replacement_membership_id = $3,
           replaced_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [renewalId, newUserId, newMembershipId],
    );
    return result.rows[0]!;
  }

  async markMoved(
    renewalId: string,
    toTenantId: string,
    tx?: PoolClient,
  ): Promise<TenureRenewalRow> {
    const runner = tx ?? pool;
    const result = await runner.query<TenureRenewalRow>(
      `UPDATE tenure_renewals
       SET moved_to_tenant_id = $2, moved_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [renewalId, toTenantId],
    );
    return result.rows[0]!;
  }

  /** Find the PENDING renewal row for a specific freed slot. */
  async findPendingForSlot(
    tenantId: string,
    closingTenure: number,
    slotNumber: number,
  ): Promise<TenureRenewalRow | null> {
    const result = await pool.query<TenureRenewalRow>(
      `SELECT * FROM tenure_renewals
       WHERE tenant_id = $1 AND closing_tenure = $2 AND slot_number = $3
         AND vote = 'NO' AND replacement_user_id IS NULL
       LIMIT 1`,
      [tenantId, closingTenure, slotNumber],
    );
    return result.rows[0] ?? null;
  }

  /** List all NO votes without replacement, ordered by slot. */
  async findUnfilledSlots(
    tenantId: string,
    closingTenure: number,
  ): Promise<TenureRenewalRow[]> {
    const result = await pool.query<TenureRenewalRow>(
      `SELECT * FROM tenure_renewals
       WHERE tenant_id = $1 AND closing_tenure = $2
         AND vote = 'NO' AND replacement_user_id IS NULL
       ORDER BY slot_number ASC`,
      [tenantId, closingTenure],
    );
    return result.rows;
  }

  /** Member-facing: all members with their vote status. */
  async listMembersForRenewal(
    tenantId: string,
    closingTenure: number,
  ): Promise<RenewalMemberView[]> {
    const result = await pool.query<RenewalMemberView>(
      `SELECT
         tr.id             AS renewal_id,
         tr.user_id        AS user_id,
         u.full_name       AS full_name,
         u.phone           AS phone,
         tr.slot_number    AS slot_number,
         tr.vote           AS vote,
         tr.voted_at       AS voted_at,
         tr.replacement_user_id AS replacement_user_id,
         ru.full_name      AS replacement_name,
         tr.replaced_at    AS replaced_at
       FROM tenure_renewals tr
         INNER JOIN users u ON u.id = tr.user_id
         LEFT JOIN users ru ON ru.id = tr.replacement_user_id
       WHERE tr.tenant_id = $1 AND tr.closing_tenure = $2
       ORDER BY tr.slot_number ASC`,
      [tenantId, closingTenure],
    );
    return result.rows;
  }

  async countVotes(
    tenantId: string,
    closingTenure: number,
  ): Promise<{ yes: number; no: number; pending: number; replaced: number }> {
    const result = await pool.query<{
      yes: string;
      no: string;
      pending: string;
      replaced: string;
    }>(
      `SELECT
         COUNT(*) FILTER (WHERE vote = 'YES')::text AS yes,
         COUNT(*) FILTER (WHERE vote = 'NO')::text AS no,
         COUNT(*) FILTER (WHERE vote = 'PENDING')::text AS pending,
         COUNT(*) FILTER (WHERE replacement_user_id IS NOT NULL)::text AS replaced
       FROM tenure_renewals
       WHERE tenant_id = $1 AND closing_tenure = $2`,
      [tenantId, closingTenure],
    );
    const r = result.rows[0]!;
    return {
      yes: Number(r.yes),
      no: Number(r.no),
      pending: Number(r.pending),
      replaced: Number(r.replaced),
    };
  }

  async logRebalance(
    data: {
      branchId: string;
      fromTenantId: string;
      toTenantId: string;
      membershipId: string;
      userId: string;
      reason: string;
    },
    tx?: PoolClient,
  ): Promise<void> {
    const runner = tx ?? pool;
    await runner.query(
      `INSERT INTO tenant_rebalance_log
         (branch_id, from_tenant_id, to_tenant_id, membership_id, user_id, reason)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        data.branchId,
        data.fromTenantId,
        data.toTenantId,
        data.membershipId,
        data.userId,
        data.reason,
      ],
    );
  }
}

export const tenureRenewalRepository = new TenureRenewalRepository();