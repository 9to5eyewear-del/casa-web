// End-to-end through the HTTP handlers and the real migration (in PGlite).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createLeadsHandler, createLeadHandler, createManualLeadHandler } from '../api/_lib/handlers.js';
import { createTestDb, mockReq, mockRes, silentLog, fakeRequireStaff, STAFF } from './helpers.js';

let t, log, leadsApi, leadApi, manualApi;

beforeEach(async () => {
  t = await createTestDb();
  log = silentLog();
  const deps = () => ({ db: t.db, ipHashKey: 'test-key', requireStaff: fakeRequireStaff });
  leadsApi = createLeadsHandler(deps, { log });
  leadApi = createLeadHandler(deps, { log });
  manualApi = createManualLeadHandler(deps, { log });
});

async function call(handler, reqOpts) {
  const res = mockRes();
  await handler(mockReq(reqOpts), res);
  return res;
}

const post = (body, headers) => call(leadsApi, { method: 'POST', body, headers });
const list = (query = {}, auth = 'Bearer good') => call(leadsApi, { method: 'GET', query, headers: { authorization: auth } });
const getOne = (id, auth = 'Bearer good') => call(leadApi, { method: 'GET', query: { id }, headers: { authorization: auth } });
const patch = (id, body, auth = 'Bearer good') => call(leadApi, { method: 'PATCH', query: { id }, body, headers: { authorization: auth } });
const addManual = (body, auth = 'Bearer good') => call(manualApi, { method: 'POST', body, headers: { authorization: auth } });

const websiteLead = (over = {}) => ({
  source: 'website_form', name: 'דנה כהן', phone: '054-678-7179', email: 'dana@example.com',
  lead_type: 'bridal', event_date: '2027-05-14', companions: 3, message: 'נשמח לפרטים', ...over,
});
const leadPageLead = (over = {}) => ({
  source: 'lead_page', name: 'נועה לוי', phone: '0521112233', email: 'noa@example.com',
  lead_type: 'production', lead_subtype: 'קמפיין', urgency: 'this_week', budget: 6000, ...over,
});

async function onlyLead() {
  const res = await list();
  assert.equal(res.statusCode, 200);
  return res.body.leads;
}

test('POST creates a lead with status new, and logs lead_created', async () => {
  const res = await post(websiteLead());
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.ok, true);
  assert.equal(res.headers['cache-control'], 'no-store');

  const [lead] = await onlyLead();
  assert.equal(lead.status, 'new');
  assert.equal(lead.source, 'website_form');
  assert.equal(lead.phone_normalized, '972546787179'); // for the WhatsApp button
  assert.equal(lead.lead_score, 'warm');                // date + service, no budget needed
  assert.equal(lead.submission_count, 1);

  const full = (await getOne(lead.id)).body.lead;
  assert.equal(full.phone_normalized, '972546787179');
  assert.equal(full.companions, 3);
  assert.equal(full.event_date, '2027-05-14');
  assert.deepEqual(full.events.map((e) => e.type), ['lead_created']);
});

test('no date or urgency → no score', async () => {
  await post(websiteLead({ event_date: null }));
  assert.equal((await onlyLead())[0].lead_score, null);
});

test('lead_page lead is scored on the server; client-sent score is ignored', async () => {
  await post(leadPageLead({ lead_score: 'cold' }));
  const [lead] = await onlyLead();
  assert.equal(lead.lead_score, 'hot');
});

test('repeat inquiry on an open lead: no new lead, count goes up, nothing overwritten', async () => {
  await post(websiteLead({ message: null, companions: null }));
  // Same number, different spelling and different details.
  await post(websiteLead({ phone: '+972546787179', name: 'Dana', email: 'other@example.com', message: 'שוב אני', companions: 5, event_date: '2027-06-01' }));
  await post(websiteLead({ phone: '972546787179' }));

  const leads = await onlyLead();
  assert.equal(leads.length, 1);
  const full = (await getOne(leads[0].id)).body.lead;
  assert.equal(full.submission_count, 3);
  assert.equal(full.name, 'דנה כהן');               // kept
  assert.equal(full.email, 'dana@example.com');      // kept
  assert.equal(full.event_date, '2027-05-14');       // kept
  assert.equal(full.message, 'שוב אני');             // was empty → filled
  assert.equal(full.companions, 5);                  // was empty → filled
  assert.deepEqual(full.events.map((e) => e.type), ['lead_created', 'repeat_submission', 'repeat_submission']);
  assert.equal(full.events[1].data.email, 'other@example.com'); // the repeat's own details are preserved
  assert.ok(log.entries.some((e) => e.event === 'lead_saved' && e.result === 'repeat' && e.submission_count === 3));
});

