-- Cash allocation is configured only after event creation. NULL means the owner
-- has not split the initial total budget yet; digital budget is always derived.
alter table public.events
  add column if not exists cash_budget bigint;

do $migration$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conname = 'events_cash_budget_within_total'
      and conrelid = 'public.events'::pg_catalog.regclass
  ) then
    alter table public.events
      add constraint events_cash_budget_within_total
      check (cash_budget is null or (cash_budget >= 0 and cash_budget <= budget));
  end if;
end
$migration$;

comment on column public.events.cash_budget is
  'Optional cash allocation from the total event budget; NULL means not split yet. Digital allocation is budget minus cash_budget.';

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
  where e.public_share_token = p_token
    and p_token is not null
  group by e.id;
$function$;

revoke all on function public.get_public_event(text) from public;
grant execute on function public.get_public_event(text) to anon, authenticated;
