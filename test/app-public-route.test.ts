import { describe, expect, test } from "bun:test";

process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_ANON_KEY = "test-anon-key";
const { app } = await import("../src/index");

describe("public route mounting", () => {
  test("reaches the anonymous public handler before the auth middleware", async () => {
    const response = await app.handle(new Request("http://localhost/api/public/events"));
    const body = await response.text();

    expect(response.status).toBe(404);
    expect(body).toContain("Catatan tidak tersedia.");
  });
});
