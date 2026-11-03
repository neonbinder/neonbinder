---
name: sync-status-step-ledger-waits
description: NEO-415 - wait on a live marketplace Sync one ledger step at a time (7 s each) with syncRun/underWay/followRunToEnd; stale-ledger gate, throttled press, optional photo step
metadata:
  type: pattern
---

Sync status ticks a run's steps off as list items named `<label>, <state>` (state done|working|waiting|failed) in a list `Sync steps for <set> on <platform>` (Running now) that becomes `Last sync steps for <set> on <platform>` on the set row once the run ends. Never both at once for the same set. Helpers: `syncRun`, `followRunToEnd` in `support/collection.ts`.

- **Stale ledger.** The row keeps the PREVIOUS run's finished steps (all done) until the next run claims the set, so a per-step `done` wait alone passes on the old run. Gate first on `run.underWay(resultLine)` = the running list `.or()` the new run's own distinct result line (`0 listed...` vs the old `2 listed`).
- **Step lookup spans both lists** (`running.or(last)`), so it passes whether the spec looks mid-run or after the end, with no race on the run's end.
- **Labels come from the code**, not from guesswork: BSC modern reads are one per BSC sheet named by the NB conditions that fold into it (Mint and Near Mint / Excellent / Very Good and Good / Poor); the confirm's condition is the account's default condition, so match `Double-check .+`.
- **A Sync press inside 60 s of the last press is throttled** (`RESYNC_THROTTLE_MS`): the queued box write still runs the set, but it reads only the sheets NB pushed to. A take-down run therefore asserts "a read, the send, a confirm", not all four reads.
- **eBay's photo step is optional** (a rerun can reuse the last run's pictures): wait on `Upload photos` `.or()` `List the cards` `.first()`, then hard-assert the items, offers, go-live steps.
- A done step is stamped when the NEXT step starts (the last one at finish), so the last step and the result line land together.
- The running-ledger state cannot be axe-checked deterministically (a fast run may be over before the spec looks); the finished row ledger can, so assert it before the existing axe call.
- **A finished BSC row folds** (Jason, 2026-11-02): reads become one `Gathering data, <state>` item, `Double-check` items are dropped (a failed one stays), update steps (`Upload photos`, `Send changes to ...`) stay; eBay rows are unchanged. A bare `step("Read ...")` would hang if the run ended before the spec looked, so BSC reads and confirms are waited on through `readLanded` / `confirmLanded` (the running item OR the folded row). After the run, assert the folded shape and that no Read/Double-check item remains (paired with a positive assert).
