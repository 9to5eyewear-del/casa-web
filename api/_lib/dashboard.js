// GET /api/dashboard — the LeadLive home + insights screens in one call.
//
// Postgres does the counting (public.dashboard in db/migrations/004); this
// file only divides those counts (rate / change), ranks the attention list
// and turns the numbers into a few rule-based insights. No AI, no guessing:
// every insight states the counts it rests on, and a rule that lacks data
// stays silent.

import { LEAD_TYPE_LABELS, SOURCE_LABELS } from './catalog.js';
import { attentionList, withPriority } from './priority.js';
import { send, query } from './http.js';
import { defaultLog, withStaff } from './handlers.js';

export const RANGES = new Set(['7d', '30d', 'this_month', 'previous_month', 'custom']);
// Below this many leads a period is too small to compare or rank.
export const MIN_SAMPLE = 5;
const MAX_INSIGHTS = 5;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// ── The only places ratios are computed ──

/** won / leads etc. → { rate (0..1) | null, num, den } */
export function rate(num, den) {
  return { rate: den > 0 ? num / den : null, num, den };
}

/** Relative change, only when the base is big enough to mean something. */
export function change(cur, prev, min = MIN_SAMPLE) {
  return prev >= min ? (cur - prev) / prev : null;
}

const pct = (x) => `${Math.round(x * 100)}%`;
const sourceLabel = (s) => SOURCE_LABELS[s] || s;
const typeLabel = (t) => (t === 'unknown' ? 'לא צוין' : LEAD_TYPE_LABELS[t] || t);
const plural = (n, one, many) => (n === 1 ? one : `${n} ${many}`);

function withRates(rows, total) {
  return rows.map((r) => ({ ...r, share: rate(r.leads, total), conversion: rate(r.won, r.leads) }));
}