test('same phone after the lead closed → new lead flagged as possible duplicate', async () => {
  await post(websiteLead());
  const [first] = await onlyLead();
  await patch(first.id, { status: 'lost' });

  await post(websiteLead({ message: 'חוזרת אחרי שנה' }));
  const leads = await onlyLead();
  assert.equal(leads.length, 2);
  assert.equal(leads[0].possible_duplicate_of, first.id);
  assert.equal(leads[0].status, 'new');
});

test('email-only match never merges, only flags', async () => {
  await post(websiteLead());
  await post(websiteLead({ phone: '0529998877', name: 'מישהי אחרת' }));
  const leads = await onlyLead();
  assert.equal(leads.length, 2);
  assert.equal(leads[0].possible_duplicate_of, leads[1].id);
});

test('retried submission_id is idempotent', async () => {
  const sid = '5b0f2f0e-8a3c-4f6e-9a77-2c1d9e0b1a11';
  await post(websiteLead({ submission_id: sid }));
  await post(websiteLead({ submission_id: sid }));
  const [lead] = await onlyLead();
  assert.equal((await getOne(lead.id)).body.lead.submission_count, 1);
});

test('concurrent submits for the same phone create exactly one lead', async () => {
  await Promise.all([post(websiteLead()), post(websiteLead()), post(websiteLead())]);
  const leads = await onlyLead();
  assert.equal(leads.length, 1);
  assert.equal(leads[0].submission_count, 3);
});

test('rate limit: 5 per IP per 10 minutes, other IPs unaffected', async () => {
  for (let i = 0; i < 5; i++) {
    assert.equal((await post(websiteLead({ phone: `05200000${10 + i}` }))).statusCode, 201);
  }
  const blocked = await post(websiteLead({ phone: '0520000099' }));
  assert.equal(blocked.statusCode, 429);
  assert.ok(log.entries.some((e) => e.event === 'lead_rate_limited'));
  const other = await post(websiteLead({ phone: '0520000098' }), { 'x-forwarded-for': '198.51.100.1' });
  assert.equal(other.statusCode, 201);
  assert.equal((await onlyLead()).length, 6);
});

test('public POST rejects bad input, cross-site origins; honeypot is silently dropped', async () => {
  const bad = await post({ source: 'website_form', name: '', phone: 'x' });
  assert.equal(bad.statusCode, 400);
  assert.deepEqual(Object.keys(bad.body.fields).sort(), ['name', 'phone']);

  assert.equal((await post(websiteLead({ source: 'not_a_source' }))).statusCode, 400);
  assert.equal((await post(websiteLead(), { origin: 'https://evil.example' })).statusCode, 403);
  assert.equal((await post('{not json')).statusCode, 400);
  assert.equal((await post('x'.repeat(30_000))).statusCode, 413);

  const bot = await post(websiteLead({ botcheck: 'on' }));
  assert.equal(bot.statusCode, 201);
  assert.equal((await onlyLead()).length, 0);
});

test('stored text is sanitized; HTML is stored as plain text', async () => {
  await post(websiteLead({ name: '<img src=x onerror=alert(1)>\u0007', message: 'hi‮ there' }));
  const full = (await getOne((await onlyLead())[0].id)).body.lead;
  assert.equal(full.name, '<img src=x onerror=alert(1)>'); // escaped when rendered by the PWA
  assert.equal(full.message, 'hi there');
});

test('DB failure → 503 + lead_db_save_failed log with submission_id and no PII', async () => {
  const failing = createLeadsHandler(() => ({
    db: { ingestLead: async () => { throw new Error('connection refused'); } },
    ipHashKey: 'k',
  }), { log });
  const res = mockRes();
  await failing(mockReq({ method: 'POST', body: websiteLead() }), res);
  assert.equal(res.statusCode, 503);
  const entry = log.entries.find((e) => e.event === 'lead_db_save_failed');
  assert.ok(entry);
  assert.equal(entry.level, 'error');
  assert.equal(entry.submission_id, res.body.submission_id);
  assert.equal(entry.phone_tail, '7179');
  assert.equal(JSON.stringify(entry).includes('dana'), false);
  assert.equal(JSON.stringify(entry).includes('דנה'), false);
});

