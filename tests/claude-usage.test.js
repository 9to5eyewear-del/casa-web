// The Claude API card in LeadLive: what each Judith call records, and what
// /api/judith/usage reports from it (and from Anthropic's Cost API when an
// Admin key is set). Real migrations in PGlite; Anthropic is faked.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createUsageHandler, priceRows, classifyError, creditLevel, apiStatus, COST_TTL_MS } from '../api/_lib/judith/usage.js';
import { createChatHandler, DEFAULT_LIMITS } from '../api/_lib/judith/handlers.js';
import { createTestDb, mockReq, mockRes, silentLog, fakeRequireStaff } from './helpers.js';

const NOW = new Date('2026-10-07T09:00:00Z');
const H = 3600000, D = 24 * H;
const ADMIN_KEY = 'sk-ant-admin01-test-secret';

let t, log;
beforeEach(async () => {
  t = await createTestDb();
  log = silentLog();
});

const config = (over = {}) => ({ enabled: true, adminKey: null, creditBudget: null, creditSince: null, ...over });
function usageApi(claude = {}, { now = () => NOW, fetchImpl } = {}) {
  return createUsageHandler(() => ({ db: t.db, requireStaff: fakeRequireStaff, claude: config(claude) }), { log, now, fetchImpl });
}
async function get(handler, query = {}, auth = 'Bearer good') {
  const res = mockRes();
  await handler(mockReq({ method: 'GET', query, headers: auth ? { authorization: auth } : {} }), res);
  return res;
}
async function call({ at, model = 'claude-sonnet-5-5', ok = true, error = null, input = 0, write = 0, read = 0, output = 0 }) {
  await t.pg.query(`insert into claude_calls (created_at, model, ok, error, input_tokens, cache_write_tokens, cache_read_tokens, output_tokens)
    values ($1, $2, $3, $4, $5, $6, $7, $8)`, [at, model, ok, error, input, write, read, output]);
}

// Stands in for fetch to the Cost API: one response per call, records URLs and headers.
function fakeCostApi(...responses) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url: String(url), headers: opts.headers });
    const r = responses.length > 1 ? responses.shift() : responses[0];
    if (r instanceof Error) throw r;
    return { ok: r.status === 200, status: r.status, json: async () => r.body };
  };
  fn.calls = calls;
  return fn;
}
const bucket = (day, cents) => ({ starting_at: `${day}T00:00:00Z`, ending_at: `${day}T23:59:59Z`, results: cents == null ? [] : [{ amount: String(cents), currency: 'USD' }] });

// ── Pure rules ──

test('pricing: tokens × the official per-MTok rates; unknown models are counted, not priced', () => {
  const r = priceRows([
    // Sonnet 5.5: $2 in, $2.50 5m cache write, $0.20 cache read, $10 out per MTok
    { model: 'claude-sonnet-5-5', calls: 2, input: 1_000_000, cache_write: 1_000_000, cache_read: 1_000_000, output: 1_000_000 },
    { model: 'claude-opus-5-5', calls: 1, input: 0, cache_write: 0, cache_read: 0, output: 100_000 },   // $2.00
    { model: 'some-future-model', calls: 3, input: 999, cache_write: 0, cache_read: 0, output: 999 },
  ]);
  assert.equal(Math.round(r.usd * 100) / 100, 2 + 2.5 + 0.2 + 10 + 2);
  assert.equal(r.calls, 6);
  assert.equal(r.unpriced, 3);
});

test('credit levels follow the agreed thresholds', () => {
  assert.equal(creditLevel(3.74), 'ok');
  assert.equal(creditLevel(1.01), 'ok');
  assert.equal(creditLevel(1), 'low');
  assert.equal(creditLevel(0.5), 'low');
  assert.equal(creditLevel(0.49), 'critical');
  assert.equal(creditLevel(0), 'empty');
  assert.equal(creditLevel(-0.2), 'empty');
});

