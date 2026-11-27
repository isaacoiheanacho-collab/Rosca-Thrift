import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { pool, withTransaction } from '../../db';
import { AppError } from '../../errors/AppError';
import { requireAuth } from '../auth/auth.middleware';

const router = Router();
const submitSchema = z.object({
  tenantId: z.string().uuid(),
  provider: z.string().trim().min(2).max(80).default('manual'),
  providerReference: z.string().trim().min(3).max(180),
}).strict();
const asyncRoute = (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => { void fn(req, res).catch(next); };

router.post('/', requireAuth, asyncRoute(async (req, res) => {
  const input = submitSchema.parse(req.body);
  const record = await withTransaction(async (tx) => {
    const member = await tx.query<{id:string;tenant_status:string}>(
      `SELECT tm.id, t.status AS tenant_status
       FROM tenant_members tm JOIN tenants t ON t.id = tm.tenant_id
       WHERE tm.tenant_id = $1 AND tm.user_id = $2 AND tm.registration_status = 'registered'
       FOR UPDATE OF tm`,
      [input.tenantId, req.auth!.userId],
    );
    if (!member.rowCount) throw new AppError({ code: 'TENANT_MEMBERSHIP_NOT_FOUND', httpStatus: 404, message: 'Your membership in this circle was not found' });
    if (member.rows[0].tenant_status === 'active') throw new AppError({ code: 'ONBOARDING_LOCKED', httpStatus: 409, message: 'This circle has already activated' });
    const created = await tx.query(
      `INSERT INTO kyc_records (user_id, tenant_member_id, status, provider, provider_reference, submitted_at)
       VALUES ($1, $2, 'submitted', $3, $4, NOW())
       RETURNING id, tenant_member_id, status, provider, provider_reference, submitted_at`,
      [req.auth!.userId, member.rows[0].id, input.provider, input.providerReference],
    );
    await tx.query("UPDATE tenant_members SET onboarding_status = 'submitted' WHERE id = $1", [member.rows[0].id]);
    return created.rows[0];
  });
  res.status(201).json({ ok: true, data: record });
}));

router.get('/me', requireAuth, asyncRoute(async (req, res) => {
  const result = await pool.query(
    `SELECT kr.id, kr.tenant_member_id, kr.status, kr.provider, kr.provider_reference,
            kr.submitted_at, kr.reviewed_at, t.id AS tenant_id, t.tenant_sequence,
            b.name AS branch_name
     FROM kyc_records kr
     LEFT JOIN tenant_members tm ON tm.id = kr.tenant_member_id
     LEFT JOIN tenants t ON t.id = tm.tenant_id
     LEFT JOIN branches b ON b.id = t.branch_id
     WHERE kr.user_id = $1 ORDER BY kr.created_at DESC`,
    [req.auth!.userId],
  );
  res.json({ ok: true, data: result.rows });
}));

router.get('/branch/:branchId/pending', requireAuth, asyncRoute(async (req, res) => {
  const branchId = z.string().uuid().parse(req.params.branchId);
  if (req.auth!.role !== 'SUPER_ADMIN') {
    const access = await pool.query(
      "SELECT 1 FROM branch_admins WHERE branch_id = $1 AND user_id = $2 AND status = 'active'",
      [branchId, req.auth!.userId],
    );
    if (!access.rowCount) throw new AppError({ code: 'BRANCH_FORBIDDEN', httpStatus: 403, message: 'You cannot review KYC for this branch' });
  }
  const result = await pool.query(
    `SELECT kr.id, kr.user_id, kr.tenant_member_id, kr.status, kr.provider,
            kr.provider_reference, kr.submitted_at, u.full_name, u.phone_e164,
            t.id AS tenant_id, t.tenant_sequence, tm.position
     FROM kyc_records kr
     JOIN users u ON u.id = kr.user_id
     JOIN tenant_members tm ON tm.id = kr.tenant_member_id
     JOIN tenants t ON t.id = tm.tenant_id
     WHERE t.branch_id = $1 AND kr.status IN ('submitted', 'under_review')
     ORDER BY kr.submitted_at ASC`,
    [branchId],
  );
  res.json({ ok: true, data: result.rows });
}));

export { router as kycRoutes };
