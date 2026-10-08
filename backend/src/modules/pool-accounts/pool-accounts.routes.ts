/**
 * Pool accounts routes.
 *
 * Branch Admin:
 *   GET    /api/branch-admin/pool-account      - view my branch's pool account
 *   PUT    /api/branch-admin/pool-account      - set/update my branch's pool account
 *
 * Super Admin:
 *   GET    /api/super-admin/maintenance-account
 *   PUT    /api/super-admin/maintenance-account
 *   GET    /api/super-admin/branches/:branchId/pool-account
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { requireSuperAdmin, requireBranchAdmin } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { AppError } from '../../errors';
import { poolAccountsRepository } from './pool-accounts.repository';
import {
  SetBranchPoolAccountSchema,
  SetPlatformMaintenanceAccountSchema,
} from './pool-accounts.schemas';

// ---- Branch admin ----

export const branchAdminPoolAccountRouter = Router();

branchAdminPoolAccountRouter.use(requireBranchAdmin);

branchAdminPoolAccountRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const branchId = req.user!.branchId;
    if (!branchId) {
      throw new AppError({
        code: 'AUTH_BRANCH_REQUIRED',
        httpStatus: 403,
        message: 'No branch assigned to this account',
      });
    }
    const account = await poolAccountsRepository.findBranchAccount(branchId);
    res.json({ ok: true, data: account });
  } catch (err) {
    next(err);
  }
});

branchAdminPoolAccountRouter.put(
  '/',
  validate({ body: SetBranchPoolAccountSchema }),
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
      const account = await poolAccountsRepository.upsertBranchAccount(branchId, req.body);
      res.json({ ok: true, data: account });
    } catch (err) {
      next(err);
    }
  },
);

// ---- Super admin ----

export const superAdminMaintenanceAccountRouter = Router();

superAdminMaintenanceAccountRouter.use(requireSuperAdmin);

superAdminMaintenanceAccountRouter.get(
  '/',
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const account = await poolAccountsRepository.findPlatformMaintenanceAccount();
      res.json({ ok: true, data: account });
    } catch (err) {
      next(err);
    }
  },
);

superAdminMaintenanceAccountRouter.put(
  '/',
  validate({ body: SetPlatformMaintenanceAccountSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const account = await poolAccountsRepository.upsertPlatformMaintenanceAccount(req.body);
      res.json({ ok: true, data: account });
    } catch (err) {
      next(err);
    }
  },
);

export const superAdminBranchPoolAccountRouter = Router();

superAdminBranchPoolAccountRouter.use(requireSuperAdmin);

superAdminBranchPoolAccountRouter.get(
  '/:branchId',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const account = await poolAccountsRepository.findBranchAccount(String(req.params.branchId));
      res.json({ ok: true, data: account });
    } catch (err) {
      next(err);
    }
  },
);