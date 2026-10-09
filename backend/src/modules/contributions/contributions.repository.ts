/**
 * Contributions repository — all SQL for contribution_intents, contributions,
 * receipts, plus helper queries for admin/tenant visibility.
 */

import type { PoolClient } from 'pg';
import { pool } from '../../db';

export interface ContributionIntentRow {
  id: string;
  tenant_id: string;
  user_id: string;
  membership_id: string;
  branch_id: string;
  tenure: number;
  cycle: number;
  slot_number: number;
  reference: string;
  expected_amount: bigint;
  deadline_at: Date;
  state: 'PENDING' | 'CONFIRMED' | 'LATE' | 'EXEMPT';
  created_at: Date;
  updated_at: Date;
}

export interface ContributionRow {
  id: string;
  tenant_id: string;
  user_id: string;
  membership_id: string;
  intent_id: string;
  branch_id: string;
  tenure: number;
  cycle: number;
  slot_number: number;
  reference: string;
  amount: bigint;
  currency: string;
  confirmed_by: string;
  confirmed_at: Date;
  admin_note: string | null;
  created_at: Date;
}

export interface ReceiptRow {
  id: string;
  purpose: 'CONTRIBUTION' | 'PAYOUT' | 'PLATFORM_FEE';
  intent_id: string | null;
  contribution_id: string | null;
  payout_id: string | null;
  uploaded_by: string;
  branch_id: string;
  object_key: string;
  file_name: string;
  mime_type: string;
  size_bytes: bigint;
  claimed_amount: bigint | null;
  claimed_reference: string | null;
  claimed_sender_name: string | null;
  claimed_note: string | null;
  created_at: Date;
}

export interface TenantCycleMemberRow {
  membership_id: string;
  user_id: string;
  slot_number: number;
  full_name: string;
  phone: string;
  intent_id: string | null;
  intent_state: 'PENDING' | 'CONFIRMED' | 'LATE' | 'EXEMPT' | null;
  intent_reference: string | null;
  intent_deadline_at: Date | null;
  contribution_id: string | null;
  contribution_amount: bigint | null;
  contribution_confirmed_at: Date | null;
  has_receipt: boolean;
}

export interface TenantLedgerRow {
  id: string;
  entry_type: 'CREDIT' | 'DEBIT';
  entry_kind: string;
  amount: bigint;
  currency: string;
  reference: string;
  description: string | null;
  created_at: Date;
}

export interface TenantReceiptRow {
  receipt_id: string;
  object_key: string;
  file_name: string;
  mime_type: string;
  uploaded_by: string;
  uploaded_by_name: string;
  claimed_amount: bigint | null;
  claimed_reference: string | null;
  claimed_sender_name: string | null;
  intent_reference: string | null;
  contribution_confirmed_at: Date | null;
  created_at: Date;
}

export class ContributionsRepository {
  // ---- Intents ----

  async findIntentByUserCycle(
    tenantId: string,
    userId: string,
    tenure: number,
    cycle: number,
  ): Promise<ContributionIntentRow | null> {
    const result = await pool.query<ContributionIntentRow>(
      `SELECT * FROM contribution_intents
       WHERE tenant_id = $1 AND user_id = $2 AND tenure = $3 AND cycle = $4
       LIMIT 1`,
      [tenantId, userId, tenure, cycle],
    );
    return result.rows[0] ?? null;
  }

  async findIntentById(id: string): Promise<ContributionIntentRow | null> {
    const result = await pool.query<ContributionIntentRow>(
      'SELECT * FROM contribution_intents WHERE id = $1',
      [id],
    );
    return result.rows[0] ?? null;
  }

  async insertIntent(
    data: {
      tenantId: string;
      userId: string;
      membershipId: string;
      branchId: string;
      tenure: number;
      cycle: number;
      slotNumber: number;
      reference: string;
      expectedAmount: bigint;
      deadlineAt: Date;
    },
    tx?: PoolClient,
  ): Promise<ContributionIntentRow> {
    const runner = tx ?? pool;
    const result = await runner.query<ContributionIntentRow>(
      `INSERT INTO contribution_intents
         (tenant_id, user_id, membership_id, branch_id, tenure, cycle, slot_number,
          reference, expected_amount, deadline_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        data.tenantId,
        data.userId,
        data.membershipId,
        data.branchId,
        data.tenure,
        data.cycle,
        data.slotNumber,
        data.reference,
        data.expectedAmount,
        data.deadlineAt,
      ],
    );
    return result.rows[0]!;
  }

  async updateIntentState(
    id: string,
    state: 'PENDING' | 'CONFIRMED' | 'LATE' | 'EXEMPT',
    tx?: PoolClient,
  ): Promise<void> {
    const runner = tx ?? pool;
    await runner.query('UPDATE contribution_intents SET state = $1 WHERE id = $2', [state, id]);
  }

  async listIntentsByTenantCycle(
    tenantId: string,
    tenure: number,
    cycle: number,
  ): Promise<ContributionIntentRow[]> {
    const result = await pool.query<ContributionIntentRow>(
      `SELECT * FROM contribution_intents
       WHERE tenant_id = $1 AND tenure = $2 AND cycle = $3
       ORDER BY slot_number ASC`,
      [tenantId, tenure, cycle],
    );
    return result.rows;
  }

  async listIntentsByUser(userId: string): Promise<ContributionIntentRow[]> {
    const result = await pool.query<ContributionIntentRow>(
      `SELECT * FROM contribution_intents
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [userId],
    );
    return result.rows;
  }

