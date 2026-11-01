---
name: patterns-neo411-retry-generation-and-dispatcher
description: per-row retry needs an attempt generation (scheduled deadlines and late pool completions key on row id alone); workpool cancel does not stop a running action; undici timeouts 0 safe only with a per-call AbortSignal; npm audit an exact-pinned undici
metadata:
  type: project
---

Rule: when a diff lets a terminal row go back to "working" (a Try again / retry door),
every asynchronous thing still aimed at that row's PREVIOUS attempt must be fenced by an
attempt generation, not by row id + status.

**Why:** two leftovers survive a retry. (1) A scheduled timer (a deadline scheduled with
`{imageId}` only) fires on the new attempt and kills it early. (2) @convex-dev/workpool
`cancel` only removes `pendingStart`; a RUNNING action keeps running (paid) and its
completion is still delivered to onComplete, where a settle keyed on imageId + tier accepts it
once the retried row reaches the same tier again.

**How to apply:** for any retry/reset door, list the timers and in-flight work items aimed at
the row; require a generation (`retries`, a start stamp) in the scheduled args and the work
item `context`, and a test of "old attempt's timer/completion lands after retry -> no-op".
Check the cap counter is persisted and incremented in the same mutation as the status flip.

Related:
- `new Agent({ headersTimeout: 0, bodyTimeout: 0 })` as fetch `dispatcher` is fine only while
  every caller passes `AbortSignal.timeout` (it bounds the body read too, and abort destroys the
  socket). Grep every use of the dispatcher for `signal:`.
- A transitive package promoted to a direct exact pin: run `npm audit --json` and read the
  ranges; an exact pin stops it drifting with the parents' caret range, so the pin must be at
  the latest patch of that major. Keep undici on the major the Convex Node runtime's fetch uses.
- Appending `err.cause.code` to error text is log-safe (fixed identifiers), but
  `classifyAdapterError`'s substring match moves UND_ERR_*TIMEOUT from `network` to `timeout`.

See [[patterns-neo299-shared-pool-warmups]], [[patterns-neo170-workpool-pipeline]].
