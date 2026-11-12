---
name: vitest-spies-handle-returned-promises
description: A vi.fn mock's returned promise is observed by the spy (settledResults), so a mocked rejection is never "unhandled" and an unhandled-rejection test cannot go red
metadata:
  type: reference
---

vitest's spy attaches its own handlers to any promise a `vi.fn` returns (to fill
`mock.settledResults`). A test that says "no unhandled rejection when the prepared
promise fails" and drives the rejection through a mocked function stays green with the
guard (`p.catch(() => undefined)`) deleted. Checked by removing the guard (NEO-466).

**How to apply:** don't claim unhandled-rejection coverage from a mocked rejection.
Either make the rejecting promise outside a spy (a plain function the module calls) or
state that the guard rests on review. Before trusting any such test, delete the guard and
confirm it goes red ([[a-green-suite-can-mean-the-test-stopped-testing]]).
