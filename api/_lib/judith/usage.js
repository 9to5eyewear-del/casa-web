// GET /api/judith/usage — the "Claude API" card in LeadLive: is Judith's
// Claude access working, and what has it cost?
//
// What Anthropic offers (checked against platform.claude.com, Oct 2026):
//  - No API returns the remaining prepaid credit. So nothing here is ever
//    called a balance. With ANTHROPIC_CREDIT_BUDGET set, the card shows an
//    *estimate*: that amount minus what was spent since ANTHROPIC_CREDIT_SINCE.
//  - The Usage & Cost Admin API (/v1/organizations/cost_report) has real
//    dollar costs, but only with an Admin key (sk-ant-admin…), which
//    individual accounts can't create. With ANTHROPIC_ADMIN_KEY set it is the
//    source of the dollar figures (the whole organization), cached in the DB
//    for COST_TTL so a dashboard load doesn't call Anthropic.
//  - Otherwise the figures come from Judith's own log: the token counts
//    Anthropic returns with every response, priced from the public price list.
//    That covers Judith's calls only.
// Days and months are UTC, like Anthropic's billing.
//
// The keys never leave the server; the app gets only the summary below.

import { send, query } from '../http.js';
import { defaultLog, withStaff } from '../handlers.js';

// USD per million tokens (platform.claude.com/docs/en/about-claude/pricing,
// Oct 2026). Judith caches with the default 5-minute TTL, so cache writes are
// the 5m rate. A model missing here is counted but not priced.
export const PRICES = {
  'claude-sonnet-5-5': { input: 2, cacheWrite: 2.5, cacheRead: 0.2, output: 10 },
  'claude-sonnet-5': { input: 2, cacheWrite: 2.5, cacheRead: 0.2, output: 10 },
  'claude-opus-5-5': { input: 4, cacheWrite: 5, cacheRead: 0.2, output: 20 },
  'claude-opus-5': { input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 25 },
  'claude-haiku-4-5': { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 },
};

export const COST_TTL_MS = 20 * 60 * 1000;
// "רענון" may skip the cache, but not more than once a minute (Anthropic's
// recommended polling rate for this API).
export const MIN_REFRESH_MS = 60 * 1000;
const COST_REPORT_URL = 'https://api.anthropic.com/v1/organizations/cost_report';
const MAX_PAGES = 13;   // 31 days a page: a year back is plenty
const DAY = 86400000;

export const priceOf = (model) => PRICES[model] || PRICES[String(model).replace(/-\d{8}$/, '')] || null;

/** One response's usage → its price-list cost in USD, or null for an unknown model. */
export function callCost(model, usage) {
  const p = priceOf(model);
  if (!p) return null;
  const u = usage || {};
  return ((u.input_tokens ?? 0) * p.input + (u.cache_creation_input_tokens ?? 0) * p.cacheWrite
    + (u.cache_read_input_tokens ?? 0) * p.cacheRead + (u.output_tokens ?? 0) * p.output) / 1e6;
}

/** Per-model token rows from claude_usage → { usd, calls, unpriced } */
export function priceRows(rows) {
  let usd = 0, calls = 0, unpriced = 0;
  for (const r of rows || []) {
    const n = Number(r.calls);
    calls += n;
    const p = priceOf(r.model);
    if (!p) { unpriced += n; continue; }
    usd += (Number(r.input) * p.input + Number(r.cache_write) * p.cacheWrite
      + Number(r.cache_read) * p.cacheRead + Number(r.output) * p.output) / 1e6;
  }
  return { usd, calls, unpriced };
}

/** An Anthropic SDK error → the reason stored on the call. */
export function classifyError(err) {
  const status = err?.status;
  // Anthropic answers an empty prepaid balance with a 400 whose message says
  // so; there is no dedicated error type for it.
  if (status === 400 && /credit balance/i.test(String(err?.message || ''))) return 'credit';
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'overloaded';
  if (status == null) return 'network';
  return 'other';
}

/** The alert level for an estimated remaining credit (USD). */
export function creditLevel(usd) {
  if (usd > 1) return 'ok';
  if (usd >= 0.5) return 'low';
  if (usd > 0) return 'critical';
  return 'empty';
}

/** Judith's state from the configuration and the last call. */
export function apiStatus(enabled, lastCall) {
  if (!enabled) return 'off';
  if (!lastCall) return 'idle';
  if (lastCall.ok) return 'active';
  if (lastCall.error === 'credit') return 'no_credit';
  if (lastCall.error === 'auth') return 'auth_error';
  return 'error';
}

const utcDay = (t) => new Date(Math.floor(t / DAY) * DAY);
const utcMonth = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
const round = (x) => Math.round(x * 10000) / 10000;

