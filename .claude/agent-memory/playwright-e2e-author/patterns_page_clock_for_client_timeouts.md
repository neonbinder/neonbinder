---
name: patterns-page-clock-for-client-timeouts
description: How page.clock proves a client-side timeout (a held request cut off by an AbortController timer) in this suite; install-before-signIn works, fastForward not runFor, bound waits by event
metadata:
  type: patterns
---

First `page.clock` use in the suite (NEO-431, stalled photo upload, Playwright 1.63):

- `await page.clock.install()` with no options, BEFORE `signIn(...)`, leaves Clerk, Convex and the harness sign-in working: after install time still flows at the real pace; install only swaps the page's timers for ones the test can push. No `pauseAt`.
- `page.clock.fastForward(ms)` jumps and fires each due timer once. That is what a "cut off after N s" proof needs; `runFor` would replay every Convex/Clerk tick in between. A single ~22 s jump, and three of them in one test (about 66 s of fake time), left the Convex socket and the session fine; the later UI steps and the self-clean still ran inside 7 s.
- Hold a request by returning a never-resolving promise from the `page.route` handler (no `fulfill`, no `abort`); `unroute` at the end does not wait for it.
- Never await a bare promise for "the retry arrived": test timeout is 20 min, so a broken product would hang. Use `page.waitForRequest(...)` or `page.waitForEvent("console", ...)`, which take the 7 s `actionTimeout` default; start it BEFORE the action that causes it, and do not read a route-handler counter right after the event (the handler runs after the request event).
- Size the jump from the window formula but assert the held body is small (`postDataBuffer().length`) so one fixed jump clears the window. Overshoot is harmless: the retry backoff timers are set after the abort and run in real time.
- A planted break that removes the abort signal goes red at the FIRST held step (the give-up step), so to prove a later step (recover after a held try) can fail, temporarily cut the earlier step out of a scratch copy, then restore both files with `cmp`. A failed run leaves the copy marked Have: run the `bootstrap` project before the next green run.
- Slow part is not the clock: `expectAccessible` (light + dark) inside a held window costs real seconds, so it fits only while the window is 20 s.
