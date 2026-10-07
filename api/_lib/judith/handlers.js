// /api/judith/chat and /api/judith/handoff.
//
// The browser only ever sends { session_id, message }. History and state are
// loaded from the database, so a client can't inject turns or edit what
// Judith "remembers", and the system prompt never leaves the server.

import { randomBytes, randomUUID } from 'node:crypto';
import { send, readJson, header, clientIp, hashIp, query } from '../http.js';
import { defaultLog, UUID } from '../handlers.js';
import { cleanText } from '../validate.js';
import { runTurn, mergeState, JudithUnavailable, DEFAULT_MODEL } from './agent.js';

export const MAX_MESSAGE_CHARS = 600;
const STORED_MESSAGES = 40;
export const HANDOFF_TTL_SECONDS = 2 * 3600;
export const TOKEN = /^[A-Za-z0-9_-]{20,64}$/;

// Each allowed message is at most one Claude call (~1¢). JUDITH_DAILY_LIMIT
// caps the whole site per 24h — the hard ceiling on spend.
export const DEFAULT_LIMITS = {
  ipMax: 12, ipWindowSeconds: 300,  // a fast typist, not a script
  ipDailyMax: 80,
  globalDailyMax: 1000,
  sessionMaxTurns: 30,
};

export const LEAD_URL = '/lead?source=judith_ai';
export const FALLBACK_MESSAGE = 'נראה שאני לא זמינה לרגע, אבל אני לא רוצה לעכב אותך. אפשר להשאיר כאן כמה פרטים ונחזור אלייך, או לכתוב לנו ישר בוואטסאפ.';
const SESSION_LIMIT_MESSAGE = 'נראה שכבר דיברנו לא מעט 🌿 כדי שנוכל לתת לך תשובות מדויקות, הכי טוב להשאיר כמה פרטים — ונחזור אלייך.';

const handoffUrl = (token) => `${LEAD_URL}&h=${encodeURIComponent(token)}`;
// The same WhatsApp number as the rest of the site.
export const WHATSAPP_URL = `https://wa.me/972546787179?text=${encodeURIComponent('היי יהודית, הגעתי מהצ׳אט באתר 🙂')}`;

