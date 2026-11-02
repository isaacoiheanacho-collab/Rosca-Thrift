/**
 * Ledger repository — append-only ledger entries.
 *
 * Every credit and debit to any account (tenant pool, branch fee, platform
 * maintenance, TVC) is recorded here. No updates, no deletes — enforced by
 * DB trigger.
 *
 * Account types in play:
 *   - TENANT      — the pooled savings balance that cycle payouts draw from.
 *   - BRANCH_FEE  — fee-tracking per branch (what the branch has paid to
 *                   the platform for its cycles).
 *   - PLATFORM    — the platform's own maintenance account balance.
 *   - TVC         — Time-Value Contribution pool. Credits/debits here track
 *                   the early-vs-late adjustment applied to payouts so the
 *                   TVC account nets to zero over a full cycle.
 */

import type { PoolClient } from 'pg';
import { pool } from '../../db';

export type LedgerAccountType = 'TENANT' | 'BRANCH_FEE' | 'PLATFORM' | 'TVC';
export type LedgerEntryType = 'CREDIT' | 'DEBIT';
export type LedgerEntryKind =
  | 'CONTRIBUTION'
  | 'PAYOUT'
  | 'PLATFORM_FEE'
  | 'TVC_ADJUSTMENT'
  | 'ADJUSTMENT';

export interface LedgerEntryRow {
  id: string;
  account_type: LedgerAccountType;
  tenant_id: string | null;
  branch_id: string | null;
  entry_type: LedgerEntryType;
  amount: bigint;
  currency: string;
  reference: string;
  entry_kind: LedgerEntryKind;
  contribution_id: string | null;
  payout_id: string | null;
  description: string | null;
  created_by: string | null;
  created_at: Date;
}

export class LedgerRepository {
  async insert(
    data: {
      accountType: LedgerAccountType;
      tenantId: string | null;
      branchId: string | null;
      entryType: LedgerEntryType;
      amount: bigint;
      currency: string;
      reference: string;
      entryKind: LedgerEntryKind;
      contributionId: string | null;
      payoutId: string | null;
      description: string | null;
      createdBy: string | null;
    },
    tx?: PoolClient,
  ): Promise<LedgerEntryRow> {
    const runner = tx ?? pool;
    const result = await runner.query<LedgerEntryRow>(
      `INSERT INTO ledger_entries
         (account_type, tenant_id, branch_id, entry_type, amount, currency,
          reference, entry_kind, contribution_id, payout_id, description, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [
        data.accountType,
        data.tenantId,
        data.branchId,
        data.entryType,
        data.amount,
        data.currency,
        data.reference,
        data.entryKind,
        data.contributionId,
        data.payoutId,
        data.description,
        data.createdBy,
      ],
    );
    return result.rows[0]!;
  }

  /** Tenant pool balance: SUM(credits) - SUM(debits) for a tenant. */
  async tenantBalance(tenantId: string): Promise<bigint> {
    const result = await pool.query<{ balance: string }>(
      `SELECT COALESCE(SUM(CASE WHEN entry_type = 'CREDIT' THEN amount ELSE -amount END), 0)::text AS balance
       FROM ledger_entries
       WHERE account_type = 'TENANT' AND tenant_id = $1`,
      [tenantId],
    );
    return BigInt(result.rows[0]?.balance ?? '0');
  }

  /** Platform maintenance balance. */
  async platformBalance(): Promise<bigint> {
    const result = await pool.query<{ balance: string }>(
      `SELECT COALESCE(SUM(CASE WHEN entry_type = 'CREDIT' THEN amount ELSE -amount END), 0)::text AS balance
       FROM ledger_entries
       WHERE account_type = 'PLATFORM'`,
    );
    return BigInt(result.rows[0]?.balance ?? '0');
  }

  /** Branch fee-tracking balance (what the branch has paid to platform, per branch). */
  async branchFeeBalance(branchId: string): Promise<bigint> {
    const result = await pool.query<{ balance: string }>(
      `SELECT COALESCE(SUM(CASE WHEN entry_type = 'CREDIT' THEN amount ELSE -amount END), 0)::text AS balance
       FROM ledger_entries
       WHERE account_type = 'BRANCH_FEE' AND branch_id = $1`,
      [branchId],
    );
    return BigInt(result.rows[0]?.balance ?? '0');
  }

  /**
   * TVC pool balance for a tenant: CREDITs minus DEBITs on the TVC account.
   *
   * The TVC pool holds the time-value adjustments applied to payouts. In a
   * well-formed cycle, the sum of early-collector debits and late-collector
   * credits nets to (approximately) zero — this method lets you verify that
   * invariant and surface any drift from rounding, failed adjustments, or
   * manual corrections.
   */
  async tvcBalance(tenantId: string): Promise<bigint> {
    const result = await pool.query<{ balance: string }>(
      `SELECT COALESCE(SUM(CASE WHEN entry_type = 'CREDIT' THEN amount ELSE -amount END), 0)::text AS balance
       FROM ledger_entries
       WHERE account_type = 'TVC' AND tenant_id = $1`,
      [tenantId],
    );
    return BigInt(result.rows[0]?.balance ?? '0');
  }

  async listByTenant(tenantId: string, limit = 100): Promise<LedgerEntryRow[]> {
    const result = await pool.query<LedgerEntryRow>(
      `SELECT * FROM ledger_entries
       WHERE tenant_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [tenantId, limit],
    );
    return result.rows;
  }

  async listByReference(reference: string): Promise<LedgerEntryRow[]> {
    const result = await pool.query<LedgerEntryRow>(
      `SELECT * FROM ledger_entries WHERE reference = $1 ORDER BY created_at ASC`,
      [reference],
    );
    return result.rows;
  }
}

export const ledgerRepository = new LedgerRepository();