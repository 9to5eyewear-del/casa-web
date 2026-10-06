-- Casa Mancini leads: the single source of truth for every inquiry.
--
-- Access model: RLS is on and no policies exist, so the anon/authenticated
-- roles can't read or write anything. Only the server (service_role, via the
-- functions under /api) touches these tables, through the RPC functions below.

-- ─────────────────────────────────────────────
--  Tables
-- ─────────────────────────────────────────────

create table public.leads (
  id                    uuid primary key default gen_random_uuid(),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  -- Open text (not an enum) so new sources/types need no migration.
  source                text not null check (source ~ '^[a-z][a-z0-9_]{1,39}$'),
  status                text not null default 'new'
                          check (status in ('new', 'in_progress', 'won', 'lost')),

  name                  text not null check (char_length(name) between 1 and 120),
  phone                 text not null,                -- as the customer typed it
  phone_normalized      text check (phone_normalized ~ '^[1-9][0-9]{7,14}$'), -- 972546787179; null if unrecognized
  email                 text check (email = lower(email)),

  lead_type             text check (lead_type ~ '^[a-z][a-z0-9_]{1,39}$'),
  lead_subtype          text,
  event_date            date,
  urgency               text check (urgency in ('this_week', 'this_month', 'three_months', 'flexible')),
  companions            smallint check (companions between 0 and 50),
  production_type       text,
  budget                integer check (budget >= 0),
  message               text,
  lead_score            text check (lead_score in ('hot', 'warm', 'cold')),  -- null = not enough info

  submission_count      integer not null default 1 check (submission_count >= 1),
  last_submission_at    timestamptz not null default now(),
  possible_duplicate_of uuid references public.leads (id) on delete set null,

  status_changed_at     timestamptz,
  closed_at             timestamptz,                  -- set only while status = 'won'
  metadata              jsonb not null default '{}'::jsonb,

  constraint leads_closed_at_only_when_won check (closed_at is null or status = 'won')
);

create index leads_feed_idx        on public.leads (last_submission_at desc, id desc);
create index leads_status_feed_idx on public.leads (status, last_submission_at desc, id desc);
create index leads_phone_idx       on public.leads (phone_normalized);
create index leads_email_idx       on public.leads (email) where email is not null;
create index leads_source_idx      on public.leads (source);

create table public.lead_events (
  id            bigint generated always as identity primary key,
  lead_id       uuid not null references public.leads (id) on delete cascade,
  -- lead_created | repeat_submission | status_changed (open text for future events)
  type          text not null check (type ~ '^[a-z][a-z0-9_]{1,39}$'),
  created_at    timestamptz not null default now(),   -- for status_changed: changed_at
  actor_id      uuid references auth.users (id) on delete set null,  -- changed_by
  actor_email   text,
  from_status   text,
  to_status     text,
  submission_id uuid,                                 -- client-generated, makes retries idempotent
  ip_hash       text,                                 -- HMAC of the client IP, for rate limiting
  data          jsonb not null default '{}'::jsonb    -- the full submission, for created/repeat events
);

create index lead_events_lead_idx on public.lead_events (lead_id, created_at);
create unique index lead_events_submission_idx on public.lead_events (submission_id) where submission_id is not null;
create index lead_events_ip_idx on public.lead_events (ip_hash, created_at) where ip_hash is not null;

create table public.push_subscriptions (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users (id) on delete cascade,
  endpoint        text not null unique,
  p256dh          text not null,
  auth            text not null,
  user_agent      text,
  created_at      timestamptz not null default now(),
  last_success_at timestamptz
);

create index push_subscriptions_user_idx on public.push_subscriptions (user_id);

create function public.set_updated_at() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger leads_set_updated_at before update on public.leads
  for each row execute function public.set_updated_at();

-- ─────────────────────────────────────────────
--  Access: server only
-- ─────────────────────────────────────────────

alter table public.leads              enable row level security;
alter table public.lead_events        enable row level security;
alter table public.push_subscriptions enable row level security;

revoke all on public.leads, public.lead_events, public.push_subscriptions from anon, authenticated;
grant all on public.leads, public.lead_events, public.push_subscriptions to service_role;

-- ─────────────────────────────────────────────
--  ingest_lead: create a lead, or attach a repeat inquiry to an open one.
--
--  p_lead is the already-validated submission (see api/_lib/validate.js).
--  Returns {result: created | repeat | duplicate_submission | rate_limited, ...}.
-- ─────────────────────────────────────────────

