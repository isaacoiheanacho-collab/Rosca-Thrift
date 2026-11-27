import { createHash, createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env';
import { AppError } from '../../errors/AppError';
import { sendSms } from '../../utils/sms';
import * as repo from './auth.repository';

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const hashOtp = (phone: string, code: string): string =>
  createHmac('sha256', env.JWT_ACCESS_SECRET).update(phone).update(':').update(code).digest('hex');
const accessSecret = env.JWT_ACCESS_SECRET;
const refreshSecret = env.JWT_REFRESH_SECRET;

function issueAccessToken(user: repo.UserRecord): string {
  return jwt.sign({ role: user.role, phone: user.phone_e164 }, accessSecret, {
    subject: user.id, expiresIn: env.JWT_ACCESS_TTL,
  });
}
function issueRefreshToken(userId: string): string {
  return jwt.sign({ typ: 'refresh', nonce: randomUUID() }, refreshSecret, {
    subject: userId, expiresIn: env.JWT_REFRESH_TTL,
  });
}
function publicUser(user: repo.UserRecord) {
  return { id: user.id, fullName: user.full_name, phone: user.phone_e164, email: user.email, role: user.role, phoneVerified: Boolean(user.phone_verified_at) };
}

export async function requestOtp(phone: string): Promise<{ message: string }> {
  const code = env.IS_DEVELOPMENT && env.DEV_OTP_OVERRIDE
    ? env.DEV_OTP_OVERRIDE
    : String(randomInt(100000, 1000000));
  if (!/^\d{6}$/.test(code)) throw new AppError({ code: 'OTP_CONFIG_INVALID', httpStatus: 500, message: 'OTP configuration is invalid' });
  await repo.createOtp(phone, hashOtp(phone, code), new Date(Date.now() + env.OTP_EXPIRY_MINUTES * 60_000));
  const sent = await sendSms(phone, `Your ROSCA verification code is ${code}. It expires in ${env.OTP_EXPIRY_MINUTES} minutes.`);
  if (!sent.ok) throw new AppError({ code: 'OTP_DELIVERY_FAILED', httpStatus: 502, message: 'Unable to deliver verification code' });
  return { message: 'If the phone number can receive messages, a verification code has been sent.' };
}

export async function verifyOtp(input: { phone: string; code: string }, meta: { userAgent: string | null; ipAddress: string | null }) {
  const valid = await repo.consumeOtp(input.phone, hashOtp(input.phone, input.code), env.OTP_MAX_ATTEMPTS);
  if (!valid) throw new AppError({ code: 'INVALID_OTP', httpStatus: 401, message: 'The verification code is invalid or expired' });
  const user = await repo.createUserForVerifiedPhone(input.phone);
  const refreshToken = issueRefreshToken(user.id);
  const expiresAt = new Date(Date.now() + env.JWT_REFRESH_TTL * 1000);
  await repo.createSession({ userId: user.id, refreshTokenHash: hash(refreshToken), expiresAt, ...meta });
  return { accessToken: issueAccessToken(user), refreshToken, expiresIn: env.JWT_ACCESS_TTL, user: publicUser(user) };
}

export async function refreshSession(refreshToken: string) {
  let claims: jwt.JwtPayload;
  try {
    const decoded = jwt.verify(refreshToken, refreshSecret);
    if (typeof decoded === 'string' || decoded.typ !== 'refresh' || !decoded.sub) throw new Error('Invalid refresh claims');
    claims = decoded;
  } catch {
    throw new AppError({ code: 'INVALID_REFRESH_TOKEN', httpStatus: 401, message: 'Refresh token is invalid or expired' });
  }
  const oldHash = hash(refreshToken);
  const existing = await repo.findSessionByHash(oldHash);
  if (!existing || existing.revoked_at || existing.expires_at.getTime() <= Date.now()) {
    throw new AppError({ code: 'SESSION_EXPIRED', httpStatus: 401, message: 'Session is expired or has been revoked' });
  }
  if (existing.user_id !== claims.sub) throw new AppError({ code: 'SESSION_INVALID', httpStatus: 401, message: 'Session is invalid' });
  const user = await repo.findUserById(existing.user_id);
  if (!user) throw new AppError({ code: 'USER_NOT_FOUND', httpStatus: 401, message: 'User account no longer exists' });
  const nextRefresh = issueRefreshToken(user.id);
  const nextHash = hash(nextRefresh);
  const expiresAt = new Date(Date.now() + env.JWT_REFRESH_TTL * 1000);
  const rotated = await repo.rotateSession(oldHash, nextHash, expiresAt);
  if (!rotated) throw new AppError({ code: 'SESSION_REPLAYED', httpStatus: 401, message: 'Session has already been used; sign in again' });
  return { accessToken: issueAccessToken(user), refreshToken: nextRefresh, expiresIn: env.JWT_ACCESS_TTL, user: publicUser(user) };
}

export async function logout(refreshToken: string): Promise<void> {
  await repo.revokeSession(hash(refreshToken));
}

export function authenticateAccessToken(token: string): { userId: string; role: string } {
  try {
    const decoded = jwt.verify(token, accessSecret);
    if (typeof decoded === 'string' || !decoded.sub || !decoded.role) throw new Error('Invalid claims');
    return { userId: decoded.sub, role: String(decoded.role) };
  } catch {
    throw new AppError({ code: 'UNAUTHENTICATED', httpStatus: 401, message: 'A valid access token is required' });
  }
}

export async function getProfile(userId: string) {
  const user = await repo.findUserById(userId);
  if (!user) throw new AppError({ code: 'USER_NOT_FOUND', httpStatus: 404, message: 'User not found' });
  return publicUser(user);
}

export async function bootstrapSuperAdmin(userId: string, suppliedSecret: string) {
  if (!env.SUPER_ADMIN_PHONE) {
    throw new AppError({ code: 'SUPER_ADMIN_BOOTSTRAP_DISABLED', httpStatus: 403, message: 'Super administrator bootstrap is not configured' });
  }
  const expected = Buffer.from(env.SUPER_ADMIN_REGISTRATION_SECRET);
  const supplied = Buffer.from(suppliedSecret);
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
    throw new AppError({ code: 'SUPER_ADMIN_SECRET_INVALID', httpStatus: 403, message: 'Registration secret is invalid' });
  }
  const user = await repo.findUserById(userId);
  if (!user || user.phone_e164 !== env.SUPER_ADMIN_PHONE || !user.phone_verified_at) {
    throw new AppError({ code: 'SUPER_ADMIN_PHONE_MISMATCH', httpStatus: 403, message: 'This verified phone is not authorised for super administrator bootstrap' });
  }
  const promoted = await repo.promoteSuperAdmin(userId);
  if (!promoted) throw new AppError({ code: 'USER_NOT_FOUND', httpStatus: 404, message: 'User account not found' });
  return publicUser(promoted);
}