test('missing env is logged as a save failure, not a crash', async () => {
  const noEnv = createLeadsHandler(() => { throw new Error('missing env SUPABASE_URL'); }, { log });
  const res = mockRes();
  await noEnv(mockReq({ method: 'POST', body: websiteLead() }), res);
  assert.equal(res.statusCode, 503);
  assert.match(log.entries.find((e) => e.event === 'lead_db_save_failed').error, /missing env/);
});

test('private endpoints require a staff session', async () => {
  await post(websiteLead());
  assert.equal((await list({}, null)).statusCode, 401);
  assert.equal((await list({}, 'Bearer junk')).statusCode, 401);
  assert.equal((await list({}, 'Bearer outsider')).statusCode, 403);
  const id = (await onlyLead())[0].id;
  assert.equal((await getOne(id, null)).statusCode, 401);
  assert.equal((await patch(id, { status: 'won' }, 'Bearer outsider')).statusCode, 403);
  assert.equal((await getOne(id)).body.lead.status, 'new');
});

test('status flow: closed_at set on won, cleared when reopened; events record who changed what', async () => {
  await post(websiteLead());
  const id = (await onlyLead())[0].id;

  let r = await patch(id, { status: 'in_progress' });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.lead.closed_at, null);

  r = await patch(id, { status: 'won' });
  assert.ok(r.body.lead.closed_at);

  r = await patch(id, { status: 'won' }); // no-op: no extra event
  r = await patch(id, { status: 'in_progress' });
  assert.equal(r.body.lead.closed_at, null);

  const events = (await getOne(id)).body.lead.events.filter((e) => e.type === 'status_changed');
  assert.deepEqual(events.map((e) => [e.from_status, e.to_status]), [['new', 'in_progress'], ['in_progress', 'won'], ['won', 'in_progress']]);
  assert.ok(events.every((e) => e.actor_email === STAFF.email && e.created_at));
  const { rows } = await t.pg.query(`select distinct actor_id from lead_events where type = 'status_changed'`);
  assert.deepEqual(rows.map((x) => x.actor_id), [STAFF.id]);
});

test('PATCH accepts only {status}; unknown ids are 404', async () => {
  await post(websiteLead());
  const id = (await onlyLead())[0].id;
  assert.equal((await patch(id, { status: 'archived' })).statusCode, 400);
  assert.equal((await patch(id, { status: 'won', name: 'x' })).statusCode, 400);
  assert.equal((await patch(id, { name: 'x' })).statusCode, 400);
  assert.equal((await patch('7d3b1e70-0000-4000-8000-000000000000', { status: 'won' })).statusCode, 404);
  assert.equal((await getOne('not-a-uuid')).statusCode, 404);
});

test('deal: saved on the lead, moves its date and service, logged; bad fields are 400', async () => {
  await post(websiteLead());
  const id = (await onlyLead())[0].id;
  await patch(id, { status: 'won' });

  const deal = { package: 'התארגנות + צלם', lead_type: 'production', event_date: '2027-06-01', start_time: '09:30', end_time: '14:00',
    guests: '6', price: '4800', deposit: '1500', payment_method: 'transfer', notes: 'שורה 1\nשורה 2', junk: 'x' };
  const r = await patch(id, { deal });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.body.lead.deal, { package: 'התארגנות + צלם', notes: 'שורה 1\nשורה 2', lead_type: 'production', payment_method: 'transfer',
    start_time: '09:30', end_time: '14:00', event_date: '2027-06-01', guests: 6, price: 4800, deposit: 1500 });

  const lead = (await getOne(id)).body.lead;
  assert.equal(lead.event_date, '2027-06-01');
  assert.equal(lead.lead_type, 'production');
  assert.equal(lead.deal.price, 4800);
  const ev = lead.events.find((e) => e.type === 'deal_updated');
  assert.equal(ev.actor_email, STAFF.email);
  assert.equal(ev.data.package, 'התארגנות + צלם');

  // Empty fields are left out; the lead's date stays.
  assert.deepEqual((await patch(id, { deal: { price: '', package: ' ', notes: 'רק הערה' } })).body.lead.deal, { notes: 'רק הערה' });
  assert.equal((await getOne(id)).body.lead.event_date, '2027-06-01');

  const bad = await patch(id, { deal: { price: '100', deposit: '200', start_time: '25:00', guests: '-1', payment_method: 'gold', event_date: '2027-02-30' } });
  assert.equal(bad.statusCode, 400);
  assert.deepEqual(Object.keys(bad.body.fields).sort(), ['deposit', 'event_date', 'guests', 'payment_method', 'start_time']);
  assert.equal((await patch(id, { deal: 'x' })).statusCode, 400);
  assert.equal((await patch(id, { deal: {}, status: 'won' })).statusCode, 400);
  assert.equal((await patch('7d3b1e70-0000-4000-8000-000000000000', { deal: {} })).statusCode, 404);
  assert.equal((await patch(id, { deal: {} }, 'Bearer outsider')).statusCode, 403);
});

