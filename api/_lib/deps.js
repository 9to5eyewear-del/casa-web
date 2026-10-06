import { neon } from '@neondatabase/serverless';
import webpush from 'web-push';
import { waitUntil } from '@vercel/functions';
import { createDb, sqlRpc, neonQuery } from './db.js';
import { createRequireSession } from './session.js';
import { createNotifier } from './push.js';
import { defaultLog } from './handlers.js';

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

// Built per request so a missing variable fails loudly in the logs instead
// of at import time. Getters keep each endpoint to the variables it uses.
export function productionDeps() {
  // DATABASE_URL is set by the Neon integration on Vercel.
  const db = createDb(sqlRpc(neonQuery(required('DATABASE_URL'), neon)));
  const env = process.env;
  const vapid = env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT
    ? { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: env.VAPID_SUBJECT }
    : null;

  return {
    db,
    get ipHashKey() { return required('IP_HASH_SECRET'); },
    get sessionSecret() { return required('SESSION_SECRET'); },
    get passwordHash() { return required('LEADS_PASSWORD_HASH'); },
    get cronSecret() { return required('CRON_SECRET'); },
    get requireStaff() { return createRequireSession(required('SESSION_SECRET')); },
    vapidPublicKey: vapid?.publicKey ?? null,
    // Push is best-effort: without VAPID keys leads are still saved.
    notify: vapid ? createNotifier({ db, webpush, vapid, log: defaultLog }) : null,
    waitUntil,
  };
}
