// GET /api/availability?date=YYYY-MM-DD — which slots are still open on that
// day? The lead form asks as soon as a date is picked, so nobody fills in the
// rest for a day that's taken.
//
// A day holds two bookings, each with its own Google Calendar: one bridal prep
// ("התארגנות כלה קאזה מנציני") and one photo production ("הפקות קאזה מנציני").
// Any busy event on the day (Israel time) in a calendar takes that slot;
// events marked "Free" in Google Calendar don't count. The answer is
// { date, bridal, production }, each true (open), false (taken) or null
// (unknown).
//
// How it reaches the calendars: a Google service account (no OAuth screen, no
// refresh tokens) that both calendars are shared with. It asks only freeBusy,
// so event titles and details never reach this server, let alone the visitor.
//
// It fails open: without the env vars, or when Google errors or is slow, the
// slot is null and the form behaves as it did before.
//
// Env: GOOGLE_CALENDAR_BRIDAL and GOOGLE_CALENDAR_PRODUCTION (each calendar's
// ID from its settings page) and GOOGLE_SERVICE_ACCOUNT_JSON (the whole JSON
// key file, pasted as is).

import { createSign } from 'node:crypto';
import { send, query } from './http.js';
import { defaultLog } from './handlers.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FREEBUSY_URL = 'https://www.googleapis.com/calendar/v3/freeBusy';
const SCOPE = 'https://www.googleapis.com/auth/calendar.freebusy';
export const SLOTS = ['bridal', 'production'];
const TZ = 'Asia/Jerusalem';
export const CACHE_MS = 2 * 60 * 1000;   // a new booking shows up within 2 minutes
const TIMEOUT_MS = 4000;
const MAX_DAYS_AHEAD = 3 * 365;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY = 86400000;

/** Env → { calendars: { bridal, production }, clientEmail, privateKey }, or
 * null when not set up. A slot without a calendar ID is never checked. */
export function calendarConfig(env = process.env, log = defaultLog) {
  const calendars = {
    bridal: (env.GOOGLE_CALENDAR_BRIDAL || '').trim() || null,
    production: (env.GOOGLE_CALENDAR_PRODUCTION || '').trim() || null,
  };
  // Pasting through TextEdit or Notes turns the key file's quotes curly.
  const raw = (env.GOOGLE_SERVICE_ACCOUNT_JSON || '').replace(/^\uFEFF/, '').replace(/[\u201C\u201D\u201E\u201F]/g, '"').trim();
  if (!raw || !SLOTS.some((slot) => calendars[slot])) return null;
  try {
    const key = JSON.parse(raw);
    if (!key.client_email || !key.private_key) throw new Error('missing client_email or private_key');
    return { calendars, clientEmail: key.client_email, privateKey: key.private_key };
  } catch (err) {
    // Never err.message from JSON.parse: it quotes the start of the secret.
    const message = err instanceof SyntaxError
      ? (raw.startsWith('AIza') ? 'an API key, not a service account JSON key file'
        : `not valid JSON (starts with "{": ${raw.startsWith('{')}, ends with "}": ${raw.endsWith('}')}, length ${raw.length})`)
      : err.message;
    log.error('calendar_bad_key', { message });
    return null;
  }
}

const b64url = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');

/** The signed JWT a service account trades for an access token. */
export function serviceAccountJwt({ clientEmail, privateKey }, nowMs) {
  const iat = Math.floor(nowMs / 1000);
  const unsigned = `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url({ iss: clientEmail, scope: SCOPE, aud: TOKEN_URL, iat, exp: iat + 3600 })}`;
  const signature = createSign('RSA-SHA256').update(unsigned).sign(privateKey, 'base64url');
  return `${unsigned}.${signature}`;
}

/** The UTC offset in Israel on a date, e.g. "+03:00". */
export function israelOffset(date) {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'longOffset' })
    .formatToParts(new Date(`${date}T12:00:00Z`)).find((p) => p.type === 'timeZoneName').value;
  return name === 'GMT' ? '+00:00' : name.slice(3);
}

const nextDate = (date) => new Date(Date.parse(`${date}T00:00:00Z`) + DAY).toISOString().slice(0, 10);
const israelToday = (nowMs) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(nowMs));

/** A YYYY-MM-DD that is a real date, today or later (Israel), within the window. */
export function checkDate(date, nowMs) {
  if (typeof date !== 'string' || !ISO_DATE.test(date)) return false;
  const t = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== date) return false;
  const today = Date.parse(`${israelToday(nowMs)}T00:00:00Z`);
  return t >= today && t <= today + MAX_DAYS_AHEAD * DAY;
}

export function createAvailabilityHandler(getConfig, { fetchImpl = fetch, now = () => Date.now(), log = defaultLog } = {}) {
  // Per function instance: one access token (valid an hour) and recent answers.
  let token = null;
  const answers = new Map();

  async function accessToken(cfg) {
    if (token && token.email === cfg.clientEmail && token.expires - 60000 > now()) return token.value;
    const res = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: serviceAccountJwt(cfg, now()) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) throw Object.assign(new Error(`token ${res.status} ${data.error || ''}`.trim()), { kind: 'auth' });
    token = { value: data.access_token, email: cfg.clientEmail, expires: now() + (data.expires_in || 3600) * 1000 };
    return token.value;
  }

  // One freeBusy request for both calendars → { bridal, production }.
  async function openSlots(cfg, date) {
    const ids = SLOTS.map((slot) => cfg.calendars[slot]).filter(Boolean);
    const res = await fetchImpl(FREEBUSY_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await accessToken(cfg)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        timeMin: `${date}T00:00:00${israelOffset(date)}`,
        timeMax: `${nextDate(date)}T00:00:00${israelOffset(nextDate(date))}`,
        timeZone: TZ,
        items: [...new Set(ids)].map((id) => ({ id })),
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) token = null;
    if (!res.ok || !data.calendars) throw Object.assign(new Error(`freeBusy ${res.status}`), { kind: 'google' });
    const open = {};
    const problems = {};
    for (const slot of SLOTS) {
      const cal = cfg.calendars[slot] && data.calendars[cfg.calendars[slot]];
      // notFound means the calendar isn't shared with the service account (or a wrong ID).
      if (cal?.errors?.length) problems[slot] = `calendar ${cal.errors[0].reason}`;
      else if (!cal) problems[slot] = cfg.calendars[slot] ? 'calendar missing from the answer' : 'no calendar ID set';
      open[slot] = problems[slot] ? null : cal.busy.length === 0;
    }
    // One line per request: Vercel's log view keeps only the first.
    if (Object.keys(problems).length) log.error('calendar_check_failed', { kind: 'calendar', ...problems, date });
    return open;
  }

  return async function availability(req, res) {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return send(res, 405, { error: 'method_not_allowed' });
    }
    const { date } = query(req);
    if (!checkDate(date, now())) return send(res, 400, { error: 'invalid_date' });

    const unknown = { date, bridal: null, production: null };
    const cfg = getConfig();
    if (!cfg) return send(res, 200, unknown);

    const hit = answers.get(date);
    if (hit && now() - hit.at < CACHE_MS) return send(res, 200, { date, ...hit.open });

    try {
      const open = await openSlots(cfg, date);
      if (answers.size > 500) answers.clear();
      if (SLOTS.every((slot) => open[slot] !== null || !cfg.calendars[slot])) answers.set(date, { open, at: now() });
      return send(res, 200, { date, ...open });
    } catch (err) {
      log.error('calendar_check_failed', { kind: err.kind || 'network', message: err.message, date });
      return send(res, 200, unknown);
    }
  };
}
