---
name: transient-side-table-checklist
description: Adding a table keyed on a selectorOptions/cardChecklist id — the five places it must be wired (reset steps + toEqual test blocks, deleteSelectorOption sweep, holdings note, ops doc, subtree-wipe graph) or it dangles
metadata:
  type: project
---

A new table whose rows point at a `selectorOptions` row (candidates, skips,
status, aliases) is not done when the schema compiles. Four consumers must
learn about it, and only one of them fails loudly:

1. **`runSetBuilderReset` steps** (`selectorOptions.ts`, the `steps` array):
   add a `reset<Table>Batch` internalMutation (copy `resetPlayerAliasesBatch`:
   `assertResetArmed()`, `.take(RESET_BATCH_SIZE)`), a count key in
   `SetBuilderResetResult`, the `returns` validator of
   `resetSetBuilderDataFromCli`, and the initial `counts` object. Order rule
   from the leagues comment: drain the REFERENCING table before the table it
   points at, so an interrupted reset never leaves dangling pointers.
2. **`resetSetBuilderData.test.ts`** asserts the whole counts object with
   `toEqual` in FOUR places — a new key breaks all four. Budget for that.
3. **`deleteSelectorOption`'s transient sweep** (the loop over
   `selectorSyncStatus` / `entityReviewSkips` / `checklistCandidates`):
   rows keyed on the deleted row must be swept with `.take(TRANSIENT_DELETE_CAP)`,
   and the `collectSelectorOptionHoldings` comment that lists the "NOT
   holdings" tables must name it. `selectorOptions.deleteRow.test.ts` pins the
   sweep.
4. **`docs/operations/neo214-set-builder-admin-scripts.md`** prints the
   counts object as an example; `e2e-baseline.sh` parses only `complete`.
5. **`SUBTREE_REFERENCE_GRAPH`** in `wipeVariantTypeSubtree.ts`: its test
   parses schema.ts and fails for ANY table holding a `v.id("selectorOptions")`
   or `v.id("cardChecklist")` field (sport-level ones included) that the graph
   does not list. A sport-level table is a one-line "Untouched" entry; a table
   pointing at cards needs real wipe handling (delete with the card) and a
   `WIPED_TABLES` entry. This one DOES fail loudly — first red in NEO-313.

**Why:** the reset and the delete sweep are the only two things that ever
remove rows from these tables; a table left out of either accumulates rows
pointing at deleted parents forever (the `playerAliases` / `teamAliases`
precedent, NEO-254/284).

The checklist runs in REVERSE too. NEO-237's `setCandidates` table (SportLots
sets offered for review) was wired through all four on 2026-09-21 and removed
the same day, once Jason ruled a set a marketplace lists is saved, not
offered; the removal had to unwire the same four places, and the `toEqual`
count blocks were again what failed first.

**How to apply:** any plan that adds a side table keyed on `selectorOptions`
lists all five in its migration steps. Related: [[staging-tables-scope-per-operator]].

**NEO-358 (2026-10-23), two more places.**
- `apps/web/scripts/reference-seed/cli.mjs` `SELECTOR_DEPENDANT_TABLES`: any table that holds a `selectorOptions` id belongs here (`cli.test.mjs` checks it), so a reference-seed load knows what it would orphan.
- **Per-user tables** (keyed on the Clerk subject, e.g. collector copies) also join `resetMyTestState` in `convex/testing.ts`, not only the global drain. Keep them out of `REFERENCE_SEED_TABLES`.
See [[per-card-derived-state-hook-points]].
