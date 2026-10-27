import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const migration = readFileSync(new URL("../migrations/008_budget_movements.sql", import.meta.url), "utf8");

describe("v1.5 budget movement migration", () => {
  test("is additive and creates user-scoped audit logs for reallocations and budget adjustments", () => {
    expect(migration).toMatch(/create table public\.event_fund_movements/i);
    expect(migration).toMatch(/create table public\.event_budget_adjustments/i);
    expect(migration).toMatch(/enable row level security/i);
    expect(migration).toMatch(/auth\.uid\(\) = user_id/i);
    expect(migration).not.toMatch(/drop table|truncate|delete from public\.(events|transactions|participants)/i);
  });

  test("uses locked, owner-scoped atomic RPCs and refuses archived events", () => {
    expect(migration).toMatch(/function public\.reallocate_event_funds/i);
    expect(migration).toMatch(/function public\.adjust_event_budget/i);
    expect(migration).toMatch(/for update/i);
    expect(migration).toMatch(/e\.status = 'completed'/i);
    expect(migration).toMatch(/cash_spent/);
    expect(migration).toMatch(/digital_spent/);
  });
});
