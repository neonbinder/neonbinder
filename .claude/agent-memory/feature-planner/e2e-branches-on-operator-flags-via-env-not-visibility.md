---
name: e2e-branches-on-operator-flags-via-env-not-visibility
description: when a Playwright spec must branch on an operator switch (a Convex env var), read the flag from the suite's env (env.SL_PAUSED, derived from PAUSED_PLATFORMS) and branch with a plain if; never branch on the visible notice (a poll per run, R10), and end both branches in hard asserts
metadata:
  type: feedback
---

A spec that has to behave differently under an operator switch learns the state
from the suite's env (`support/env.ts`: `env.SL_PAUSED` is derived from the
`PAUSED_PLATFORMS` process variable; unset reads as not paused), and branches with
a plain `if (env.SL_PAUSED) { ... } else { ... }`. Both branches end in hard asserts so a
mismatch between the runner's value and the deployment's real state fails loudly (R2).

**Why:** the test process cannot read Convex env. Branching on the visible notice
instead (`isVisible()` / an `.or()` on the notice) either polls on every run in the
common (not-paused) case or silently takes the "not shown" path, which is R2
fall-through.

**How to apply:** CI sets the deployment's env var and `PAUSED_PLATFORMS` from ONE GitHub
Actions repository variable in the same job, so they cannot disagree; local runs export
the same name. See GUIDE "Operator switches".
