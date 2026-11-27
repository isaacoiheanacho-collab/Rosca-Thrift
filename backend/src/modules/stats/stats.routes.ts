import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { pool } from '../../db';
import { AppError } from '../../errors/AppError';
import { requireAuth } from '../auth/auth.middleware';

const router = Router();
const asyncRoute = (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => { void fn(req, res).catch(next); };

router.get('/branch/:branchId', requireAuth, asyncRoute(async (req, res) => {
  const branchId = z.string().uuid().parse(req.params.branchId);
  if (req.auth!.role !== 'SUPER_ADMIN') {
    const access = await pool.query(
      "SELECT 1 FROM branch_admins WHERE branch_id = $1 AND user_id = $2 AND status = 'active'",
      [branchId, req.auth!.userId],
    );
    if (!access.rowCount) throw new AppError({ code: 'BRANCH_FORBIDDEN', httpStatus: 403, message: 'You cannot view this branch statistics' });
  }

  const [configurations, tenants, membership, contributions, payouts] = await Promise.all([
    pool.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE status = 'active')::int AS active,
              COUNT(*) FILTER (WHERE status = 'inactive')::int AS inactive,
              COUNT(*) FILTER (WHERE status = 'archived')::int AS archived
       FROM circle_configurations WHERE branch_id = $1`, [branchId],
    ),
    pool.query(
      `SELECT status, COUNT(*)::int AS count FROM tenants
       WHERE branch_id = $1 GROUP BY status ORDER BY status`, [branchId],
    ),
    pool.query(
      `SELECT
        (SELECT COALESCE(SUM(capacity), 0)::int FROM tenants
         WHERE branch_id = $1 AND status <> 'cancelled') AS configured_positions,
        (SELECT COUNT(*)::int FROM tenant_members tm
         JOIN tenants t ON t.id = tm.tenant_id
         WHERE t.branch_id = $1 AND t.status <> 'cancelled'
           AND tm.registration_status = 'registered') AS occupied_positions,
        (SELECT COUNT(*)::int FROM tenant_members tm
         JOIN tenants t ON t.id = tm.tenant_id
         JOIN users u ON u.id = tm.user_id
         WHERE t.branch_id = $1 AND t.status <> 'cancelled'
           AND tm.registration_status = 'registered'
           AND tm.onboarding_status = 'approved'
           AND tm.verification_status = 'approved'
           AND u.phone_verified_at IS NOT NULL) AS verified_members`, [branchId],
    ),
    pool.query(
      `SELECT COUNT(*)::int AS recorded_contributions,
              COUNT(*) FILTER (WHERE c.status IN ('received', 'reconciled'))::int AS received_contributions,
              COUNT(*) FILTER (WHERE c.status = 'reconciled')::int AS reconciled_contributions,
              COALESCE(SUM(c.amount_pence) FILTER (WHERE c.status IN ('received', 'reconciled')), 0)::text AS received_amount_pence,
              COALESCE(SUM(c.amount_pence) FILTER (WHERE c.status = 'pending'), 0)::text AS pending_amount_pence
       FROM contributions c JOIN tenants t ON t.id = c.tenant_id
       WHERE t.branch_id = $1`, [branchId],
    ),
    pool.query(
      `SELECT COUNT(*)::int AS payout_intents,
              COUNT(*) FILTER (WHERE pi.status = 'paid')::int AS paid_payouts,
              COALESCE(SUM(pi.net_payout_pence) FILTER (WHERE pi.status = 'paid'), 0)::text AS net_paid_pence,
              COALESCE(SUM(pi.platform_fee_pence) FILTER (WHERE pi.status = 'paid'), 0)::text AS platform_fees_pence
       FROM payout_intents pi JOIN tenants t ON t.id = pi.tenant_id
       WHERE t.branch_id = $1`, [branchId],
    ),
  ]);

  res.json({ ok: true, data: {
    configurations: configurations.rows[0],
    tenantsByStatus: tenants.rows,
    membership: membership.rows[0],
    contributions: contributions.rows[0],
    payouts: payouts.rows[0],
  }});
}));

export { router as statsRoutes };
