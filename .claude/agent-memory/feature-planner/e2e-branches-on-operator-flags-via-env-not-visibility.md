---
name: e2e-branches-on-operator-flags-via-env-not-visibility
description: when a Maestro flow must branch on an operator switch (a Convex env var), pass the state as a runner `-e` variable and branch with `runFlow: when: true:`; never branch on `when: visible:` of the notice (7 s poll per run, R10)
metadata:
  type: feedback
---

A flow that has to behave differently under an operator switch learns the
state from a Maestro `-e` variable the runner scripts pass (the same way
`APP_URL` / `WORKER_INDEX` / `ATTEMPT_ID` travel), computed once in a util
into `output.*`, and branches with `runFlow: when: { true: "${...}" }`.
Both branches end in hard asserts so a mismatch between the runner's value
and the deployment's real state fails loudly (R2).

**Why:** Maestro cannot read Convex env. Branching on the visible notice
instead (`when: visible:` / `notVisible:`) polls the optional-lookup
timeout on every run in the common (not-paused) case, which is exactly the
dead wait R10 forbids; and a flow that silently takes the "not shown" path
is R2 fall-through.

**How to apply:** CI sets the deployment's env var and the Maestro variable
from ONE GitHub Actions repository variable in the same job, so they cannot
disagree; local runs export the same name before `test:e2e:pick`.
