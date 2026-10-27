import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const migration = readFileSync(new URL("../migrations/009_transaction_evidence.sql", import.meta.url), "utf8");

describe("transaction evidence migration", () => {
  test("adds evidence metadata without changing or deleting existing transaction rows", () => {
    expect(migration).toMatch(/create table public\.transaction_evidence/i);
    expect(migration).toMatch(/references public\.transactions\(id\) on delete cascade/i);
    expect(migration).toMatch(/enable row level security/i);
    expect(migration).toMatch(/auth\.uid\(\) = user_id/i);
    expect(migration).not.toMatch(/drop table|truncate|delete from public\.(events|transactions|participants)/i);
  });

  test("constrains evidence metadata to safe link or private-file records", () => {
    expect(migration).toMatch(/evidence_type in \('link', 'file'\)/i);
    expect(migration).toMatch(/link_url/);
    expect(migration).toMatch(/object_key/);
    expect(migration).toMatch(/content_type/);
    expect(migration).toMatch(/byte_size/);
  });
});
