import { Router, type NextFunction, type Request, type Response } from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { pool } from '../db';
import { env } from '../config/env';
import { AppError } from '../errors/AppError';

interface AccessClaims {
  sub: string;
  role: 'MEMBER' | 'BRANCH_ADMIN' | 'SUPER_ADMIN';
  branchId?: string;
}

function requireBranchAdmin(req: Request, _res: Response, next: NextFunction): void {
  const header = req.header('authorization');
  if (!header?.startsWith('Bearer ')) {
    next(new AppError({ code: 'AUTH_REQUIRED', httpStatus: 401, message: 'Authentication is required.' }));
    return;
  }
  try {
    const claims = jwt.verify(header.slice(7), env.JWT_ACCESS_SECRET) as AccessClaims;
    if (!claims.sub || !['BRANCH_ADMIN', 'SUPER_ADMIN'].includes(claims.role)) {
      throw new Error('Insufficient role');
    }
    if (claims.role === 'BRANCH_ADMIN' && !claims.branchId) {
      throw new Error('Branch context missing');
    }
    res.locals.auth = claims;
    next();
  } catch {
    next(new AppError({ code: 'INVALID_ACCESS_TOKEN', httpStatus: 401, message: 'Your session is invalid or expired.' }));
  }
}

const createConfigurationSchema = z.object({
  branchId: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(120),
  contributionAmountPence: z.number().int().positive().safe(),
  frequency: z.enum(['weekly', 'monthly']),
  capacity: z.number().int().positive().max(10_000),
  publicJoinEnabled: z.boolean().default(true),
});

export const publicCircleConfigurationsRouter = Router();
publicCircleConfigurationsRouter.get('/', async (_req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, branch_id, name, contribution_amount_pence, frequency,
              max_co_savers, collection_positions, duration_periods
       FROM circle_configurations
       WHERE status = 'active' AND public_join_enabled = TRUE
       ORDER BY created_at DESC`,
    );
    res.json({ ok: true, data: result.rows });
  } catch (error) { next(error); }
});

export const branchAdminCircleConfigurationsRouter = Router();
branchAdminCircleConfigurationsRouter.post('/', requireBranchAdmin, async (req, res, next) => {
  try {
    const input = createConfigurationSchema.parse(req.body);
    const auth = res.locals.auth as AccessClaims;
    const branchId = auth.role === 'SUPER_ADMIN' ? input.branchId : auth.branchId;
    if (!branchId) {
      throw new AppError({ code: 'BRANCH_REQUIRED', httpStatus: 400, message: 'A branch must be selected.' });
    }
    if (auth.role === 'BRANCH_ADMIN') {
      const access = await pool.query(
        `SELECT 1 FROM branch_admins
         WHERE branch_id = $1 AND user_id = $2 AND status = 'active'`,
        [branchId, auth.sub],
      );
      if (access.rowCount !== 1) {
        throw new AppError({ code: 'BRANCH_ACCESS_DENIED', httpStatus: 403, message: 'You cannot manage this branch.' });
      }
    }
    const result = await pool.query(
      `INSERT INTO circle_configurations
        (branch_id, name, contribution_amount_pence, frequency, max_co_savers,
         collection_positions, duration_periods, public_join_enabled, created_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$5,$5,$6,$7)
       RETURNING id, branch_id, name, contribution_amount_pence, frequency,
                 max_co_savers, collection_positions, duration_periods,
                 status, public_join_enabled, created_at`,
      [branchId, input.name, input.contributionAmountPence, input.frequency,
       input.capacity, input.publicJoinEnabled, auth.sub],
    );
    res.status(201).json({ ok: true, data: result.rows[0] });
  } catch (error) { next(error); }
});

export const authRoutes = Router();
authRoutes.all('*', (_req, res) => res.status(501).json({
  ok: false, error: { code: 'AUTH_NOT_IMPLEMENTED', message: 'Phone verification and authentication endpoints are being rebuilt.' },
}));

export const usersRoutes = Router();
export const publicBranchesRouter = Router();
export const superAdminBranchesRouter = Router();
export const branchTrustAccountRouter = Router();
export const branchAdminBranchesRouter = Router();
export const kycRouter = Router();
export const branchAdminKycRouter = Router();
export const superAdminKycRouter = Router();
export const tenantsRouter = Router();
export const branchAdminTenantsRouter = Router();
export const superAdminTenantsRouter = Router();
export const tenantRenewalRouter = Router();
export const branchAdminRenewalRouter = Router();
export const contributionsRouter = Router();
export const branchAdminContributionsRouter = Router();
export const tenantVisibilityRouter = Router();
export const receiptsRouter = Router();
export const branchAdminPoolAccountRouter = Router();
export const saverPoolAccountRouter = Router();
export const superAdminMaintenanceAccountRouter = Router();
export const superAdminBranchPoolAccountRouter = Router();
export const branchAdminPayoutsRouter = Router();
export const superAdminPayoutsRouter = Router();
export const tenantPayoutVisibilityRouter = Router();
export const notificationsRouter = Router();
export const superAdminStatsRouter = Router();
export const branchAdminStatsRouter = Router();
