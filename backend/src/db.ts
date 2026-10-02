/**
 * Postgres connection pool.
 *
 * - Uses DATABASE_URL (Neon pooled connection).
 * - Exposes `pool` for single queries and `withTransaction(fn)` for atomic work.
 * - Connection lifecycle is logged so we can see pool exhaustion early.
 */

import { Pool, type PoolClient, type PoolConfig } from 'pg';
import { env } from './config/env';
import { logger } from './logger';

const config: PoolConfig = {
  connectionString: env.DATABASE_URL,
  ssl: env.IS_PRODUCTION ? { rejectUnauthorized: true } : { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  statement_timeout: 15_000,      // kill queries that run > 15s
  query_timeout: 15_000,
};

export const pool = new Pool(config);

pool.on('connect', () => {
  logger.debug('Postgres: new client connected');
});

pool.on('remove', () => {
  logger.debug('Postgres: client removed from pool');
});

pool.on('error', (err) => {
  logger.error({ err }, 'Postgres: unexpected pool error');
});

/**
 * Run a function inside a single database transaction.
 * Automatically COMMITs on success, ROLLBACKs on any throw.
 *
 * Usage:
 *   await withTransaction(async (tx) => {
 *     await tx.query('INSERT ...');
 *     await tx.query('UPDATE ...');
 *   });
 */
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      logger.error({ err: rollbackErr }, 'Postgres: rollback failed');
    }
    throw err;
  } finally {
    client.release();
  }
}

/** Ping the database. Used by /health. */
export async function testConnection(): Promise<
  | { ok: true; latencyMs: number; serverTime: string }
  | { ok: false; error: string }
> {
  const start = Date.now();
  try {
    const result = await pool.query<{ now: Date }>('SELECT NOW() as now');
    return {
      ok: true,
      latencyMs: Date.now() - start,
      serverTime: result.rows[0]?.now?.toISOString() ?? 'unknown',
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}