// Browsers send Origin on every fetch POST; a missing or foreign one is not our page.
export function isOwnPage(req) {
  const origin = header(req, 'origin');
  if (!origin) return false;
  const host = header(req, 'x-forwarded-host') || header(req, 'host');
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** The fields /lead can prefill, from a conversation's state. */
export function prefillFrom(state) {
  const s = state || {};
  return {
    name: s.customer_name ?? null,
    lead_type: s.lead_type ?? null,
    lead_subtype: s.lead_subtype ?? null,
    event_date: s.event_date ?? null,
    event_date_text: s.event_date_text ?? null,
    urgency: s.urgency ?? null,
    companions: s.companions ?? null,
    production_type: s.production_type ?? null,
    budget: s.budget ?? null,
  };
}

/** /api/judith/chat — GET: is Judith on? POST: one turn. DELETE: forget a session. */
export function createChatHandler(getDeps, { log = defaultLog, now = () => new Date(), newId = randomUUID,
  newToken = () => randomBytes(24).toString('base64url') } = {}) {

  const unavailable = (res, status, extra = {}) =>
    send(res, status, { error: 'unavailable', message: FALLBACK_MESSAGE, handoff_url: LEAD_URL, whatsapp_url: WHATSAPP_URL, ...extra });

  async function turn(req, res, deps) {
    const { body, error } = readJson(req);
    if (error) return send(res, error === 'too_large' ? 413 : 400, { error });
    if (!body || typeof body !== 'object' || Array.isArray(body)) return send(res, 400, { error: 'invalid' });
    if (typeof body.message !== 'string' || body.message.length > MAX_MESSAGE_CHARS * 2) return send(res, 400, { error: 'invalid message' });
    const message = cleanText(body.message, MAX_MESSAGE_CHARS, { multiline: true });
    if (!message) return send(res, 400, { error: 'invalid message' });
    if (body.session_id != null && (typeof body.session_id !== 'string' || !UUID.test(body.session_id))) {
      return send(res, 400, { error: 'invalid session_id' });
    }

    if (!deps.anthropic) return unavailable(res, 503);

    const ipHash = hashIp(clientIp(req), deps.ipHashKey) || 'unknown';
    // An unknown or expired id starts a fresh session; ids are always ours.
    const session = body.session_id ? await deps.db.judithLoad(body.session_id.toLowerCase()) : null;
    const sessionId = session?.id || newId();

    const gate = await deps.db.judithGate(ipHash, session?.id || null, deps.judithLimits);
    if (!gate.allowed) {
      log.warn('judith_rate_limited', { reason: gate.reason, ip_hash: ipHash, session_id: sessionId });
      if (gate.retry_after_seconds) res.setHeader('Retry-After', String(gate.retry_after_seconds));
      return send(res, 429, {
        error: 'rate_limited', session_id: sessionId, handoff_url: LEAD_URL, whatsapp_url: WHATSAPP_URL,
        message: gate.reason === 'session_limit' ? SESSION_LIMIT_MESSAGE : FALLBACK_MESSAGE,
      });
    }

    const history = session?.messages || [];
    const prevState = session?.state || {};
    const started = Date.now();
    let out;
    try {
      out = await runTurn({ client: deps.anthropic, model: deps.judithModel, history, message, state: prevState, now: now() });
    } catch (err) {
      const reason = err instanceof JudithUnavailable ? err.reason : 'unexpected';
      const cause = err?.cause || err;
      log.error('judith_claude_failed', { session_id: sessionId, reason, status: cause?.status ?? null,
        error: String(cause?.message || cause).slice(0, 300) });
      return unavailable(res, 503, { session_id: sessionId });
    }

    const state = mergeState(prevState, out.state);
    const qualified = Boolean(session?.qualified) || out.qualified;
    const messages = [...history, { role: 'user', content: message }, { role: 'assistant', content: out.message }]
      .slice(-STORED_MESSAGES);
    const saved = await deps.db.judithSaveTurn({
      sessionId, ipHash, messages, state, qualified,
      handoffReady: out.handoff_ready,
      leadSummary: qualified ? out.lead_summary : null,
      handoffToken: newToken(),
      handoffTtlSeconds: HANDOFF_TTL_SECONDS,
      whatsapp: out.whatsapp,
    });

    const u = out.usage || {};
    log.info('judith_turn', {
      session_id: sessionId, turn: (session?.turns || 0) + 1, ms: Date.now() - started,
      qualified, handoff: Boolean(saved.handoff_token), whatsapp: out.whatsapp, intent: state.intent, lead_type: state.lead_type,
      model: deps.judithModel, input_tokens: u.input_tokens ?? null, cache_write: u.cache_creation_input_tokens ?? null,
      cache_read: u.cache_read_input_tokens ?? null, output_tokens: u.output_tokens ?? null,
    });
    // Only show the button when Judith actually offered it this turn.
    return send(res, 200, {
      session_id: sessionId,
      message: out.message,
      handoff_url: out.handoff_ready && saved.handoff_token ? handoffUrl(saved.handoff_token) : null,
      whatsapp_url: out.whatsapp ? WHATSAPP_URL : null,
    });
  }

  async function reset(req, res, deps) {
    const { body } = readJson(req);
    const id = body && typeof body.session_id === 'string' && UUID.test(body.session_id) ? body.session_id.toLowerCase() : null;
    if (!id) return send(res, 400, { error: 'invalid session_id' });
    await deps.db.judithReset(id);
    return send(res, 200, { ok: true });
  }

  return async function handler(req, res) {
    try {
      if (req.method === 'GET') {
        const deps = getDeps();
        return send(res, 200, { enabled: Boolean(deps.anthropic) });
      }
      if (req.method !== 'POST' && req.method !== 'DELETE') {
        res.setHeader('Allow', 'GET, POST, DELETE');
        return send(res, 405, { error: 'method_not_allowed' });
      }
      if (!isOwnPage(req)) return send(res, 403, { error: 'forbidden' });
      const deps = getDeps();
      return req.method === 'POST' ? await turn(req, res, deps) : await reset(req, res, deps);
    } catch (err) {
      log.error('judith_api_error', { method: req.method, error: String(err && err.message || err) });
      return req.method === 'POST' ? unavailable(res, 500) : send(res, 500, { error: 'server_error' });
    }
  };
}

/** GET /api/judith/handoff?token=… → { prefill } for /lead (and counts the click). */
export function createHandoffHandler(getDeps, { log = defaultLog } = {}) {
  return async function handler(req, res) {
    try {
      if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET');
        return send(res, 405, { error: 'method_not_allowed' });
      }
      const token = String(query(req).token || '');
      if (!TOKEN.test(token)) return send(res, 404, { error: 'not_found' });
      const out = await getDeps().db.judithHandoff(token);
      if (!out) return send(res, 404, { error: 'not_found' });
      log.info('judith_handoff_opened', {});
      return send(res, 200, { prefill: prefillFrom(out.state) });
    } catch (err) {
      log.error('judith_handoff_error', { error: String(err && err.message || err) });
      return send(res, 500, { error: 'server_error' });
    }
  };
}

export { DEFAULT_MODEL };
