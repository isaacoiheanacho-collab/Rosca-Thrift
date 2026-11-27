import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { pool } from '../../db';
import { AppError } from '../../errors/AppError';
import { requireAuth } from '../auth/auth.middleware';

const router = Router();
const asyncRoute = (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => { void fn(req, res).catch(next); };

router.get('/', requireAuth, asyncRoute(async (req, res) => {
  const limit = z.coerce.number().int().min(1).max(100).default(50).parse(req.query.limit);
  const unreadOnly = req.query.unreadOnly === 'true';
  const result = await pool.query(
    `SELECT id, tenant_id, channel, notification_type, payload, status,
            scheduled_at, sent_at, read_at, created_at
     FROM notifications
     WHERE user_id = $1 AND status = 'sent' AND ($2::boolean = FALSE OR read_at IS NULL)
     ORDER BY created_at DESC LIMIT $3`,
    [req.auth!.userId, unreadOnly, limit],
  );
  res.json({ ok: true, data: result.rows });
}));

router.patch('/:notificationId/read', requireAuth, asyncRoute(async (req, res) => {
  const notificationId = z.string().uuid().parse(req.params.notificationId);
  const result = await pool.query(
    `UPDATE notifications SET read_at = COALESCE(read_at, NOW())
     WHERE id = $1 AND user_id = $2 AND status = 'sent'
     RETURNING id, read_at`,
    [notificationId, req.auth!.userId],
  );
  if (!result.rowCount) throw new AppError({ code: 'NOTIFICATION_NOT_FOUND', httpStatus: 404, message: 'Notification not found' });
  res.json({ ok: true, data: result.rows[0] });
}));

export { router as notificationsRoutes };
