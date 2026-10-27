-- Apply after canonical migrations 001-009, including 007. Definition only; NOT applied.
-- Kept in backend/migrations because ../supabase/migrations is outside the writable workspace.
begin;

-- Unconstrained numeric preserves every bigint major-unit value exactly. Precision is
-- validated before writes, rather than silently rounded by a numeric(p,s) typmod.
alter table public.events
  alter column budget type numeric using budget::numeric,
  alter column cash_budget type numeric using cash_budget::numeric,
  add column initial_budget numeric,
  add column initial_budget_known boolean not null default false,
  add column currency_mode text not null default 'domestic',
  add column base_currency text not null default 'IDR',
  add column currency_locked boolean not null default false,
  add column fx_reference_rate_to_idr numeric default 1,
  add column fx_reference_date date,
  add column fx_reference_provider text default 'identity';
alter table public.transactions
  alter column unit_price type numeric using unit_price::numeric,
  add column base_currency text not null default 'IDR',
  add column fx_rate_to_idr numeric,
  add column fx_rate_date date,
  add column fx_rate_provider text;
alter table public.event_fund_movements alter column amount type numeric using amount::numeric;
alter table public.event_budget_adjustments
  alter column budget_delta type numeric using budget_delta::numeric,
  alter column cash_budget_delta type numeric using cash_budget_delta::numeric;

-- Only the migration's backfill bypasses the archive guards, within this transaction.
alter table public.events disable trigger events_completed_archive_guard;
alter table public.transactions disable trigger transactions_completed_archive_guard;
-- Legacy budget edits may never have been audited. This is only a numeric placeholder,
-- never evidence of the historical initial amount (including for completed events).
update public.events e set initial_budget = e.budget, initial_budget_known = false,
  currency_locked = exists (select 1 from public.transactions t where t.event_id = e.id);
update public.transactions set fx_rate_to_idr = 1, fx_rate_provider = 'identity';
alter table public.transactions enable trigger transactions_completed_archive_guard;
alter table public.events enable trigger events_completed_archive_guard;
alter table public.events alter column initial_budget set not null;
comment on column public.events.initial_budget is
  'Initial budget in base currency; only meaningful as an original amount when initial_budget_known is true.';
comment on column public.events.initial_budget_known is
  'False for legacy placeholders; true for new inserts or explicit pre-transaction base-currency resets.';

