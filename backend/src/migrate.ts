/**
 * Strict, transactional SQL migration runner.
 * Missing or empty migration directories are fatal.
 */

import fs from 'node:fs';
import path from 'node:path';
import { pool } from './db';

const SQL_DIR = path.join(__dirname, 'sql');

async function ensureMigrationsTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id BIGSERIAL PRIMARY KEY,
      filename TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function applyMigration(filename: string): Promise<void> {
  const sql = fs.readFileSync(path.join(SQL_DIR, filename), 'utf8');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [filename]);
    await client.query('COMMIT');
    console.log(`  ✓ ${filename}`);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error(`  ✗ ${filename} failed; transaction rolled back`);
    throw error;
  } finally {
    client.release();
  }
}

async function main(): Promise<void> {
  if (!fs.existsSync(SQL_DIR) || !fs.statSync(SQL_DIR).isDirectory()) {
    throw new Error(`Required migration directory is missing: ${SQL_DIR}`);
  }

  const files = fs.readdirSync(SQL_DIR).filter((file) => file.endsWith('.sql')).sort();
  if (files.length === 0) {
    throw new Error(`No SQL migrations found in required directory: ${SQL_DIR}`);
  }
  for (const file of files) {
    if (!/^\d{3,}_[a-z0-9_]+\.sql$/.test(file)) {
      throw new Error(`Invalid migration filename "${file}". Expected NNN_description.sql.`);
    }
  }

  await ensureMigrationsTable();
  const result = await pool.query<{ filename: string }>('SELECT filename FROM schema_migrations');
  const applied = new Set(result.rows.map((row) => row.filename));
  let appliedCount = 0;

  for (const file of files) {
    if (applied.has(file)) {
      console.log(`  - ${file} (already applied)`);
      continue;
    }
    await applyMigration(file);
    appliedCount += 1;
  }
  console.log(`Migration complete: ${appliedCount} new migration(s) applied.`);
}

main()
  .catch((error: unknown) => {
    console.error('Migration failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