test('list: counters, filters, search by name / phone / email', async () => {
  await post(websiteLead());
  await post(leadPageLead());
  await post(websiteLead({ name: 'Maya Ben', phone: '0533334444', email: 'maya@mail.com', lead_type: 'production' }));
  const noa = (await list({ q: 'נועה' })).body.leads[0];
  await patch(noa.id, { status: 'won' });

  const all = await list();
  assert.deepEqual(all.body.counts, { new: 2, in_progress: 0, won: 1, lost: 0, unread: 3 });
  assert.equal((await list({ status: 'won' })).body.leads.length, 1);
  assert.equal((await list({ source: 'lead_page' })).body.leads.length, 1);
  assert.equal((await list({ status: 'nope' })).statusCode, 400);

  const names = async (q) => (await list({ q })).body.leads.map((l) => l.name).sort();
  assert.deepEqual(await names('maya'), ['Maya Ben']);
  assert.deepEqual(await names('054678'), ['דנה כהן']);         // local format
  assert.deepEqual(await names('+97253333'), ['Maya Ben']);     // international format
  assert.deepEqual(await names('NOA@'), ['נועה לוי']);           // email, case-insensitive
  assert.deepEqual(await names('%'), []);                       // no LIKE wildcards
});

test('list: newest activity first, keyset pagination', async () => {
  for (let i = 0; i < 5; i++) {
    await post(websiteLead({ name: `Lead ${i}`, phone: `05400000${10 + i}` }), { 'x-forwarded-for': `10.0.0.${i}` });
  }
  // Older timestamps; Leads 2, 3 and 4 tie on purpose.
  await t.pg.exec(`update leads set last_submission_at =
    '2026-01-01'::timestamptz + make_interval(mins => least(substring(name from 6)::int, 2))`);
  // A repeat inquiry brings Lead 0 back to the top.
  await post(websiteLead({ name: 'Lead 0', phone: '0540000010' }), { 'x-forwarded-for': '10.0.0.9' });

  const full = (await list()).body.leads.map((l) => l.name);
  assert.equal(full[0], 'Lead 0');
  assert.deepEqual(full.slice(1, 4).sort(), ['Lead 2', 'Lead 3', 'Lead 4']);
  assert.equal(full[4], 'Lead 1');

  // Pages walk the same order with nothing skipped or repeated, even when
  // timestamps tie (ordering falls back to id).
  const paged = [];
  let cursor;
  for (let page = 0; page < 5; page++) {
    const r = await list({ limit: '2', ...(cursor && { cursor }) });
    assert.equal(r.statusCode, 200);
    if (page > 0) assert.equal(r.body.counts, undefined);
    paged.push(...r.body.leads.map((l) => l.name));
    cursor = r.body.next_cursor;
    if (!cursor) break;
  }
  assert.deepEqual(paged, full);
  assert.equal((await list({ cursor: 'garbage' })).statusCode, 400);
});

test('database: constraints hold even if the API is bypassed', async () => {
  await assert.rejects(t.pg.query(`insert into leads (source, name, phone, status) values ('website_form','x','1','archived')`));
  await assert.rejects(t.pg.query(`insert into leads (source, name, phone, status, closed_at) values ('website_form','x','1','new', now())`));
  await assert.rejects(t.pg.query(`insert into leads (source, name, phone, lead_score) values ('website_form','x','1','lukewarm')`));
  await assert.rejects(t.pg.query(`insert into leads (source, name, phone) values ('Bad Source!','x','1')`));
  // A future source / type needs no migration.
  await t.pg.query(`insert into leads (source, name, phone, lead_type) values ('judith_ai','x','1','event_planning')`);
});

