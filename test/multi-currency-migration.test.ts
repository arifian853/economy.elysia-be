import { describe, expect, test } from "bun:test";
import { minorUnits } from "../src/money";

const sql = await Bun.file(new URL("../migrations/010_multi_currency_live_ledger.sql", import.meta.url)).text();
const eventGuard = sql.split("create or replace function public.enforce_event_currency()")[1]!.split("$$;")[0]!;
describe("010 exact multi-currency ledger migration", () => {
  test("preserves major-unit values with exact casts and backfills domestic IDR", () => {
    expect(sql).toMatch(/begin;/i);
    expect(sql).toMatch(/alter column budget type numeric using budget::numeric/i);
    expect(sql).toMatch(/alter column unit_price type numeric using unit_price::numeric/i);
    expect(sql).toMatch(/currency_mode text not null default 'domestic'/i);
    expect(sql).toMatch(/base_currency text not null default 'IDR'/i);
    expect(sql).toMatch(/fx_rate_to_idr numeric/i);
    expect(sql).not.toMatch(/double precision|\breal\b|\bfloat\b|\btruncate\b/i);
    expect(sql).not.toMatch(/unit_price\s*\/\s*100|budget\s*\/\s*100/i);
    expect(sql).toMatch(/enable trigger transactions_completed_archive_guard/i);
    expect(sql).toMatch(/enable trigger events_completed_archive_guard/i);
    expect(sql).toMatch(/commit;/i);
  });
  test("backfills every legacy event with a non-historical placeholder, then restores archive guards", () => {
    expect(sql).toMatch(/add column initial_budget numeric/i);
    expect(sql).toMatch(/add column initial_budget_known boolean not null default false/i);
    const backfill = sql.split("disable trigger events_completed_archive_guard;")[1]!.split("enable trigger events_completed_archive_guard;")[0]!;
    expect(backfill).toMatch(/update public\.events e set initial_budget = e\.budget, initial_budget_known = false,/i);
    expect(backfill).not.toMatch(/where.*status|initial_budget_known\s*=\s*true/is);
    expect(sql).toMatch(/alter column initial_budget set not null/i);
    expect(sql).toMatch(/events_initial_budget_positive check \(initial_budget > 0\)/i);
  });
  test("new inserts own the initial snapshot and ordinary updates cannot rewrite either field", () => {
    const insert = eventGuard.split("if tg_op = 'INSERT' then")[1]!.split("elsif tg_op = 'UPDATE' then")[0]!;
    expect(insert).toContain("new.initial_budget := new.budget;");
    expect(insert).toContain("new.initial_budget_known := true;");
    expect(eventGuard).toMatch(/elsif \(new\.initial_budget, new\.initial_budget_known\) is distinct from \(old\.initial_budget, old\.initial_budget_known\) then\s+raise exception 'Initial budget snapshot is immutable\.' using errcode = '55000'/);
    expect(eventGuard).toContain("perform public.assert_event_money(new.initial_budget, new.base_currency);");
    const validation = sql.split("create or replace function public.assert_event_money(")[1]!.split("$$;")[0]!;
    expect(validation).toContain("abs(p_amount) > 9223372036854775807");
    expect(validation).toContain("p_amount <> trunc(p_amount, digits)");
    expect(validation).toContain("'NaN', 'Infinity', '-Infinity'");
  });
  test("only a real unlocked base change resets the snapshot to the same nominal budget", () => {
    expect(eventGuard).toContain("old.currency_locked and not new.currency_locked");
    expect(eventGuard).toContain("old.currency_locked or exists (select 1 from public.transactions where event_id = old.id)");
    const currencyReset = eventGuard.split("if new.base_currency is distinct from old.base_currency then")[1]!.split("elsif (new.initial_budget")[0]!;
    expect(currencyReset).toMatch(/if new\.budget is distinct from old\.budget then\s+raise exception.*'22023'/);
    expect(currencyReset).toContain("new.initial_budget := old.budget;");
    expect(currencyReset).toContain("new.initial_budget_known := true;");
    expect(eventGuard.indexOf("'Event currency is locked.'")).toBeLessThan(eventGuard.indexOf("new.initial_budget := old.budget;"));
    expect(eventGuard.indexOf("new.initial_budget := old.budget;")).toBeLessThan(eventGuard.indexOf("assert_event_money(new.initial_budget"));
  });
  test("audited adjustments and reallocations never assign initial snapshot fields", () => {
    for (const name of ["adjust_event_budget", "reallocate_event_funds"]) {
      const rpc = sql.split(`create or replace function public.${name}(`)[1]!.split("$function$;")[0]!;
      expect(rpc).toMatch(/select \* into e from public\.events where id = p_event_id and user_id = p_user_id for update/);
      expect(rpc).toMatch(/if e\.status = 'completed' then raise exception.*'55000'/);
      expect(rpc).not.toMatch(/initial_budget/);
      expect(rpc).toMatch(/update public\.events set /);
    }
  });
  test("the preserved archive guard freezes the initial fields as well as all other financial data", async () => {
    const archives = await Bun.file(new URL("../migrations/007_compact_public_share_codes.sql", import.meta.url)).text();
    const guard = archives.split("create or replace function public.enforce_completed_event_archive()")[1]!.split("$$;")[0]!;
    expect(guard).toContain("if old.status = 'completed' then");
    expect(guard).toContain("to_jsonb(old) - array['public_share_token', 'public_share_code', 'updated_at']::text[]");
    expect(guard).toContain("to_jsonb(new) - array['public_share_token', 'public_share_code', 'updated_at']::text[]");
    expect(guard).not.toContain("initial_budget"); // Neither snapshot field is exempted.
    expect(guard).toMatch(/new_data is distinct from old_data then\s+raise exception.*'55000'/);
    expect(sql).not.toMatch(/drop trigger.*events_completed_archive_guard|create or replace function public\.enforce_completed_event_archive/);
  });
  test("locks currency atomically, preserves archives and enforces precision and owner binding", () => {
    expect(sql).toMatch(/currency_locked/);
    expect(sql).toMatch(/for update/i);
    expect(sql).toMatch(/currency_locked.*55000/is);
    expect(sql).toMatch(/new\.base_currency is distinct from e\.base_currency/i);
    expect(sql).toMatch(/new\.user_id is distinct from e\.user_id/i);
    expect(sql).toMatch(/old\.fx_rate_to_idr/i);
    expect(sql).toMatch(/currency_minor_units/i);
    expect(sql).toMatch(/new\.unit_price <> trunc/i);
  });
  test("uses the same currency precision registry as the API", () => {
    for (const code of Intl.supportedValuesOf("currency")) {
      expect(sql).toContain(`('${code}', ${minorUnits(code)})`);
    }
  });
  test("updates both audited budget RPCs to numeric with restricted grants", () => {
    expect(sql).toMatch(/drop function public\.reallocate_event_funds\(uuid, uuid, text, bigint, text\)/i);
    expect(sql).toMatch(/p_amount numeric/);
    expect(sql).toMatch(/p_budget_delta numeric/);
    expect(sql).toMatch(/revoke all on function public\.adjust_event_budget.*from public, anon/i);
    expect(sql).toMatch(/to authenticated, service_role/i);
  });
  test("revokes compact aliases when existing clients clear the legacy token", () => {
    expect(sql).toMatch(/before update of public_share_token on public\.events/i);
    expect(sql).toMatch(/if new\.public_share_token is null then new\.public_share_code := null/i);
  });
  test("provides only an anonymous token-protected allowlist with truthful update metadata", () => {
    const projection = sql.split("-- Public projection")[1];
    expect(projection).toContain("security definer");
    expect(projection).toContain("set search_path = ''");
    expect(projection).toMatch(/e\.public_share_token = p_token or e\.public_share_code = p_token/);
    for (const field of ["status", "updatedAt", "baseCurrency", "initialBudget", "initialBudgetKnown", "fxReferenceDate", "fxRateToIdr", "idrEquivalent"]) expect(projection).toContain(`'${field}'`);
    expect(projection).toContain("'initialBudget', e.initial_budget::text, 'initialBudgetKnown', e.initial_budget_known");
    for (const field of ["user_id", "object_key", "transaction_evidence", "participants", "'note'", "'notes'"]) expect(projection).not.toContain(field);
    expect(projection).toMatch(/grant execute.*to anon, authenticated/i);
  });
});
