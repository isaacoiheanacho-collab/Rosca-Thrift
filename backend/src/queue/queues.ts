/**
 * Queue definitions.
 *
 * Each queue represents a category of background work. Adding a queue here
 * + a worker file + a job type is the whole pattern. Everything else
 * (retries, backoff, concurrency) is per-queue config.
 *
 * Conventions:
 *  - Queue name = kebab-case noun ("notifications", "webhook-retries").
 *  - Job data is always a plain object with a `type` discriminator.
 *  - Jobs are idempotent - re-running must be safe.
 */

import { Queue, type JobsOptions } from 'bullmq';
import { createQueueConnection } from './connection';
import { logger } from '../logger';

/** Shared Redis connection for all queues (producers only - non-blocking). */
const producerConnection = createQueueConnection();

/** Default job options applied to every job unless overridden. */
export const defaultJobOptions: JobsOptions = {
  attempts: 5,
  backoff: {
    type: 'exponential',
    delay: 2_000,   // 2s, 4s, 8s, 16s, 32s
  },
  removeOnComplete: {
    age: 24 * 3600, // keep completed jobs 24h
    count: 1_000,   // cap at 1000 jobs
  },
  removeOnFail: {
    age: 7 * 24 * 3600, // keep failed jobs 7 days
  },
};

// ---- Job data shapes ----

export interface NotificationJobData {
  type: 'notification.send';
  userId: string;
  channel: 'in-app' | 'email';
  title: string;
  body: string;
  metadata?: Record<string, unknown>;
}

export type JobData = NotificationJobData;

// ---- Queues ----

export const notificationsQueue = new Queue<NotificationJobData>('notifications', {
  connection: producerConnection,
  defaultJobOptions,
});

/** All queues - used for health checks and shutdown. */
export const queues = {
  notifications: notificationsQueue,
} as const;

export type QueueName = keyof typeof queues;

/** Close every queue (called on graceful shutdown). */
export async function closeQueues(): Promise<void> {
  logger.debug('Closing BullMQ queues...');
  await Promise.allSettled(Object.values(queues).map((q) => q.close()));
  await producerConnection.quit().catch(() => producerConnection.disconnect());
}