---
name: reference_bulk_walk_gap_strands_late_staged_steps
description: The entity-review bulk walk picks its page in a query and writes in a mutation; a lookup landing in that gap stages a step the last page never sees — sweep by_source_* inside the write
metadata:
  type: reference
---

`recordAllRemainingAs*` is query (`listBulkCandidates`) then mutation
(`decideRowsByIds`), per NEO-301. A row's lookup that lands between the two
finds the row still undecided, so `applyLookupResult` settles it AND stages a
career-team / league step at the batch tail. Mid-walk that is harmless (later
pages scan the tail by `_creationTime`), but on the LAST page nothing re-reads
it: the step is left the only undecided row and Confirm & Save never shows
("Skip remaining names" stuck on "New Team: X — Needed by: <skipped player>",
NEO-341 CI).

Fixed in NEO-341 for skip: `skipStagedStepsOf` reads `by_source_player` /
`by_source_team` keyed on each settled skipped row inside the same mutation
(serializable, so either the step is visible or the lookup later sees the
decision and stages nothing). Pending rows need no read: only a lookup landing
stages, and it settles the row in the same transaction.

**How to apply:** any new "act on a page chosen by a query" path over
`entityReviewQueue` must ask what a concurrent `applyLookupResult` can insert
between the read and the write. The bulkReadSet test's Proxy pins which
indexes the write may read; a new own-id index read must be added there.
Related: [[reference_occ_window_moves_to_a_query_behind_an_action]].
