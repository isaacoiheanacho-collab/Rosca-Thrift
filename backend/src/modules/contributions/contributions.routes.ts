/**
 * Contributions routes.
 *
 * Saver:
 *   GET  /api/contributions/me/current          - get or create current-cycle intent
 *   GET  /api/contributions/me/intents          - list all my intents
 *   GET  /api/contributions/me/contributions    - list all my confirmed contributions
 *   POST /api/contributions/me/receipt          - upload a receipt for an intent
 *
 * Branch admin (or super admin):
 *   GET   /api/branch-admin/contributions/pending              - pending queue with receipts
 *   POST  /api/branch-admin/contributions/:intentId/confirm    - confirm
 *   POST  /api/branch-admin/contributions/:intentId/reject     - reject
 *   GET   /api/branch-admin/contributions/tenants/:tenantId/cycle - cycle status
 *
 * Tenant-wide visibility (any member of a tenant):
 *   GET /api/tenants/me/contributions   - all 12 members' statuses
 *   GET /api/tenants/me/ledger          - tenant ledger
 *   GET /api/tenants/me/receipts        - receipt gallery
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

// ---- Branch admin / super admin router ----

export const branchAdminContributionsRouter = Router();

branchAdminContributionsRouter.use(requireBranchAdmin);

branchAdminContributionsRouter.get(
  '/pending',
  validate({ query: ListPendingSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const q = req.query as unknown as {
        limit: number;
        offset: number;
        tenantId?: string;
        cycle?: number;
      };
      const user = req.user!;
      // Branch admin → only their branch. Super admin → all branches.
      const branchFilter = user.role === 'BRANCH_ADMIN' ? user.branchId : null;

      const result = await contributionsService.listPendingForAdmin(branchFilter, {
        limit: q.limit,
        offset: q.offset,
      });
      res.json({ ok: true, data: { ...result, limit: q.limit, offset: q.offset } });
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
      if (req.user!.role === 'BRANCH_ADMIN' && tenant.branch_id !== req.user!.branchId) {
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

// ---- Tenant-wide visibility router (any authenticated member) ----

export const tenantVisibilityRouter = Router();

tenantVisibilityRouter.use(requireAuth);

tenantVisibilityRouter.get(
  '/contributions',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const membership = await tenantsRepository.findMembershipByUser(req.user!.sub);
      if (!membership) {
        throw new AppError({
          code: 'AUTH_TENANT_SCOPE',
          httpStatus: 403,
          message: 'You are not a member of any tenant',
        });
      }
      const tenant = await tenantsRepository.findById(membership.tenant_id);
      if (!tenant) {
        throw new AppError({ code: 'NOT_FOUND', httpStatus: 404, message: 'Tenant not found' });
      }
      const members = await contributionsService.listTenantCycleMembers(
        tenant.id,
        tenant.current_tenure,
        tenant.current_cycle,
      );
      res.json({
        ok: true,
        data: {
          tenantId: tenant.id,
          cycle: tenant.current_cycle,
          tenure: tenant.current_tenure,
          members,
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

tenantVisibilityRouter.get('/ledger', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const membership = await tenantsRepository.findMembershipByUser(req.user!.sub);
    if (!membership) {
      throw new AppError({
        code: 'AUTH_TENANT_SCOPE',
        httpStatus: 403,
        message: 'You are not a member of any tenant',
      });
    }
    const entries = await contributionsService.listTenantLedger(membership.tenant_id, 100);
    res.json({ ok: true, data: entries });
  } catch (err) {
    next(err);
  }
});

tenantVisibilityRouter.get('/receipts', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const membership = await tenantsRepository.findMembershipByUser(req.user!.sub);
    if (!membership) {
      throw new AppError({
        code: 'AUTH_TENANT_SCOPE',
        httpStatus: 403,
        message: 'You are not a member of any tenant',
      });
    }
    const receipts = await contributionsService.listTenantReceipts(membership.tenant_id, 100);
    res.json({ ok: true, data: receipts });
  } catch (err) {
    next(err);
  }
});