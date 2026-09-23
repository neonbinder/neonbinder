---
name: pure-router-rows-carry-nb-value
description: A pure router taking (marketplace entries + NB row index) must route EXISTING rows by the row's own value; check every rung for which name it reads
metadata:
  type: reference
---

When a pure planning function in `convex/selectorSync*.ts` takes both a list of
marketplace entries and an index of NB rows (holders), each rung of its ladder
reads a *different* name, and the index shape is what makes the mistake
invisible:

- an index entry carrying only ids (`rowId`, `parentId`) leaves the entry's
  marketplace label as the only string in scope, so the "existing row" rung
  silently routes on it. It type-checks and the happy-path tests pass, because
  in the normal case the NB name was derived from that same label.
- the failure only shows once an operator renames the row: the marketplace
  keeps returning the old name and the sync moves NB data on it — invariant 3
  and 4, silently.

Rule: give the index entry the row's own `value` as a REQUIRED field, route
existing rows by it, and keep the marketplace's name for rows NB has no row
for (creation-time derivation, invariant 2a). When reviewing such a function,
read each rung and ask which of the two names it consults.

Related: [[product-bug-tests-are-fix-requests]]
