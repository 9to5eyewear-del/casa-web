// Leads → Google Calendar (calendar-sync.js): interested on arrival, the
// bookings calendar when won, gone when lost. Google Calendar is faked in
// memory with the behaviour the sync relies on (deleted events keep their ID,
// move keeps it too); the lead API runs on a real database (PGlite).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createCalendarSync, syncLeadCalendar, eventIdFor, targetFor, eventFor } from '../api/_lib/calendar-sync.js';
import { createLeadsHandler, createLeadHandler } from '../api/_lib/handlers.js';
import { createTestDb, mockReq, mockRes, silentLog, fakeRequireStaff } from './helpers.js';

const CAL = { interested: 'interested@group.calendar.google.com', bridal: 'bridal@group.calendar.google.com', production: 'production@group.calendar.google.com' };
const CFG = { calendars: CAL, clientEmail: 'casa@casa.iam.gserviceaccount.com', privateKey: 'unused' };
const LEAD_ID = '5b0c8a52-6f0e-4b8a-9d3e-2f1a7c9e4b11';
const lead = (over = {}) => ({
  id: LEAD_ID, status: 'new', name: 'דנה כהן', phone: '054-678-7179', email: 'dana@example.com',
  lead_type: 'bridal', lead_subtype: null, event_date: '2027-05-14', companions: 3, budget: null,
  message: 'נשמח לפרטים', source: 'website_form', ...over,
});
const tokens = { get: async () => 'tok', reset() {} };

// In-memory Google Calendar: calendars → Map(eventId → event).
function fakeCalendar() {
  const cals = Object.fromEntries(Object.values(CAL).map((id) => [id, new Map()]));
  const calls = [];
  const json = (status, body) => ({ ok: status < 300, status, json: async () => body });
  const fn = async (url, { method, body }) => {
    const u = new URL(url);
    const [, calId, , eventId, action] = u.pathname.replace('/calendar/v3/calendars', '').split('/').map(decodeURIComponent);
    calls.push(`${method} ${Object.keys(CAL).find((k) => CAL[k] === calId)}${action ? ` ${action}` : ''}`);
    const cal = cals[calId];
    if (!cal) return json(404, { error: { message: 'Not Found' } });
    const data = body ? JSON.parse(body) : null;
    if (method === 'POST' && !eventId) {
      if (cal.has(data.id)) return json(409, { error: { message: 'The requested identifier already exists.' } });
      cal.set(data.id, { ...data, status: 'confirmed' });
      return json(200, cal.get(data.id));
    }
    const ev = cal.get(eventId);
    if (!ev) return json(404, { error: { message: 'Not Found' } });
    if (method === 'GET') return json(200, ev);
    if (method === 'PATCH') { Object.assign(ev, data); return json(200, ev); }
    if (method === 'DELETE') { ev.status = 'cancelled'; return { ok: true, status: 204, json: async () => null }; }
    if (method === 'POST' && action === 'move') {
      cal.delete(eventId);
      cals[u.searchParams.get('destination')].set(eventId, ev);
      return json(200, ev);
    }
    return json(400, {});
  };
  // Where the lead's event is now, live (not cancelled) only.
  fn.where = (id = eventIdFor(LEAD_ID)) => Object.keys(CAL).filter((k) => cals[CAL[k]].get(id)?.status === 'confirmed');
  fn.event = (role, id = eventIdFor(LEAD_ID)) => cals[CAL[role]].get(id);
  fn.calls = calls;
  return fn;
}

let google, sync;
beforeEach(() => {
  google = fakeCalendar();
  sync = createCalendarSync(CFG, { fetchImpl: google, tokens });
});

test('the event ID is valid for Google and the same for the same lead', () => {
  const id = eventIdFor(LEAD_ID);
  assert.match(id, /^[a-v0-9]{5,1024}$/);
  assert.equal(id, eventIdFor(LEAD_ID.toUpperCase()));
});

test('which calendar: interested while open, bookings when won, none when lost or undated', () => {
  assert.equal(targetFor(lead()), 'interested');
  assert.equal(targetFor(lead({ status: 'in_progress' })), 'interested');
  assert.equal(targetFor(lead({ status: 'won' })), 'bridal');
  for (const t of ['production', 'fashion', 'product', 'other', null]) assert.equal(targetFor(lead({ status: 'won', lead_type: t })), 'production');
  assert.equal(targetFor(lead({ status: 'lost' })), null);
  assert.equal(targetFor(lead({ event_date: null, urgency: 'flexible' })), null);
});

test('the event: all day on the date, the details and a LeadLive link', () => {
  const e = eventFor(lead({ budget: 6000 }));
  assert.equal(e.summary, 'התארגנות כלה · דנה כהן');
  assert.deepEqual(e.start, { date: '2027-05-14' });
  assert.deepEqual(e.end, { date: '2027-05-15' });
  assert.equal(e.transparency, 'opaque');
  assert.match(e.description, /טלפון: 054-678-7179/);
  assert.match(e.description, /מלוות: 3/);
  assert.match(e.description, /הערות: נשמח לפרטים/);
  assert.match(e.description, new RegExp(`leadlive#/lead/${LEAD_ID}`));
  assert.ok(!/null|undefined/.test(e.description));
});

