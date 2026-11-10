---
name: preprocess-spend-is-heavy-cold-starts-times-ci-runs
description: GCP spend is per E2E run, not idle - heavy preprocess cold starts (~2/3 of heavy cost, ~100 s of each is the rembg/onnxruntime import) plus fast-lane Vision calls; measure with startup_latencies + per-instance request logs before proposing a cost fix
metadata:
  type: project
---

Measured for NEO-484 (2026-11-10). Dev holds ~85-90% of the bill and it scales
with full E2E runs, not time: request-based billing, scale-to-zero, zero-cost
days when CI is quiet. PRs that do not touch services/preprocess all share the
dev main heavy revision; preprocess PR previews are only ~10% of heavy time.

- Heavy (4 vCPU / 16Gi, concurrency 1): each instance serves ~3 escalations
  (~35 s BiRefNet each) after a ~230 s cold start, so cold starts are ~2/3 of
  heavy cost. Startup phases from the log lines: ~100 s between "Waiting for
  application startup" and "loading BiRefNet session" (the onnxruntime + rembg
  import inside `_get_session`), ~40 s session create, ~48 s dummy inference
  (rembg pads to 1024, so it is a full pass), plus probe-period lag.
- Most cold-started instances serve real escalations; warm-on-intent instances
  that never get work are ~12%, so cutting warm-ups is not the lever.
- Vision is called ~0.85x per fast-lane entry; heavy gets the baseline passed
  through and almost never calls it.
- Heavy memory p99 is ~55% of 16Gi.

**Why:** the obvious guesses (preview deploys, idle instances, warm-up
fan-outs) are each small; the multiplier is cold-start time x E2E run count.

**How to apply:** for any spend or heavy-latency plan, pull
`run.googleapis.com/container/startup_latencies` count/mean and the heavy request
log grouped by instance before sizing a fix. A cold-start cut also relieves the
heavy-escalation E2E reds ([[heavy-escalation-red-read-the-request-log-per-instance]]).
Keep project ids and billing table names out of this file.
