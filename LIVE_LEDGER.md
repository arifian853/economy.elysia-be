Economy backend currency contract
================================

The versioned migration chain 001–010 now lives in this backend repository's
`migrations/` directory; see `migrations/README.md`. Migrations 001–009 were copied
verbatim from `/home/arifian/projects/economy/supabase/migrations/`, preserving
every filename and number. All nine copies were verified byte-identical with
SHA-256 and `cmp`; the source copies remain unchanged. The still-unapplied 010
was updated in place for the initial-budget contract below; no new migration
number was added. Every backend SQL test reads `../migrations/<same filename>`
relative to the test file,
so the tests no longer depend on a sibling checkout.

File presence does not establish production applied status. Before rollout,
independently check migration history and the actual schema. Migration 010
(`migrations/010_multi_currency_live_ledger.sql`) must follow the actual required
001–009 state, including 007 (compact aliases), 008 (budget movements), and 009
(private evidence). No live application state was inspected and no SQL was
executed against any database during this work.

The backend requires 010 before serving the new owner API. The public sanitizer
also accepts the old IDR projection during an ordered rollout.

Money travels in major units. There is no multiplication/division by 100 during
migration. Existing safe whole amounts remain JSON numbers; fractional amounts
and integers beyond JavaScript's safe range are canonical decimal strings.
Inputs accept numbers for existing clients, but clients should send decimal
strings for exact fractional or large values. Never parse these strings through
`Number` for arithmetic. For example, `"12.50"` becomes `"12.5"`, `100000` remains
`100000`, and `"9223372036854775807"` stays a string. Quantity remains an integer.
PostgREST reads cast numeric columns to text before JSON decoding. Numeric budget
RPCs and the public SQL projection also serialize money as text.

Currency precision comes from Bun/ICU's ISO currency metadata, with Economy's
existing whole-rupiah convention retained for IDR. JPY/KRW have zero digits,
SGD/USD have two, KWD has three, and CLF has four. Migration 010 embeds the same
registry and rejects excess precision instead of rounding amounts. Changing this
policy requires updating both the backend and migration registry. Budgets, unit
prices and budget deltas retain the old bigint major-unit magnitude bound.
Transaction totals and aggregate totals use exact decimal arithmetic.

Event creation accepts `currencyMode: "domestic" | "international"` and
`baseCurrency`, defaulting to domestic IDR for existing clients. Domestic events
reject any other base currency. International codes must appear in both the ISO
registry and the provider-supported currency list. Changes before the first
transaction must also leave the existing budget/allocation representable in the
new currency. `currencyLocked` persists after the first transaction, including
after deleting transactions. Database row locks serialize currency changes,
transaction insertion, and completion. Existing RLS/archive guards stay enabled.

Final Statement initial-budget contract:

- Owner event list/detail and mutation responses expose `initialBudget` and
  `initialBudgetKnown`. The anonymous allowlisted projection exposes the same
  fields under `event`, with the same exact money serialization as `budget`.
- Migration 010 adds `initial_budget numeric NOT NULL` and
  `initial_budget_known boolean NOT NULL`. Every legacy event, including completed
  events, receives its current budget as a safe numeric placeholder and
  `initial_budget_known=false`. Earlier budget edits may never have been audited;
  this placeholder is NOT the historical initial amount. Do not reconstruct an
  original by subtracting recorded adjustments from today's budget.
- New event inserts snapshot the submitted budget and set known=true. Both SQL
  and the API own these values; they are not editable request fields. The initial
  amount must be positive and satisfy the same currency precision, finite-number,
  and bigint major-unit magnitude rules as the event budget.
- Adjustments, reallocations, ordinary edits, FX-reference refreshes and
  completion preserve both snapshot fields. A legacy placeholder may therefore
  differ from today's budget while remaining unknown.
- An explicit change of base currency before any transaction keeps the current
  budget's same nominal amount in the new currency, without FX conversion, and
  establishes that amount as a known initial snapshot for the newly selected base
  currency. It does not recover the original in the prior currency. Existing
  budget and cash allocation must be representable in the new currency; a base
  change cannot simultaneously change the nominal total. Reasserting the same
  base or changing only currency mode preserves the existing snapshot and flag.
  Currency remains locked after the first transaction, even if all transactions
  are later deleted. Completed events cannot reset or edit the snapshot.
- When `initialBudgetKnown=false`, the Final Statement UI must say the original
  is unavailable (for example, "Original budget unavailable"); it must not display
  the placeholder as a historical initial amount. During ordered rollout, old
  public projections lacking both fields use the current budget only as an
  unknown placeholder. Malformed or partially supplied snapshot fields fail
  sanitization. No private adjustment reasons or other private data are added to
  public sharing.

Transaction POST/PATCH accept optional `currency` and `baseCurrency` assertions;
either must match the event. Omission means the selected event's base currency.
Responses retain existing fields and add `baseCurrency`, `fxRateToIdr`,
`fxRateDate`, `fxRateProvider`, and `idrEquivalent`. The stored snapshot is
immutable on edits; changing a price/quantity recomputes its IDR reference using
that snapshot. IDR uses rate `"1"`, provider `"identity"`, and a null observation
date because no market observation is involved. FX-derived IDR references round
half up to whole rupiah. Null snapshot fields mean reference unavailable.

