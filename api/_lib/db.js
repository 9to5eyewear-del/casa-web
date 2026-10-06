// All lead data access goes through the SQL functions in
// supabase/migrations, so dedupe / status rules run atomically in Postgres.
// `rpc(fn, args)` is injectable: Supabase REST in production, PGlite in tests.

export function createDb(rpc) {
  return {
    ingestLead: (lead, { submissionId, ipHash, rateMax, rateWindowSeconds }) =>
      rpc('ingest_lead', {
        p_lead: lead,
        p_submission_id: submissionId,
        p_ip_hash: ipHash,
        p_rate_max: rateMax,
        p_rate_window_seconds: rateWindowSeconds,
      }),
    listLeads: ({ status = null, source = null, query = null, cursorTs = null, cursorId = null, limit = 30 }) =>
      rpc('list_leads', {
        p_status: status,
        p_source: source,
        p_query: query,
        p_cursor_ts: cursorTs,
        p_cursor_id: cursorId,
        p_limit: limit,
      }),
    statusCounts: () => rpc('lead_status_counts', {}),
    getLead: (id) => rpc('get_lead', { p_lead_id: id }),
    setStatus: (id, status, actor) =>
      rpc('set_lead_status', {
        p_lead_id: id,
        p_status: status,
        p_actor_id: actor?.id ?? null,
        p_actor_email: actor?.email ?? null,
      }),
  };
}

export function supabaseRpc({ url, serviceKey, fetchImpl = fetch, timeoutMs = 8000 }) {
  const headers = { apikey: serviceKey, 'Content-Type': 'application/json' };
  // Legacy service_role keys are JWTs and go in Authorization too; the new
  // sb_secret_ keys must only be sent as apikey.
  if (serviceKey.startsWith('eyJ')) headers.Authorization = `Bearer ${serviceKey}`;

  return async function rpc(fn, args) {
    const res = await fetchImpl(`${url}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) {
      const err = new Error(`rpc ${fn} failed: ${res.status} ${text.slice(0, 300)}`);
      err.status = res.status;
      throw err;
    }
    return text ? JSON.parse(text) : null;
  };
}
