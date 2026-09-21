---
name: transient-side-table-checklist
description: Adding a table keyed on a selectorOptions id — the four places it must be wired (reset steps + toEqual test blocks, deleteSelectorOption sweep, holdings note, ops doc) or it dangles
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

**Why:** the reset and the delete sweep are the only two things that ever
remove rows from these tables; a table left out of either accumulates rows
pointing at deleted parents forever (the `playerAliases` / `teamAliases`
precedent, NEO-254/284).

**How to apply:** any plan that adds a side table keyed on `selectorOptions`
lists all four in its migration steps. Related: [[staging-tables-scope-per-operator]].
