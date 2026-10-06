import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { createDb, sqlRpc } from '../api/_lib/db.js';

const MIGRATIONS = new URL('../db/migrations/', import.meta.url);

// A real Postgres (PGlite) with the production migrations applied.
export async function createTestDb() {
  const pg = new PGlite();
  for (const file of readdirSync(MIGRATIONS).sort()) {
    await pg.exec(readFileSync(new URL(file, MIGRATIONS), 'utf8'));
  }

  const rpc = sqlRpc(async (text, params) => (await pg.query(text, params)).rows);
  return { pg, rpc, db: createDb(rpc) };
}

export function mockReq({ method = 'GET', body, headers = {}, query = {} } = {}) {
  return {
    method,
    body,
    query,
    headers: { host: 'www.casamancini.site', 'x-forwarded-for': '203.0.113.7', ...headers },
  };
}

export function mockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: undefined,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    end(text) { this.body = text ? JSON.parse(text) : undefined; },
  };
  return res;
}

export function silentLog() {
  const entries = [];
  const push = (level) => (event, data) => entries.push({ level, event, ...data });
  return { entries, info: push('info'), warn: push('warn'), error: push('error') };
}

export const STAFF = { id: '11111111-1111-4111-8111-111111111111', email: 'team@casamancini.site' };

// Stands in for Supabase Auth: "Bearer good" is staff, "Bearer outsider" is a
// valid user who isn't on the allowlist, anything else is rejected.
export async function fakeRequireStaff(req) {
  const auth = req.headers.authorization;
  if (auth === 'Bearer good') return { user: STAFF };
  if (auth === 'Bearer outsider') return { status: 403, error: 'forbidden' };
  return { status: 401, error: 'unauthorized' };
}
