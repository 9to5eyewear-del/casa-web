// /api/dashboard end to end (real migrations in PGlite), plus the priority
// and insight rules on their own.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createDashboardHandler, buildInsights, rate, change, headline, MIN_SAMPLE } from '../api/_lib/dashboard.js';
import { createLeadsHandler } from '../api/_lib/handlers.js';
import { attentionPriority, attentionList, daysUntil } from '../api/_lib/priority.js';
import { createTestDb, mockReq, mockRes, silentLog, fakeRequireStaff } from './helpers.js';

// Tuesday 6 Oct 2026, 12:00 in Israel.
const NOW = new Date('2026-10-06T09:00:00Z');
const H = 3600000, D = 24 * H;
const ago = (ms) => new Date(NOW - ms).toISOString();

let t, dashApi, leadsApi;

beforeEach(async () => {
  t = await createTestDb();
  const deps = () => ({ db: t.db, ipHashKey: 'k', requireStaff: fakeRequireStaff });
  dashApi = createDashboardHandler(deps, { log: silentLog(), now: () => NOW });
  leadsApi = createLeadsHandler(deps, { log: silentLog(), now: () => NOW });
});

async function call(handler, query, auth = 'Bearer good') {
  const res = mockRes();
  await handler(mockReq({ method: 'GET', query, headers: auth ? { authorization: auth } : {} }), res);
  return res;
}
const dash = (range = '30d', extra = {}) => call(dashApi, { range, ...extra });

let seq = 0;
// Inserts a lead as if it arrived at `created`, with the given outcome.
async function lead({ created, status = 'new', source = 'website_form', type = 'bridal', score = null,
  eventDate = null, repeats = 0, firstActionAfter = null, closedAfter = null, name } = {}) {
  seq++;
  const createdAt = new Date(created);
  const last = repeats ? new Date(+createdAt + H) : createdAt;
  const { rows: [{ id }] } = await t.pg.query(
    `insert into leads (created_at, last_submission_at, source, status, name, phone, phone_normalized, lead_type,
       event_date, lead_score, submission_count, status_changed_at, closed_at, seen_at)
     values ($1, $2, $3, $4, $5, '050', $6, $7, $8, $9, $10, $11, $12, $1) returning id`,
    [createdAt, last, source, status, name || `ליד ${seq}`, `97250${String(1000000 + seq)}`, type, eventDate, score,
      1 + repeats, status === 'new' ? null : createdAt,
      status === 'won' ? new Date(+createdAt + (closedAfter ?? D)) : null]);
  await t.pg.query(`insert into lead_events (lead_id, type, created_at) values ($1, 'lead_created', $2)`, [id, createdAt]);
  for (let i = 0; i < repeats; i++) {
    await t.pg.query(`insert into lead_events (lead_id, type, created_at) values ($1, 'repeat_submission', $2)`, [id, last]);
  }
  if (status !== 'new') {
    await t.pg.query(`insert into lead_events (lead_id, type, created_at, from_status, to_status) values ($1, 'status_changed', $2, 'new', $3)`,
      [id, new Date(+createdAt + (firstActionAfter ?? H)), status]);
  }
  return id;
}

test('dashboard requires the session', async () => {
  assert.equal((await dash('30d', {})).statusCode, 200);
  const res = await call(dashApi, { range: '30d' }, null);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.leads, undefined);
});

test('dashboard rejects unknown ranges and bad custom dates', async () => {
  assert.equal((await dash('1y')).statusCode, 400);
  assert.equal((await dash('custom', { from: '2026-10-05', to: '2026-10-01' })).statusCode, 400);
  assert.equal((await dash('custom', { from: '2026-13-01', to: '2026-10-01' })).statusCode, 400);
  assert.equal((await dash('custom', { from: '2024-01-01', to: '2026-10-01' })).statusCode, 400);
  assert.equal((await dash('custom', { from: '2026-09-01', to: '2026-09-30' })).statusCode, 200);
});

