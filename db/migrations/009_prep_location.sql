-- 009: מיקום ההתארגנות — where a bridal prep takes place, and whether it's
-- outside Casa Mancini's fixed service regions.
--
--   prep_region    the region she picked (js/service-areas.js → REGIONS ids)
--   prep_location  the locality / address as she typed it
--   out_of_area    true when the location is outside every service region and
--                  she chose to go on anyway: LeadLive flags it so the team
--                  can price or approve the trip. Decided by the API
--                  (validate.js), from the same locality lists as the form.
--
-- ingest_lead stores them (a repeat inquiry fills them only if still empty);
-- list_leads returns them, and p_flag 'out_of_area' lists only those leads.

alter table public.leads
  add column prep_region   text check (prep_region ~ '^[a-z][a-z_]{1,39}$'),
  add column prep_location text check (char_length(prep_location) <= 120),
  add column out_of_area   boolean not null default false;

create index leads_out_of_area_idx on public.leads (last_submission_at desc, id desc) where out_of_area;

create or replace function public.ingest_lead(
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
      lead_score         = coalesce(lead_score,      p_lead ->> 'lead_score'),
      -- The location travels as one: region, text and flag from the same submission.
      prep_region        = case when prep_location is null then p_lead ->> 'prep_region' else prep_region end,
      out_of_area        = case when prep_location is null then coalesce((p_lead ->> 'out_of_area')::boolean, false) else out_of_area end,
      prep_location      = coalesce(prep_location,   p_lead ->> 'prep_location')
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
    prep_region, prep_location, out_of_area,
    possible_duplicate_of, metadata
  ) values (
    p_lead ->> 'source', p_lead ->> 'name', p_lead ->> 'phone', v_phone, v_email,
    p_lead ->> 'lead_type', p_lead ->> 'lead_subtype', (p_lead ->> 'event_date')::date,
    p_lead ->> 'urgency', (p_lead ->> 'companions')::smallint,
    p_lead ->> 'production_type', (p_lead ->> 'budget')::integer,
    p_lead ->> 'message', p_lead ->> 'lead_score',
    p_lead ->> 'prep_region', p_lead ->> 'prep_location', coalesce((p_lead ->> 'out_of_area')::boolean, false),
    v_dup_id, coalesce(p_lead -> 'metadata', '{}'::jsonb)
  )
  returning id into v_id;

  insert into lead_events (lead_id, type, submission_id, ip_hash, data)
  values (v_id, 'lead_created', p_submission_id, p_ip_hash, p_lead);

  return jsonb_build_object('result', 'created', 'lead_id', v_id, 'submission_count', 1,
                            'possible_duplicate_of', v_dup_id);
end $$;

drop function public.list_leads(text, text, text, timestamptz, uuid, integer, text);

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
             status_changed_at, prep_region, prep_location, out_of_area
      from leads
      where (p_status is null or status = p_status)
        and (p_source is null or source = p_source)
        and (p_flag is null
             or (p_flag = 'repeat' and submission_count > 1)
             or (p_flag = 'open' and status in ('new', 'in_progress'))
             or (p_flag = 'out_of_area' and out_of_area))
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
