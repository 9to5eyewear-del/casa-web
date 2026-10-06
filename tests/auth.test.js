// Owner login, sessions, protected endpoints and push — against the real
// migrations (PGlite) with the real session code.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createLeadsHandler, createLeadHandler } from '../api/_lib/handlers.js';
import {
  createLoginHandler, createLogoutHandler, createSessionHandler, createPushSubscribeHandler,
} from '../api/_lib/auth-handlers.js';
import {
  createRequireSession, createSessionToken, hashPassword, SESSION_COOKIE,
} from '../api/_lib/session.js';
import { createNotifier, leadNotification } from '../api/_lib/push.js';
import { createTestDb, mockReq, mockRes, silentLog } from './helpers.js';

const PASSWORD = 'test-only-password';
const SECRET = 'test-session-secret';
const DAY = 86400_000;
const passwordHash = await hashPassword(PASSWORD);

let t, log, api, pushCalls, pending, deadEndpoints;

// Stand-in for the web-push module: records sends, and answers 410 for
// endpoints we declare dead.
const fakeWebpush = {
  setVapidDetails() {},
  async sendNotification(sub, body) {
    pushCalls.push({ endpoint: sub.endpoint, payload: JSON.parse(body) });
    if (deadEndpoints.has(sub.endpoint)) throw Object.assign(new Error('Gone'), { statusCode: 410 });
    return { statusCode: 201 };
  },
};

beforeEach(async () => {
  t = await createTestDb();
  log = silentLog();
  pushCalls = [];
  pending = [];
  deadEndpoints = new Set();
  const deps = () => ({
    db: t.db,
    ipHashKey: 'ip-key',
    sessionSecret: SECRET,
    passwordHash,
    requireStaff: createRequireSession(SECRET),
    vapidPublicKey: 'BPublicKey',
    notify: createNotifier({ db: t.db, webpush: fakeWebpush, vapid: { subject: 'https://x', publicKey: 'p', privateKey: 'k' }, log }),
    waitUntil: (p) => pending.push(p),
  });
  api = {
    leads: createLeadsHandler(deps, { log }),
    lead: createLeadHandler(deps, { log }),
    login: createLoginHandler(deps, { log }),
    logout: createLogoutHandler({ log }),
    session: createSessionHandler(deps, { log }),
    push: createPushSubscribeHandler(deps, { log }),
  };
});

async function call(handler, opts) {
  const res = mockRes();
  await handler(mockReq(opts), res);
  return res;
}

const cookieFrom = (res) => res.headers['set-cookie'].split(';')[0];
const login = (password, ip = '203.0.113.7') =>
  call(api.login, { method: 'POST', body: { password }, headers: { 'x-forwarded-for': ip } });
