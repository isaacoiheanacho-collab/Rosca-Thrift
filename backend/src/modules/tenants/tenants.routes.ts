import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { withTransaction } from '../../db';
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

export { router as tenantsRoutes };
