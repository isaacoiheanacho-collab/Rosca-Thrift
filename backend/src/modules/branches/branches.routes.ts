/**
 * Branch routes.
 *
 * Public:
 *   POST  /api/branches/onboard             - self-serve branch onboarding
 *   GET   /api/branches/id/:id              - public branch info by ID
 *   GET   /api/branches/:slug/status        - public branch status (always available)
 *   GET   /api/branches/:slug/public        - public branch info + content
 *   GET   /api/branches/:slug               - legacy full lookup
 *
 * Super Admin:
 *   POST   /api/super-admin/branches                       - create (manual)
 *   GET    /api/super-admin/branches                       - list
 *   GET    /api/super-admin/branches/:id                   - view one
 *   PATCH  /api/super-admin/branches/:id                   - update
 *   PATCH  /api/super-admin/branches/:id/branding          - update branding
 *   PATCH  /api/super-admin/branches/:id/onboarding/approve
 *   PATCH  /api/super-admin/branches/:id/onboarding/reject
 *
 * Branch Admin:
 *   PATCH  /api/branch-admin/branches/:id/content          - edit own content
 *   PATCH  /api/branches/:id/trust-account                 - set trust account
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { requireAuth, requireSuperAdmin, requireBranchAdmin } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { AppError } from '../../errors';
import { branchesService, type RequestMeta } from './branches.service';
import {
  CreateBranchSchema,
  OnboardBranchSchema,
  RejectOnboardingSchema,
  UpdateBranchContentSchema,
  UpdateBranchSchema,
  UpdateBrandingSchema,
  UpdateTrustAccountSchema,
} from './branches.schemas';

function metaOf(req: Request): RequestMeta {
  return { ipAddress: req.ip, userAgent: req.header('user-agent') ?? undefined };
}

// ─────────────────────────────────────────────────────────────
// Public routes
// ─────────────────────────────────────────────────────────────

export const publicBranchesRouter = Router();

/**
 * Self-serve onboarding — creates a PENDING branch + a BRANCH_ADMIN user.
 * No auth required. The admin's phone still needs OTP verification before
 * they can log in.
 */
publicBranchesRouter.post(
  '/onboard',
  validate({ body: OnboardBranchSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await branchesService.onboard(req.body, metaOf(req));
      res.status(201).json({ ok: true, data: result });
    } catch (err) {
      next(err);
    }
  },
);

/** Public branch read by ID — used by dashboards to resolve the branch name without knowing the slug. */
publicBranchesRouter.get(
  '/id/:id',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const branch = await branchesService.getById(String(req.params.id));
      res.json({ ok: true, data: branch });
    } catch (err) {
      next(err);
    }
  },
);

/** Public branch status check — always available, used by the pending-approval page. */
publicBranchesRouter.get(
  '/:slug/status',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const status = await branchesService.getPublicStatusBySlug(String(req.params.slug));
      res.json({ ok: true, data: status });
    } catch (err) {
      next(err);
    }
  },
);

/** Public branch read — used by the branch landing page. */
publicBranchesRouter.get(
  '/:slug/public',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const branch = await branchesService.getPublicBySlug(String(req.params.slug));
      res.json({ ok: true, data: branch });
    } catch (err) {
      next(err);
    }
  },
);

/** Legacy full lookup. */
publicBranchesRouter.get('/:slug', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const branch = await branchesService.getBySlug(String(req.params.slug));
    res.json({ ok: true, data: branch });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────
// Super admin routes
// ─────────────────────────────────────────────────────────────

const ListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  status: z.enum(['ACTIVE', 'SUSPENDED', 'ARCHIVED']).optional(),
  onboardingStatus: z.enum(['PENDING', 'APPROVED', 'REJECTED']).optional(),
});

export const superAdminBranchesRouter = Router();
superAdminBranchesRouter.use(requireSuperAdmin);

superAdminBranchesRouter.post(
  '/',
  validate({ body: CreateBranchSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const branch = await branchesService.create(req.body, req.user!.sub, metaOf(req));
      res.status(201).json({ ok: true, data: branch });
    } catch (err) {
      next(err);
    }
  },
);

