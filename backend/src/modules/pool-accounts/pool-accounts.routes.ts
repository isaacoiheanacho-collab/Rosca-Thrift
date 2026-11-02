/**
 * Pool accounts routes.
 *
 * Branch Admin:
 *   GET    /api/branch-admin/pool-account      - view my branch's pool account
 *   PUT    /api/branch-admin/pool-account      - set/update my branch's pool account
 *
 * Saver:
 *   GET    /api/pool-account                   - view my branch's approved bank details
 *
 * Super Admin:
 *   GET    /api/super-admin/maintenance-account
 *   PUT    /api/super-admin/maintenance-account
 *   GET    /api/super-admin/branches/:branchId/pool-account
 *   GET    /api/super-admin/branch-pool-account/pending
 *   POST   /api/super-admin/branch-pool-account/:branchId/approve
 *   POST   /api/super-admin/branch-pool-account/:branchId/reject
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { requireSuperAdmin, requireBranchAdmin, requireAuth } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { AppError } from '../../errors';
import { pool } from '../../db';
import { getPresignedDownloadUrl } from '../../utils/s3';
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

// ---- Saver-accessible: fetch my branch's approved pool account ----
// Requires auth but NOT branch-admin role. Any authenticated user can
// see the bank details of the branch they belong to (needed to pay in).

export const saverPoolAccountRouter = Router();

saverPoolAccountRouter.use(requireAuth);

saverPoolAccountRouter.get(
  '/',
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
      const account = await poolAccountsRepository.findBranchAccount(branchId);
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

// ─────────────────────────────────────────────────────────────
// Super Admin: Verify Branch Pool Accounts (MUST be before /:branchId)
// ─────────────────────────────────────────────────────────────

superAdminBranchPoolAccountRouter.get(
  '/pending',
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      // We use the standard KYC service but filter specifically for BRANCH_ADMINs
      const result = await pool.query(`
        SELECT 
          k.id AS kyc_id,
          k.legal_name,
          k.account_name,
          k.bank_name,
          k.sort_code,
          k.account_number,
          k.selfie_object_key,
          k.created_at,
          k.status AS kyc_status,
          u.id AS admin_id,
          u.full_name AS admin_name,
          u.phone AS admin_phone,
          b.id AS branch_id,
          b.name AS branch_name
        FROM kyc_submissions k
        JOIN users u ON u.id = k.user_id
        JOIN branches b ON b.id = u.branch_id
        WHERE u.role = 'BRANCH_ADMIN'
        ORDER BY k.created_at DESC
      `);
      
      // Generate presigned URLs for the selfies
      const accounts = await Promise.all(result.rows.map(async (row: any) => {
        let selfie_url = null;
        if (row.selfie_object_key) {
          selfie_url = await getPresignedDownloadUrl(row.selfie_object_key, 300);
        }
        return { ...row, selfie_url };
      }));

      res.json({ ok: true, data: accounts });
    } catch (err) {
      next(err);
    }
  }
);

superAdminBranchPoolAccountRouter.post(
  '/:branchId/approve',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const branchId = String(req.params.branchId);
      
      // 1. Find the KYC submission for the Branch Admin of this branch
      const kycResult = await pool.query<{ id: string }>(
        `SELECT k.id 
         FROM kyc_submissions k
         JOIN users u ON u.id = k.user_id
         WHERE u.branch_id = $1 AND u.role = 'BRANCH_ADMIN' AND k.status = 'PENDING'
         LIMIT 1`,
        [branchId]
      );
      
      const kyc = kycResult.rows[0];
      if (!kyc) {
        throw new AppError({ code: 'KYC_NOT_FOUND', httpStatus: 404, message: 'No pending KYC found for this branch' });
      }

      // 2. Approve the KYC
      await pool.query(
        `UPDATE kyc_submissions SET status = 'APPROVED', reviewed_by = $2, reviewed_at = NOW() WHERE id = $1`,
        [kyc.id, req.user!.sub]
      );

      // Insert (or update) the branch_pool_accounts row from the KYC data
      await pool.query(
        `INSERT INTO branch_pool_accounts 
           (branch_id, account_holder_name, bank_name, account_number, sort_code, status, verified_by, verified_at)
         SELECT 
           $1, k.account_name, k.bank_name, k.account_number, k.sort_code,
           'APPROVED', $2, NOW()
         FROM kyc_submissions k
         WHERE k.id = $3
         ON CONFLICT (branch_id) DO UPDATE SET
           account_holder_name = EXCLUDED.account_holder_name,
           bank_name = EXCLUDED.bank_name,
           account_number = EXCLUDED.account_number,
           sort_code = EXCLUDED.sort_code,
           status = 'APPROVED',
           verified_by = EXCLUDED.verified_by,
           verified_at = NOW()`,
        [branchId, req.user!.sub, kyc.id]
      );

      res.json({ ok: true, message: 'Branch Admin KYC approved' });
    } catch (err) {
      next(err);
    }
  }
);

superAdminBranchPoolAccountRouter.post(
  '/:branchId/reject',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.body.reason) {
        throw new AppError({ code: 'MISSING_REASON', httpStatus: 400, message: 'Rejection reason is required' });
      }
      const branchId = String(req.params.branchId);
      
      // 1. Find the KYC submission
      const kycResult = await pool.query<{ id: string }>(
        `SELECT k.id 
         FROM kyc_submissions k
         JOIN users u ON u.id = k.user_id
         WHERE u.branch_id = $1 AND u.role = 'BRANCH_ADMIN' AND k.status = 'PENDING'
         LIMIT 1`,
        [branchId]
      );
      
      const kyc = kycResult.rows[0];
      if (!kyc) {
        throw new AppError({ code: 'KYC_NOT_FOUND', httpStatus: 404, message: 'No pending KYC found for this branch' });
      }

      // 2. Reject the KYC
      await pool.query(
        `UPDATE kyc_submissions SET status = 'REJECTED', reviewed_by = $2, reviewed_at = NOW(), rejection_reason = $3 WHERE id = $1`,
        [kyc.id, req.user!.sub, req.body.reason]
      );

      res.json({ ok: true, message: 'Branch Admin KYC rejected' });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────────────────────────
// Dynamic /:branchId route MUST come after the specific routes
// ─────────────────────────────────────────────────────────────

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