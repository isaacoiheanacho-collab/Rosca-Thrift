/**
 * Tenants repository — all SQL for tenants + memberships.
 */

import { pool } from '../../db';

export type TenantStatus = 'FILLING' | 'ACTIVE' | 'COMPLETED' | 'ARCHIVED';
export type MembershipStatus = 'ACTIVE' | 'COLLECTED' | 'REMOVED';

export interface TenantRow {
  id: string;
  branch_id: string;
  name: string | null;
  status: TenantStatus;
  current_cycle: number;
  activated_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
  // Cycle columns (migration 011)
  current_tenure: number;
  cycle_started_at: Date | null;
  cycle_ends_at: Date | null;
  cycle_contribution_deadline_at: Date | null;
  cycle_payout_at: Date | null;
  // Tenure rate snapshots (migration 012)
  current_tenure_fee_bps: number;
  current_tenure_tvc_bps: number;
}

export interface TenantMembershipRow {
  id: string;
  tenant_id: string;
  user_id: string;
  slot_number: number;
  status: MembershipStatus;
  joined_at: Date;
  collected_at: Date | null;
}

export class TenantsRepository {
  async findById(id: string): Promise<TenantRow | null> {
    const result = await pool.query<TenantRow>('SELECT * FROM tenants WHERE id = $1', [id]);
    return result.rows[0] ?? null;
  }

  async findOpenByBranch(branchId: string): Promise<TenantRow | null> {
    const result = await pool.query<TenantRow>(
      `SELECT * FROM tenants
       WHERE branch_id = $1 AND status = 'FILLING'
       ORDER BY created_at ASC
       LIMIT 1`,
      [branchId],
    );
    return result.rows[0] ?? null;
  }

  async findByBranch(
    branchId: string,
    options: { limit: number; offset: number; status?: TenantStatus },
  ): Promise<{ tenants: TenantRow[]; total: number }> {
    const conditions: string[] = ['branch_id = $1'];
    const params: unknown[] = [branchId];

    if (options.status) {
      params.push(options.status);
      conditions.push(`status = $${params.length}`);
    }

    const where = `WHERE ${conditions.join(' AND ')}`;

    const countResult = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM tenants ${where}`,
      params,
    );
    const total = Number(countResult.rows[0]?.count ?? '0');

    params.push(options.limit);
    const limitIdx = params.length;
    params.push(options.offset);
    const offsetIdx = params.length;

    const listResult = await pool.query<TenantRow>(
      `SELECT * FROM tenants ${where}
       ORDER BY created_at DESC
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params,
    );

    return { tenants: listResult.rows, total };
  }

  async insert(branchId: string, name: string | null): Promise<TenantRow> {
    const result = await pool.query<TenantRow>(
      `INSERT INTO tenants (branch_id, name, status)
       VALUES ($1, $2, 'FILLING')
       RETURNING *`,
      [branchId, name],
    );
    return result.rows[0]!;
  }

  async updateStatus(
    id: string,
    status: TenantStatus,
    opts: { activate?: boolean; complete?: boolean } = {},
  ): Promise<TenantRow> {
    const fields: string[] = ['status = $2'];
    const params: unknown[] = [id, status];

    if (opts.activate) {
      fields.push('activated_at = NOW()');
    }
    if (opts.complete) {
      fields.push('completed_at = NOW()');
    }

    const result = await pool.query<TenantRow>(
      `UPDATE tenants SET ${fields.join(', ')} WHERE id = $1 RETURNING *`,
      params,
    );
    return result.rows[0]!;
  }

  // ---- Memberships ----

  async countMembers(tenantId: string): Promise<number> {
    const result = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM tenant_memberships WHERE tenant_id = $1`,
      [tenantId],
    );
    return Number(result.rows[0]?.count ?? '0');
  }

  async findMembershipByUser(userId: string): Promise<TenantMembershipRow | null> {
    const result = await pool.query<TenantMembershipRow>(
      `SELECT * FROM tenant_memberships
       WHERE user_id = $1 AND status != 'REMOVED'
       ORDER BY joined_at DESC
       LIMIT 1`,
      [userId],
    );
    return result.rows[0] ?? null;
  }

  async findMembershipsByTenant(tenantId: string): Promise<TenantMembershipRow[]> {
    const result = await pool.query<TenantMembershipRow>(
      `SELECT * FROM tenant_memberships
       WHERE tenant_id = $1 AND status != 'REMOVED'
       ORDER BY slot_number ASC`,
      [tenantId],
    );
    return result.rows;
  }

  async usedSlots(tenantId: string): Promise<number[]> {
    const result = await pool.query<{ slot_number: number }>(
      `SELECT slot_number FROM tenant_memberships
       WHERE tenant_id = $1 AND status != 'REMOVED'`,
      [tenantId],
    );
    return result.rows.map((r) => r.slot_number);
  }

  async insertMembership(
    tenantId: string,
    userId: string,
    slotNumber: number,
  ): Promise<TenantMembershipRow> {
    const result = await pool.query<TenantMembershipRow>(
      `INSERT INTO tenant_memberships (tenant_id, user_id, slot_number)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [tenantId, userId, slotNumber],
    );
    return result.rows[0]!;
  }
}

export const tenantsRepository = new TenantsRepository();