async function loggedIn() {
  const res = await login(PASSWORD);
  assert.equal(res.statusCode, 200);
  return cookieFrom(res);
}
const withCookie = (cookie, opts = {}) => ({ ...opts, headers: { ...(opts.headers || {}), ...(cookie && { cookie }) } });
const newLead = (over = {}) => ({ source: 'website_form', name: 'דנה', phone: '0546787179', lead_type: 'bridal', event_date: '2027-05-14', ...over });
const sub = (n) => ({ endpoint: `https://push.example/${n}`, keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' } });

// ── Login ──

test('correct password → 200 + secure 30-day session cookie', async () => {
  const res = await login(PASSWORD);
  assert.equal(res.statusCode, 200);
  const c = res.headers['set-cookie'];
  assert.match(c, new RegExp(`^${SESSION_COOKIE}=[^;]+`));
  for (const attr of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/', 'Max-Age=2592000']) assert.ok(c.includes(attr), attr);
  assert.equal(JSON.stringify(res.body).includes(PASSWORD), false);
  assert.ok(log.entries.some((e) => e.event === 'login_ok'));
});

test('wrong / missing password → 401 / 400, no cookie', async () => {
  const wrong = await login('nope');
  assert.equal(wrong.statusCode, 401);
  assert.equal(wrong.headers['set-cookie'], undefined);
  assert.equal((await login('')).statusCode, 400);
  assert.equal((await call(api.login, { method: 'POST', body: { password: 123 } })).statusCode, 400);
  assert.equal((await call(api.login, { method: 'GET' })).statusCode, 405);
  assert.equal((await call(api.login, { method: 'POST', body: { password: PASSWORD }, headers: { origin: 'https://evil.example' } })).statusCode, 403);
});

test('login rate limit: 5 wrong tries per IP lock it (even the right password) for at most 15 minutes', async () => {
  for (let i = 0; i < 5; i++) assert.equal((await login('wrong')).statusCode, 401);
  const locked = await login(PASSWORD);
  assert.equal(locked.statusCode, 429);
  assert.ok(locked.body.retry_after_seconds > 0 && locked.body.retry_after_seconds <= 900);
  assert.equal(locked.headers['retry-after'], String(locked.body.retry_after_seconds));

  // Another IP is unaffected.
  assert.equal((await login(PASSWORD, '198.51.100.9')).statusCode, 200);

  // Once the failures age out of the window, the owner gets back in.
  await t.pg.exec(`update login_attempts set created_at = created_at - interval '16 minutes'`);
  assert.equal((await login(PASSWORD)).statusCode, 200);
});

test('login rate limit: a correct login clears earlier typos', async () => {
  for (let i = 0; i < 4; i++) await login('typo');
  assert.equal((await login(PASSWORD)).statusCode, 200);
  for (let i = 0; i < 4; i++) assert.equal((await login('typo')).statusCode, 401); // 4 more allowed again
  assert.equal((await login(PASSWORD)).statusCode, 200);
});

test('login rate limit: distributed guessing is capped globally', async () => {
  for (let i = 0; i < 50; i++) await login('guess', `10.1.${Math.floor(i / 4)}.${i}`);
  assert.equal((await login(PASSWORD, '192.0.2.200')).statusCode, 429);
});

// ── Session ──

test('session endpoint: valid cookie → authenticated + VAPID key; none → not authenticated', async () => {
  const cookie = await loggedIn();
  const ok = await call(api.session, withCookie(cookie));
  assert.equal(ok.body.authenticated, true);
  assert.equal(ok.body.vapid_public_key, 'BPublicKey');
  assert.ok(Date.parse(ok.body.expires_at) > Date.now() + 29 * DAY);
  assert.equal(ok.headers['set-cookie'], undefined); // fresh session isn't re-issued
  assert.deepEqual((await call(api.session, {})).body, { authenticated: false });
});

test('expired session is rejected server-side, whatever the cookie says', async () => {
  const old = `${SESSION_COOKIE}=${createSessionToken(SECRET, Date.now() - 31 * DAY)}`;
  assert.equal((await call(api.session, withCookie(old))).body.authenticated, false);
  assert.equal((await call(api.leads, withCookie(old, { method: 'GET' }))).statusCode, 401);
});

test('tampered or foreign-secret sessions are rejected', async () => {
  const cookie = await loggedIn();
  const [name, token] = cookie.split('=');
  const [payload, sig] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ v: 1, iat: 0, exp: 4102444800 })).toString('base64url');
  for (const bad of [`${forged}.${sig}`, `${payload}.${sig}x`, `${payload}`, createSessionToken('other-secret'), 'garbage']) {
    assert.equal((await call(api.leads, withCookie(`${name}=${bad}`, { method: 'GET' }))).statusCode, 401, bad);
  }
});

test('a week-old session is renewed for another 30 days when the app opens', async () => {
  const old = `${SESSION_COOKIE}=${createSessionToken(SECRET, Date.now() - 8 * DAY)}`;
  const res = await call(api.session, withCookie(old));
  assert.equal(res.body.authenticated, true);
  assert.match(res.headers['set-cookie'], /Max-Age=2592000/);
  assert.ok(Date.parse(res.body.expires_at) > Date.now() + 29 * DAY);
});

test('logout clears the cookie', async () => {
  const res = await call(api.logout, { method: 'POST' });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['set-cookie'], new RegExp(`^${SESSION_COOKIE}=;.*Max-Age=0`));
  assert.ok(res.headers['set-cookie'].includes('HttpOnly'));
});

// ── Private API ──

test('GET / PATCH without a session → 401; with one → works and records the owner', async () => {
  await call(api.leads, { method: 'POST', body: newLead() });
  const cookie = await loggedIn();
  const id = (await call(api.leads, withCookie(cookie, { method: 'GET' }))).body.leads[0].id;

  assert.equal((await call(api.leads, { method: 'GET' })).statusCode, 401);
  assert.equal((await call(api.lead, { method: 'GET', query: { id } })).statusCode, 401);
  assert.equal((await call(api.lead, { method: 'PATCH', query: { id }, body: { status: 'won' } })).statusCode, 401);

  const r = await call(api.lead, withCookie(cookie, { method: 'PATCH', query: { id }, body: { status: 'in_progress' } }));
  assert.equal(r.statusCode, 200);
  assert.equal((await call(api.lead, withCookie(cookie, { method: 'PATCH', query: { id }, body: { status: 'won' }, headers: { origin: 'https://evil.example' } }))).statusCode, 403);
  const { rows } = await t.pg.query(`select actor_id from lead_events where type = 'status_changed'`);
  assert.deepEqual(rows, [{ actor_id: 'owner' }]);
});

// ── Push ──

