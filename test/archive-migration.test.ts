import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const migration = readFileSync(new URL("../migrations/005_event_archives.sql", import.meta.url), "utf8");

describe("event archive migration", () => {
  test("records a completion timestamp and backfills existing completed events", () => {
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS completed_at timestamptz/i);
    expect(migration).toMatch(/WHERE status\s*=\s*'completed'/i);
    expect(migration).toMatch(/completed_at IS NOT NULL/i);
  });

  test("locks completed event data and deletion while allowing public-link changes", () => {
    expect(migration).toMatch(/enforce_completed_event_archive/i);
    expect(migration).toMatch(/public_share_token/i);
    expect(migration).toMatch(/TG_OP\s*=\s*'DELETE'/i);
    expect(migration).toMatch(/status\s*=\s*'completed'/i);
  });

  test("serializes child writes against completion for transactions and participants", () => {
    expect(migration).toMatch(/FOR UPDATE/i);
    expect(migration).toMatch(/transactions.*BEFORE INSERT OR UPDATE OR DELETE/is);
    expect(migration).toMatch(/participants.*BEFORE INSERT OR UPDATE OR DELETE/is);
  });
});