create function public.ingest_lead(
  p_lead               jsonb,
  p_submission_id      uuid    default null,
  p_ip_hash            text    default null,
  p_rate_max           integer default 5,
  p_rate_window_seconds integer default 600
) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  v_phone    text := nullif(p_lead ->> 'phone_normalized', '');
  v_email    text := nullif(p_lead ->> 'email', '');
  v_open_id  uuid;
  v_dup_id   uuid;
  v_id       uuid;
  v_count    integer;
begin
  -- Serialize concurrent submissions for the same phone, so two quick
  -- submits can't both create a lead.
  perform pg_advisory_xact_lock(hashtextextended(
    'lead:' || coalesce(v_phone, p_submission_id::text, gen_random_uuid()::text), 0));

  -- A retry of a submission we already stored.
  if p_submission_id is not null then
    select lead_id into v_id from lead_events where submission_id = p_submission_id;
    if found then
      return jsonb_build_object('result', 'duplicate_submission', 'lead_id', v_id);
    end if;
  end if;

  if p_ip_hash is not null and p_rate_max > 0 then
    select count(*) into v_count from lead_events
     where ip_hash = p_ip_hash
       and type in ('lead_created', 'repeat_submission')
       and created_at > now() - make_interval(secs => p_rate_window_seconds);
    if v_count >= p_rate_max then
      return jsonb_build_object('result', 'rate_limited');
    end if;
  end if;

  -- Same phone + still open → the same inquiry coming back. Only fill fields
  -- that are empty; never overwrite what the team already has.
  if v_phone is not null then
    select id into v_open_id from leads
     where phone_normalized = v_phone and status in ('new', 'in_progress')
     order by created_at desc
     limit 1
     for update;
  end if;

  if v_open_id is not null then
    update leads set
      submission_count   = submission_count + 1,
      last_submission_at = now(),
      email              = coalesce(email,           v_email),
      lead_type          = coalesce(lead_type,       p_lead ->> 'lead_type'),
      lead_subtype       = coalesce(lead_subtype,    p_lead ->> 'lead_subtype'),
      event_date         = coalesce(event_date,      (p_lead ->> 'event_date')::date),
      urgency            = coalesce(urgency,         p_lead ->> 'urgency'),
      companions         = coalesce(companions,      (p_lead ->> 'companions')::smallint),
      production_type    = coalesce(production_type, p_lead ->> 'production_type'),
      budget             = coalesce(budget,          (p_lead ->> 'budget')::integer),
      message            = coalesce(message,         p_lead ->> 'message'),
      lead_score         = coalesce(lead_score,      p_lead ->> 'lead_score')
    where id = v_open_id
    returning submission_count into v_count;

    insert into lead_events (lead_id, type, submission_id, ip_hash, data)
    values (v_open_id, 'repeat_submission', p_submission_id, p_ip_hash, p_lead);

    return jsonb_build_object('result', 'repeat', 'lead_id', v_open_id, 'submission_count', v_count);
  end if;

  -- Not merged, but flagged: a closed lead with this phone (returning
  -- customer), or any lead with this email.
  select id into v_dup_id from leads
   where (v_phone is not null and phone_normalized = v_phone)
      or (v_email is not null and email = v_email)
   order by (v_phone is not null and phone_normalized = v_phone) desc, created_at desc
   limit 1;

  insert into leads (
    source, name, phone, phone_normalized, email,
    lead_type, lead_subtype, event_date, urgency, companions,
    production_type, budget, message, lead_score,
    possible_duplicate_of, metadata
  ) values (
    p_lead ->> 'source', p_lead ->> 'name', p_lead ->> 'phone', v_phone, v_email,
    p_lead ->> 'lead_type', p_lead ->> 'lead_subtype', (p_lead ->> 'event_date')::date,
    p_lead ->> 'urgency', (p_lead ->> 'companions')::smallint,
    p_lead ->> 'production_type', (p_lead ->> 'budget')::integer,
    p_lead ->> 'message', p_lead ->> 'lead_score',
    v_dup_id, coalesce(p_lead -> 'metadata', '{}'::jsonb)
  )
  returning id into v_id;

  insert into lead_events (lead_id, type, submission_id, ip_hash, data)
  values (v_id, 'lead_created', p_submission_id, p_ip_hash, p_lead);

  return jsonb_build_object('result', 'created', 'lead_id', v_id, 'submission_count', 1,
                            'possible_duplicate_of', v_dup_id);
end $$;

-- ─────────────────────────────────────────────
--  set_lead_status: change status, keep closed_at consistent, log who did it.
--  Returns the updated lead, or null if it doesn't exist.
-- ─────────────────────────────────────────────

