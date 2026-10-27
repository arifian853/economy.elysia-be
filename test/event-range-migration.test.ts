import { describe, expect, test } from "bun:test";

const migration = await Bun.file(new URL("../migrations/011_public_participants_and_event_range.sql", import.meta.url)).text();

describe("public participants and event range migration", () => {
  test("backfills a required non-reversed range and retains archive immutability", () => {
    expect(migration).toMatch(/add column if not exists event_end_date date/i);
    expect(migration).toMatch(/set event_end_date\s*=\s*event_date/i);
    expect(migration).toMatch(/alter column event_end_date set not null/i);
    expect(migration).toMatch(/event_end_date\s*>=\s*event_date/i);
    expect(migration).toMatch(/alter table public\.events disable trigger events_completed_archive_guard/i);
    expect(migration).toMatch(/alter table public\.events disable trigger events_currency_guard/i);
    expect(migration).toMatch(/alter table public\.events enable trigger events_completed_archive_guard/i);
    expect(migration).toMatch(/alter table public\.events enable trigger events_currency_guard/i);
    expect(migration).toMatch(/enforce_completed_event_archive/i);
  });

  test("public RPC returns participant names only with constrained range and preserves protection", () => {
    const body = migration.toLowerCase();
    expect(body).toMatch(/security definer[\s\S]*set search_path\s*=\s*''/i);
    expect(body).toContain("'eventenddate'");
    expect(body).toContain("'participants'");
    expect(body).toMatch(/btrim\(p\.name\)/i);
    expect(body).toMatch(/order by[\s\S]*limit 100/i);
    expect(body).toMatch(/public_share_token\s*=\s*p_token[\s\S]*public_share_code\s*=\s*p_token/i);
    expect(body).toMatch(/revoke all on function[\s\S]*from public/i);
    expect(body).toMatch(/grant execute on function[\s\S]*to anon, authenticated/i);
    expect(body).not.toMatch(/'email'|'user_id'|'ownerid'|'private_notes'/i);
  });
});
