/**
 * BullMQ Redis connection.
 *
 * BullMQ workers use blocking reads (BRPOPLPUSH etc.), which require a
 * dedicated connection per worker. We cannot share our main `redis` client
 * because blocking would freeze it.
 *
 * `maxRetriesPerRequest: null` is REQUIRED by BullMQ - it manages retries
 * internally and needs the client to never fail a command on its own.
 */

import { Redis, type RedisOptions } from 'ioredis';
import { env } from '../config/env';
import { logger } from '../logger';

const connectionOptions: RedisOptions = {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  retryStrategy: (times) => Math.min(times * 200, 3000),
};

/** Create a fresh BullMQ-compatible Redis connection. */
export function createQueueConnection(): Redis {
  const connection = new Redis(env.REDIS_URL, connectionOptions);

  connection.on('connect', () => logger.debug('BullMQ Redis: connecting'));
  connection.on('ready', () => logger.debug('BullMQ Redis: ready'));
  connection.on('error', (err) => logger.error({ err }, 'BullMQ Redis: error'));

  return connection;
}