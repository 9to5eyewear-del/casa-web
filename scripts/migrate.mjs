// Applies db/migrations/*.sql to the database in DATABASE_URL_UNPOOLED (or
// DATABASE_URL), in order, each in its own transaction. Already-applied files
// are recorded in schema_migrations and skipped.
//
//   vercel env pull .env.local && node --env-file=.env.local scripts/migrate.mjs

import { readFileSync, readdirSync } from 'node:fs';
import { Pool } from '@neondatabase/serverless';

const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL_UNPOOLED / DATABASE_URL is not set');
  process.exit(1);
}

const dir = new URL('../db/migrations/', import.meta.url);
const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
const pool = new Pool({ connectionString: url });
const client = await pool.connect();

try {
  await client.query(`create table if not exists schema_migrations (
    name text primary key, applied_at timestamptz not null default now())`);
  const { rows } = await client.query('select name from schema_migrations');
  const applied = new Set(rows.map((r) => r.name));

  for (const file of files) {
    if (applied.has(file)) {
      console.log(`skip     ${file}`);
      continue;
    }
    await client.query('begin');
    try {
      await client.query(readFileSync(new URL(file, dir), 'utf8'));
      await client.query('insert into schema_migrations (name) values ($1)', [file]);
      await client.query('commit');
      console.log(`applied  ${file}`);
    } catch (err) {
      await client.query('rollback');
      throw new Error(`${file}: ${err.message}`);
    }
  }
} finally {
  client.release();
  await pool.end();
}
