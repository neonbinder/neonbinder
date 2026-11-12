---
name: long-admin-lists-freeze-whole-dom-scanners
description: A 2,000-row admin master list (~20k DOM nodes) costs any whole-DOM pass seconds (axe 10 s, one 6 s block); a huge Vercel-toolbar INP on such a screen is DOM size, not the handler. Measure with a scripted Playwright + PerformanceObserver run.
metadata:
  type: reference
---

Measured on /admin/teams (NEO-495, dev build, seeded per-worktree deployment):
the "All leagues" view renders 2,000 rows = ~20,500 DOM nodes. The select's
own change handler cost 24-104 ms in every path (keyboard type-ahead, headed
mouse + native popup, with Sentry Replay running). But `axe.run` over that DOM
took ~10 s with one uninterrupted 6.2 s long task; over a 120-row view, 0.3 s
with no long task. The Vercel toolbar's Accessibility Audit runs axe on page
load by default, so a pick made in the first seconds after load waits on it.

Two more traps when reading an INP report on a `<select>`:
- Chrome on macOS gives the select's `mouseup` an Event Timing duration equal
  to the time the native popup stayed open (1 s open -> 1064 ms), with
  `interactionId` 0. A tool that does not filter on `interactionId` reports
  reading time as INP.
- Type-ahead on a closed select keeps a ~1 s buffer: a script typing "MLB"
  then "All" inside a second searches "MLBAll". Wait 1.2 s between picks.

**How to apply:** when a list screen "freezes", count its DOM nodes before
reading handler code; script the interaction with Playwright (trusted keyboard
input, `PerformanceObserver` for `event` + `longtask`/`long-animation-frame`,
CDP `Profiler` for self time) and time `axe.run` on each state. The fix is
fewer rendered rows (smaller window, server-scoped filter), not a faster
handler. Related: [[convex-hook-mocks-need-stable-identities]].
