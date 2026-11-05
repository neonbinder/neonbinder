---
name: unstub-globals-before-real-timers
description: a vitest stubGlobal of setTimeout made after useFakeTimers must be undone first, or the fake clock stays installed and the network guard's afterAll hook times out
metadata:
  type: reference
---

`vi.stubGlobal("setTimeout", ...)` taken after `vi.useFakeTimers(...)` saves the
FAKE as the value to restore. Running `vi.useRealTimers()` then
`vi.unstubAllGlobals()` puts the fake back for good, and the suite fails with
"Hook timed out in 10000ms" at `vitest.setup.network-guard.ts`, which names no
test and looks like a leak.

**How to apply:** in `afterEach`, `vi.unstubAllGlobals()` first, then
`vi.useRealTimers()`. Prefer an injected pause where the code can take one
([[adapter-retry-pause-is-injected]]).
