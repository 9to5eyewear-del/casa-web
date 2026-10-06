import { neon } from '@neondatabase/serverless';
import { createDb, sqlRpc, neonQuery } from './db.js';

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

// Built per request so a missing variable fails loudly in the logs instead
// of at import time.
export function productionDeps() {
  // DATABASE_URL is set by the Neon integration on Vercel.
  const databaseUrl = required('DATABASE_URL');
  return {
    db: createDb(sqlRpc(neonQuery(databaseUrl, neon))),
    // The IP hash is keyed with the DB secret: nothing extra to configure,
    // and rotating it only resets the 10-minute rate-limit window.
    ipHashKey: databaseUrl,
    // Staff login is being replaced (Supabase Auth is gone). Until then every
    // private endpoint fails closed.
    requireStaff: async () => ({ status: 503, error: 'auth_not_configured' }),
  };
}
