/**
 * Structured logger (pino).
 *
 * Redaction rules:
 *   - Auth: authorization header, cookies, api keys
 *   - Secrets: passwords, tokens
 *   - PII: phone, email, full names, bank account details
 *   - KYC: selfie keys, legal names
 *
 * Never log user-supplied strings without sanitizing first.
 */

import pino from 'pino';
import { env } from './config/env';

const redactPaths = [
  // Headers
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.headers["plaid-verification"]',

  // Top-level auth/secrets
  'password',
  'passwordHash',
  'password_hash',
  'accessToken',
  'refreshToken',
  'token',
  'code',
  'code_hash',

  // PII — top level
  'phone',
  'email',
  'fullName',
  'full_name',
  'legalName',
  'legal_name',

  // Bank details
  'accountNumber',
  'account_number',
  'sortCode',
  'sort_code',
  'accountHolderName',
  'account_holder_name',

  // Wildcard variants — match nested objects
  '*.password',
  '*.passwordHash',
  '*.password_hash',
  '*.accessToken',
  '*.refreshToken',
  '*.token',
  '*.phone',
  '*.email',
  '*.fullName',
  '*.full_name',
  '*.legalName',
  '*.legal_name',
  '*.accountNumber',
  '*.account_number',
  '*.sortCode',
  '*.sort_code',
  '*.accountHolderName',
  '*.account_holder_name',

  // Nested user objects
  'user.phone',
  'user.email',
  'user.fullName',
  'user.full_name',
  'user.legalName',
  'user.legal_name',
  'data.user.phone',
  'data.user.email',
  'data.user.fullName',

  // Responses (for debugging logs that capture req/res)
  'res.body.phone',
  'res.body.email',
];

export const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: redactPaths,
    censor: '[REDACTED]',
    remove: false, // keep the key, replace the value
  },
  base: { service: 'rosca-backend', env: env.NODE_ENV },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label }),
  },
  transport: env.IS_DEVELOPMENT
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:HH:MM:ss',
          ignore: 'pid,hostname,service,env',
        },
      }
    : undefined,
});

export type Logger = typeof logger;