test('empty database: zeros, no ratios, no insights, calm headline', async () => {
  const { statusCode, body } = await dash('30d');
  assert.equal(statusCode, 200);
  assert.equal(body.summary.leads.value, 0);
  assert.equal(body.summary.leads.change, null);
  assert.equal(body.summary.conversion.rate, null);
  assert.equal(body.summary.conversion.delta, null);
  assert.deepEqual(body.sources, []);
  assert.deepEqual(body.attention, []);
  assert.deepEqual(body.insights, []);
  assert.equal(body.headline, 'הכול מטופל');
  assert.equal(body.trend.bucket, 'day');
  assert.equal(body.trend.points.length, 30);
  assert.ok(body.trend.points.every((p) => p.leads === 0));
});

test('period bounds follow Israel time for every range', async () => {
  const r = async (range, extra) => (await dash(range, extra)).body.range;
  const week = await r('7d');
  assert.equal(new Date(week.from).toISOString(), '2026-09-29T21:00:00.000Z'); // 30 Sep 00:00 IDT
  assert.equal(new Date(week.prev_from).toISOString(), '2026-09-22T21:00:00.000Z');
  assert.equal(new Date(week.prev_to).toISOString(), new Date(NOW - 7 * D).toISOString());

  const month = await r('this_month');
  assert.equal(new Date(month.from).toISOString(), '2026-09-30T21:00:00.000Z'); // 1 Oct 00:00 IDT
  assert.equal(new Date(month.prev_from).toISOString(), '2026-08-31T21:00:00.000Z');
  assert.equal(month.days, 6);

  const last = await r('previous_month');
  assert.equal(new Date(last.from).toISOString(), '2026-08-31T21:00:00.000Z');
  assert.equal(new Date(last.to).toISOString(), '2026-09-30T21:00:00.000Z');
  assert.equal(last.days, 30);

  const custom = await r('custom', { from: '2026-01-01', to: '2026-06-30' });
  assert.equal(custom.bucket, 'week');
});

test('few leads: counts, conversion as won/leads, pipeline, sources, services', async () => {
  await lead({ created: ago(2 * D), status: 'won', source: 'lead_page', type: 'production' });
  await lead({ created: ago(3 * D), status: 'lost' });
  await lead({ created: ago(4 * D), status: 'in_progress' });
  await lead({ created: ago(2 * H), status: 'new', type: null });
  await lead({ created: ago(40 * D), status: 'won' });            // outside 30d: previous period

  const { body } = await dash('30d');
  assert.equal(body.summary.leads.value, 4);
  assert.equal(body.summary.leads.prev, 1);
  assert.equal(body.summary.leads.change, null);                 // previous period too small to compare
  assert.deepEqual([body.summary.conversion.num, body.summary.conversion.den], [1, 4]);
  assert.equal(body.summary.conversion.rate, 0.25);
  assert.equal(body.summary.conversion.delta, null);
  assert.equal(body.summary.open_now.value, 2);
  assert.deepEqual(body.pipeline, { entered: 4, handled: 3, won: 1, lost: 1, open: 2, new: 1, in_progress: 1 });

  const site = body.sources.find((s) => s.source === 'website_form');
  assert.deepEqual([site.leads, site.won, site.conversion.rate, site.share.rate], [3, 0, 0, 0.75]);
  const page = body.sources.find((s) => s.source === 'lead_page');
  assert.deepEqual([page.leads, page.won, page.conversion.rate], [1, 1, 1]);

  assert.deepEqual(body.services.map((s) => [s.lead_type, s.leads]), [['bridal', 2], ['production', 1], ['unknown', 1]]);
  assert.equal(body.trend.points.reduce((n, p) => n + p.leads, 0), 4);
  assert.equal(body.trend.points.reduce((n, p) => n + p.won, 0), 1);
  // Too little data: no comparison insights.
  assert.ok(!body.insights.some((i) => /growth|conversion|top_source|top_service/.test(i.id)));
});

