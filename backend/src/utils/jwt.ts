/**
 * JWT signing and verification.
 *
 * Security features:
 *   - HS256 signing with 256-bit secrets
 *   - iss/aud/env claims prevent cross-env token acceptance
 *   - Refresh tokens hashed before storage (see auth.service.ts)
 */

import jwt, { type SignOptions, type JwtPayload as BaseJwtPayload } from 'jsonwebtoken';
import { env } from '../config/env';

export type UserRole = 'SUPER_ADMIN' | 'BRANCH_ADMIN' | 'SAVER';

export interface JwtPayload extends BaseJwtPayload {
  sub: string;
  role: UserRole;
  branchId: string | null;
  type: 'access' | 'refresh';
  env: string;
}

const ISSUER = 'rosca-api';
const AUDIENCE = 'rosca-app';

export function signAccessToken(userId: string, role: UserRole, branchId: string | null): string {
  const payload = {
    sub: userId,
    role,
    branchId,
    type: 'access',
    env: env.NODE_ENV,
  };
  const opts: SignOptions = {
    issuer: ISSUER,
    audience: AUDIENCE,
    expiresIn: env.JWT_ACCESS_TTL,
  };
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, opts);
}

export function signRefreshToken(userId: string, role: UserRole, branchId: string | null): string {
  const payload = {
    sub: userId,
    role,
    branchId,
    type: 'refresh',
    env: env.NODE_ENV,
  };
  const opts: SignOptions = {
    issuer: ISSUER,
    audience: AUDIENCE,
    expiresIn: env.JWT_REFRESH_TTL,
  };
  return jwt.sign(payload, env.JWT_REFRESH_SECRET, opts);
}

function verifyCommon(token: string, secret: string): JwtPayload {
  const decoded = jwt.verify(token, secret, {
    issuer: ISSUER,
    audience: AUDIENCE,
  }) as JwtPayload;

  if (decoded.env !== env.NODE_ENV) {
    throw new Error(`Token env mismatch: expected ${env.NODE_ENV}, got ${decoded.env}`);
  }

  return decoded;
}

export function verifyAccessToken(token: string): JwtPayload {
  const decoded = verifyCommon(token, env.JWT_ACCESS_SECRET);
  if (decoded.type !== 'access') throw new Error('Invalid token type');
  return decoded;
}

export function verifyRefreshToken(token: string): JwtPayload {
  const decoded = verifyCommon(token, env.JWT_REFRESH_SECRET);
  if (decoded.type !== 'refresh') throw new Error('Invalid token type');
  return decoded;
}

export function refreshTokenExpiryDate(): Date {
  return new Date(Date.now() + env.JWT_REFRESH_TTL * 1000);
}