/**
 * KYC repository — all SQL for KYC submissions.
 */

import { pool } from '../../db';
import type { PoolClient } from 'pg';

export type KycStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'NOT_SUBMITTED';

export interface KycSubmissionRow {
  id: string;
  user_id: string;
  branch_id: string;
  legal_name: string;
  account_name: string | null;
  selfie_object_key: string | null;
  bank_name: string | null;
  account_number: string | null;
  sort_code: string | null;
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

  async findRegistrationByUserId(userId: string): Promise<KycSubmissionRow | null> {
    const result = await pool.query<KycSubmissionRow>(
      `SELECT * FROM kyc_submissions
       WHERE user_id = $1 AND status = 'NOT_SUBMITTED'
       ORDER BY created_at ASC
       LIMIT 1`,
      [userId],
    );
    return result.rows[0] ?? null;
  }

  async backfillRegistrationNamesForExistingAdmin(
    userId: string,
    branchId: string,
  ): Promise<KycSubmissionRow | null> {
    const result = await pool.query<KycSubmissionRow>(
      `UPDATE kyc_submissions k
       SET legal_name = COALESCE(NULLIF(k.legal_name, ''), u.full_name),
           account_name = COALESCE(NULLIF(k.account_name, ''), b.name)
       FROM users u
       JOIN branches b ON b.id = u.branch_id
       WHERE k.user_id = u.id
         AND u.id = $1
         AND u.branch_id = $2
         AND u.role = 'BRANCH_ADMIN'
       RETURNING k.*`,
      [userId, branchId],
    );
    return result.rows[0] ?? null;
  }

  async createRegistrationRecordForExistingAdmin(
    userId: string,
    branchId: string,
  ): Promise<KycSubmissionRow | null> {
    const result = await pool.query<KycSubmissionRow>(
      `INSERT INTO kyc_submissions
         (user_id, branch_id, legal_name, account_name, status)
       SELECT u.id, b.id, u.full_name, b.name, 'NOT_SUBMITTED'
       FROM users u
       JOIN branches b ON b.id = u.branch_id
       WHERE u.id = $1
         AND u.branch_id = $2
         AND u.role = 'BRANCH_ADMIN'
         AND NOT EXISTS (
           SELECT 1 FROM kyc_submissions k WHERE k.user_id = u.id
         )
       RETURNING *`,
      [userId, branchId],
    );
    return result.rows[0] ?? null;
  }

  async findLatestByUserId(userId: string): Promise<KycSubmissionRow | null> {
    const result = await pool.query<KycSubmissionRow>(
      `SELECT * FROM kyc_submissions
       WHERE user_id = $1
       ORDER BY CASE WHEN status = 'PENDING' THEN 0 ELSE 1 END,
                created_at DESC
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

  async insertRegistrationRecord(
    data: {
      userId: string;
      branchId: string;
      legalName: string;
      accountName: string;
    },
    tx: PoolClient,
  ): Promise<KycSubmissionRow> {
    const result = await tx.query<KycSubmissionRow>(
      `INSERT INTO kyc_submissions
         (user_id, branch_id, legal_name, account_name, status)
       VALUES ($1, $2, $3, $4, 'NOT_SUBMITTED')
       RETURNING *`,
      [data.userId, data.branchId, data.legalName, data.accountName],
    );
    return result.rows[0]!;
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
    configurationId?: string;
  }): Promise<{ submissions: KycSubmissionRow[]; total: number }> {
    // A saver belongs to a group through users.circle_configuration_id.
    // Tenant allocation is not required for group KYC visibility.
    const conditions: string[] = [\`u.role = 'SAVER'\`];
    const params: unknown[] = [];

    if (options.status === 'NOT_SUBMITTED') {
      conditions.push('k.id IS NULL');
    } else if (options.status) {
      params.push(options.status);
      conditions.push(\`k.status = $${params.length}\`);
    }

    if (options.branchId) {
      params.push(options.branchId);
      conditions.push(\`u.branch_id = $${params.length}\`);
    }

    if (options.configurationId) {
      params.push(options.configurationId);
      conditions.push(\`u.circle_configuration_id = $${params.length}\`);
    }

    if (options.tenantId) {
      params.push(options.tenantId);
      conditions.push(\`EXISTS (
        SELECT 1
        FROM tenant_memberships tm_filter
        JOIN tenants t_filter ON t_filter.id = tm_filter.tenant_id
        WHERE tm_filter.user_id = u.id
          AND tm_filter.tenant_id = $${params.length}
          AND tm_filter.status <> 'REMOVED'
          AND t_filter.configuration_id = u.circle_configuration_id
      )\`);
    }

    const where = \`WHERE ${conditions.join(" AND ")}\`;
    const notSubmitted = options.status === 'NOT_SUBMITTED';
    const baseFrom = notSubmitted
      ? 'FROM users u LEFT JOIN kyc_submissions k ON k.user_id = u.id'
      : 'FROM kyc_submissions k JOIN users u ON u.id = k.user_id';

    const countResult = await pool.query<{ count: string }>(
      \`SELECT COUNT(*)::text AS count ${baseFrom} ${where}\`,
      params,
    );
    const total = Number(countResult.rows[0]?.count ?? '0');

    params.push(options.limit);
    const limitIdx = params.length;
    params.push(options.offset);
    const offsetIdx = params.length;

    const selectColumns = notSubmitted
      ? \`u.id AS id,
         u.id AS user_id,
         u.branch_id,
         u.full_name AS legal_name,
         u.full_name AS account_name,
         NULL::text AS selfie_object_key,
         NULL::text AS bank_name,
         NULL::text AS account_number,
         NULL::text AS sort_code,
         'NOT_SUBMITTED'::text AS status,
         NULL::uuid AS reviewed_by,
         NULL::timestamptz AS reviewed_at,
         NULL::text AS rejection_reason,
         u.created_at,
         u.created_at AS updated_at,\`
      : 'k.*,';

    const orderColumn = notSubmitted ? 'u.created_at' : 'k.created_at';
    const listResult = await pool.query<KycSubmissionRow>(
      \`SELECT
         ${selectColumns}
         group_tenant.tenant_id AS tenant_id,
         COALESCE(b.name, 'Branch') || ' / ' ||
           COALESCE(group_tenant.name, cc.name || ' (not yet allocated)', 'Unassigned') AS tenant_name
       ${baseFrom}
       LEFT JOIN LATERAL (
         SELECT tm.tenant_id, t.name
         FROM tenant_memberships tm
         JOIN tenants t ON t.id = tm.tenant_id
         WHERE tm.user_id = u.id
           AND tm.status <> 'REMOVED'
           AND t.configuration_id = u.circle_configuration_id
         ORDER BY tm.joined_at DESC
         LIMIT 1
       ) group_tenant ON TRUE
       LEFT JOIN branches b ON b.id = u.branch_id
       LEFT JOIN circle_configurations cc ON cc.id = u.circle_configuration_id
       ${where}
       ORDER BY ${orderColumn} DESC
       LIMIT $${limitIdx} OFFSET $${offsetIdx}\`,
      params,
    );

    return { submissions: listResult.rows, total };
  }

  async markUserKycVerified(userId: string): Promise<void> {
    await pool.query(`UPDATE users SET kyc_verified_at = NOW() WHERE id = $1`, [userId]);
  }
}

export const kycRepository = new KycRepository();