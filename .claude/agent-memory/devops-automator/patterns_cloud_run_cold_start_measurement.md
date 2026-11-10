---
name: patterns-cloud-run-cold-start-measurement
description: How to measure Cloud Run cold starts and idle retention from logs/metrics — startup stdout log timestamps lie; use the startup_latencies metric, no-op request latency, and idle-gap binning instead
metadata:
  type: reference
---

Measuring cold start on a Cloud Run service (done for the preprocess fast
service, NEO-481):

- **Startup stdout log timestamps are not trustworthy.** "Started server
  process" / "Application startup complete" and even the system "STARTUP TCP
  probe succeeded" line were often timestamped seconds AFTER the instance had
  already answered requests (sometimes ~0.1 s after the first response ended).
  Do not compute cold start as `startup log - request arrival`.
- **Trust these instead:**
  1. Monitoring metric `run.googleapis.com/container/startup_latencies`
     (distribution; query with ALIGN_DELTA + REDUCE_SUM over the window via
     the monitoring REST API and a `gcloud auth print-access-token` bearer).
  2. Latency of a no-op route (e.g. preprocess `/warmup` on the fast role,
     ~5 ms warm) on the first request per `labels.instanceId`: anything over
     ~1 s is pure platform cold-start wait. The request-log `timestamp` is
     request arrival; `httpRequest.latency` includes the cold wait.
  3. **Idle-gap binning:** per revision, gap from the last request end to the
     next request start, binned (0-1, 1-5, 5-10, 10-15, 15-20, 20-30 min...),
     counting how often the next request lands on a new instanceId. The bin
     where it jumps to ~100% is the idle retention (was ~15 min with
     minScale 0).
- "First request on a new instanceId" is bimodal when callers fan out N
  warm-ups: the autoscaler starts extra instances that are ready before their
  first request. Use "first request after the revision was fully idle >= 15
  min" for the true from-zero number.
- `gcloud logging read --limit` silently truncates; check the oldest
  timestamp returned and page older windows with a `timestamp<` filter.
- The preprocess fast role runs the SAME image as the heavy role (torch,
  transformers, baked model weights), so its ~20-25 s cold start is image
  size + imports, not app startup (app startup logs ~10 ms).
