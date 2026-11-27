import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { pool } from '../../db';
import { AppError } from '../../errors/AppError';
import { requireAuth } from '../auth/auth.middleware';

const router = Router();
const profileSchema = z.object({
  fullName: z.string().trim().min(2).max(160),
  email: z.string().trim().email().max(254).nullable().optional(),
}).strict();
const asyncRoute = (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => { void fn(req, res).catch(next); };

router.get('/me', requireAuth, asyncRoute(async (req, res) => {
  const result = await pool.query(
    `SELECT id, full_name, phone_e164, email, role, phone_verified_at, created_at
     FROM users WHERE id = $1`, [req.auth!.userId],
  );
  if (!result.rowCount) throw new AppError({ code: 'USER_NOT_FOUND', httpStatus: 404, message: 'User account not found' });
  const user = result.rows[0];
  res.json({ ok: true, data: {
    id: user.id, fullName: user.full_name, phone: user.phone_e164, email: user.email,
    role: user.role, phoneVerified: Boolean(user.phone_verified_at), createdAt: user.created_at,
  }});
}));

router.patch('/me', requireAuth, asyncRoute(async (req, res) => {
  const input = profileSchema.parse(req.body);
  const result = await pool.query(
    `UPDATE users SET full_name = $1, email = COALESCE($2, email), updated_at = NOW()
     WHERE id = $3
     RETURNING id, full_name, phone_e164, email, role, phone_verified_at`,
    [input.fullName, input.email ?? null, req.auth!.userId],
  );
  if (!result.rowCount) throw new AppError({ code: 'USER_NOT_FOUND', httpStatus: 404, message: 'User account not found' });
  const user = result.rows[0];
  res.json({ ok: true, data: {
    id: user.id, fullName: user.full_name, phone: user.phone_e164, email: user.email,
    role: user.role, phoneVerified: Boolean(user.phone_verified_at),
  }});
}));

export { router as usersRoutes };
