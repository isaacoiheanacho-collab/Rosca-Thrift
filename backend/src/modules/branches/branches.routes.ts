import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { pool, withTransaction } from '../../db';
import { AppError } from '../../errors/AppError';
import { requireAuth } from '../auth/auth.middleware';

const router = Router();
const createSchema = z.object({
  name: z.string().trim().min(2).max(120),
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(80),
}).strict();
const asyncRoute = (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => { void fn(req, res).catch(next); };

router.post('/', requireAuth, asyncRoute(async (req, res) => {
  const input = createSchema.parse(req.body);
  const branch = await withTransaction(async (tx) => {
    const existing = await tx.query('SELECT id FROM branches WHERE slug = $1', [input.slug]);
    if (existing.rowCount) throw new AppError({ code: 'BRANCH_SLUG_TAKEN', httpStatus: 409, message: 'That branch address is already in use' });
    const created = await tx.query<{id:string;name:string;slug:string;status:string;created_at:Date}>(
      'INSERT INTO branches (name, slug) VALUES ($1, $2) RETURNING id, name, slug, status, created_at',
      [input.name, input.slug],
    );
    const row = created.rows[0];
    await tx.query('INSERT INTO branch_admins (branch_id, user_id) VALUES ($1, $2)', [row.id, req.auth!.userId]);
    await tx.query("UPDATE users SET role = 'BRANCH_ADMIN', updated_at = NOW() WHERE id = $1", [req.auth!.userId]);
    return row;
  });
  res.status(201).json({ ok: true, data: branch });
}));

router.get('/mine', requireAuth, asyncRoute(async (req, res) => {
  const result = await pool.query(
    `SELECT b.id, b.name, b.slug, b.status, b.created_at, ba.status AS admin_status
     FROM branches b JOIN branch_admins ba ON ba.branch_id = b.id
     WHERE ba.user_id = $1 ORDER BY b.created_at DESC`,
    [req.auth!.userId],
  );
  res.json({ ok: true, data: result.rows });
}));

export { router as branchesRoutes };
