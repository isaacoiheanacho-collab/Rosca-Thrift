/**
 * Branches repository — all SQL for branch management.
 */

import type { PoolClient } from 'pg';
import { pool } from '../../db';

export type BranchStatus = 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED';
export type OnboardingStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

export interface BranchBranding {
  logoUrl?: string;
  primaryColor?: string;
  accentColor?: string;
  displayName?: string;
  contactEmail?: string;
}

export interface BranchRow {
  id: string;
  slug: string;
  name: string;
  status: BranchStatus;
  trust_account_name: string | null;
  trust_account_sort: string | null;
  trust_account_number: string | null;
  trust_account_holder: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  branding: BranchBranding;
  about_text: string | null;
  branch_terms: string | null;
  branch_privacy: string | null;
  branch_terms_version: string;
  branch_privacy_version: string;
  onboarding_status: OnboardingStatus;
  onboarding_requested_at: Date | null;
  onboarding_reviewed_at: Date | null;
  onboarding_reviewed_by: string | null;
  onboarding_note: string | null;
  onboarding_rejection_reason: string | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface BranchListRow extends BranchRow {
  admin_name: string | null;
  admin_kyc_status: string;
}

export class BranchesRepository {
  async count(): Promise<number> {
    const result = await pool.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM branches',
    );
    return Number(result.rows[0]?.count ?? '0');
  }

  async findBySlug(slug: string): Promise<BranchRow | null> {
    const result = await pool.query<BranchRow>(
      'SELECT * FROM branches WHERE slug = $1',
      [slug],
    );
    return result.rows[0] ?? null;
  }

  async findById(id: string): Promise<BranchRow | null> {
    const result = await pool.query<BranchRow>(
      'SELECT * FROM branches WHERE id = $1',
      [id],
    );
    return result.rows[0] ?? null;
  }

  async list(options: {
    limit: number;
    offset: number;
    status?: BranchStatus;
    onboardingStatus?: OnboardingStatus;
  }): Promise<{ branches: BranchListRow[]; total: number }> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (options.status) {
      params.push(options.status);
      conditions.push(`status = $${params.length}`);
    }
    if (options.onboardingStatus) {
      params.push(options.onboardingStatus);
      conditions.push(`onboarding_status = $${params.length}`);
    }

