import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { createEventRoutes } from "../src/routes/events";
import { createTransactionRoutes } from "../src/routes/transactions";
import { createEconomyAssistantApi } from "../src/assistant-api";
import { FxService } from "../src/fx";
import { add, subtract } from "../src/money";

const eventId = "00000000-0000-0000-0000-000000000001";
const txId = "00000000-0000-0000-0000-000000000002";
const ownerId = "00000000-0000-0000-0000-000000000099";
const reference = { base: "SGD", quote: "IDR", rate: "12000.5", date: "2026-10-23", provider: "test provider" };

function fixture(options: { currency?: string; completed?: boolean; locked?: boolean; offline?: boolean; assistant?: boolean; legacy?: boolean } = {}) {
  const state = {
    event: { id: eventId, user_id: ownerId, name: "Trip", event_date: "2026-10-23", budget: "100.5", cash_budget: null,
      initial_budget: "100.5", initial_budget_known: !options.legacy,
      status: options.completed ? "completed" : "active", currency_mode: options.currency === "IDR" ? "domestic" : "international",
      base_currency: options.currency ?? "SGD", currency_locked: options.locked ?? false,
      fx_reference_rate_to_idr: null, fx_reference_date: null, fx_reference_provider: null,
      created_at: "2026-10-23T00:00:00Z", updated_at: "2026-10-23T00:00:00Z", completed_at: null } as Record<string, any>,
    tx: [] as Record<string, any>[],
    writes: [] as { table: string; row: Record<string, any> }[],
    filters: [] as [string, unknown][], selections: [] as string[],
    dbError: null as { code: string; message: string } | null,
    rpcCalls: [] as { name: string; args: Record<string, any> }[],
  };
  class Query {
    row?: Record<string, any>; op = "read";
    constructor(private table: string) {}
    select(columns = "*") { state.selections.push(columns); return this; }
    eq(key: string, value: unknown) { state.filters.push([key, value]); return this; }
    in() { return this; } order() { return this; } or() { return this; }
    insert(row: Record<string, any>) { this.row = row; this.op = "insert"; return this; }
    update(row: Record<string, any>) { this.row = row; this.op = "update"; return this; }
    async execute(single = false) {
      if (this.row) {
        if (state.dbError) return { data: null, error: state.dbError };
        state.writes.push({ table: this.table, row: this.row });
        if (this.table === "events") Object.assign(state.event, this.row);
        if (this.table === "transactions") {
          if (this.op === "insert") state.tx.push({ id: txId, created_at: state.event.created_at, ...this.row });
          else Object.assign(state.tx[0], this.row);
        }
      }
      const data = this.table === "events" ? state.event : this.table === "transactions" ? state.tx[0] ?? null : null;
      return { data: single ? data : this.table === "events" ? [{ ...state.event, transactions: state.tx, participants: [] }] : this.table === "transactions" ? state.tx : [], error: null };
    }
    maybeSingle() { return this.execute(true); } single() { return this.execute(true); }
    then(resolve: any, reject: any) { return this.execute().then(resolve, reject); }
  }
  let fxCalls = 0;
  const fx = new FxService({
    listCurrencies: async () => [{ code: "SGD", name: "Singapore Dollar", symbol: "S$", minorUnits: 2 }, { code: "JPY", name: "Yen", symbol: "¥", minorUnits: 0 }],
    getRate: async (base, quote) => { fxCalls++; if (options.offline) throw Error("offline"); return { ...reference, base, quote }; },
  });
  const db = { from: (table: string) => new Query(table), rpc: async (name: string, args: Record<string, any>) => {
    state.rpcCalls.push({ name, args });
    if (state.event.status === "completed") return { data: null, error: { code: "55000", message: "Completed events are archived and cannot be changed." } };
    state.event.budget = add(state.event.budget, args.p_budget_delta);
    state.event.cash_budget = add(state.event.cash_budget, args.p_cash_budget_delta);
    return { data: { budget: state.event.budget, cashBudget: state.event.cash_budget, digitalBudget: subtract(state.event.budget, state.event.cash_budget) }, error: null };
  } };
  const auth = new Elysia({ name: `currency-auth-${Math.random()}` }).resolve({ as: "scoped" }, () => ({ user: { id: ownerId }, db }));
  const app = options.assistant ? createEconomyAssistantApi({ token: "assistant-test-token", ownerId, db: db as never, fx }) :
    new Elysia().use(createEventRoutes(auth as never, fx)).use(createTransactionRoutes(auth as never, fx));
  return { app, state, fxCalls: () => fxCalls };
}
async function send(app: { handle(request: Request): Promise<Response> }, method: string, path: string, body?: unknown, token?: string) {
  return app.handle(new Request(`http://localhost${path}`, { method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
}
const txBody = { name: "Rice", quantity: 3, unitPrice: "0.1", paymentMethod: "qris" };

describe("single event currency API", () => {
  test("validates domestic and international creation, preserving exact budgets", async () => {
    const { app, state } = fixture();
    const body = { name: "Trip", eventDate: "2026-10-23", budget: "12.5", currencyMode: "international", baseCurrency: "SGD" };
    const response = await send(app, "POST", "/events", body);
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ budget: "12.5", initialBudget: "12.5", initialBudgetKnown: true, baseCurrency: "SGD", currencyMode: "international", fxReferenceRateToIdr: "12000.5", fxReferenceDate: reference.date });
    expect(state.writes[0].row).toMatchObject({ budget: "12.5", initial_budget: "12.5", initial_budget_known: true, base_currency: "SGD", user_id: ownerId });
    expect((await send(app, "POST", "/events", { ...body, currencyMode: "domestic" })).status).toBe(400);
    expect((await send(app, "POST", "/events", { ...body, baseCurrency: "XYZ" })).status).toBe(400);
    expect((await send(app, "POST", "/events", { ...body, baseCurrency: "JPY" })).status).toBe(400);
  });
  test("defaults legacy event creation to domestic IDR without an FX request", async () => {
    const { app, fxCalls } = fixture({ currency: "IDR" });
    const response = await send(app, "POST", "/events", { name: "Local", eventDate: "2026-10-23", budget: 100000 });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ budget: 100000, initialBudget: 100000, initialBudgetKnown: true, currencyMode: "domestic", baseCurrency: "IDR", fxReferenceRateToIdr: "1" });
    expect(fxCalls()).toBe(0);
  });
  test("initial budgets retain exact large values and reject invalid precision or magnitude on creation", async () => {
    const { app, state } = fixture();
    const body = { name: "Trip", eventDate: "2026-10-23", budget: "9223372036854775806.99", currencyMode: "international", baseCurrency: "SGD" };
    const response = await send(app, "POST", "/events", body);
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ budget: body.budget, initialBudget: body.budget, initialBudgetKnown: true });
    for (const budget of ["1.001", "9223372036854775807.01", "0", "-1"]) {
      expect((await send(app, "POST", "/events", { ...body, budget })).status).toBe(400);
    }
    expect(state.writes).toHaveLength(1);
  });
  test("owner list and detail mark legacy initial budgets unknown without deriving an original", async () => {
    const { app, state } = fixture({ legacy: true, currency: "IDR" });
    state.event.initial_budget = "9223372036854775807"; // A backfill placeholder retained after a later adjustment.
    state.event.budget = "9007199254740993";
    const detail = await send(app, "GET", `/events/${eventId}`);
    expect((await detail.json()).event).toMatchObject({ budget: "9007199254740993", initialBudget: "9223372036854775807", initialBudgetKnown: false });
    const list = await send(app, "GET", "/events");
    expect((await list.json())[0]).toMatchObject({ initialBudget: "9223372036854775807", initialBudgetKnown: false });
    expect(state.selections.every((selection) => !selection.includes("budget::text") || selection.includes("initial_budget::text,initial_budget_known"))).toBe(true);
    expect(state.filters).toContainEqual(["user_id", ownerId]);
  });
  test("budget adjustments preserve known and unknown snapshots in subsequent owner reads", async () => {
    for (const legacy of [false, true]) {
      const { app, state } = fixture({ legacy });
      state.event.cash_budget = "40.25";
      const response = await send(app, "POST", `/events/${eventId}/budget-adjustments`, { budgetDelta: "0.25", cashBudgetDelta: "0.1", reason: "Extra funds" });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ budget: "100.75", cashBudget: "40.35" });
      expect(state.rpcCalls).toEqual([{ name: "adjust_event_budget", args: { p_event_id: eventId, p_user_id: ownerId, p_budget_delta: "0.25", p_cash_budget_delta: "0.1", p_reason: "Extra funds" } }]);
      expect((await (await send(app, "GET", `/events/${eventId}`)).json()).event).toMatchObject({ budget: "100.75", initialBudget: "100.5", initialBudgetKnown: !legacy });
    }
  });
  test("allows a supported currency change before transactions and locks it thereafter", async () => {
    const unlocked = fixture();
    expect((await send(unlocked.app, "PATCH", `/events/${eventId}`, { baseCurrency: "JPY" })).status).toBe(400); // Existing fractional budget cannot be reinterpreted as yen.
    unlocked.state.event.budget = "100";
    unlocked.state.event.initial_budget = "12.5";
    unlocked.state.event.initial_budget_known = false;
    const changed = await send(unlocked.app, "PATCH", `/events/${eventId}`, { baseCurrency: "JPY" });
    expect(changed.status).toBe(200);
    expect(await changed.json()).toMatchObject({ budget: 100, initialBudget: 100, initialBudgetKnown: true, baseCurrency: "JPY" });
    const locked = fixture({ locked: true });
    expect((await send(locked.app, "PATCH", `/events/${eventId}`, { baseCurrency: "JPY" })).status).toBe(409);
    const archived = fixture({ completed: true });
    expect((await send(archived.app, "PATCH", `/events/${eventId}`, { baseCurrency: "JPY" })).status).toBe(409);
    expect(locked.state.writes).toHaveLength(0);
    expect(archived.state.writes).toHaveLength(0);
  });
  test("pre-transaction base changes also require representable existing cash allocation", async () => {
    const { app, state } = fixture();
    state.event.budget = "100";
    state.event.cash_budget = "0.5";
    expect((await send(app, "PATCH", `/events/${eventId}`, { baseCurrency: "JPY" })).status).toBe(400);
    expect(state.writes).toHaveLength(0);
  });
  test("same currency assertions, mode-only changes and ordinary edits preserve legacy uncertainty", async () => {
    const { app, state } = fixture({ currency: "IDR", legacy: true });
    state.event.budget = "200";
    state.event.initial_budget = "100";
    for (const patch of [{ baseCurrency: "IDR" }, { currencyMode: "international" }, { name: "Updated" }]) {
      const response = await send(app, "PATCH", `/events/${eventId}`, patch);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ budget: 200, initialBudget: 100, initialBudgetKnown: false });
    }
    expect(state.writes.every(({ row }) => !("initial_budget" in row) && !("initial_budget_known" in row))).toBe(true);
  });
  test("archived snapshots survive reads and rejected currency, allocation and adjustment mutations", async () => {
    for (const legacy of [false, true]) {
      const { app, state, fxCalls } = fixture({ completed: true, legacy });
      for (const patch of [{ baseCurrency: "JPY" }, { cashBudget: "20.5" }, { name: "Changed" }]) {
        expect((await send(app, "PATCH", `/events/${eventId}`, patch)).status).toBe(409);
      }
      expect((await send(app, "POST", `/events/${eventId}/budget-adjustments`, { budgetDelta: "1", cashBudgetDelta: "0", reason: "Extra" })).status).toBe(409);
      expect((await (await send(app, "GET", `/events/${eventId}`)).json()).event).toMatchObject({ initialBudget: "100.5", initialBudgetKnown: !legacy });
      expect(state.writes).toHaveLength(0);
      expect(fxCalls()).toBe(0);
    }
  });
  test("creates exact transaction totals and immutable FX snapshots; rejects mixed currency", async () => {
    const { app, state } = fixture();
    const response = await send(app, "POST", `/events/${eventId}/transactions`, txBody);
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ baseCurrency: "SGD", unitPrice: "0.1", total: "0.3", fxRateToIdr: reference.rate, fxRateDate: reference.date, idrEquivalent: 3600 });
    expect(state.writes[0].row).toMatchObject({ unit_price: "0.1", fx_rate_to_idr: reference.rate, base_currency: "SGD" });
    expect((await send(app, "POST", `/events/${eventId}/transactions`, { ...txBody, currency: "USD" })).status).toBe(400);
    expect((await send(app, "PATCH", `/transactions/${txId}`, { unitPrice: "0.2", currency: "USD" })).status).toBe(400);
    const patch = await send(app, "PATCH", `/transactions/${txId}`, { unitPrice: "0.2" });
    expect(patch.status).toBe(200);
    expect(await patch.json()).toMatchObject({ total: "0.6", fxRateToIdr: reference.rate, idrEquivalent: 7200 });
    expect(state.selections.some((x) => x.includes("unit_price::text"))).toBe(true);
  });
  test("records expenses during FX outage with null references", async () => {
    const { app } = fixture({ offline: true });
    const response = await send(app, "POST", `/events/${eventId}/transactions`, txBody);
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ total: "0.3", fxRateToIdr: null, fxRateDate: null, fxRateProvider: null, idrEquivalent: null });
  });
  test("rejects excess precision and unsafe amounts before insertion", async () => {
    const { app, state } = fixture();
    for (const price of ["0.001", "-0.1", Number.MAX_SAFE_INTEGER + 1]) {
      expect((await send(app, "POST", `/events/${eventId}/transactions`, { ...txBody, unitPrice: price })).status).toBe(400);
    }
    expect(state.writes).toHaveLength(0);
    const yen = fixture({ currency: "JPY" });
    expect((await send(yen.app, "POST", `/events/${eventId}/transactions`, txBody)).status).toBe(400);
  });
  test("configures fractional cash allocation without binary rounding", async () => {
    const { app, state } = fixture();
    state.event.budget = "0.3";
    const response = await send(app, "PATCH", `/events/${eventId}`, { cashBudget: "0.1" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ budget: "0.3", cashBudget: "0.1", digitalBudget: "0.2" });
    expect(state.writes[0].row.cash_budget).toBe("0.1");
  });
  test("event reads refresh active reference, but preserve archived references", async () => {
    const active = fixture();
    const response = await send(active.app, "GET", `/events/${eventId}`);
    expect(response.status).toBe(200);
    expect((await response.json()).event.fxReferenceRateToIdr).toBe(reference.rate);
    const archived = fixture({ completed: true });
    await send(archived.app, "GET", `/events/${eventId}`);
    expect(archived.fxCalls()).toBe(0);
    expect(archived.state.writes).toHaveLength(0);
  });
  test("an older cached reference never replaces a newer stored event observation", async () => {
    const { app, state } = fixture();
    state.event.fx_reference_date = "2026-10-24";
    state.event.fx_reference_rate_to_idr = "12500";
    state.event.fx_reference_provider = "test provider";
    const response = await send(app, "GET", `/events/${eventId}`);
    expect((await response.json()).event.fxReferenceDate).toBe("2026-10-24");
    expect(state.writes).toHaveLength(0);
  });
  test("maps concurrent database currency lock errors to a conflict", async () => {
    const { app, state } = fixture();
    state.event.budget = "100";
    state.dbError = { code: "55000", message: "Event currency is locked." };
    expect((await send(app, "PATCH", `/events/${eventId}`, { baseCurrency: "JPY" })).status).toBe(409);
  });
  test("assistant defaults to selected event currency while preserving bearer owner binding", async () => {
    const { app, state } = fixture({ assistant: true });
    expect((await send(app, "POST", `/events/${eventId}/transactions`, txBody)).status).toBe(401);
    expect(state.writes).toHaveLength(0);
    const response = await send(app, "POST", `/events/${eventId}/transactions`, txBody, "assistant-test-token");
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ baseCurrency: "SGD", total: "0.3", idrEquivalent: 3600 });
    expect(state.filters).toContainEqual(["user_id", ownerId]);
    expect(state.writes[0].row.user_id).toBe(ownerId);
    const domestic = fixture({ assistant: true, currency: "IDR" });
    expect((await send(domestic.app, "POST", `/events/${eventId}/transactions`, { ...txBody, unitPrice: 100, currency: "SGD" }, "assistant-test-token")).status).toBe(400);
  });
});
