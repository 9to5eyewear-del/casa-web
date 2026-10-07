-- 005: Judith AI — the digital sales assistant on the homepage.
--
-- Additive only: three new tables and functions; the only touch on existing
-- data is judith_attach_lead adding judith_summary to a lead's metadata.
--
--   judith_sessions  one chat. History + structured state live here only
--                    while useful: idle > 24h can't be continued, and rows
--                    are deleted after 7 days (judith_gate prunes them).
--   judith_events    the funnel, kept after the session is gone (no PII):
--                    chat_started → qualified → handoff_shown →
--                    handoff_clicked → lead_submitted. Each at most once per
--                    session, so counts are distinct conversations.
--   judith_requests  one row per chat message, for rate limits (2 days).

create table public.judith_sessions (
  id                 uuid primary key,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  ip_hash            text,
  turns              integer not null default 0,
  messages           jsonb not null default '[]'::jsonb,   -- [{role, content}] plain text
  state              jsonb not null default '{}'::jsonb,
  qualified          boolean not null default false,
  lead_summary       text,
  handoff_token      text unique check (handoff_token ~ '^[A-Za-z0-9_-]{20,64}$'),
  handoff_expires_at timestamptz
);

create index judith_sessions_updated_idx on public.judith_sessions (updated_at);

create table public.judith_events (
  id         bigint generated always as identity primary key,
  session_id uuid not null,               -- no FK: events outlive the session
  type       text not null check (type in ('chat_started', 'qualified', 'handoff_shown', 'handoff_clicked', 'lead_submitted')),
  created_at timestamptz not null default now(),
  lead_id    uuid
);

create unique index judith_events_once_idx on public.judith_events (session_id, type);
create index judith_events_type_time_idx on public.judith_events (type, created_at);

create table public.judith_requests (
  id         bigint generated always as identity primary key,
  ip_hash    text not null,
  created_at timestamptz not null default now()
);

create index judith_requests_ip_idx on public.judith_requests (ip_hash, created_at);
create index judith_requests_time_idx on public.judith_requests (created_at);

-- ─────────────────────────────────────────────
--  judith_gate: may this IP send one more message (to this session)?
--  Records the request when allowed. Returns {allowed, reason?, retry_after_seconds?}.
-- ─────────────────────────────────────────────
create function public.judith_gate(
  p_ip_hash           text,
  p_session_id        uuid,
  p_ip_max            integer,   -- per IP within p_ip_window_seconds
  p_ip_window_seconds integer,
  p_ip_daily_max      integer,   -- per IP per 24h
  p_global_daily_max  integer,   -- everyone together per 24h (the cost ceiling)
  p_session_max_turns integer
) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  v_count integer;
  v_turns integer;
  v_oldest timestamptz;
begin
  -- Housekeeping, cheap thanks to the indexes.
  delete from judith_requests where created_at < now() - interval '2 days';
  delete from judith_sessions where updated_at < now() - interval '7 days';

  if p_session_id is not null then
    select turns into v_turns from judith_sessions where id = p_session_id;
    if coalesce(v_turns, 0) >= p_session_max_turns then
      return jsonb_build_object('allowed', false, 'reason', 'session_limit');
    end if;
  end if;

  select count(*), min(created_at) into v_count, v_oldest from judith_requests
   where ip_hash = p_ip_hash and created_at > now() - make_interval(secs => p_ip_window_seconds);
  if v_count >= p_ip_max then
    return jsonb_build_object('allowed', false, 'reason', 'ip_burst',
      'retry_after_seconds', greatest(1, ceil(extract(epoch from v_oldest + make_interval(secs => p_ip_window_seconds) - now()))::integer));
  end if;

  select count(*) into v_count from judith_requests
   where ip_hash = p_ip_hash and created_at > now() - interval '24 hours';
  if v_count >= p_ip_daily_max then
    return jsonb_build_object('allowed', false, 'reason', 'ip_daily');
  end if;

  select count(*) into v_count from judith_requests where created_at > now() - interval '24 hours';
  if v_count >= p_global_daily_max then
    return jsonb_build_object('allowed', false, 'reason', 'global_daily');
  end if;

  insert into judith_requests (ip_hash) values (p_ip_hash);
  return jsonb_build_object('allowed', true);
end $$;

-- A session that can still be continued (active within 24h), or null.
create function public.judith_load(p_session_id uuid) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  select jsonb_build_object('id', id, 'turns', turns, 'messages', messages, 'state', state,
                            'qualified', qualified, 'lead_summary', lead_summary)
  from judith_sessions
  where id = p_session_id and updated_at > now() - interval '24 hours';
$$;

