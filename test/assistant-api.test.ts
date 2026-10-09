import { describe, expect, test } from "bun:test";
import { createEconomyAssistantApi } from "../src/assistant-api";

const ownerId = "00000000-0000-0000-0000-000000000099";
const token = "local-test-token-that-is-long-enough-for-auth";

class Query {
  filters: [string, unknown][] = [];
  constructor(private readonly calls: { table: string; filters: [string, unknown][] }[], private readonly table: string) {
    calls.push({ table, filters: this.filters });
  }
  select(_columns?: string) { return this; }
  eq(key: string, value: unknown) { this.filters.push([key, value]); return this; }
  order(_key: string, _options?: unknown) { return this; }
  then(resolve: (value: { data: never[]; error: null }) => unknown, reject?: (reason: unknown) => unknown) {
    return Promise.resolve({ data: [] as never[], error: null }).then(resolve, reject);
  }
}

function makeApp() {
  const calls: { table: string; filters: [string, unknown][] }[] = [];
  const db = { from: (table: string) => new Query(calls, table) };
  return { app: createEconomyAssistantApi({ token, ownerId, db: db as never }), calls };
}

async function request(app: { handle(request: Request): Promise<Response> }, auth?: string) {
  return app.handle(new Request("http://localhost/events", {
    headers: auth ? { authorization: auth } : undefined,
  }));
}

describe("local Economy assistant API", () => {
  test("rejects missing or incorrect credentials before querying data", async () => {
    const { app, calls } = makeApp();
    expect((await request(app)).status).toBe(401);
    expect((await request(app, "Bearer wrong-token")).status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  test("mounts the existing event API with a fixed owner identity", async () => {
    const { app, calls } = makeApp();
    const response = await request(app, `Bearer ${token}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
    expect(calls.some((call) => call.table === "events" && call.filters.some(([key, value]) => key === "user_id" && value === ownerId))).toBe(true);
  });
});
