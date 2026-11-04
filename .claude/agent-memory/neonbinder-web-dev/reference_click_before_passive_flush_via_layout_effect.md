---
name: click-before-passive-flush-via-layout-effect
description: To test "a click beat a pending passive effect", click the real button from a child's useLayoutEffect; the effect's write then queues after the handler's, even under act
metadata:
  type: reference
---

A commit in a non-sync lane leaves its passive effects pending, and a click can
land before they flush. React flushes them ahead of rendering the click
(`performSyncWorkOnRoot` starts with `flushPendingEffects`), so an effect's
`setState` queues AFTER the handler's and wins. Convex results take this path:
`useQuery` reads through `useSubscription`, a plain `useState` write, not
`useSyncExternalStore`, so it is not a sync lane.

**How to apply:** a test cannot time the scheduler, but a child with a
`useLayoutEffect` that calls `button.click()` runs inside that commit, DOM
updated and passive effects unflushed. Pass it through a slot prop, arm a flag,
then `rerender` inside `act`. It reproduced a real red from NEO-417 and went red
on the old code. Prove it bites by reverting the fix.

A functional updater only fixes a stale closure. It does not help when the
effect's own logic is what closes the state (a reset-on-prop-change effect sees
the press's "custom" and closes it); that needs the reset moved out of a passive
effect.

Related: [[reference-rerender-same-element-bails-out]].
