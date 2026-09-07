---
name: reference_neo247_bsc_multicard_reschedule_needs_cancel
description: commitCardChecklist's BSC team-enrichment queue self-reschedules with a REAL 300ms delay once 2+ cards need lookup — drainScheduled alone cannot settle it; cancelScheduled is required too.
metadata:
  type: reference
---

`convex/adapters/buysportscards.ts`'s `processBscTeamEnrichmentQueue` (scheduled
by `commitCardChecklistFinalize` in `convex/selectorOptions.ts` whenever a
committed card carries `platformData.bsc` and no resolvable team) processes
ONE card via `runAfter(0)`, then — **only if more than one id was enqueued in
the same commit** — reschedules itself for the tail via
`ctx.scheduler.runAfter(BSC_TEAM_ENRICH_DELAY_MS /* 300ms */, ...)`. That is a
REAL delay, not `runAfter(0)`.

`drainScheduled(t)` (`lib/testing/drain-scheduled.ts`) is
`t.finishAllScheduledFunctions(() => {})` — a no-op timer. It settles the
FIRST hop fine, but cannot force through a function whose scheduled time is
still in the future, so the delayed tail is left pending. It then fires later
in real wall-clock time, often during a LATER, unrelated test's window,
tripping the NEO-188 network guard there and getting misattributed.

**Fix:** any test whose single `commitCardChecklist` call commits 2+ cards
that all carry a `platformData.bsc` ref with no resolvable team must call
BOTH, in order, right after the commit:

```ts
await drainScheduled(t);
await cancelScheduled(t);
```

A single-card commit only ever needs `drainScheduled` — the reschedule branch
is gated on `tail.length > 0`.

This was found independently by multiple parallel sub-agents fixing separate
files during NEO-247 (`commitCardChecklist.chunking.test.ts`,
`commitCardChecklist.resync.test.ts`, `commitCardChecklist.operatorDecisions.test.ts`,
`diffChecklistAgainstExisting.test.ts`, `skuWiring.test.ts`), so treat it as an
established pattern, not a one-off. See [[reference_neo247_network_guard_timing_blind_spot]].
