/**
 * Auth repository - all SQL for the auth module.
 * Phone is the primary identifier.
 */

import type { PoolClient } from 'pg';
import { pool } from '../../db';

export type UserRole = 'SAVER' | 'ADMIN';
export type UserStatus = 'PENDING' | 'VERIFIED' | 'SUSPENDED';

export interface UserRow {
  id: string;
  phone: string;
  email: string | null;
  password_hash: string;
  full_name: string;
  role: UserRole;
  status: UserStatus;
  phone_verified_at: Date | null;
  email_verified_at: Date | null;
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
  async findUserByPhone(phone: string): Promise<UserRow | null> {
    const result = await pool.query<UserRow>('SELECT * FROM users WHERE phone = $1 LIMIT 1', [
      phone,
    ]);
    return result.rows[0] ?? null;
  }

  async findUserById(id: string): Promise<UserRow | null> {
    const result = await pool.query<UserRow>('SELECT * FROM users WHERE id = $1', [id]);
    return result.rows[0] ?? null;
  }

  async phoneExists(phone: string): Promise<boolean> {
    const result = await pool.query('SELECT 1 FROM users WHERE phone = $1 LIMIT 1', [phone]);
    return (result.rowCount ?? 0) > 0;
  }

  async insertUser(
    data: {
      phone: string;
      email: string | null;
      passwordHash: string;
      fullName: string;
      role: UserRole;
    },
    tx: PoolClient,
  ): Promise<UserRow> {
    const result = await tx.query<UserRow>(
      `INSERT INTO users (phone, email, password_hash, full_name, role)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [data.phone, data.email, data.passwordHash, data.fullName, data.role],
    );
    return result.rows[0]!;
  }

  async markPhoneVerified(userId: string): Promise<UserRow> {
    const result = await pool.query<UserRow>(
      `UPDATE users
       SET phone_verified_at = NOW(), status = 'VERIFIED'
       WHERE id = $1
       RETURNING *`,
      [userId],
    );
    return result.rows[0]!;
  }

  async updatePassword(userId: string, passwordHash: string): Promise<void> {
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, userId]);
  }

  async promoteIfAdminPhone(phone: string): Promise<void> {
    const adminPhone = process.env.ADMIN_PHONE;
    if (!adminPhone || adminPhone !== phone) return;
    await pool.query(`UPDATE users SET role = 'ADMIN' WHERE phone = $1 AND role != 'ADMIN'`, [
      phone,
    ]);
  }

  // ---- Refresh tokens ----

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