/**
 * Auth routes - phone-first.
 *
 * Rate limiting strategy:
 *   - Global: 20 req/min per IP on all /auth/*
 *   - Extra: 10 req/min per IP on /verify-phone and /password/reset
 *   - Sessions sub-router is mounted in server.ts (not here)
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { validate } from '../../middleware/validate';
import { requireAuth } from '../../middleware/auth';
import { authService, type RequestMeta } from './auth.service';
import {
  ForgotPasswordSchema,
  LoginSchema,
  RefreshSchema,
  RegisterSchema,
  ResetPasswordSchema,
  VerifyPhoneSchema,
} from './auth.schemas';
import { authRepository } from './auth.repository';
import { NotFoundError } from '../../errors';
import { env } from '../../config/env';

const router = Router();

function metaOf(req: Request): RequestMeta {
  return { ipAddress: req.ip, userAgent: req.header('user-agent') ?? undefined };
}

const otpVerifyLimiter = rateLimit({
  windowMs: 60_000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (_req: Request, res: Response) => {
    res.status(429).json({
      ok: false,
      error: { code: 'RATE_LIMIT_EXCEEDED', message: 'Too many attempts - wait a minute.' },
    });
  },
  skip: () => env.IS_DEVELOPMENT,
});

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
  '/verify-phone',
  otpVerifyLimiter,
  validate({ body: VerifyPhoneSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await authService.verifyPhone(req.body, metaOf(req));
      res.json({ ok: true, data: result });
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

router.post(
  '/password/forgot',
  validate({ body: ForgotPasswordSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await authService.forgotPassword(req.body, metaOf(req));
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  '/password/reset',
  otpVerifyLimiter,
  validate({ body: ResetPasswordSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await authService.resetPassword(req.body, metaOf(req));
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  },
);

router.get('/me', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await authRepository.findUserById(req.user!.sub);
    if (!user) throw new NotFoundError('User');
    res.json({
      ok: true,
      data: {
        id: user.id,
        phone: user.phone,
        email: user.email,
        fullName: user.full_name,
        role: user.role,
        status: user.status,
        phoneVerified: user.phone_verified_at !== null,
        createdAt: user.created_at.toISOString(),
      },
    });
  } catch (err) {
    next(err);
  }
});

export default router;