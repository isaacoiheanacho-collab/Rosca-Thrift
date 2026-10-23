/**
 * KYC repository — all SQL for KYC submissions.
 */

import { pool } from '../../db';

export type KycStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'NOT_SUBMITTED';

export interface KycSubmissionRow {
  id: string;
  user_id: string;
  branch_id: string;
  legal_name: string;
  account_name: string | null;
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
  // Tenant Info (populated by list())
  tenant_id?: string | null;
  tenant_name?: string | null;
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
    accountName: string;
    selfieObjectKey: string;
    bankName: string;
    accountNumber: string;
    sortCode: string;
  }): Promise<KycSubmissionRow> {
    const result = await pool.query<KycSubmissionRow>(
      `INSERT INTO kyc_submissions
         (user_id, branch_id, legal_name, account_name, selfie_object_key, bank_name, account_number, sort_code)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        data.userId,
        data.branchId,
        data.legalName,
        data.accountName,
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
   *
   * IMPORTANT: This list is used by branch admins and the super admin to
   * review *saver* KYC submissions. Branch admin submissions are reviewed
   * by the super admin through a different flow, so we exclude them here.
   */
  async list(options: {
    limit: number;
    offset: number;
    status?: KycStatus;
    branchId?: string;
    tenantId?: string;
  }): Promise<{ submissions: KycSubmissionRow[]; total: number }> {
    
    // 1. Handle users who haven't submitted KYC at all
    if (options.status === 'NOT_SUBMITTED') {
      const conditions: string[] = [`u.role = 'SAVER'`, `k.id IS NULL`];
      const params: unknown[] = [];

      if (options.branchId) {
        params.push(options.branchId);
        conditions.push(`u.branch_id = $${params.length}`);
      }
      if (options.tenantId) {
        params.push(options.tenantId);
        conditions.push(`tm.tenant_id = $${params.length}`);
      }

      const where = `WHERE ${conditions.join(' AND ')}`;
      
      const baseFrom = `
        FROM users u
        LEFT JOIN kyc_submissions k ON k.user_id = u.id
        LEFT JOIN tenant_memberships tm ON tm.user_id = u.id AND tm.status != 'REMOVED'
        LEFT JOIN tenants t ON t.id = tm.tenant_id
      `;

      const countResult = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count ${baseFrom} ${where}`,
        params,
      );
      const total = Number(countResult.rows[0]?.count ?? '0');

      params.push(options.limit);
      const limitIdx = params.length;
      params.push(options.offset);
      const offsetIdx = params.length;

      // We map user data to fake the KycSubmissionRow format for the frontend
      const listResult = await pool.query<KycSubmissionRow>(
        `SELECT 
           u.id AS id,
           u.id AS user_id,
           u.branch_id,
           u.full_name AS legal_name,
           u.full_name AS account_name,
           '' AS selfie_object_key,
           '' AS bank_name,
           '' AS account_number,
           '' AS sort_code,
           'NOT_SUBMITTED' AS status,
           u.created_at,
           u.created_at AS updated_at,
           t.id AS tenant_id,
           COALESCE(b.name, 'Branch') || ' / ' || COALESCE(t.name, 'Unnamed Tenant') AS tenant_name
         ${baseFrom}
         LEFT JOIN branches b ON b.id = u.branch_id
         ${where}
         ORDER BY u.created_at DESC
         LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
        params,
      );

      return { submissions: listResult.rows, total };
    }

    // 2. Handle standard KYC submissions (Pending/Approved/Rejected)
    const conditions: string[] = [`u.role = 'SAVER'`];
    const params: unknown[] = [];

    if (options.status) {
      params.push(options.status);
      conditions.push(`k.status = $${params.length}`);
    }
    if (options.branchId) {
      params.push(options.branchId);
      conditions.push(`k.branch_id = $${params.length}`);
    }
    if (options.tenantId) {
      params.push(options.tenantId);
      conditions.push(`tm.tenant_id = $${params.length}`);
    }

    const where = `WHERE ${conditions.join(' AND ')}`;

    const countResult = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM kyc_submissions k
       JOIN users u ON u.id = k.user_id
       LEFT JOIN tenant_memberships tm ON tm.user_id = u.id AND tm.status != 'REMOVED'
       ${where}`,
      params,
    );
    const total = Number(countResult.rows[0]?.count ?? '0');

    params.push(options.limit);
    const limitIdx = params.length;
    params.push(options.offset);
    const offsetIdx = params.length;

    const listResult = await pool.query<KycSubmissionRow>(
      `SELECT 
         k.*,
         t.id AS tenant_id,
         COALESCE(b.name, 'Branch') || ' / ' || COALESCE(t.name, 'Unnamed Tenant') AS tenant_name
       FROM kyc_submissions k
       JOIN users u ON u.id = k.user_id
       LEFT JOIN tenant_memberships tm ON tm.user_id = k.user_id AND tm.status != 'REMOVED'
       LEFT JOIN tenants t ON t.id = tm.tenant_id
       LEFT JOIN branches b ON b.id = k.branch_id
       ${where}
       ORDER BY k.created_at DESC
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