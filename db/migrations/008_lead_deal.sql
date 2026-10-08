-- 008: what a closed lead actually booked ("פרטי הסגירה" in LeadLive) —
-- the package, the booked date and hours, how many people, the price, the
-- deposit, how they pay, and free notes.
--
--   leads.deal   jsonb, null until someone fills it in. Validated by the API
--                (validate.js → validateDeal); kept when the lead leaves
--                'won', so reopening a deal doesn't lose what was agreed.
--
-- The booked date and service also update the lead's own event_date /
-- lead_type, so the Google Calendar event follows the deal.

alter table public.leads add column deal jsonb;

create function public.set_lead_deal(
  p_lead_id     uuid,
  p_deal        jsonb,
  p_event_date  date default null,
  p_lead_type   text default null,
  p_actor_id    text default null,
  p_actor_email text default null
) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  v_lead leads;
begin
  update leads set
    deal       = p_deal,
    event_date = coalesce(p_event_date, event_date),
    lead_type  = coalesce(p_lead_type, lead_type),
    updated_at = now()
  where id = p_lead_id
  returning * into v_lead;
  if not found then
    return null;
  end if;

  insert into lead_events (lead_id, type, actor_id, actor_email, data)
  values (p_lead_id, 'deal_updated', p_actor_id, p_actor_email, p_deal);

  return to_jsonb(v_lead);
end $$;
