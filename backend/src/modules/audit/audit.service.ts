/**
 * Audit service.
 *
 * Writes append-only records to audit_logs. Never throws — a failed audit
 * write must never break the business operation, but it is logged loudly.
 */

import type { PoolClient } from 'pg';
import { pool } from '../../db';
import { logger } from '../../logger';

export interface AuditEvent {
  actorId?: string | null;
  action: string;
  entityType?: string;
  entityId?: string;
  ipAddress?: string;
  userAgent?: string;
  metadata?: Record<string, unknown>;
}

export async function record(event: AuditEvent, tx?: PoolClient): Promise<void> {
  const runner = tx ?? pool;

  try {
    await runner.query(
      `INSERT INTO audit_logs
         (actor_id, action, entity_type, entity_id, ip_address, user_agent, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        event.actorId ?? null,
        event.action,
        event.entityType ?? null,
        event.entityId ?? null,
        event.ipAddress ?? null,
        event.userAgent ?? null,
        event.metadata ?? {},
      ],
    );
  } catch (err) {
    logger.error({ err, event }, 'Audit log write failed');
  }
}

/** Known action codes — keep centralised so they don't drift. */
export const AuditAction = {
  USER_REGISTERED: 'USER_REGISTERED',
  USER_LOGGED_IN: 'USER_LOGGED_IN',
  LOGIN_FAILED: 'LOGIN_FAILED',
  TOKEN_REFRESHED: 'TOKEN_REFRESHED',
  TOKEN_REVOKED: 'TOKEN_REVOKED',
  TOKEN_REUSED: 'TOKEN_REUSED',
  LOGOUT: 'LOGOUT',
} as const;

export type AuditAction = (typeof AuditAction)[keyof typeof AuditAction];