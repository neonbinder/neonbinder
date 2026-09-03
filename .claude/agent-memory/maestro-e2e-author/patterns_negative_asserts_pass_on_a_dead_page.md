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