test('many leads: period comparison, source quality, service demand, growth', async () => {
  // Current 30d: 12 leads. Lead page 6 (4 won), website 6 (1 won). Mostly settled.
  for (let i = 0; i < 6; i++) await lead({ created: ago((i + 2) * D), source: 'lead_page', status: i < 4 ? 'won' : 'lost' });
  for (let i = 0; i < 6; i++) await lead({ created: ago((i + 2) * D), status: i < 1 ? 'won' : 'lost', type: i < 3 ? 'bridal' : 'fashion' });
  // Previous 30d: 6 leads, 4 won.
  for (let i = 0; i < 6; i++) await lead({ created: ago((35 + i) * D), status: i < 4 ? 'won' : 'lost' });

  const { body } = await dash('30d');
  assert.equal(body.summary.leads.value, 12);
  assert.equal(body.summary.leads.prev, 6);
  assert.equal(body.summary.leads.change, 1);
  assert.ok(Math.abs(body.summary.conversion.delta - (5 / 12 - 4 / 6)) < 1e-9);

  const ids = body.insights.map((i) => i.id);
  assert.ok(ids.includes('conversion_down'));
  assert.ok(ids.includes('top_source'));
  assert.ok(ids.includes('growth_up'));
  assert.match(body.insights.find((i) => i.id === 'top_source').text, /דף ליד ממיר 67%, לעומת 17% בטופס באתר/);
  assert.ok(ids.indexOf('conversion_down') < ids.indexOf('top_source'));
  assert.ok(body.insights.length <= 5);
  assert.equal(body.trend.points.length, 30);
});

test('future source (judith_ai) flows through sources with no code change', async () => {
  await lead({ created: ago(D), source: 'judith_ai', status: 'won' });
  const { body } = await dash('7d');
  assert.deepEqual(body.sources.map((s) => s.source), ['judith_ai']);
});

test('repeat leads, HOT, waiting and close dates feed attention + insights', async () => {
  const waiting = await lead({ created: ago(30 * H), name: 'ממתינה' });
  const repeat = await lead({ created: ago(5 * D), status: 'in_progress', repeats: 2, name: 'חוזרת' });
  await lead({ created: ago(6 * D), status: 'in_progress', repeats: 1 });
  const hot = await lead({ created: ago(20 * 60000), score: 'hot', eventDate: '2026-10-18', name: 'נועה' });
  await lead({ created: ago(2 * D), status: 'won', eventDate: '2026-10-10' }); // closed: never in attention
  await lead({ created: ago(10 * D), status: 'in_progress', score: 'cold' });   // nothing urgent

  const { body } = await dash('30d');
  assert.equal(body.summary.repeat_leads, 2);
  assert.equal(body.summary.open_now.waiting_24h, 1);
  assert.equal(body.attention[0].id, hot);
  assert.equal(body.attention[0].priority.level, 'hot');
  assert.deepEqual(body.attention[0].priority.reasons, ['hot', 'date_soon']);
  const byId = Object.fromEntries(body.attention.map((l) => [l.id, l.priority.reasons]));
  assert.ok(byId[waiting].includes('waiting'));
  assert.ok(byId[repeat].includes('repeat'));
  assert.equal(body.attention.length, 4);

  const ids = body.insights.map((i) => i.id);
  assert.deepEqual(ids.slice(0, 2), ['waiting', 'hot']);
  assert.ok(ids.includes('repeat'));
  assert.equal(body.headline, 'ליד אחד ממתין לטיפול מעל 24 שעות');
  // The dashboard sends only the fields it shows.
  assert.equal(body.attention[0].email, undefined);
  assert.equal(body.attention[0].metadata, undefined);
});

test('time to first action and time to close come from lead_events / closed_at', async () => {
  await lead({ created: ago(3 * D), status: 'in_progress', firstActionAfter: 1 * H });
  await lead({ created: ago(3 * D), status: 'won', firstActionAfter: 2 * H, closedAfter: 2 * D });
  await lead({ created: ago(3 * D), status: 'lost', firstActionAfter: 6 * H });
  const { body } = await dash('7d');
  assert.equal(body.timing.first_action.samples, 3);
  assert.equal(body.timing.first_action.median_hours, 2);
  assert.equal(body.timing.close.samples, 1);
  assert.equal(body.timing.close.median_days, 2);
  assert.ok(body.insights.some((i) => i.id === 'response_time' && i.text.includes('2 שעות')));
});