superAdminBranchesRouter.get(
  '/',
  validate({ query: ListQuerySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const q = req.query as unknown as z.infer<typeof ListQuerySchema>;
      const result = await branchesService.list(q);
      res.json({ ok: true, data: { ...result, limit: q.limit, offset: q.offset } });
    } catch (err) {
      next(err);
    }
  },
);

superAdminBranchesRouter.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const branch = await branchesService.getById(String(req.params.id));
    res.json({ ok: true, data: branch });
  } catch (err) {
    next(err);
  }
});

superAdminBranchesRouter.patch(
  '/:id',
  validate({ body: UpdateBranchSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const branch = await branchesService.update(
        String(req.params.id),
        req.body,
        req.user!.sub,
        metaOf(req),
      );
      res.json({ ok: true, data: branch });
    } catch (err) {
      next(err);
    }
  },
);

superAdminBranchesRouter.patch(
  '/:id/branding',
  validate({ body: UpdateBrandingSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const branch = await branchesService.updateBranding(
        String(req.params.id),
        req.body,
        req.user!.sub,
        metaOf(req),
      );
      res.json({ ok: true, data: branch });
    } catch (err) {
      next(err);
    }
  },
);

superAdminBranchesRouter.patch(
  '/:id/onboarding/approve',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const branch = await branchesService.approveOnboarding(
        String(req.params.id),
        req.user!.sub,
        metaOf(req),
      );
      res.json({ ok: true, data: branch });
    } catch (err) {
      next(err);
    }
  },
);

superAdminBranchesRouter.patch(
  '/:id/onboarding/reject',
  validate({ body: RejectOnboardingSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const branch = await branchesService.rejectOnboarding(
        String(req.params.id),
        req.body.reason,
        req.user!.sub,
        metaOf(req),
      );
      res.json({ ok: true, data: branch });
    } catch (err) {
      next(err);
    }
  },
);

// ─────────────────────────────────────────────────────────────
// Branch admin routes — edit own content
// ─────────────────────────────────────────────────────────────

export const branchAdminBranchesRouter = Router();
branchAdminBranchesRouter.use(requireBranchAdmin);

branchAdminBranchesRouter.patch(
  '/:id/content',
  validate({ body: UpdateBranchContentSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const branchId = String(req.params.id);
      const user = req.user!;
      if (user.role === 'BRANCH_ADMIN' && user.branchId !== branchId) {
        throw new AppError({
          code: 'AUTH_BRANCH_SCOPE',
          httpStatus: 403,
          message: 'You can only edit your own branch content',
        });
      }
      const branch = await branchesService.updateContent(
        branchId,
        req.body,
        user.sub,
        metaOf(req),
      );
      res.json({ ok: true, data: branch });
    } catch (err) {
      next(err);
    }
  },
);

// ─────────────────────────────────────────────────────────────
// Trust account (Branch Admin or Super Admin)
// ─────────────────────────────────────────────────────────────

export const branchTrustAccountRouter = Router();

branchTrustAccountRouter.patch(
  '/:id/trust-account',
  requireAuth,
  validate({ body: UpdateTrustAccountSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const branchId = String(req.params.id);
      const user = req.user!;

      if (user.role === 'BRANCH_ADMIN' && user.branchId !== branchId) {
        res.status(403).json({
          ok: false,
          error: { code: 'AUTH_BRANCH_SCOPE', message: 'You can only manage your own branch' },
        });
        return;
      }
      if (user.role === 'SAVER') {
        res.status(403).json({
          ok: false,
          error: { code: 'AUTH_FORBIDDEN', message: 'Not permitted' },
        });
        return;
      }

      const branch = await branchesService.updateTrustAccount(
        branchId,
        req.body,
        user.sub,
        metaOf(req),
      );
      res.json({ ok: true, data: branch });
    } catch (err) {
      next(err);
    }
  },
);