---
name: scheduled-telemetry-unmasks-cross-test-leaks
description: Moving recordAdapterCall's PostHog capture from awaited runAction to scheduler.runAfter(0) made events land after the action returns and let a prior test's floating capture land in the next test; drain + scope by requestId
metadata:
  type: reference
---

Since NEO-315 `recordAdapterCall` (convex/observability.ts) SCHEDULES
`internal.posthog.captureEvent` instead of awaiting it, and schedules nothing at
all when `POSTHOG_API_KEY` is unset (the capture would be a no-op).

Two test consequences that are not obvious from the diff:

1. **convex-test captures arrive late.** An assertion on FakePostHog
   `captureCalls` right after `t.action(...)` sees nothing; call
   `drainScheduled(t)` (lib/testing/drain-scheduled.ts) first. A stub
   `ActionCtx` needs `scheduler.runAfter` (and `auth`), and the test must set
   `POSTHOG_API_KEY` or nothing is scheduled.
2. **The old awaited hop was masking a leak.** `recordAdapterPhase` fires a
   FLOATING `runAction` capture. While `recordAdapterCall` awaited its own
   capture, that kept the action open long enough for the floating one to land
   inside the same test. Without it, test N's breadcrumb lands after test N+1's
   `captureCalls.length = 0`, so a count assertion in N+1 reads 2. Scope
   telemetry assertions by the test's own `requestId`, never by event name alone.

**How to apply:** when changing anything that awaits or stops awaiting work in
an adapter path, re-run adapterPhase.test.ts and observability.test.ts, and in
new telemetry tests filter on requestId and drain before asserting. Related:
[[convex-test-needs-the-modules-arg]], [[action-impl-stub-ctx-for-write-failures]].
