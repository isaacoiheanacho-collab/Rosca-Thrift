/**
 * Session management endpoints.
 *
 *   GET    /api/auth/sessions       - list active sessions
 *   DELETE /api/auth/sessions       - revoke ALL sessions (logout everywhere)
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { pool } from '../../db';
import { requireAuth } from '../../middleware/auth';
import { authRepository } from './auth.repository';
import { record } from '../audit/audit.service';
import { logger } from '../../logger';

const router = Router();

router.use(requireAuth);

interface SessionRow {
  id: string;
  created_at: Date;
  expires_at: Date;
  user_agent: string | null;
  ip_address: string | null;
}

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await pool.query<SessionRow>(
      `SELECT id, created_at, expires_at, user_agent, ip_address
       FROM refresh_tokens
       WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > NOW()
       ORDER BY created_at DESC`,
      [req.user!.sub],
    );

    res.json({
      ok: true,
      data: result.rows.map((r) => ({
        id: r.id,
        createdAt: r.created_at.toISOString(),
        expiresAt: r.expires_at.toISOString(),
        userAgent: r.user_agent,
        ipAddress: r.ip_address,
      })),
    });
  } catch (err) {
    next(err);
  }
});

router.delete('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await authRepository.revokeAllUserTokens(req.user!.sub);

    await record({
      actorId: req.user!.sub,
      action: 'LOGOUT_ALL',
      entityType: 'user',
      entityId: req.user!.sub,
      ipAddress: req.ip,
      userAgent: req.header('user-agent') ?? undefined,
    });

    logger.info({ userId: req.user!.sub }, 'All sessions revoked');

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;