import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { createPublicEventRoutes, sanitizePublicEvent } from "../src/routes/public-events";

const payload = {
  event: { name: "Trip", eventDate: "2026-10-23", status: "active", updatedAt: "2026-10-23T12:00:00.000Z",
    initialBudget: "12.50", initialBudgetKnown: true,
    currencyMode: "international", baseCurrency: "SGD", fxReferenceRateToIdr: "12000.5", fxReferenceDate: "2026-10-23", fxReferenceProvider: "Frankfurter v2",
    userId: "private-owner", notes: "private-notes", objectKey: "private-object" },
  budgetSummary: { budget: "1", cashBudget: "0.5", digitalBudget: "0.5", totalExpenses: "0.3", cashExpenses: "0.1", digitalExpenses: "0.2", totalRemaining: "0.7", cashRemaining: "0.4", digitalRemaining: "0.3" },
  entries: [
    { type: "expense", name: "Cash", amount: "0.1", source: "cash", transactionAt: "2026-10-23T11:00:00Z", fxRateToIdr: "12000.5", fxRateDate: "2026-10-22", fxRateProvider: "Frankfurter v2", idrEquivalent: "1200", object_key: "private-receipt", note: "private-note", evidence: ["private-evidence"] },
    { type: "expense", name: "Digital", amount: "0.2", source: "digital", transactionAt: "2026-10-23T12:00:00Z", fxRateToIdr: null, fxRateDate: null, fxRateProvider: null, idrEquivalent: null },
  ], owner: { email: "private-email" },
};
describe("public currency projection", () => {
  test("polls anonymously with safe status, timestamps, exact totals and transaction snapshots", async () => {
    const app = new Elysia().use(createPublicEventRoutes(async () => ({ data: payload })));
    const response = await app.handle(new Request("http://localhost/public/events", { headers: { "x-economy-share-token": "a".repeat(64) } }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.event).toMatchObject({ initialBudget: "12.5", initialBudgetKnown: true, status: "active", updatedAt: payload.event.updatedAt, baseCurrency: "SGD", fxReferenceRateToIdr: "12000.5" });
    expect(body.entries[0]).toMatchObject({ amount: "0.1", fxRateDate: "2026-10-22", idrEquivalent: 1200 });
    expect(body.entries[1].idrEquivalent).toBeNull();
    expect(body.budgetSummary.totalExpenses).toBe("0.3");
    expect(JSON.stringify(body)).not.toContain("private-");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });
  test("exposes unknown legacy placeholders without promoting them to historical amounts", () => {
    const result = sanitizePublicEvent({ ...payload, event: { ...payload.event, initialBudget: "9223372036854775806.99", initialBudgetKnown: false } });
    expect(result?.event).toMatchObject({ initialBudget: "9223372036854775806.99", initialBudgetKnown: false });
    expect(JSON.stringify(result)).not.toContain("private-");
  });
  test("validates initial snapshot precision, size, positivity and strict knowledge flags", () => {
    for (const initialBudget of ["0.001", "9223372036854775807.01", "0", "-1", "NaN", "1e2", Number.MAX_SAFE_INTEGER + 1, null, "private-path"]) {
      for (const initialBudgetKnown of [true, false]) {
        expect(sanitizePublicEvent({ ...payload, event: { ...payload.event, initialBudget, initialBudgetKnown } })).toBeNull();
      }
    }
    for (const initialBudgetKnown of ["false", "true", 1, null, undefined]) {
      expect(sanitizePublicEvent({ ...payload, event: { ...payload.event, initialBudgetKnown } })).toBeNull();
    }
    expect(sanitizePublicEvent({ ...payload, event: { ...payload.event, initialBudget: undefined } })).toBeNull();
    const idr = { ...payload.event, baseCurrency: "IDR", currencyMode: "domestic", fxReferenceRateToIdr: "1", fxReferenceDate: null, fxReferenceProvider: "identity", initialBudget: "1.5" };
    expect(sanitizePublicEvent({ ...payload, event: idr })).toBeNull();
  });
  test("rejects invalid metadata, overprecision and misleading balances", () => {
    for (const event of [
      { ...payload.event, baseCurrency: "XYZ" }, { ...payload.event, currencyMode: "domestic" },
      { ...payload.event, updatedAt: "private-path" }, { ...payload.event, fxReferenceProvider: "https://private.example/key" },
    ]) expect(sanitizePublicEvent({ ...payload, event })).toBeNull();
    expect(sanitizePublicEvent({ ...payload, budgetSummary: { ...payload.budgetSummary, totalExpenses: "0.30000000000000004" } })).toBeNull();
    expect(sanitizePublicEvent({ ...payload, budgetSummary: { ...payload.budgetSummary, totalRemaining: "0.6" } })).toBeNull();
  });
  test("keeps large legacy integers exact through the public response", () => {
    const result = sanitizePublicEvent({ event: { name: "Local", eventDate: "2026-10-23" },
      budgetSummary: { budget: "9223372036854775807", cashBudget: null, digitalBudget: null, totalExpenses: 0, cashExpenses: 0, digitalExpenses: 0, totalRemaining: "9223372036854775807", cashRemaining: null, digitalRemaining: null }, entries: [] });
    expect(result?.budgetSummary.budget).toBe("9223372036854775807");
    expect(result?.event).toMatchObject({ initialBudget: "9223372036854775807", initialBudgetKnown: false });
  });
});
