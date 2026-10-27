-- v1.5 additive ledger tables and atomic budget operations.
-- This file is a migration definition only; applying it is a separate, explicit release step.

create table public.event_fund_movements (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  from_channel text not null check (from_channel in ('cash', 'digital')),
  amount bigint not null check (amount > 0),
  note text check (note is null or char_length(note) <= 500),
  created_at timestamptz not null default now()
);
create index event_fund_movements_event_created_idx on public.event_fund_movements(event_id, created_at desc);
alter table public.event_fund_movements enable row level security;
create policy event_fund_movements_select_owner on public.event_fund_movements
  for select to authenticated using (auth.uid() = user_id);

create table public.event_budget_adjustments (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  budget_delta bigint not null check (budget_delta <> 0),
  cash_budget_delta bigint not null,
  reason text not null check (char_length(btrim(reason)) between 1 and 500),
  created_at timestamptz not null default now()
);
create index event_budget_adjustments_event_created_idx on public.event_budget_adjustments(event_id, created_at desc);
alter table public.event_budget_adjustments enable row level security;
create policy event_budget_adjustments_select_owner on public.event_budget_adjustments
  for select to authenticated using (auth.uid() = user_id);

create or replace function public.reallocate_event_funds(
  p_event_id uuid,
  p_user_id uuid,
  p_from_channel text,
  p_amount bigint,
  p_note text default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  e public.events%rowtype;
  cash_spent bigint;
  digital_spent bigint;
  digital_budget bigint;
  available bigint;
  next_cash bigint;
begin
  if p_user_id is null or (auth.uid() is not null and auth.uid() <> p_user_id) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if p_from_channel is null or p_from_channel not in ('cash', 'digital') or p_amount is null or p_amount <= 0 or char_length(coalesce(p_note, '')) > 500 then
    raise exception 'Invalid fund movement' using errcode = '22023';
  end if;
  select * into e from public.events where id = p_event_id and user_id = p_user_id for update;
  if not found then raise exception 'Event not found' using errcode = 'P0002'; end if;
  if e.status = 'completed' then raise exception 'Completed events are archived and cannot be changed.' using errcode = '55000'; end if;
  if e.cash_budget is null then raise exception 'Configure cash/digital allocation first.' using errcode = '22023'; end if;

  select coalesce(sum(quantity::bigint * unit_price) filter (where payment_method = 'cash'), 0),
         coalesce(sum(quantity::bigint * unit_price) filter (where payment_method <> 'cash'), 0)
    into cash_spent, digital_spent from public.transactions where event_id = p_event_id;
  digital_budget := e.budget - e.cash_budget;
  if cash_spent > e.cash_budget or digital_spent > digital_budget then
    raise exception 'Current allocations are below recorded expenses.' using errcode = '22023';
  end if;
  available := case when p_from_channel = 'cash' then e.cash_budget - cash_spent else digital_budget - digital_spent end;
  if p_amount > available then raise exception 'Insufficient unspent source allocation.' using errcode = '22023'; end if;
  next_cash := case when p_from_channel = 'cash' then e.cash_budget - p_amount else e.cash_budget + p_amount end;

  update public.events set cash_budget = next_cash, updated_at = now() where id = p_event_id and user_id = p_user_id;
  insert into public.event_fund_movements(event_id, user_id, from_channel, amount, note)
    values (p_event_id, p_user_id, p_from_channel, p_amount, nullif(btrim(p_note), ''));
  return jsonb_build_object('eventId', p_event_id, 'from', p_from_channel, 'to', case when p_from_channel = 'cash' then 'digital' else 'cash' end,
    'amount', p_amount, 'cashBudget', next_cash, 'digitalBudget', e.budget - next_cash, 'budget', e.budget);
end;
$function$;

create or replace function public.adjust_event_budget(
  p_event_id uuid,
  p_user_id uuid,
  p_budget_delta bigint,
  p_cash_budget_delta bigint,
  p_reason text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  e public.events%rowtype;
  cash_spent bigint;
  digital_spent bigint;
  next_budget bigint;
  next_cash bigint;
  next_digital bigint;
begin
  if p_user_id is null or (auth.uid() is not null and auth.uid() <> p_user_id) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if p_budget_delta is null or p_budget_delta = 0 or p_cash_budget_delta is null or char_length(btrim(coalesce(p_reason, ''))) not between 1 and 500 then
    raise exception 'Invalid budget adjustment' using errcode = '22023';
  end if;
  select * into e from public.events where id = p_event_id and user_id = p_user_id for update;
  if not found then raise exception 'Event not found' using errcode = 'P0002'; end if;
  if e.status = 'completed' then raise exception 'Completed events are archived and cannot be changed.' using errcode = '55000'; end if;
  if e.cash_budget is null then raise exception 'Configure cash/digital allocation first.' using errcode = '22023'; end if;

  select coalesce(sum(quantity::bigint * unit_price) filter (where payment_method = 'cash'), 0),
         coalesce(sum(quantity::bigint * unit_price) filter (where payment_method <> 'cash'), 0)
    into cash_spent, digital_spent from public.transactions where event_id = p_event_id;
  next_budget := e.budget + p_budget_delta;
  next_cash := e.cash_budget + p_cash_budget_delta;
  next_digital := next_budget - next_cash;
  if next_budget < 1 or next_cash < 0 or next_cash > next_budget then
    raise exception 'Budget adjustment creates invalid allocations.' using errcode = '22023';
  end if;
  if next_cash < cash_spent or next_digital < digital_spent then
    raise exception 'Budget cannot be reduced below recorded expenses.' using errcode = '22023';
  end if;

  update public.events set budget = next_budget, cash_budget = next_cash, updated_at = now() where id = p_event_id and user_id = p_user_id;
  insert into public.event_budget_adjustments(event_id, user_id, budget_delta, cash_budget_delta, reason)
    values (p_event_id, p_user_id, p_budget_delta, p_cash_budget_delta, btrim(p_reason));
  return jsonb_build_object('eventId', p_event_id, 'budget', next_budget, 'cashBudget', next_cash, 'digitalBudget', next_digital,
    'budgetDelta', p_budget_delta, 'cashBudgetDelta', p_cash_budget_delta, 'reason', btrim(p_reason));
end;
$function$;

revoke all on function public.reallocate_event_funds(uuid, uuid, text, bigint, text) from public, anon;
revoke all on function public.adjust_event_budget(uuid, uuid, bigint, bigint, text) from public, anon;
grant execute on function public.reallocate_event_funds(uuid, uuid, text, bigint, text) to authenticated, service_role;
grant execute on function public.adjust_event_budget(uuid, uuid, bigint, bigint, text) to authenticated, service_role;
