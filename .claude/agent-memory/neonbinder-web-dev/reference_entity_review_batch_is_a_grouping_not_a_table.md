---
name: entity-review-batch-is-a-grouping-not-a-table
description: There is no entityReviewQueue "batches" table — a batch is a (selectorOptionId, batchId) grouping inside the queue; and the two staging tables' reaper crons use DIFFERENT thresholds (24h vs 1h)
metadata:
  type: reference
---

Two things a plan about the entity-review staging tables routinely gets wrong.

**1. "The batch rows" do not exist as rows.** `entityReviewQueue` is the only
table; a *batch* is the `(selectorOptionId, batchId)` grouping within it, read
through `by_selector_option_and_batch`. So draining the table drains every
batch, a row costs exactly ONE delete, and there is no per-batch surcharge to
budget for. A task worded "drain the queue rows and its batch rows" is asking
for one table, not two. `schema.ts`'s table list is the check — it is long, so
grep `^  [a-zA-Z]*: defineTable` rather than scrolling.

**2. The two reaper crons are not the same threshold**, even though both are
registered hourly next to each other in `crons.ts` and the comments there
describe them as matching:

- `entityReviewQueue` → `ENTITY_REVIEW_ABANDONED_MS`, **24 hours** of silence
  (deleting a batch destroys an operator's recorded decisions, so it errs
  long). This is the one that accumulates across a working day.
- `checklistCandidates` → `CANDIDATE_STALE_MS`, **one hour** past
  `lastUpdated`. It does not stack across a day, but it is very much live
  during a run and between two runs close together, at ~900 rows per set.

Both feed ONE number: `collectSelectorOptionHoldings` adds
`checklistCandidates` + `entityReviewQueue` into a single `review` holding,
which is the "<N> checklist reviews are in progress here — finish or cancel
them first" refusal on a row delete. So a diagnosis that reads that number
cannot attribute it to either table without querying them separately.

**How to apply:** when sizing or scheduling work over these tables, count one
operation per queue row and look up the actual constant rather than trusting
the neighbouring cron's comment. Related: [[reference_convex_system_op_budget_and_bounded_walks]],
[[reference_review_batch_rows_the_batch_stages_itself]].
