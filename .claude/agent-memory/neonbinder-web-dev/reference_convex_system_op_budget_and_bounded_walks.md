---
name: reference-convex-system-op-budget-and-bounded-walks
description: Measured Convex per-transaction operation thresholds in this repo (~900 comfortable, ~1800 straining, ~4000 fails), that a workpool COMPONENT call costs ~3 invisibly, the house shape for bounding a whole-batch mutation (cursor walk with SEPARATE scan and work bounds), and what to do instead when no caller can drive the loop
metadata:
  type: reference
---

Two independent NeonBinder incidents produced the same Convex error —
`timed out performing too many system operations` — and the same fix shape.
Calibration, from `CARDS_PER_COMMIT_CHUNK`'s comment in `convex/selectorOptions.ts`
and NEO-294's entity-review failure:

- **~900 operations per transaction is comfortable** (the number both chunk
  sizes are built to hit).
- **~1800 strains** (335 cards × ~5.5 ops passed, but sat near its timeout).
- **~4000 fails** (712 cards × ~5.5 ops).

Count operations per row before picking a size: each indexed read, each
`db.get`, each insert/patch/delete, AND each `ctx.scheduler.runAfter` is one.
A loop body that calls a helper (ambiguity check, staging, era resolution) is
usually 5–10x more expensive than it looks — NEO-294's per-player cost was ~28.

**A COMPONENT call inside a mutation is 2-3 operations, and invisible at the
call site.** `pool.cancel(ctx, workId)` / `pool.enqueueAction(...)`
(`@convex-dev/workpool`) are component MUTATIONS running in the caller's own
transaction, not scheduler hops: they read and write the component's tables
before returning. A loop over "every in-flight row" that calls one per row is
the same defect as a loop of `db.patch`, costing triple, and nothing in the
line `await pool.cancel(...)` says so. Count them at 3 when sizing a page.

**The house bounding shape** (`selectorOptions` reset batches,
`commitCardChecklist` chunks, `entityReviewQueue.decideAllRemaining`):
a public function does ONE bounded page, returns `{ <count>, hasMore, cursor }`,
and the CLIENT (or an action) re-calls with the cursor until `hasMore` is false.
Each page commits on its own, so partial progress is durable and an interrupted
run is finished by re-invoking — provided the write is idempotent per row (skip
a row that already carries the outcome). See
[[reference_convex_one_paginate_per_function]] for why the cursor is a
`_creationTime` `.take()` walk rather than `.paginate()`.

**Use TWO bounds when scanning and working cost different amounts.** A single
small page makes a *re-pass* over a mostly-finished batch cost one call per
page — and re-passes are normal (a reactive UI re-walks as background work
lands). Bounding "rows read" (large) separately from "rows acted on" (small)
turned a 754-row re-pass from 31 calls into 4. The cursor must then be the last
row EXAMINED, not the last row of the page, or the rows a spent work-budget
left unread are skipped forever.

**When there is NO looping caller, the mutation schedules ITSELF.** Several of
the worst offenders are reached from a caller you do not own (an action in
another module, a component that awaits the mutation once), so the
`{ hasMore, cursor }` shape has nobody to drive it. The working substitute:
write one bounded page, then `ctx.scheduler.runAfter(0, <this same function>,
<args>)` for the rest, and keep the public return shape unchanged. Two things
make it safe:

- **Prefer convergence over a cursor.** If re-invoking with the SAME arguments
  reaches the same end state (a reconciliation that suppresses what already
  exists, a delete that re-reads from the head), the continuation needs no
  state at all and an interrupted chain is finished by the operator's next
  ordinary action. Only pass an index/cursor when the work is a plain walk over
  an array the caller re-passes.
- **Tag the continuation with the id of the thing it continues.** A link
  landing after the batch was cancelled, committed or superseded will otherwise
  take the *create* branch and resurrect what the operator just disposed of —
  a wizard that reopens itself, or rows of a dead batch beside the live one.
  Cheapest guard: the continuation carries `continueBatchId` and abandons when
  the current open batch is absent or different (no extra read; decide on the
  lookup the handler already does).

A scheduled page is invisible downstream only if nothing reads the whole set
synchronously. Check the consumers first: in `apps/web` the auto-keep checklist
path already polls `getReadyCandidates` until `total` matches the action's own
count, so it tolerates a chained write — but a sibling mutation that patches
rows by id (`resolveCandidateTeams`) had to gain ONE delayed retry, because a
row it cannot find is silently skipped.

**A PER-ITEM budget is not a transaction bound; compose the two by ENDING THE
PAGE.** A budget charged per name/row/item (8 team reads per name) is often
chosen on purpose — it keeps an item's ANSWER independent of its position, which
a shared counter cannot do. But per-item × page-size can blow past the ~1800
band, so a transaction total has to join it. What the total does when it is
reached is the whole design: do NOT let the remaining items fall back to a
degraded answer, because that is exactly the position-dependence the per-item
budget removed, and the boundary then moves with the page size. Instead stop the
walk, roll the loop counter back so the resume cursor points AT the undecided
item, and let `hasMore` carry it. Every item reached was evaluated whole; every
item deferred is re-evaluated from a fresh cache in the next transaction and
answers identically. Livelock guard (the `sweepAbandonedBatches` `rows > 0`
equivalent): the first item of a page must always get its full allowance — a
fresh per-transaction counter at zero with a floor of 1 gives that structurally
— so a page can never end where it started.
