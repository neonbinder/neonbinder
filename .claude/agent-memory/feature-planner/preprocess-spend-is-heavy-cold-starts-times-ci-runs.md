---
name: preprocess-spend-is-heavy-cold-starts-times-ci-runs
description: GCP spend is per E2E run, not idle - heavy preprocess cold starts times E2E run count dominate; measure with startup_latencies + per-instance request logs before proposing a cost fix
metadata:
  type: project
---

Pattern from NEO-484 (2026-11-10). Under request-based billing with
scale-to-zero, preprocess spend scales with full E2E runs, not with time:
quiet CI days cost almost nothing. The multiplier is heavy cold-start time x
E2E run count, so a cold-start cut is the main lever.

- Each heavy instance serves only a few escalations, so its cold start is a
  large share of its billed time.
- Break a cold start into phases from the startup log lines (module import,
  session create, any warm-up inference, probe lag) before choosing a fix. In
  NEO-484 most of it was imports (numba compiling an unused dependency, then
  lazily read image layers), not the model.
- Warm-on-intent instances that never get work, preview deploys and warm-up
  fan-outs were each small; check them, but don't assume they are the lever.

**Why:** the obvious guesses are each small; the multiplier is cold-start time
x run count.

**How to apply:** for any spend or heavy-latency plan, pull
`run.googleapis.com/container/startup_latencies` count/mean and the heavy request
log grouped by instance before sizing a fix. A cold-start cut also relieves the
heavy-escalation E2E reds ([[heavy-escalation-red-read-the-request-log-per-instance]]).
Keep bill shares, service sizing, project ids and billing table names out of
this file; they belong in the private operational notes.
