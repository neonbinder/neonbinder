---
name: reference-convex-system-op-budget-and-bounded-walks
description: Measured Convex per-transaction operation thresholds in this repo (~900 comfortable, ~1800 straining, ~4000 fails) and the house shape for bounding a whole-batch mutation — a client-driven cursor walk with SEPARATE scan and decide bounds
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
