// One Judith turn: build the request, call Claude, and turn its structured
// output into something the server can trust.
//
// Claude answers in JSON (structured outputs), so the business logic reads
// state / qualified / handoff_ready from fields, never from the prose. Every
// field is re-validated here anyway: a wrong value from the model must never
// reach a lead.

import { SYSTEM_PROMPT } from './prompt.js';
import { LEAD_TYPES, URGENCIES } from '../catalog.js';
import { cleanText } from '../validate.js';

// Sonnet 5.5: natural Hebrew and sound sales judgment at a fraction of Opus
// cost; with thinking off and low effort it answers in a couple of seconds.
export const DEFAULT_MODEL = 'claude-sonnet-5-5';
export const MAX_OUTPUT_TOKENS = 900;
// Only the most recent messages go to Claude; the structured state carries
// everything said earlier, so older turns aren't needed to stay consistent.
export const HISTORY_WINDOW = 16;

const INTENTS = ['bridal_prep', 'production', 'venue_info', 'pricing', 'availability', 'contact', 'other'];
export const STATE_FIELDS = ['intent', 'lead_type', 'lead_subtype', 'customer_name', 'event_date', 'event_date_text',
  'urgency', 'companions', 'production_type', 'budget', 'special_request'];

const nullable = (schema) => ({ anyOf: [schema, { type: 'null' }] });
const str = nullable({ type: 'string' });
const int = nullable({ type: 'integer' });

export const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    message: { type: 'string' },
    state: {
      type: 'object',
      properties: {
        intent: nullable({ type: 'string', enum: INTENTS }),
        lead_type: nullable({ type: 'string', enum: [...LEAD_TYPES] }),
        lead_subtype: str,
        customer_name: str,
        event_date: str,
        event_date_text: str,
        urgency: nullable({ type: 'string', enum: [...URGENCIES] }),
        companions: int,
        production_type: str,
        budget: int,
        special_request: str,
      },
      required: STATE_FIELDS,
      additionalProperties: false,
    },
    qualified: { type: 'boolean' },
    handoff_ready: { type: 'boolean' },
    whatsapp: { type: 'boolean' },
    lead_summary: str,
  },
  required: ['message', 'state', 'qualified', 'handoff_ready', 'whatsapp', 'lead_summary'],
  additionalProperties: false,
};

/** Model-specific request options; between_tools / effort only exist on Sonnet 5.5. */
export function modelOptions(model) {
  if (model.startsWith('claude-sonnet-5-5')) {
    return { thinking: { type: 'between_tools' }, output_config: { effort: 'low' } };
  }
  return { output_config: {} };
}

const israelDate = (now) => new Date(now).toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
const WEEKDAY = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

// The visitor's text can't pose as the server context: our delimiters are
// stripped from it.
const fence = (text) => text.replace(/<\/?(visitor|server_context)>/gi, '');

/** The latest user turn as Claude sees it: server context + the visitor's words. */
export function contextualize(message, state, now = new Date()) {
  const day = israelDate(now);
  const weekday = WEEKDAY[new Date(day + 'T12:00:00Z').getUTCDay()];
  const known = Object.fromEntries(Object.entries(state || {}).filter(([, v]) => v != null));
  return `<server_context>\nהיום: ${day} (יום ${weekday})\nמה שכבר ידוע מהשיחה: ${JSON.stringify(known)}\n</server_context>\n<visitor>\n${fence(message)}\n</visitor>`;
}

/** Last HISTORY_WINDOW messages, starting with a user turn. */
export function recentHistory(messages) {
  let recent = messages.slice(-HISTORY_WINDOW);
  while (recent.length && recent[0].role !== 'user') recent = recent.slice(1);
  return recent;
}

export function buildRequest({ model, history, message, state, now }) {
  const opts = modelOptions(model);
  return {
    model,
    max_tokens: MAX_OUTPUT_TOKENS,
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [...recentHistory(history), { role: 'user', content: contextualize(message, state, now) }],
    ...opts,
    output_config: { ...opts.output_config, format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
  };
}

// ── Validation of the model's output ──

function cleanDate(value, now) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const t = Date.parse(value + 'T00:00:00Z');
  if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== value) return null;
  const days = (t - Date.parse(israelDate(now) + 'T00:00:00Z')) / 86400000;
  return days >= 0 && days <= 365 * 3 ? value : null;
}

function cleanInt(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max ? value : null;
}

/** Validates one state object from the model; anything invalid becomes null. */
export function sanitizeState(raw, now = new Date()) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    intent: INTENTS.includes(r.intent) ? r.intent : null,
    lead_type: LEAD_TYPES.has(r.lead_type) ? r.lead_type : null,
    lead_subtype: cleanText(r.lead_subtype, 80),
    customer_name: cleanText(r.customer_name, 60),
    event_date: cleanDate(r.event_date, now),
    event_date_text: cleanText(r.event_date_text, 60),
    urgency: URGENCIES.has(r.urgency) ? r.urgency : null,
    companions: cleanInt(r.companions, 0, 20),
    production_type: cleanText(r.production_type, 120),
    budget: cleanInt(r.budget, 0, 1_000_000),
    special_request: cleanText(r.special_request, 300),
  };
}

/** New values win; a null from the model never erases what is already known. */
export function mergeState(prev, next) {
  const out = {};
  for (const k of STATE_FIELDS) out[k] = next[k] ?? prev?.[k] ?? null;
  // An exact date says it all; a time frame is only for when there's none
  // (the model sometimes adds "flexible" the visitor never said).
  if (out.event_date) out.urgency = null;
  return out;
}

export class JudithUnavailable extends Error {
  constructor(reason, cause) {
    super(`judith unavailable: ${reason}`);
    this.reason = reason;
    this.cause = cause;
  }
}

/**
 * Parses Claude's response into { message, state, qualified, handoff_ready, whatsapp, lead_summary }.
 * Throws JudithUnavailable when there's nothing safe to show.
 */
export function parseResponse(response, now = new Date()) {
  if (response.stop_reason === 'refusal') throw new JudithUnavailable('refusal');
  if (response.stop_reason === 'max_tokens') throw new JudithUnavailable('max_tokens');
  const text = (response.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  let out;
  try { out = JSON.parse(text); } catch (err) { throw new JudithUnavailable('bad_json', err); }
  const message = cleanText(out?.message, 1500, { multiline: true });
  if (!message) throw new JudithUnavailable('empty_message');
  return {
    message,
    state: sanitizeState(out.state, now),
    qualified: out.qualified === true,
    handoff_ready: out.handoff_ready === true,
    whatsapp: out.whatsapp === true,
    lead_summary: cleanText(out.lead_summary, 400, { multiline: true }),
  };
}

/** Calls Claude once. `client` is an Anthropic SDK client (or a stand-in in tests). */
export async function runTurn({ client, model = DEFAULT_MODEL, history, message, state, now = new Date(), timeoutMs = 20000 }) {
  let response;
  try {
    response = await client.messages.create(buildRequest({ model, history, message, state, now }), { timeout: timeoutMs, maxRetries: 1 });
  } catch (err) {
    throw new JudithUnavailable('api_error', err);
  }
  return { ...parseResponse(response, now), usage: response.usage || null };
}
