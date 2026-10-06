-- 002: single-owner login (no users), login rate limiting, push
-- subscription management, and the normalized phone in the lead list (for
-- the WhatsApp button).

-- ─────────────────────────────────────────────
--  Push subscriptions belong to the one owner: no user_id.
-- ─────────────────────────────────────────────

alter table public.push_subscriptions drop column user_id;

create function public.save_push_subscription(
  p_endpoint   text,
  p_p256dh     text,
  p_auth       text,
  p_user_agent text default null
) returns jsonb
language sql set search_path = public, pg_temp as $$
  insert into push_subscriptions (endpoint, p256dh, auth, user_agent)
  values (p_endpoint, p_p256dh, p_auth, p_user_agent)
  on conflict (endpoint) do update
    set p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent
  returning jsonb_build_object('id', id);
$$;

create function public.delete_push_subscription(p_endpoint text) returns jsonb
language sql set search_path = public, pg_temp as $$
  with d as (delete from push_subscriptions where endpoint = p_endpoint returning 1)
  select jsonb_build_object('deleted', count(*)) from d;
$$;

create function public.list_push_subscriptions() returns jsonb
language sql stable set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'endpoint', endpoint, 'p256dh', p256dh, 'auth', auth)), '[]'::jsonb)
  from push_subscriptions;
$$;

-- After a send: mark the ones that worked, drop the ones the push service
-- says no longer exist (404 / 410).
create function public.record_push_results(p_ok uuid[], p_gone uuid[]) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  v_gone integer;
begin
  update push_subscriptions set last_success_at = now() where id = any (coalesce(p_ok, '{}'));
  delete from push_subscriptions where id = any (coalesce(p_gone, '{}'));
  get diagnostics v_gone = row_count;
  return jsonb_build_object('removed', v_gone);
end $$;

-- ─────────────────────────────────────────────
--  Login rate limiting (one password → brute force is the main threat).
-- ─────────────────────────────────────────────

create table public.login_attempts (
  id         bigint generated always as identity primary key,
  ip_hash    text not null,
  success    boolean not null,
  created_at timestamptz not null default now()
);

create index login_attempts_ip_idx   on public.login_attempts (ip_hash, created_at) where not success;
create index login_attempts_time_idx on public.login_attempts (created_at) where not success;

-- Allowed unless this IP, or everyone together, failed too often within
-- the window. Returns {allowed, retry_after_seconds}.
create function public.login_gate(
  p_ip_hash        text,
  p_ip_max         integer,
  p_global_max     integer,
  p_window_seconds integer
) returns jsonb
language plpgsql stable set search_path = public, pg_temp as $$
declare
  v_window   interval := make_interval(secs => p_window_seconds);
  v_unlock   timestamptz;
begin
  -- The window frees up when the oldest of the last N failures ages out.
  select created_at + v_window into v_unlock from login_attempts
   where ip_hash = p_ip_hash and not success and created_at > now() - v_window
   order by created_at desc offset p_ip_max - 1 limit 1;

  if v_unlock is null then
    select created_at + v_window into v_unlock from login_attempts
     where not success and created_at > now() - v_window
     order by created_at desc offset p_global_max - 1 limit 1;
  end if;

  if v_unlock is null then
    return jsonb_build_object('allowed', true);
  end if;
  return jsonb_build_object('allowed', false,
    'retry_after_seconds', greatest(1, ceil(extract(epoch from v_unlock - now()))::integer));
end $$;

-- A successful login clears that IP's failures, so a few typos never
-- linger. Old rows are pruned as we go.
create function public.record_login_attempt(p_ip_hash text, p_success boolean) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
begin
  if p_success then
    delete from login_attempts where ip_hash = p_ip_hash and not success;
  end if;
  insert into login_attempts (ip_hash, success) values (p_ip_hash, p_success);
  delete from login_attempts where created_at < now() - interval '2 days';
  return jsonb_build_object('ok', true);
end $$;

-- ─────────────────────────────────────────────
--  Lead list: add phone_normalized (WhatsApp links). Same signature.
-- ─────────────────────────────────────────────

create or replace function public.list_leads(
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
  v_digits := regexp_replace(v_digits, '^(972|0)', '');
  if char_length(v_digits) < 3 then
    v_digits := null;
  end if;

  return (
    select coalesce(jsonb_agg(to_jsonb(l) order by l.last_submission_at desc, l.id desc), '[]'::jsonb)
    from (
      select id, created_at, source, status, name, phone, phone_normalized, email,
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
