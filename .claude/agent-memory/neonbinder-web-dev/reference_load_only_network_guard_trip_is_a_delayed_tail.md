---
name: load-only-network-guard-trip-is-a-delayed-tail
description: A NEO-188 guard trip that fails only in the full parallel suite and passes in isolation is usually a self-rescheduling DELAYED scheduled tail that drainScheduled cannot reach — not machine load
metadata:
  type: reference
---

When `npm run test:unit` fails with `NEO-188: N real outbound request(s)
attempted during this file, after its tests finished` but the same file passes
3/3 in isolation, check for a **self-rescheduling delayed** scheduled function
BEFORE concluding it is load or flake.

**The mechanism.** `finishAllScheduledFunctions` (what `drainScheduled` calls)
can only force work whose scheduled time has already passed. A queue that pops
one item and reschedules its tail behind a real delay therefore *survives the
drain*. The tail then outlives `afterEach`'s `vi.unstubAllGlobals()`, which
swaps the file's own throwing fetch stub back for the global network guard, and
fires against the guard. Whether the timer lands before the file ends is a
function of how loaded the run is — hence green alone, red in a full suite.

Concrete instance (2026-09-06, neo-246): `firstCommit.cardCount.test.ts`
enqueued 335 cards, and `processBscTeamEnrichmentQueue` reschedules its tail
behind `BSC_TEAM_ENRICH_DELAY_MS` (300ms, `convex/adapters/buysportscards.ts`).
The file already had both a drain and a throwing stub, which is exactly why it
looked like a flake.

**How to apply:**

- Grep the scheduled function for `runAfter(<non-zero>` / a `*_DELAY_MS`
  constant. If found, the fix is the documented pair
  `await drainScheduled(t); await cancelScheduled(t);` — the same pair
  `commitCardChecklist.chunking.test.ts` and `diffChecklistAgainstExisting.test.ts`
  already use. `drain-scheduled.ts` spells out why cancel is the honest call
  when a delay makes settling impossible.
- This is a rival explanation to [[full-suite-reruns-exhaust-memory]], which
  pushes toward blaming load, and to
  [[teardown-leak-attribution]], which warns the reported file may not be the
  culprit. Distinguish them by the delay grep, which is cheap and decisive —
  do that before running the suite again.
- A *printed* `Component "X" is not registered` line is a different thing and
  is not this: see [[convex-components-unregistered-in-convex-test]]. Those do
  not fail a run, and draining to remove them makes things worse.
