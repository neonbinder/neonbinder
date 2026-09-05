---
name: negative-asserts-pass-on-a-dead-page
description: assertNotVisible / extendedWaitUntil-notVisible both pass when the SPA has fallen to its error boundary — always follow one with a positive assertion
metadata:
  type: feedback
---

A `notVisible` assertion is satisfied by a page that has NOTHING on it. When a
`useQuery` hits a Convex function the deployment does not have, the SPA falls to
its error boundary and the whole hierarchy collapses to one node,
`"An error occurred. Please refresh the page."` — at which point every
`assertNotVisible` in the flow passes trivially.

**Why:** measured 2026-09-02 on NEO-101's title flow against shared dev. Two
`notVisible` steps went green on a crashed page; only the `assertVisible` that
followed them caught it. Had the flow ended on the negatives it would have
reported a feature working that had never rendered.

**How to apply:** when a `notVisible` is the SYNCHRONISER for an async change
(waiting for a value to be replaced, a badge to clear, a dialog to close),
immediately follow it with a POSITIVE assertion of what should now be on
screen — the state, not just the absence. Order matters: the positive one is
what fails loudly. The same rule applies to a flow's final steps: never let a
flow's last word be a negative.

**A `when: notVisible:` GUARD is the same hazard, and it is worse** — it does
not merely pass, it routes the flow down the WRONG BRANCH. Observed 2026-09-04:
`util-drill-to-custom` taps the sport, then guards its fallback with
`when: notVisible: "Years"` + `when: notVisible: <SPORT>`. On a page that had
just fallen to its error boundary BOTH guards were satisfied, so the util
decided the sport did not exist and went looking for `Add custom Sports` — and
the reported failure was `No visible element found: id: Add custom Sports`,
which names neither the crash nor the sport. When a `when:`-guarded fallback
fires for something that should obviously have been there, screenshot first and
suspect a dead page before touching the selector.
