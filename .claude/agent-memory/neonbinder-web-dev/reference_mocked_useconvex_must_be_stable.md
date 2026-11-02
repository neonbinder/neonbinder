---
name: mocked-useconvex-must-be-stable
description: A component test that mocks useConvex as `() => ({ query })` loops forever once the page reads on demand in an effect keyed on the client — every test times out at 5s
metadata:
  type: reference
---

A read-once-on-demand page (`useConvex().query` in a `useEffect` with `convex`
in its deps, the NEO-392 alternative to a heavy `useQuery`) re-runs the effect
whenever the client identity changes. The real client is stable; a test mock
written as `useConvex: () => ({ query: ... })` returns a NEW object per render,
so read → setState → render → new client → read… and every test in the file
times out at 5000ms with no assertion error.

**How to apply:** put the fake client in `vi.hoisted` (`mocks.client`) and
return that same object from `useConvex`. Route by function ref inside its
`query`. Also: `react-hooks/set-state-in-effect` flags an effect that calls a
`useCallback` which sets state, even after an `await`; inline the
`convex.query(...).then(setX)` in the effect and drive Refresh with a `tick`
state in the deps.