/** Daily USD costs from the Cost API, oldest first: [{ start, usd }]. */
export async function fetchDailyCosts({ adminKey, from, to, fetchImpl = fetch, timeoutMs = 8000 }) {
  const days = [];
  let page = null;
  for (let i = 0; i < MAX_PAGES; i++) {
    const url = new URL(COST_REPORT_URL);
    url.searchParams.set('starting_at', from.toISOString());
    url.searchParams.set('ending_at', to.toISOString());
    url.searchParams.set('bucket_width', '1d');
    url.searchParams.set('limit', '31');
    if (page) url.searchParams.set('page', page);
    const res = await fetchImpl(url, {
      headers: { 'x-api-key': adminKey, 'anthropic-version': '2023-06-01', 'user-agent': 'CasaMancini-LeadLive/1.0' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`cost_report HTTP ${res.status}`);
    const body = await res.json();
    // amount is a decimal string in cents ("123.45" = $1.23).
    for (const b of body.data || []) {
      days.push({ start: b.starting_at, usd: (b.results || []).reduce((s, r) => s + (Number(r.amount) || 0), 0) / 100 });
    }
    if (!body.has_more || !body.next_page) return days;
    page = body.next_page;
  }
  throw new Error('cost_report: too many pages');
}

/** Today / month / since-day totals from the Cost API, through the DB cache. */
async function anthropicCosts({ db, adminKey, sinceDay, at, force, fetchImpl }) {
  const row = await db.claudeCostCacheGet();
  const cached = row && { data: row.data, fetched_at: new Date(row.fetched_at).toISOString() };
  const age = cached ? at - Date.parse(cached.fetched_at) : Infinity;
  const fits = cached && cached.data.since === sinceDay && cached.data.month === utcMonth(at).toISOString().slice(0, 7)
    && cached.data.day === utcDay(+at).toISOString().slice(0, 10);
  if (fits && age < (force ? MIN_REFRESH_MS : COST_TTL_MS)) return { ...cached.data, fetched_at: cached.fetched_at, stale: false };

  try {
    const today = utcDay(+at), month = utcMonth(at);
    const sinceDate = new Date(sinceDay + 'T00:00:00Z');
    const from = new Date(Math.max(Math.min(+month, +sinceDate), +today - 365 * DAY));
    const days = await fetchDailyCosts({ adminKey, from, to: new Date(+today + DAY), fetchImpl });
    const sum = (min) => round(days.filter((d) => Date.parse(d.start) >= +min).reduce((s, d) => s + d.usd, 0));
    const data = {
      since: sinceDay, month: month.toISOString().slice(0, 7), day: today.toISOString().slice(0, 10),
      today_usd: sum(today), month_usd: sum(month), since_usd: sum(sinceDate),
    };
    const fetchedAt = new Date(at).toISOString();
    await db.claudeCostCachePut(data, fetchedAt);
    return { ...data, fetched_at: fetchedAt, stale: false };
  } catch (err) {
    // Anthropic down or the key rejected: the last answer is better than none.
    if (cached && cached.data.since === sinceDay) return { ...cached.data, fetched_at: cached.fetched_at, stale: true, error: err };
    throw err;
  }
}

/** GET /api/judith/usage[?refresh=1] (staff only) */
export function createUsageHandler(getDeps, { log = defaultLog, now = () => new Date(), fetchImpl = fetch } = {}) {
  return async function handler(req, res) {
    try {
      if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET');
        return send(res, 405, { error: 'method_not_allowed' });
      }
      const deps = getDeps();
      if (!(await withStaff(deps, req, res))) return;

      const at = now();
      const cfg = deps.claude;
      const local = await deps.db.claudeUsage({ now: at.toISOString(), since: cfg.creditSince ? `${cfg.creditSince}T00:00:00Z` : null });
      // The estimate counts from ANTHROPIC_CREDIT_SINCE, else from Judith's first call.
      const sinceDay = cfg.creditSince || (local.first_call_at ? new Date(local.first_call_at).toISOString().slice(0, 10)
        : utcDay(+at).toISOString().slice(0, 10));

      const today = priceRows(local.today), month = priceRows(local.month), since = priceRows(local.since);
      const usage = {
        source: 'judith_log',
        today_usd: round(today.usd), month_usd: round(month.usd),
        calls_today: today.calls, calls_month: month.calls,
        // Calls on a model with no known price aren't in the dollar figures.
        unpriced_calls: month.unpriced,
        stale: false, anthropic_error: false,
      };
      let spent = since.usd, spentComplete = since.unpriced === 0, updatedAt = at.toISOString();

      if (cfg.adminKey) {
        try {
          const c = await anthropicCosts({ db: deps.db, adminKey: cfg.adminKey, sinceDay, at, force: query(req).refresh === '1', fetchImpl });
          if (c.error) log.error('claude_cost_api_failed', { error: String(c.error.message || c.error).slice(0, 200), stale: true });
          Object.assign(usage, { source: 'anthropic', today_usd: c.today_usd, month_usd: c.month_usd, unpriced_calls: 0, stale: c.stale });
          spent = c.since_usd; spentComplete = true; updatedAt = c.fetched_at;
        } catch (err) {
          // Falls back to Judith's own log, and says so.
          log.error('claude_cost_api_failed', { error: String(err.message || err).slice(0, 200), stale: false });
          usage.anthropic_error = true;
        }
      }

      const budget = cfg.creditBudget == null ? null : {
        budget_usd: cfg.creditBudget, since: sinceDay, spent_usd: round(spent), complete: spentComplete,
        remaining_usd: round(cfg.creditBudget - spent), level: creditLevel(cfg.creditBudget - spent),
      };
      const last = local.last_call || null;
      return send(res, 200, {
        status: { state: apiStatus(cfg.enabled, last), last_call_at: last ? new Date(last.at).toISOString() : null, last_error: last && !last.ok ? last.error : null },
        usage,
        budget,
        balance_api: false,   // Anthropic offers no remaining-credit API
        updated_at: updatedAt,
      });
    } catch (err) {
      log.error('claude_usage_error', { error: String(err && err.message || err) });
      return send(res, 500, { error: 'server_error' });
    }
  };
}
