// /api/availability: the lead form's check against the two bookings calendars
// (bridal prep, production). Google (token endpoint + freeBusy) is faked; the
// JWT is signed for real.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { createAvailabilityHandler, calendarConfig, serviceAccountJwt, israelOffset, checkDate, CACHE_MS } from '../api/_lib/calendar.js';
import { mockReq, mockRes, silentLog } from './helpers.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });
const BRIDAL = 'bridal-cal@group.calendar.google.com';
const PROD = 'production-cal@group.calendar.google.com';
const CFG = { calendars: { bridal: BRIDAL, production: PROD }, clientEmail: 'casa@casa.iam.gserviceaccount.com', privateKey: PEM };
const NOW = Date.parse('2026-10-08T09:00:00Z');
const NONE = { bridal: null, production: null };
const BLOCK = [{ start: '2026-11-20T07:00:00Z', end: '2026-11-20T12:00:00Z' }];

let log, clock;
beforeEach(() => { log = silentLog(); clock = NOW; });

const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

// busy: date → calendar IDs with an event that day. Records each request.
function fakeGoogle({ busy = {}, freeBusy } = {}) {
  const calls = [];
  const fn = async (url, opts) => {
    const body = typeof opts.body === 'string' ? JSON.parse(opts.body) : opts.body;
    calls.push({ url, opts, body });
    if (url.includes('oauth2')) return json(200, { access_token: 'tok-1', expires_in: 3600 });
    if (freeBusy) return freeBusy(body);
    const date = body.timeMin.slice(0, 10);
    const calendars = Object.fromEntries(body.items.map(({ id }) => [id, { busy: (busy[date] || []).includes(id) ? BLOCK : [] }]));
    return json(200, { calendars });
  };
  fn.calls = calls;
  fn.checks = () => calls.filter((c) => c.url.includes('freeBusy'));
  return fn;
}

function api(fetchImpl, cfg = CFG) {
  return createAvailabilityHandler(() => cfg, { fetchImpl, now: () => clock, log });
}
async function get(handler, date, method = 'GET') {
  const res = mockRes();
  await handler(mockReq({ method, query: date === undefined ? {} : { date } }), res);
  return res;
}

test('a day holds one bridal prep and one production, each from its own calendar', async () => {
  const h = api(fakeGoogle({ busy: { '2026-11-20': [BRIDAL], '2026-11-21': [PROD], '2026-11-22': [BRIDAL, PROD] } }));
  assert.deepEqual((await get(h, '2026-11-19')).body, { date: '2026-11-19', bridal: true, production: true });
  assert.deepEqual((await get(h, '2026-11-20')).body, { date: '2026-11-20', bridal: false, production: true });
  assert.deepEqual((await get(h, '2026-11-21')).body, { date: '2026-11-21', bridal: true, production: false });
  assert.deepEqual((await get(h, '2026-11-22')).body, { date: '2026-11-22', bridal: false, production: false });
});

test('one freeBusy request for both calendars, the whole day in Israel time across DST', async () => {
  const google = fakeGoogle();
  const h = api(google);
  await get(h, '2026-10-20');   // summer time
  await get(h, '2026-12-01');   // winter time
  const [summer, winter] = google.checks();
  assert.equal(summer.url, 'https://www.googleapis.com/calendar/v3/freeBusy');
  assert.deepEqual(summer.body.items, [{ id: BRIDAL }, { id: PROD }]);
  assert.equal(summer.body.timeMin, '2026-10-20T00:00:00+03:00');
  assert.equal(summer.body.timeMax, '2026-10-21T00:00:00+03:00');
  assert.equal(winter.body.timeMin, '2026-12-01T00:00:00+02:00');
  assert.equal(winter.opts.headers.Authorization, 'Bearer tok-1');
  assert.equal(israelOffset('2026-10-25'), '+02:00');
});

test('the token is reused and answers are cached for a couple of minutes', async () => {
  const google = fakeGoogle();
  const h = api(google);
  await get(h, '2026-11-01');
  await get(h, '2026-11-01');
  await get(h, '2026-11-02');
  assert.equal(google.calls.filter((c) => c.url.includes('oauth2')).length, 1);
  assert.equal(google.checks().length, 2);
  clock += CACHE_MS + 1;
  await get(h, '2026-11-01');
  assert.equal(google.checks().length, 3);
});

