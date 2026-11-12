---
name: route-only-one-of-two-concurrent-puts
description: When a save fires two uploads at once, force only one by its URL pathname and compare hosts as booleans so signed addresses are never printed
metadata:
  type: feedback
---

When a flow sends two requests side by side (copy photo: image and thumb PUTs to the store), a total PUT count is not deterministic. Route the store but force only the one under test: match `new URL(request.url()).pathname` against the object name (regex on the path), `route.fallback()` the rest, and count only the forced file.

**Why:** signed URLs carry credentials and the host carries an account id, so a failing `expect(a).not.toBe(b)` on hosts would print them into published artifacts.

**How to apply:** compare hosts in-test into booleans (`const same = a === b; expect(same, "msg").toBe(false)`), never put a URL or host in a message. Await a console line with `page.waitForEvent("console", { predicate })` started BEFORE the action (event-based, no `expect.poll`). Before moving `page.clock.fastForward`, await the other concurrent request's `requestfinished`, so the jump cannot cut a live request short. `page.clock.install()` alone runs time at the real pace, so a real-time stall case and a fastForward case can share one test.