test('lead list: HOT and repeat quick filters, priority on every lead', async () => {
  const hot = await lead({ created: ago(10 * 60000), score: 'hot', eventDate: '2026-10-12' });
  const rep = await lead({ created: ago(3 * D), status: 'lost', repeats: 1 });
  await lead({ created: ago(4 * D), status: 'in_progress', score: 'cold' });

  const all = (await call(leadsApi, {})).body;
  assert.equal(all.leads.length, 3);
  assert.equal(all.leads.find((l) => l.id === rep).priority, null);   // closed
  assert.ok(all.leads.every((l) => 'priority' in l));

  const hotList = (await call(leadsApi, { flag: 'hot' })).body;
  assert.deepEqual(hotList.leads.map((l) => l.id), [hot]);
  assert.equal(hotList.next_cursor, null);

  const repList = (await call(leadsApi, { flag: 'repeat' })).body;
  assert.deepEqual(repList.leads.map((l) => l.id), [rep]);

  assert.equal((await call(leadsApi, { flag: 'vip' })).statusCode, 400);
});

// ── Pure rules ──

test('rate and change: one definition, honest about small samples', () => {
  assert.deepEqual(rate(3, 12), { rate: 0.25, num: 3, den: 12 });
  assert.deepEqual(rate(0, 0), { rate: null, num: 0, den: 0 });
  assert.equal(change(12, 10), 0.2);
  assert.equal(change(12, MIN_SAMPLE - 1), null);
});

test('priority: closed leads have none; fresh repeat with a near date is hot', () => {
  const base = { status: 'in_progress', created_at: ago(10 * D), last_submission_at: ago(10 * D), submission_count: 1 };
  assert.equal(attentionPriority({ ...base, status: 'won' }, NOW), null);
  assert.equal(attentionPriority(base, NOW).level, 'cold');
  const p = attentionPriority({ ...base, last_submission_at: ago(30 * 60000), submission_count: 3, event_date: '2026-10-15' }, NOW);
  assert.equal(p.level, 'hot');
  assert.deepEqual(p.reasons, ['hot', 'repeat', 'date_soon']);
  assert.equal(daysUntil('2026-10-07', NOW), 1);
  assert.equal(attentionList([base], NOW).length, 0); // nothing urgent → not listed
});

test('insights: silence without data, ranked and capped when everything fires', () => {
  const empty = {
    current: { leads: 0, new: 0, in_progress: 0, won: 0, lost: 0, handled: 0, repeat_leads: 0 },
    previous: { leads: 0, new: 0, in_progress: 0, won: 0, lost: 0, handled: 0, repeat_leads: 0 },
    open_now: { new: 0, in_progress: 0, waiting_24h: 0 }, hot_open: 0, sources: [], services: [],
    timing: { first_action: { samples: 0 }, close: { samples: 0 } },
  };
  assert.deepEqual(buildInsights(empty), []);
  assert.equal(headline(empty), 'הכול מטופל');

  const full = {
    ...empty,
    current: { leads: 20, new: 1, in_progress: 1, won: 4, lost: 14, handled: 19, repeat_leads: 3 },
    previous: { leads: 10, new: 0, in_progress: 0, won: 5, lost: 5, handled: 10, repeat_leads: 0 },
    open_now: { new: 3, in_progress: 1, waiting_24h: 2 }, hot_open: 1,
    sources: [
      { source: 'lead_page', leads: 8, won: 3, conversion: rate(3, 8) },
      { source: 'website_form', leads: 12, won: 1, conversion: rate(1, 12) }],
    services: [{ lead_type: 'bridal', leads: 12, share: rate(12, 20) }],
    timing: { first_action: { samples: 5, median_hours: 3.4 }, close: { samples: 0 } },
  };
  const ids = buildInsights(full).map((i) => i.id);
  assert.deepEqual(ids, ['waiting', 'hot', 'conversion_down', 'repeat', 'top_source']);
});
