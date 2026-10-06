-- 004: LeadLive dashboard — period aggregates, and lead list filters for
-- "repeat" and "open" leads. Read-only; no change to how leads are stored.
--
-- Metric definitions (one place; api/_lib/dashboard.js only divides these):
--   • A period is [from, to) in Israel time. Every period metric is a cohort of
--     the leads CREATED in it: leads, won, lost, open and handled all describe
--     those same rows, so won ≤ leads always holds.
--   • conversion = won / leads (the cohort's current status).
--   • handled = cohort leads no longer 'new' (someone acted on them).
--   • repeat_leads = distinct leads with a repeat_submission event in the period.
--   • first action = first status change out of 'new' − created_at.
--   • time to close = closed_at − created_at, for the cohort's won leads.
--   • open_now (new / in_progress) is the state right now, not a period metric.

create index leads_created_idx on public.leads (created_at);
create index lead_events_type_time_idx on public.lead_events (type, created_at);

-- The current and comparison windows for a range key.
--   7d / 30d       rolling days ending now (today counts as day 1); compared
--                  with the same span just before.
--   this_month     month start → now; compared with the same elapsed time of
--                  last month (so a half month never faces a full one).
--   previous_month that whole month; compared with the month before it.
--   custom         p_from..p_to inclusive (local dates); compared with the
--                  same length just before.
create function public.dashboard_bounds(
  p_range text,
  p_from  date        default null,
  p_to    date        default null,
  p_now   timestamptz default null
) returns table (cur_from timestamptz, cur_to timestamptz, prev_from timestamptz, prev_to timestamptz)
language plpgsql stable set search_path = public, pg_temp as $$
declare
  tz      constant text := 'Asia/Jerusalem';
  v_now   timestamptz := coalesce(p_now, now());
  v_today date := (v_now at time zone tz)::date;
  v_month date := date_trunc('month', v_today)::date;
  v_days  integer;
begin
  if p_range in ('7d', '30d') then
    v_days := case p_range when '7d' then 7 else 30 end;
    cur_from  := (v_today - (v_days - 1))::timestamp at time zone tz;
    cur_to    := v_now;
    prev_from := ((v_today - (v_days - 1)) - v_days)::timestamp at time zone tz;
    prev_to   := v_now - make_interval(days => v_days);
  elsif p_range = 'this_month' then
    cur_from  := v_month::timestamp at time zone tz;
    cur_to    := v_now;
    prev_from := (v_month - interval '1 month')::timestamp at time zone tz;
    prev_to   := least(prev_from + (cur_to - cur_from), cur_from);
  elsif p_range = 'previous_month' then
    cur_from  := (v_month - interval '1 month')::timestamp at time zone tz;
    cur_to    := v_month::timestamp at time zone tz;
    prev_from := (v_month - interval '2 months')::timestamp at time zone tz;
    prev_to   := cur_from;
  elsif p_range = 'custom' and p_from is not null and p_to is not null and p_from <= p_to then
    cur_from  := p_from::timestamp at time zone tz;
    cur_to    := least((p_to + 1)::timestamp at time zone tz, v_now);
    prev_to   := cur_from;
    prev_from := cur_from - ((p_to + 1) - p_from) * interval '1 day';
  else
    raise exception 'invalid range: %', p_range using errcode = '22023';
  end if;
  return next;
end $$;

-- Cohort counts for leads created in [p_from, p_to).
create function public.dashboard_period(p_from timestamptz, p_to timestamptz) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'leads',        count(*),
    'new',          count(*) filter (where l.status = 'new'),
    'in_progress',  count(*) filter (where l.status = 'in_progress'),
    'won',          count(*) filter (where l.status = 'won'),
    'lost',         count(*) filter (where l.status = 'lost'),
    'handled',      count(*) filter (where l.status <> 'new'),
    'repeat_leads', (select count(distinct e.lead_id) from lead_events e
                      where e.type = 'repeat_submission' and e.created_at >= p_from and e.created_at < p_to))
  from leads l
  where l.created_at >= p_from and l.created_at < p_to;
$$;

-- Everything the dashboard shows, in one round trip. p_now is for tests.
create function public.dashboard(
  p_range text,
  p_from  date        default null,
  p_to    date        default null,
  p_now   timestamptz default null
) returns jsonb
language plpgsql stable set search_path = public, pg_temp as $$
declare
  tz      constant text := 'Asia/Jerusalem';
  v_now   timestamptz := coalesce(p_now, now());
  b       record;
  v_span  integer;
  v_step  integer;
  v_cols  constant text[] := array['id', 'created_at', 'source', 'status', 'name', 'phone', 'phone_normalized',
                                   'lead_type', 'lead_subtype', 'event_date', 'urgency', 'lead_score',
                                   'submission_count', 'last_submission_at', 'status_changed_at', 'seen_at'];