test('new lead → interested; won → bridal; reopened → back to interested', async () => {
  assert.deepEqual(await sync(lead()), { action: 'created', calendar: 'interested' });
  assert.deepEqual(google.where(), ['interested']);

  assert.deepEqual(await sync(lead({ status: 'won' })), { action: 'moved', from: 'interested', calendar: 'bridal' });
  assert.deepEqual(google.where(), ['bridal']);

  assert.deepEqual(await sync(lead({ status: 'in_progress' })), { action: 'moved', from: 'bridal', calendar: 'interested' });
  assert.deepEqual(google.where(), ['interested']);
});

test('a won shoot goes to the productions calendar', async () => {
  await sync(lead({ lead_type: 'fashion' }));
  await sync(lead({ lead_type: 'fashion', status: 'won' }));
  assert.deepEqual(google.where(), ['production']);
  assert.equal(google.event('production').summary, 'צילום אופנה · דנה כהן');
});

test('lost → off the calendar; reopened → the same event comes back', async () => {
  await sync(lead());
  assert.deepEqual(await sync(lead({ status: 'lost' })), { action: 'removed', from: 'interested' });
  assert.deepEqual(google.where(), []);
  assert.deepEqual(await sync(lead({ status: 'lost' })), { action: 'none' });   // already gone

  assert.deepEqual(await sync(lead({ status: 'new' })), { action: 'updated', calendar: 'interested' });
  assert.deepEqual(google.where(), ['interested']);
});

test('syncing again only updates (a repeat inquiry with a new date moves the day)', async () => {
  await sync(lead());
  assert.deepEqual(await sync(lead({ event_date: '2027-06-01' })), { action: 'updated', calendar: 'interested' });
  assert.deepEqual(google.event('interested').start, { date: '2027-06-01' });
  assert.deepEqual(google.where(), ['interested']);
});

test('no date, or the target calendar not set up: nothing is written', async () => {
  assert.deepEqual(await sync(lead({ event_date: null })), { action: 'none' });
  const partial = createCalendarSync({ ...CFG, calendars: { ...CAL, bridal: null } }, { fetchImpl: google, tokens });
  assert.deepEqual(await partial(lead({ status: 'won' })), { action: 'skipped', reason: 'no bridal calendar' });
  assert.ok(!google.calls.some((c) => c.startsWith('POST') || c.startsWith('PATCH')));
});

test('a failure is logged, never thrown', async () => {
  const log = silentLog();
  const down = createCalendarSync(CFG, { fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({ error: { message: 'Backend Error' } }) }), tokens });
  await syncLeadCalendar(down, null, lead(), log);
  const e = log.entries.find((x) => x.event === 'calendar_sync_failed');
  assert.equal(e.lead_id, LEAD_ID);
  assert.match(e.error, /500 Backend Error/);
  assert.ok(!JSON.stringify(log.entries).includes('054-678-7179'));   // no lead details in the logs
});

// ── Through the lead API ──

test('the form and LeadLive drive it: new lead → interested, נסגר → bridal, לא רלוונטי → gone', async () => {
  const t = await createTestDb();
  const log = silentLog();
  const pending = [];
  const deps = () => ({
    db: t.db, ipHashKey: 'k', requireStaff: fakeRequireStaff,
    waitUntil: (p) => pending.push(p),
    calendarSync: (leadOrId, l) => syncLeadCalendar(sync, t.db, leadOrId, l),
  });
  const leadsApi = createLeadsHandler(deps, { log });
  const leadApi = createLeadHandler(deps, { log });
  const settle = async () => { await Promise.all(pending.splice(0)); };

  const res = mockRes();
  await leadsApi(mockReq({ method: 'POST', body: { source: 'website_form', name: 'דנה כהן', phone: '054-678-7179', lead_type: 'bridal', event_date: '2027-05-14' } }), res);
  assert.equal(res.statusCode, 201);
  await settle();
  const { rows: [{ id }] } = await t.pg.query('select id from leads');
  const where = () => google.where(eventIdFor(id));
  assert.deepEqual(where(), ['interested']);

  const patch = async (status) => {
    const r = mockRes();
    await leadApi(mockReq({ method: 'PATCH', query: { id }, body: { status }, headers: { authorization: 'Bearer good' } }), r);
    assert.equal(r.statusCode, 200);
    await settle();
  };
  await patch('in_progress');
  assert.deepEqual(where(), ['interested']);
  await patch('won');
  assert.deepEqual(where(), ['bridal']);
  await patch('lost');
  assert.deepEqual(where(), []);
  assert.ok(!log.entries.some((e) => e.event === 'calendar_sync_failed'));
});

test('without the calendar set up the lead API works as before', async () => {
  const t = await createTestDb();
  const deps = () => ({ db: t.db, ipHashKey: 'k', requireStaff: fakeRequireStaff, waitUntil: () => {}, calendarSync: null });
  const res = mockRes();
  await createLeadsHandler(deps, { log: silentLog() })(mockReq({ method: 'POST', body: { source: 'website_form', name: 'דנה', phone: '0546787179', lead_type: 'bridal', event_date: '2027-05-14' } }), res);
  assert.equal(res.statusCode, 201);
});
