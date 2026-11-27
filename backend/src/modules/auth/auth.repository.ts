import { pool, withTransaction } from '../../db';

export interface UserRecord {
  id: string;
  full_name: string;
  phone_e164: string;
  email: string | null;
  role: 'MEMBER' | 'BRANCH_ADMIN' | 'SUPER_ADMIN';
  phone_verified_at: Date | null;
}

export async function findUserByPhone(phone: string): Promise<UserRecord | null> {
  const result = await pool.query<UserRecord>(
    'SELECT id, full_name, phone_e164, email, role, phone_verified_at FROM users WHERE phone_e164 = $1',
    [phone],
  );
  return result.rows[0] ?? null;
}

export async function createOtp(phone: string, codeHash: string, expiresAt: Date): Promise<void> {
  await withTransaction(async (tx) => {
    await tx.query('DELETE FROM auth_otps WHERE phone_e164 = $1 AND consumed_at IS NULL', [phone]);
    await tx.query(
      'INSERT INTO auth_otps (phone_e164, code_hash, expires_at) VALUES ($1, $2, $3)',
      [phone, codeHash, expiresAt],
    );
  });
}

export async function consumeOtp(phone: string, codeHash: string, maxAttempts: number): Promise<boolean> {
  return withTransaction(async (tx) => {
    const result = await tx.query(
      `SELECT id FROM auth_otps
       WHERE phone_e164 = $1 AND code_hash = $2 AND consumed_at IS NULL
         AND expires_at > NOW() AND attempts < $3
       ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [phone, codeHash, maxAttempts],
    );
    const row = result.rows[0] as { id: string } | undefined;
    if (!row) {
      await tx.query(
        `UPDATE auth_otps SET attempts = attempts + 1
         WHERE id = (SELECT id FROM auth_otps WHERE phone_e164 = $1
           AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1)`,
        [phone],
      );
      return false;
    }
    await tx.query('UPDATE auth_otps SET consumed_at = NOW() WHERE id = $1', [row.id]);
    return true;
  });
}

export async function createUserForVerifiedPhone(phone: string): Promise<UserRecord> {
  const result = await pool.query<UserRecord>(
    `INSERT INTO users (full_name, phone_e164, role)
     VALUES ($1, $2, 'MEMBER')
     ON CONFLICT (phone_e164) DO UPDATE SET phone_e164 = EXCLUDED.phone_e164
     RETURNING id, full_name, phone_e164, email, role, phone_verified_at`,
    ['New member', phone],
  );
  await pool.query('UPDATE users SET phone_verified_at = COALESCE(phone_verified_at, NOW()) WHERE id = $1', [result.rows[0].id]);
  return { ...result.rows[0], phone_verified_at: result.rows[0].phone_verified_at ?? new Date() };
}

export async function createSession(input: {
  userId: string; refreshTokenHash: string; expiresAt: Date; userAgent: string | null; ipAddress: string | null;
}): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO auth_sessions (user_id, refresh_token_hash, expires_at, user_agent, ip_address)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [input.userId, input.refreshTokenHash, input.expiresAt, input.userAgent, input.ipAddress],
  );
  return result.rows[0].id;
}

export async function findSessionByHash(hash: string): Promise<{
  id: string; user_id: string; expires_at: Date; revoked_at: Date | null;
} | null> {
  const result = await pool.query<{id:string;user_id:string;expires_at:Date;revoked_at:Date|null}>(
    'SELECT id, user_id, expires_at, revoked_at FROM auth_sessions WHERE refresh_token_hash = $1',
    [hash],
  );
  return result.rows[0] ?? null;
}

export async function rotateSession(oldHash: string, newHash: string, expiresAt: Date): Promise<boolean> {
  return withTransaction(async (tx) => {
    const found = await tx.query<{id:string;user_id:string}>(
      `SELECT id, user_id FROM auth_sessions
       WHERE refresh_token_hash = $1 AND revoked_at IS NULL AND expires_at > NOW()
       FOR UPDATE`, [oldHash],
    );
    const session = found.rows[0];
    if (!session) return false;
    await tx.query('UPDATE auth_sessions SET revoked_at = NOW() WHERE id = $1', [session.id]);
    await tx.query(
      'INSERT INTO auth_sessions (user_id, refresh_token_hash, expires_at, user_agent, ip_address) VALUES ($1, $2, $3, NULL, NULL)',
      [session.user_id, newHash, expiresAt],
    );
    return true;
  });
}

export async function revokeSession(hash: string): Promise<void> {
  await pool.query('UPDATE auth_sessions SET revoked_at = NOW() WHERE refresh_token_hash = $1 AND revoked_at IS NULL', [hash]);
}

export async function findUserById(id: string): Promise<UserRecord | null> {
  const result = await pool.query<UserRecord>(
    'SELECT id, full_name, phone_e164, email, role, phone_verified_at FROM users WHERE id = $1',
    [id],
  );
  return result.rows[0] ?? null;
}