test('manual lead: staff only, manual sources only, already seen, no push', async () => {
  const body = { source: 'instagram', name: 'מיכל אברהם', phone: '050-123-4567', lead_type: 'bridal', urgency: 'this_month', message: 'פנתה בדיירקט' };
  assert.equal((await addManual(body, null)).statusCode, 401);
  assert.equal((await addManual(body, 'Bearer outsider')).statusCode, 403);
  assert.equal((await addManual({ ...body, source: 'website_form' })).statusCode, 400);   // public sources stay public
  assert.equal((await post({ ...body })).statusCode, 400);                                 // and manual ones stay staff-only
  assert.equal((await addManual({ ...body, status: 'archived' })).statusCode, 400);
  assert.deepEqual((await addManual({ ...body, name: '', phone: '12' })).body.fields, { name: 'required', phone: 'required' });

  const res = await addManual(body);
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.result, 'created');
  const lead = (await getOne(res.body.lead_id)).body.lead;
  assert.equal(lead.source, 'instagram');
  assert.equal(lead.status, 'new');
  assert.equal(lead.lead_score, 'warm');
  assert.ok(lead.seen_at);
  assert.equal(lead.metadata.entered_by, STAFF.email);
  assert.equal(log.entries.some((e) => e.event === 'push_notify_failed'), false);
});

test('manual lead: optional starting status; same phone merges into the open lead', async () => {
  const won = await addManual({ source: 'phone', name: 'רותם', phone: '0529998877', status: 'won' });
  const lead = (await getOne(won.body.lead_id)).body.lead;
  assert.equal(lead.status, 'won');
  assert.ok(lead.closed_at);
  assert.equal(lead.events.find((e) => e.type === 'status_changed').actor_email, STAFF.email);

  await post(websiteLead());
  const r = await addManual({ source: 'whatsapp', name: 'דנה כהן', phone: '+972 54-678-7179', budget: 3000 });
  assert.equal(r.body.result, 'repeat');
  assert.equal(r.body.submission_count, 2);
  const merged = (await getOne(r.body.lead_id)).body.lead;
  assert.equal(merged.source, 'website_form');
  assert.equal(merged.budget, 3000);

  // Retrying the same form (same submission_id) never adds twice.
  const sid = '4f1c2b9a-6d3e-4b7a-9c1d-2e3f4a5b6c7d';
  const a = await addManual({ source: 'referral', name: 'שירן', phone: '0531112222', submission_id: sid });
  const b = await addManual({ source: 'referral', name: 'שירן', phone: '0531112222', submission_id: sid });
  assert.equal(b.body.result, 'duplicate_submission');
  assert.equal(b.body.lead_id, a.body.lead_id);
});

test('bridal prep location: out of area is decided by the server, stored, flagged and filterable', async () => {
  // Ashkelon is outside every service region; the client's own flag is ignored.
  await post(websiteLead({ prep_region: 'south', prep_location: 'אשקלון', out_of_area: false }));
  // רחובות sent under the wrong region: in the area, and the region follows the locality.
  await post(websiteLead({ phone: '0521234567', email: 'b@example.com', prep_region: 'sharon', prep_location: 'רחובות' }));
  // Not bridal: no location is kept.
  await post(leadPageLead({ prep_region: 'south', prep_location: 'אשקלון' }));

  const byPhone = Object.fromEntries((await onlyLead()).map((l) => [l.phone_normalized, l]));
  const out = byPhone['972546787179'];
  assert.deepEqual([out.prep_region, out.prep_location, out.out_of_area], ['south', 'אשקלון', true]);
  const inArea = byPhone['972521234567'];
  assert.deepEqual([inArea.prep_region, inArea.prep_location, inArea.out_of_area], ['shfela', 'רחובות', false]);
  const shoot = byPhone['972521112233'];
  assert.deepEqual([shoot.prep_region, shoot.prep_location, shoot.out_of_area], [null, null, false]);

  const flagged = (await list({ flag: 'out_of_area' })).body.leads;
  assert.deepEqual(flagged.map((l) => l.id), [out.id]);
  assert.equal((await getOne(out.id)).body.lead.out_of_area, true);

  // A repeat inquiry doesn't overwrite a location already on the lead.
  await post(websiteLead({ prep_region: 'center', prep_location: 'תל אביב' }));
  const again = (await getOne(out.id)).body.lead;
  assert.deepEqual([again.prep_location, again.out_of_area, again.submission_count], ['אשקלון', true, 2]);
});
