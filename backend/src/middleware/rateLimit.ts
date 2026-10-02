/**
 * Rate limiting middleware.
 *
 * Two limiters:
 *  - generalLimiter: applied globally (per IP)
 *  - authLimiter:    applied to /api/auth/* (much stricter)
 *
 * Uses in-memory store for now. Swap to a Redis store (rate-limit-redis)
 * once we run multiple backend instances.
 */

import rateLimit, { type RateLimitRequestHandler } from 'express-rate-limit';
import type { Request, Response } from 'express';
import { env } from '../config/env';
import { logger } from '../logger';

const jsonHandler =
  (message: string) =>
  (_req: Request, res: Response): void => {
    res.status(429).json({
      ok: false,
      error: { code: 'RATE_LIMIT_EXCEEDED', message },
    });
  };

export const generalLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: 60_000, // 1 minute
  limit: 120,       // 120 requests / minute / IP
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: jsonHandler('Too many requests - slow down.'),
  // In dev, don't rate-limit to avoid annoying yourself
  skip: () => env.IS_DEVELOPMENT,
});

export const authLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: 60_000, // 1 minute
  limit: 20,        // 20 auth attempts / minute / IP
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: jsonHandler('Too many auth attempts - please wait a minute.'),
  skip: () => env.IS_DEVELOPMENT,
});

logger.debug('Rate limiters configured');