-- CURRENCY_REGISTRY: generated from Bun/ICU ISO currency metadata, matching src/money.ts.
-- International event creation additionally checks the provider's supported registry.
create or replace function public.currency_minor_units(p_currency text)
returns integer language sql immutable strict set search_path = '' as $$
  select digits from (values
      ('ADP', 2),
      ('AED', 2),
      ('AFA', 2),
      ('AFN', 2),
      ('ALK', 2),
      ('ALL', 2),
      ('AMD', 2),
      ('ANG', 2),
      ('AOA', 2),
      ('AOK', 2),
      ('AON', 2),
      ('AOR', 2),
      ('ARA', 2),
      ('ARL', 2),
      ('ARM', 2),
      ('ARP', 2),
      ('ARS', 2),
      ('ATS', 2),
      ('AUD', 2),
      ('AWG', 2),
      ('AZM', 2),
      ('AZN', 2),
      ('BAD', 2),
      ('BAM', 2),
      ('BAN', 2),
      ('BBD', 2),
      ('BDT', 2),
      ('BEC', 2),
      ('BEF', 2),
      ('BEL', 2),
      ('BGL', 2),
      ('BGM', 2),
      ('BGN', 2),
      ('BGO', 2),
      ('BHD', 3),
      ('BIF', 0),
      ('BMD', 2),
      ('BND', 2),
      ('BOB', 2),
      ('BOL', 2),
      ('BOP', 2),
      ('BOV', 2),
      ('BRB', 2),
      ('BRC', 2),
      ('BRE', 2),
      ('BRL', 2),
      ('BRN', 2),
      ('BRR', 2),
      ('BRZ', 2),
      ('BSD', 2),
      ('BTN', 2),
      ('BUK', 2),
      ('BWP', 2),
      ('BYB', 2),
      ('BYN', 2),
      ('BYR', 0),
      ('BZD', 2),
      ('CAD', 2),
      ('CDF', 2),
      ('CHE', 2),
      ('CHF', 2),
      ('CHW', 2),
      ('CLE', 2),
      ('CLF', 4),
      ('CLP', 0),
      ('CNH', 2),
      ('CNX', 2),
      ('CNY', 2),
      ('COP', 2),
      ('COU', 2),
      ('CRC', 2),
      ('CSD', 2),
      ('CSK', 2),
      ('CUC', 2),
      ('CUP', 2),
      ('CVE', 2),
      ('CYP', 2),
      ('CZK', 2),
      ('DDM', 2),
      ('DEM', 2),
      ('DJF', 0),
      ('DKK', 2),
      ('DOP', 2),
      ('DZD', 2),
      ('ECS', 2),
      ('ECV', 2),
      ('EEK', 2),
      ('EGP', 2),
      ('ERN', 2),
      ('ESA', 2),
      ('ESB', 2),
      ('ESP', 2),
      ('ETB', 2),
      ('EUR', 2),
      ('FIM', 2),
      ('FJD', 2),
      ('FKP', 2),
      ('FRF', 2),
      ('GBP', 2),
      ('GEK', 2),
      ('GEL', 2),
      ('GHC', 2),
      ('GHS', 2),
      ('GIP', 2),
      ('GMD', 2),
      ('GNF', 0),
      ('GNS', 2),
      ('GQE', 2),
      ('GRD', 2),
      ('GTQ', 2),
      ('GWE', 2),
      ('GWP', 2),
      ('GYD', 2),
      ('HKD', 2),
      ('HNL', 2),
      ('HRD', 2),
      ('HRK', 2),
      ('HTG', 2),
      ('HUF', 2),
      ('IDR', 0),
      ('IEP', 2),
      ('ILP', 2),
      ('ILR', 2),
      ('ILS', 2),
      ('INR', 2),
      ('IQD', 3),
      ('IRR', 2),
      ('ISJ', 2),
      ('ISK', 0),
      ('ITL', 2),
      ('JMD', 2),
      ('JOD', 3),
      ('JPY', 0),
      ('KES', 2),
      ('KGS', 2),
      ('KHR', 2),
      ('KMF', 0),
      ('KPW', 2),
      ('KRH', 2),
      ('KRO', 2),
      ('KRW', 0),
      ('KWD', 3),
      ('KYD', 2),
      ('KZT', 2),
      ('LAK', 2),
      ('LBP', 2),
      ('LKR', 2),
      ('LRD', 2),
      ('LSL', 2),
      ('LTL', 2),
      ('LTT', 2),
      ('LUC', 2),
      ('LUF', 2),
      ('LUL', 2),
      ('LVL', 2),
      ('LVR', 2),
      ('LYD', 3),
      ('MAD', 2),
      ('MAF', 2),
      ('MCF', 2),
      ('MDC', 2),
      ('MDL', 2),
      ('MGA', 2),
      ('MGF', 2),
      ('MKD', 2),
      ('MKN', 2),
      ('MLF', 2),
      ('MMK', 2),
      ('MNT', 2),
      ('MOP', 2),
      ('MRO', 2),
      ('MRU', 2),
      ('MTL', 2),
      ('MTP', 2),
      ('MUR', 2),
      ('MVP', 2),
      ('MVR', 2),
      ('MWK', 2),
      ('MXN', 2),
      ('MXP', 2),
      ('MXV', 2),
      ('MYR', 2),
      ('MZE', 2),
      ('MZM', 2),
      ('MZN', 2),
      ('NAD', 2),
      ('NGN', 2),
      ('NIC', 2),
      ('NIO', 2),
      ('NLG', 2),
      ('NOK', 2),
      ('NPR', 2),
      ('NZD', 2),
      ('OMR', 3),
      ('PAB', 2),
      ('PEI', 2),
      ('PEN', 2),
      ('PES', 2),
      ('PGK', 2),
      ('PHP', 2),
      ('PKR', 2),
      ('PLN', 2),
      ('PLZ', 2),
      ('PTE', 2),
      ('PYG', 0),
      ('QAR', 2),
      ('RHD', 2),
      ('ROL', 2),
      ('RON', 2),
      ('RSD', 2),
      ('RUB', 2),
      ('RUR', 2),
      ('RWF', 0),
      ('SAR', 2),
      ('SBD', 2),
      ('SCR', 2),
      ('SDD', 2),
      ('SDG', 2),
      ('SDP', 2),
      ('SEK', 2),
      ('SGD', 2),
      ('SHP', 2),
      ('SIT', 2),
      ('SKK', 2),
      ('SLE', 2),
      ('SLL', 2),
      ('SOS', 2),
      ('SRD', 2),
      ('SRG', 2),
      ('SSP', 2),
      ('STD', 2),
      ('STN', 2),
      ('SUR', 2),
      ('SVC', 2),
      ('SYP', 2),
      ('SZL', 2),
      ('THB', 2),
      ('TJR', 2),
      ('TJS', 2),
      ('TMM', 2),
      ('TMT', 2),
      ('TND', 3),
      ('TOP', 2),
      ('TPE', 2),
      ('TRL', 2),
      ('TRY', 2),
      ('TTD', 2),
      ('TWD', 2),
      ('TZS', 2),
      ('UAH', 2),
      ('UAK', 2),
      ('UGS', 2),
      ('UGX', 0),
      ('USD', 2),
      ('USN', 2),
      ('USS', 2),
      ('UYI', 0),
      ('UYP', 2),
      ('UYU', 2),
      ('UYW', 2),
      ('UZS', 2),
      ('VEB', 2),
      ('VED', 2),
      ('VEF', 2),
      ('VES', 2),
      ('VND', 0),
      ('VNN', 2),
      ('VUV', 0),
      ('WST', 2),
      ('XAF', 0),
      ('XAG', 2),
      ('XAU', 2),
      ('XBA', 2),
      ('XBB', 2),
      ('XBC', 2),
      ('XBD', 2),
      ('XCD', 2),
      ('XCG', 2),
      ('XDR', 2),
      ('XEU', 2),
      ('XFO', 2),
      ('XFU', 2),
      ('XOF', 0),
      ('XPD', 2),
      ('XPF', 0),
      ('XPT', 2),
      ('XRE', 2),
      ('XSU', 2),
      ('XTS', 2),
      ('XUA', 2),
      ('XXX', 2),
      ('YDD', 2),
      ('YER', 2),
      ('YUD', 2),
      ('YUM', 2),
      ('YUN', 2),
      ('YUR', 2),
      ('ZAL', 2),
      ('ZAR', 2),
      ('ZMK', 2),
      ('ZMW', 2),
      ('ZRN', 2),
      ('ZRZ', 2),
      ('ZWD', 2),
      ('ZWG', 2),
      ('ZWL', 2),
      ('ZWR', 2)
  ) as currencies(code, digits) where code = p_currency;
