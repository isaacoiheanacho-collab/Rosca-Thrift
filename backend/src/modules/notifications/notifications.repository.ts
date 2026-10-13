/**
 * Notifications repository — SQL for the feed + push subscriptions.
 */

import type { PoolClient } from 'pg';
import { pool } from '../../db';

export interface NotificationRow {
  id: string;
  user_id: string;
  tenant_id: string | null;
  branch_id: string | null;
  kind: string;
  title: string;
  body: string;
  metadata: Record<string, unknown>;
  read_at: Date | null;
  pushed_at: Date | null;
  push_failed_at: Date | null;
  push_error: string | null;
  created_at: Date;
}

export interface PushSubscriptionRow {
  id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  user_agent: string | null;
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
}

export class NotificationsRepository {
  // ---- Feed ----

  async insert(
    data: {
      userId: string;
      tenantId: string | null;
      branchId: string | null;
      kind: string;
      title: string;
      body: string;
      metadata: Record<string, unknown>;
    },
    tx?: PoolClient,
  ): Promise<NotificationRow> {
    const runner = tx ?? pool;
    const result = await runner.query<NotificationRow>(
      `INSERT INTO notifications
         (user_id, tenant_id, branch_id, kind, title, body, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        data.userId,
        data.tenantId,
        data.branchId,
        data.kind,
        data.title,
        data.body,
        data.metadata,
      ],
    );
    return result.rows[0]!;
  }

  async insertMany(
    rows: Array<{
      userId: string;
      tenantId: string | null;
      branchId: string | null;
      kind: string;
      title: string;
      body: string;
      metadata: Record<string, unknown>;
    }>,
    tx?: PoolClient,
  ): Promise<NotificationRow[]> {
    if (rows.length === 0) return [];
    const runner = tx ?? pool;

    const values: unknown[] = [];
    const placeholders: string[] = [];
    let idx = 1;
    for (const r of rows) {
      placeholders.push(
        `($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++})`,
      );
      values.push(
        r.userId,
        r.tenantId,
        r.branchId,
        r.kind,
        r.title,
        r.body,
        r.metadata,
      );
    }

    const result = await runner.query<NotificationRow>(
      `INSERT INTO notifications
         (user_id, tenant_id, branch_id, kind, title, body, metadata)
       VALUES ${placeholders.join(', ')}
       RETURNING *`,
      values,
    );
    return result.rows;
  }

  async findById(id: string): Promise<NotificationRow | null> {
    const result = await pool.query<NotificationRow>(
      'SELECT * FROM notifications WHERE id = $1',
      [id],
    );
    return result.rows[0] ?? null;
  }

  async listByUser(
    userId: string,
    options: { limit: number; offset: number; unreadOnly?: boolean },
  ): Promise<{ notifications: NotificationRow[]; total: number }> {
    const conditions: string[] = ['user_id = $1'];
    const params: unknown[] = [userId];

    if (options.unreadOnly) {
      conditions.push('read_at IS NULL');
    }

    const where = `WHERE ${conditions.join(' AND ')}`;

    const countResult = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM notifications ${where}`,
      params,
    );
    const total = Number(countResult.rows[0]?.count ?? '0');

    params.push(options.limit);
    const limitIdx = params.length;
    params.push(options.offset);
    const offsetIdx = params.length;

