import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { pool } from '../../db';
import { AppError } from '../../errors/AppError';
import { requireAuth } from '../auth/auth.middleware';

const router = Router();
const accountSchema = z.object({
  branchId: z.string().uuid(),
  provider: z.string().trim().min(2).max(80),
  externalAccountReference: z.string().trim().min(3).max(180),
  accountName: z.string().trim().max(120).optional(),
  maskedAccountIdentifier: z.string().trim().max(40).optional(),
}).strict();
const asyncRoute = (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => { void fn(req, res).catch(next); };

async function assertAccess(branchId: string, userId: string, role: string) {
  if (role === 'SUPER_ADMIN') return;
  const access = await pool.query(
    "SELECT 1 FROM branch_admins WHERE branch_id = $1 AND user_id = $2 AND status = 'active'",
    [branchId, userId],
  );
  if (!access.rowCount) throw new AppError({ code: 'BRANCH_FORBIDDEN', httpStatus: 403, message: 'You cannot manage this branch pool account' });
}

router.post('/', requireAuth, asyncRoute(async (req, res) => {
  const input = accountSchema.parse(req.body);
  await assertAccess(input.branchId, req.auth!.userId, req.auth!.role);
  const result = await pool.query(
    `INSERT INTO pool_account_references
      (branch_id, provider, external_account_reference, account_name, masked_account_identifier)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (branch_id, provider, external_account_reference)
     DO UPDATE SET account_name = EXCLUDED.account_name,
                   masked_account_identifier = EXCLUDED.masked_account_identifier,
                   status = 'active'
     RETURNING id, branch_id, provider, account_name, masked_account_identifier, status, created_at`,
    [input.branchId, input.provider, input.externalAccountReference, input.accountName ?? null, input.maskedAccountIdentifier ?? null],
  );
  res.status(201).json({ ok: true, data: result.rows[0] });
}));

router.get('/:branchId', requireAuth, asyncRoute(async (req, res) => {
  const branchId = z.string().uuid().parse(req.params.branchId);
  await assertAccess(branchId, req.auth!.userId, req.auth!.role);
  const result = await pool.query(
    `SELECT id, branch_id, provider, account_name, masked_account_identifier, status, created_at
     FROM pool_account_references WHERE branch_id = $1 ORDER BY created_at DESC`,
    [branchId],
  );
  res.json({ ok: true, data: result.rows });
}));

export { router as poolAccountsRoutes };