    // Count query — unchanged, runs against branches only.
    const countWhere = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const countResult = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM branches ${countWhere}`,
      params,
    );
    const total = Number(countResult.rows[0]?.count ?? '0');

    params.push(options.limit);
    const limitIdx = params.length;
    params.push(options.offset);
    const offsetIdx = params.length;

    // List query — JOIN users via branch_id + role so we always pick the
    // branch admin who actually belongs to this branch (safer than created_by,
    // which can be null during onboarding or point at the wrong user).
    // Also JOIN the admin's most recent kyc_submissions row so the UI can
    // surface a unified branch + admin KYC status.
    const listWhere =
      conditions.length > 0
        ? `WHERE ${conditions.map((c) => `b.${c}`).join(' AND ')}`
        : '';

    const listResult = await pool.query(
      `SELECT 
         b.*, 
         u.full_name AS admin_name,
         COALESCE(k.status, 'NOT_SUBMITTED') AS admin_kyc_status
       FROM branches b
       LEFT JOIN users u ON u.branch_id = b.id AND u.role = 'BRANCH_ADMIN'
       LEFT JOIN kyc_submissions k ON k.user_id = u.id AND k.id = (
         SELECT id FROM kyc_submissions 
         WHERE user_id = u.id 
         ORDER BY created_at DESC LIMIT 1
       )
       ${listWhere}
       ORDER BY b.created_at DESC
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params,
    );

    return { branches: listResult.rows, total };
  }

  /**
   * Insert a branch.
   *
   * createdBy may be null during onboarding — the branch is created first,
   * then the admin user is created, then created_by is backfilled.
   */
  async insert(
    data: {
      slug: string;
      name: string;
      contactEmail: string | null;
      contactPhone: string | null;
      createdBy: string | null;
      onboardingStatus?: OnboardingStatus;
      onboardingNote?: string | null;
    },
    tx?: PoolClient,
  ): Promise<BranchRow> {
    const runner = tx ?? pool;
    const status = data.onboardingStatus ?? 'APPROVED';
    const result = await runner.query<BranchRow>(
      `INSERT INTO branches
         (slug, name, contact_email, contact_phone, created_by,
          onboarding_status, onboarding_requested_at, onboarding_note)
       VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7)
       RETURNING *`,
      [
        data.slug,
        data.name,
        data.contactEmail,
        data.contactPhone,
        data.createdBy,           // string OR null
        status,
        data.onboardingNote ?? null,
      ],
    );
    return result.rows[0]!;
  }

  async update(
    id: string,
    data: {
      name?: string;
      contactEmail?: string | null;
      contactPhone?: string | null;
      status?: BranchStatus;
    },
  ): Promise<BranchRow> {
    const fields: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (data.name !== undefined) {
      fields.push(`name = $${idx++}`);
      values.push(data.name);
    }
    if (data.contactEmail !== undefined) {
      fields.push(`contact_email = $${idx++}`);
      values.push(data.contactEmail);
    }
    if (data.contactPhone !== undefined) {
      fields.push(`contact_phone = $${idx++}`);
      values.push(data.contactPhone);
    }
    if (data.status !== undefined) {
      fields.push(`status = $${idx++}`);
      values.push(data.status);
    }

    values.push(id);
    const result = await pool.query<BranchRow>(
      `UPDATE branches SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
      values,
    );
    return result.rows[0]!;
  }

  async updateBranding(
    id: string,
    patch: Partial<BranchBranding>,
  ): Promise<BranchRow> {
    const result = await pool.query<BranchRow>(
      `UPDATE branches
       SET branding = COALESCE(branding, '{}'::jsonb) || $2::jsonb
       WHERE id = $1
       RETURNING *`,
      [id, JSON.stringify(patch)],
    );
    return result.rows[0]!;
  }

  async updateContent(
    id: string,
    data: {
      aboutText?: string | null;
      branchTerms?: string | null;
      branchPrivacy?: string | null;
      branchTermsVersion?: string;
      branchPrivacyVersion?: string;
    },
  ): Promise<BranchRow> {
    const fields: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (data.aboutText !== undefined) {
      fields.push(`about_text = $${idx++}`);
      values.push(data.aboutText);
    }
    if (data.branchTerms !== undefined) {
      fields.push(`branch_terms = $${idx++}`);
      values.push(data.branchTerms);
    }
    if (data.branchPrivacy !== undefined) {
      fields.push(`branch_privacy = $${idx++}`);
      values.push(data.branchPrivacy);
    }
    if (data.branchTermsVersion !== undefined) {
      fields.push(`branch_terms_version = $${idx++}`);
      values.push(data.branchTermsVersion);
    }
    if (data.branchPrivacyVersion !== undefined) {
      fields.push(`branch_privacy_version = $${idx++}`);
      values.push(data.branchPrivacyVersion);
    }

    if (fields.length === 0) {
      const existing = await this.findById(id);
      return existing!;
    }

    values.push(id);
    const result = await pool.query<BranchRow>(
      `UPDATE branches SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
      values,
    );
    return result.rows[0]!;
  }

  async updateTrustAccount(
    id: string,
    data: {
      trustAccountName: string;
      trustAccountSort: string;
      trustAccountNumber: string;
      trustAccountHolder: string;
    },
  ): Promise<BranchRow> {
    const result = await pool.query<BranchRow>(
      `UPDATE branches
       SET trust_account_name = $1,
           trust_account_sort = $2,
           trust_account_number = $3,
           trust_account_holder = $4
       WHERE id = $5
       RETURNING *`,
      [
        data.trustAccountName,
        data.trustAccountSort,
        data.trustAccountNumber,
        data.trustAccountHolder,
        id,
      ],
    );
    return result.rows[0]!;
  }

  async approveOnboarding(
    id: string,
    reviewedBy: string,
  ): Promise<BranchRow> {
    const result = await pool.query<BranchRow>(
      `UPDATE branches
       SET onboarding_status = 'APPROVED',
           onboarding_reviewed_at = NOW(),
           onboarding_reviewed_by = $2,
           onboarding_rejection_reason = NULL
       WHERE id = $1
       RETURNING *`,
      [id, reviewedBy],
    );
    return result.rows[0]!;
  }

  async rejectOnboarding(
    id: string,
    reviewedBy: string,
    reason: string,
  ): Promise<BranchRow> {
    const result = await pool.query<BranchRow>(
      `UPDATE branches
       SET onboarding_status = 'REJECTED',
           onboarding_reviewed_at = NOW(),
           onboarding_reviewed_by = $2,
           onboarding_rejection_reason = $3
       WHERE id = $1
       RETURNING *`,
      [id, reviewedBy, reason],
    );
    return result.rows[0]!;
  }

  /**
   * After onboarding, point created_by at the admin user.
   */
  async setCreatedBy(
    id: string,
    createdBy: string,
    tx?: PoolClient,
  ): Promise<void> {
    const runner = tx ?? pool;
    await runner.query(
      `UPDATE branches SET created_by = $2 WHERE id = $1`,
      [id, createdBy],
    );
  }

  async findBranchesForUser(userId: string): Promise<BranchRow[]> {
    const result = await pool.query<BranchRow>(
      `SELECT b.* FROM branches b
       INNER JOIN users u ON u.branch_id = b.id
       WHERE u.id = $1`,
      [userId],
    );
    return result.rows;
  }
}

export const branchesRepository = new BranchesRepository();