    const listResult = await pool.query<NotificationRow>(
      `SELECT * FROM notifications ${where}
       ORDER BY created_at DESC
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params,
    );

    return { notifications: listResult.rows, total };
  }

  async unreadCount(userId: string): Promise<number> {
    const result = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM notifications
       WHERE user_id = $1 AND read_at IS NULL`,
      [userId],
    );
    return Number(result.rows[0]?.count ?? '0');
  }

  async markRead(id: string, userId: string): Promise<NotificationRow | null> {
    const result = await pool.query<NotificationRow>(
      `UPDATE notifications
       SET read_at = COALESCE(read_at, NOW())
       WHERE id = $1 AND user_id = $2
       RETURNING *`,
      [id, userId],
    );
    return result.rows[0] ?? null;
  }

  async markAllRead(userId: string): Promise<number> {
    const result = await pool.query(
      `UPDATE notifications
       SET read_at = NOW()
       WHERE user_id = $1 AND read_at IS NULL`,
      [userId],
    );
    return result.rowCount ?? 0;
  }

  async markPushed(id: string): Promise<void> {
    await pool.query(`UPDATE notifications SET pushed_at = NOW() WHERE id = $1`, [id]);
  }

  async markPushFailed(id: string, error: string): Promise<void> {
    await pool.query(
      `UPDATE notifications
       SET push_failed_at = NOW(), push_error = $2
       WHERE id = $1`,
      [id, error.slice(0, 500)],
    );
  }

  /**
   * All user IDs with an ACTIVE membership in a tenant.
   * Used to fan out tenant-wide notifications.
   */
  async listTenantMemberUserIds(tenantId: string): Promise<string[]> {
    const result = await pool.query<{ user_id: string }>(
      `SELECT user_id FROM tenant_memberships
       WHERE tenant_id = $1 AND status != 'REMOVED'`,
      [tenantId],
    );
    return result.rows.map((r) => r.user_id);
  }

  /**
   * All super admin user IDs. Used for fee-related events.
   */
  async listSuperAdminUserIds(): Promise<string[]> {
    const result = await pool.query<{ id: string }>(
      `SELECT id FROM users WHERE role = 'SUPER_ADMIN' AND status != 'SUSPENDED'`,
    );
    return result.rows.map((r) => r.id);
  }

  /**
   * All branch admin user IDs for a given branch.
   */
  async listBranchAdminUserIds(branchId: string): Promise<string[]> {
    const result = await pool.query<{ id: string }>(
      `SELECT id FROM users
       WHERE role = 'BRANCH_ADMIN' AND branch_id = $1 AND status != 'SUSPENDED'`,
      [branchId],
    );
    return result.rows.map((r) => r.id);
  }

  // ---- Push subscriptions ----

  async upsertSubscription(data: {
    userId: string;
    endpoint: string;
    p256dh: string;
    auth: string;
    userAgent: string | null;
  }): Promise<PushSubscriptionRow> {
    const result = await pool.query<PushSubscriptionRow>(
      `INSERT INTO push_subscriptions
         (user_id, endpoint, p256dh, auth, user_agent)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (endpoint) DO UPDATE SET
         user_id    = EXCLUDED.user_id,
         p256dh     = EXCLUDED.p256dh,
         auth       = EXCLUDED.auth,
         user_agent = EXCLUDED.user_agent,
         revoked_at = NULL
       RETURNING *`,
      [data.userId, data.endpoint, data.p256dh, data.auth, data.userAgent],
    );
    return result.rows[0]!;
  }

  async listActiveSubscriptions(userId: string): Promise<PushSubscriptionRow[]> {
    const result = await pool.query<PushSubscriptionRow>(
      `SELECT * FROM push_subscriptions
       WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId],
    );
    return result.rows;
  }

  async touchSubscription(id: string): Promise<void> {
    await pool.query(
      `UPDATE push_subscriptions SET last_used_at = NOW() WHERE id = $1`,
      [id],
    );
  }

  async revokeSubscription(id: string): Promise<void> {
    await pool.query(
      `UPDATE push_subscriptions SET revoked_at = NOW() WHERE id = $1`,
      [id],
    );
  }

  async revokeByEndpoint(endpoint: string, userId: string): Promise<void> {
    await pool.query(
      `UPDATE push_subscriptions
       SET revoked_at = NOW()
       WHERE endpoint = $1 AND user_id = $2 AND revoked_at IS NULL`,
      [endpoint, userId],
    );
  }

  async listUserSubscriptions(userId: string): Promise<PushSubscriptionRow[]> {
    const result = await pool.query<PushSubscriptionRow>(
      `SELECT * FROM push_subscriptions
       WHERE user_id = $1 AND revoked_at IS NULL
       ORDER BY created_at DESC`,
      [userId],
    );
    return result.rows;
  }
}

export const notificationsRepository = new NotificationsRepository();