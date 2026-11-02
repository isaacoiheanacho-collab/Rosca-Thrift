/**
 * Stats routes.
 *
 *   GET /api/super-admin/stats                    - platform-wide stats
 *   GET /api/super-admin/stats/monthly-volume     - 12-month rollup
 *   GET /api/super-admin/stats/analytics          - platform-wide analytics
 *   GET /api/branch-admin/stats                   - branch-scoped stats
 *
 * All read-only. No mutations. No audit logging.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { requireSuperAdmin, requireBranchAdmin } from '../../middleware/auth';
import { AppError } from '../../errors';
import { statsService } from './stats.service';
import { statsRepository } from './stats.repository';

// ─── Super admin ─────────────────────────────────────────────────

export const superAdminStatsRouter = Router();
superAdminStatsRouter.use(requireSuperAdmin);

superAdminStatsRouter.get(
  '/',
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const [stats, money] = await Promise.all([
        statsService.getSuperAdminStats(),
        statsRepository.platformFinancialsThisMonth()
      ]);
      
      // Inject the money stats into the response
      stats.contributions = {
        thisMonthGbp: money.contribGbp,
        thisMonthPence: (Number(money.contribGbp) * 100).toString(),
        thisMonthCount: 0, // Optional: Add count if needed
        pendingConfirmation: stats.contributions.pendingConfirmation || 0,
      };
      
      stats.payouts = {
        thisMonthGbp: money.payoutGbp,
        thisMonthPence: (Number(money.payoutGbp) * 100).toString(),
        thisMonthCount: 0, 
        pendingFees: stats.payouts.pendingFees || 0,
        pendingConfirmation: stats.payouts.pendingConfirmation || 0,
      };

      res.json({ ok: true, data: stats });
    } catch (err) {
      next(err);
    }
  },
);

superAdminStatsRouter.get(
  '/monthly-volume',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const monthsParam = req.query.months;
      const months = monthsParam ? Number(monthsParam) : 12;
      if (!Number.isInteger(months) || months < 1 || months > 24) {
        throw new AppError({
          code: 'STATS_BAD_MONTHS',
          httpStatus: 400,
          message: 'months must be an integer between 1 and 24',
        });
      }
      const data = await statsService.getMonthlyVolume(months);
      res.json({ ok: true, data });
    } catch (err) {
      next(err);
    }
  },
);

superAdminStatsRouter.get(
  '/analytics',
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await statsService.getPlatformAnalytics();
      // Convert BigInts to strings for JSON
      const jsonSafe = {
        totalContributionsGbp: (Number(data.totalContributionsPence) / 100).toFixed(2),
        totalContributionsCount: data.totalContributionsCount,
        totalPayoutsGbp: (Number(data.totalPayoutsPence) / 100).toFixed(2),
        totalPayoutsCount: data.totalPayoutsCount,
        topBranches: data.topBranches.map(b => ({
          name: b.name,
          totalGbp: (Number(b.totalPence) / 100).toFixed(2),
          count: b.count,
        })),
        recentActivity: data.recentActivity.map(a => ({
          type: a.type,
          amountGbp: (Number(a.amountPence) / 100).toFixed(2),
          name: a.name,
          reference: a.reference,
          date: a.date.toISOString(),
        })),
      };
      res.json({ ok: true, data: jsonSafe });
    } catch (err) {
      next(err);
    }
  }
);

// ─── Branch admin ────────────────────────────────────────────────

export const branchAdminStatsRouter = Router();
branchAdminStatsRouter.use(requireBranchAdmin);

branchAdminStatsRouter.get(
  '/',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = req.user!;

      // Branch admin → their own branch. Super admin using this route must
      // supply ?branchId=. This keeps the endpoint coherent regardless of role.
      let branchId: string | undefined;
      if (user.role === 'BRANCH_ADMIN') {
        if (!user.branchId) {
          throw new AppError({
            code: 'AUTH_BRANCH_REQUIRED',
            httpStatus: 403,
            message: 'No branch assigned to this account',
          });
        }
        branchId = user.branchId;
      } else {
        // Super admin
        const fromQuery = String(req.query.branchId ?? '');
        if (!fromQuery) {
          throw new AppError({
            code: 'AUTH_BRANCH_REQUIRED',
            httpStatus: 400,
            message: 'Super admin must supply branchId as a query parameter',
          });
        }
        branchId = fromQuery;
      }

      const stats = await statsService.getBranchAdminStats(branchId);
      res.json({ ok: true, data: stats });
    } catch (err) {
      next(err);
    }
  },
);