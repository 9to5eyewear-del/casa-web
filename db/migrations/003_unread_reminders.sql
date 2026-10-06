-- 003: unread leads (app-icon badge) and the 24-hour "still not handled" reminder.

alter table public.leads
  add column seen_at          timestamptz,   -- first time the owner opened it; null = unread
  add column reminder_sent_at timestamptz;   -- when the 24h reminder went out (once per lead)

create index leads_unread_idx on public.leads (created_at) where seen_at is null;
create index leads_reminder_idx on public.leads (created_at) where status = 'new' and reminder_sent_at is null;

-- A repeat inquiry makes the lead unread again.
create function public.leads_repeat_marks_unread() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if new.submission_count > old.submission_count then
    new.seen_at := null;
  end if;
  return new;
end $$;

create trigger leads_repeat_marks_unread before update of submission_count on public.leads
  for each row execute function public.leads_repeat_marks_unread();

create function public.unread_count() returns integer
language sql stable set search_path = public, pg_temp as $$
  select count(*)::integer from leads where seen_at is null;
$$;

-- Returns the remaining unread count, or null if the lead doesn't exist.
create function public.mark_lead_seen(p_lead_id uuid) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
begin
  update leads set seen_at = coalesce(seen_at, now()) where id = p_lead_id;
  if not found then
    return null;
  end if;
  return jsonb_build_object('unread', unread_count());
end $$;

-- Claims the leads still 'new' after p_hours that haven't been reminded yet,
-- marking them in the same statement so two runs never remind twice.
create function public.claim_due_reminders(p_hours integer default 24) returns jsonb
language sql set search_path = public, pg_temp as $$
  with due as (
    update leads set reminder_sent_at = now()
     where id in (
       select id from leads
        where status = 'new' and reminder_sent_at is null
          and created_at < now() - make_interval(hours => p_hours)
        order by created_at
        limit 20
        for update skip locked)
    returning id, name, lead_type, event_date, created_at
  )
  select coalesce(jsonb_agg(to_jsonb(due) order by due.created_at), '[]'::jsonb) from due;
$$;

create or replace function public.lead_status_counts() returns jsonb
language sql stable set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'new',         count(*) filter (where status = 'new'),
    'in_progress', count(*) filter (where status = 'in_progress'),
    'won',         count(*) filter (where status = 'won'),
    'lost',        count(*) filter (where status = 'lost'),
    'unread',      count(*) filter (where seen_at is null))
  from leads;
$$;

-- Same as 002, plus seen_at for the unread marker.
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
             lead_score, submission_count, last_submission_at, possible_duplicate_of, seen_at
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

-- Permanent delete by the owner (history goes with it; leads that pointed at
-- it as a possible duplicate just lose the pointer). Returns null if missing.
create function public.delete_lead(p_lead_id uuid) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
begin
  delete from leads where id = p_lead_id;
  if not found then
    return null;
  end if;
  return jsonb_build_object('deleted', true, 'unread', unread_count());
end $$;
