---
name: adapter-retry-pause-is-injected
description: An adapter's retry wait is an optional `pause` parameter threaded through DrainOptions (like fetchPhoto); drain tests pass an instant counting pause; fake only setTimeout to prove the default
metadata:
  type: reference
---

When an adapter call retries after a pause (eBay `publishOffer`'s one busy
retry, NEO-415), make the wait an optional last parameter
(`pause: (ms) => Promise<void> = realPause`) and thread it through
`DrainOptions` beside `fetchPhoto`, rather than faking timers in convex-test
drain suites (their fakes already use `setTimeout` gates, and a global fake
clock stalls them).

**How to apply:**
- Drain test file: a module-level `pause` that records `ms` and returns at
  once, reset in `beforeEach`, passed as `drainOwnerImpl(..., { fetchPhoto,
  pause: (ms) => pause(ms) })` so one test can swap in a held pause (e.g.
  wait until another publish has halted the pool, to prove a retry in its
  pause still counts as in flight).
- Prove the real default once in the adapter test with
  `vi.useFakeTimers({ toFake: ["setTimeout"] })` and
  `advanceTimersByTimeAsync(PAUSE - 1)` / `(1)`; `AbortSignal.timeout` in
  `send` is not faked by that list, so fetch timeouts are unaffected.
- Retry above `send`, not inside it: `send` already owns the 401 refresh
  (shared `reauthOnce`) and the dead-session short-circuit, so a retried
  `send` inherits both and a signed-out result (kind `signed_out`) is never
  mistaken for busy. Classify busy on `kind === "http"` and status, so
  unreadable bodies (`bad_response`), timeouts and network errors stay
  unretried.
- An existing test that fed one 5xx and expected the run to stop must feed
  the 5xx for every call to that offer once a retry exists, or it goes green
  for the wrong reason (the retry succeeds through the fake).

- No seam to inject through (a pause inside an `internalAction` tested with
  `t.action`, args fixed by its validator): in `beforeEach`,
  `vi.spyOn(globalThis, "setTimeout")`, shorten only calls whose delay equals
  the exported pause constant, and pass every other delay to the real timer.
  convex-test keeps running, the pause is still asserted, and recording a
  counter inside the spy proves where it fell between calls.

- An in-action pause in a suite that already runs `vi.useFakeTimers()` and
  calls `t.action(...)` directly (not via `finishAllScheduledFunctions`) hangs
  the action at the 5 s test timeout: nothing advances the fake clock while
  `t.action` is awaited. `vi.useFakeTimers({ shouldAdvanceTime: true })` lets
  a sub-second pause elapse in real time while minute-scale `runAfter` passes
  still wait for `runAllTimers` (NEO-475 card-listing retry,
  bscTeamEnrichmentQueue NEO-330 block). A jittered pause has no exact delay
  to match, so a setTimeout spy keyed on the pause RANGE must not overlap
  another delay in the path (BSC_TEAM_ENRICH_DELAY_MS is 300, inside 250-500).
- A retry SCHEDULE (several pauses, e.g. `readSheets`' 503 list, NEO-475):
  export the list, key the setTimeout spy on `list.includes(ms)`, and record
  `[ms, readsSoFar]` so one assertion pins both the lengths and where each
  fell. Test the shared-schedule bound (a 503 on two sheets spends it) and
  that a second call (the read-back) starts its own.
- The seller adapter's failure sentences are asserted outside the adapter
  tests too (order poll `lastPollError` in listingSales.test.ts, cleanup
  error text): grep the whole convex/ tree before changing the copy.
- Adding a retry changes every "asked N times" count downstream (queue passes
  x attempts); a "succeeds on a later pass" test must fail every attempt of
  the first pass or it goes green through the in-action retry.

Related: [[action-impl-stub-ctx-for-write-failures]], [[hold-runafter0-in-convex-test]].
