/**
 * Users routes — profile management, phone change, consent management.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { validate } from '../../middleware/validate';
import { requireAuth } from '../../middleware/auth';
import { AppError } from '../../errors';
import { usersService, type RequestMeta } from './users.service';
import {
  ChangePasswordSchema,
  RequestPhoneChangeSchema,
  UpdateProfileSchema,
  VerifyPhoneChangeSchema,
  WithdrawConsentSchema,
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

// ─────────────────────────────────────────────────────────────
// Consent management
// ─────────────────────────────────────────────────────────────

/** Latest consent per type (accepted + withdrawn). */
router.get('/me/consent', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const consents = await usersService.getMyConsents(req.user!.sub);
    res.json({ ok: true, data: consents });
  } catch (err) {
    next(err);
  }
});

/** Full history — every acceptance and withdrawal event. */
router.get(
  '/me/consent/history',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const history = await usersService.getMyConsentHistory(req.user!.sub);
      res.json({ ok: true, data: history });
    } catch (err) {
      next(err);
    }
  },
);

/** Precondition check — can this user withdraw right now? */
router.get(
  '/me/consent/can-withdraw',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await usersService.canWithdrawConsent(req.user!.sub);
      res.json({ ok: true, data: result });
    } catch (err) {
      next(err);
    }
  },
);

/** Withdraw a consent. Fails with 403 if user is inside an active tenure. */
router.post(
  '/me/consent/withdraw',
  validate({ body: WithdrawConsentSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const dto = await usersService.withdrawConsent(
        req.user!.sub,
        req.body.consentType,
        metaOf(req),
      );
      res.json({ ok: true, data: dto });
    } catch (err) {
      next(err);
    }
  },
);

void AppError;

export default router;