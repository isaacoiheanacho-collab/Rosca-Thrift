import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { pool, withTransaction } from '../../db';
import { AppError } from '../../errors/AppError';
import { calculatePayout } from './payout-calculator';
import { requireAuth } from '../auth/auth.middleware';

const router = Router();
const intentSchema = z.object({
  tenantId: z.string().uuid(),
  collectionPosition: z.number().int().positive(),
}).strict();
const statusSchema = z.object({
  status: z.enum(['approved', 'paid', 'failed', 'reversed']),
  paymentProvider: z.string().trim().min(2).max(80).optional(),
  paymentReference: z.string().trim().min(3).max(160).optional(),
}).strict();
const asyncRoute = (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => { void fn(req, res).catch(next); };

async function assertBranchAccess(tx: import('pg').PoolClient, branchId: string, userId: string, role: string) {
  if (role === 'SUPER_ADMIN') return;
  const access = await tx.query(
    "SELECT 1 FROM branch_admins WHERE branch_id = $1 AND user_id = $2 AND status = 'active'",
    [branchId, userId],
  );
  if (!access.rowCount) throw new AppError({ code: 'BRANCH_FORBIDDEN', httpStatus: 403, message: 'You cannot manage payouts for this branch' });
}

router.post('/intents', requireAuth, asyncRoute(async (req, res) => {
  const input = intentSchema.parse(req.body);
  const intent = await withTransaction(async (tx) => {
    const tenantResult = await tx.query<{
      id:string;branch_id:string;capacity:number;status:string;configuration_id:string;
    }>('SELECT id, branch_id, capacity, status, configuration_id FROM tenants WHERE id = $1 FOR UPDATE', [input.tenantId]);
    const tenant = tenantResult.rows[0];
    if (!tenant) throw new AppError({ code: 'TENANT_NOT_FOUND', httpStatus: 404, message: 'Circle group not found' });
    await assertBranchAccess(tx, tenant.branch_id, req.auth!.userId, req.auth!.role);
    if (tenant.status !== 'active') throw new AppError({ code: 'TENANT_NOT_ACTIVE', httpStatus: 409, message: 'Payouts can only be prepared for an active circle group' });
    if (input.collectionPosition > tenant.capacity) throw new AppError({ code: 'INVALID_PAYOUT_POSITION', httpStatus: 400, message: 'Payout position exceeds this circle configured capacity' });

    const configResult = await tx.query<{contribution_amount_pence:string;collection_positions:number}>(
      'SELECT contribution_amount_pence, collection_positions FROM circle_configurations WHERE id = $1',
      [tenant.configuration_id],
    );
    const config = configResult.rows[0];
    if (!config || input.collectionPosition > config.collection_positions) {
      throw new AppError({ code: 'INVALID_PAYOUT_POSITION', httpStatus: 400, message: 'Payout position is not configured for this circle' });
    }
    const periodResult = await tx.query<{id:string;status:string}>(
      'SELECT id, status FROM contribution_periods WHERE tenant_id = $1 AND period_number = $2 FOR UPDATE',
      [tenant.id, input.collectionPosition],
    );
    const period = periodResult.rows[0];
    if (!period || !['open', 'completed'].includes(period.status)) {
      throw new AppError({ code: 'COLLECTION_NOT_READY', httpStatus: 409, message: 'The matching contribution period is not ready for payout' });
    }
    const paidContributions = await tx.query<{count:number}>(
      "SELECT COUNT(DISTINCT tenant_member_id)::int AS count FROM contributions WHERE period_id = $1 AND status = 'reconciled'",
      [period.id],
    );
    if (paidContributions.rows[0].count !== tenant.capacity) {
      throw new AppError({ code: 'COLLECTION_INCOMPLETE', httpStatus: 409, message: 'All configured member contributions must be reconciled before payout' });
    }
    const recipient = await tx.query<{id:string}>(
      `SELECT id FROM tenant_members WHERE tenant_id = $1 AND position = $2
       AND registration_status = 'registered' AND onboarding_status = 'approved'
       AND verification_status = 'approved'`,
      [tenant.id, input.collectionPosition],
    );
    if (!recipient.rowCount) throw new AppError({ code: 'PAYOUT_RECIPIENT_UNVERIFIED', httpStatus: 409, message: 'The member assigned to this payout position is not verified' });

    const calculation = calculatePayout({
      contributionAmountPence: BigInt(config.contribution_amount_pence),
      configuredCapacity: tenant.capacity,
      collectionPosition: input.collectionPosition,
    });
    const idempotencyKey = `payout:${tenant.id}:${input.collectionPosition}`;
    const created = await tx.query(
      `INSERT INTO payout_intents
        (tenant_id, collection_position, recipient_member_id, gross_pool_pence,
         tvc_adjustment_pence, amount_after_tvc_pence, platform_fee_bps,
         platform_fee_pence, net_payout_pence, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id, tenant_id, collection_position, recipient_member_id,
         gross_pool_pence, tvc_adjustment_pence, amount_after_tvc_pence,
         platform_fee_bps, platform_fee_pence, net_payout_pence, status, created_at`,
      [tenant.id, input.collectionPosition, recipient.rows[0].id,
       calculation.grossPoolPence.toString(), calculation.tvcAdjustmentPence.toString(),
       calculation.amountAfterTvcPence.toString(), Number(calculation.platformFeeBps),
       calculation.platformFeePence.toString(), calculation.netPayoutPence.toString(), idempotencyKey],
    );
    if (!created.rowCount) {
      const existing = await tx.query(
        'SELECT id, tenant_id, collection_position, recipient_member_id, gross_pool_pence, tvc_adjustment_pence, amount_after_tvc_pence, platform_fee_bps, platform_fee_pence, net_payout_pence, status, created_at FROM payout_intents WHERE idempotency_key = $1',
        [idempotencyKey],
      );
      return existing.rows[0];
    }
    return created.rows[0];
  });
  res.status(201).json({ ok: true, data: intent });
}));

router.patch('/intents/:intentId/status', requireAuth, asyncRoute(async (req, res) => {
  const intentId = z.string().uuid().parse(req.params.intentId);
  const input = statusSchema.parse(req.body);
  const updated = await withTransaction(async (tx) => {
    const found = await tx.query<{
      id:string;tenant_id:string;branch_id:string;status:string;net_payout_pence:string;
      platform_fee_pence:string;recipient_member_id:string;
    }>(
      `SELECT pi.id, pi.tenant_id, t.branch_id, pi.status, pi.net_payout_pence,
              pi.platform_fee_pence, pi.recipient_member_id
       FROM payout_intents pi JOIN tenants t ON t.id = pi.tenant_id
       WHERE pi.id = $1 FOR UPDATE OF pi`,
      [intentId],
    );
    const intent = found.rows[0];
    if (!intent) throw new AppError({ code: 'PAYOUT_INTENT_NOT_FOUND', httpStatus: 404, message: 'Payout intent not found' });
    await assertBranchAccess(tx, intent.branch_id, req.auth!.userId, req.auth!.role);

    const allowed =
      (input.status === 'approved' && ['pending', 'failed'].includes(intent.status)) ||
      (input.status === 'failed' && ['pending', 'approved'].includes(intent.status)) ||
      (input.status === 'paid' && intent.status === 'approved') ||
      (input.status === 'reversed' && intent.status === 'paid');
    if (!allowed) throw new AppError({ code: 'INVALID_PAYOUT_TRANSITION', httpStatus: 409, message: `Cannot move payout from ${intent.status} to ${input.status}` });
    if (input.status === 'paid' && !input.paymentReference) {
      throw new AppError({ code: 'PAYMENT_REFERENCE_REQUIRED', httpStatus: 400, message: 'A payment reference is required to confirm payout' });
    }

    const result = await tx.query(
      'UPDATE payout_intents SET status = $1, approved_at = CASE WHEN $1 = \'approved\' THEN COALESCE(approved_at, NOW()) ELSE approved_at END WHERE id = $2 RETURNING id, tenant_id, collection_position, recipient_member_id, gross_pool_pence, tvc_adjustment_pence, amount_after_tvc_pence, platform_fee_bps, platform_fee_pence, net_payout_pence, status, approved_at, created_at',
      [input.status, intentId],
    );

    if (input.status === 'paid' || input.status === 'failed') {
      await tx.query(
        `INSERT INTO payouts (payout_intent_id, status, payment_provider, payment_reference, paid_at)
         VALUES ($1, $2, $3, $4, CASE WHEN $2 = 'paid' THEN NOW() ELSE NULL END)
         ON CONFLICT (payout_intent_id) DO UPDATE SET
           status = EXCLUDED.status, payment_provider = EXCLUDED.payment_provider,
           payment_reference = EXCLUDED.payment_reference, paid_at = EXCLUDED.paid_at`,
        [intentId, input.status, input.paymentProvider ?? null, input.paymentReference ?? null],
      );
    }
    if (input.status === 'paid') {
      await tx.query(
        `INSERT INTO ledger_transactions
          (branch_id, tenant_id, transaction_type, amount_pence, reference_type, reference_id, external_reference, status)
         VALUES ($1, $2, 'payout_paid', $3, 'payout_intent', $4, $5, 'recorded')`,
        [intent.branch_id, intent.tenant_id, (-BigInt(intent.net_payout_pence)).toString(), intent.id, input.paymentReference],
      );
      if (BigInt(intent.platform_fee_pence) > 0n) {
        await tx.query(
          `INSERT INTO ledger_transactions
            (branch_id, tenant_id, transaction_type, amount_pence, reference_type, reference_id, external_reference, status)
           VALUES ($1, $2, 'platform_fee_withheld', $3, 'payout_intent', $4, $5, 'recorded')`,
          [intent.branch_id, intent.tenant_id, (-BigInt(intent.platform_fee_pence)).toString(), intent.id, input.paymentReference],
        );
      }
    }
    if (input.status === 'reversed') {
      await tx.query("UPDATE payouts SET status = 'reversed' WHERE payout_intent_id = $1", [intentId]);
      await tx.query("UPDATE ledger_transactions SET status = 'reversed' WHERE reference_type = 'payout_intent' AND reference_id = $1", [intentId]);
    }
    return result.rows[0];
  });
  res.json({ ok: true, data: updated });
}));

export { router as payoutsRoutes };
