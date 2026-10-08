// Turns an untrusted public submission into a clean lead.
//
// Only name, phone and source are required. An invalid optional field is
// dropped (and listed in metadata.dropped_fields) rather than rejecting the
// whole inquiry: losing a lead over a malformed date is worse than losing the date.

import { SOURCES, LEAD_TYPES, URGENCIES, PAYMENT_METHODS } from './catalog.js';
import { normalizePhone } from './phone.js';
import { checkLocation, needsCheck } from '../../js/service-areas.js';

// C0/C1 control chars, zero-width chars and bidi overrides (but not \n / \t).
const INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩﻿]/g;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JUDITH_TOKEN = /^[A-Za-z0-9_-]{20,64}$/;
const METADATA_KEYS = ['page', 'referrer', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];
const LANGS = new Set(['he', 'en']);

export function cleanText(value, max, { multiline = false } = {}) {
  if (value == null || typeof value === 'object') return null;
  let s = String(value).normalize('NFC').replace(INVISIBLE, '');
  s = multiline
    ? s.replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n')
    : s.replace(/\s+/g, ' ');
  s = s.trim().slice(0, max).trim();
  return s || null;
}

function cleanInt(value, min, max) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : undefined;
}

function cleanDate(value, now) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const t = Date.parse(value + 'T00:00:00Z');
  if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== value) return undefined;
  const days = (t - now.getTime()) / 86400000;
  return days >= -2 && days <= 365 * 5 ? value : undefined;
}

/**
 * @returns {{ ok: true, lead, submissionId, spam, judithHandoff }} or {{ ok: false, errors }}
 */
export function validateLead(body, { now = new Date(), userAgent = null, sources = SOURCES } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, errors: { body: 'expected a JSON object' } };
  }

  const errors = {};
  const dropped = [];
  const optional = (field, value) => {
    if (value === undefined) { dropped.push(field); return null; }
    return value;
  };

  const source = typeof body.source === 'string' && sources.has(body.source) ? body.source : null;
  if (!source) errors.source = 'unknown source';

  const name = cleanText(body.name, 120);
  if (!name || name.length < 2) errors.name = 'required';

  const phone = cleanText(body.phone, 40);
  const phoneDigits = phone ? phone.replace(/\D/g, '') : '';
  if (phoneDigits.length < 7) errors.phone = 'required';

  if (Object.keys(errors).length) return { ok: false, errors };

  const emailRaw = cleanText(body.email, 254);
  const email = emailRaw ? (EMAIL.test(emailRaw) ? emailRaw.toLowerCase() : optional('email', undefined)) : null;

  const leadType = body.lead_type == null || body.lead_type === ''
    ? null
    : optional('lead_type', LEAD_TYPES.has(body.lead_type) ? body.lead_type : undefined);
  // With a date, the category comes from the date (priority.js → timingFor).
  const eventDate = optional('event_date', cleanDate(body.event_date, now));
  const urgency = eventDate || body.urgency == null || body.urgency === ''
    ? null
    : optional('urgency', URGENCIES.has(body.urgency) ? body.urgency : undefined);

  // מיקום ההתארגנות: bridal prep only. The drive time from Ein Vered and the
  // service zone are worked out here, from the same data the form uses
  // (js/service-areas.js), not taken from the client. out_of_area = beyond the
  // recommended zone: check availability and pricing.
  let prepLocation = null, driveMinutes = null, serviceZone = null, outOfArea = false;
  if (leadType === 'bridal') {
    prepLocation = cleanText(body.prep_location, 120);
    if (prepLocation) {
      const where = checkLocation(prepLocation);
      driveMinutes = where.minutes;
      serviceZone = where.zone;
      outOfArea = needsCheck(where.zone);
    }
  }

  const phoneNormalized = normalizePhone(phone);

  const metadata = {};
  if (body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)) {
    for (const key of METADATA_KEYS) {
      const v = cleanText(body.metadata[key], key === 'referrer' ? 500 : 200);
      if (v) metadata[key] = v;
    }
  }
  if (body.metadata && LANGS.has(body.metadata.lang)) metadata.lang = body.metadata.lang;
  const ua = cleanText(userAgent, 300);
  if (ua) metadata.user_agent = ua;
  if (!phoneNormalized) metadata.phone_unrecognized = true;

  const lead = {
    source,
    name,
    phone,
    phone_normalized: phoneNormalized,
    email,
    lead_type: leadType,
    lead_subtype: cleanText(body.lead_subtype, 80),
    event_date: eventDate,
    urgency,
    companions: optional('companions', cleanInt(body.companions, 0, 20)),
    production_type: cleanText(body.production_type, 120),
    budget: optional('budget', cleanInt(body.budget, 0, 1_000_000)),
    prep_location: prepLocation,
    drive_minutes: driveMinutes,
    service_zone: serviceZone,
    out_of_area: outOfArea,
    message: cleanText(body.message, 4000, { multiline: true }),
    metadata,
  };
  if (dropped.length) metadata.dropped_fields = dropped;

  // The Judith handoff token (not stored on the lead): links it to the chat.
  const judithHandoff = source === 'judith_ai' && typeof body.judith_handoff === 'string' && JUDITH_TOKEN.test(body.judith_handoff)
    ? body.judith_handoff
    : null;

  const submissionId = typeof body.submission_id === 'string' && UUID.test(body.submission_id)
    ? body.submission_id.toLowerCase()
    : null;

  // Honeypot: the hidden "botcheck" checkbox only bots fill in.
  const spam = Boolean(body.botcheck) && body.botcheck !== 'false';

  return { ok: true, lead, submissionId, spam, judithHandoff };
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * What a closed lead booked (LeadLive → פרטי הסגירה). Staff typed it, so a bad
 * field is an error to fix, not something to drop. Empty fields are left out.
 * @returns {{ ok: true, deal }} or {{ ok: false, errors }}
 */
export function validateDeal(body, { now = new Date() } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, errors: { deal: 'expected a JSON object' } };
  }
  const errors = {};
  const deal = {};
  const empty = (v) => v == null || v === '';
  const set = (key, value, valid) => {
    if (empty(body[key])) return;
    if (valid) deal[key] = value; else errors[key] = 'invalid';
  };

  const text = (key, max, opts) => { const v = cleanText(body[key], max, opts); if (v) deal[key] = v; };
  text('package', 300);
  text('notes', 4000, { multiline: true });

  set('lead_type', body.lead_type, LEAD_TYPES.has(body.lead_type));
  set('payment_method', body.payment_method, PAYMENT_METHODS.has(body.payment_method));
  set('start_time', body.start_time, TIME.test(String(body.start_time)));
  set('end_time', body.end_time, TIME.test(String(body.end_time)));

  if (!empty(body.event_date)) {
    const v = String(body.event_date);
    const t = /^\d{4}-\d{2}-\d{2}$/.test(v) ? Date.parse(v + 'T00:00:00Z') : NaN;
    const days = (t - now.getTime()) / 86400000;
    set('event_date', v, !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === v && days >= -365 * 2 && days <= 365 * 5);
  }
  for (const [key, max] of [['guests', 50], ['price', 1_000_000], ['deposit', 1_000_000]]) {
    const n = cleanInt(body[key], 0, max);
    set(key, n, n != null);
  }
  if (deal.price != null && deal.deposit != null && deal.deposit > deal.price) errors.deposit = 'more than price';

  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, deal };
}
