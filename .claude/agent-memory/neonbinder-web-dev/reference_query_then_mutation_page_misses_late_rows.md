---
name: query-then-mutation-page-misses-late-rows
description: A bulk walk whose page is chosen by a query and written by a mutation (NEO-301 split) cannot see rows inserted between the two; the LAST page must re-read from its cursor or the walk ends on them (NEO-330 bulk skip)
metadata:
  type: reference
---

`runBulkDecidePage` picks ids in `listBulkCandidates` (a query, outside OCC)
and writes them in `decideRowsByIds`. A lookup that lands in between sees its
row still undecided, so `applyLookupResult` stages career-team/league rows at
the batch tail. They are not in the id list. A non-last page is fine (the next
query sees them past the cursor); the LAST page ended the walk with them open.
Fixed (NEO-330) by a skip-only re-query from the cursor after the write,
returning `hasMore: true` when anything undecided turned up.

**Diagnosis trap:** the first read of the bug was "staging ignores the skip
decision" — wrong, `applyLookupResult` already returns on any `row.decision`.
If the parent was decided at staging time nothing stages; so a staged row under
a skipped parent means the parent was UNDECIDED when the lookup landed. Look
for a window, not a missing guard.

**How to apply:** any new "choose in a query, write in a mutation" walk needs a
final re-check (or the mutation must read the parent's children itself, which
widens its OCC read set — the NEO-301 storm). Reproduce the window in
convex-test by passing `runBulkDecidePage` a fake ActionCtx whose `runQuery`
lands the lookup after the first query (entityReviewQueue.skipStaging.test.ts).
Related: [[action-blind-insert-is-invisible-to-occ]], [[occ-window-moves-to-a-query-behind-an-action]].
