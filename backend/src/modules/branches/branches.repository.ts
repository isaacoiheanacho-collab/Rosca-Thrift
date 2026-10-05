/**
 * Branches repository — all SQL for branch management.
 */

import type { PoolClient } from 'pg';
import { pool } from '../../db';

export type BranchStatus = 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED';

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
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export class BranchesRepository {
  async count(): Promise<number> {
    const result = await pool.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM branches');
    return Number(result.rows[0]?.count ?? '0');
  }

  async findBySlug(slug: string): Promise<BranchRow | null> {
    const result = await pool.query<BranchRow>('SELECT * FROM branches WHERE slug = $1', [slug]);
    return result.rows[0] ?? null;
  }

  async findById(id: string): Promise<BranchRow | null> {
    const result = await pool.query<BranchRow>('SELECT * FROM branches WHERE id = $1', [id]);
    return result.rows[0] ?? null;
  }

  async list(options: { limit: number; offset: number; status?: BranchStatus }): Promise<{
    branches: BranchRow[];
    total: number;
  }> {
    const where = options.status ? 'WHERE status = $1' : '';
    const params: unknown[] = options.status ? [options.status] : [];

    const countResult = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM branches ${where}`,
      params,
    );
    const total = Number(countResult.rows[0]?.count ?? '0');

    const limitIdx = params.length + 1;
    const offsetIdx = params.length + 2;

    const listResult = await pool.query<BranchRow>(
      `SELECT * FROM branches ${where}
       ORDER BY created_at DESC
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      [...params, options.limit, options.offset],
    );

    return { branches: listResult.rows, total };
  }

  async insert(
    data: {
      slug: string;
      name: string;
      contactEmail: string | null;
      contactPhone: string | null;
      createdBy: string;
    },
    tx?: PoolClient,
  ): Promise<BranchRow> {
    const runner = tx ?? pool;
    const result = await runner.query<BranchRow>(
      `INSERT INTO branches (slug, name, contact_email, contact_phone, created_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [data.slug, data.name, data.contactEmail, data.contactPhone, data.createdBy],
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