$$;

create or replace function public.assert_event_money(p_amount numeric, p_currency text)
returns void language plpgsql immutable set search_path = '' as $$
declare digits integer := public.currency_minor_units(p_currency);
begin
  if digits is null or p_amount is null or p_amount::text in ('NaN', 'Infinity', '-Infinity')
     or abs(p_amount) > 9223372036854775807 or p_amount <> trunc(p_amount, digits) then
    raise exception 'Invalid amount or currency precision.' using errcode = '22023';
  end if;
end;
$$;

alter table public.events
  add constraint events_initial_budget_positive check (initial_budget > 0),
  add constraint events_currency_mode_check check (currency_mode in ('domestic', 'international') and (currency_mode <> 'domestic' or base_currency = 'IDR')),
  add constraint events_currency_registry_check check (public.currency_minor_units(base_currency) is not null),
  add constraint events_fx_reference_check check (
    (base_currency = 'IDR' and fx_reference_rate_to_idr = 1 and fx_reference_date is null and fx_reference_provider = 'identity')
    or (base_currency <> 'IDR' and (
      (fx_reference_rate_to_idr is null and fx_reference_date is null and fx_reference_provider is null)
      or (fx_reference_rate_to_idr is not null and fx_reference_rate_to_idr > 0 and fx_reference_rate_to_idr < 'Infinity'::numeric
        and fx_reference_date is not null and fx_reference_date <= current_date
        and fx_reference_provider is not null and fx_reference_provider ~ '^[[:alnum:] ._()/+-]{1,100}$')
    ))
  );
alter table public.transactions add constraint transactions_fx_snapshot_check check (
  (base_currency = 'IDR' and fx_rate_to_idr = 1 and fx_rate_date is null and fx_rate_provider = 'identity')
  or (base_currency <> 'IDR' and (
    (fx_rate_to_idr is null and fx_rate_date is null and fx_rate_provider is null)
    or (fx_rate_to_idr is not null and fx_rate_to_idr > 0 and fx_rate_to_idr < 'Infinity'::numeric
      and fx_rate_date is not null and fx_rate_date <= current_date
      and fx_rate_provider is not null and fx_rate_provider ~ '^[[:alnum:] ._()/+-]{1,100}$')
  ))
);

