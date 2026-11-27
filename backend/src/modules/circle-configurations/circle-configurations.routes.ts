import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { pool, withTransaction } from '../../db';
import { AppError } from '../../errors/AppError';
import { requireAuth } from '../auth/auth.middleware';

const router = Router();
const createSchema = z.object({
  branchId: z.string().uuid(),
  name: z.string().trim().min(2).max(120),
  contributionAmountPence: z.number().int().positive().max(100_000_000),
  frequency: z.enum(['weekly', 'monthly']),
  capacity: z.number().int().min(1).max(500),
  publicJoinEnabled: z.boolean().default(true),
}).strict();
const asyncRoute = (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => { void fn(req, res).catch(next); };

router.get('/public', asyncRoute(async (_req, res) => {
  const result = await pool.query(
    `SELECT c.id, c.branch_id, b.name AS branch_name, c.name, c.contribution_amount_pence,
            c.frequency, c.max_co_savers, c.collection_positions, c.duration_periods
     FROM circle_configurations c JOIN branches b ON b.id = c.branch_id
     WHERE c.status = 'active' AND c.public_join_enabled = TRUE AND b.status = 'active'
     ORDER BY b.name, c.name`,
  );
  res.json({ ok: true, data: result.rows });
}));

router.post('/', requireAuth, asyncRoute(async (req, res) => {
  const input = createSchema.parse(req.body);
  const created = await withTransaction(async (tx) => {
    const admin = await tx.query(
      "SELECT 1 FROM branch_admins WHERE branch_id = $1 AND user_id = $2 AND status = 'active' FOR UPDATE",
      [input.branchId, req.auth!.userId],
    );
    if (!admin.rowCount && req.auth!.role !== 'SUPER_ADMIN') {
      throw new AppError({ code: 'BRANCH_FORBIDDEN', httpStatus: 403, message: 'You cannot create configurations for this branch' });
    }
    const branch = await tx.query("SELECT id FROM branches WHERE id = $1 AND status = 'active' FOR UPDATE", [input.branchId]);
    if (!branch.rowCount) throw new AppError({ code: 'BRANCH_NOT_FOUND', httpStatus: 404, message: 'Active branch not found' });
    const result = await tx.query(
      `INSERT INTO circle_configurations
       (branch_id, name, contribution_amount_pence, frequency, max_co_savers,
        collection_positions, duration_periods, public_join_enabled, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $5, $5, $6, $7)
       RETURNING id, branch_id, name, contribution_amount_pence, frequency,
                 max_co_savers, collection_positions, duration_periods, status,
                 public_join_enabled, created_at`,
      [input.branchId, input.name, input.contributionAmountPence, input.frequency,
       input.capacity, input.publicJoinEnabled, req.auth!.userId],
    );
    return result.rows[0];
  });
  res.status(201).json({ ok: true, data: created });
}));

router.get('/branch/:branchId', requireAuth, asyncRoute(async (req, res) => {
  const branchId = z.string().uuid().parse(req.params.branchId);
  const isSuper = req.auth!.role === 'SUPER_ADMIN';
  if (!isSuper) {
    const access = await pool.query(
      "SELECT 1 FROM branch_admins WHERE branch_id = $1 AND user_id = $2 AND status = 'active'",
      [branchId, req.auth!.userId],
    );
    if (!access.rowCount) {
      throw new AppError({ code: 'BRANCH_FORBIDDEN', httpStatus: 403, message: 'You cannot view this branch configurations' });
    }
  }
  const result = await pool.query(
    `SELECT c.id, c.branch_id, c.name, c.contribution_amount_pence, c.frequency,
            c.max_co_savers, c.collection_positions, c.duration_periods, c.status,
            c.public_join_enabled, c.created_at
     FROM circle_configurations c
     WHERE c.branch_id = $1 AND ($2::boolean OR EXISTS (
       SELECT 1 FROM branch_admins ba WHERE ba.branch_id = c.branch_id
         AND ba.user_id = $3 AND ba.status = 'active'))
     ORDER BY c.created_at DESC`,
    [branchId, isSuper, req.auth!.userId],
  );
  res.json({ ok: true, data: result.rows });
}));

router.get('/:configurationId', asyncRoute(async (req, res) => {
  const id = z.string().uuid().parse(req.params.configurationId);
  const result = await pool.query(
    `SELECT c.id, c.branch_id, b.name AS branch_name, c.name,
            c.contribution_amount_pence, c.frequency, c.max_co_savers,
            c.collection_positions, c.duration_periods
     FROM circle_configurations c JOIN branches b ON b.id = c.branch_id
     WHERE c.id = $1 AND c.status = 'active' AND b.status = 'active'
       AND c.public_join_enabled = TRUE`, [id],
  );
  if (!result.rowCount) throw new AppError({ code: 'CONFIGURATION_NOT_FOUND', httpStatus: 404, message: 'Public circle configuration not found' });
  res.json({ ok: true, data: result.rows[0] });
}));

export { router as circleConfigurationsRoutes };
