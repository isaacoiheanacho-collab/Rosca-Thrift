/**
 * Payouts routes.
 *
 * Branch admin:
 *   GET  /api/branch-admin/payouts                    - list own branch payouts
 *   GET  /api/branch-admin/payouts/:id                - view one
 *   POST /api/branch-admin/payouts/fees/:id/receipt   - upload fee receipt
 *   POST /api/branch-admin/payouts/:id/receipt        - upload payout receipt
 *   POST /api/branch-admin/payouts/:id/confirm        - mark payout done
 *   POST /api/branch-admin/payouts/:id/fail           - mark payout failed
 *   POST /api/branch-admin/payouts/:id/retry          - issue a retry
 *   GET  /api/branch-admin/payouts/failed             - list failed for this branch
 *
 * Super admin:
 *   GET  /api/super-admin/payouts/fees/pending        - queue of fee receipts
 *   POST /api/super-admin/payouts/fees/:id/confirm    - confirm fee received
 *   POST /api/super-admin/payouts/fees/:id/reject     - reject fee receipt
 *   GET  /api/super-admin/payouts/:id                 - view any payout
 *   POST /api/super-admin/payouts/:id/fail            - fail any payout
 *   POST /api/super-admin/payouts/:id/retry           - retry any failed payout
 *   GET  /api/super-admin/payouts/failed              - queue of failed payouts
 *
 * Saver (tenant-scoped):
 *   GET /api/tenants/me/payout/current                 - current cycle's payout
 *   GET /api/tenants/me/payouts                        - all payouts for tenant
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import { requireAuth, requireBranchAdmin, requireSuperAdmin } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { AppError } from '../../errors';
import { payoutsService, type RequestMeta } from './payouts.service';
import { tenantsRepository } from '../tenants/tenants.repository';
import {
  ConfirmFeeSchema,
  ConfirmPayoutQuerySchema,
  FailPayoutSchema,
  FeeIntentIdParamSchema,
  ListFailedQuerySchema,
  ListFeesQuerySchema,
  ListPayoutsQuerySchema,
  PayoutIdParamSchema,
  RejectFeeSchema,
  UploadFeeReceiptSchema,
  UploadPayoutReceiptSchema,
} from './payouts.schemas';

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

/**
 * Resolve branch scope for a route that strictly requires it (list, upload,
 * confirm fee). Super admin must supply branchId via query/body/params.
 */
function resolveBranchScope(req: Request): string {
  const user = req.user!;

  if (user.role === 'BRANCH_ADMIN') {
    if (!user.branchId) {
      throw new AppError({
        code: 'AUTH_BRANCH_REQUIRED',
        httpStatus: 403,
        message: 'No branch assigned to this account',
      });
    }
    return user.branchId;
  }

  if (user.role === 'SUPER_ADMIN') {
    const fromQuery = String((req.query as Record<string, unknown>).branchId ?? '');
    const fromBody = String((req.body as Record<string, unknown>)?.branchId ?? '');
    const fromParams = String((req.params as Record<string, unknown>)?.branchId ?? '');
    const branchId = fromQuery || fromBody || fromParams;
    if (!branchId) {
      throw new AppError({
        code: 'AUTH_BRANCH_REQUIRED',
        httpStatus: 400,
        message: 'Super admin must supply branchId (query, body, or params)',
      });
    }
    return branchId;
  }

  throw new AppError({ code: 'AUTH_FORBIDDEN', httpStatus: 403, message: 'Not permitted' });
}

/**
 * Resolve optional branch scope for actions on a specific resource ID.
 * Returns:
 *   - branch admin → their own branchId (service validates resource matches)
 *   - super admin  → null (service skips branch validation)
 */
function resolveBranchScopeOptional(req: Request): string | null {
  const user = req.user!;
  if (user.role === 'BRANCH_ADMIN') {
    if (!user.branchId) {
      throw new AppError({
        code: 'AUTH_BRANCH_REQUIRED',
        httpStatus: 403,
        message: 'No branch assigned to this account',
      });
    }
    return user.branchId;
  }
  // SUPER_ADMIN → no restriction
  return null;
}

// ---- Branch admin router ----

export const branchAdminPayoutsRouter = Router();

branchAdminPayoutsRouter.use(requireBranchAdmin);

branchAdminPayoutsRouter.get(
  '/',
  validate({ query: ListPayoutsQuerySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const q = req.query as unknown as {
        limit: number;
        offset: number;
        state?: 'PENDING' | 'FEE_PAID' | 'RECEIPT_UPLOADED' | 'CONFIRMED' | 'FAILED';
        branchId?: string;
      };
      const branchId = resolveBranchScope(req);
      const result = await payoutsService.listPayoutsByBranch(branchId, {
        limit: q.limit,
        offset: q.offset,
        state: q.state,
      });
      res.json({ ok: true, data: { ...result, limit: q.limit, offset: q.offset } });
    } catch (err) {
      next(err);
    }
  },
);

