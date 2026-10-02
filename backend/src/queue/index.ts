/**
 * Queue public API.
 *
 * Import from here to enqueue jobs or manage workers. Feature modules
 * should never import from './queues' or './workers/*' directly.
 */

import { type Worker } from 'bullmq';
import { logger } from '../logger';
import { startNotificationsWorker } from './workers/notifications.worker';
import { closeQueues, notificationsQueue, type NotificationJobData } from './queues';

let startedWorkers: Worker[] = [];

/** Start every worker. Called once on server boot. */
export function startAllWorkers(): void {
  if (startedWorkers.length > 0) {
    logger.warn('Workers already started - skipping');
    return;
  }
  startedWorkers = [startNotificationsWorker()];
  logger.info({ count: startedWorkers.length }, 'All workers started');
}

/** Stop every worker and close all queues. Called on graceful shutdown. */
export async function stopAllWorkers(): Promise<void> {
  logger.info('Stopping workers...');
  await Promise.allSettled(startedWorkers.map((w) => w.close()));
  await closeQueues();
  startedWorkers = [];
  logger.info('Workers stopped');
}

/** Enqueue a notification job. */
export async function enqueueNotification(data: NotificationJobData): Promise<string> {
  const job = await notificationsQueue.add(data.type, data);
  return job.id ?? 'unknown';
}