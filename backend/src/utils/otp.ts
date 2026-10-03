/**
 * OTP generation, hashing, and verification.
 *
 * Rules:
 *  - 6-digit numeric code
 *  - SHA-256 hashed before storage (never store raw)
 *  - 10-minute default expiry (env override)
 *  - Max N wrong attempts (env override), then invalidated
 *  - Only one active code per (phone, purpose)
 */

import { randomInt, createHash } from 'node:crypto';
import { pool, withTransaction } from '../db';
import { env } from '../config/env';
import { logger } from '../logger';
import { sendSms } from './sms';

export type OtpPurpose = 'signup' | 'reset' | 'verify_phone';

export function generateOtp(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

export function hashOtp(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

interface OtpRow {
  id: string;
  phone: string;
  code_hash: string;
  purpose: OtpPurpose;
  expires_at: Date;
  consumed_at: Date | null;
  attempts: number;
}

/**
 * Create + send an OTP. Rate-limits: max 5 per phone per hour.
 * Returns ok=false if the SMS send failed.
 */
export async function createAndSendOtp(
  phone: string,
  purpose: OtpPurpose,
  ipAddress?: string,
): Promise<{ ok: boolean; error?: string }> {
  // Rate limit: count codes sent for this phone in the last hour
  const rateCheck = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM otp_codes
     WHERE phone = $1 AND created_at > NOW() - INTERVAL '1 hour'`,
    [phone],
  );
  const sentLastHour = Number(rateCheck.rows[0]?.count ?? '0');
  const limit = env.IS_PRODUCTION ? 3 : 5;
  if (sentLastHour >= limit) {
    logger.warn({ phone, purpose, sentLastHour }, 'OTP rate limit hit');
    return { ok: false, error: 'Too many codes requested - try again later' };
  }

  const code = generateOtp();
  const codeHash = hashOtp(code);
  const expiresAt = new Date(Date.now() + env.OTP_EXPIRY_MINUTES * 60 * 1000);

  await withTransaction(async (tx) => {
    // Invalidate any existing unconsumed codes for the same phone + purpose
    await tx.query(
      `UPDATE otp_codes SET consumed_at = NOW()
       WHERE phone = $1 AND purpose = $2 AND consumed_at IS NULL`,
      [phone, purpose],
    );

    // Insert new code
    await tx.query(
      `INSERT INTO otp_codes (phone, code_hash, purpose, expires_at, ip_address)
       VALUES ($1, $2, $3, $4, $5)`,
      [phone, codeHash, purpose, expiresAt, ipAddress ?? null],
    );
  });

  const purposeLabel =
    purpose === 'signup'
      ? 'signup'
      : purpose === 'reset'
        ? 'password reset'
        : 'verification';

  const message = `Your ROSCA ${purposeLabel} code is ${code}. Valid for ${env.OTP_EXPIRY_MINUTES} minutes. Do not share this code.`;

  const send = await sendSms(phone, message);
  if (!send.ok) {
    return { ok: false, error: send.error ?? 'Failed to send SMS' };
  }

  // Dev hint - log the code locally only
  if (env.IS_DEVELOPMENT) {
    logger.info({ phone, purpose, code }, 'DEV: OTP code (logged for testing)');
  }

  return { ok: true };
}

/**
 * Verify an OTP. Returns ok=true if valid and consumes it.
 * Increments attempts on failure; invalidates after N failed attempts.
 */
export async function verifyOtp(
  phone: string,
  purpose: OtpPurpose,
  code: string,
): Promise<{ ok: boolean; error?: string }> {
  // Dev override - allows a fixed master code in dev
  if (env.IS_DEVELOPMENT && env.DEV_OTP_OVERRIDE && code === env.DEV_OTP_OVERRIDE) {
    logger.warn({ phone, purpose }, 'DEV: OTP override used');
    return { ok: true };
  }

  const result = await pool.query<OtpRow>(
    `SELECT * FROM otp_codes
     WHERE phone = $1 AND purpose = $2 AND consumed_at IS NULL
     ORDER BY created_at DESC LIMIT 1`,
    [phone, purpose],
  );

  const row = result.rows[0];
  if (!row) return { ok: false, error: 'No active code - request a new one' };

  if (row.expires_at.getTime() < Date.now()) {
    await pool.query(`UPDATE otp_codes SET consumed_at = NOW() WHERE id = $1`, [row.id]);
    return { ok: false, error: 'Code expired - request a new one' };
  }

  if (row.attempts >= env.OTP_MAX_ATTEMPTS) {
    await pool.query(`UPDATE otp_codes SET consumed_at = NOW() WHERE id = $1`, [row.id]);
    return { ok: false, error: 'Too many attempts - request a new code' };
  }

  const suppliedHash = hashOtp(code);
  if (suppliedHash !== row.code_hash) {
    await pool.query(`UPDATE otp_codes SET attempts = attempts + 1 WHERE id = $1`, [row.id]);
    return { ok: false, error: 'Invalid code' };
  }

  await pool.query(`UPDATE otp_codes SET consumed_at = NOW() WHERE id = $1`, [row.id]);
  return { ok: true };
}