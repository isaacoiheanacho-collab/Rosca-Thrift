/**
 * Notifications worker.
 *
 * Processes jobs from the `notifications` queue:
 *   - type: 'notification.send' -> deliver via in-app and/or email
 *
 * Workers use a SEPARATE Redis connection from the producers because
 * BullMQ workers do blocking reads. Do not share connection objects
 * between Queue and Worker instances.
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
      logger.info(
        { jobId: job.id, attempt: job.attemptsMade + 1, type, userId, channel, title },
        'Processing notification job',
      );

      switch (type) {
        case 'notification.send':
          // TODO (Phase 1.3): insert into notifications table (in-app)
          // TODO (Phase 1.3): send via SMTP (email)
          await new Promise((r) => setTimeout(r, 100)); // simulate work
          break;
        default: {
          const _exhaustive: never = type;
          throw new Error(`Unknown job type: ${_exhaustive}`);
        }
      }

      return { delivered: true };
    },
    {
      connection: createQueueConnection(),
      concurrency: 5,
    },
  );

  worker.on('completed', (job) => {
    logger.info({ jobId: job.id }, 'Notification job completed');
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