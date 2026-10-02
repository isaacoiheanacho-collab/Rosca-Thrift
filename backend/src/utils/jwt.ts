import jwt, { type SignOptions } from 'jsonwebtoken';
import { env } from '../config/env';

export interface JwtPayload {
  sub: string;
  role: 'SAVER' | 'ADMIN';
  type: 'access' | 'refresh';
}

export function signAccessToken(userId: string, role: JwtPayload['role']): string {
  const payload: JwtPayload = { sub: userId, role, type: 'access' };
  const opts: SignOptions = { expiresIn: env.JWT_ACCESS_TTL };

  return jwt.sign(payload, env.JWT_ACCESS_SECRET, opts);
}

export function signRefreshToken(userId: string, role: JwtPayload['role']): string {
  const payload: JwtPayload = { sub: userId, role, type: 'refresh' };
  const opts: SignOptions = { expiresIn: env.JWT_REFRESH_TTL };

  return jwt.sign(payload, env.JWT_REFRESH_SECRET, opts);
}

export function verifyAccessToken(token: string): JwtPayload {
  const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET) as JwtPayload;

  if (decoded.type !== 'access') {
    throw new Error('Invalid token type');
  }

  return decoded;
}

export function verifyRefreshToken(token: string): JwtPayload {
  const decoded = jwt.verify(token, env.JWT_REFRESH_SECRET) as JwtPayload;

  if (decoded.type !== 'refresh') {
    throw new Error('Invalid token type');
  }

  return decoded;
}

export function refreshTokenExpiryDate(): Date {
  return new Date(Date.now() + env.JWT_REFRESH_TTL * 1000);
}