/** Rule-based insights, most important first; at most MAX_INSIGHTS. */
export function buildInsights(d) {
  const out = [];
  const { current: cur, previous: prev, open_now: open } = d;
  const add = (rank, insight) => out.push({ rank, ...insight });

  if (open.waiting_24h > 0) {
    add(1, { id: 'waiting', tone: 'alert', icon: '⚠️', title: 'דורש טיפול',
      text: `${plural(open.waiting_24h, 'ליד חדש אחד ממתין', 'לידים חדשים ממתינים')} מעל 24 שעות.` });
  }

  const hot = d.hot_open;
  if (hot > 0) {
    add(2, { id: 'hot', tone: 'alert', icon: '🔥', title: 'לידים חמים פתוחים',
      text: `${plural(hot, 'ליד HOT אחד פתוח', 'לידי HOT פתוחים')} — כדאי לחזור אליהם היום.` });
  }

  // Comparing conversions is only fair once most of the period's leads have
  // an outcome; a fresh period is mostly still open and would always "drop".
  const conv = rate(cur.won, cur.leads), prevConv = rate(prev.won, prev.leads);
  const settled = cur.leads > 0 && (cur.new + cur.in_progress) / cur.leads <= 0.3;
  if (cur.leads >= MIN_SAMPLE && prev.leads >= MIN_SAMPLE && settled) {
    const delta = conv.rate - prevConv.rate;
    if (delta <= -0.05) {
      add(3, { id: 'conversion_down', tone: 'warning', icon: '📉', title: 'ירידה בהמרה',
        text: `ההמרה ירדה מ-${pct(prevConv.rate)} ל-${pct(conv.rate)} לעומת התקופה הקודמת.` });
    } else if (delta >= 0.05) {
      add(9, { id: 'conversion_up', tone: 'positive', icon: '📈', title: 'שיפור בהמרה',
        text: `ההמרה עלתה מ-${pct(prevConv.rate)} ל-${pct(conv.rate)} לעומת התקופה הקודמת.` });
    }
  }

  if (cur.repeat_leads >= 2) {
    add(4, { id: 'repeat', tone: 'info', icon: '↩', title: 'לידים חוזרים',
      text: `${cur.repeat_leads} לקוחות פנו יותר מפעם אחת בתקופה הזו — סימן לעניין גבוה.` });
  }

  const ranked = d.sources.filter((s) => s.leads >= MIN_SAMPLE);
  if (ranked.length >= 2) {
    const byConv = [...ranked].sort((a, b) => b.conversion.rate - a.conversion.rate);
    const [best, worst] = [byConv[0], byConv[byConv.length - 1]];
    if (best.conversion.rate - worst.conversion.rate >= 0.1) {
      add(5, { id: 'top_source', tone: 'positive', icon: '🏆', title: 'מקור מוביל',
        text: `${sourceLabel(best.source)} ממיר ${pct(best.conversion.rate)}, לעומת ${pct(worst.conversion.rate)} ב${sourceLabel(worst.source)}.` });
    }
  }

  const growth = change(cur.leads, prev.leads);
  if (growth != null && Math.abs(growth) >= 0.15) {
    add(6, growth > 0
      ? { id: 'growth_up', tone: 'positive', icon: '↑', title: 'עלייה בביקוש',
          text: `נכנסו ${cur.leads} לידים — ${pct(growth)} יותר מהתקופה הקודמת (${prev.leads}).` }
      : { id: 'growth_down', tone: 'warning', icon: '↓', title: 'ירידה בביקוש',
          text: `נכנסו ${cur.leads} לידים — ${pct(-growth)} פחות מהתקופה הקודמת (${prev.leads}).` });
  }

  const topService = d.services.find((s) => s.lead_type !== 'unknown');
  if (topService && cur.leads >= MIN_SAMPLE && topService.share.rate >= 0.4) {
    add(7, { id: 'top_service', tone: 'info', icon: topService.lead_type === 'bridal' ? '💍' : '✦',
      title: topService.lead_type === 'bridal' ? 'ביקוש לכלות' : 'השירות המבוקש',
      text: `${pct(topService.share.rate)} מהלידים בתקופה הם ל${typeLabel(topService.lead_type)}.` });
  }

  const fa = d.timing.first_action;
  if (fa.samples >= 3) {
    add(8, { id: 'response_time', tone: 'info', icon: '⏱️', title: 'זמן תגובה',
      text: `זמן טיפוסי מליד חדש להתחלת טיפול: ${formatHours(fa.median_hours)} (חציון של ${fa.samples} לידים).` });
  }

  return out.sort((a, b) => a.rank - b.rank).slice(0, MAX_INSIGHTS);
}

