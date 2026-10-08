/**
 * Contributions routes.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import { requireAuth, requireBranchAdmin } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { AppError } from '../../errors';
import { contributionsService, type RequestMeta } from './contributions.service';
import { tenantsRepository } from '../tenants/tenants.repository';
import {
  ConfirmContributionSchema,
  ListPendingSchema,
  RejectContributionSchema,
  UploadReceiptSchema,
} from './contributions.schemas';

function metaOf(req: Request): RequestMeta {
  return { ipAddress: req.ip, userAgent: req.header('user-agent') ?? undefined };
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = /^image\/(jpeg|png|heic)$/.test(file.mimetype);
    if (!ok) {
      cb(
        new AppError({
          code: 'RECEIPT_BAD_FILE',
          httpStatus: 400,
          message: 'Receipt must be an image (JPEG, PNG, HEIC)',
        }),
      );
      return;
    }
    cb(null, true);
  },
});

// ---- Saver router ----

export const contributionsRouter = Router();

contributionsRouter.get(
  '/me/current',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const dto = await contributionsService.getOrCreateCurrentIntent(req.user!.sub, metaOf(req));
      res.json({ ok: true, data: dto });
    } catch (err) {
      next(err);
    }
  },
);

contributionsRouter.get(
  '/me/intents',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const list = await contributionsService.listMyIntents(req.user!.sub);
      res.json({ ok: true, data: list });
    } catch (err) {
      next(err);
    }
  },
);

contributionsRouter.get(
  '/me/contributions',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const list = await contributionsService.listMyContributions(req.user!.sub);
      res.json({ ok: true, data: list });
    } catch (err) {
      next(err);
    }
  },
);

contributionsRouter.post(
  '/me/receipt',
  requireAuth,
  upload.single('receipt'),
  validate({ body: UploadReceiptSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.file) {
        throw new AppError({
          code: 'RECEIPT_NO_FILE',
          httpStatus: 400,
          message: 'Receipt image is required',
        });
      }

      const claimedAmount = BigInt(req.body.claimedAmount);

      const dto = await contributionsService.uploadReceipt(
        req.user!.sub,
        {
          intentId: req.body.intentId,
          claimedAmount,
          claimedReference: req.body.claimedReference,
          claimedSenderName: req.body.claimedSenderName,
          claimedNote: req.body.claimedNote,
        },
        {
          buffer: req.file.buffer,
          mimetype: req.file.mimetype,
          originalname: req.file.originalname,
          size: req.file.size,
        },
        metaOf(req),
      );

      res.status(201).json({ ok: true, data: dto });
    } catch (err) {
      next(err);
    }
  },
);

// ---- Admin router ----

export const branchAdminContributionsRouter = Router();

branchAdminContributionsRouter.use(requireBranchAdmin);

branchAdminContributionsRouter.get(
  '/pending',
  validate({ query: ListPendingSchema }),
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      res.json({ ok: true, data: { intents: [], limit: 50, offset: 0 } });
    } catch (err) {
      next(err);
    }
  },
);

branchAdminContributionsRouter.post(
  '/:intentId/confirm',
  validate({ body: ConfirmContributionSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const amount = BigInt(req.body.amount);
      const dto = await contributionsService.confirmContribution(
        req.body.intentId,
        amount,
        req.body.adminNote ?? null,
        req.user!.sub,
        metaOf(req),
      );
      res.json({ ok: true, data: dto });
    } catch (err) {
      next(err);
    }
  },
);

branchAdminContributionsRouter.post(
  '/:intentId/reject',
  validate({ body: RejectContributionSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await contributionsService.rejectContribution(
        req.body.intentId,
        req.body.reason,
        req.user!.sub,
        metaOf(req),
      );
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  },
);

branchAdminContributionsRouter.get(
  '/tenants/:tenantId/cycle',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = String(req.params.tenantId);
      const tenant = await tenantsRepository.findById(tenantId);
      if (!tenant) {
        throw new AppError({ code: 'NOT_FOUND', httpStatus: 404, message: 'Tenant not found' });
      }
      if (tenant.branch_id !== req.user!.branchId) {
        throw new AppError({ code: 'AUTH_BRANCH_SCOPE', httpStatus: 403, message: 'Not permitted' });
      }
      const status = await contributionsService.listTenantCycleStatus(
        tenantId,
        tenant.current_tenure,
        tenant.current_cycle,
      );
      res.json({ ok: true, data: status });
    } catch (err) {
      next(err);
    }
  },
);