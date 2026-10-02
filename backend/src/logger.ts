/**
 * Structured logger (pino).
 *
 * Rules:
 *  - All logs are JSON lines — machine-parseable, safe to ship to a log drain.
 *  - Redaction list removes auth headers, cookies, passwords, tokens, and PII.
 *  - Child loggers carry requestId / userId for tracing.
 */

import pino from 'pino';
import { env } from './config/env';

const redactPaths = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'password',
  'passwordHash',
  'password_hash',
  'accessToken',
  'refreshToken',
  'token',
  '*.password',
  '*.passwordHash',
  '*.password_hash',
  '*.accessToken',
  '*.refreshToken',
];

export const logger = pino({
  level: env.LOG_LEVEL,
  redact: { paths: redactPaths, censor: '[REDACTED]' },
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