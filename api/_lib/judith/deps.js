import Anthropic from '@anthropic-ai/sdk';
import { productionDeps } from '../deps.js';
import { DEFAULT_LIMITS } from './handlers.js';
import { DEFAULT_MODEL } from './agent.js';

const positiveInt = (v, fallback) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : fallback);

// ANTHROPIC_API_KEY lives only in Vercel's environment. Without it (or with
// JUDITH_ENABLED=0) Judith reports itself off and the homepage shows no chat.
export function judithDeps() {
  const base = productionDeps();
  const env = process.env;
  // A key pasted into the dashboard can carry a stray space or newline.
  const apiKey = (env.ANTHROPIC_API_KEY || '').trim();
  const on = Boolean(apiKey) && env.JUDITH_ENABLED !== '0';
  return {
    db: base.db,
    get ipHashKey() { return base.ipHashKey; },
    anthropic: on ? new Anthropic({ apiKey }) : null,
    judithModel: env.JUDITH_MODEL || DEFAULT_MODEL,
    judithLimits: { ...DEFAULT_LIMITS, globalDailyMax: positiveInt(env.JUDITH_DAILY_LIMIT, DEFAULT_LIMITS.globalDailyMax) },
  };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// For the Claude card in LeadLive (usage.js). ANTHROPIC_ADMIN_KEY (optional,
// organizations only) turns on Anthropic's Cost API. ANTHROPIC_CREDIT_BUDGET
// (USD) with ANTHROPIC_CREDIT_SINCE (YYYY-MM-DD) turns on the estimated balance.
export function claudeUsageDeps() {
  const base = productionDeps();
  const env = process.env;
  const budget = Number((env.ANTHROPIC_CREDIT_BUDGET || '').trim());
  const since = (env.ANTHROPIC_CREDIT_SINCE || '').trim();
  return {
    db: base.db,
    get requireStaff() { return base.requireStaff; },
    claude: {
      enabled: Boolean((env.ANTHROPIC_API_KEY || '').trim()) && env.JUDITH_ENABLED !== '0',
      adminKey: (env.ANTHROPIC_ADMIN_KEY || '').trim() || null,
      creditBudget: (env.ANTHROPIC_CREDIT_BUDGET || '').trim() && Number.isFinite(budget) && budget >= 0 ? budget : null,
      creditSince: ISO_DATE.test(since) && !Number.isNaN(Date.parse(since)) ? since : null,
    },
  };
}
