/**
 * Environment configuration.
 *
 * Loads .env into process.env, then validates every variable we need.
 * If any required variable is missing or malformed, the process exits
 * with a clear message - no silent failures at runtime.
 */

import 'dotenv/config';
import { z } from 'zod';

/** Postgres connection URL (postgresql:// or postgres://). */
const PostgresUrl = z
  .string()
  .min(1, 'is required')
  .refine((v) => /^postgres(ql)?:\/\//.test(v), {
    message: 'must start with postgresql:// or postgres://',
  });

/** Redis connection URL (redis:// or rediss:// for TLS). */
const RedisUrl = z
  .string()
  .min(1, 'is required')
  .refine((v) => /^rediss?:\/\//.test(v), {
    message: 'must start with redis:// or rediss://',
  });

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4001),

  DATABASE_URL: PostgresUrl,
  DIRECT_URL: PostgresUrl.optional(),
  REDIS_URL: RedisUrl,

  S3_ENDPOINT: z.string().url(),
  S3_REGION: z.string().min(1),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),

  JWT_ACCESS_SECRET: z.string().min(32, 'must be at least 32 chars'),
  JWT_REFRESH_SECRET: z.string().min(32, 'must be at least 32 chars'),
  JWT_ACCESS_TTL: z.coerce.number().int().positive().default(900),
  JWT_REFRESH_TTL: z.coerce.number().int().positive().default(2_592_000),

  CORS_ORIGINS: z.string().default('http://localhost:3000'),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // Tenant and branch configuration
  MAX_TENANTS: z.coerce.number().int().positive().default(50),
  BRANCH_JOIN_BASE_URL: z.string().url().default('http://localhost:3000/join'),

  // TextBee SMS
  TEXTBEE_API_KEY: z.string().min(1),
  TEXTBEE_DEVICE_ID: z.string().min(1),
  TEXTBEE_BASE_URL: z.string().url().default('https://api.textbee.dev/api/v1'),

  // OTP
  OTP_EXPIRY_MINUTES: z.coerce.number().int().positive().default(10),
  OTP_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),

  // Super-admin bootstrap
  SUPER_ADMIN_PHONE: z.string().regex(/^\+[1-9]\d{6,14}$/).optional(),

  // Dev override (optional). In dev, if set, this code works alongside real OTP.
  DEV_OTP_OVERRIDE: z.string().optional(),
});

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('❌ Invalid environment configuration:');

  for (const issue of parsed.error.issues) {
    // eslint-disable-next-line no-console
    console.error(`   ${issue.path.join('.')}: ${issue.message}`);
  }

  process.exit(1);
}

export const env = Object.freeze({
  ...parsed.data,
  CORS_ORIGINS_LIST: parsed.data.CORS_ORIGINS.split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  IS_PRODUCTION: parsed.data.NODE_ENV === 'production',
  IS_DEVELOPMENT: parsed.data.NODE_ENV === 'development',
  IS_TEST: parsed.data.NODE_ENV === 'test',
});

export type Env = typeof env;