branchAdminPayoutsRouter.get(
  '/failed',
  validate({ query: ListFailedQuerySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const q = req.query as unknown as { limit: number; offset: number };
      const branchId = resolveBranchScope(req);
      const result = await payoutsService.listPayoutsByBranch(branchId, {
        limit: q.limit,
        offset: q.offset,
        state: 'FAILED',
      });
      res.json({ ok: true, data: { ...result, limit: q.limit, offset: q.offset } });
    } catch (err) {
      next(err);
    }
  },
);

branchAdminPayoutsRouter.get(
  '/:id',
  validate({ params: PayoutIdParamSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const payout = await payoutsService.getPayoutById(String(req.params.id));
      if (req.user!.role === 'BRANCH_ADMIN' && payout.branchId !== req.user!.branchId) {
        throw new AppError({ code: 'AUTH_BRANCH_SCOPE', httpStatus: 403, message: 'Not permitted' });
      }
      res.json({ ok: true, data: payout });
    } catch (err) {
      next(err);
    }
  },
);

branchAdminPayoutsRouter.post(
  '/fees/:id/receipt',
  upload.single('receipt'),
  validate({ params: FeeIntentIdParamSchema, body: UploadFeeReceiptSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.file) {
        throw new AppError({ code: 'RECEIPT_NO_FILE', httpStatus: 400, message: 'Receipt is required' });
      }
      const branchId = resolveBranchScope(req);
      const claimedAmount = BigInt(req.body.claimedAmount);
      const dto = await payoutsService.uploadFeeReceipt(
        String(req.params.id),
        branchId,
        {
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
        req.user!.sub,
        metaOf(req),
      );
      res.status(201).json({ ok: true, data: dto });
    } catch (err) {
      next(err);
    }
  },
);

branchAdminPayoutsRouter.post(
  '/:id/receipt',
  upload.single('receipt'),
  validate({ params: PayoutIdParamSchema, body: UploadPayoutReceiptSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.file) {
        throw new AppError({ code: 'RECEIPT_NO_FILE', httpStatus: 400, message: 'Receipt is required' });
      }
      const branchId = resolveBranchScope(req);
      const claimedAmount = BigInt(req.body.claimedAmount);
      const dto = await payoutsService.uploadPayoutReceipt(
        String(req.params.id),
        branchId,
        {
          claimedAmount,
          claimedReference: req.body.claimedReference,
          claimedRecipientName: req.body.claimedRecipientName,
          claimedNote: req.body.claimedNote,
        },
        {
          buffer: req.file.buffer,
          mimetype: req.file.mimetype,
          originalname: req.file.originalname,
          size: req.file.size,
        },
        req.user!.sub,
        metaOf(req),
      );
      res.status(201).json({ ok: true, data: dto });
    } catch (err) {
      next(err);
    }
  },
);

branchAdminPayoutsRouter.post(
  '/:id/confirm',
  validate({ params: PayoutIdParamSchema, query: ConfirmPayoutQuerySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const branchId = resolveBranchScope(req);
      const dto = await payoutsService.confirmPayout(
        String(req.params.id),
        branchId,
        req.user!.sub,
        metaOf(req),
      );
      res.json({ ok: true, data: dto });
    } catch (err) {
      next(err);
    }
  },
);

branchAdminPayoutsRouter.post(
  '/:id/fail',
  validate({ params: PayoutIdParamSchema, body: FailPayoutSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Optional branch scope — super admin passes null, service handles it.
      const branchScope = resolveBranchScopeOptional(req);
      const dto = await payoutsService.markPayoutFailed(
        String(req.params.id),
        branchScope,
        req.body.reason,
        req.body.notes ?? null,
        req.user!.sub,
        metaOf(req),
      );
      res.json({ ok: true, data: dto });
    } catch (err) {
      next(err);
    }
  },
);

branchAdminPayoutsRouter.post(
  '/:id/retry',
  validate({ params: PayoutIdParamSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Optional branch scope — super admin passes null, service handles it.
      const branchScope = resolveBranchScopeOptional(req);
      const dto = await payoutsService.retryPayout(
        String(req.params.id),
        branchScope,
        req.user!.sub,
        metaOf(req),
      );
      res.status(201).json({ ok: true, data: dto });
    } catch (err) {
      next(err);
    }
  },
);

// ---- Super admin router ----

export const superAdminPayoutsRouter = Router();

superAdminPayoutsRouter.use(requireSuperAdmin);

