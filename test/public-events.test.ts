import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { createPublicEventRoutes } from "../src/routes/public-events";

const SHARE_TOKEN = "a".repeat(64);
const PRIVATE_DATA = {
  event: { name: "Camping Bintan", eventDate: "2026-11-03", notes: "Lokasi rahasia", userId: "owner-id" },
  budgetSummary: {
    budget: 100_000,
    cashBudget: 25_000,
    digitalBudget: 75_000,
    totalExpenses: 60_000,
    cashExpenses: 25_000,
    digitalExpenses: 35_000,
    totalRemaining: 40_000,
    cashRemaining: 0,
    digitalRemaining: 40_000,
    participants: ["private"],
  },
  entries: [
    { type: "expense", name: "Belanja tunai", amount: 25_000, source: "cash", transactionAt: "2026-11-03T10:00:00.000Z", paymentMethod: "cash", note: "internal", userId: "payer-id" },
    { type: "expense", name: "Belanja QRIS", amount: 35_000, source: "digital", transactionAt: "2026-11-03T11:00:00.000Z", paymentMethod: "qris", note: "internal" },
    { type: "income", name: "Income not modeled", amount: 100_000, source: "digital", transactionAt: "2026-11-03T12:00:00.000Z" },
  ],
  participants: [{ name: "Jangan tampilkan" }],
};

describe("public event route", () => {
  test("serves the financial summary and allowlisted entries without requiring login", async () => {
    let receivedToken = "";
    const app = new Elysia().use(
      createPublicEventRoutes(async (token) => {
        receivedToken = token;
        return { data: PRIVATE_DATA, error: null };
      }),
    );

    const response = await app.handle(
      new Request("http://localhost/public/events", {
        headers: { "x-economy-share-token": SHARE_TOKEN },
      }),
    );

    expect(response.status).toBe(200);
    expect(receivedToken).toBe(SHARE_TOKEN);
    expect(await response.json()).toEqual({
      event: { name: "Camping Bintan", eventDate: "2026-11-03", initialBudget: 100_000, initialBudgetKnown: false },
      budgetSummary: {
        budget: 100_000,
        cashBudget: 25_000,
        digitalBudget: 75_000,
        totalExpenses: 60_000,
        cashExpenses: 25_000,
        digitalExpenses: 35_000,
        totalRemaining: 40_000,
        cashRemaining: 0,
        digitalRemaining: 40_000,
      },
      entries: [
        { type: "expense", name: "Belanja tunai", amount: 25_000, source: "cash", transactionAt: "2026-11-03T10:00:00.000Z" },
        { type: "expense", name: "Belanja QRIS", amount: 35_000, source: "digital", transactionAt: "2026-11-03T11:00:00.000Z" },
      ],
    });
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });

  test("allows a negative remaining balance when one channel is overspent", async () => {
    const overspent = {
      ...PRIVATE_DATA,
      budgetSummary: {
        ...PRIVATE_DATA.budgetSummary,
        cashBudget: 20_000,
        digitalBudget: 80_000,
        cashRemaining: -5_000,
        digitalRemaining: 45_000,
      },
    };
    const app = new Elysia().use(createPublicEventRoutes(async () => ({ data: overspent, error: null })));
    const response = await app.handle(new Request("http://localhost/public/events", {
      headers: { "x-economy-share-token": SHARE_TOKEN },
    }));
    expect(response.status).toBe(200);
    expect((await response.json() as { budgetSummary: { cashRemaining: number } }).budgetSummary.cashRemaining).toBe(-5_000);
  });

  test("rejects inconsistent totals rather than publishing misleading balances", async () => {
    const app = new Elysia().use(
      createPublicEventRoutes(async () => ({
        data: { ...PRIVATE_DATA, budgetSummary: { ...PRIVATE_DATA.budgetSummary, totalExpenses: 59_999 } },
        error: null,
      })),
    );
    const response = await app.handle(new Request("http://localhost/public/events", {
      headers: { "x-economy-share-token": SHARE_TOKEN },
    }));
    expect(response.status).toBe(404);
  });

  test("accepts compact random share codes as bearer values", async () => {
    const shortCode = "Ab3dE5fG7hJ9kLmN2pQ4rS";
    let receivedToken = "";
    const app = new Elysia().use(createPublicEventRoutes(async (token) => {
      receivedToken = token;
      return { data: PRIVATE_DATA, error: null };
    }));
    const response = await app.handle(new Request("http://localhost/public/events", {
      headers: { "x-economy-share-token": shortCode },
    }));
    expect(response.status).toBe(200);
    expect(receivedToken).toBe(shortCode);
  });

  test("returns a generic not-found response for missing or malformed tokens", async () => {
    let calls = 0;
    const app = new Elysia().use(
      createPublicEventRoutes(async () => {
        calls += 1;
        return { data: PRIVATE_DATA, error: null };
      }),
    );
    const response = await app.handle(new Request("http://localhost/public/events"));
    expect(response.status).toBe(404);
    expect(calls).toBe(0);
    expect(await response.json()).toEqual({ error: "Catatan tidak tersedia." });
  });

  test("does not expose backend errors to anonymous callers", async () => {
    const app = new Elysia().use(createPublicEventRoutes(async () => ({ data: null, error: { message: "secret database details" } })));
    const response = await app.handle(new Request("http://localhost/public/events", {
      headers: { "x-economy-share-token": SHARE_TOKEN },
    }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Catatan publik sementara tidak tersedia." });
  });
});
