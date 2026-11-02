---
name: hold-runafter0-in-convex-test
description: How to inspect a runAfter(0) network action (a drain) in convex-test without it running; fake setTimeout, hand-run sibling walks, cancel before restoring timers
metadata:
  type: reference
---

convex-test starts a scheduled function on a real `setTimeout`, so a
`runAfter(0)` action (a listing drain) runs before the test can read its
`_scheduled_functions` row, and `drainScheduled` runs it too (reaching the
network guard or consuming the rows under test).

- Hold it: `vi.useFakeTimers({ toFake: ["setTimeout"] })` before the kick.
  The row stays `pending`, inspectable.
- Other `runAfter(0)` work you DO need (a paged walk that ends by kicking the
  drain): find its pending row, `ctx.scheduler.cancel` it, and call the
  internal mutation by hand with `row.args[0]`, looping until none is left.
- Teardown order matters: `cancelScheduled` FIRST, then `vi.useRealTimers()`,
  then `drainScheduled`. Draining while a held job is pending waits on a timer
  that never fires.
- A "no drain was scheduled" assertion must count rows in ANY state; a
  pending-only filter goes green after the drain already ran.
- Add a `vi.mock("./credentials")` that answers no token as a safety net, so a
  drain that does run stops before any BSC call.

Related: [[convex-test-ids-fail-real-id-codecs]], [[scheduled-telemetry-unmasks-cross-test-leaks]].
