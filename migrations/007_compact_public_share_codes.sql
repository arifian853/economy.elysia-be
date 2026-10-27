-- Add a compact, random public alias while retaining existing long share tokens.
alter table public.events
  add column if not exists public_share_code text;

create unique index if not exists events_public_share_code_uidx
  on public.events (public_share_code)
  where public_share_code is not null;

comment on column public.events.public_share_code is
  '22-character cryptographically random bearer code for compact public share links.';

-- Link rotation/revocation stays allowed on completed events, like the legacy token.
create or replace function public.enforce_completed_event_archive()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  old_data jsonb;
  new_data jsonb;
begin
  if tg_op = 'INSERT' then
    if new.status = 'completed' then
      raise exception 'Create the event first, then complete it to archive it.' using errcode = '55000';
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;

  if old.status = 'completed' then
    old_data := to_jsonb(old) - array['public_share_token', 'public_share_code', 'updated_at']::text[];
    new_data := to_jsonb(new) - array['public_share_token', 'public_share_code', 'updated_at']::text[];
    if new_data is distinct from old_data then
      raise exception 'Completed events are archived and cannot be changed.' using errcode = '55000';
    end if;
  end if;
  return new;
end;
$$;

-- Keep the existing narrow, read-only projection and accept both legacy tokens and compact codes.
create or replace function public.get_public_event(p_token text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'event', pg_catalog.jsonb_build_object(
      'name', e.name,
      'eventDate', e.event_date::text
    ),
    'budgetSummary', pg_catalog.jsonb_build_object(
      'budget', e.budget,
      'cashBudget', e.cash_budget,
      'digitalBudget', case
        when e.cash_budget is null then null
        else e.budget - e.cash_budget
      end,
      'totalExpenses', coalesce(sum(t.quantity::bigint * t.unit_price), 0),
      'cashExpenses', coalesce(sum(t.quantity::bigint * t.unit_price) filter (where t.payment_method = 'cash'), 0),
      'digitalExpenses', coalesce(sum(t.quantity::bigint * t.unit_price) filter (where t.payment_method is not null and t.payment_method <> 'cash'), 0),
      'totalRemaining', e.budget - coalesce(sum(t.quantity::bigint * t.unit_price), 0),
      'cashRemaining', case
        when e.cash_budget is null then null
        else e.cash_budget - coalesce(sum(t.quantity::bigint * t.unit_price) filter (where t.payment_method = 'cash'), 0)
      end,
      'digitalRemaining', case
        when e.cash_budget is null then null
        else (e.budget - e.cash_budget) - coalesce(sum(t.quantity::bigint * t.unit_price) filter (where t.payment_method is not null and t.payment_method <> 'cash'), 0)
      end
    ),
    'entries', coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'type', 'expense',
          'name', t.name,
          'amount', t.quantity::bigint * t.unit_price,
          'source', case when t.payment_method = 'cash' then 'cash' else 'digital' end,
          'transactionAt', pg_catalog.to_char(
            t.transaction_at at time zone 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS"Z"'
          )
        ) order by t.transaction_at desc
      ) filter (where t.id is not null),
      '[]'::pg_catalog.jsonb
    )
  )
  from public.events as e
  left join public.transactions as t on t.event_id = e.id
  where (e.public_share_token = p_token or e.public_share_code = p_token)
    and p_token is not null
  group by e.id;
$function$;

revoke all on function public.get_public_event(text) from public;
grant execute on function public.get_public_event(text) to anon, authenticated;
