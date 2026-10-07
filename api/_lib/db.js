// All lead data access goes through the SQL functions in db/migrations, so
// dedupe / status rules run atomically in Postgres.

// sqlRpc serializes objects but passes arrays through (for uuid[] args);
// a jsonb array has to go as text.
const jsonArg = (v) => JSON.stringify(v);

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
    listLeads: ({ status = null, source = null, query = null, cursorTs = null, cursorId = null, limit = 30, flag = null }) =>
      rpc('list_leads', {
        p_status: status,
        p_source: source,
        p_query: query,
        p_cursor_ts: cursorTs,
        p_cursor_id: cursorId,
        p_limit: limit,
        p_flag: flag,
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

    loginGate: (ipHash, { ipMax, globalMax, windowSeconds }) =>
      rpc('login_gate', { p_ip_hash: ipHash, p_ip_max: ipMax, p_global_max: globalMax, p_window_seconds: windowSeconds }),
    recordLoginAttempt: (ipHash, success) =>
      rpc('record_login_attempt', { p_ip_hash: ipHash, p_success: success }),

    savePushSubscription: ({ endpoint, p256dh, auth, userAgent }) =>
      rpc('save_push_subscription', { p_endpoint: endpoint, p_p256dh: p256dh, p_auth: auth, p_user_agent: userAgent }),
    deletePushSubscription: (endpoint) => rpc('delete_push_subscription', { p_endpoint: endpoint }),
    listPushSubscriptions: () => rpc('list_push_subscriptions', {}),
    recordPushResults: (okIds, goneIds) => rpc('record_push_results', { p_ok: okIds, p_gone: goneIds }),

    unreadCount: () => rpc('unread_count', {}),
    markSeen: (id) => rpc('mark_lead_seen', { p_lead_id: id }),
    deleteLead: (id) => rpc('delete_lead', { p_lead_id: id }),
    dashboard: ({ range, from = null, to = null, now = null }) =>
      rpc('dashboard', { p_range: range, p_from: from, p_to: to, p_now: now }),
    claimDueReminders: (hours) => rpc('claim_due_reminders', { p_hours: hours }),

    // Judith AI (db/migrations/005)
    judithGate: (ipHash, sessionId, { ipMax, ipWindowSeconds, ipDailyMax, globalDailyMax, sessionMaxTurns }) =>
      rpc('judith_gate', {
        p_ip_hash: ipHash, p_session_id: sessionId, p_ip_max: ipMax, p_ip_window_seconds: ipWindowSeconds,
        p_ip_daily_max: ipDailyMax, p_global_daily_max: globalDailyMax, p_session_max_turns: sessionMaxTurns,
      }),
    judithLoad: (sessionId) => rpc('judith_load', { p_session_id: sessionId }),
    judithSaveTurn: ({ sessionId, ipHash, messages, state, qualified, handoffReady, leadSummary, handoffToken, handoffTtlSeconds }) =>
      rpc('judith_save_turn', {
        p_session_id: sessionId, p_ip_hash: ipHash, p_messages: jsonArg(messages), p_state: state,
        p_qualified: qualified, p_handoff_ready: handoffReady, p_lead_summary: leadSummary,
        p_handoff_token: handoffToken, p_handoff_ttl_seconds: handoffTtlSeconds,
      }),
    judithHandoff: (token) => rpc('judith_handoff', { p_token: token }),
    judithAttachLead: (token, leadId) => rpc('judith_attach_lead', { p_token: token, p_lead_id: leadId }),
    judithReset: (sessionId) => rpc('judith_reset', { p_session_id: sessionId }),
    judithFunnel: ({ range, from = null, to = null, now = null }) =>
      rpc('judith_funnel', { p_range: range, p_from: from, p_to: to, p_now: now }),
  };
}

// Calls one of the SQL functions with named arguments; each returns jsonb.
// `query(text, params) → rows` is Neon in production and PGlite in tests.
export function sqlRpc(query) {
  return async function rpc(fn, args) {
    if (!/^[a-z_]+$/.test(fn)) throw new Error(`bad function name: ${fn}`);
    const keys = Object.keys(args);
    const text = `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as r`;
    const params = keys.map((k) => {
      const v = args[k];
      return v !== null && typeof v === 'object' && !Array.isArray(v) ? JSON.stringify(v) : v;
    });
    const rows = await query(text, params);
    return rows[0].r;
  };
}

export function neonQuery(connectionString, neon, { timeoutMs = 8000 } = {}) {
  const sql = neon(connectionString);
  return (text, params) => sql.query(text, params, { fetchOptions: { signal: AbortSignal.timeout(timeoutMs) } });
}
