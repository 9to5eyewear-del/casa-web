-- 006: Judith can hand a conversation over to WhatsApp (when the visitor asks
-- to talk there). One more funnel step, 'whatsapp_shown', counted like the rest.

alter table public.judith_events drop constraint judith_events_type_check;
alter table public.judith_events add constraint judith_events_type_check
  check (type in ('chat_started', 'qualified', 'handoff_shown', 'handoff_clicked', 'lead_submitted', 'whatsapp_shown'));

-- Same as 005 plus p_whatsapp.
drop function public.judith_save_turn(uuid, text, jsonb, jsonb, boolean, boolean, text, text, integer);

create function public.judith_save_turn(
  p_session_id          uuid,
  p_ip_hash             text,
  p_messages            jsonb,
  p_state               jsonb,
  p_qualified           boolean,
  p_handoff_ready       boolean,
  p_lead_summary        text,
  p_handoff_token       text,
  p_handoff_ttl_seconds integer default 7200,
  p_whatsapp            boolean default false
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
  if p_whatsapp then
    insert into judith_events (session_id, type) values (p_session_id, 'whatsapp_shown') on conflict do nothing;
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

create or replace function public.judith_funnel(
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
      'whatsapp_shown',  count(*) filter (where type = 'whatsapp_shown'),
      'leads',           (select count(*) from leads where source = 'judith_ai'
                            and created_at >= b.cur_from and created_at < b.cur_to),
      'won',             (select count(*) from leads where source = 'judith_ai' and status = 'won'
                            and created_at >= b.cur_from and created_at < b.cur_to))
    from judith_events
    where created_at >= b.cur_from and created_at < b.cur_to
  );
end $$;
