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
  const files = ['leadlive/app.js', 'leadlive/sw.js', 'js/lead-submit.js', 'js/judith-loader.js', 'js/judith.js', 'lead.html'];
  const paths = new Set();
  for (const f of files) {
    for (const m of readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').matchAll(/\/api\/[a-z_/]+/g)) paths.add(m[0].replace(/\/$/, ''));
  }
  assert.ok(paths.has('/api/leads'));
  for (const p of paths) {
    const base = new URL(`..${p}`, import.meta.url);
    const ok = existsSync(new URL(`${base.href}.js`)) || existsSync(new URL(`${base.href}/index.js`))
      || existsSync(new URL(`${base.href}/[id].js`)) || existsSync(new URL('[action].js', base));
    assert.ok(ok, `${p} has no route under api/`);
  }
});

// Vercel Hobby deploys at most 12 functions; a 13th fails the whole deploy.
test('api/ stays within the 12-function limit', async () => {
  const { readdirSync } = await import('node:fs');
  const files = readdirSync(new URL('../api/', import.meta.url), { recursive: true })
    .filter((f) => f.endsWith('.js') && !f.split('/').some((part) => part.startsWith('_')));
  assert.ok(files.length <= 12, `${files.length} functions: ${files.join(', ')}`);
});


test('timing: the date files the lead, and it moves closer by itself', async () => {
  const { timingFor, withPriority } = await import('../api/_lib/priority.js');
  const now = new Date('2026-10-08T09:00:00+03:00');
  const at = (event_date, urgency = null) => timingFor({ event_date, urgency }, now);
  assert.equal(at('2026-10-08'), 'this_week');
  assert.equal(at('2026-10-15'), 'this_week');
  assert.equal(at('2026-10-16'), 'this_month');
  assert.equal(at('2026-11-08'), 'this_month');
  assert.equal(at('2026-11-09'), 'three_months');
  assert.equal(at('2027-01-08'), 'three_months');
  assert.equal(at('2027-01-09'), 'later');
  assert.equal(at('2026-10-07'), 'past');
  // No date: what an older lead chose is kept; the date always wins over it.
  assert.equal(at(null, 'flexible'), 'flexible');
  assert.equal(at(null), null);
  assert.equal(at('2027-05-01', 'this_week'), 'later');
  // The same lead, months later.
  assert.equal(timingFor({ event_date: '2027-05-01' }, new Date('2027-04-28T12:00:00+03:00')), 'this_week');
  assert.equal(withPriority({ status: 'won', event_date: '2026-10-10', created_at: now.toISOString() }, now).timing, 'this_week');
});

test('validate: with a date, a sent urgency is ignored (the date decides)', async () => {
  const { validateLead } = await import('../api/_lib/validate.js');
  const now = new Date('2026-10-08T09:00:00Z');
  const base = { source: 'website_form', name: 'דנה', phone: '0546787179' };
  assert.equal(validateLead({ ...base, event_date: '2027-03-01', urgency: 'this_week' }, { now }).lead.urgency, null);
  assert.equal(validateLead({ ...base, urgency: 'flexible' }, { now }).lead.urgency, 'flexible');
});

test('service areas: drive time from Ein Vered decides the zone; every locality is searchable', async () => {
  const { checkLocation, suggest, zoneFor, minutesText, prepLocationText, needsCheck } = await import('../js/service-areas.js');
  const at = (text) => { const r = checkLocation(text); return [r.place?.name ?? null, r.zone]; };
  // Casa Mancini's recommended area, cities and small places alike, is ≤ 75 minutes.
  for (const n of ['עין ורד', 'אבן יהודה', 'תל מונד', 'קדימה-צורן', 'נתניה', 'כפר יונה', 'פרדסיה', 'רעננה', 'כפר סבא', 'הוד השרון',
    'הרצליה', 'רמת השרון', 'חדרה', 'קיסריה', 'אור עקיבא', 'פרדס חנה-כרכור', 'תל אביב - יפו', 'רמת גן', 'גבעתיים', 'פתח תקווה',
    'קרית אונו', 'גבעת שמואל', 'יהוד-מונוסון', 'אור יהודה', 'חולון', 'בת ים', 'ראשון לציון', 'ראש העין', 'שוהם', 'נס ציונה',
    'רחובות', 'באר יעקב', 'יבנה', 'גדרה', 'מזכרת בתיה', 'רמלה', 'לוד', 'מודיעין-מכבים-רעות', 'גן יבנה', 'אשדוד',
    'כפר ויתקין', 'משמר השרון', 'בני דרור', 'צור משה']) {
    assert.equal(checkLocation(n).zone, 'recommended', n);
  }
  assert.deepEqual(at('אשקלון'), ['אשקלון', 'special']);
  assert.deepEqual(at('ירושלים'), ['ירושלים', 'special']);
  assert.deepEqual(at('באר שבע'), ['באר שבע', 'remote']);
  assert.deepEqual(at('אילת'), ['אילת', 'remote']);
  assert.deepEqual(at('קריית אונו'), ['קרית אונו', 'recommended']);   // קרית / קריית
  assert.deepEqual(at('ת״א'), ['תל אביב - יפו', 'recommended']);      // alias
  assert.deepEqual(at('הרצל 5, נתניה'), ['נתניה', 'recommended']);    // inside an address
  assert.deepEqual(at('בלה בלה'), [null, 'unknown']);
  assert.equal(checkLocation('עין ורד').minutes, 0);
  // The boundaries: ≤ 75 recommended, 76–105 special, above that remote.
  assert.deepEqual([75, 76, 105, 106, null].map(zoneFor), ['recommended', 'special', 'special', 'remote', 'unknown']);
  assert.ok(!needsCheck('recommended') && needsCheck('special') && needsCheck('remote') && needsCheck('unknown'));
  assert.deepEqual([3, 22, 88, 131].map(minutesText), ['כמה דקות', 'כ-20 דקות', 'כ-90 דקות', 'כ-2 שעות ו-10 דקות']);
  // Quick search: closer recommended places first at the same match; far ones are offered too.
  const nt = suggest('נת', 5);
  assert.deepEqual(nt[0], { name: 'נתניה', minutes: checkLocation('נתניה').minutes, zone: 'recommended' });
  assert.deepEqual(suggest('אשק').map((p) => [p.name, p.zone]), [['אשקלון', 'special']]);
  assert.equal(prepLocationText({ prep_location: 'אשקלון', drive_minutes: 88, service_zone: 'special' }),
    'אשקלון · כ-90 דקות מעין ורד · מחוץ לאזור המומלץ – נבדוק אפשרות מיוחדת');
  assert.equal(prepLocationText({ prep_location: null }), null);
});
