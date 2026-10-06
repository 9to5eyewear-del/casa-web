import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhone } from '../api/_lib/phone.js';
import { validateLead } from '../api/_lib/validate.js';
import { scoreLead } from '../api/_lib/score.js';
import { parseEmailList, createStaffAuth } from '../api/_lib/auth.js';
import { isSameOrigin } from '../api/_lib/http.js';
import { supabaseRpc } from '../api/_lib/db.js';

const NOW = new Date('2026-10-06T12:00:00Z');

test('phone: every spelling of an Israeli mobile normalizes the same', () => {
  for (const p of ['0546787179', '054-678-7179', '+972546787179', '972546787179',
                   '+972 54 678 7179', '00972546787179', '546787179', '+972 054 678 7179', '(054) 6787179']) {
    assert.equal(normalizePhone(p), '972546787179', p);
  }
});

test('phone: landlines, foreign and garbage', () => {
  assert.equal(normalizePhone('03-1234567'), '97231234567');
  assert.equal(normalizePhone('+1 212 555 1234'), '12125551234');
  assert.equal(normalizePhone('12345'), null);
  assert.equal(normalizePhone('0612345678'), null);       // not an Israeli prefix
  assert.equal(normalizePhone('97212345'), null);
  assert.equal(normalizePhone(null), null);
});

test('validate: required fields', () => {
  const r = validateLead({ source: 'website_form', name: 'א', phone: '12' }, { now: NOW });
  assert.equal(r.ok, false);
  assert.deepEqual(Object.keys(r.errors).sort(), ['name', 'phone']);
  assert.equal(validateLead({ source: 'instagram', name: 'דנה', phone: '0546787179' }).ok, false);
  assert.equal(validateLead(null).ok, false);
  assert.equal(validateLead([1]).ok, false);
});