create or replace function public.enforce_event_currency()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    -- Server-owned snapshot: clients cannot supply an invented original amount.
    new.initial_budget := new.budget;
    new.initial_budget_known := true;
  elsif tg_op = 'UPDATE' then
    if old.currency_locked and not new.currency_locked then
      raise exception 'Event currency is locked.' using errcode = '55000';
    end if;
    if (new.base_currency, new.currency_mode) is distinct from (old.base_currency, old.currency_mode)
       and (old.currency_locked or exists (select 1 from public.transactions where event_id = old.id)) then
      raise exception 'Event currency is locked.' using errcode = '55000';
    end if;
    if new.base_currency is distinct from old.base_currency then
      -- An explicit base change reinterprets the same nominal budget, without FX conversion.
      -- The archive guard rejects this for completed events, even without transactions.
      if new.budget is distinct from old.budget then
        raise exception 'Currency changes must preserve the nominal budget.' using errcode = '22023';
      end if;
      new.initial_budget := old.budget;
      new.initial_budget_known := true;
    elsif (new.initial_budget, new.initial_budget_known) is distinct from (old.initial_budget, old.initial_budget_known) then
      raise exception 'Initial budget snapshot is immutable.' using errcode = '55000';
    end if;
  end if;
  perform public.assert_event_money(new.budget, new.base_currency);
  perform public.assert_event_money(new.initial_budget, new.base_currency);
  if new.cash_budget is not null then perform public.assert_event_money(new.cash_budget, new.base_currency); end if;
  if new.base_currency = 'IDR' then
    new.fx_reference_rate_to_idr := 1; new.fx_reference_date := null; new.fx_reference_provider := 'identity';
  end if;
  if tg_op = 'UPDATE' and to_jsonb(new) is distinct from to_jsonb(old) then new.updated_at := clock_timestamp(); end if;
  return new;
end;
$$;
create trigger events_currency_guard before insert or update on public.events
for each row execute function public.enforce_event_currency();

create or replace function public.enforce_transaction_currency()
returns trigger language plpgsql set search_path = '' as $$
declare e public.events%rowtype;
begin
  -- The archive trigger also locks this event. Serialize currency changes and first insert.
  select * into e from public.events where id = new.event_id for update;
  if not found then raise exception 'Event not found.' using errcode = 'P0002'; end if;
  if new.user_id is distinct from e.user_id then raise exception 'Invalid transaction owner.' using errcode = '42501'; end if;
  if new.base_currency is distinct from e.base_currency then raise exception 'Transaction currency must match event.' using errcode = '22023'; end if;
  perform public.assert_event_money(new.unit_price, e.base_currency);
  if new.unit_price <> trunc(new.unit_price, public.currency_minor_units(e.base_currency)) then
    raise exception 'Invalid currency precision.' using errcode = '22023';
  end if;
  if tg_op = 'UPDATE' and (new.base_currency, new.fx_rate_to_idr, new.fx_rate_date, new.fx_rate_provider)
    is distinct from (old.base_currency, old.fx_rate_to_idr, old.fx_rate_date, old.fx_rate_provider) then
    raise exception 'Transaction FX snapshot is immutable.' using errcode = '55000';
  end if;
  if new.base_currency = 'IDR' then new.fx_rate_to_idr := 1; new.fx_rate_date := null; new.fx_rate_provider := 'identity'; end if;
  if not e.currency_locked then update public.events set currency_locked = true where id = e.id; end if;
  -- Assistant-only recording also advances the active event reference. A stale cache
  -- must not replace a newer observation already stored on the event.
  if tg_op = 'INSERT' and new.base_currency <> 'IDR' and new.fx_rate_to_idr is not null
     and (e.fx_reference_date is null or new.fx_rate_date >= e.fx_reference_date) then
    update public.events set fx_reference_rate_to_idr = new.fx_rate_to_idr,
      fx_reference_date = new.fx_rate_date, fx_reference_provider = new.fx_rate_provider where id = e.id;
  end if;
  return new;
end;
$$;
create trigger transactions_currency_guard before insert or update on public.transactions
for each row execute function public.enforce_transaction_currency();

-- Child edits/deletes advance the public revision, including deletion of the final expense.
-- Existing BEFORE archive guards still reject direct changes to completed children.
create or replace function public.touch_live_ledger()
returns trigger language plpgsql set search_path = '' as $$
declare target_id uuid;
begin
  if tg_op = 'DELETE' then target_id := old.event_id; else target_id := new.event_id; end if;
  update public.events set updated_at = clock_timestamp() where id = target_id and status <> 'completed';
  return null;
end;
$$;
create trigger transactions_live_revision after insert or update or delete on public.transactions
for each row execute function public.touch_live_ledger();

