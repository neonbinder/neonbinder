---
name: happy-dom-has-no-window-confirm
description: happy-dom leaves window.confirm undefined, so vi.spyOn(window, "confirm") throws; define it per test. Also: adding useConvex to the collection store breaks every convex/react mock that lacks it.
metadata:
  type: reference
---

`window.confirm` does not exist in the `components` (happy-dom) project, so
`vi.spyOn(window, "confirm")` fails with "can only spy on a function. Received
undefined". Put one in place per test instead:
`Object.defineProperty(window, "confirm", { value: vi.fn(() => false), configurable: true, writable: true })`.
`window.history.go` does exist and can be spied (NEO-370 `useLeaveGuard`).

Related: when a hook used by the real collection store (`convexStore.ts`) starts
calling a new `convex/react` export (NEO-370 added `useConvex`), every test
that hand-builds that mock goes red at render, not just the new feature's:
`convexStore.test.tsx` (89 tests) and `AppModeDemo.test.tsx`. Grep
`vi.mock("convex/react"` for files that render the real store and add the
export there. See [[reference_component_tests_hand_build_the_api_mock]].