export function formatHours(h) {
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} דקות`;
  if (h < 48) return `${(Math.round(h * 10) / 10).toString()} שעות`;
  return `${Math.round(h / 24)} ימים`;
}

/** The one-line status under the greeting. */
export function headline(d) {
  const { open_now: open, current: cur, previous: prev } = d;
  if (open.waiting_24h > 0) return `${plural(open.waiting_24h, 'ליד אחד ממתין', 'לידים ממתינים')} לטיפול מעל 24 שעות`;
  if (open.new > 0) return `${plural(open.new, 'ליד חדש אחד מחכה', 'לידים חדשים מחכים')} לטיפול`;
  const growth = change(cur.leads, prev.leads);
  if (growth != null && Math.abs(growth) >= 0.1) {
    return `בתקופה הזו נכנסו ${pct(Math.abs(growth))} ${growth > 0 ? 'יותר' : 'פחות'} לידים מהתקופה הקודמת`;
  }
  if (open.in_progress > 0) return `הכול מטופל · ${plural(open.in_progress, 'ליד אחד בטיפול', 'לידים בטיפול')}`;
  return 'הכול מטופל';
}

/** Raw SQL aggregates → the payload the app renders. */
export function buildDashboard(raw, now = new Date()) {
  const cur = raw.current, prev = raw.previous;
  const sources = withRates(raw.sources, cur.leads);
  const services = withRates(raw.services, cur.leads);
  const openRanked = raw.open_leads.map((l) => withPriority(l, now));
  const d = { ...raw, sources, services, hot_open: openRanked.filter((l) => l.priority?.level === 'hot').length };

  return {
    range: raw.range,
    headline: headline(d),
    summary: {
      leads: { value: cur.leads, prev: prev.leads, change: change(cur.leads, prev.leads) },
      open_now: { value: raw.open_now.new + raw.open_now.in_progress, ...raw.open_now },
      won: { value: cur.won, prev: prev.won, change: change(cur.won, prev.won) },
      // conversion = won / leads created in the period (see migration 004).
      conversion: {
        ...rate(cur.won, cur.leads),
        prev: rate(prev.won, prev.leads),
        delta: cur.leads >= MIN_SAMPLE && prev.leads >= MIN_SAMPLE
          ? cur.won / cur.leads - prev.won / prev.leads : null,
      },
      hot_open: d.hot_open,
      repeat_leads: cur.repeat_leads,
    },
    pipeline: {
      entered: cur.leads, handled: cur.handled, won: cur.won, lost: cur.lost,
      open: cur.new + cur.in_progress, new: cur.new, in_progress: cur.in_progress,
    },
    sources,
    services,
    trend: { bucket: raw.range.bucket, points: raw.trend },
    timing: raw.timing,
    attention: attentionList(raw.open_leads, now),
    insights: buildInsights(d),
    recent: raw.recent.map((l) => withPriority(l, now)),
    min_sample: MIN_SAMPLE,
  };
}

/**
 * The Judith AI funnel for the period, or null when there's nothing yet (the
 * app shows an empty state). Each rate is against the step before it, plus
 * the two end-to-end ones: conversation → lead and lead → won.
 */
export function buildJudith(f) {
  if (!f || (!f.conversations && !f.leads)) return null;
  f = { whatsapp_shown: 0, ...f };
  return {
    ...f,
    qualified_rate: rate(f.qualified, f.conversations),
    handoff_rate: rate(f.handoff_shown, f.conversations),
    click_rate: rate(f.handoff_clicked, f.handoff_shown),
    whatsapp_rate: rate(f.whatsapp_shown, f.conversations),
    lead_rate: rate(f.leads, f.conversations),
    won_rate: rate(f.won, f.leads),
  };
}

/** GET /api/dashboard?range=7d|30d|this_month|previous_month|custom[&from=YYYY-MM-DD&to=YYYY-MM-DD] */
export function createDashboardHandler(getDeps, { log = defaultLog, now = () => new Date() } = {}) {
  return async function handler(req, res) {
    try {
      if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET');
        return send(res, 405, { error: 'method_not_allowed' });
      }
      const deps = getDeps();
      if (!(await withStaff(deps, req, res))) return;

      const q = query(req);
      const range = q.range || '30d';
      if (!RANGES.has(range)) return send(res, 400, { error: 'invalid range', allowed: [...RANGES] });
      let from = null, to = null;
      if (range === 'custom') {
        const ok = (s) => typeof s === 'string' && ISO_DATE.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));
        if (!ok(q.from) || !ok(q.to) || q.from > q.to) return send(res, 400, { error: 'invalid custom range' });
        if ((Date.parse(q.to) - Date.parse(q.from)) / 86400000 > 366) return send(res, 400, { error: 'range too long' });
        from = q.from; to = q.to;
      }

      const at = now();
      const args = { range, from, to, now: at.toISOString() };
      const [raw, funnel] = await Promise.all([
        deps.db.dashboard(args),
        // Judith's numbers are an extra; if they fail, the dashboard still loads.
        deps.db.judithFunnel(args).catch((err) => {
          log.error('judith_funnel_failed', { error: String(err && err.message || err) });
          return null;
        }),
      ]);
      return send(res, 200, { ...buildDashboard(raw, at), judith: buildJudith(funnel) });
    } catch (err) {
      log.error('dashboard_api_error', { error: String(err && err.message || err) });
      return send(res, 500, { error: 'server_error' });
    }
  };
}