test('a calendar not shared with the service account is unknown, the other still answers', async () => {
  const google = fakeGoogle({ freeBusy: () => json(200, { calendars: {
    [BRIDAL]: { errors: [{ domain: 'global', reason: 'notFound' }], busy: [] },
    [PROD]: { busy: BLOCK },
  } }) });
  const h = api(google);
  assert.deepEqual((await get(h, '2026-11-01')).body, { date: '2026-11-01', bridal: null, production: false });
  assert.ok(log.entries.some((e) => e.event === 'calendar_check_failed' && e.slot === 'bridal' && /notFound/.test(e.message)));
  await get(h, '2026-11-01');
  assert.equal(google.checks().length, 2);   // a partial answer isn't cached
});

test('only one calendar set up: the other slot stays unknown', async () => {
  const google = fakeGoogle({ busy: { '2026-11-01': [PROD] } });
  const h = api(google, { ...CFG, calendars: { bridal: null, production: PROD } });
  assert.deepEqual((await get(h, '2026-11-01')).body, { date: '2026-11-01', bridal: null, production: false });
  assert.deepEqual(google.checks()[0].body.items, [{ id: PROD }]);
});

test('fails open: not set up, Google errors, network errors', async () => {
  assert.deepEqual((await get(api(fakeGoogle(), null), '2026-11-01')).body, { date: '2026-11-01', ...NONE });
  const down = api(fakeGoogle({ freeBusy: () => json(500, {}) }));
  assert.deepEqual((await get(down, '2026-11-01')).body, { date: '2026-11-01', ...NONE });
  const thrown = api(async () => { throw new Error('timeout'); });
  assert.deepEqual((await get(thrown, '2026-11-01')).body, { date: '2026-11-01', ...NONE });
  assert.ok(log.entries.some((e) => e.event === 'calendar_check_failed'));
});

test('rejects bad, past and far-off dates, and non-GET', async () => {
  const h = api(fakeGoogle());
  for (const d of [undefined, '', '2026-13-01', '2026-02-30', '20261101', '2026-10-07', '2035-01-01']) {
    assert.equal((await get(h, d)).statusCode, 400, String(d));
  }
  assert.equal((await get(h, '2026-10-08')).statusCode, 200);   // today
  assert.equal((await get(h, '2026-11-01', 'POST')).statusCode, 405);
  assert.equal(checkDate('2026-10-08', Date.parse('2026-10-07T22:30:00Z')), true);  // already the 8th in Israel
});

test('the JWT is a valid RS256 assertion for the freeBusy scope', () => {
  const jwt = serviceAccountJwt(CFG, NOW);
  const [head, claims, sig] = jwt.split('.');
  assert.ok(createVerify('RSA-SHA256').update(`${head}.${claims}`).verify(publicKey, sig, 'base64url'));
  const c = JSON.parse(Buffer.from(claims, 'base64url'));
  assert.equal(c.iss, CFG.clientEmail);
  assert.equal(c.scope, 'https://www.googleapis.com/auth/calendar.freebusy');
  assert.equal(c.exp - c.iat, 3600);
});

test('config reads both calendar IDs and the pasted key file', () => {
  const key = JSON.stringify({ client_email: CFG.clientEmail, private_key: PEM });
  const env = { GOOGLE_CALENDAR_BRIDAL: ` ${BRIDAL} `, GOOGLE_CALENDAR_PRODUCTION: PROD, GOOGLE_SERVICE_ACCOUNT_JSON: key };
  assert.deepEqual(calendarConfig(env, log), CFG);
  assert.equal(calendarConfig({ GOOGLE_SERVICE_ACCOUNT_JSON: key }, log), null);
  assert.equal(calendarConfig({ GOOGLE_CALENDAR_BRIDAL: BRIDAL }, log), null);
  assert.equal(calendarConfig({ ...env, GOOGLE_SERVICE_ACCOUNT_JSON: '{nope' }, log), null);
});

test('a wrong key is reported without quoting it in the logs', () => {
  const secret = 'AIzaSyFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE';
  assert.equal(calendarConfig({ GOOGLE_CALENDAR_BRIDAL: BRIDAL, GOOGLE_SERVICE_ACCOUNT_JSON: secret }, log), null);
  const entry = log.entries.find((e) => e.event === 'calendar_bad_key');
  assert.match(entry.message, /API key/);
  assert.ok(!JSON.stringify(log.entries).includes('AIza'));
});
