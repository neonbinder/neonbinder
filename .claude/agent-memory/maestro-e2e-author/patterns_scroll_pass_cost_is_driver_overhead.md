---
name: scroll-pass-cost-is-driver-overhead
description: A scrollUntilVisible pass costs ~2.0s (mid-scroll) / ~1.4s (found) on maestro-web on ANY page, because every executeJS sleeps 100ms and re-injects maestro-web.js. Page size barely matters, so a slow scroll means distance (count the 312px swipes), not DOM size.
metadata:
  type: reference
---

Measured on NEO-330 (cli 2.8.0; the same code is in 2.6.0 and on Maestro `main` as of 2026-10).

**Where the time goes.** `CdpWebDriver.executeJS` runs on every JS call: `listTargets()` over HTTP, then a NEW websocket `evaluate` of the 14 KB `maestro-web.js`, one per injected arg, an unconditional `Thread.sleep(100)`, and then the real `evaluate`. A hierarchy read is `getWindowHandles` + that executeJS + `getCurrentUrl`, and costs **~0.33 s on any page**. Across ~6,300 immediate `assertVisible`s per CI run, the floor is 0.32–0.33 s, on every page and in every run.

**One pass of `scrollUntilVisible`:**
- `deviceInfo`: 2 executeJS, ~0.21 s. It is the gap between `ElementNotFound` and `Swiping UP from center` in maestro.log.
- the swipe: 2 executeJS (`isFlutterApp`, then `window.scroll({behavior:'smooth'})`), ~0.2 s.
- `waitForAppToSettle`: reads until two in a row are equal, with a 200 ms sleep between them. A smooth scroll that is still moving costs 3+ reads.
- find: the first pass polls for 500 ms (~3 reads, ~1.2 s). Later passes get `max(0, 500 - sinceLastCommand)` = 0, so one read.

The result is **~2.0 s per pass that still has to scroll, and ~1.4 s for the pass that finds the target**. About 1 s of each mid-scroll pass is literal sleep. One swipe is `innerHeight/2` = **312 px** at 625 px. So 900 px costs 1.2 + 2×2.0 + 1.4 ≈ 6.7 s, whatever the page.

**Page size is a small term.** Static pages (local probe), whole 4-swipe scroll:

| Rows | Time |
|---|---|
| 1 | 8.47 s |
| 500 | 8.77 s |
| 2,000 | 9.58 s |

Per read on those pages: 0.35 / 0.35 / 0.40 s. On the real app the effect is a little larger: an immediate assert reads 0.49 s on unfiltered `/admin/players` (500 rows) and 0.64 s on `/admin/teams` (2,000 rows).

**How to apply.**
- To explain a slow scroll, count the `Swiping` lines and multiply by ~2 s before suspecting the app.
- Don't propose list virtualisation for a scroll whose list is already filtered. Both NEO-313 player flows type a token before opening the panel, so the master list is 1 row.
- The levers are fewer swipes (a target nearer the top, or not centring a bottom-locked target, R8 case 2), or a tool fix. Never a timeout.

Related: [[maestro-web-driver-primitives]] §4, [[below-the-fold-asserts-and-bottom-locked-scrolls]].
