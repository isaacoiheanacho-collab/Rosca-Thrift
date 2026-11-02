/**
 * Users routes — profile management, phone change, consent management.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { validate } from '../../middleware/validate';
import { requireAuth, requireSuperAdmin } from '../../middleware/auth';
import { AppError } from '../../errors';
import { pool } from '../../db';
import { getPresignedDownloadUrl } from '../../utils/s3';
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

// ─────────────────────────────────────────────────────────────
// Super Admin: All Savers
// ─────────────────────────────────────────────────────────────

router.get(
  '/admin/savers/:id',
  requireSuperAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = String(req.params.id);
      
      const result = await pool.query(`
        SELECT 
          u.id, 
          u.full_name, 
          u.phone, 
          u.email,
          u.created_at,
          u.status AS user_status,
          b.name AS branch_name,
          tm.slot_number,
          t.name AS tenant_name,
          k.status AS kyc_status,
          k.legal_name,
          k.account_name,
          k.bank_name,
          k.sort_code,
          k.account_number,
          k.selfie_object_key
        FROM users u
        LEFT JOIN branches b ON b.id = u.branch_id
        LEFT JOIN tenant_memberships tm ON tm.user_id = u.id AND tm.status != 'REMOVED'
        LEFT JOIN tenants t ON t.id = tm.tenant_id
        LEFT JOIN kyc_submissions k ON k.user_id = u.id
        WHERE u.id = $1 AND u.role = 'SAVER'
        LIMIT 1
      `, [userId]);
      
      const saver = result.rows[0];
      if (!saver) {
        throw new AppError({ code: 'NOT_FOUND', httpStatus: 404, message: 'Saver not found' });
      }

      // Generate presigned URL for the profile photo if it exists
      let selfieUrl = null;
      if (saver.selfie_object_key) {
        selfieUrl = await getPresignedDownloadUrl(saver.selfie_object_key, 300);
      }

      res.json({ ok: true, data: { ...saver, selfieUrl } });
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  '/admin/savers',
  requireSuperAdmin,
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await pool.query(`
        SELECT 
          u.id, 
          u.full_name, 
          u.phone, 
          u.email,
          u.created_at,
          b.name AS branch_name,
          tm.slot_number,
          t.name AS tenant_name,
          COALESCE(k.status, 'NOT_SUBMITTED') AS kyc_status,
          k.selfie_object_key
        FROM users u
        LEFT JOIN branches b ON b.id = u.branch_id
        LEFT JOIN tenant_memberships tm ON tm.user_id = u.id AND tm.status != 'REMOVED'
        LEFT JOIN tenants t ON t.id = tm.tenant_id
        LEFT JOIN kyc_submissions k ON k.user_id = u.id
        WHERE u.role = 'SAVER'
        ORDER BY u.created_at DESC
      `);
      
      res.json({ ok: true, data: result.rows });
    } catch (err) {
      next(err);
    }
  }
);

void AppError;

export default router;