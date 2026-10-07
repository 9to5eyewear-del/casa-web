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
  const on = Boolean(env.ANTHROPIC_API_KEY) && env.JUDITH_ENABLED !== '0';
  return {
    db: base.db,
    get ipHashKey() { return base.ipHashKey; },
    anthropic: on ? new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }) : null,
    judithModel: env.JUDITH_MODEL || DEFAULT_MODEL,
    judithLimits: { ...DEFAULT_LIMITS, globalDailyMax: positiveInt(env.JUDITH_DAILY_LIMIT, DEFAULT_LIMITS.globalDailyMax) },
  };
}
