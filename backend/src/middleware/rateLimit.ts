/**
 * Rate limiting middleware.
 *
 * Uses Redis-backed store so limits apply across all API instances.
 * Falls back to memory store if Redis is unavailable at boot.
 *
 * Two limiters:
 *   - generalLimiter: applied globally (per IP)
 *   - authLimiter: applied to /api/auth/* (stricter)
 */

import rateLimit, { type RateLimitRequestHandler } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import type { Request, Response } from 'express';
import { env } from '../config/env';
import { logger } from '../logger';
import { redis } from '../utils/redis';

const jsonHandler =
  (message: string) =>
  (_req: Request, res: Response): void => {
    res.status(429).json({
      ok: false,
      error: { code: 'RATE_LIMIT_EXCEEDED', message },
    });
  };

/**
 * Redis-backed store for express-rate-limit.
 * Uses ioredis's `call` method to send raw Redis commands.
 */
function makeStore(prefix: string): RedisStore | undefined {
  try {
    const store = new RedisStore({
      sendCommand: (...args: string[]) =>
        // ioredis exposes call() for raw commands; cast to satisfy typing
        (redis.call as unknown as (...a: string[]) => Promise<never>)(...args),
      prefix: `rl:${prefix}:`,
    });
    logger.info({ prefix }, 'Rate limit store: Redis');
    return store;
  } catch (err) {
    logger.warn({ err, prefix }, 'Rate limit store: fallback to memory');
    return undefined;
  }
}

export const generalLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  store: makeStore('general'),
  handler: jsonHandler('Too many requests - slow down.'),
  skip: () => env.IS_DEVELOPMENT,
});

export const authLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: 60_000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  store: makeStore('auth'),
  handler: jsonHandler('Too many auth attempts - please wait a minute.'),
  skip: () => env.IS_DEVELOPMENT,
});