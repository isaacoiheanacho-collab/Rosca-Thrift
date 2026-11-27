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
    if (!access.rowCount) throw new AppError({ code: 'BRANCH_FORBIDDEN', httpStatus: 403, message: 'You cannot view this branch ledger' });
  }
  const limit = z.coerce.number().int().min(1).max(200).default(100).parse(req.query.limit);
  const result = await pool.query(
    `SELECT id, tenant_id, transaction_type, amount_pence, currency, reference_type,
            reference_id, external_reference, status, occurred_at, created_at
     FROM ledger_transactions WHERE branch_id = $1
     ORDER BY occurred_at DESC, id DESC LIMIT $2`,
    [branchId, limit],
  );
  res.json({ ok: true, data: result.rows });
}));

export { router as ledgerRoutes };
