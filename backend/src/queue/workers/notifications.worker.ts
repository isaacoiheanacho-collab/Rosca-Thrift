/**
 * Notifications worker.
 *
 * Processes jobs from the `notifications` queue.
 *
 * At the moment, all notification inserts + delivery happen synchronously
 * inside NotificationsService.notify() — the queue exists but is not on the
 * critical path. This worker is kept as a stub for future bulk operations
 * (e.g., digest emails, batched SMS) that benefit from being off-process.
 *
 * If a `notification.send` job arrives, this worker logs it and does nothing
 * — the service layer already handled delivery. This preserves the queue
 * contract without double-delivering.
 */

import { Worker, type Job } from 'bullmq';
import { createQueueConnection } from '../connection';
import { logger } from '../../logger';
import type { NotificationJobData } from '../queues';

export function startNotificationsWorker(): Worker<NotificationJobData> {
  const worker = new Worker<NotificationJobData>(
    'notifications',
    async (job: Job<NotificationJobData>) => {
      const { type, userId, channel, title } = job.data;
      logger.debug(
        { jobId: job.id, type, userId, channel, title },
        'Notification job received (delivery already handled by service layer)',
      );

      switch (type) {
        case 'notification.send':
          // Delivery is handled synchronously in NotificationsService.
          // This worker exists for future batch operations.
          return { handled: true };
        default: {
          const _exhaustive: never = type;
          throw new Error(`Unknown job type: ${_exhaustive}`);
        }
      }
    },
    {
      connection: createQueueConnection(),
      concurrency: 5,
    },
  );

  worker.on('completed', (job) => {
    logger.debug({ jobId: job.id }, 'Notification job completed');
  });

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err }, 'Notification job failed');
  });

  worker.on('error', (err) => {
    logger.error({ err }, 'Notifications worker error');
  });

  logger.info('Notifications worker started');

  return worker;
}