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

Related: [[action-impl-stub-ctx-for-write-failures]], [[hold-runafter0-in-convex-test]].
