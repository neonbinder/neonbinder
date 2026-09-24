---
name: store-loops-fall-through-to-insert
description: Both selector-sync store loops treat any planSelectorSync outcome that is not "withheld" or "matched" as an INSERT, so a new MatchOutcome kind silently creates rows until each store gets its own branch
metadata:
  type: reference
---

`storeSelectorOptions` (selectorOptions.ts) and `storeReconciledOptions`
(setReconciliation.ts) walk `plan.outcomes` as: `if withheld → continue`,
`if matched → refresh + continue`, then the fresh-insert code with no guard.
There is no exhaustive switch, so adding a kind to `MatchOutcome` in
selectorSyncMatch.ts type-checks cleanly and turns every item with that
outcome into a NEW ROW — the exact duplicate the new kind was usually added
to prevent.

**How to apply:** when you add an outcome kind, add an explicit
`if (outcome.kind === "<new>") { …; continue; }` in BOTH store loops before
the insert code, and write a through-the-mutation test (not only a pure
`planSelectorSync` test) that would go red if the branch were missing. The
two stores are the only consumers today (`grep planSelectorSync`).

Related: NEO-300's `heldElsewhere` (row already elsewhere in the variant
type's subtree) is the first kind added this way. See also
[[convex-op-budget-count-writes-not-items]] for the budget the subtree walk
is charged against, and [[a-green-suite-can-mean-the-test-stopped-testing]].
