---
name: playwright-click-checks-first-mouse-event-only
description: A reflow between mousedown and mouseup makes locator.click() succeed with no click on the control; do not draw a control before the read that can move it
metadata:
  type: reference
---

Playwright's hit-target interceptor tests the first mouse event only (`result === void 0` in `setupHitTargetInterceptor`). If the page reflows between mousedown and mouseup, `click()` reports success and the control's onClick never runs: the browser sends the click to a common ancestor. Verified on 1.63 in Chromium, desktop and Pixel 7 (`hasTouch` still sends `pointerType: "mouse"`). Real operators hit the same thing.

**How to spot it:** a click step that passes, then the next assert times out, on a screen with a live query that renders above the control. Line the click's start up with that query's last execution in `convex-logs-*`; a query ending milliseconds before the click is the collision. Read the logs before accepting a "sync finished" story: a `done` status row persists, so a notice on screen can come from a sync long before.

**Fix pattern:** do not draw a control before the read that can move it, so both arrive together in their final place. Rescuing the press on one control leaves its neighbours and finger taps exposed. A gate like this has a cost to check: a stalled read now hides the control, so make sure a stall backstop watches that read too. See [[agent-bash-node-ignores-nvmrc]] for running the gates on the pinned Node.
