---
name: heavy-preprocess-specs-share-the-dev-service
description: A heavy-escalation spec red on a PR that does not touch services/preprocess is usually the shared dev heavy service; trace the call against its 400 s budget and the service's cold-start log lines before suspecting the branch
metadata:
  type: feedback
---

A PR that does not change `services/preprocess` skips `wire-preprocess-url`, so
its preview calls the shared dev heavy service. Concurrent runs and local
sessions all land on that one instance pool, and a wide batch pays cold starts.

**Why:** the page reads as a product failure ("2 pairs ready to print" where the
spec expects 3, "1 photo couldn't be read"), but the path is outside the diff.
Cloud Run can log a 200 for a request Convex already gave up on, because its
latency field excludes the time a request waits in its queue.

**How to apply:** on a heavy-pipeline red, first confirm with
`git diff --name-only origin/main...HEAD` that nothing on the path changed. Then:
1. In the shard's `convex-logs-*` artifact, trace each `adapter_sync_call`
   (start = timestamp minus `duration_ms`). Look for
   `preprocess request timed out after 400s` and `placeholder_photo_timed_out`.
   The artifact is a stream capture and can miss a completion row.
2. In the heavy service's logs, read the request log with `Starting new instance`,
   `BiRefNet session warmed in` and the startup probe lines, per revision. Compare
   cold-start time with other revisions of the same image.
3. Check for another run of the same spec in the same window.

The call budget, Cloud Run request timeout and photo deadline are 400 / 420 /
420 s, so a slow cold start plus any queueing crosses the line. Passes near 300 s
on this spec are the same cold path landing just under it. Neither the 7 s assert
nor the spec is the thing to change. Related:
[[dev-red-that-matches-main-means-dev-was-repushed]].
