---
name: convex-test-same-ms-stamps
description: Two convex-test mutations in a row often stamp the same Date.now() ms, so a "later write is strictly newer" assertion (gt range on a stamp index) flakes; await a ~3 ms real setTimeout between them
metadata:
  type: reference
---

convex-test runs mutations back to back in well under a millisecond, so two
writes that each stamp `Date.now()` (e.g. `collectionCopies.filedAt`) usually
share one value. A test that reads "news since the first stamp" with a strict
`.gt("filedAt", stamp)` index range then sees nothing, or sees the wrong line.

**How to apply:** between writes whose stamps must differ, `await new Promise((r) => setTimeout(r, 3))`
(a real timer; no network, so the guard is fine). Prefer this to fake timers in
a file that doesn't already use them: convex-test clamps `_creationTime`
against the real clock ([[convex-test-creationtime-fake-timer-clamp]]).
Pin unchanged stamps with `toBe(stamp)` on a `ctx.db.get` of the row rather
than through the query, so the assertion can't pass vacuously.
