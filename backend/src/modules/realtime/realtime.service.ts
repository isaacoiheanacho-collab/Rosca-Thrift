/**
 * Realtime delivery service.
 *
 * One entry point: `deliverNotification()`. Given a persisted notification
 * row (from notifications.service), it fans out to:
 *
 *   1. Socket.IO       — live update if the user has the app open
 *   2. Web Push        — browser-native push, works when app is closed
 *
 * This is the "delivery" half of the system. The "creation" half (writing
 * the row, picking recipients) lives in notifications.service.
 *
 * Delivery is best-effort and never throws.
 */

import { logger } from '../../logger';
import { emitToUser } from './socket';
import { sendWebPush } from '../../utils/web-push';
import { notificationsRepository } from '../notifications/notifications.repository';

export interface DeliverableNotification {
  id: string;
  userId: string;
  kind: string;
  title: string;
  body: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

export interface DeliverResult {
  socketEmitted: boolean;
  pushAttempted: number;
  pushSucceeded: number;
  pushFailed: number;
  pushGone: number;
}

export class RealtimeService {
  /**
   * Deliver one notification to one user via all channels.
   * Marks pushed_at / push_failed_at in the DB based on the outcome.
   */
  async deliver(notification: DeliverableNotification): Promise<DeliverResult> {
    // 1. Socket.IO — live update
    emitToUser(notification.userId, 'notification:new', {
      id: notification.id,
      kind: notification.kind,
      title: notification.title,
      body: notification.body,
      metadata: notification.metadata,
      createdAt: notification.createdAt.toISOString(),
    });

    // 2. Web Push — fan out to all the user's active subscriptions
    const subs = await notificationsRepository.listActiveSubscriptions(
      notification.userId,
    );

    let ok = 0;
    let failed = 0;
    let gone = 0;

    for (const sub of subs) {
      const result = await sendWebPush(
        {
          endpoint: sub.endpoint,
          p256dh: sub.p256dh,
          auth: sub.auth,
        },
        {
          title: notification.title,
          body: notification.body,
          url: '/notifications',
          metadata: notification.metadata,
        },
      );

      if (result.ok) {
        ok++;
        await notificationsRepository.touchSubscription(sub.id);
      } else {
        failed++;
        if (result.gone) {
          gone++;
          await notificationsRepository.revokeSubscription(sub.id);
        }
      }
    }

    // 3. Update the notification row's push tracking
    if (subs.length > 0) {
      if (ok > 0 && failed === 0) {
        await notificationsRepository.markPushed(notification.id);
      } else if (ok === 0 && failed > 0) {
        await notificationsRepository.markPushFailed(
          notification.id,
          `all ${failed} pushes failed`,
        );
      }
    }

    logger.debug(
      {
        notificationId: notification.id,
        userId: notification.userId,
        kind: notification.kind,
        subs: subs.length,
        pushOk: ok,
        pushFailed: failed,
        pushGone: gone,
      },
      'Notification delivered',
    );

    return {
      socketEmitted: true,
      pushAttempted: subs.length,
      pushSucceeded: ok,
      pushFailed: failed,
      pushGone: gone,
    };
  }
}

export const realtimeService = new RealtimeService();