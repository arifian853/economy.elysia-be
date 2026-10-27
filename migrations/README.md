# Backend migration chain

This directory contains the versioned SQL chain 001–011 used by the backend and
its SQL definition tests. Migrations 001–009 were copied verbatim from
`/home/arifian/projects/economy/supabase/migrations/`, preserving their numbering
and filenames; all nine copies were verified byte-identical with SHA-256 and
`cmp`. Tests read `../migrations/<filename>` relative to their test files, so they
do not require the sibling Supabase checkout.

Migration 010 adds currency/FX support, `initial_budget numeric` and
`initial_budget_known boolean`, both non-null after backfill. Legacy events
(including completed archives) receive the current budget as a numeric placeholder
with known=false. Pre-migration budget edits may not have been recorded, so this
value must never be claimed as the historical original or reconstructed from
partial adjustment history.

New inserts snapshot the submitted budget with known=true. Adjustments and
reallocations leave both fields untouched. The only later reset is an explicit
base-currency change before any transaction: it preserves the current nominal
budget in the newly selected currency and establishes its known initial snapshot.
Reasserting the same currency or changing only mode preserves the snapshot.
Initial amounts obey the event currency's precision and size limits; completed
events retain their archive protection. The owner and allowlisted anonymous
projections expose `initialBudget` and `initialBudgetKnown`; clients show the
original as unavailable when known=false. Migration 011 adds inclusive
`event_end_date`, backfills it from `event_date`, and enforces a non-reversed
non-null range. It also replaces the canonical 010 public RPC projection to add
the date range and up to 100 deterministically ordered, trimmed participant
display names only. Participant IDs and metadata remain private. Its archive
guard remains the 005/007 guard: completed range data is not exempted, while
share token/code and `updated_at` remain the only allowed event-row differences.
See `../LIVE_LEDGER.md` for the ledger contract.

These files do not establish any database's applied migration status. Before
rollout, independently check the target database's migration history and actual
schema. Migration 010 must follow the actual required 001–009 state, including
007 compact aliases, 008 budget movements, and 009 private evidence; 011 must
follow 010. No SQL was applied and no live database was inspected during this work. SQL tests only
inspect repository-local definitions; they do not verify SQL execution or the
correctness of an actual database schema.
