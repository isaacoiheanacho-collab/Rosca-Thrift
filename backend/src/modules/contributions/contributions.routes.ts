import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { pool, withTransaction } from '../../db';
import { AppError } from '../../errors/AppError';
import { requireAuth } from '../auth/auth.middleware';

const router = Router();
const recordSchema = z.object({
  tenantId: z.string().uuid(),
  periodId: z.string().uuid(),
  amountPence: z.number().int().positive().max(100_000_000),
  idempotencyKey: z.string().trim().min(12).max(128),
}).strict();
const statusSchema = z.object({
  status: z.enum(['received', 'failed', 'reconciled']),
  paymentReference: z.string().trim().min(3).max(160).optional(),
}).strict();
const asyncRoute = (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => { void fn(req, res).catch(next); };

router.post('/', requireAuth, asyncRoute(async (req, res) => {
  const input = recordSchema.parse(req.body);
  const created = await withTransaction(async (tx) => {
    const eligibility = await tx.query<{
      period_id:string;period_status:string;tenant_status:string;branch_id:string;
      contribution_amount_pence:string;member_id:string;
    }>(
      `SELECT cp.id AS period_id, cp.status AS period_status, t.status AS tenant_status,
              t.branch_id, c.contribution_amount_pence, tm.id AS member_id
       FROM contribution_periods cp
       JOIN tenants t ON t.id = cp.tenant_id
       JOIN circle_configurations c ON c.id = t.configuration_id
       JOIN tenant_members tm ON tm.tenant_id = t.id AND tm.user_id = $3
       WHERE cp.id = $1 AND t.id = $2 AND tm.registration_status = 'registered'
       FOR UPDATE OF cp`,
      [input.periodId, input.tenantId, req.auth!.userId],
    );
    const row = eligibility.rows[0];
    if (!row || row.tenant_status !== 'active' || row.period_status !== 'open') {
      throw new AppError({ code: 'CONTRIBUTION_NOT_ALLOWED', httpStatus: 409, message: 'Contribution cannot be recorded for this circle period' });
    }
    if (BigInt(row.contribution_amount_pence) !== BigInt(input.amountPence)) {
      throw new AppError({ code: 'CONTRIBUTION_AMOUNT_MISMATCH', httpStatus: 400, message: 'Contribution amount must match this circle configuration' });
    }
    const result = await tx.query(
      `INSERT INTO contributions (tenant_id, period_id, tenant_member_id, amount_pence, idempotency_key)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id, tenant_id, period_id, tenant_member_id, amount_pence, status, created_at`,
      [input.tenantId, input.periodId, row.member_id, input.amountPence, input.idempotencyKey],
    );
    if (!result.rowCount) throw new AppError({ code: 'DUPLICATE_IDEMPOTENCY_KEY', httpStatus: 409, message: 'This contribution request has already been submitted' });
    return result.rows[0];
  });
  res.status(201).json({ ok: true, data: created });
}));

router.patch('/:contributionId/status', requireAuth, asyncRoute(async (req, res) => {
  const contributionId = z.string().uuid().parse(req.params.contributionId);
  const input = statusSchema.parse(req.body);
  const updated = await withTransaction(async (tx) => {
    const found = await tx.query<{
      id:string;tenant_id:string;branch_id:string;amount_pence:string;status:string;
    }>(
      `SELECT c.id, c.tenant_id, c.period_id, t.branch_id, t.capacity, c.amount_pence, c.status
       FROM contributions c JOIN tenants t ON t.id = c.tenant_id
       JOIN contribution_periods cp ON cp.id = c.period_id
       WHERE c.id = $1 FOR UPDATE OF c, cp`,
      [contributionId],
    );
    const contribution = found.rows[0];
    if (!contribution) throw new AppError({ code: 'CONTRIBUTION_NOT_FOUND', httpStatus: 404, message: 'Contribution not found' });
    if (req.auth!.role !== 'SUPER_ADMIN') {
      const access = await tx.query(
        "SELECT 1 FROM branch_admins WHERE branch_id = $1 AND user_id = $2 AND status = 'active'",
        [contribution.branch_id, req.auth!.userId],
      );
      if (!access.rowCount) throw new AppError({ code: 'BRANCH_FORBIDDEN', httpStatus: 403, message: 'You cannot update contributions for this branch' });
    }

    if (input.status === 'received' || input.status === 'failed') {
      if (contribution.status !== 'pending') {
        throw new AppError({ code: 'INVALID_CONTRIBUTION_TRANSITION', httpStatus: 409, message: 'Only pending contributions can be marked received or failed' });
      }
      if (input.status === 'received' && !input.paymentReference) {
        throw new AppError({ code: 'PAYMENT_REFERENCE_REQUIRED', httpStatus: 400, message: 'A payment reference is required to confirm receipt' });
      }
      const result = await tx.query(
        `UPDATE contributions SET status = $1, payment_reference = $2,
           received_at = CASE WHEN $1 = 'received' THEN NOW() ELSE NULL END
         WHERE id = $3
         RETURNING id, tenant_id, period_id, tenant_member_id, amount_pence, status, payment_reference, received_at`,
        [input.status, input.paymentReference ?? null, contributionId],
      );
      return result.rows[0];
    }

    if (contribution.status !== 'received') {
      throw new AppError({ code: 'INVALID_CONTRIBUTION_TRANSITION', httpStatus: 409, message: 'Only received contributions can be reconciled' });
    }
    const result = await tx.query(
      `UPDATE contributions SET status = 'reconciled', reconciled_at = NOW()
       WHERE id = $1
       RETURNING id, tenant_id, period_id, tenant_member_id, amount_pence, status, payment_reference, received_at, reconciled_at`,
      [contributionId],
    );
    await tx.query(
      `INSERT INTO ledger_transactions
        (branch_id, tenant_id, transaction_type, amount_pence, reference_type, reference_id, external_reference, status)
       VALUES ($1, $2, 'contribution_received', $3, 'contribution', $4, $5, 'reconciled')`,
      [contribution.branch_id, contribution.tenant_id, contribution.amount_pence, contribution.id, input.paymentReference ?? null],
    );
    const reconciled = await tx.query<{count:number}>(
      "SELECT COUNT(*)::int AS count FROM contributions WHERE period_id = $1 AND status = 'reconciled'",
      [contribution.period_id],
    );
    if (reconciled.rows[0].count === contribution.capacity) {
      await tx.query("UPDATE contribution_periods SET status = 'completed' WHERE id = $1", [contribution.period_id]);
      await tx.query(
        "UPDATE contribution_periods SET status = 'open' WHERE tenant_id = $1 AND period_number = (SELECT period_number + 1 FROM contribution_periods WHERE id = $2) AND status = 'scheduled'",
        [contribution.tenant_id, contribution.period_id],
      );
    }
    return result.rows[0];
  });
  res.json({ ok: true, data: updated });
}));

router.get('/tenant/:tenantId/progress', requireAuth, asyncRoute(async (req, res) => {
  const tenantId = z.string().uuid().parse(req.params.tenantId);
  const access = await pool.query(
    `SELECT 1 FROM tenants t
     WHERE t.id = $1 AND (
       EXISTS (SELECT 1 FROM tenant_members tm WHERE tm.tenant_id = t.id AND tm.user_id = $2 AND tm.registration_status = 'registered')
       OR EXISTS (SELECT 1 FROM branch_admins ba WHERE ba.branch_id = t.branch_id AND ba.user_id = $2 AND ba.status = 'active')
       OR $3::boolean
     )`,
    [tenantId, req.auth!.userId, req.auth!.role === 'SUPER_ADMIN'],
  );
  if (!access.rowCount) throw new AppError({ code: 'TENANT_FORBIDDEN', httpStatus: 403, message: 'You cannot view this circle progress' });
  const summary = await pool.query(
    `SELECT t.id AS tenant_id, t.status, t.capacity,
            c.contribution_amount_pence, c.frequency, c.duration_periods,
            COUNT(DISTINCT tm.id) FILTER (WHERE tm.registration_status = 'registered')::int AS occupied_positions,
            COUNT(DISTINCT tm.id) FILTER (
              WHERE tm.registration_status = 'registered'
                AND tm.onboarding_status = 'approved'
                AND tm.verification_status = 'approved'
            )::int AS verified_members,
            COUNT(DISTINCT cp.id)::int AS scheduled_periods,
            COUNT(DISTINCT cp.id) * t.capacity AS expected_contributions,
            COUNT(DISTINCT co.id) FILTER (WHERE co.status IN ('received', 'reconciled'))::int AS received_contributions,
            COALESCE(SUM(co.amount_pence) FILTER (WHERE co.status IN ('received', 'reconciled')), 0)::text AS received_amount_pence
     FROM tenants t
     JOIN circle_configurations c ON c.id = t.configuration_id
     LEFT JOIN tenant_members tm ON tm.tenant_id = t.id
     LEFT JOIN contribution_periods cp ON cp.tenant_id = t.id
     LEFT JOIN contributions co ON co.period_id = cp.id AND co.tenant_member_id = tm.id
     WHERE t.id = $1
     GROUP BY t.id, c.id`,
    [tenantId],
  );
  const row = summary.rows[0];
  const outstanding = Number(row.expected_contributions) - Number(row.received_contributions);
  res.json({ ok: true, data: {
    ...row,
    outstanding_contributions: outstanding,
    collection_progress_percent: Number(row.expected_contributions) === 0 ? 0 :
      Math.round(Number(row.received_contributions) / Number(row.expected_contributions) * 10_000) / 100,
  }});
}));

export { router as contributionsRoutes };