create function public.set_lead_status(
  p_lead_id     uuid,
  p_status      text,
  p_actor_id    uuid default null,
  p_actor_email text default null
) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  v_lead leads;
  v_from text;
begin
  if p_status is null or p_status not in ('new', 'in_progress', 'won', 'lost') then
    raise exception 'invalid status: %', p_status using errcode = '22023';
  end if;

  select * into v_lead from leads where id = p_lead_id for update;
  if not found then
    return null;
  end if;
  if v_lead.status = p_status then
    return to_jsonb(v_lead);
  end if;

  v_from := v_lead.status;
  update leads set
    status            = p_status,
    status_changed_at = now(),
    -- Leaving 'won' clears it, so time-to-close analytics stay honest.
    closed_at         = case when p_status = 'won' then now() end
  where id = p_lead_id
  returning * into v_lead;

  insert into lead_events (lead_id, type, actor_id, actor_email, from_status, to_status)
  values (p_lead_id, 'status_changed', p_actor_id, p_actor_email, v_from, p_status);

  return to_jsonb(v_lead);
end $$;

-- ─────────────────────────────────────────────
--  Read functions for the PWA (called by the server after auth).
-- ─────────────────────────────────────────────

-- Newest activity first (a repeat inquiry brings the lead back to the top).
-- Keyset pagination on (last_submission_at, id).
create function public.list_leads(
  p_status    text        default null,
  p_source    text        default null,
  p_query     text        default null,
  p_cursor_ts timestamptz default null,
  p_cursor_id uuid        default null,
  p_limit     integer     default 30
) returns jsonb
language plpgsql stable set search_path = public, pg_temp as $$
declare
  v_q      text := nullif(lower(btrim(p_query)), '');
  v_digits text := regexp_replace(coalesce(p_query, ''), '\D', '', 'g');
begin
  -- Phone search: match the national part, so "054678" finds 972546787179.
  v_digits := regexp_replace(v_digits, '^(972|0)', '');
  if char_length(v_digits) < 3 then
    v_digits := null;
  end if;

  return (
    select coalesce(jsonb_agg(to_jsonb(l) order by l.last_submission_at desc, l.id desc), '[]'::jsonb)
    from (
      select id, created_at, source, status, name, phone, email,
             lead_type, lead_subtype, event_date, urgency, production_type,
             lead_score, submission_count, last_submission_at, possible_duplicate_of
      from leads
      where (p_status is null or status = p_status)
        and (p_source is null or source = p_source)
        and (v_q is null
             or position(v_q in lower(name)) > 0
             or position(v_q in coalesce(email, '')) > 0
             or (v_digits is not null and position(v_digits in coalesce(phone_normalized, '')) > 0))
        and (p_cursor_ts is null or (last_submission_at, id) < (p_cursor_ts, p_cursor_id))
      order by last_submission_at desc, id desc
      limit least(greatest(coalesce(p_limit, 30), 1), 100)
    ) l
  );
end $$;

create function public.lead_status_counts() returns jsonb
language sql stable set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'new',         count(*) filter (where status = 'new'),
    'in_progress', count(*) filter (where status = 'in_progress'),
    'won',         count(*) filter (where status = 'won'),
    'lost',        count(*) filter (where status = 'lost'))
  from leads;
$$;

create function public.get_lead(p_lead_id uuid) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  select to_jsonb(l) || jsonb_build_object('events', coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', e.id, 'type', e.type, 'created_at', e.created_at,
             'actor_email', e.actor_email, 'from_status', e.from_status,
             'to_status', e.to_status, 'data', e.data)
           order by e.created_at, e.id)
    from lead_events e where e.lead_id = l.id), '[]'::jsonb))
  from leads l where l.id = p_lead_id;
$$;

revoke all on function public.ingest_lead(jsonb, uuid, text, integer, integer) from public, anon, authenticated;
revoke all on function public.set_lead_status(uuid, text, uuid, text)         from public, anon, authenticated;
revoke all on function public.list_leads(text, text, text, timestamptz, uuid, integer) from public, anon, authenticated;
revoke all on function public.lead_status_counts()                              from public, anon, authenticated;
revoke all on function public.get_lead(uuid)                                    from public, anon, authenticated;
revoke all on function public.set_updated_at()                                  from public, anon, authenticated;

grant execute on function public.ingest_lead(jsonb, uuid, text, integer, integer) to service_role;
grant execute on function public.set_lead_status(uuid, text, uuid, text)         to service_role;
grant execute on function public.list_leads(text, text, text, timestamptz, uuid, integer) to service_role;
grant execute on function public.lead_status_counts()                              to service_role;
grant execute on function public.get_lead(uuid)                                    to service_role;
