---
name: leave-hook-survives-strictmode
description: An "on leave" side effect (flush, save) in an effect cleanup fires on React StrictMode's dev double mount; defer it with a zero-delay timer keyed on the view id and cancel it when the same id mounts straight back
metadata:
  type: reference
---

`src/main.tsx` renders under `<StrictMode>`, so dev mounts every effect, runs
its cleanup, then mounts again. A cleanup that calls the server ("send my
changes as I leave") fires on open in dev, and Playwright runs against a dev
build, so a spec can see the leave-time write happen early.

Pattern (NEO-370 `useFlushOnLeave` in the inventory listing panel): the
cleanup schedules `setTimeout(leave, 0)` and records `{ viewId, timer }` in a
ref; the mount effect clears that timer when the recorded id equals its own.
Refs survive StrictMode's simulated unmount; a real switch to another id does
not cancel. Keep the once-per-leave flag as a closure local per effect run,
not a shared ref, or the old view's deferred leave marks the new one as left.

Test it with a `strict` option on the render helper and a
`act(() => new Promise(r => setTimeout(r, 0)))` wait. Remove the cancel and
confirm the StrictMode test goes red.

Related: Playwright's `toBeEnabled()` honours `aria-disabled="true"`, so
moving a control from native `disabled` to aria-disabled keeps such specs
meaningful.
