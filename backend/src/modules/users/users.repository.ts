/**
 * Users repository — SQL for profile management.
 * Reads/writes the users table only. No auth concerns.
 */

import type { PoolClient } from 'pg';
import { pool } from '../../db';
import type { UserRow } from '../auth/auth.repository';

export class UsersRepository {
  async findById(id: string): Promise<UserRow | null> {
    const result = await pool.query<UserRow>('SELECT * FROM users WHERE id = $1', [id]);
    return result.rows[0] ?? null;
  }

  async findByPhone(phone: string): Promise<UserRow | null> {
    const result = await pool.query<UserRow>('SELECT * FROM users WHERE phone = $1 LIMIT 1', [
      phone,
    ]);
    return result.rows[0] ?? null;
  }

  async emailExists(email: string, excludeUserId?: string): Promise<boolean> {
    const result = await pool.query(
      `SELECT 1 FROM users
       WHERE LOWER(email) = LOWER($1)
         AND ($2::uuid IS NULL OR id != $2)
       LIMIT 1`,
      [email, excludeUserId ?? null],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async updateProfile(
    userId: string,
    data: { fullName?: string; email?: string | null },
  ): Promise<UserRow> {
    const fields: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (data.fullName !== undefined) {
      fields.push(`full_name = $${idx++}`);
      values.push(data.fullName);
    }
    if (data.email !== undefined) {
      fields.push(`email = $${idx++}`);
      values.push(data.email);
    }

    values.push(userId);
    const result = await pool.query<UserRow>(
      `UPDATE users SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
      values,
    );
    return result.rows[0]!;
  }

  async updatePhone(userId: string, newPhone: string, tx: PoolClient): Promise<UserRow> {
    const result = await tx.query<UserRow>(
      `UPDATE users
       SET phone = $1, phone_verified_at = NOW(), status = 'VERIFIED'
       WHERE id = $2
       RETURNING *`,
      [newPhone, userId],
    );
    return result.rows[0]!;
  }

  async updatePassword(userId: string, passwordHash: string, tx: PoolClient): Promise<void> {
    await tx.query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, userId]);
  }

  // ---- Admin: list users ----

  async listUsers(options: {
    limit: number;
    offset: number;
    status?: string;
    role?: string;
    search?: string;
  }): Promise<{ users: UserRow[]; total: number }> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (options.status) {
      conditions.push(`status = $${idx++}`);
      values.push(options.status);
    }
    if (options.role) {
      conditions.push(`role = $${idx++}`);
      values.push(options.role);
    }
    if (options.search) {
      conditions.push(`(LOWER(full_name) LIKE $${idx} OR phone LIKE $${idx})`);
      values.push(`%${options.search.toLowerCase()}%`);
      idx++;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countResult = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM users ${where}`,
      values,
    );
    const total = Number(countResult.rows[0]?.count ?? '0');

    const listResult = await pool.query<UserRow>(
      `SELECT * FROM users ${where}
       ORDER BY created_at DESC
       LIMIT $${idx++} OFFSET $${idx}`,
      [...values, options.limit, options.offset],
    );

    return { users: listResult.rows, total };
  }

  async updateUserStatus(userId: string, status: string): Promise<UserRow> {
    const result = await pool.query<UserRow>(
      'UPDATE users SET status = $1 WHERE id = $2 RETURNING *',
      [status, userId],
    );
    return result.rows[0]!;
  }
}

export const usersRepository = new UsersRepository();