/**
 * Auth routes - phone-first.
 *
 *   POST /api/auth/register        - create account, sends OTP
 *   POST /api/auth/verify-phone    - confirm OTP, returns tokens
 *   POST /api/auth/login           - phone + password
 *   POST /api/auth/refresh         - rotate refresh token
 *   POST /api/auth/logout          - revoke refresh token
 *   POST /api/auth/password/forgot - send reset OTP
 *   POST /api/auth/password/reset  - consume reset OTP, set new password
 *   GET  /api/auth/me              - current user
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
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

const router = Router();

function metaOf(req: Request): RequestMeta {
  return { ipAddress: req.ip, userAgent: req.header('user-agent') ?? undefined };
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
  '/verify-phone',
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