superAdminPayoutsRouter.get(
  '/fees/pending',
  validate({ query: ListFeesQuerySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const q = req.query as unknown as { limit: number; offset: number };
      const result = await payoutsService.listPendingFeeIntents(q);
      res.json({ ok: true, data: { ...result, limit: q.limit, offset: q.offset } });
    } catch (err) {
      next(err);
    }
  },
);

superAdminPayoutsRouter.get(
  '/failed',
  validate({ query: ListFailedQuerySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const q = req.query as unknown as {
        limit: number;
        offset: number;
        onlyUnretried: boolean;
      };
      const result = await payoutsService.listFailedPayouts({
        limit: q.limit,
        offset: q.offset,
        onlyUnretried: q.onlyUnretried,
      });
      res.json({ ok: true, data: { ...result, limit: q.limit, offset: q.offset } });
    } catch (err) {
      next(err);
    }
  },
);

superAdminPayoutsRouter.get(
  '/fees/:id',
  validate({ params: FeeIntentIdParamSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const dto = await payoutsService.getFeeIntentById(String(req.params.id));
      res.json({ ok: true, data: dto });
    } catch (err) {
      next(err);
    }
  },
);

superAdminPayoutsRouter.post(
  '/fees/:id/confirm',
  validate({ params: FeeIntentIdParamSchema, body: ConfirmFeeSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await payoutsService.confirmFee(
        String(req.params.id),
        req.user!.sub,
        req.body.adminNote ?? null,
        metaOf(req),
      );
      res.json({ ok: true, data: result });
    } catch (err) {
      next(err);
    }
  },
);

superAdminPayoutsRouter.post(
  '/fees/:id/reject',
  validate({ params: FeeIntentIdParamSchema, body: RejectFeeSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const dto = await payoutsService.rejectFee(
        String(req.params.id),
        req.user!.sub,
        req.body.reason,
        metaOf(req),
      );
      res.json({ ok: true, data: dto });
    } catch (err) {
      next(err);
    }
  },
);

superAdminPayoutsRouter.post(
  '/:id/fail',
  validate({ params: PayoutIdParamSchema, body: FailPayoutSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const dto = await payoutsService.markPayoutFailed(
        String(req.params.id),
        null, // super admin — no branch restriction
        req.body.reason,
        req.body.notes ?? null,
        req.user!.sub,
        metaOf(req),
      );
      res.json({ ok: true, data: dto });
    } catch (err) {
      next(err);
    }
  },
);

superAdminPayoutsRouter.post(
  '/:id/retry',
  validate({ params: PayoutIdParamSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const dto = await payoutsService.retryPayout(
        String(req.params.id),
        null,
        req.user!.sub,
        metaOf(req),
      );
      res.status(201).json({ ok: true, data: dto });
    } catch (err) {
      next(err);
    }
  },
);

superAdminPayoutsRouter.get(
  '/:id',
  validate({ params: PayoutIdParamSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const dto = await payoutsService.getPayoutById(String(req.params.id));
      res.json({ ok: true, data: dto });
    } catch (err) {
      next(err);
    }
  },
);

// ---- Tenant-scoped payout visibility (saver) ----

export const tenantPayoutVisibilityRouter = Router();

tenantPayoutVisibilityRouter.use(requireAuth);

tenantPayoutVisibilityRouter.get(
  '/payout/current',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const membership = await tenantsRepository.findMembershipByUser(req.user!.sub);
      if (!membership) {
        throw new AppError({ code: 'AUTH_TENANT_SCOPE', httpStatus: 403, message: 'Not in a tenant' });
      }
      const tenant = await tenantsRepository.findById(membership.tenant_id);
      if (!tenant) throw new AppError({ code: 'NOT_FOUND', httpStatus: 404, message: 'Tenant not found' });
      const all = await payoutsService.listPayoutsByTenant(tenant.id);
      const current = all.find(
        (p) => p.tenure === tenant.current_tenure && p.cycle === tenant.current_cycle,
      );
      res.json({ ok: true, data: current ?? null });
    } catch (err) {
      next(err);
    }
  },
);

tenantPayoutVisibilityRouter.get(
  '/payouts',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const membership = await tenantsRepository.findMembershipByUser(req.user!.sub);
      if (!membership) {
        throw new AppError({ code: 'AUTH_TENANT_SCOPE', httpStatus: 403, message: 'Not in a tenant' });
      }
      const list = await payoutsService.listPayoutsByTenant(membership.tenant_id);
      res.json({ ok: true, data: list });
    } catch (err) {
      next(err);
    }
  },
);

tenantPayoutVisibilityRouter.get(
  '/payouts/me',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const list = await payoutsService.listPayoutsByRecipient(req.user!.sub);
      res.json({ ok: true, data: list });
    } catch (err) {
      next(err);
    }
  },
);