import { describe, expect, test } from "bun:test";

process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_ANON_KEY = "test-anon-key";
const { app } = await import("../src/index");

describe("event API route tree", () => {
  test("event and transaction subresource routes compile together", async () => {
    const response = await app.handle(
      new Request("http://localhost/api/events/00000000-0000-0000-0000-000000000001"),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
  });
});
