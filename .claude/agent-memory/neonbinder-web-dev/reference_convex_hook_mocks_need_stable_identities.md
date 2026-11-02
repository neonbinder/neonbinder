---
name: convex-hook-mocks-need-stable-identities
description: A vi.mock of convex/react whose useAction/useMutation returns a fresh vi.fn() per call loops any useEffect that lists the bound function as a dependency (NEO-415 read policies 22 times); cache one bound fn per getFunctionName(ref).
metadata:
  type: reference
---

Real `useAction` / `useMutation` return a stable function for a stable
reference. A hand-built mock like `useAction: () => vi.fn(...)` hands back a
new function on every render, so an effect such as
`useEffect(() => { void readPolicies() }, [readPolicies, reads])` re-fires on
each render it causes: the test sees the action called dozens of times and
state that never settles, which reads like a product bug.

**How to apply:** in the mock, key bound functions by
`getFunctionName(ref)` (from `convex/server`) in a module-level `Map`, return
the cached one, and clear the map in `beforeEach`. Assert call counts after
that, never before. Related: [[component-tests-hand-build-the-api-mock]].
