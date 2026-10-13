/**
 * Notifications routes.
 *
 * All routes require auth and operate on the caller's own notifications.
 *
 *   GET    /api/notifications                       - list my feed
 *   GET    /api/notifications/unread-count          - bell badge number
 *   POST   /api/notifications/:id/read              - mark one read
 *   POST   /api/notifications/read-all              - mark all read
 *   GET    /api/notifications/vapid-public-key      - frontend fetches to subscribe
 *   POST   /api/notifications/push/subscribe        - register browser push subscription
 *   POST   /api/notifications/push/unsubscribe      - revoke a subscription
 *   GET    /api/notifications/push/subscriptions    - list my subscriptions
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { requireAuth } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { AppError } from '../../errors';
import { notificationsService } from './notifications.service';
import { notificationsRepository } from './notifications.repository';
import { getVapidPublicKey } from '../../utils/web-push';
import {
  ListNotificationsQuerySchema,
  NotificationIdParamSchema,
  PushSubscribeSchema,
  PushUnsubscribeSchema,
} from './notifications.schemas';

const router = Router();
router.use(requireAuth);

router.get(
  '/',
  validate({ query: ListNotificationsQuerySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const q = req.query as unknown as {
        limit: number;
        offset: number;
        unreadOnly: boolean;
      };
      const result = await notificationsService.listMyNotifications(req.user!.sub, q);
      res.json({
        ok: true,
        data: {
          notifications: result.notifications.map((n) => ({
            id: n.id,
            kind: n.kind,
            title: n.title,
            body: n.body,
            metadata: n.metadata,
            readAt: n.read_at?.toISOString() ?? null,
            createdAt: n.created_at.toISOString(),
          })),
          total: result.total,
          unread: result.unread,
          limit: q.limit,
          offset: q.offset,
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

router.get(
  '/unread-count',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const count = await notificationsService.getUnreadCount(req.user!.sub);
      res.json({ ok: true, data: { count } });
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  '/read-all',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const count = await notificationsService.markAllRead(req.user!.sub);
      res.json({ ok: true, data: { marked: count } });
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  '/:id/read',
  validate({ params: NotificationIdParamSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const updated = await notificationsService.markRead(
        String(req.params.id),
        req.user!.sub,
      );
      if (!updated) {
        throw new AppError({
          code: 'NOTIFICATION_NOT_FOUND',
          httpStatus: 404,
          message: 'Notification not found',
        });
      }
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  },
);

// ---- Push subscription management ----

router.get(
  '/vapid-public-key',
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const key = getVapidPublicKey();
      if (!key) {
        throw new AppError({
          code: 'PUSH_NOT_CONFIGURED',
          httpStatus: 503,
          message: 'Web Push is not configured on this server',
        });
      }
      res.json({ ok: true, data: { publicKey: key } });
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  '/push/subscribe',
  validate({ body: PushSubscribeSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const sub = await notificationsRepository.upsertSubscription({
        userId: req.user!.sub,
        endpoint: req.body.endpoint,
        p256dh: req.body.keys.p256dh,
        auth: req.body.keys.auth,
        userAgent: req.header('user-agent') ?? null,
      });
      res.status(201).json({ ok: true, data: { id: sub.id } });
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  '/push/unsubscribe',
  validate({ body: PushUnsubscribeSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await notificationsRepository.revokeByEndpoint(req.body.endpoint, req.user!.sub);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  },
);

router.get(
  '/push/subscriptions',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const subs = await notificationsRepository.listUserSubscriptions(req.user!.sub);
      res.json({
        ok: true,
        data: subs.map((s) => ({
          id: s.id,
          userAgent: s.user_agent,
          createdAt: s.created_at.toISOString(),
          lastUsedAt: s.last_used_at?.toISOString() ?? null,
        })),
      });
    } catch (err) {
      next(err);
    }
  },
);

export default router;