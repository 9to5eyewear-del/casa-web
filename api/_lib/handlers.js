import { randomUUID } from 'node:crypto';
import { STATUSES } from './catalog.js';
import { validateLead, cleanText } from './validate.js';
import { scoreLead } from './score.js';
import { leadNotification } from './push.js';
import { send, readJson, header, clientIp, hashIp, isSameOrigin, query } from './http.js';

const RATE_LIMIT = { max: 5, windowSeconds: 600 };
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOURCE_PATTERN = /^[a-z][a-z0-9_]{1,39}$/;

// One JSON line per event, so Vercel logs are searchable by "event".
export const defaultLog = {
  info: (event, data) => console.log(JSON.stringify({ level: 'info', event, ...data })),
  warn: (event, data) => console.warn(JSON.stringify({ level: 'warn', event, ...data })),
  error: (event, data) => console.error(JSON.stringify({ level: 'error', event, ...data })),
};

const phoneTail = (phone) => (phone ? phone.replace(/\D/g, '').slice(-4) : null);

function encodeCursor(lead) {
  return Buffer.from(JSON.stringify([lead.last_submission_at, lead.id])).toString('base64url');
}

function decodeCursor(value) {
  try {
    const [ts, id] = JSON.parse(Buffer.from(value, 'base64url').toString());
    if (!Number.isNaN(Date.parse(ts)) && UUID.test(id)) return { cursorTs: ts, cursorId: id };
  } catch {}
  return null;
}

export async function withStaff(deps, req, res) {
  const auth = await deps.requireStaff(req);
  if (auth.user) return auth.user;
  send(res, auth.status, { error: auth.error });
  return null;
}

/** /api/leads — POST (public): create a lead. GET (staff): list leads. */
export function createLeadsHandler(getDeps, { log = defaultLog, rateLimit = RATE_LIMIT, now = () => new Date() } = {}) {
  async function createLead(req, res) {
    if (!isSameOrigin(req)) return send(res, 403, { error: 'forbidden' });

    const { body, error } = readJson(req);
    if (error) return send(res, error === 'too_large' ? 413 : 400, { error });

    const v = validateLead(body, { now: now(), userAgent: header(req, 'user-agent') });
    if (!v.ok) {
      // Error level: if Web3Forms got this one, it's in the inbox but not the PWA.
      const sid = typeof body?.submission_id === 'string' && UUID.test(body.submission_id) ? body.submission_id : null;
      log.error('lead_rejected', { submission_id: sid, errors: v.errors });
      return send(res, 400, { error: 'invalid', fields: v.errors });
    }

    const submissionId = v.submissionId || randomUUID();
    // Bots get the same answer as people, so the honeypot isn't revealed.
    if (v.spam) {
      log.info('lead_spam_dropped', { submission_id: submissionId });
      return send(res, 201, { ok: true, submission_id: submissionId });
    }

    const lead = { ...v.lead, lead_score: scoreLead(v.lead, now()) };
    const logCtx = { submission_id: submissionId, source: lead.source, lead_type: lead.lead_type, phone_tail: phoneTail(lead.phone) };

    let out, deps;
    try {
      deps = getDeps();
      out = await deps.db.ingestLead(lead, {
        submissionId,
        ipHash: hashIp(clientIp(req), deps.ipHashKey),
        rateMax: rateLimit.max,
        rateWindowSeconds: rateLimit.windowSeconds,
      });
    } catch (err) {
      // The inquiry may still reach email via Web3Forms; this line is how we
      // find leads that are in the inbox but missing from the system.
      log.error('lead_db_save_failed', { ...logCtx, error: String(err && err.message || err) });
      return send(res, 503, { error: 'save_failed', submission_id: submissionId });
    }

    if (out.result === 'rate_limited') {
      log.error('lead_rate_limited', logCtx);
      return send(res, 429, { error: 'rate_limited', submission_id: submissionId });
    }

    log.info('lead_saved', { ...logCtx, result: out.result, lead_id: out.lead_id, submission_count: out.submission_count });

    // Sent after the response, so a slow push service never delays the form.
    const note = leadNotification(lead, out);
    if (note && deps.notify) {
      // The unread count rides along so the app icon badge stays current.
      deps.waitUntil(deps.db.unreadCount().then((unread) => deps.notify({ ...note, unread })).catch((err) =>
        log.error('push_notify_failed', { lead_id: out.lead_id, error: String(err && err.message || err) })));
    }
    // Same response for new and repeat leads: the public can't probe who already inquired.
    return send(res, 201, { ok: true, submission_id: submissionId });
  }

  async function listLeads(req, res) {
    const deps = getDeps();
    if (!(await withStaff(deps, req, res))) return;

    const q = query(req);
    const filters = { limit: 30 };
    if (q.status) {
      if (!STATUSES.has(q.status)) return send(res, 400, { error: 'invalid status' });
      filters.status = q.status;
    }
    if (q.source) {
      if (!SOURCE_PATTERN.test(q.source)) return send(res, 400, { error: 'invalid source' });
      filters.source = q.source;
    }
    if (q.q) filters.query = cleanText(q.q, 80);
    if (q.limit) filters.limit = Math.min(Math.max(parseInt(q.limit, 10) || 30, 1), 100);
    if (q.cursor) {
      const c = decodeCursor(q.cursor);
      if (!c) return send(res, 400, { error: 'invalid cursor' });
      Object.assign(filters, c);
    }

    const [leads, counts] = await Promise.all([
      deps.db.listLeads(filters),
      q.cursor ? null : deps.db.statusCounts(),
    ]);
    const nextCursor = leads.length === filters.limit ? encodeCursor(leads[leads.length - 1]) : null;
    return send(res, 200, { leads, next_cursor: nextCursor, ...(counts && { counts }) });
  }

  return async function handler(req, res) {
    try {
      if (req.method === 'POST') return await createLead(req, res);
      if (req.method === 'GET') return await listLeads(req, res);
      res.setHeader('Allow', 'GET, POST');
      return send(res, 405, { error: 'method_not_allowed' });
    } catch (err) {
      log.error('leads_api_error', { method: req.method, error: String(err && err.message || err) });
      return send(res, 500, { error: 'server_error' });
    }
  };
}

