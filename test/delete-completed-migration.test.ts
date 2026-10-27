import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const migration = readFileSync(new URL("../migrations/006_delete_completed_events.sql", import.meta.url), "utf8");

describe("completed-event deletion migration", () => {
  test("permits parent event deletion while preserving completed-row updates as immutable", () => {
    expect(migration).toMatch(/CREATE OR REPLACE FUNCTION public\.enforce_completed_event_archive/i);
    expect(migration).toMatch(/TG_OP\s*=\s*'DELETE'[\s\S]*?RETURN OLD/i);
    expect(migration).toMatch(/new_data IS DISTINCT FROM old_data/i);
    expect(migration).toMatch(/CREATE TRIGGER events_completed_archive_guard/i);
  });

  test("permits child deletes only during a cascading parent delete", () => {
    expect(migration).toMatch(/TG_OP\s*=\s*'DELETE'\s+AND\s+pg_trigger_depth\(\)\s*>\s*1[\s\S]*?RETURN OLD/i);
    expect(migration).toMatch(/target_status\s*=\s*'completed'[\s\S]*?RAISE EXCEPTION/i);
    expect(migration).toMatch(/transactions_completed_archive_guard/i);
    expect(migration).toMatch(/participants_completed_archive_guard/i);
  });
});
