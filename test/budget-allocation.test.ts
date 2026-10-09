import { describe, expect, test } from "bun:test";
import { resolveCashBudgetUpdate } from "../src/budget-allocation";

describe("cash budget allocation", () => {
  test("allows a null allocation until the owner configures it", () => {
    expect(resolveCashBudgetUpdate(100_000, null, undefined)).toEqual({ ok: true, cashBudget: null });
  });

  test("rejects invalid total budgets even if the split is not configured", () => {
    expect(resolveCashBudgetUpdate(0, null, null)).toEqual({ ok: false });
    expect(resolveCashBudgetUpdate(Number.MAX_SAFE_INTEGER + 1, null, null)).toEqual({ ok: false });
  });

  test("accepts only a non-negative integer not exceeding total budget", () => {
    expect(resolveCashBudgetUpdate(100_000, null, 40_000)).toEqual({ ok: true, cashBudget: 40_000 });
    expect(resolveCashBudgetUpdate(100_000, null, 100_001)).toEqual({ ok: false });
    expect(resolveCashBudgetUpdate(100_000, null, -1)).toEqual({ ok: false });
    expect(resolveCashBudgetUpdate(100_000, null, 1.5)).toEqual({ ok: false });
  });

  test("clamps existing cash allocation if total budget is lowered", () => {
    expect(resolveCashBudgetUpdate(80_000, 90_000, undefined)).toEqual({ ok: true, cashBudget: 80_000 });
  });
});
