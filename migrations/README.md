# Backend migration chain

This directory contains the versioned SQL chain 001–010 used by the backend and
its SQL definition tests. Migrations 001–009 were copied verbatim from
`/home/arifian/projects/economy/supabase/migrations/`, preserving their numbering
and filenames; all nine copies were verified byte-identical with SHA-256 and
`cmp`. Tests read `../migrations/<filename>` relative to their test files, so they
do not require the sibling Supabase checkout.

Migration 010 is still unapplied and is updated in place; no migration 011 was
added. In addition to currency/FX support, it adds `initial_budget numeric` and
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
original as unavailable when known=false. See `../LIVE_LEDGER.md` for the full
contract and offline verification commands.

These files do not establish any database's applied migration status. Before
rollout, independently check the target database's migration history and actual
schema. Migration 010 must follow the actual required 001–009 state, including
007 compact aliases, 008 budget movements, and 009 private evidence. No SQL was
applied and no live database was inspected during this work. SQL tests only
inspect repository-local definitions; they do not verify SQL execution or the
correctness of an actual database schema.
