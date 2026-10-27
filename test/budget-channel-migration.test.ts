import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const migration = readFileSync(
  new URL("../migrations/004_budget_channels.sql", import.meta.url),
  "utf8",
);

describe("budget channel migration", () => {
  test("keeps existing events unallocated and bounds cash within total budget", () => {
    expect(migration).toMatch(/add column if not exists cash_budget bigint/i);
    expect(migration).toMatch(/cash_budget is null or \(cash_budget >= 0 and cash_budget <= budget\)/i);
  });

  test("public projection exposes only the financial summary and expense channel", () => {
    expect(migration).toMatch(/'cashBudget'/);
    expect(migration).toMatch(/'digitalBudget'/);
    expect(migration).toMatch(/'totalExpenses'/);
    expect(migration).toMatch(/'cashExpenses'/);
    expect(migration).toMatch(/'digitalExpenses'/);
    expect(migration).toMatch(/'totalRemaining'/);
    expect(migration).toMatch(/'source'/);
    expect(migration).not.toMatch(/'participants'/i);
    expect(migration).not.toMatch(/'notes'/i);
    expect(migration).not.toMatch(/'paymentMethod'/i);
  });
});
