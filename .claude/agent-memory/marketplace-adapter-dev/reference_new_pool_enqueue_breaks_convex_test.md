---
name: reference-new-pool-enqueue-breaks-convex-test
description: A mutation that enqueues on a workpool fails convex-test with Component not registered; spy on the pool, run the lane by hand through the real onComplete; scheduled enqueues fail silently
metadata:
  type: reference
---

convex-test cannot mount a workpool component, so once a mutation calls `pool.enqueueAction`, every test that reaches that mutation throws `Component "<pool>" is not registered`, including tests that never think about the pool. One enqueue line can turn most of a test file red.

**How to apply:** `vi.spyOn(pool, "enqueueAction").mockResolvedValue("work" as never)` in that file's `beforeEach`, and have the test run the enqueued action itself. Grep the test files for callers of the mutation before adding the enqueue.

**Driving a ladder through the pool by hand:** when the retry policy lives in the pool's `defineOnComplete`, capture each `enqueueAction` call (args plus `options.runAt`) into a list, then loop: sort by `runAt`, `vi.setSystemTime(runAt)` (fake timers with `shouldAdvanceTime` so the item's own pause elapses), run the item action, and call the onComplete mutation with `{ workId, context: args, result: { kind: "success", returnValue } }`. The real completion then re-enqueues or gives up, so the old "asked N times, then flagged" assertions still hold. `lib/testing/bsc-team-lane.ts` is the house copy.

**Silent pass trap:** when the enqueue is reached through a SCHEDULED mutation (`runAfter(0, enqueue…)`), the unregistered component fails inside the scheduled function and the test stays green with no work done, so "fetch never called" assertions pass vacuously. Capture the lane in those describes too.
