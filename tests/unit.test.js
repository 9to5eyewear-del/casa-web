import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhone } from '../api/_lib/phone.js';
import { validateLead } from '../api/_lib/validate.js';
import { scoreLead } from '../api/_lib/score.js';
import { isSameOrigin } from '../api/_lib/http.js';
import { sqlRpc } from '../api/_lib/db.js';

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

test('score: null without a timing signal or a known service', () => {
  assert.equal(scoreLead({ lead_type: 'bridal', email: 'a@b.co', budget: 9000 }, NOW), null); // no date / urgency
  assert.equal(scoreLead({ event_date: '2026-10-20' }, NOW), null);                           // no service
  assert.equal(scoreLead({ lead_type: 'other', urgency: 'this_week' }, NOW), null);            // service unclear
  assert.equal(scoreLead({}, NOW), null);
});

test('score: budget is optional; a close date + clear intent is hot without it', () => {
  // date in 10 days 45 + bridal 20 = 65
  assert.equal(scoreLead({ lead_type: 'bridal', event_date: '2026-10-16' }, NOW), 'hot');
  // this week 45 + production 15 = 60
  assert.equal(scoreLead({ lead_type: 'production', urgency: 'this_week' }, NOW), 'hot');
  // date in 60 days 20 + bridal 20 = 40
  assert.equal(scoreLead({ lead_type: 'bridal', event_date: '2026-12-05' }, NOW), 'warm');
  // flexible 5 + product 10 = 15
  assert.equal(scoreLead({ lead_type: 'product', urgency: 'flexible' }, NOW), 'cold');
});

test('score: budget and completeness add on top', () => {
  // 60 days 20 + bridal 20 = 40 → + budget 5000 (15) + email (5) = 60
  const base = { lead_type: 'bridal', event_date: '2026-12-05' };
  assert.equal(scoreLead({ ...base, budget: 5000, email: 'a@b.co' }, NOW), 'hot');
  // flexible 5 + fashion 10 + email 5 + long message 5 + subtype 5 + budget 2000 (10) = 40
  assert.equal(scoreLead({ lead_type: 'fashion', urgency: 'flexible', email: 'a@b.co',
    message: 'אנחנו מחפשים לוקיישן לצילום קולקציה', lead_subtype: 'קמפיין', budget: 2000 }, NOW), 'warm');
  assert.equal(scoreLead({ lead_type: 'product', urgency: 'flexible', budget: 500 }, NOW), 'cold');
});

test('same-origin check', () => {
  const r = (origin, host = 'www.casamancini.site') => ({ headers: { host, ...(origin && { origin }) } });
  assert.equal(isSameOrigin(r('https://www.casamancini.site')), true);
  assert.equal(isSameOrigin(r(null)), true);
  assert.equal(isSameOrigin(r('https://evil.example')), false);
  assert.equal(isSameOrigin(r('garbage')), false);
});

test('sql rpc: named arguments, JSON-encoded objects, safe function names', async () => {
  const seen = [];
  const rpc = sqlRpc(async (text, params) => { seen.push({ text, params }); return [{ r: { ok: 1 } }]; });
  assert.deepEqual(await rpc('ingest_lead', { p_lead: { a: 1 }, p_ip_hash: null, p_rate_max: 5 }), { ok: 1 });
  assert.equal(seen[0].text, 'select public.ingest_lead(p_lead => $1, p_ip_hash => $2, p_rate_max => $3) as r');
  assert.deepEqual(seen[0].params, ['{"a":1}', null, 5]);
  await assert.rejects(rpc('x; drop table leads', {}), /bad function name/);
});

test('every /api path the PWA and the forms call exists as a route', async () => {
  const { readFileSync, existsSync } = await import('node:fs');
  const files = ['leadlive/app.js', 'leadlive/sw.js', 'js/lead-submit.js'];
  const paths = new Set();
  for (const f of files) {
    for (const m of readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').matchAll(/\/api\/[a-z_/]+/g)) paths.add(m[0].replace(/\/$/, ''));
  }
  assert.ok(paths.has('/api/leads'));
  for (const p of paths) {
    const base = new URL(`..${p}`, import.meta.url);
    const ok = existsSync(new URL(`${base.href}.js`)) || existsSync(new URL(`${base.href}/index.js`))
      || existsSync(new URL(`${base.href}/[id].js`));
    assert.ok(ok, `${p} has no route under api/`);
  }
});
