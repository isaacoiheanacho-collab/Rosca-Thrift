/**
 * Tenure renewal routes.
 *
 * Saver:
 *   GET  /api/tenants/me/renewal          - my renewal status + my vote
 *   POST /api/tenants/me/renewal/vote     - cast YES or NO
 *   GET  /api/tenants/me/renewal/members  - see all members' votes
 *
 * Branch admin:
 *   GET  /api/branch-admin/tenants/:id/renewal                 - full status
 *   GET  /api/branch-admin/tenants/:id/renewal/members         - member votes
 *   POST /api/branch-admin/tenants/:id/renewal/replace         - assign replacement
 *   POST /api/branch-admin/tenants/:id/renewal/dissolve        - force dissolve
 *
 * Super admin: same as branch admin but with full scope.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { requireAuth, requireBranchAdmin } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { AppError } from '../../errors';
import { tenureRenewalService, type RequestMeta } from './tenure-renewal.service';
import {
  CastRenewalVoteSchema,
  ForceDissolveSchema,
  ReplacementBodySchema,
  TenantIdParamSchema,
} from './tenure-renewal.schemas';
import { tenantsRepository } from './tenants.repository';

function metaOf(req: Request): RequestMeta {
  return { ipAddress: req.ip, userAgent: req.header('user-agent') ?? undefined };
}

// ─── Saver routes ────────────────────────────────────────────────

export const tenantRenewalRouter = Router();
tenantRenewalRouter.use(requireAuth);

tenantRenewalRouter.get(
  '/renewal',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await tenureRenewalService.getMyRenewal(req.user!.sub);
      res.json({ ok: true, data });
    } catch (err) {
      next(err);
    }
  },
);

tenantRenewalRouter.post(
  '/renewal/vote',
  validate({ body: CastRenewalVoteSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const status = await tenureRenewalService.castVote(
        req.user!.sub,
        req.body.vote,
        metaOf(req),
      );
      res.json({ ok: true, data: status });
    } catch (err) {
      next(err);
    }
  },
);

tenantRenewalRouter.get(
  '/renewal/members',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const membership = await tenantsRepository.findMembershipByUser(req.user!.sub);
      if (!membership) {
        throw new AppError({
          code: 'AUTH_TENANT_SCOPE',
          httpStatus: 403,
          message: 'Not in a tenant',
        });
      }

      const members = await tenureRenewalService.listMembers(membership.tenant_id);
      res.json({ ok: true, data: members });
    } catch (err) {
      next(err);
    }
  },
);

// ─── Branch admin routes ─────────────────────────────────────────

export const branchAdminRenewalRouter = Router();
branchAdminRenewalRouter.use(requireBranchAdmin);

async function requireTenantInCallerBranch(req: Request): Promise<string> {
  const tenantId = String(req.params.id);
  const tenant = await tenantsRepository.findById(tenantId);

  if (!tenant) {
    throw new AppError({ code: 'NOT_FOUND', httpStatus: 404, message: 'Tenant not found' });
  }

  const user = req.user!;
  if (user.role === 'BRANCH_ADMIN' && tenant.branch_id !== user.branchId) {
    throw new AppError({
      code: 'AUTH_BRANCH_SCOPE',
      httpStatus: 403,
      message: 'Not permitted for this branch',
    });
  }

  return tenantId;
}

branchAdminRenewalRouter.get(
  '/:id/renewal',
  validate({ params: TenantIdParamSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = await requireTenantInCallerBranch(req);
      const status = await tenureRenewalService.getStatus(tenantId);
      res.json({ ok: true, data: status });
    } catch (err) {
      next(err);
    }
  },
);

branchAdminRenewalRouter.get(
  '/:id/renewal/members',
  validate({ params: TenantIdParamSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = await requireTenantInCallerBranch(req);
      const members = await tenureRenewalService.listMembers(tenantId);
      res.json({ ok: true, data: members });
    } catch (err) {
      next(err);
    }
  },
);

branchAdminRenewalRouter.post(
  '/:id/renewal/replace',
  validate({ params: TenantIdParamSchema, body: ReplacementBodySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = await requireTenantInCallerBranch(req);
      const status = await tenureRenewalService.adminAssignReplacement(
        tenantId,
        req.body.slotNumber,
        req.body.newUserId,
        req.user!.sub,
        metaOf(req),
      );
      res.json({ ok: true, data: status });
    } catch (err) {
      next(err);
    }
  },
);

branchAdminRenewalRouter.post(
  '/:id/renewal/dissolve',
  validate({ params: TenantIdParamSchema, body: ForceDissolveSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = await requireTenantInCallerBranch(req);
      await tenureRenewalService.adminForceDissolve(
        tenantId,
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