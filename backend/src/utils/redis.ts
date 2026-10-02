/**
 * Redis client (ioredis).
 *
 * Single shared connection for the app. In Phase 2 we'll add a second
 * connection specifically for BullMQ (workers need their own blocking
 * connection).
 *
 * TLS is handled automatically: `rediss://` scheme enables it.
 */

import Redis, { type RedisOptions } from 'ioredis';
import { env } from '../config/env';
import { logger } from '../logger';

if (!env.REDIS_URL) {
  throw new Error('REDIS_URL is not set. Check your .env file.');
}

const options: RedisOptions = {
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  lazyConnect: false,
  retryStrategy: (times) => {
    // Exponential backoff, capped at 3 seconds
    return Math.min(times * 200, 3000);
  },
};

export const redis = new Redis(env.REDIS_URL, options);

redis.on('connect', () => logger.debug('Redis: connecting'));
redis.on('ready', () => logger.info('Redis: ready'));
redis.on('error', (err) => logger.error({ err }, 'Redis: error'));
redis.on('close', () => logger.warn('Redis: connection closed'));
redis.on('reconnecting', () => logger.warn('Redis: reconnecting'));

/** Ping Redis and return latency. Used by /health. */
export async function testRedis(): Promise<
  | { ok: true; latencyMs: number }
  | { ok: false; error: string }
> {
  const start = Date.now();
  try {
    const reply = await redis.ping();
    if (reply !== 'PONG') {
      return { ok: false, error: `Unexpected PING reply: ${reply}` };
    }
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Graceful shutdown — call from server SIGTERM / SIGINT handlers. */
export async function closeRedis(): Promise<void> {
  try {
    await redis.quit();
  } catch {
    redis.disconnect();
  }
}