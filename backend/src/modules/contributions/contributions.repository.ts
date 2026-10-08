/**
 * Contributions repository — all SQL for contribution_intents, contributions,
 * and receipts.
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
}

export const contributionsRepository = new ContributionsRepository();