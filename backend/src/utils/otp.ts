/**
 * OTP generation, hashing, and verification.
 *
 * Security:
 *  - 6-digit numeric code
 *  - SHA-256 hashed before storage (never raw)
 *  - Constant-time hash comparison (timing-safe)
 *  - 10-minute default expiry
 *  - Max N wrong attempts per code (env), then invalidated
 *  - Max M failures per phone per 1-hour window (hard-coded 15), then lockout
 *  - Only one active code per (phone, purpose)
 */

import { randomInt, createHash, timingSafeEqual } from 'node:crypto';
import { pool, withTransaction } from '../db';
import { env } from '../config/env';
import { logger } from '../logger';
import { sendSms } from './sms';

export type OtpPurpose = 'signup' | 'reset' | 'verify_phone';

const PHONE_FAILURE_LIMIT = 15; // total failed verifications per phone per 1h
const PHONE_FAILURE_WINDOW_MINUTES = 60;

export function generateOtp(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

export function hashOtp(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

/** Constant-time comparison of two hex strings. Returns false if lengths differ. */
function timingSafeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
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
 * Create + send an OTP. Rate-limits: max 5 per phone per hour (dev) or 3 (prod).
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
    logger.warn({ purpose, sentLastHour }, 'OTP rate limit hit');
    return { ok: false, error: 'Too many codes requested - try again later' };
  }

  const code = generateOtp();
  const codeHash = hashOtp(code);
  const expiresAt = new Date(Date.now() + env.OTP_EXPIRY_MINUTES * 60 * 1000);

  await withTransaction(async (tx) => {
    await tx.query(
      `UPDATE otp_codes SET consumed_at = NOW()
       WHERE phone = $1 AND purpose = $2 AND consumed_at IS NULL`,
      [phone, purpose],
    );

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

  if (env.IS_DEVELOPMENT) {
    logger.info({ purpose, code }, 'DEV: OTP code (logged for testing)');
  }

  return { ok: true };
}

/**
 * Verify an OTP. Returns ok=true if valid and consumes it.
 *
 * Enforces:
 *  - Per-code wrong-attempt limit (env.OTP_MAX_ATTEMPTS)
 *  - Per-phone failure limit over 1-hour window (PHONE_FAILURE_LIMIT)
 *  - Expiry
 *  - Constant-time comparison
 */
export async function verifyOtp(
  phone: string,
  purpose: OtpPurpose,
  code: string,
): Promise<{ ok: boolean; error?: string }> {
  // Dev override — only fires in development
  if (env.IS_DEVELOPMENT && env.DEV_OTP_OVERRIDE && code === env.DEV_OTP_OVERRIDE) {
    logger.warn({ purpose }, 'DEV: OTP override used');
    return { ok: true };
  }

  // Per-phone failure lockout (across all recent codes)
  const failCheck = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM otp_codes
     WHERE phone = $1
       AND attempts > 0
       AND created_at > NOW() - INTERVAL '${PHONE_FAILURE_WINDOW_MINUTES} minutes'`,
    [phone],
  );
  const recentFailures = Number(failCheck.rows[0]?.count ?? '0');
  if (recentFailures >= PHONE_FAILURE_LIMIT) {
    logger.warn({ purpose, recentFailures }, 'OTP phone lockout triggered');
    return { ok: false, error: 'Too many failed attempts - try again later' };
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
  if (!timingSafeHexEqual(suppliedHash, row.code_hash)) {
    await pool.query(`UPDATE otp_codes SET attempts = attempts + 1 WHERE id = $1`, [row.id]);
    return { ok: false, error: 'Invalid code' };
  }

  await pool.query(`UPDATE otp_codes SET consumed_at = NOW() WHERE id = $1`, [row.id]);
  return { ok: true };
}