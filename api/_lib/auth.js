import { header } from './http.js';

// Staff auth for the private endpoints: a valid Supabase Auth session whose
// email is on LEADS_ADMIN_EMAILS. Sign-ups are disabled in Supabase, and the
// allowlist means an account alone still isn't enough.
//
// Returns { user } on success, or { status, error } to send back.
export function createStaffAuth({ url, anonKey, allowedEmails, fetchImpl = fetch, timeoutMs = 5000 }) {
  return async function requireStaff(req) {
    const m = /^Bearer\s+(\S+)$/i.exec(header(req, 'authorization') || '');
    if (!m) return { status: 401, error: 'unauthorized' };

    const res = await fetchImpl(`${url}/auth/v1/user`, {
      headers: { apikey: anonKey, Authorization: `Bearer ${m[1]}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 401 || res.status === 403) return { status: 401, error: 'unauthorized' };
    if (!res.ok) throw new Error(`auth check failed: ${res.status}`);

    const user = await res.json();
    const email = String(user.email || '').toLowerCase();
    if (!user.id || !allowedEmails.has(email)) return { status: 403, error: 'forbidden' };
    return { user: { id: user.id, email } };
  };
}

export function parseEmailList(value) {
  return new Set(String(value || '').split(/[\s,;]+/).map((e) => e.trim().toLowerCase()).filter(Boolean));
}