test('errors: an empty balance, a bad key, overload and network are told apart', () => {
  const err = (status, message = '') => Object.assign(new Error(message), { status });
  assert.equal(classifyError(err(400, '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}')), 'credit');
  assert.equal(classifyError(err(400, 'max_tokens too large')), 'other');
  assert.equal(classifyError(err(401)), 'auth');
  assert.equal(classifyError(err(429)), 'rate_limit');
  assert.equal(classifyError(err(529)), 'overloaded');
  assert.equal(classifyError(new Error('fetch failed')), 'network');
  assert.equal(apiStatus(false, { ok: true }), 'off');
  assert.equal(apiStatus(true, null), 'idle');
  assert.equal(apiStatus(true, { ok: false, error: 'credit' }), 'no_credit');
});

// ── /api/judith/usage from Judith's own log ──

test('usage requires the LeadLive session', async () => {
  assert.equal((await get(usageApi(), {}, null)).statusCode, 401);
  assert.equal((await get(usageApi(), {}, 'Bearer outsider')).statusCode, 403);
});

test('no Admin key: today / month / calls come from Judith\'s log, and no balance is claimed', async () => {
  await call({ at: new Date(+NOW - H), input: 100_000, output: 10_000 });               // today: $0.20 + $0.10
  await call({ at: new Date(+NOW - 3 * D), read: 1_000_000 });                 // this month: $0.20
  await call({ at: new Date('2026-09-28T12:00:00Z'), output: 1_000_000 });              // last month: not counted
  await call({ at: new Date(+NOW - 2 * H), ok: false, error: 'overloaded' });           // a failed call: counted, $0

  const res = await get(usageApi());
  assert.equal(res.statusCode, 200);
  const { usage, budget, status } = res.body;
  assert.equal(usage.source, 'judith_log');
  assert.equal(usage.today_usd, 0.3);
  assert.equal(usage.month_usd, 0.5);
  assert.equal(usage.calls_today, 2);
  assert.equal(usage.calls_month, 3);
  assert.equal(budget, null);
  assert.equal(res.body.balance_api, false);
  assert.equal(status.state, 'active');                 // the latest call (an hour ago) succeeded
  assert.equal(res.body.updated_at, NOW.toISOString());
});

test('estimated balance: budget minus spend since ANTHROPIC_CREDIT_SINCE, with the alert level', async () => {
  await call({ at: new Date('2026-09-20T12:00:00Z'), output: 50_000 });   // before the date: $0.50, ignored
  await call({ at: new Date('2026-10-02T12:00:00Z'), output: 20_000 });   // $0.20
  await call({ at: new Date(+NOW - H), output: 6_000 });                  // $0.06

  let b = (await get(usageApi({ creditBudget: 4, creditSince: '2026-10-01' }))).body.budget;
  assert.deepEqual(b, { budget_usd: 4, since: '2026-10-01', spent_usd: 0.26, complete: true, remaining_usd: 3.74, level: 'ok' });

  b = (await get(usageApi({ creditBudget: 1, creditSince: '2026-10-01' }))).body.budget;
  assert.equal(b.remaining_usd, 0.74);
  assert.equal(b.level, 'low');

  b = (await get(usageApi({ creditBudget: 0.2, creditSince: '2026-10-01' }))).body.budget;
  assert.equal(b.level, 'empty');

  // Without a date, the estimate counts from Judith's first recorded call.
  b = (await get(usageApi({ creditBudget: 4 }))).body.budget;
  assert.equal(b.since, '2026-09-20');
  assert.equal(b.spent_usd, 0.76);
});

