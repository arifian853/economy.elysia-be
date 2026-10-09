import { describe, expect, test } from "bun:test";

const compactMigration = await Bun.file(
  new URL("../../supabase/migrations/007_compact_public_share_codes.sql", import.meta.url),
).text();
const compactFunction = compactMigration.split("as $function$")[1]?.split("$function$")[0]?.toLowerCase() ?? "";

describe("compact public share code migration", () => {
  test("adds a unique optional code and keeps the old token valid", () => {
    expect(compactMigration).toMatch(/add column if not exists public_share_code text/i);
    expect(compactMigration).toMatch(/create unique index[\s\S]*public_share_code[\s\S]*is not null/i);
    expect(compactFunction).toMatch(/e\.public_share_token\s*=\s*p_token\s+or\s+e\.public_share_code\s*=\s*p_token/i);
    expect(compactMigration).toMatch(/public_share_token', 'public_share_code', 'updated_at/i);
    expect(compactMigration).toMatch(/revoke all on function[\s\S]*from public/i);
    expect(compactMigration).toMatch(/grant execute on function[\s\S]*to anon, authenticated/i);
  });
});

const migration = await Bun.file(
  new URL("../../supabase/migrations/003_public_event_sharing.sql", import.meta.url),
).text();
const functionBody = migration.split("as $function$")[1]?.split("$function$")[0]?.toLowerCase() ?? "";

describe("public event sharing migration", () => {
  test("keeps sharing off by default and exposes only a token-protected RPC", () => {
    expect(migration).toMatch(/add column if not exists public_share_token text/i);
    expect(migration).toMatch(/create unique index[\s\S]*public_share_token[\s\S]*is not null/i);
    expect(migration).toMatch(/security definer/i);
    expect(migration).toMatch(/set search_path\s*=\s*''/i);
    expect(migration).toMatch(/where e\.public_share_token\s*=\s*p_token/i);
    expect(migration).toMatch(/revoke all on function[\s\S]*from public/i);
    expect(migration).toMatch(/grant execute on function[\s\S]*to anon, authenticated/i);
  });

  test("returns only event context and public financial entry fields", () => {
    expect(functionBody).toContain("'event'");
    expect(functionBody).toContain("'eventdate'");
    expect(functionBody).toContain("'entries'");
    expect(functionBody).toContain("'type'");
    expect(functionBody).toContain("'name'");
    expect(functionBody).toContain("'amount'");
    expect(functionBody).toContain("'transactionat'");
    for (const privateField of ["participants", "payment_method", "'note'", "'budget'", "'user_id'"]) {
      expect(functionBody).not.toContain(privateField);
    }
  });
});
