-- 007: the "Claude API" card in LeadLive — is Judith's Claude access working,
-- and what has it cost?
--
-- Anthropic has no API for the remaining prepaid credit, and its Usage & Cost
-- API needs an Admin key (organizations only). So every Judith call records
-- the token counts Anthropic returned with it (response.usage); the server
-- prices them. claude_cost_cache keeps the last Cost API answer when an Admin
-- key is configured, so LeadLive doesn't call Anthropic on every load.
--
--   claude_calls       one row per Claude request (failed ones too, with no
--                      tokens), no conversation content. est_cost_usd is the
--                      price-list cost at the time (null for an unknown model).
--   claude_cost_cache  a single row: the last cost_report summary.

create table public.claude_calls (
  id                 bigint generated always as identity primary key,
  created_at         timestamptz not null default now(),
  model              text not null,
  ok                 boolean not null,
  error              text check (error in ('credit', 'auth', 'rate_limit', 'overloaded', 'network', 'other')),
  input_tokens       integer not null default 0,
  cache_write_tokens integer not null default 0,
  cache_read_tokens  integer not null default 0,
  output_tokens      integer not null default 0,
  est_cost_usd       numeric(12, 6)
);

create index claude_calls_time_idx on public.claude_calls (created_at);

create function public.claude_record_call(
  p_model       text,
  p_ok          boolean,
  p_error       text,
  p_input       integer,
  p_cache_write integer,
  p_cache_read  integer,
  p_output      integer,
  p_est_cost    numeric default null
) returns jsonb
language sql set search_path = public, pg_temp as $$
  insert into claude_calls (model, ok, error, input_tokens, cache_write_tokens, cache_read_tokens, output_tokens, est_cost_usd)
  values (p_model, p_ok, p_error, coalesce(p_input, 0), coalesce(p_cache_write, 0),
          coalesce(p_cache_read, 0), coalesce(p_output, 0), p_est_cost)
  returning jsonb_build_object('id', id);
$$;

-- Token totals per model for today, this month (UTC, like Anthropic's
-- billing) and since p_since (all calls when null), plus the last call.
create function public.claude_usage(p_now timestamptz, p_since timestamptz default null) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  with b as (
    select date_trunc('day', p_now at time zone 'UTC') at time zone 'UTC' as day_from,
           date_trunc('month', p_now at time zone 'UTC') at time zone 'UTC' as month_from
  ),
  per_model as (
    select model,
           (created_at >= b.day_from)   as is_today,
           (created_at >= b.month_from) as is_month,
           (p_since is null or created_at >= p_since) as is_since,
           input_tokens, cache_write_tokens, cache_read_tokens, output_tokens
    from claude_calls, b
    where created_at <= p_now
  ),
  windows as (
    select w.name, m.model, count(*) as calls,
           sum(input_tokens)::bigint as input, sum(cache_write_tokens)::bigint as cache_write,
           sum(cache_read_tokens)::bigint as cache_read, sum(output_tokens)::bigint as output
    from per_model m
    cross join lateral (values ('today', m.is_today), ('month', m.is_month), ('since', m.is_since)) as w(name, hit)
    where w.hit
    group by w.name, m.model
  )
  select jsonb_build_object(
    'today', coalesce((select jsonb_agg(to_jsonb(x) - 'name') from windows x where name = 'today'), '[]'::jsonb),
    'month', coalesce((select jsonb_agg(to_jsonb(x) - 'name') from windows x where name = 'month'), '[]'::jsonb),
    'since', coalesce((select jsonb_agg(to_jsonb(x) - 'name') from windows x where name = 'since'), '[]'::jsonb),
    'first_call_at', (select min(created_at) from claude_calls),
    'last_call', (select jsonb_build_object('at', created_at, 'ok', ok, 'error', error)
                    from claude_calls where created_at <= p_now order by created_at desc, id desc limit 1));
$$;

create table public.claude_cost_cache (
  id         smallint primary key default 1 check (id = 1),
  fetched_at timestamptz not null,
  data       jsonb not null
);

create function public.claude_cost_cache_get() returns jsonb
language sql stable set search_path = public, pg_temp as $$
  select jsonb_build_object('fetched_at', fetched_at, 'data', data) from claude_cost_cache where id = 1;
$$;

create function public.claude_cost_cache_put(p_data jsonb, p_fetched_at timestamptz) returns jsonb
language sql set search_path = public, pg_temp as $$
  insert into claude_cost_cache (id, fetched_at, data) values (1, p_fetched_at, p_data)
  on conflict (id) do update set fetched_at = excluded.fetched_at, data = excluded.data
  returning jsonb_build_object('fetched_at', fetched_at);
$$;
