// Leads → Google Calendar. Every lead with an event date has one all-day event
// on that date, and its status decides which calendar holds it:
//
//   new / in_progress  → "מתעניינים"           (GOOGLE_CALENDAR_INTERESTED)
//   won (נסגר)          → "התארגנות כלה"        (GOOGLE_CALENDAR_BRIDAL) for bridal,
//                         "הפקות"                (GOOGLE_CALENDAR_PRODUCTION) for anything else
//   lost               → no event
//
// So a closed deal lands in the bookings calendars, and from then on the lead
// form shows that day as taken (calendar.js). Synced after a lead is saved
// and after each status change in LeadLive, in the background: Google being
// slow or down never holds up the form or LeadLive, it's only logged.
//
// No database column: the event's ID is derived from the lead's ID
// (eventIdFor), so the event is always found again, in whichever calendar it
// is, and moving it (events.move) keeps the ID. The service account needs
// "Make changes to events" on all three calendars.
//
// Leads without an exact date (only "this month" / "flexible") get no event.

import { createTokenSource, nextDate, TIMEOUT_MS } from './calendar.js';
import { LEAD_TYPE_LABELS, SOURCE_LABELS } from './catalog.js';
import { defaultLog } from './handlers.js';

const API = 'https://www.googleapis.com/calendar/v3/calendars';
const LEADLIVE_URL = 'https://www.casamancini.site/leadlive#/lead/';
export const ROLES = ['interested', 'bridal', 'production'];

/** Google event IDs allow 0-9 and a-v; a UUID's hex digits fit. */
export const eventIdFor = (leadId) => `lead${String(leadId).replace(/-/g, '').toLowerCase()}`;

/** Which calendar a lead's event belongs in, or null for none. */
export function targetFor(lead) {
  if (!lead?.event_date || lead.status === 'lost') return null;
  if (lead.status === 'won') return lead.lead_type === 'bridal' ? 'bridal' : 'production';
  return 'interested';
}

/** The event for a lead: an all-day event on its date, details in the description. */
export function eventFor(lead) {
  const date = String(lead.event_date).slice(0, 10);
  const type = LEAD_TYPE_LABELS[lead.lead_type] || 'פנייה';
  const lines = [
    `טלפון: ${lead.phone}`,
    lead.email && `אימייל: ${lead.email}`,
    `שירות: ${type}${lead.lead_subtype ? ` · ${lead.lead_subtype}` : ''}`,
    lead.production_type && `סוג הפקה: ${lead.production_type}`,
    lead.companions != null && `מלוות: ${lead.companions}`,
    lead.budget != null && `תקציב: ₪${Number(lead.budget).toLocaleString('he-IL')}`,
    lead.message && `הערות: ${lead.message}`,
    lead.source && `מקור: ${SOURCE_LABELS[lead.source] || lead.source}`,
    '',
    `ב-LeadLive: ${LEADLIVE_URL}${lead.id}`,
  ].filter((l) => l !== false && l != null);
  return {
    summary: `${type} · ${lead.name}`,
    description: lines.join('\n'),
    start: { date },
    end: { date: nextDate(date) },
    transparency: 'opaque',   // a booking must count as busy for the availability check
    extendedProperties: { private: { lead_id: String(lead.id) } },
  };
}

export function createCalendarSync(cfg, { fetchImpl = fetch, now = () => Date.now(), tokens = createTokenSource({ fetchImpl, now }) } = {}) {
  async function call(method, role, path, { body, params } = {}) {
    const url = `${API}/${encodeURIComponent(cfg.calendars[role])}/events${path}${params ? `?${new URLSearchParams(params)}` : ''}`;
    const res = await fetchImpl(url, {
      method,
      headers: { Authorization: `Bearer ${await tokens.get(cfg)}`, ...(body && { 'Content-Type': 'application/json' }) },
      body: body && JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 401) tokens.reset();
    const data = res.status === 204 ? null : await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, data };
  }
  // Google's error text names the calendar or the problem, never the lead's details.
  const fail = (what, r) => Object.assign(new Error(`${what} ${r.status} ${r.data?.error?.message || ''}`.trim()), { kind: 'google' });

  // The lead's event in any of the calendars, deleted ones included.
  async function find(id, order) {
    for (const role of order) {
      const r = await call('GET', role, `/${id}`);
      if (r.ok) return { role, event: r.data };
      if (r.status !== 404 && r.status !== 410) throw fail('get', r);
    }
    return null;
  }

  /** Puts the lead's event where its status says → { action, calendar?, from? }. */
  return async function syncLead(lead) {
    const id = eventIdFor(lead.id);
    const target = targetFor(lead);
    if (target && !cfg.calendars[target]) return { action: 'skipped', reason: `no ${target} calendar` };
    const seen = new Set();
    const order = [target, ...ROLES].filter((role) => role && cfg.calendars[role] && !seen.has(cfg.calendars[role]) && seen.add(cfg.calendars[role]));
    const found = await find(id, order);

    if (!target) {
      if (!found || found.event?.status === 'cancelled') return { action: 'none' };
      const r = await call('DELETE', found.role, `/${id}`);
      if (!r.ok && r.status !== 404 && r.status !== 410) throw fail('delete', r);
      return { action: 'removed', from: found.role };
    }

    const body = eventFor(lead);
    if (!found) {
      const r = await call('POST', target, '', { body: { id, ...body } });
      if (r.ok) return { action: 'created', calendar: target };
      // 409: Google still remembers a deleted event with this ID; bring it back.
      if (r.status !== 409) throw fail('insert', r);
      const p = await call('PATCH', target, `/${id}`, { body: { ...body, status: 'confirmed' } });
      if (!p.ok) throw fail('restore', p);
      return { action: 'restored', calendar: target };
    }

    // Update first (also brings back a deleted event), then move if needed.
    const p = await call('PATCH', found.role, `/${id}`, { body: { ...body, status: 'confirmed' } });
    if (!p.ok) throw fail('update', p);
    if (cfg.calendars[found.role] === cfg.calendars[target]) return { action: 'updated', calendar: target };
    const m = await call('POST', found.role, `/${id}/move`, { params: { destination: cfg.calendars[target] } });
    if (!m.ok) throw fail('move', m);
    return { action: 'moved', from: found.role, calendar: target };
  };
}

/** Syncs a lead (or a lead ID, loaded first) without throwing; callers hand it to waitUntil. */
export async function syncLeadCalendar(syncLead, db, leadOrId, log = defaultLog) {
  if (!leadOrId) return;
  const leadId = typeof leadOrId === 'string' ? leadOrId : leadOrId.id;
  try {
    const lead = typeof leadOrId === 'string' ? await db.getLead(leadOrId) : leadOrId;
    if (!lead) return;
    const out = await syncLead(lead);
    log.info('calendar_synced', { lead_id: leadId, ...out });
  } catch (err) {
    log.error('calendar_sync_failed', { lead_id: leadId, kind: err.kind || 'network', error: String(err && err.message || err) });
  }
}
