---
name: reference-new-pool-enqueue-breaks-convex-test
description: A mutation that starts enqueueing on a new workpool fails every convex-test through it with Component not registered; spy on the pool instance
metadata:
  type: reference
---

convex-test cannot mount a workpool component, so once a mutation calls `pool.enqueueAction`, every test that reaches that mutation throws `Component "<pool>" is not registered`, including tests that never think about the pool. One enqueue line can turn most of a test file red.

**How to apply:** `vi.spyOn(pool, "enqueueAction").mockResolvedValue("work" as never)` in that file's `beforeEach`, and have the test run the enqueued action itself. Grep the test files for callers of the mutation before adding the enqueue.
