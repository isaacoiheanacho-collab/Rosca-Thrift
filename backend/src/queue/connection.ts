/**
 * BullMQ Redis connection.
 *
 * BullMQ workers use blocking reads (BRPOPLPUSH etc.), which require a
 * dedicated connection per worker. We cannot share our main `redis` client
 * because blocking would freeze it.
 *
 * `maxRetriesPerRequest: null` is REQUIRED by BullMQ - it manages retries
 * internally and needs the client to never fail a command on its own.
 *
 * Tuning for free-tier providers (Upstash, Redis Labs, etc.):
 *  - `enableReadyCheck: false` avoids extra INFO commands on connect.
 *  - `retryStrategy` prevents rapid reconnect storms.
 *  - `keepAlive` avoids frequent TCP keepalive pings.
 *  - `connectTimeout` prevents slow-boot zombies.
 */

import { Redis, type RedisOptions } from 'ioredis';
import { env } from '../config/env';
import { logger } from '../logger';

const connectionOptions: RedisOptions = {
  maxRetriesPerRequest: null,        // Required by BullMQ
  enableReadyCheck: false,           // Skip extra INFO call on connect
  retryStrategy: (times) => Math.min(times * 1000, 15000), // Max 15s backoff
  keepAlive: 30000,                  // 30s TCP keepalive
  connectTimeout: 15000,             // 15s connect timeout
  enableOfflineQueue: false,         // Don't queue commands when offline
};

/** Create a fresh BullMQ-compatible Redis connection. */
export function createQueueConnection(): Redis {
  const connection = new Redis(env.REDIS_URL, connectionOptions);

  connection.on('connect', () => logger.debug('BullMQ Redis: connecting'));
  connection.on('ready', () => logger.debug('BullMQ Redis: ready'));
  connection.on('error', (err) => logger.error({ err }, 'BullMQ Redis: error'));

  return connection;
}