// All lead data access goes through the SQL functions in db/migrations, so
// dedupe / status rules run atomically in Postgres.

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

// Calls one of the SQL functions with named arguments; each returns jsonb.
// `query(text, params) → rows` is Neon in production and PGlite in tests.
export function sqlRpc(query) {
  return async function rpc(fn, args) {
    if (!/^[a-z_]+$/.test(fn)) throw new Error(`bad function name: ${fn}`);
    const keys = Object.keys(args);
    const text = `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as r`;
    const params = keys.map((k) => (args[k] !== null && typeof args[k] === 'object' ? JSON.stringify(args[k]) : args[k]));
    const rows = await query(text, params);
    return rows[0].r;
  };
}

export function neonQuery(connectionString, neon, { timeoutMs = 8000 } = {}) {
  const sql = neon(connectionString);
  return (text, params) => sql.query(text, params, { fetchOptions: { signal: AbortSignal.timeout(timeoutMs) } });
}
