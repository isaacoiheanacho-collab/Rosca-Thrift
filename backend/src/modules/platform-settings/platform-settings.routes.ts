import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { pool, withTransaction } from '../../db';
import { AppError } from '../../errors/AppError';
import { requireAuth } from '../auth/auth.middleware';

const router = Router();

const updateSchema = z.object({
  maintenanceFeeBps: z.number().int().min(0).max(10_000),
  reason: z.string().trim().min(5).max(500),
}).strict();

const asyncRoute = (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => {
    void fn(req, res).catch(next);
  };

function requireSuperAdmin(req: Request): void {
  if (req.auth!.role !== 'SUPER_ADMIN') {
    throw new AppError({
      code: 'SUPER_ADMIN_REQUIRED',
      httpStatus: 403,
      message: 'Only a Super Admin can manage the platform maintenance fee',
    });
  }
}

router.get('/maintenance-fee', requireAuth, asyncRoute(async (req, res) => {
  requireSuperAdmin(req);

  const result = await pool.query(
    `SELECT maintenance_fee_bps, updated_by_user_id, updated_at
     FROM platform_maintenance_fee_policy
     WHERE id = 1`,
  );

  if (!result.rowCount) {
    throw new AppError({
      code: 'PLATFORM_FEE_POLICY_MISSING',
      httpStatus: 500,
      message: 'Platform maintenance fee policy is not configured',
    });
  }

  const policy = result.rows[0];

  res.json({
    ok: true,
    data: {
      maintenanceFeeBps: policy.maintenance_fee_bps,
      maintenanceFeePercent: policy.maintenance_fee_bps / 100,
      updatedByUserId: policy.updated_by_user_id,
      updatedAt: policy.updated_at,
    },
  });
}));

router.patch('/maintenance-fee', requireAuth, asyncRoute(async (req, res) => {
  requireSuperAdmin(req);
  const input = updateSchema.parse(req.body);

  const updated = await withTransaction(async (tx) => {
    const current = await tx.query<{ maintenance_fee_bps: number }>(
      `SELECT maintenance_fee_bps
       FROM platform_maintenance_fee_policy
       WHERE id = 1
       FOR UPDATE`,
    );

    if (!current.rowCount) {
      throw new AppError({
        code: 'PLATFORM_FEE_POLICY_MISSING',
        httpStatus: 500,
        message: 'Platform maintenance fee policy is not configured',
      });
    }

    const previousFeeBps = current.rows[0].maintenance_fee_bps;

    const result = await tx.query(
      `UPDATE platform_maintenance_fee_policy
       SET maintenance_fee_bps = $1,
           updated_by_user_id = $2,
           updated_at = NOW()
       WHERE id = 1
       RETURNING maintenance_fee_bps, updated_by_user_id, updated_at`,
      [input.maintenanceFeeBps, req.auth!.userId],
    );

    await tx.query(
      `INSERT INTO platform_maintenance_fee_history
       (previous_fee_bps, new_fee_bps, changed_by_user_id, reason)
       VALUES ($1, $2, $3, $4)`,
      [previousFeeBps, input.maintenanceFeeBps, req.auth!.userId, input.reason],
    );

    return result.rows[0];
  });

  res.json({
    ok: true,
    data: {
      maintenanceFeeBps: updated.maintenance_fee_bps,
      maintenanceFeePercent: updated.maintenance_fee_bps / 100,
      updatedByUserId: updated.updated_by_user_id,
      updatedAt: updated.updated_at,
    },
  });
}));

router.get('/maintenance-fee/history', requireAuth, asyncRoute(async (req, res) => {
  requireSuperAdmin(req);

  const result = await pool.query(
    `SELECT id, previous_fee_bps, new_fee_bps,
            changed_by_user_id, reason, changed_at
     FROM platform_maintenance_fee_history
     ORDER BY changed_at DESC, id DESC
     LIMIT 100`,
  );

  res.json({
    ok: true,
    data: result.rows.map((row) => ({
      id: row.id,
      previousFeeBps: row.previous_fee_bps,
      previousFeePercent: row.previous_fee_bps === null
        ? null : row.previous_fee_bps / 100,
      newFeeBps: row.new_fee_bps,
      newFeePercent: row.new_fee_bps / 100,
      changedByUserId: row.changed_by_user_id,
      reason: row.reason,
      changedAt: row.changed_at,
    })),
  });
}));

export { router as platformSettingsRoutes };
