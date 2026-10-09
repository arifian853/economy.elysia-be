import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { createEventRoutes } from "../src/routes/events";
import { createTransactionRoutes } from "../src/routes/transactions";

const eventId = "00000000-0000-0000-0000-000000000001";
const transactionId = "00000000-0000-0000-0000-000000000002";

class CompletedEventDb {
  from(table: string) { return new CompletedEventQuery(table); }
}

class CompletedEventQuery {
  operation = "select";
  constructor(private readonly table: string) {}
  select(_columns?: string) { return this; }
  update(_values?: unknown) { this.operation = "update"; return this; }
  delete() { this.operation = "delete"; return this; }
  insert(_values?: unknown) { this.operation = "insert"; return this; }
  eq(_column: string, _value: unknown) { return this; }
  is(_column: string, _value: unknown) { return this; }
  in(_column: string, _values: unknown[]) { return this; }
  order(_column: string, _options?: unknown) { return this; }
  async maybeSingle() {
    return {
      data: this.table === "transactions" ? { event_id: eventId } : { id: eventId, status: "completed" },
      error: null,
    };
  }
  then(resolve: (value: { data: { id: string }[]; error: null }) => unknown, reject?: (reason: unknown) => unknown) {
    return Promise.resolve({ data: this.operation === "delete" ? [{ id: eventId }] : [], error: null }).then(resolve, reject);
  }
  async single() { return { data: null, error: null }; }
}

function testAuth(db: CompletedEventDb) {
  return new Elysia({ name: `archive-test-auth-${Math.random()}` }).resolve(
    { as: "scoped" },
    () => ({ user: { id: "owner-id" }, db }),
  );
}

async function send(app: { handle(request: Request): Promise<Response> }, method: string, path: string, body?: unknown) {
  return app.handle(new Request(`http://localhost${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
}

describe("archived event API guards", () => {
  test("completed events can be deleted, but not edited", async () => {
    const app = new Elysia().use(createEventRoutes(testAuth(new CompletedEventDb()) as never));
    const patchResponse = await send(app, "PATCH", `/events/${eventId}`, { name: "Changed" });
    expect(patchResponse.status).toBe(409);

    const deleteResponse = await send(app, "DELETE", `/events/${eventId}`);
    expect(deleteResponse.status).toBe(200);
    expect(await deleteResponse.json()).toEqual({ deleted: true });
  });

  test("completion cannot be repeated after archiving", async () => {
    const app = new Elysia().use(createEventRoutes(testAuth(new CompletedEventDb()) as never));
    const response = await send(app, "POST", `/events/${eventId}/complete`);
    expect(response.status).toBe(409);
  });

  test("transaction create, edit, and delete are rejected after completion", async () => {
    const app = new Elysia().use(createTransactionRoutes(testAuth(new CompletedEventDb()) as never));
    const requests = [
      ["POST", `/events/${eventId}/transactions`, { name: "Item", unitPrice: 100, paymentMethod: "cash" }],
      ["PATCH", `/transactions/${transactionId}`, { name: "Changed" }],
      ["DELETE", `/transactions/${transactionId}`, undefined],
    ] as const;
    for (const [method, path, body] of requests) {
      const response = await send(app, method, path, body);
      expect(response.status).toBe(409);
      expect((await response.json()).error).toBe("Event sudah diarsipkan dan hanya bisa dilihat.");
    }
  });
});
