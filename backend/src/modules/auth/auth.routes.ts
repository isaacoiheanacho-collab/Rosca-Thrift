/**
 * Auth routes.
 *
 * Endpoints:
 *   POST /api/auth/register   — create account, returns tokens
 *   POST /api/auth/login      — authenticate, returns tokens
 *   POST /api/auth/refresh    — rotate refresh token, returns new tokens
 *   POST /api/auth/logout     — revoke the presented refresh token
 *   GET  /api/auth/me         — current user (requires access token)
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { validate } from '../../middleware/validate';
import { requireAuth } from '../../middleware/auth';
import { authService, type RequestMeta } from './auth.service';
import { LoginSchema, RefreshSchema, RegisterSchema } from './auth.schemas';
import { authRepository } from './auth.repository';
import { NotFoundError } from '../../errors';

const router = Router();

function metaOf(req: Request): RequestMeta {
  return {
    ipAddress: req.ip,
    userAgent: req.header('user-agent') ?? undefined,
  };
}

router.post(
  '/register',
  validate({ body: RegisterSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await authService.register(req.body, metaOf(req));
      res.status(201).json({ ok: true, data: result });
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  '/login',
  validate({ body: LoginSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await authService.login(req.body, metaOf(req));
      res.json({ ok: true, data: result });
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  '/refresh',
  validate({ body: RefreshSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await authService.refresh(req.body, metaOf(req));
      res.json({ ok: true, data: result });
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  '/logout',
  validate({ body: RefreshSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await authService.logout(req.body, metaOf(req));
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  },
);

router.get(
  '/me',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = await authRepository.findUserById(req.user!.sub);
      if (!user) throw new NotFoundError('User');
      res.json({
        ok: true,
        data: {
          id: user.id,
          email: user.email,
          phone: user.phone,
          fullName: user.full_name,
          role: user.role,
          status: user.status,
          createdAt: user.created_at.toISOString(),
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

export default router;