-- Existing owner clients revoke by clearing the legacy token, even when 007 aliases exist.
-- UPDATE OF also fires when a NULL legacy token is explicitly set to NULL again.
create or replace function public.revoke_public_share_alias()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.public_share_token is null then new.public_share_code := null; end if;
  return new;
end;
$$;
create trigger events_share_revoke_alias before update of public_share_token on public.events
for each row execute function public.revoke_public_share_alias();

-- Remove bigint overloads: named PostgREST RPCs must resolve to the exact numeric version.
drop function public.reallocate_event_funds(uuid, uuid, text, bigint, text);
drop function public.adjust_event_budget(uuid, uuid, bigint, bigint, text);
create or replace function public.reallocate_event_funds(
  p_event_id uuid,
  p_user_id uuid,
  p_from_channel text,
  p_amount numeric,
  p_note text default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  e public.events%rowtype;
  cash_spent numeric;
  digital_spent numeric;
  digital_budget numeric;
  available numeric;
  next_cash numeric;
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
  perform public.assert_event_money(p_amount, e.base_currency);
  if e.cash_budget is null then raise exception 'Configure cash/digital allocation first.' using errcode = '22023'; end if;

  select coalesce(sum(quantity::numeric * unit_price) filter (where payment_method = 'cash'), 0),
         coalesce(sum(quantity::numeric * unit_price) filter (where payment_method <> 'cash'), 0)
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
    'amount', (p_amount)::text, 'cashBudget', (next_cash)::text, 'digitalBudget', (e.budget - next_cash)::text, 'budget', (e.budget)::text);
end;
$function$;

create or replace function public.adjust_event_budget(
  p_event_id uuid,
  p_user_id uuid,
  p_budget_delta numeric,
  p_cash_budget_delta numeric,
  p_reason text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  e public.events%rowtype;
  cash_spent numeric;
  digital_spent numeric;
  next_budget numeric;
  next_cash numeric;
  next_digital numeric;
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
  perform public.assert_event_money(p_budget_delta, e.base_currency);
  perform public.assert_event_money(p_cash_budget_delta, e.base_currency);
  if e.cash_budget is null then raise exception 'Configure cash/digital allocation first.' using errcode = '22023'; end if;

  select coalesce(sum(quantity::numeric * unit_price) filter (where payment_method = 'cash'), 0),
         coalesce(sum(quantity::numeric * unit_price) filter (where payment_method <> 'cash'), 0)
    into cash_spent, digital_spent from public.transactions where event_id = p_event_id;
  next_budget := e.budget + p_budget_delta;
  next_cash := e.cash_budget + p_cash_budget_delta;
  next_digital := next_budget - next_cash;
  if next_budget <= 0 or next_cash < 0 or next_cash > next_budget then
    raise exception 'Budget adjustment creates invalid allocations.' using errcode = '22023';
  end if;
  if next_cash < cash_spent or next_digital < digital_spent then
    raise exception 'Budget cannot be reduced below recorded expenses.' using errcode = '22023';
  end if;

  update public.events set budget = next_budget, cash_budget = next_cash, updated_at = now() where id = p_event_id and user_id = p_user_id;
  insert into public.event_budget_adjustments(event_id, user_id, budget_delta, cash_budget_delta, reason)
    values (p_event_id, p_user_id, p_budget_delta, p_cash_budget_delta, btrim(p_reason));
  return jsonb_build_object('eventId', p_event_id, 'budget', (next_budget)::text, 'cashBudget', (next_cash)::text, 'digitalBudget', (next_digital)::text,
    'budgetDelta', (p_budget_delta)::text, 'cashBudgetDelta', (p_cash_budget_delta)::text, 'reason', btrim(p_reason));
end;
$function$;

revoke all on function public.reallocate_event_funds(uuid, uuid, text, numeric, text) from public, anon;
revoke all on function public.adjust_event_budget(uuid, uuid, numeric, numeric, text) from public, anon;
grant execute on function public.reallocate_event_funds(uuid, uuid, text, numeric, text) to authenticated, service_role;
grant execute on function public.adjust_event_budget(uuid, uuid, numeric, numeric, text) to authenticated, service_role;


-- Public projection: anonymous, read-only, token-protected and deliberately allowlisted.
-- All money leaves PostgreSQL as text so JSON parsing cannot round it before sanitization.
create or replace function public.get_public_event(p_token text)
returns jsonb language sql stable security definer set search_path = '' as $function$
  select jsonb_build_object(
    'event', jsonb_build_object(
      'name', e.name, 'eventDate', e.event_date::text, 'status', e.status,
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