begin
  select * into b from dashboard_bounds(p_range, p_from, p_to, v_now);
  -- Daily points up to ~6 weeks, weekly beyond. Buckets start at the period start.
  v_span := ((b.cur_to - interval '1 microsecond') at time zone tz)::date - (b.cur_from at time zone tz)::date + 1;
  v_step := case when v_span <= 45 then 1 else 7 end;

  return jsonb_build_object(
    'range', jsonb_build_object(
      'key', p_range, 'from', b.cur_from, 'to', b.cur_to, 'prev_from', b.prev_from, 'prev_to', b.prev_to,
      'days', v_span, 'bucket', case v_step when 1 then 'day' else 'week' end, 'now', v_now),

    'current',  dashboard_period(b.cur_from, b.cur_to),
    'previous', dashboard_period(b.prev_from, b.prev_to),

    'open_now', (select jsonb_build_object(
        'new',         count(*) filter (where status = 'new'),
        'in_progress', count(*) filter (where status = 'in_progress'),
        'waiting_24h', count(*) filter (where status = 'new' and created_at < v_now - interval '24 hours'),
        'unread',      count(*) filter (where seen_at is null))
      from leads),

    'sources', (select coalesce(jsonb_agg(s order by s.leads desc, s.source), '[]'::jsonb) from (
        select source, count(*) as leads,
               count(*) filter (where status = 'won') as won,
               count(*) filter (where status = 'lost') as lost
        from leads where created_at >= b.cur_from and created_at < b.cur_to
        group by source) s),

    'services', (select coalesce(jsonb_agg(s order by s.leads desc, s.lead_type), '[]'::jsonb) from (
        select coalesce(lead_type, 'unknown') as lead_type, count(*) as leads,
               count(*) filter (where status = 'won') as won,
               count(*) filter (where status = 'lost') as lost
        from leads where created_at >= b.cur_from and created_at < b.cur_to
        group by 1) s),

    'trend', (select coalesce(jsonb_agg(jsonb_build_object('start', t.d, 'leads', t.leads, 'won', t.won) order by t.d), '[]'::jsonb)
      from (
        select d::date as d,
               count(l.id) as leads,
               count(l.id) filter (where l.status = 'won') as won
        from generate_series((b.cur_from at time zone tz)::date,
                             ((b.cur_to - interval '1 microsecond') at time zone tz)::date,
                             make_interval(days => v_step)) d
        left join leads l
          on l.created_at >= greatest(d::timestamp at time zone tz, b.cur_from)
         and l.created_at <  least((d + make_interval(days => v_step))::timestamp at time zone tz, b.cur_to)
        group by d) t),

    'timing', jsonb_build_object(
      'first_action', (select jsonb_build_object('samples', count(*),
                         'median_hours', percentile_cont(0.5) within group (order by h),
                         'avg_hours', avg(h))
        from (select extract(epoch from (min(e.created_at) - l.created_at)) / 3600 as h
              from leads l
              join lead_events e on e.lead_id = l.id and e.type = 'status_changed' and e.from_status = 'new'
              where l.created_at >= b.cur_from and l.created_at < b.cur_to
              group by l.id, l.created_at) x),
      'close', (select jsonb_build_object('samples', count(*),
                  'median_days', percentile_cont(0.5) within group (order by d),
                  'avg_days', avg(d))
        from (select extract(epoch from (closed_at - created_at)) / 86400 as d
              from leads
              where status = 'won' and closed_at is not null
                and created_at >= b.cur_from and created_at < b.cur_to) x)),

    -- Open leads, for the attention list (ranked in api/_lib/priority.js).
    'open_leads', (select coalesce(jsonb_agg(o.x order by o.last_submission_at desc), '[]'::jsonb) from (
        select (select jsonb_object_agg(k, v) from jsonb_each(to_jsonb(l)) j(k, v) where k = any (v_cols)) as x,
               l.last_submission_at
        from leads l where l.status in ('new', 'in_progress')
        order by l.last_submission_at desc limit 200) o(x, last_submission_at)),

    'recent', (select coalesce(jsonb_agg(o.x order by o.last_submission_at desc), '[]'::jsonb) from (
        select (select jsonb_object_agg(k, v) from jsonb_each(to_jsonb(l)) j(k, v) where k = any (v_cols)) as x,
               l.last_submission_at
        from leads l order by l.last_submission_at desc limit 6) o(x, last_submission_at))
  );
end $$;

-- Same as 003 plus p_flag: 'repeat' (came back at least once) or 'open'
-- (new / in_progress; the HOT view ranks these in api/_lib/priority.js).
drop function public.list_leads(text, text, text, timestamptz, uuid, integer);

create function public.list_leads(
  p_status    text        default null,
  p_source    text        default null,
  p_query     text        default null,
  p_cursor_ts timestamptz default null,
  p_cursor_id uuid        default null,
  p_limit     integer     default 30,
  p_flag      text        default null
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
             lead_score, submission_count, last_submission_at, possible_duplicate_of, seen_at,
             status_changed_at
      from leads
      where (p_status is null or status = p_status)
        and (p_source is null or source = p_source)
        and (p_flag is null
             or (p_flag = 'repeat' and submission_count > 1)
             or (p_flag = 'open' and status in ('new', 'in_progress')))
        and (v_q is null
             or position(v_q in lower(name)) > 0
             or position(v_q in coalesce(email, '')) > 0
             or (v_digits is not null and position(v_digits in coalesce(phone_normalized, '')) > 0))
        and (p_cursor_ts is null or (last_submission_at, id) < (p_cursor_ts, p_cursor_id))
      order by last_submission_at desc, id desc
      limit least(greatest(coalesce(p_limit, 30), 1), 200)
    ) l
  );
end $$;
