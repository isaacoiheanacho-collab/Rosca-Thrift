/**
 * KYC repository — all SQL for KYC submissions.
 */

import { pool } from '../../db';

export type KycStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

export interface KycSubmissionRow {
  id: string;
  user_id: string;
  branch_id: string;
  legal_name: string;
  selfie_object_key: string;
  bank_name: string;
  account_number: string;
  sort_code: string;
  status: KycStatus;
  reviewed_by: string | null;
  reviewed_at: Date | null;
  rejection_reason: string | null;
  created_at: Date;
  updated_at: Date;
}

export class KycRepository {
  async findPendingByUserId(userId: string): Promise<KycSubmissionRow | null> {
    const result = await pool.query<KycSubmissionRow>(
      `SELECT * FROM kyc_submissions
       WHERE user_id = $1 AND status = 'PENDING'
       LIMIT 1`,
      [userId],
    );
    return result.rows[0] ?? null;
  }

  async findLatestByUserId(userId: string): Promise<KycSubmissionRow | null> {
    const result = await pool.query<KycSubmissionRow>(
      `SELECT * FROM kyc_submissions
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [userId],
    );
    return result.rows[0] ?? null;
  }

  async findById(id: string): Promise<KycSubmissionRow | null> {
    const result = await pool.query<KycSubmissionRow>(
      'SELECT * FROM kyc_submissions WHERE id = $1',
      [id],
    );
    return result.rows[0] ?? null;
  }

  async insert(data: {
    userId: string;
    branchId: string;
    legalName: string;
    selfieObjectKey: string;
    bankName: string;
    accountNumber: string;
    sortCode: string;
  }): Promise<KycSubmissionRow> {
    const result = await pool.query<KycSubmissionRow>(
      `INSERT INTO kyc_submissions
         (user_id, branch_id, legal_name, selfie_object_key, bank_name, account_number, sort_code)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        data.userId,
        data.branchId,
        data.legalName,
        data.selfieObjectKey,
        data.bankName,
        data.accountNumber,
        data.sortCode,
      ],
    );
    return result.rows[0]!;
  }

  async approve(id: string, reviewerId: string): Promise<KycSubmissionRow> {
    const result = await pool.query<KycSubmissionRow>(
      `UPDATE kyc_submissions
       SET status = 'APPROVED', reviewed_by = $2, reviewed_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [id, reviewerId],
    );
    return result.rows[0]!;
  }

  async reject(id: string, reviewerId: string, reason: string): Promise<KycSubmissionRow> {
    const result = await pool.query<KycSubmissionRow>(
      `UPDATE kyc_submissions
       SET status = 'REJECTED', reviewed_by = $2, reviewed_at = NOW(), rejection_reason = $3
       WHERE id = $1
       RETURNING *`,
      [id, reviewerId, reason],
    );
    return result.rows[0]!;
  }

  /**
   * List KYC submissions. If branchId is provided, only that branch.
   * Super Admin omits branchId to see all.
   */
  async list(options: {
    limit: number;
    offset: number;
    status?: KycStatus;
    branchId?: string;
  }): Promise<{ submissions: KycSubmissionRow[]; total: number }> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (options.status) {
      params.push(options.status);
      conditions.push(`status = $${params.length}`);
    }
    if (options.branchId) {
      params.push(options.branchId);
      conditions.push(`branch_id = $${params.length}`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countResult = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM kyc_submissions ${where}`,
      params,
    );
    const total = Number(countResult.rows[0]?.count ?? '0');

    params.push(options.limit);
    const limitIdx = params.length;
    params.push(options.offset);
    const offsetIdx = params.length;

    const listResult = await pool.query<KycSubmissionRow>(
      `SELECT * FROM kyc_submissions ${where}
       ORDER BY created_at ASC
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params,
    );

    return { submissions: listResult.rows, total };
  }

  async markUserKycVerified(userId: string): Promise<void> {
    await pool.query(`UPDATE users SET kyc_verified_at = NOW() WHERE id = $1`, [userId]);
  }
}

export const kycRepository = new KycRepository();