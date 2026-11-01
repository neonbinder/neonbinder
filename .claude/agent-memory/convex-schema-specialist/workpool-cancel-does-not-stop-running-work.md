---
name: workpool-cancel-does-not-stop-running-work
description: "@convex-dev/workpool cancel on a RUNNING item only blocks retries; the attempt finishes, holds its slot, and its real result (or 'canceled' if it ended retryably) still reaches onComplete — a row reused across generations needs a generation guard"
metadata:
  type: project
---

Verified against @convex-dev/workpool 0.4.12 source (`component/loop.ts`
`handleCancelation` / `handleCompletions` / `rescheduleJob`, `complete.ts`):

- `pool.cancel(workId)` sets `work.canceled` and deletes a PENDING start only.
  A running action is not interrupted; it keeps its maxParallelism slot until
  it returns.
- When it returns: success or non-retryable failure → onComplete gets the REAL
  result. Retryable failure → `rescheduleJob` refuses (canceled) → onComplete
  gets `{kind:"canceled"}`. Either way it arrives later, possibly minutes later.
- onComplete args include `workId` as well as `context`.

**Why it matters:** placeholder settle identifies a row by `{jobId, imageId}`
context only. Anything that resets a row in place and re-enqueues it (zip
restart, NEO-411 Try again) can be settled by the PREVIOUS generation's late
completion once the new generation reaches the same tier — a "canceled"
landing on a fresh attempt. Tier/escalation stale checks don't see it.

**How to apply:** when a plan cancels work and then lets the same row be
re-enqueued, require a generation guard: compare onComplete's `workId` to the
row's stored `workId` (works when the enqueue patches workId in the same
mutation), or carry a generation number in the context (optional field so
queued items still validate) and in any scheduled deadline's args. Ask for a
test that drives the old completion after the reset.

Related: [[project-neo170-placeholder-batch-schema]].
