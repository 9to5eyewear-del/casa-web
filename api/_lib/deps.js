import { createDb, supabaseRpc } from './db.js';
import { createStaffAuth, parseEmailList } from './auth.js';

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

// Built per request so a missing variable fails loudly in the logs instead
// of at import time.
export function productionDeps() {
  const url = required('SUPABASE_URL').replace(/\/+$/, '');
  const serviceKey = required('SUPABASE_SERVICE_ROLE_KEY');
  return {
    db: createDb(supabaseRpc({ url, serviceKey })),
    // The IP hash is keyed with the service key: nothing extra to configure,
    // and rotating the key only resets the 10-minute rate-limit window.
    ipHashKey: serviceKey,
    get requireStaff() {
      return createStaffAuth({
        url,
        anonKey: required('SUPABASE_ANON_KEY'),
        allowedEmails: parseEmailList(required('LEADS_ADMIN_EMAILS')),
      });
    },
  };
}
