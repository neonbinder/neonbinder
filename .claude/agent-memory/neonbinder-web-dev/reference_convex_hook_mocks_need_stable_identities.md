---
name: convex-hook-mocks-need-stable-identities
description: A vi.mock of convex/react whose useAction/useMutation returns a fresh vi.fn() per call loops effects (NEO-415); a useQuery mock returning a fresh object loops a screen that holds its last answer (NEO-495). Cache per ref and args.
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

The same holds for a mocked `useQuery` once a screen keeps "the last answer"
in state by identity (NEO-495 Team Management holds its list across an
argument change): a mock that builds `{ teams, truncated }` afresh on every
call reads as a new answer each render and React throws "Too many
re-renders". Cache the answer per arguments and per the fixture arrays it
was built from, so a test that swaps the fixture still gets a new object.
