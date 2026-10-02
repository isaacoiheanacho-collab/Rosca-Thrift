/**
 * Migration runner.
 *
 * Reads every .sql file in src/sql/ in alphabetical order, applies any that
 * haven't been recorded in schema_migrations yet, then exits.
 *
 * Run with:  npm run migrate
 */

import fs from 'node:fs';
import path from 'node:path';
import { pool } from './db';

const SQL_DIR = path.join(__dirname, 'sql');

async function ensureMigrationsTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id            SERIAL PRIMARY KEY,
      filename      TEXT NOT NULL UNIQUE,
      applied_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function getApplied(): Promise<Set<string>> {
  const result = await pool.query<{ filename: string }>(
    'SELECT filename FROM schema_migrations ORDER BY filename',
  );
  return new Set(result.rows.map((r) => r.filename));
}

async function applyMigration(filename: string): Promise<void> {
  const fullPath = path.join(SQL_DIR, filename);
  const sql = fs.readFileSync(fullPath, 'utf8');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [filename]);
    await client.query('COMMIT');
    console.log(`  ✅ ${filename}`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(`  ❌ ${filename} FAILED — rolled back`);
    throw err;
  } finally {
    client.release();
  }
}

async function main(): Promise<void> {
  console.log('🔄 Running migrations…\n');

  if (!fs.existsSync(SQL_DIR)) {
    console.log('   (no src/sql/ folder found — nothing to do)');
    return;
  }

  await ensureMigrationsTable();
  const applied = await getApplied();

  const files = fs
    .readdirSync(SQL_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  let count = 0;
  for (const file of files) {
    if (applied.has(file)) {
      console.log(`  ⏭  ${file} (already applied)`);
      continue;
    }
    await applyMigration(file);
    count++;
  }

  console.log(`\n✅ Done. ${count} new migration(s) applied.`);
}

main()
  .then(() => pool.end())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error('\n❌ Migration failed:', err);
    await pool.end();
    process.exit(1);
  });