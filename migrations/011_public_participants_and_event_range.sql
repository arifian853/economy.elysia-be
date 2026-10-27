-- Apply after canonical migrations 001-010, including 007 aliases and 010 ledger.
-- Additive range upgrade: existing single-day events retain their original date.
begin;

alter table public.events add column if not exists event_end_date date;
-- Backfill is a data-only migration maintenance step, not an owner edit. Suspend the
-- event-row guards in this transaction so archived dates stay immutable and updated_at
-- is not rewritten by the currency snapshot trigger. Transaction rollback restores them.
alter table public.events disable trigger events_completed_archive_guard;
alter table public.events disable trigger events_currency_guard;
update public.events set event_end_date = event_date where event_end_date is null;
alter table public.events enable trigger events_currency_guard;
alter table public.events enable trigger events_completed_archive_guard;
alter table public.events alter column event_end_date set not null;
alter table public.events add constraint events_event_date_range_check check (event_end_date >= event_date);
comment on column public.events.event_end_date is 'Inclusive event end date; event_date remains the start date.';

-- 005/007's enforce_completed_event_archive guard compares all columns except the explicitly allowed share
-- token/code and updated_at. event_end_date is intentionally not exempted.
-- Keep the trigger function unchanged: event_end_date remains part of its row diff.
create or replace function public.get_public_event(p_token text)
returns jsonb language sql stable security definer set search_path = '' as $function$
  select jsonb_build_object(
    'event', jsonb_build_object(
      'name', e.name, 'eventDate', e.event_date::text, 'eventEndDate', e.event_end_date::text,
      'status', e.status,
      'updatedAt', to_char(e.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'currencyMode', e.currency_mode, 'baseCurrency', e.base_currency,
      'initialBudget', e.initial_budget::text, 'initialBudgetKnown', e.initial_budget_known,
      'fxReferenceRateToIdr', e.fx_reference_rate_to_idr::text,
      'fxReferenceDate', e.fx_reference_date::text, 'fxReferenceProvider', e.fx_reference_provider
    ),
    'budgetSummary', jsonb_build_object(
      'budget', e.budget::text, 'cashBudget', e.cash_budget::text,
      'digitalBudget', (e.budget - e.cash_budget)::text,
      'totalExpenses', coalesce(sum(t.quantity::numeric * t.unit_price), 0)::text,
      'cashExpenses', coalesce(sum(t.quantity::numeric * t.unit_price) filter (where t.payment_method = 'cash'), 0)::text,
      'digitalExpenses', coalesce(sum(t.quantity::numeric * t.unit_price) filter (where t.payment_method <> 'cash'), 0)::text,
      'totalRemaining', (e.budget - coalesce(sum(t.quantity::numeric * t.unit_price), 0))::text,
      'cashRemaining', (e.cash_budget - coalesce(sum(t.quantity::numeric * t.unit_price) filter (where t.payment_method = 'cash'), 0))::text,
      'digitalRemaining', (e.budget - e.cash_budget - coalesce(sum(t.quantity::numeric * t.unit_price) filter (where t.payment_method <> 'cash'), 0))::text
    ),
    'participants', coalesce((
      select jsonb_agg(public_names.name order by public_names.name collate "C")
      from (
        select btrim(p.name) as name
        from public.participants p
        where p.event_id = e.id and char_length(btrim(p.name)) between 1 and 100
        order by btrim(p.name) collate "C", p.id
        limit 100
      ) public_names
    ), '[]'::jsonb),
    'entries', coalesce(jsonb_agg(jsonb_build_object(
      'type', 'expense', 'name', t.name, 'amount', (t.quantity::numeric * t.unit_price)::text,
      'source', case when t.payment_method = 'cash' then 'cash' else 'digital' end,
      'transactionAt', to_char(t.transaction_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'fxRateToIdr', t.fx_rate_to_idr::text, 'fxRateDate', t.fx_rate_date::text, 'fxRateProvider', t.fx_rate_provider,
      'idrEquivalent', round(t.quantity::numeric * t.unit_price * t.fx_rate_to_idr)::text
    ) order by t.transaction_at desc, t.created_at desc, t.id) filter (where t.id is not null), '[]'::jsonb)
  ) from public.events e left join public.transactions t on t.event_id = e.id
  where (e.public_share_token = p_token or e.public_share_code = p_token)
    and p_token is not null and p_token ~ '^([a-f0-9]{64}|[A-Za-z0-9]{22})$'
  group by e.id;
$function$;
revoke all on function public.get_public_event(text) from public;
grant execute on function public.get_public_event(text) to anon, authenticated;

commit;
