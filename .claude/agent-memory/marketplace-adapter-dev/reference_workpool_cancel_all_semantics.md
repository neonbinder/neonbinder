---
name: workpool-cancel-all-semantics
description: "@convex-dev/workpool 0.4.x cancelAll: pending and runAt items reach onComplete as canceled; a RUNNING item finishes with its real result, so an onComplete that re-enqueues escapes the cancel"
metadata:
  type: reference
---

Read from `dist/component/{lib,loop,complete}.js` in 0.4.15:

- `cancelAll` pages the `work` table by `_creationTime <= now` (64 a page,
  self-scheduling for the rest) and inserts `pendingCancelation` rows.
- An item still in `pendingStart` (not started, including a future `runAt`)
  is removed and its onComplete gets `{ kind: "canceled" }`.
- An item already RUNNING is only marked not-to-retry; it finishes and its
  onComplete gets its real success/failed result. If that onComplete
  re-enqueues, the new item was created after the cancel's cut-off and is NOT
  cancelled.

**Why:** a lane whose onComplete re-enqueues (the BSC team lane's ladder) can
survive a cancelAll by one item.

**How to apply:** make the work item itself end cheaply when its subject is
gone (read the row first, before any cooldown or network step), and treat
`canceled` in onComplete as done: no retry, no operator hand-off. In
convex-test the component cannot be mounted: spy `pool.cancelAll` /
`pool.enqueueAction` ([[new-pool-enqueue-breaks-convex-test]],
[[workpool-retry-semantics]]).
