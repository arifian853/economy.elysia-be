import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { createEventRoutes } from "../src/routes/events";

const eventId = "00000000-0000-0000-0000-000000000001";

describe("legacy public-link API without migration 007", () => {
  test("creates the existing long bearer token without querying the compact-code column", async () => {
    const statements: string[] = [];
    let savedToken: string | null = null;
    const db = {
      from(table: string) {
        expect(table).toBe("events");
        return {
          select(fields: string) {
            statements.push(`select:${fields}`);
            expect(fields).not.toContain("public_share_code");
            return this;
          },
          update(values: Record<string, unknown>) {
            statements.push(`update:${Object.keys(values).join(",")}`);
            expect(values).not.toHaveProperty("public_share_code");
            savedToken = String(values.public_share_token);
            return this;
          },
          eq() { return this; },
          is() { return this; },
          async maybeSingle() {
            return { data: { public_share_token: savedToken }, error: null };
          },
        };
      },
    };
    const auth = new Elysia({ name: "legacy-share-test" }).resolve({ as: "scoped" }, () => ({
      user: { id: "owner-1" }, db,
    }));
    const app = new Elysia().use(createEventRoutes(auth as never));
    const response = await app.handle(new Request(`http://localhost/events/${eventId}/public-link`, {
      method: "POST",
    }));

    expect(response.status).toBe(200);
    const body = await response.json() as { enabled: boolean; token: string };
    expect(body.enabled).toBe(true);
    expect(body.token).toMatch(/^[a-f0-9]{64}$/);
    expect(statements).toContain("select:public_share_token");
    expect(statements).toContain("update:public_share_token");
  });
});
