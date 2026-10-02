/**
 * Auth repository — every SQL statement the auth module needs.
 *
 * Repositories are the ONLY place raw SQL lives. Services call methods,
 * never pool.query. This keeps queries auditable and easy to swap.
 */

import type { PoolClient } from 'pg';
import { pool } from '../../db';

export type UserRole = 'SAVER' | 'ADMIN';
export type UserStatus = 'PENDING' | 'VERIFIED' | 'SUSPENDED';

export interface UserRow {
  id: string;
  email: string | null;
  phone: string | null;
  password_hash: string;
  full_name: string;
  role: UserRole;
  status: UserStatus;
  created_at: Date;
  updated_at: Date;
}

export interface RefreshTokenRow {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: Date;
  revoked_at: Date | null;
  replaced_by: string | null;
  user_agent: string | null;
  ip_address: string | null;
  created_at: Date;
}

export class AuthRepository {
  // -------- Users --------

  async findUserByEmailOrPhone(
    email: string | undefined,
    phone: string | undefined,
  ): Promise<UserRow | null> {
    const result = await pool.query<UserRow>(
      `SELECT * FROM users
       WHERE ($1::text IS NOT NULL AND LOWER(email) = LOWER($1))
          OR ($2::text IS NOT NULL AND phone = $2)
       LIMIT 1`,
      [email ?? null, phone ?? null],
    );
    return result.rows[0] ?? null;
  }

  async findUserById(id: string): Promise<UserRow | null> {
    const result = await pool.query<UserRow>('SELECT * FROM users WHERE id = $1', [id]);
    return result.rows[0] ?? null;
  }

  async emailExists(email: string): Promise<boolean> {
    const result = await pool.query('SELECT 1 FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1', [
      email,
    ]);
    return result.rowCount !== null && result.rowCount > 0;
  }

  async phoneExists(phone: string): Promise<boolean> {
    const result = await pool.query('SELECT 1 FROM users WHERE phone = $1 LIMIT 1', [phone]);
    return result.rowCount !== null && result.rowCount > 0;
  }

  async insertUser(
    data: { email: string | null; phone: string | null; passwordHash: string; fullName: string },
    tx: PoolClient,
  ): Promise<UserRow> {
    const result = await tx.query<UserRow>(
      `INSERT INTO users (email, phone, password_hash, full_name)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [data.email, data.phone, data.passwordHash, data.fullName],
    );
    return result.rows[0]!;
  }

  // -------- Refresh tokens --------

  async insertRefreshToken(
    data: {
      userId: string;
      tokenHash: string;
      expiresAt: Date;
      userAgent?: string | null;
      ipAddress?: string | null;
    },
    tx: PoolClient,
  ): Promise<RefreshTokenRow> {
    const result = await tx.query<RefreshTokenRow>(
      `INSERT INTO refresh_tokens
         (user_id, token_hash, expires_at, user_agent, ip_address)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [
        data.userId,
        data.tokenHash,
        data.expiresAt,
        data.userAgent ?? null,
        data.ipAddress ?? null,
      ],
    );
    return result.rows[0]!;
  }

  async findRefreshTokenByHash(tokenHash: string): Promise<RefreshTokenRow | null> {
    const result = await pool.query<RefreshTokenRow>(
      'SELECT * FROM refresh_tokens WHERE token_hash = $1 LIMIT 1',
      [tokenHash],
    );
    return result.rows[0] ?? null;
  }

  async revokeRefreshToken(
    tokenId: string,
    replacedById: string | null,
    tx: PoolClient,
  ): Promise<void> {
    await tx.query(
      `UPDATE refresh_tokens
       SET revoked_at = NOW(), replaced_by = $2
       WHERE id = $1 AND revoked_at IS NULL`,
      [tokenId, replacedById],
    );
  }

  /** Nuclear option: revoke ALL active tokens for a user (theft detected). */
  async revokeAllUserTokens(userId: string): Promise<void> {
    await pool.query(
      `UPDATE refresh_tokens
       SET revoked_at = NOW()
       WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId],
    );
  }
}

export const authRepository = new AuthRepository();