test('push subscribe / unsubscribe require a session', async () => {
  assert.equal((await call(api.push, { method: 'POST', body: sub(1) })).statusCode, 401);
  assert.equal((await call(api.push, { method: 'DELETE', body: sub(1) })).statusCode, 401);

  const cookie = await loggedIn();
  assert.equal((await call(api.push, withCookie(cookie, { method: 'POST', body: sub(1) }))).statusCode, 201);
  assert.equal((await call(api.push, withCookie(cookie, { method: 'POST', body: sub(1) }))).statusCode, 201); // idempotent
  assert.equal((await call(api.push, withCookie(cookie, { method: 'POST', body: sub(2) }))).statusCode, 201);
  assert.equal((await call(api.push, withCookie(cookie, { method: 'POST', body: { endpoint: 'http://insecure/x', keys: sub(3).keys } }))).statusCode, 400);
  assert.equal((await call(api.push, withCookie(cookie, { method: 'POST', body: { endpoint: 'https://x/y', keys: { p256dh: '<script>', auth: 'a' } } }))).statusCode, 400);
  assert.equal((await t.db.listPushSubscriptions()).length, 2);

  assert.equal((await call(api.push, withCookie(cookie, { method: 'DELETE', body: { endpoint: sub(1).endpoint } }))).statusCode, 200);
  assert.deepEqual((await t.db.listPushSubscriptions()).map((s) => s.endpoint), [sub(2).endpoint]);
});

test('push: new lead and repeat inquiry go to every device; dead ones are removed', async () => {
  const cookie = await loggedIn();
  for (const n of [1, 2, 3]) await call(api.push, withCookie(cookie, { method: 'POST', body: sub(n) }));
  deadEndpoints.add(sub(2).endpoint);

  await call(api.leads, { method: 'POST', body: newLead({ name: 'דנה' }) });
  await Promise.all(pending);
  const id = (await call(api.leads, withCookie(cookie, { method: 'GET' }))).body.leads[0].id;
  assert.equal(pushCalls.length, 3);
  assert.deepEqual(pushCalls[0].payload, { title: 'ליד חדש – Casa Mancini', body: 'דנה | התארגנות כלה | 14.05', url: `/leads#/lead/${id}`, tag: `lead-${id}` });

  // The 410 endpoint is gone; the others were marked as working.
  const subs = await t.db.listPushSubscriptions();
  assert.deepEqual(subs.map((s) => s.endpoint).sort(), [sub(1).endpoint, sub(3).endpoint]);
  const { rows } = await t.pg.query('select count(*)::int n from push_subscriptions where last_success_at is not null');
  assert.equal(rows[0].n, 2);

  pushCalls = [];
  await call(api.leads, { method: 'POST', body: newLead({ phone: '+972546787179' }) });
  await Promise.all(pending);
  assert.equal(pushCalls.length, 2);
  assert.deepEqual(pushCalls[0].payload, { title: 'פנייה חוזרת – Casa Mancini', body: 'דנה פנתה שוב · פנייה ×2', url: `/leads#/lead/${id}`, tag: `lead-${id}` });
});

test('push: nothing for spam, rate-limited or retried submissions; push failure never fails the lead', async () => {
  const cookie = await loggedIn();
  await call(api.push, withCookie(cookie, { method: 'POST', body: sub(1) }));

  await call(api.leads, { method: 'POST', body: newLead({ botcheck: 'on' }) });
  const sid = '5b0f2f0e-8a3c-4f6e-9a77-2c1d9e0b1a11';
  await call(api.leads, { method: 'POST', body: newLead({ submission_id: sid }) });
  await call(api.leads, { method: 'POST', body: newLead({ submission_id: sid }) });
  await Promise.all(pending);
  assert.equal(pushCalls.length, 1);

  // A push service that throws for everything: the lead is still saved (201).
  fakeWebpush.sendNotification = async () => { throw Object.assign(new Error('boom'), { statusCode: 500 }); };
  const res = await call(api.leads, { method: 'POST', body: newLead({ phone: '0521234567' }) });
  await Promise.all(pending);
  assert.equal(res.statusCode, 201);
  assert.ok(log.entries.some((e) => e.event === 'push_send_failed'));
});

test('push notification text', () => {
  const created = leadNotification({ name: 'נועה כהן', lead_type: 'production', event_date: null }, { result: 'created', lead_id: 'x' });
  assert.deepEqual([created.title, created.body], ['ליד חדש – Casa Mancini', 'נועה כהן | הפקת צילום']);
  assert.equal(leadNotification({ name: 'x' }, { result: 'duplicate_submission', lead_id: 'x' }), null);
  assert.equal(leadNotification({ name: 'x' }, { result: 'rate_limited' }), null);
});