`GET /api/fx/currencies` and `GET /api/fx/rate?base=SGD&quote=IDR&date=2026-10-23`
are anonymous reference-data endpoints. Dates are optional and cannot be future
or invalid calendar dates. Responses expose `rate` as a decimal string,
`rateDate`, `provider`, and `stale`. Frankfurter v2 uses its blended feed and is
attributed as `Frankfurter v2`, with the actual returned observation date. The
adapter follows the [official v2 contract](https://api.frankfurter.dev/v2/openapi.json).
It has a three-second request timeout. Rate cache capacity is 256 pairs/dates;
latest TTL is six hours, historical observations are retained until eviction,
and currencies cache for 24 hours. Concurrent requests are coalesced and bounded.
Expired observations can be returned on failure with their original date and
`stale: true`; a one-minute retry delay limits repeated failures for cached keys.
This cache is process-local and resets on restart.

FX never determines whether a valid expense can be recorded. A failed lookup
uses a cached observation or saves null metadata. Active owner detail reads
refresh the stored event reference; new transaction snapshots can advance it
atomically without replacing a newer stored observation. Completed events keep
their last stored reference and never fetch or write a new one. V1 does not
rewrite historical snapshots or automatically backfill null snapshots.

Public clients continue polling `GET /api/public/events` with
`X-Economy-Share-Token`, without owner credentials. Both existing long tokens and
007 compact aliases remain accepted. Existing owner clients continue creating
long tokens; 010 ensures clearing one also revokes any compact alias. The payload
keeps `event`, `budgetSummary`, and `entries`; safe metadata lives under `event`:
`status`, `updatedAt`, `currencyMode`, `baseCurrency`, `initialBudget`,
`initialBudgetKnown`, and event FX reference
fields. Expense entries add snapshot fields and `idrEquivalent`. The sanitizer
uses exact arithmetic to validate totals and initial-budget precision/size, and
derives the equivalent from the allowlisted snapshot. No owner IDs,
participants, notes, evidence paths, object
keys, or profile fields are projected. Ledger mutations, including deletion,
advance `event.updatedAt`. Responses remain no-store, noindex/nofollow, and
no-referrer. Frontend polling timing, visibility pausing, backoff, and statement
UI belong to the frontend implementation.

The assistant uses the same routes and currency rules with an injectable FX
service for tests. Its constant-time bearer comparison, fixed owner binding,
and loopback-only listeners remain intact. Private evidence and audited budget
movement routes remain mounted. No new dependency is required for this feature.

Verification without loading `.env` or connecting to Supabase:

```sh
SUPABASE_URL=https://example.supabase.co SUPABASE_ANON_KEY=test-anon-key bun --no-env-file test
tsc --noEmit -p tsconfig.json
bun --no-env-file build src/index.ts --target=bun --outdir=/tmp/economy-backend-build
git diff --check
```

TypeScript is not a declared dependency, so no `typecheck` script or dependency
change was added; the check above uses the available `tsc` executable.

Tests inject FX providers/fetch responses and mocked databases; they never call
live FX or a live database. Migration tests inspect SQL definitions, including
casts, backfill, guards, owner scoping, grants, alias revocation, and the public
allowlist. SQL execution, real PostgREST casts, concurrent database behavior, and
RLS integration still require a separate authorized database verification step.

Changed files for this implementation (excluding preserved baseline changes):

- `src/money.ts`, `src/fx.ts`, `src/event-currency.ts`, `src/public-projection.ts`
- `src/routes/events.ts`, `src/routes/transactions.ts`, `src/routes/public-events.ts`, `src/routes/fx.ts`
- `src/assistant-api.ts`, `src/index.ts`
- `src/routes/evidence.ts` (return-type annotation only, preserving the existing evidence implementation)
- `migrations/010_multi_currency_live_ledger.sql`
- `migrations/001_initial.sql` through `migrations/009_transaction_evidence.sql`
  (verbatim historical copies), `migrations/README.md`
- `test/archive-migration.test.ts`, `test/budget-channel-migration.test.ts`,
  `test/budget-movements-migration.test.ts`, `test/delete-completed-migration.test.ts`,
  `test/public-event-migration.test.ts`, `test/transaction-evidence-migration.test.ts`
  (migration read paths only)
- `test/money.test.ts`, `test/fx.test.ts`, `test/currency-routes.test.ts`, `test/public-currency.test.ts`, `test/public-events.test.ts`, `test/multi-currency-migration.test.ts`
- `test/budget-movement-routes.test.ts` (one added precision regression test)
- `package.json` (working test script, preserving existing dependency changes), `tsconfig.json`, `LIVE_LEDGER.md`

Reproducibility verification before the initial-budget change (2026-10-27): all
four commands above passed using the repository-local migration chain (87 tests,
24 files, 627 assertions).

Initial-budget verification (2026-10-27): all four commands above passed again
without loading `.env`, with the documented dummy Supabase environment for tests.
Bun reported 100 tests passed across 24 files, zero failures, and 737 assertions.
TypeScript `--noEmit` exited 0; the Bun server build bundled 613 modules to
`/tmp/economy-backend-build/index.js`; `git diff --check` exited 0. Added coverage
checks new known snapshots, legacy uncertainty, adjustment preservation,
pre-transaction nominal currency resets, persistent currency locks, public
privacy/precision and archived immutability. These are mocked API and SQL
definition checks; neither database SQL execution nor deployed schema correctness
is verified.

For each of migrations 001–009, SHA-256 matched the source and `cmp` exited 0:

```sh
for source in /home/arifian/projects/economy/supabase/migrations/00[1-9]_*.sql; do
  cmp "$source" "migrations/${source##*/}" || exit 1
done
```

No external migration paths remain in `test/`. Existing uncommitted work was
preserved. No secrets, live database, or systemd were accessed; no SQL was
applied; no reset, stash, discard, commit, push, or deployment was performed.