  /**
   * Pending verification queue: PENDING or LATE intents with an uploaded
   * receipt but no contribution yet. If branchId is null, returns all
   * branches (super admin scope).
   */
  async listPendingForBranch(
    branchId: string | null,
    options: { limit: number; offset: number },
  ): Promise<{ intents: ContributionIntentRow[]; total: number }> {
    const conditions: string[] = [
      `i.state IN ('PENDING', 'LATE')`,
      `EXISTS (SELECT 1 FROM receipts r WHERE r.intent_id = i.id)`,
      `NOT EXISTS (SELECT 1 FROM contributions c WHERE c.intent_id = i.id)`,
    ];
    const params: unknown[] = [];

    if (branchId) {
      params.push(branchId);
      conditions.push(`i.branch_id = $${params.length}`);
    }

    const where = `WHERE ${conditions.join(' AND ')}`;

    const countResult = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM contribution_intents i ${where}`,
      params,
    );
    const total = Number(countResult.rows[0]?.count ?? '0');

    params.push(options.limit);
    const limitIdx = params.length;
    params.push(options.offset);
    const offsetIdx = params.length;

    const listResult = await pool.query<ContributionIntentRow>(
      `SELECT i.* FROM contribution_intents i
       ${where}
       ORDER BY i.deadline_at ASC, i.slot_number ASC
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params,
    );