test('validate: sanitizes and normalizes', () => {
  const r = validateLead({
    source: 'website_form',
    name: '  דנה‮   כהן\u0000 ',
    phone: ' 054-678-7179 ',
    email: ' Dana@Example.COM ',
    lead_type: 'bridal',
    event_date: '2026-12-01',
    companions: '3',
    message: 'שורה 1\r\n\r\n\r\n\r\nשורה 2   עם   רווחים',
    metadata: { page: '/', utm_source: 'google', evil: 'x', referrer: { nested: true } },
    submission_id: 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE',
    unknown_field: 'ignored',
  }, { now: NOW, userAgent: 'Mozilla/5.0' });
  assert.equal(r.ok, true);
  assert.equal(r.lead.name, 'דנה כהן');
  assert.equal(r.lead.phone, '054-678-7179');
  assert.equal(r.lead.phone_normalized, '972546787179');
  assert.equal(r.lead.email, 'dana@example.com');
  assert.equal(r.lead.companions, 3);
  assert.equal(r.lead.message, 'שורה 1\n\nשורה 2 עם רווחים');
  assert.deepEqual(r.lead.metadata, { page: '/', utm_source: 'google', user_agent: 'Mozilla/5.0' });
  assert.equal(r.submissionId, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
  assert.equal('unknown_field' in r.lead, false);
  assert.equal(r.spam, false);
});

test('validate: bad optional fields are dropped, not fatal', () => {
  const r = validateLead({
    source: 'lead_page', name: 'נועה', phone: '0521234567',
    email: 'not-an-email', event_date: '2020-01-01', companions: 99, budget: 'lots',
    lead_type: 'wedding_planner', urgency: 'yesterday',
  }, { now: NOW });
  assert.equal(r.ok, true);
  for (const f of ['email', 'event_date', 'companions', 'budget', 'lead_type', 'urgency']) assert.equal(r.lead[f], null, f);
  assert.deepEqual(r.lead.metadata.dropped_fields.sort(),
    ['budget', 'companions', 'email', 'event_date', 'lead_type', 'urgency']);
  assert.equal(validateLead({ source: 'lead_page', name: 'נועה', phone: '0521234567', event_date: '2026-02-30' }, { now: NOW }).lead.event_date, null);
});

test('validate: unrecognized phone is kept and flagged, not rejected', () => {
  const r = validateLead({ source: 'lead_page', name: 'Guest', phone: '12345678901' }, { now: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.lead.phone_normalized, null);
  assert.equal(r.lead.metadata.phone_unrecognized, true);
});

test('validate: honeypot', () => {
  const base = { source: 'website_form', name: 'Bot', phone: '0546787179' };
  assert.equal(validateLead({ ...base, botcheck: 'on' }).spam, true);
  assert.equal(validateLead({ ...base, botcheck: '' }).spam, false);
  assert.equal(validateLead({ ...base, botcheck: false }).spam, false);
});

test('score: null without timing + budget (simple site form)', () => {
  assert.equal(scoreLead({ lead_type: 'bridal', event_date: '2026-10-20' }, NOW), null);
  assert.equal(scoreLead({ lead_type: 'bridal', budget: 5000 }, NOW), null);
  assert.equal(scoreLead({}, NOW), null);
});

test('score: matches the weights lead.html used', () => {
  // this_week 40 + budget 5000 → 25 + bridal 20 = 85
  assert.equal(scoreLead({ urgency: 'this_week', budget: 5000, lead_type: 'bridal' }, NOW), 'hot');
  // date in 60 days 20 + budget 2000 → 15 = 35
  assert.equal(scoreLead({ event_date: '2026-12-05', budget: 2000, lead_type: 'fashion' }, NOW), 'warm');
  // flexible 10 + budget 500 → 5 = 15
  assert.equal(scoreLead({ urgency: 'flexible', budget: 500, lead_type: 'product' }, NOW), 'cold');
});

test('auth: email allowlist parsing', () => {
  assert.deepEqual([...parseEmailList(' A@x.com, b@y.com;c@z.com\n')], ['a@x.com', 'b@y.com', 'c@z.com']);
  assert.equal(parseEmailList('').size, 0);
});

test('auth: verifies the token with Supabase and enforces the allowlist', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, auth: opts.headers.Authorization });
    const token = opts.headers.Authorization.slice(7);
    if (token === 'staff') return new Response(JSON.stringify({ id: 'u1', email: 'Team@Casa.co' }));
    if (token === 'other') return new Response(JSON.stringify({ id: 'u2', email: 'x@y.co' }));
    return new Response('{}', { status: 401 });
  };
  const requireStaff = createStaffAuth({ url: 'https://p.supabase.co', anonKey: 'anon', allowedEmails: new Set(['team@casa.co']), fetchImpl });
  const req = (h) => ({ headers: h ? { authorization: h } : {} });
  assert.deepEqual(await requireStaff(req('Bearer staff')), { user: { id: 'u1', email: 'team@casa.co' } });
  assert.deepEqual(await requireStaff(req('Bearer other')), { status: 403, error: 'forbidden' });
  assert.deepEqual(await requireStaff(req('Bearer expired')), { status: 401, error: 'unauthorized' });
  assert.deepEqual(await requireStaff(req()), { status: 401, error: 'unauthorized' });
  assert.equal(calls[0].url, 'https://p.supabase.co/auth/v1/user');
});

test('same-origin check', () => {
  const r = (origin, host = 'www.casamancini.site') => ({ headers: { host, ...(origin && { origin }) } });
  assert.equal(isSameOrigin(r('https://www.casamancini.site')), true);
  assert.equal(isSameOrigin(r(null)), true);
  assert.equal(isSameOrigin(r('https://evil.example')), false);
  assert.equal(isSameOrigin(r('garbage')), false);
});

test('supabase rpc: headers for both key formats, errors surface', async () => {
  const seen = [];
  const fetchImpl = async (url, opts) => {
    seen.push({ url, headers: opts.headers, body: JSON.parse(opts.body) });
    return url.endsWith('/boom') ? new Response('{"message":"nope"}', { status: 500 }) : new Response('{"result":"created"}');
  };
  const legacy = supabaseRpc({ url: 'https://p.supabase.co', serviceKey: 'eyJhbGciOi.x.y', fetchImpl });
  assert.deepEqual(await legacy('ingest_lead', { p_lead: { a: 1 } }), { result: 'created' });
  assert.equal(seen[0].url, 'https://p.supabase.co/rest/v1/rpc/ingest_lead');
  assert.equal(seen[0].headers.Authorization, 'Bearer eyJhbGciOi.x.y');
  assert.deepEqual(seen[0].body, { p_lead: { a: 1 } });

  const modern = supabaseRpc({ url: 'https://p.supabase.co', serviceKey: 'sb_secret_abc', fetchImpl });
  await modern('get_lead', {});
  assert.equal(seen[1].headers.apikey, 'sb_secret_abc');
  assert.equal('Authorization' in seen[1].headers, false);
  await assert.rejects(modern('boom', {}), /rpc boom failed: 500/);
});
