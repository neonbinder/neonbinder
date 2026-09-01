---
name: convex-write-budgets
description: Measured per-transaction limits that bound bulk-write Convex mutations in apps/web, and the two places this repo already works around them
metadata:
  type: reference
---

# Convex per-transaction budget, as this repo has actually hit it

Hard limits per query/mutation: **1s execution, 4,096 index ranges read, 32k
documents scanned, 16k documents written**, plus an unnamed **system-operation
time budget** that surfaces as `Your request timed out performing too many
system operations.` — that last one is what trips first on write-heavy loops,
and it is not documented as a number.

Two measured data points from `commitCardChecklist` (2026-09-01, PR #205
Convex preview, request `af06962bc3db7994`), at ~5-6 DB ops per card:

| cards | ops (approx) | result |
|---|---|---|
| 335 | ~1,800 | passes, near the wait budget |
| 712 | ~4,000 | **fails** with the system-operations timeout |

So the practical ceiling for a per-row write loop in one mutation is somewhere
under ~2,000 database operations. Size bulk work against that, not against the
documented 16k-writes figure — writes are not the binding constraint, the
system-operation clock is.

## The workaround this repo uses

Public **action** looping **internal mutations**, each its own transaction.
Two instances in `convex/selectorOptions.ts`:

- `resetSetBuilderData` → `reset*Batch` (the original, driven by the 4,096-read
  limit on `.collect()`)
- `commitCardChecklist` → `commitCardChecklistPrelude` / `...Chunk` /
  `...Finalize` (NEO-189; `CARDS_PER_COMMIT_CHUNK` is exported)

Cost of the pattern, worth stating before reaching for it: **atomicity is
gone.** Anything that deletes, or that needs the whole batch in view, has to
live in a single once-per-call phase, and the operation has to be re-runnable.

## Cheap wins before chunking

Both showed up in NEO-189 and are worth checking first:

- A per-row `ctx.db.get` inside a write loop is usually replaceable by one
  indexed `.collect()` into an id→doc map. Same rows, one system op.
- A `db.get` used only to read a name/label off a related row can often be
  resolved once, up front, in whatever pass already touched that row.

## Watch out: re-reading a table inside a chunk changes semantics

`commitCardChecklist` upserts by `cardNumber` against a snapshot taken *before*
the write loop, which is what lets a legitimately duplicate-numbered checklist
(BSC's 1996 Score Dugout Collection Artist's Proofs — Series 1 and 2 both
numbered #1-110) insert two rows. A chunk that re-read the table would see the
previous chunk's inserts and silently collapse them. Resolve the upsert target
once, outside the chunks, and pass it in. See
`convex/commitCardChecklist.duplicateNumbers.test.ts` and NEO-203.
