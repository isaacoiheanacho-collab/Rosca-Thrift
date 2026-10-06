/**
 * Tenants routes (Phase 1.4a — read-only + status change).
 *
 * Saver:
 *   GET /api/tenants/me                 - my current tenant + members
 *
 * Branch Admin:
 *   GET   /api/branch-admin/tenants                          - list tenants in my branch
 *   GET   /api/branch-admin/tenants/:id                      - view one
 *   PATCH /api/branch-admin/tenants/:id/status               - change status
 *
 * Super Admin:
 *   GET   /api/super-admin/tenants/by-branch/:branchId       - list tenants in any branch
 *   GET   /api/super-admin/tenants/:id                       - view one
 *   PATCH /api/super-admin/tenants/:id/status                - change status
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { requireAuth, requireSuperAdmin, requireBranchAdmin } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { AppError } from '../../errors';
import { tenantsService, type RequestMeta } from './tenants.service';
import { ListTenantsQuerySchema, UpdateTenantStatusSchema } from './tenants.schemas';

function metaOf(req: Request): RequestMeta {
  return { ipAddress: req.ip, userAgent: req.header('user-agent') ?? undefined };
}

// ---- Saver router ----

export const tenantsRouter = Router();

tenantsRouter.get('/me', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const dto = await tenantsService.getMyTenant(req.user!.sub);
    res.json({ ok: true, data: dto });
  } catch (err) {
    next(err);
  }
});

// ---- Branch Admin router ----

export const branchAdminTenantsRouter = Router();

branchAdminTenantsRouter.use(requireBranchAdmin);

branchAdminTenantsRouter.get(
  '/',
  validate({ query: ListTenantsQuerySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const q = req.query as unknown as z.infer<typeof ListTenantsQuerySchema>;
      const branchId = req.user!.branchId;
      if (!branchId) {
        throw new AppError({
          code: 'AUTH_BRANCH_REQUIRED',
          httpStatus: 403,
          message: 'No branch assigned to this account',
        });
      }
      const result = await tenantsService.listByBranch(branchId, q);
      res.json({ ok: true, data: { ...result, limit: q.limit, offset: q.offset } });
    } catch (err) {
      next(err);
    }
  },
);

branchAdminTenantsRouter.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenant = await tenantsService.getById(String(req.params.id));
    if (tenant.branchId !== req.user!.branchId) {
      throw new AppError({
        code: 'AUTH_BRANCH_SCOPE',
        httpStatus: 403,
        message: 'Not permitted for this branch',
      });
    }
    res.json({ ok: true, data: tenant });
  } catch (err) {
    next(err);
  }
});

branchAdminTenantsRouter.patch(
  '/:id/status',
  validate({ body: UpdateTenantStatusSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenant = await tenantsService.getById(String(req.params.id));
      if (tenant.branchId !== req.user!.branchId) {
        throw new AppError({
          code: 'AUTH_BRANCH_SCOPE',
          httpStatus: 403,
          message: 'Not permitted for this branch',
        });
      }
      const updated = await tenantsService.updateStatus(
        String(req.params.id),
        req.body.status,
        req.user!.sub,
        metaOf(req),
      );
      res.json({ ok: true, data: updated });
    } catch (err) {
      next(err);
    }
  },
);

// ---- Super Admin router ----

export const superAdminTenantsRouter = Router();

superAdminTenantsRouter.use(requireSuperAdmin);

superAdminTenantsRouter.get(
  '/by-branch/:branchId',
  validate({ query: ListTenantsQuerySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const q = req.query as unknown as z.infer<typeof ListTenantsQuerySchema>;
      const result = await tenantsService.listByBranch(String(req.params.branchId), q);
      res.json({ ok: true, data: { ...result, limit: q.limit, offset: q.offset } });
    } catch (err) {
      next(err);
    }
  },
);

superAdminTenantsRouter.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const dto = await tenantsService.getById(String(req.params.id));
    res.json({ ok: true, data: dto });
  } catch (err) {
    next(err);
  }
});

superAdminTenantsRouter.patch(
  '/:id/status',
  validate({ body: UpdateTenantStatusSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const dto = await tenantsService.updateStatus(
        String(req.params.id),
        req.body.status,
        req.user!.sub,
        metaOf(req),
      );
      res.json({ ok: true, data: dto });
    } catch (err) {
      next(err);
    }
  },
);