/** /api/leads/:id — GET (staff): one lead with its history. PATCH (staff): {status} or {seen: true}. DELETE (staff). */
export function createLeadHandler(getDeps, { log = defaultLog } = {}) {
  return async function handler(req, res) {
    try {
      if (!['GET', 'PATCH', 'DELETE'].includes(req.method)) {
        res.setHeader('Allow', 'GET, PATCH, DELETE');
        return send(res, 405, { error: 'method_not_allowed' });
      }
      const deps = getDeps();
      const user = await withStaff(deps, req, res);
      if (!user) return;

      const id = String(query(req).id || '');
      if (!UUID.test(id)) return send(res, 404, { error: 'not_found' });

      if (req.method === 'GET') {
        const lead = await deps.db.getLead(id);
        return lead ? send(res, 200, { lead }) : send(res, 404, { error: 'not_found' });
      }

      if (!isSameOrigin(req)) return send(res, 403, { error: 'forbidden' });

      if (req.method === 'DELETE') {
        const out = await deps.db.deleteLead(id);
        if (!out) return send(res, 404, { error: 'not_found' });
        log.info('lead_deleted', { lead_id: id, by: user.id });
        return send(res, 200, out);
      }

      const { body, error } = readJson(req);
      if (error) return send(res, 400, { error });
      const keys = body && typeof body === 'object' ? Object.keys(body) : [];
      if (keys.length === 1 && keys[0] === 'seen' && body.seen === true) {
        const out = await deps.db.markSeen(id);
        return out ? send(res, 200, out) : send(res, 404, { error: 'not_found' });
      }
      if (keys.length !== 1 || keys[0] !== 'status' || !STATUSES.has(body.status)) {
        return send(res, 400, { error: 'only {status} or {seen: true} can be updated', allowed: [...STATUSES] });
      }

      const lead = await deps.db.setStatus(id, body.status, user);
      if (!lead) return send(res, 404, { error: 'not_found' });
      log.info('lead_status_changed', { lead_id: id, status: body.status, by: user.email });
      return send(res, 200, { lead });
    } catch (err) {
      log.error('lead_api_error', { method: req.method, error: String(err && err.message || err) });
      return send(res, 500, { error: 'server_error' });
    }
  };
}
