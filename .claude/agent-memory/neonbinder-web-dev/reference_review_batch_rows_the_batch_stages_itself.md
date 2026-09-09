---
name: review-batch-rows-the-batch-stages-itself
description: A row the review batch stages for itself (entityReviewQueue.source) is invisible to the incoming name list, so startBatch's resume reconciliation deletes it — and any read inside applyLookupResult must be indexed, never a collect
metadata:
  type: reference
---

Two traps that bite anything adding a row to `entityReviewQueue` that did NOT
come from the checklist's `playerNames`/`teamNames` — NEO-236's staged career
teams are the first, and the shape will recur.

**1. `startBatch`'s resume path deletes it.** Reconciliation drops any existing
row whose key is not in the incoming set and that carries no decision. A row the
batch raised itself is never in that set and never can be, so every "Back to
matching" → Confirm round trip silently deleted the staged steps, leaving the
player that needed them with chips reading "needs a team decision" and no step
anywhere to answer. Nothing re-stages it either: the enrichment that staged it
has already landed, and the wizard's belt-and-braces pass fires once per row per
session. The guard is `row.source === undefined` on the drop test.

**2. A read inside `applyLookupResult` must be an INDEX read.** That mutation is
called once per row, five at a time, by the Wikidata pool — while the commit
prelude may be reading the same batch. A `.collect()` there puts every row of
the batch into each of those mutations' read sets, which is exactly the
optimistic-concurrency storm NEO-189 diagnosed ("Documents read from or written
to the entityReviewQueue table changed while this mutation was being run and on
every subsequent retry"). NEO-236 added `nameNormalized` + the
`by_batch_and_kind_and_name` index for precisely this: dedupe by key, one narrow
range per question.

**How to apply:** adding any self-staged row to a review batch means (a) marking
it with `source` and exempting it from reconciliation's drop test, and (b)
asking "does this batch already hold this?" through the index, never by
collecting. Related: [[workpool-oncomplete-inline-batched]],
[[convex-components-unregistered-in-convex-test]].