    return { intents: listResult.rows, total };
  }

  // ---- Contributions ----

  async insertContribution(
    data: {
      tenantId: string;
      userId: string;
      membershipId: string;
      intentId: string;
      branchId: string;
      tenure: number;
      cycle: number;
      slotNumber: number;
      reference: string;
      amount: bigint;
      confirmedBy: string;
      adminNote: string | null;
    },
    tx: PoolClient,
  ): Promise<ContributionRow> {
    const result = await tx.query<ContributionRow>(
      `INSERT INTO contributions
         (tenant_id, user_id, membership_id, intent_id, branch_id,
          tenure, cycle, slot_number, reference, amount,
          confirmed_by, admin_note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [
        data.tenantId,
        data.userId,
        data.membershipId,
        data.intentId,
        data.branchId,
        data.tenure,
        data.cycle,
        data.slotNumber,
        data.reference,
        data.amount,
        data.confirmedBy,
        data.adminNote,
      ],
    );
    return result.rows[0]!;
  }

  async findContributionByIntentId(intentId: string): Promise<ContributionRow | null> {
    const result = await pool.query<ContributionRow>(
      'SELECT * FROM contributions WHERE intent_id = $1 LIMIT 1',
      [intentId],
    );
    return result.rows[0] ?? null;
  }

  async listContributionsByTenantCycle(
    tenantId: string,
    tenure: number,
    cycle: number,
  ): Promise<ContributionRow[]> {
    const result = await pool.query<ContributionRow>(
      `SELECT * FROM contributions
       WHERE tenant_id = $1 AND tenure = $2 AND cycle = $3
       ORDER BY confirmed_at ASC`,
      [tenantId, tenure, cycle],
    );
    return result.rows;
  }

  async listContributionsByUser(userId: string): Promise<ContributionRow[]> {
    const result = await pool.query<ContributionRow>(
      `SELECT * FROM contributions
       WHERE user_id = $1
       ORDER BY confirmed_at DESC`,
      [userId],
    );
    return result.rows;
  }

  // ---- Receipts ----

  async insertReceipt(
    data: {
      purpose: 'CONTRIBUTION' | 'PAYOUT' | 'PLATFORM_FEE';
      intentId: string | null;
      contributionId: string | null;
      payoutId: string | null;
      uploadedBy: string;
      branchId: string;
      objectKey: string;
      fileName: string;
      mimeType: string;
      sizeBytes: bigint;
      claimedAmount: bigint | null;
      claimedReference: string | null;
      claimedSenderName: string | null;
      claimedNote: string | null;
    },
    tx?: PoolClient,
  ): Promise<ReceiptRow> {
    const runner = tx ?? pool;
    const result = await runner.query<ReceiptRow>(
      `INSERT INTO receipts
         (purpose, intent_id, contribution_id, payout_id, uploaded_by, branch_id,
          object_key, file_name, mime_type, size_bytes,
          claimed_amount, claimed_reference, claimed_sender_name, claimed_note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING *`,
      [
        data.purpose,
        data.intentId,
        data.contributionId,
        data.payoutId,
        data.uploadedBy,
        data.branchId,
        data.objectKey,
        data.fileName,
        data.mimeType,
        data.sizeBytes,
        data.claimedAmount,
        data.claimedReference,
        data.claimedSenderName,
        data.claimedNote,
      ],
    );
    return result.rows[0]!;
  }

  async findReceiptByIntentId(intentId: string): Promise<ReceiptRow | null> {
    const result = await pool.query<ReceiptRow>(
      `SELECT * FROM receipts WHERE intent_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [intentId],
    );
    return result.rows[0] ?? null;
  }

  async listReceiptsByTenant(tenantId: string): Promise<ReceiptRow[]> {
    const result = await pool.query<ReceiptRow>(
      `SELECT r.* FROM receipts r
       INNER JOIN contribution_intents i ON i.id = r.intent_id
       WHERE i.tenant_id = $1
       ORDER BY r.created_at DESC`,
      [tenantId],
    );
    return result.rows;
  }

  // ---- Tenant visibility queries ----

  /** All 12 members' status for a given tenant cycle. */
  async listTenantCycleMembers(
    tenantId: string,
    tenure: number,
    cycle: number,
  ): Promise<TenantCycleMemberRow[]> {
    const result = await pool.query<TenantCycleMemberRow>(
      `SELECT
         tm.id           AS membership_id,
         tm.user_id      AS user_id,
         tm.slot_number  AS slot_number,
         u.full_name     AS full_name,
         u.phone         AS phone,
         i.id            AS intent_id,
         i.state         AS intent_state,
         i.reference     AS intent_reference,
         i.deadline_at   AS intent_deadline_at,
         c.id            AS contribution_id,
         c.amount        AS contribution_amount,
         c.confirmed_at  AS contribution_confirmed_at,
         (r.id IS NOT NULL) AS has_receipt
       FROM tenant_memberships tm
         INNER JOIN users u ON u.id = tm.user_id
         LEFT JOIN contribution_intents i
           ON i.tenant_id = tm.tenant_id
          AND i.user_id = tm.user_id
          AND i.tenure = $2
          AND i.cycle = $3
         LEFT JOIN contributions c ON c.intent_id = i.id
         LEFT JOIN receipts r ON r.intent_id = i.id
       WHERE tm.tenant_id = $1 AND tm.status != 'REMOVED'
       ORDER BY tm.slot_number ASC`,
      [tenantId, tenure, cycle],
    );
    return result.rows;
  }

  /** Tenant ledger. */
  async listLedgerByTenant(tenantId: string, limit: number): Promise<TenantLedgerRow[]> {
    const result = await pool.query<TenantLedgerRow>(
      `SELECT id, entry_type, entry_kind, amount, currency, reference, description, created_at
       FROM ledger_entries
       WHERE account_type = 'TENANT' AND tenant_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [tenantId, limit],
    );
    return result.rows;
  }

  /** Tenant receipts gallery. */
  async listReceiptsByTenantWithIntent(
    tenantId: string,
    limit: number,
  ): Promise<TenantReceiptRow[]> {
    const result = await pool.query<TenantReceiptRow>(
      `SELECT
         r.id               AS receipt_id,
         r.object_key       AS object_key,
         r.file_name        AS file_name,
         r.mime_type        AS mime_type,
         r.uploaded_by      AS uploaded_by,
         u.full_name        AS uploaded_by_name,
         r.claimed_amount   AS claimed_amount,
         r.claimed_reference AS claimed_reference,
         r.claimed_sender_name AS claimed_sender_name,
         i.reference        AS intent_reference,
         c.confirmed_at     AS contribution_confirmed_at,
         r.created_at       AS created_at
       FROM receipts r
         INNER JOIN users u ON u.id = r.uploaded_by
         LEFT JOIN contribution_intents i ON i.id = r.intent_id
         LEFT JOIN contributions c ON c.intent_id = i.id
       WHERE i.tenant_id = $1
       ORDER BY r.created_at DESC
       LIMIT $2`,
      [tenantId, limit],
    );
    return result.rows;
  }
}

export const contributionsRepository = new ContributionsRepository();