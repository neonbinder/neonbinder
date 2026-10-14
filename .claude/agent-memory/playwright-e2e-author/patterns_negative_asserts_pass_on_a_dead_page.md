---
name: negative-asserts-pass-on-a-dead-page
description: toBeHidden / toHaveCount(0) pass when the SPA has fallen to its error boundary — always pair one with a positive assertion
metadata:
  type: feedback
---

A negative assertion (`toBeHidden`, `toHaveCount(0)`, `not.toBeVisible`) is
satisfied by a page that has NOTHING on it. When a `useQuery` hits a Convex
function the deployment does not have, the SPA falls to its error boundary and
the whole page collapses to one message, `"An error occurred. Please refresh the
page."`, at which point every negative assertion in the spec passes trivially.

**Why:** measured 2026-09-02 on NEO-101's title spec against shared dev. Two
negative steps went green on a crashed page; only the positive assertion that
followed them caught it. Had the spec ended on the negatives it would have
reported a feature working that had never rendered.

**How to apply:** when a negative assertion is the SYNCHRONISER for an async
change (waiting for a value to be replaced, a badge to clear, a dialog to
close), immediately follow it with a POSITIVE assertion of what should now be on
screen: the state, not just the absence (GUIDE R2). The positive one is what
fails loudly. Never let a spec's last word be a negative.

**A branch guard is the same hazard, and it is worse.** `if (await x.isHidden())`
or an `.or()` whose fallback fires on absence does not merely pass, it routes the
spec down the WRONG BRANCH: on a dead page every "is it gone?" guard is true, so
a helper decided the sport did not exist and went looking for a control to
create it, and the reported failure named neither the crash nor the sport. When a
fallback fires for something that should obviously have been there, read the
failure screenshot first and suspect a dead page before touching the locator.
