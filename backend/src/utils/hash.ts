/**
 * SHA-256 hashing helpers.
 *
 * Used for refresh tokens: raw token is handed to the client, only the
 * SHA-256 hash is stored. If the DB is leaked, tokens can't be reused.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}