test('status: the last call decides — out of credit, bad key, or Judith switched off', async () => {
  assert.equal((await get(usageApi())).body.status.state, 'idle');
  await call({ at: new Date(+NOW - 2 * H) });
  await call({ at: new Date(+NOW - H), ok: false, error: 'credit' });
  let s = (await get(usageApi())).body.status;
  assert.equal(s.state, 'no_credit');
  assert.equal(s.last_error, 'credit');
  await call({ at: new Date(+NOW - 30 * 60000), ok: false, error: 'auth' });
  assert.equal((await get(usageApi())).body.status.state, 'auth_error');
  assert.equal((await get(usageApi({ enabled: false }))).body.status.state, 'off');
});

// ── With an Admin key: Anthropic's Cost API, cached ──

const costPage = { status: 200, body: { data: [bucket('2026-09-30', 900), bucket('2026-10-01', 12), bucket('2026-10-06', 14), bucket('2026-10-07', 5.5)], has_more: false, next_page: null } };

test('Admin key: dollars come from the Cost API (cents → USD); the key is sent only to Anthropic', async () => {
  await call({ at: new Date(+NOW - H), output: 1000 });
  const fetchImpl = fakeCostApi(costPage);
  const res = await get(usageApi({ adminKey: ADMIN_KEY, creditBudget: 4, creditSince: '2026-09-30' }, { fetchImpl }));
  const { usage, budget } = res.body;
  assert.equal(usage.source, 'anthropic');
  assert.equal(usage.today_usd, 0.055);
  assert.equal(usage.month_usd, 0.315);
  assert.equal(usage.calls_today, 1);                   // request counts still come from Judith's log
  assert.equal(budget.spent_usd, 9.315);
  assert.equal(budget.level, 'empty');

  assert.equal(fetchImpl.calls.length, 1);
  const url = new URL(fetchImpl.calls[0].url);
  assert.equal(url.origin + url.pathname, 'https://api.anthropic.com/v1/organizations/cost_report');
  assert.equal(url.searchParams.get('starting_at'), '2026-09-30T00:00:00.000Z');
  assert.equal(url.searchParams.get('ending_at'), '2026-10-08T00:00:00.000Z');   // today's bucket included
  assert.equal(fetchImpl.calls[0].headers['x-api-key'], ADMIN_KEY);
  assert.doesNotMatch(JSON.stringify(res.body), /sk-ant/);
});

test('cache: dashboard loads within 20 min reuse the answer; "רענון" refetches, at most once a minute', async () => {
  const fetchImpl = fakeCostApi(costPage);
  let clock = NOW;
  const api = usageApi({ adminKey: ADMIN_KEY }, { fetchImpl, now: () => clock });

  await get(api);
  clock = new Date(+NOW + COST_TTL_MS - 1000);
  const cached = (await get(api)).body;
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(cached.updated_at, NOW.toISOString());   // "עודכן" shows when Anthropic was last asked

  clock = new Date(+NOW + 30_000);
  await get(api, { refresh: '1' });
  assert.equal(fetchImpl.calls.length, 1);              // refresh within a minute: still cached
  clock = new Date(+NOW + 61_000);
  await get(api, { refresh: '1' });
  assert.equal(fetchImpl.calls.length, 2);

  clock = new Date(+NOW + COST_TTL_MS + 62_000);
  await get(api);
  assert.equal(fetchImpl.calls.length, 3);              // expired
});

test('Cost API down: the last answer is shown as stale; with none, Judith\'s log is used — never an error page', async () => {
  await call({ at: new Date(+NOW - H), output: 1000 });   // $0.01
  const fetchImpl = fakeCostApi(costPage, new Error('network down'));
  let clock = NOW;
  const api = usageApi({ adminKey: ADMIN_KEY }, { fetchImpl, now: () => clock });
  await get(api);
  clock = new Date(+NOW + COST_TTL_MS + 1000);
  const stale = (await get(api)).body;
  assert.equal(stale.usage.source, 'anthropic');
  assert.equal(stale.usage.stale, true);
  assert.equal(stale.usage.today_usd, 0.055);

  await t.pg.query('delete from claude_cost_cache');
  const down = await get(usageApi({ adminKey: ADMIN_KEY }, { fetchImpl: fakeCostApi({ status: 403, body: {} }) }));
  assert.equal(down.statusCode, 200);
  assert.equal(down.body.usage.source, 'judith_log');
  assert.equal(down.body.usage.anthropic_error, true);
  assert.equal(down.body.usage.today_usd, 0.01);
  assert.ok(log.entries.some((e) => e.event === 'claude_cost_api_failed'));
});

