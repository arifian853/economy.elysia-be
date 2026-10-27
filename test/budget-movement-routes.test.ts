import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { createEventRoutes } from "../src/routes/events";

const eventId = "00000000-0000-0000-0000-000000000001";
const ownerId = "owner-1";

function buildApp(result: { data: unknown; error: { code?: string; message?: string } | null }) {
  const db = { rpc: async (name: string, args: unknown) => ({ ...result, call: { name, args } }) };
  const auth = new Elysia({ name: `budget-test-${Math.random()}` }).resolve(
    { as: "scoped" },
    () => ({ user: { id: ownerId }, db }),
  );
  return new Elysia().use(createEventRoutes(auth as never));
}

async function send(app: { handle(request: Request): Promise<Response> }, path: string, body: unknown) {
  return app.handle(new Request(`http://localhost${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }));
}

describe("budget movement API", () => {
  test("calls the atomic reallocation RPC with the authenticated owner", async () => {
    const app = buildApp({ data: { budget: 1000, cashBudget: 450, digitalBudget: 550 }, error: null });
    const response = await send(app, `/events/${eventId}/reallocations`, { from: "cash", amount: 150, note: "trip" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ budget: 1000, cashBudget: 450, digitalBudget: 550 });
  });

  test("calls the atomic adjustment RPC with explicit channel delta and reason", async () => {
    const app = buildApp({ data: { budget: 1200, cashBudget: 700, digitalBudget: 500 }, error: null });
    const response = await send(app, `/events/${eventId}/budget-adjustments`, { budgetDelta: 200, cashBudgetDelta: 100, reason: "Extra contribution" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ budget: 1200, cashBudget: 700, digitalBudget: 500 });
  });

  test("rejects malformed payloads before calling the database", async () => {
    const response = await send(buildApp({ data: null, error: null }), `/events/${eventId}/reallocations`, { from: "wallet", amount: -1 });
    expect(response.status).toBe(422);
  });
  test("returns fractional and large RPC amounts without rounding", async () => {
    const response = await send(buildApp({ data: { budget: "9223372036854775807", cashBudget: "12.50", digitalBudget: "9223372036854775794.50" }, error: null }),
      `/events/${eventId}/reallocations`, { from: "cash", amount: "0.25" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ budget: "9223372036854775807", cashBudget: "12.5", digitalBudget: "9223372036854775794.5" });
  });
});
