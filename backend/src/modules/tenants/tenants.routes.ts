import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { pool, withTransaction } from '../../db';
import { AppError } from '../../errors/AppError';
import { requireAuth } from '../auth/auth.middleware';

const router = Router();
const joinSchema = z.object({ configurationId: z.string().uuid() }).strict();
const asyncRoute = (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => { void fn(req, res).catch(next); };

router.post('/join', requireAuth, asyncRoute(async (req, res) => {
  const { configurationId } = joinSchema.parse(req.body);
  const joined = await withTransaction(async (tx) => {
    const configResult = await tx.query<{
      id:string;branch_id:string;max_co_savers:number;status:string;public_join_enabled:boolean;
    }>(
      `SELECT id, branch_id, max_co_savers, status, public_join_enabled
       FROM circle_configurations WHERE id = $1 FOR UPDATE`,
      [configurationId],
    );
    const config = configResult.rows[0];
    if (!config || config.status !== 'active' || !config.public_join_enabled) {
      throw new AppError({ code: 'CONFIGURATION_UNAVAILABLE', httpStatus: 404, message: 'This circle configuration is not available for joining' });
    }

    const userResult = await tx.query<{id:string;phone_verified_at:Date|null}>(
      'SELECT id, phone_verified_at FROM users WHERE id = $1 FOR UPDATE', [req.auth!.userId],
    );
    const user = userResult.rows[0];
    if (!user || !user.phone_verified_at) {
      throw new AppError({ code: 'PHONE_VERIFICATION_REQUIRED', httpStatus: 403, message: 'Verify your phone number before joining a circle' });
    }

    let tenantResult = await tx.query<{id:string;tenant_sequence:number;capacity:number}>(
      `SELECT id, tenant_sequence, capacity FROM tenants
       WHERE configuration_id = $1 AND status = 'filling'
       ORDER BY tenant_sequence DESC LIMIT 1 FOR UPDATE`,
      [configurationId],
    );
    let tenant = tenantResult.rows[0];
    if (!tenant) {
      const sequenceResult = await tx.query<{next_sequence:number}>(
        'SELECT COALESCE(MAX(tenant_sequence), 0) + 1 AS next_sequence FROM tenants WHERE configuration_id = $1',
        [configurationId],
      );
      const created = await tx.query<{id:string;tenant_sequence:number;capacity:number}>(
        `INSERT INTO tenants (branch_id, configuration_id, tenant_sequence, capacity)
         VALUES ($1, $2, $3, $4) RETURNING id, tenant_sequence, capacity`,
        [config.branch_id, config.id, sequenceResult.rows[0].next_sequence, config.max_co_savers],
      );
      tenant = created.rows[0];
    }

    const duplicate = await tx.query('SELECT id FROM tenant_members WHERE tenant_id = $1 AND user_id = $2', [tenant.id, user.id]);
    if (duplicate.rowCount) throw new AppError({ code: 'ALREADY_IN_CIRCLE', httpStatus: 409, message: 'You have already joined this circle group' });

    const positionResult = await tx.query<{position:number}>(
      `SELECT slot.position
       FROM generate_series(1, $2::integer) AS slot(position)
       WHERE NOT EXISTS (
         SELECT 1 FROM tenant_members tm
         WHERE tm.tenant_id = $1 AND tm.position = slot.position
           AND tm.registration_status = 'registered'
       )
       ORDER BY slot.position LIMIT 1`,
      [tenant.id, tenant.capacity],
    );
    const position = positionResult.rows[0]?.position;
    if (!position) throw new AppError({ code: 'CIRCLE_FULL', httpStatus: 409, message: 'This circle has reached its configured capacity' });

    const memberResult = await tx.query<{id:string}>(
      `INSERT INTO tenant_members (tenant_id, user_id, position)
       VALUES ($1, $2, $3) RETURNING id`,
      [tenant.id, user.id, position],
    );

    const countResult = await tx.query<{occupied:number}>(
      "SELECT COUNT(*)::int AS occupied FROM tenant_members WHERE tenant_id = $1 AND registration_status = 'registered'",
      [tenant.id],
    );
    const full = countResult.rows[0].occupied === tenant.capacity;
    if (full) {
      await tx.query("UPDATE tenants SET status = 'awaiting_verification' WHERE id = $1", [tenant.id]);
      const nextSequence = tenant.tenant_sequence + 1;
      await tx.query(
        `INSERT INTO tenants (branch_id, configuration_id, tenant_sequence, capacity)
         VALUES ($1, $2, $3, $4)`,
        [config.branch_id, config.id, nextSequence, config.max_co_savers],
      );
    }

    await tx.query(
      `INSERT INTO lifecycle_events (branch_id, tenant_id, actor_user_id, entity_type, entity_id, event_type, new_state, metadata)
       VALUES ($1, $2, $3, 'tenant_member', $4, 'member_joined', 'registered', $5::jsonb)`,
      [config.branch_id, tenant.id, user.id, memberResult.rows[0].id, JSON.stringify({ position, capacity: tenant.capacity })],
    );
    await tx.query(
      `INSERT INTO notifications (user_id, tenant_id, channel, notification_type, payload, status, sent_at)
       VALUES ($1, $2, 'in_app', 'tenant.member_joined', $3::jsonb, 'sent', NOW())`,
      [user.id, tenant.id, JSON.stringify({ position, capacity: tenant.capacity, tenantSequence: tenant.tenant_sequence })],
    );

    return {
      tenantId: tenant.id,
      tenantSequence: tenant.tenant_sequence,
      position,
      capacity: tenant.capacity,
      occupiedPositions: countResult.rows[0].occupied,
      tenantStatus: full ? 'awaiting_verification' : 'filling',
      nextTenantCreated: full,
    };
  });
  res.status(201).json({ ok: true, data: joined });
}));


const verificationSchema = z.object({
  onboardingStatus: z.enum(['approved', 'rejected']),
  verificationStatus: z.enum(['approved', 'rejected']),
}).strict();

router.patch('/:tenantId/members/:memberId/verification', requireAuth, asyncRoute(async (req, res) => {
  const tenantId = z.string().uuid().parse(req.params.tenantId);
  const memberId = z.string().uuid().parse(req.params.memberId);
  const input = verificationSchema.parse(req.body);
  const result = await withTransaction(async (tx) => {
    const tenantResult = await tx.query<{
      id:string;branch_id:string;capacity:number;configuration_id:string;status:string;
    }>('SELECT id, branch_id, capacity, configuration_id, status FROM tenants WHERE id = $1 FOR UPDATE', [tenantId]);
    const tenant = tenantResult.rows[0];
    if (!tenant) throw new AppError({ code: 'TENANT_NOT_FOUND', httpStatus: 404, message: 'Circle group not found' });

    if (req.auth!.role !== 'SUPER_ADMIN') {
      const admin = await tx.query(
        "SELECT 1 FROM branch_admins WHERE branch_id = $1 AND user_id = $2 AND status = 'active'",
        [tenant.branch_id, req.auth!.userId],
      );
      if (!admin.rowCount) throw new AppError({ code: 'BRANCH_FORBIDDEN', httpStatus: 403, message: 'You cannot verify members in this branch' });
    }
    if (!['awaiting_verification', 'filling'].includes(tenant.status)) {
      throw new AppError({ code: 'TENANT_NOT_VERIFYING', httpStatus: 409, message: 'This circle group is not awaiting member verification' });
    }

    const updated = await tx.query(
      `UPDATE tenant_members SET onboarding_status = $1, verification_status = $2,
         verified_at = CASE WHEN $1 = 'approved' AND $2 = 'approved' THEN NOW() ELSE NULL END
       WHERE id = $3 AND tenant_id = $4 AND registration_status = 'registered'
       RETURNING id`,
      [input.onboardingStatus, input.verificationStatus, memberId, tenantId],
    );
    if (!updated.rowCount) throw new AppError({ code: 'MEMBER_NOT_FOUND', httpStatus: 404, message: 'Registered circle member not found' });
    const kycStatus = input.onboardingStatus === 'approved' && input.verificationStatus === 'approved' ? 'approved' : 'rejected';
    const reviewedKyc = await tx.query(
      `UPDATE kyc_records SET status = $1, reviewed_at = NOW(), reviewed_by_user_id = $2
       WHERE tenant_member_id = $3 AND status IN ('submitted', 'under_review')
       RETURNING id`,
      [kycStatus, req.auth!.userId, memberId],
    );
    if (kycStatus === 'approved' && !reviewedKyc.rowCount) {
      throw new AppError({ code: 'KYC_SUBMISSION_REQUIRED', httpStatus: 409, message: 'The member must submit KYC before verification approval' });
    }

    const configResult = await tx.query<{frequency:'weekly'|'monthly';duration_periods:number}>(
      'SELECT frequency, duration_periods FROM circle_configurations WHERE id = $1',
      [tenant.configuration_id],
    );
    const config = configResult.rows[0];
    const counts = await tx.query<{occupied:number;eligible:number}>(
      `SELECT COUNT(*) FILTER (WHERE tm.registration_status = 'registered')::int AS occupied,
              COUNT(*) FILTER (
                WHERE tm.registration_status = 'registered'
                  AND tm.onboarding_status = 'approved'
                  AND tm.verification_status = 'approved'
                  AND u.phone_verified_at IS NOT NULL
              )::int AS eligible
       FROM tenant_members tm JOIN users u ON u.id = tm.user_id
       WHERE tm.tenant_id = $1`,
      [tenantId],
    );
    let activated = false;
    if (tenant.status === 'awaiting_verification'
      && counts.rows[0].occupied === tenant.capacity
      && counts.rows[0].eligible === tenant.capacity) {
      await tx.query(
        `UPDATE tenants SET status = 'active', activated_at = NOW(),
           schedule_start_at = NOW(),
           schedule_end_at = NOW() + CASE WHEN $2 = 'weekly'
             THEN make_interval(weeks => $3) ELSE make_interval(months => $3) END
         WHERE id = $1`,
        [tenantId, config.frequency, config.duration_periods],
      );
      await tx.query(
        `INSERT INTO contribution_periods
          (tenant_id, period_number, period_start_at, due_at, period_end_at)
         SELECT $1, period_number,
           activation_time + CASE WHEN $2 = 'weekly'
             THEN make_interval(weeks => period_number - 1)
             ELSE make_interval(months => period_number - 1) END,
           activation_time + CASE WHEN $2 = 'weekly'
             THEN make_interval(weeks => period_number)
             ELSE make_interval(months => period_number) END,
           activation_time + CASE WHEN $2 = 'weekly'
             THEN make_interval(weeks => period_number)
             ELSE make_interval(months => period_number) END
         FROM generate_series(1, $3::integer) AS periods(period_number)
         CROSS JOIN (SELECT activated_at AS activation_time FROM tenants WHERE id = $1) activation`,
        [tenantId, config.frequency, config.duration_periods],
      );
      await tx.query(
        "UPDATE contribution_periods SET status = 'open' WHERE tenant_id = $1 AND period_number = 1",
        [tenantId],
      );
      await tx.query(
        `INSERT INTO lifecycle_events
          (branch_id, tenant_id, actor_user_id, entity_type, entity_id, event_type, previous_state, new_state, metadata)
         VALUES ($1, $2, $3, 'tenant', $2, 'tenant_activated', 'awaiting_verification', 'active', $4::jsonb)`,
        [tenant.branch_id, tenantId, req.auth!.userId, JSON.stringify({ capacity: tenant.capacity, durationPeriods: config.duration_periods, frequency: config.frequency })],
      );
      await tx.query(
        `INSERT INTO notifications (user_id, tenant_id, channel, notification_type, payload, status, sent_at)
         SELECT user_id, $1, 'in_app', 'tenant.activated', $2::jsonb, 'sent', NOW()
         FROM tenant_members WHERE tenant_id = $1 AND registration_status = 'registered'`,
        [tenantId, JSON.stringify({ capacity: tenant.capacity, durationPeriods: config.duration_periods, frequency: config.frequency })],
      );
      activated = true;
    }
    return { tenantId, memberId, onboardingStatus: input.onboardingStatus, verificationStatus: input.verificationStatus, occupied: counts.rows[0].occupied, verified: counts.rows[0].eligible, capacity: tenant.capacity, activated };
  });
  res.json({ ok: true, data: result });
}));


router.get('/:tenantId/schedule', requireAuth, asyncRoute(async (req, res) => {
  const tenantId = z.string().uuid().parse(req.params.tenantId);
  const access = await pool.query(
    `SELECT 1 FROM tenants t WHERE t.id = $1 AND (
      EXISTS (SELECT 1 FROM tenant_members tm WHERE tm.tenant_id = t.id AND tm.user_id = $2 AND tm.registration_status = 'registered')
      OR EXISTS (SELECT 1 FROM branch_admins ba WHERE ba.branch_id = t.branch_id AND ba.user_id = $2 AND ba.status = 'active')
      OR $3::boolean
    )`,
    [tenantId, req.auth!.userId, req.auth!.role === 'SUPER_ADMIN'],
  );
  if (!access.rowCount) throw new AppError({ code: 'TENANT_FORBIDDEN', httpStatus: 403, message: 'You cannot view this circle schedule' });
  const result = await pool.query(
    `SELECT cp.id, cp.period_number, cp.period_start_at, cp.due_at, cp.period_end_at, cp.status,
            pi.id AS payout_intent_id, pi.status AS payout_status,
            pi.gross_pool_pence, pi.tvc_adjustment_pence, pi.amount_after_tvc_pence,
            pi.platform_fee_pence, pi.net_payout_pence
     FROM contribution_periods cp
     LEFT JOIN payout_intents pi
       ON pi.tenant_id = cp.tenant_id AND pi.collection_position = cp.period_number
     WHERE cp.tenant_id = $1 ORDER BY cp.period_number`,
    [tenantId],
  );
  res.json({ ok: true, data: result.rows });
}));

export { router as tenantsRoutes };