-- ─────────────────────────────────────────────
--  judith_save_turn: store one exchange and log the funnel steps it reached.
--  p_handoff_token is used only if the session has no live token yet.
--  Returns {handoff_token} (null until the conversation reached a handoff).
-- ─────────────────────────────────────────────
create function public.judith_save_turn(
  p_session_id          uuid,
  p_ip_hash             text,
  p_messages            jsonb,
  p_state               jsonb,
  p_qualified           boolean,
  p_handoff_ready       boolean,
  p_lead_summary        text,
  p_handoff_token       text,
  p_handoff_ttl_seconds integer default 7200
) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  v_row judith_sessions;
begin
  insert into judith_sessions (id, ip_hash) values (p_session_id, p_ip_hash)
  on conflict (id) do nothing;

  update judith_sessions set
    updated_at   = now(),
    turns        = turns + 1,
    messages     = p_messages,
    state        = p_state,
    qualified    = qualified or p_qualified,
    lead_summary = coalesce(p_lead_summary, lead_summary)
  where id = p_session_id
  returning * into v_row;

  insert into judith_events (session_id, type) values (p_session_id, 'chat_started')
  on conflict do nothing;
  if v_row.qualified then
    insert into judith_events (session_id, type) values (p_session_id, 'qualified') on conflict do nothing;
  end if;

  if p_handoff_ready then
    update judith_sessions set
      handoff_token      = case when handoff_token is not null and handoff_expires_at > now()
                                then handoff_token else p_handoff_token end,
      handoff_expires_at = now() + make_interval(secs => p_handoff_ttl_seconds)
    where id = p_session_id
    returning * into v_row;
    insert into judith_events (session_id, type) values (p_session_id, 'handoff_shown') on conflict do nothing;
  end if;

  return jsonb_build_object('handoff_token',
    case when v_row.handoff_expires_at > now() then v_row.handoff_token end);
end $$;

-- /lead opened from Judith: the state to prefill, or null if the token is
-- unknown or expired. Logs handoff_clicked once per session.
create function public.judith_handoff(p_token text) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  v_row judith_sessions;
begin
  select * into v_row from judith_sessions
   where handoff_token = p_token and handoff_expires_at > now();
  if not found then
    return null;
  end if;
  insert into judith_events (session_id, type) values (v_row.id, 'handoff_clicked') on conflict do nothing;
  return jsonb_build_object('state', v_row.state);
end $$;

-- After /api/leads saved a judith_ai lead: link it to the conversation (the
-- summary goes on the lead for LeadLive) and log lead_submitted. Filling in
-- the form can take a while, so a token is honoured for 24h past its expiry.
create function public.judith_attach_lead(p_token text, p_lead_id uuid) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  v_row judith_sessions;
begin
  select * into v_row from judith_sessions
   where handoff_token = p_token and handoff_expires_at > now() - interval '24 hours';
  if not found then
    return jsonb_build_object('attached', false);
  end if;

  if v_row.lead_summary is not null then
    update leads set metadata = metadata || jsonb_build_object('judith_summary', v_row.lead_summary)
     where id = p_lead_id;
  end if;
  insert into judith_events (session_id, type, lead_id) values (v_row.id, 'lead_submitted', p_lead_id)
  on conflict do nothing;
  return jsonb_build_object('attached', true, 'session_id', v_row.id);
end $$;

-- "שיחה חדשה": the visitor's own history and state are deleted now.
create function public.judith_reset(p_session_id uuid) returns jsonb
language sql set search_path = public, pg_temp as $$
  with d as (delete from judith_sessions where id = p_session_id returning 1)
  select jsonb_build_object('deleted', count(*)) from d;
$$;

-- ─────────────────────────────────────────────
--  The Judith funnel for a dashboard range (same windows as public.dashboard).
--  Conversation steps count sessions whose step happened in the period;
--  leads / won count judith_ai leads created in the period (current status).
-- ─────────────────────────────────────────────
create function public.judith_funnel(
  p_range text,
  p_from  date        default null,
  p_to    date        default null,
  p_now   timestamptz default null
) returns jsonb
language plpgsql stable set search_path = public, pg_temp as $$
declare
  b record;
begin
  select * into b from dashboard_bounds(p_range, p_from, p_to, coalesce(p_now, now()));
  return (
    select jsonb_build_object(
      'conversations',   count(*) filter (where type = 'chat_started'),
      'qualified',       count(*) filter (where type = 'qualified'),
      'handoff_shown',   count(*) filter (where type = 'handoff_shown'),
      'handoff_clicked', count(*) filter (where type = 'handoff_clicked'),
      'leads',           (select count(*) from leads where source = 'judith_ai'
                            and created_at >= b.cur_from and created_at < b.cur_to),
      'won',             (select count(*) from leads where source = 'judith_ai' and status = 'won'
                            and created_at >= b.cur_from and created_at < b.cur_to))
    from judith_events
    where created_at >= b.cur_from and created_at < b.cur_to
  );
end $$;