// ── What the chat records ──

test('each Judith call records Anthropic\'s token counts; failures record why, with no tokens', async () => {
  const replies = [
    { content: [{ type: 'text', text: JSON.stringify({ message: 'שלום', state: {}, qualified: false, handoff_ready: false, whatsapp: false, lead_summary: null }) }],
      stop_reason: 'end_turn', model: 'claude-sonnet-5-5',
      usage: { input_tokens: 120, cache_creation_input_tokens: 3000, cache_read_input_tokens: 0, output_tokens: 80 } },
    Object.assign(new Error('400 Your credit balance is too low to access the Anthropic API.'), { status: 400 }),
    { content: [], stop_reason: 'refusal', model: 'claude-sonnet-5-5', usage: { input_tokens: 50, output_tokens: 2 } },
  ];
  const client = { messages: { async create() { const r = replies.shift(); if (r instanceof Error) throw r; return r; } } };
  const chat = createChatHandler(() => ({ db: t.db, ipHashKey: 'k', anthropic: client, judithModel: 'claude-sonnet-5-5', judithLimits: DEFAULT_LIMITS }),
    { log, now: () => NOW });
  const say = async () => {
    const res = mockRes();
    await chat(mockReq({ method: 'POST', body: { message: 'היי' }, headers: { origin: 'https://www.casamancini.site' } }), res);
    return res.statusCode;
  };
  assert.equal(await say(), 200);
  assert.equal(await say(), 503);
  assert.equal(await say(), 503);

  const { rows } = await t.pg.query('select model, ok, error, input_tokens, cache_write_tokens, cache_read_tokens, output_tokens from claude_calls order by id');
  assert.deepEqual(rows, [
    { model: 'claude-sonnet-5-5', ok: true, error: null, input_tokens: 120, cache_write_tokens: 3000, cache_read_tokens: 0, output_tokens: 80 },
    { model: 'claude-sonnet-5-5', ok: false, error: 'credit', input_tokens: 0, cache_write_tokens: 0, cache_read_tokens: 0, output_tokens: 0 },
    // A refusal is still a billed call.
    { model: 'claude-sonnet-5-5', ok: true, error: null, input_tokens: 50, cache_write_tokens: 0, cache_read_tokens: 0, output_tokens: 2 },
  ]);
  // Estimated cost per call: 120×$2 + 3000×$2.50 + 80×$10 per MTok; a failed request costs nothing.
  const costs = (await t.pg.query('select est_cost_usd::float8 as c from claude_calls order by id')).rows.map((r) => r.c);
  assert.deepEqual(costs, [0.00854, 0, 0.00012]);
});

test('a failure to record never costs the visitor their reply', async () => {
  const client = { messages: { async create() {
    return { content: [{ type: 'text', text: JSON.stringify({ message: 'שלום', state: {}, qualified: false, handoff_ready: false, whatsapp: false, lead_summary: null }) }],
      stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } };
  } } };
  const db = { ...t.db, claudeRecordCall: async () => { throw new Error('db down'); } };
  const chat = createChatHandler(() => ({ db, ipHashKey: 'k', anthropic: client, judithModel: 'claude-sonnet-5-5', judithLimits: DEFAULT_LIMITS }), { log, now: () => NOW });
  const res = mockRes();
  await chat(mockReq({ method: 'POST', body: { message: 'היי' }, headers: { origin: 'https://www.casamancini.site' } }), res);
  assert.equal(res.statusCode, 200);
  assert.ok(log.entries.some((e) => e.event === 'claude_record_failed'));
});
