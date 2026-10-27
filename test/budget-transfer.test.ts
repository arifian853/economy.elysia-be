import { describe, expect, test } from "bun:test";
import { resolveBudgetAdjustment, resolveReallocation } from "../src/budget-transfer";

describe("cash/digital reallocation", () => {
  test("moves funds while preserving total budget and never dipping below actual spend", () => {
    expect(resolveReallocation({ budget: 1000, cashBudget: 600, cashSpent: 450, digitalSpent: 250, from: "cash", amount: 150 })).toEqual({ ok: true, cashBudget: 450, digitalBudget: 550 });
  });

  test("rejects moving more than source-channel unspent allocation", () => {
    expect(resolveReallocation({ budget: 1000, cashBudget: 600, cashSpent: 450, digitalSpent: 250, from: "cash", amount: 151 })).toEqual({ ok: false, reason: "insufficient-source-balance" });
  });

  test("rejects unsafe, nonpositive amounts and unallocated events", () => {
    const state = { budget: 1000, cashBudget: null, cashSpent: 0, digitalSpent: 0, from: "cash" as const };
    expect(resolveReallocation({ ...state, amount: 0 })).toEqual({ ok: false, reason: "invalid-amount" });
    expect(resolveReallocation({ ...state, amount: Number.MAX_SAFE_INTEGER + 1 })).toEqual({ ok: false, reason: "invalid-amount" });
    expect(resolveReallocation({ ...state, amount: 1 })).toEqual({ ok: false, reason: "allocation-not-configured" });
  });

  test("rejects a move if recorded spend already exceeds its category allocation", () => {
    expect(resolveReallocation({ budget: 1000, cashBudget: 600, cashSpent: 450, digitalSpent: 390, from: "digital", amount: 11 })).toEqual({ ok: false, reason: "insufficient-source-balance" });
  });

  test("moves in the reverse direction", () => {
    expect(resolveReallocation({ budget: 1000, cashBudget: 600, cashSpent: 450, digitalSpent: 250, from: "digital", amount: 100 })).toEqual({ ok: true, cashBudget: 700, digitalBudget: 300 });
  });
});

describe("audited budget adjustments", () => {
  const current = { budget: 1000, cashBudget: 600, cashSpent: 450, digitalSpent: 250 };

  test("adds budget with an explicit channel split", () => {
    expect(resolveBudgetAdjustment({ ...current, deltaBudget: 200, deltaCashBudget: 100 })).toEqual({ ok: true, budget: 1200, cashBudget: 700, digitalBudget: 500 });
  });

  test("rejects a reduction that would underfund recorded expenses", () => {
    expect(resolveBudgetAdjustment({ ...current, deltaBudget: -300, deltaCashBudget: -200 })).toEqual({ ok: false, reason: "allocation-below-spend" });
  });

  test("rejects invalid or zero adjustments and requires a configured split", () => {
    expect(resolveBudgetAdjustment({ ...current, deltaBudget: 0, deltaCashBudget: 0 })).toEqual({ ok: false, reason: "invalid-adjustment" });
    expect(resolveBudgetAdjustment({ ...current, deltaBudget: 100, deltaCashBudget: 300 })).toEqual({ ok: false, reason: "allocation-below-spend" });
    expect(resolveBudgetAdjustment({ ...current, cashBudget: null, deltaBudget: 100, deltaCashBudget: 50 })).toEqual({ ok: false, reason: "allocation-not-configured" });
  });
});
