/**
 * Tenants routes.
 *
 * Saver:
 *   GET /api/tenants/me                  - my current tenant + members
 *   GET /api/tenants/me/members          - flat list of members
 *
 * Branch Admin:
 *   GET   /api/branch-admin/tenants/summary            - counts + list
 *   GET   /api/branch-admin/tenants                    - list tenants
 *   GET   /api/branch-admin/tenants/:id                - view one
 *   GET   /api/branch-admin/tenants/:id/members        - view members of a tenant
 *   PATCH /api/branch-admin/tenants/:id/status         - change status
 *
 * Super Admin:
 *   GET   /api/super-admin/tenants/all                 - list all tenants across branches
 *   GET   /api/super-admin/tenants/by-branch/:branchId - list tenants in a branch
 *   GET   /api/super-admin/tenants/:id                 - view one
 *   GET   /api/super-admin/tenants/:id/members         - view members of a tenant
 *   PATCH /api/super-admin/tenants/:id/status          - change status
 *   POST  /api/super-admin/tenants/provision/:userId   - manual provisioning
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { requireAuth, requireSuperAdmin, requireBranchAdmin } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { AppError, NotFoundError } from '../../errors';
import { pool } from '../../db';
import { tenantsService, type RequestMeta } from './tenants.service';
import { provisioningService } from './provisioning.service';
import { usersRepository } from '../users/users.repository';
import { contributionsService } from '../contributions/contributions.service';
import { payoutsRepository } from '../payouts/payouts.repository';
import { ListTenantsQuerySchema, UpdateTenantStatusSchema } from './tenants.schemas';

function metaOf(req: Request): RequestMeta {
  return { ipAddress: req.ip, userAgent: req.header('user-agent') ?? undefined };
}

// ---- Saver router ----

export const tenantsRouter = Router();

tenantsRouter.get('/me', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const dto = await tenantsService.getMyTenant(req.user!.sub);
    if (!dto) {
      return res.json({ ok: true, data: null });
    }

    // ─────────────────────────────────────────────────────────────
    // Check if the current cycle has all 12 contributions confirmed.
    // Only if so is the payout intent meaningful to display.
    // ─────────────────────────────────────────────────────────────
    const cycleCountRes = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM contributions
       WHERE tenant_id = $1 AND tenure = $2 AND cycle = $3`,
      [dto.tenant.id, dto.tenant.currentTenure, dto.tenant.currentCycle],
    );
    const confirmedCount = Number(cycleCountRes.rows[0]?.count ?? '0');
    const cycleComplete = confirmedCount >= 12;

    let formattedPayout = null;

    if (cycleComplete) {
      const payoutIntent = await payoutsRepository.findPayoutIntent(
        dto.tenant.id,
        dto.tenant.currentTenure,
        dto.tenant.currentCycle,
      );

      if (payoutIntent) {
        const recipient = await usersRepository.findById(payoutIntent.recipient_user_id);
        formattedPayout = {
          grossPence: payoutIntent.gross_amount.toString(),
          tvcAdjustmentPence: payoutIntent.tvc_adjustment.toString(),
          potAfterTvcPence: payoutIntent.pot_after_tvc.toString(),
          platformFeePence: payoutIntent.platform_fee.toString(),
          netAmountPence: payoutIntent.net_amount.toString(),
          state: payoutIntent.state,
          recipientUserId: payoutIntent.recipient_user_id,
          recipientName: recipient?.full_name || 'Unknown',
          recipientSlot: payoutIntent.recipient_slot,
          isMyTurn: payoutIntent.recipient_user_id === req.user!.sub,
        };
      }
    }

    res.json({
      ok: true,
      data: {
        ...dto,
        payoutIntent: formattedPayout,
        cycleComplete,
        confirmedContributionsCount: confirmedCount,
      },
    });
  } catch (err) {
    next(err);
  }
});

tenantsRouter.get(
  '/me/members',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const members = await tenantsService.listMyMembers(req.user!.sub);
      res.json({ ok: true, data: members });
    } catch (err) {
      next(err);
    }
  },
);

// ---- Branch Admin router ----

export const branchAdminTenantsRouter = Router();

branchAdminTenantsRouter.use(requireBranchAdmin);

branchAdminTenantsRouter.get(
  '/summary',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const branchId = req.user!.branchId;
      if (!branchId) {
        throw new AppError({
          code: 'AUTH_BRANCH_REQUIRED',
          httpStatus: 403,
          message: 'No branch assigned to this account',
        });
      }
      const summary = await tenantsService.getSummaryForBranch(branchId);
      res.json({ ok: true, data: summary });
    } catch (err) {
      next(err);
    }
  },
);

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

branchAdminTenantsRouter.get(
  '/:id/members',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenant = await tenantsService.getById(String(req.params.id));
      
      // Security check: Branch Admin can only view their own branch's tenants
      if (req.user!.role === 'BRANCH_ADMIN' && tenant.branchId !== req.user!.branchId) {
        throw new AppError({ code: 'AUTH_BRANCH_SCOPE', httpStatus: 403, message: 'Not permitted' });
      }
      
      const members = await tenantsService.listTenantMembersForAdmin(String(req.params.id));
      res.json({ ok: true, data: members });
    } catch (err) {
      next(err);
    }
  },
);

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

// ─────────────────────────────────────────────────────────────
// Super Admin: All Tenants (must be before /:id)
// ─────────────────────────────────────────────────────────────

superAdminTenantsRouter.get(
  '/all',
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await pool.query(`
        SELECT t.*, b.name as branch_name, u.full_name as admin_name,
               (SELECT COUNT(*) FROM tenant_memberships tm WHERE tm.tenant_id = t.id AND tm.status != 'REMOVED') as member_count
        FROM tenants t
        JOIN branches b ON b.id = t.branch_id
        LEFT JOIN users u ON u.id = b.created_by
        ORDER BY t.created_at DESC
      `);
      res.json({ ok: true, data: result.rows });
    } catch (err) {
      next(err);
    }
  }
);

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

superAdminTenantsRouter.post(
  '/provision/:userId',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = await usersRepository.findById(String(req.params.userId));
      if (!user) throw new NotFoundError('User');
      if (!user.branch_id) {
        throw new AppError({
          code: 'PROVISION_NO_BRANCH',
          httpStatus: 400,
          message: 'User is not assigned to a branch',
        });
      }
      const result = await provisioningService.provisionUserToTenant(user.id, user.branch_id);
      res.json({ ok: true, data: result });
    } catch (err) {
      next(err);
    }
  },
);

superAdminTenantsRouter.get(
  '/:id/members',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = String(req.params.id);
      
      const tenant = await tenantsService.getById(tenantId);
      if (!tenant) throw new NotFoundError('Tenant');

      // Fetch the roster for the current cycle (includes contribution status)
      const members = await contributionsService.listTenantCycleMembers(
        tenantId, 
        tenant.currentTenure, 
        tenant.currentCycle
      );

      // Fetch financial totals for this tenant
      const financials = await pool.query<{ contrib_sum: string; contrib_count: string; payout_sum: string; payout_count: string }>(
        `SELECT 
           (SELECT COALESCE(SUM(amount), 0)::text FROM contributions WHERE tenant_id = $1) AS contrib_sum,
           (SELECT COUNT(*)::text FROM contributions WHERE tenant_id = $1) AS contrib_count,
           (SELECT COALESCE(SUM(net_amount), 0)::text FROM payout_intents WHERE tenant_id = $1 AND state = 'CONFIRMED') AS payout_sum,
           (SELECT COUNT(*)::text FROM payout_intents WHERE tenant_id = $1 AND state = 'CONFIRMED') AS payout_count`,
        [tenantId]
      );

      const stats = financials.rows[0];

      res.json({ 
        ok: true, 
        data: {
          members,
          totalContributedPence: stats.contrib_sum,
          totalContributions: Number(stats.contrib_count),
          totalPayoutsPence: stats.payout_sum,
          totalPayouts: Number(stats.payout_count),
        } 
      });
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