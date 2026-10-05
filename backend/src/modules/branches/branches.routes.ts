/**
 * Branch routes.
 *
 * Public:
 *   GET  /api/branches/:slug              - lookup branch by slug (used by join page)
 *
 * Super Admin:
 *   POST   /api/super-admin/branches             - create
 *   GET    /api/super-admin/branches             - list
 *   GET    /api/super-admin/branches/:id         - view one
 *   PATCH  /api/super-admin/branches/:id         - update details/status
 *
 * Branch Admin (or Super Admin):
 *   PATCH  /api/branches/:id/trust-account       - set trust account details
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { requireAuth, requireSuperAdmin, requireBranchAdmin } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { branchesService, type RequestMeta } from './branches.service';
import {
  CreateBranchSchema,
  UpdateBranchSchema,
  UpdateTrustAccountSchema,
} from './branches.schemas';

function metaOf(req: Request): RequestMeta {
  return { ipAddress: req.ip, userAgent: req.header('user-agent') ?? undefined };
}

// ---- Public routes ----

export const publicBranchesRouter = Router();

publicBranchesRouter.get('/:slug', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const branch = await branchesService.getBySlug(String(req.params.slug));
    res.json({ ok: true, data: branch });
  } catch (err) {
    next(err);
  }
});

// ---- Super Admin routes ----

const ListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  status: z.enum(['ACTIVE', 'SUSPENDED', 'ARCHIVED']).optional(),
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
      res.json({
        ok: true,
        data: { ...result, limit: q.limit, offset: q.offset },
      });
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

// ---- Trust account (Branch Admin or Super Admin) ----

export const branchTrustAccountRouter = Router();

branchTrustAccountRouter.patch(
  '/:id/trust-account',
  requireAuth,
  validate({ body: UpdateTrustAccountSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const branchId = String(req.params.id);
      const user = req.user!;

      // Access control: Super Admin can edit any branch; Branch Admin only their own
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

void requireBranchAdmin;