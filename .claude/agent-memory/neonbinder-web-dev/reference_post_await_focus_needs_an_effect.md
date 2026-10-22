---
name: reference-post-await-focus-needs-an-effect
description: Focusing a control that a post-await setState renders must happen in an effect (armed by a ref flag), never setTimeout/rAF — React renders it on its own scheduler task, the timer can win in Chrome, unit tests never see it; how to make a test fail on the timer
metadata:
  type: reference
---

State set after an `await` (outside a React event) is DefaultLane: React renders it on a
Scheduler task, not synchronously. A `setTimeout(…, 0)` or `requestAnimationFrame` focus
queued beside it can fire BEFORE that commit in Chrome, find the ref null, and move focus
nowhere. Component tests with an already-rejected mock usually commit first, so they pass;
NEO-339's PlayerPicker / NewTeamDialog "Use …" focus went red only in CI Playwright
(`toBeFocused` received "inactive").

**Pattern:** a `useRef(false)` flag armed in the async branch, plus
`useEffect(() => { if (!flag.current || list.length === 0) return; flag.current = false; ref.current?.focus(); }, [list])`.
Declare it after any other focus effect that may run in the same commit (NewTeamDialog's
hold-focus-on-Create `[creating]` effect).

**A test that fails on the timer version:** mock the mutation with a deferred promise, click,
then `vi.useFakeTimers({ toFake: ["setTimeout","clearTimeout","requestAnimationFrame","cancelAnimationFrame"] })`,
reject, flush ~20 `await Promise.resolve()`, assert the new UI is NOT yet in the DOM (proves the
window), `vi.runOnlyPendingTimers()`, `vi.useRealTimers()`, then `findBy…` + `waitFor` focus.
React's Scheduler captured the real `setImmediate` at load, so faking timers later does not stall it.

**Gotcha:** PlayerPicker's open-time autofocus is itself a `setTimeout`; a test that opens and
creates in one tick leaves it pending, and it lands after the effect and steals focus to the
search box. Wait for the search box to be focused before typing (a browser always has).

Related: [[reference-router-navigation-is-a-transition]], [[reference-ref-cleanup-sees-focus-before-removal]].
