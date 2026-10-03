/**
 * Users routes — profile management endpoints.
 * All routes require authentication.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { validate } from '../../middleware/validate';
import { requireAuth } from '../../middleware/auth';
import { usersService, type RequestMeta } from './users.service';
import {
  ChangePasswordSchema,
  RequestPhoneChangeSchema,
  UpdateProfileSchema,
  VerifyPhoneChangeSchema,
} from './users.schemas';

const router = Router();

function metaOf(req: Request): RequestMeta {
  return { ipAddress: req.ip, userAgent: req.header('user-agent') ?? undefined };
}

router.use(requireAuth);

router.get('/me', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await usersService.getMe(req.user!.sub);
    res.json({ ok: true, data: user });
  } catch (err) {
    next(err);
  }
});

router.patch(
  '/me',
  validate({ body: UpdateProfileSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = await usersService.updateProfile(req.user!.sub, req.body, metaOf(req));
      res.json({ ok: true, data: user });
    } catch (err) {
      next(err);
    }
  },
);

router.patch(
  '/me/password',
  validate({ body: ChangePasswordSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await usersService.changePassword(req.user!.sub, req.body, metaOf(req));
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  },
);

router.patch(
  '/me/phone/request',
  validate({ body: RequestPhoneChangeSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await usersService.requestPhoneChange(req.user!.sub, req.body, metaOf(req));
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  },
);

router.patch(
  '/me/phone/verify',
  validate({ body: VerifyPhoneChangeSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await usersService.verifyPhoneChange(req.user!.sub, req.body, metaOf(req));
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  },
);

export default router;