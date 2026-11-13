---
name: photo-red-with-upstream-502s-read-the-preprocess-traceback
description: A photo spec red whose Convex log shows repeated `preprocess HTTP 502 "preprocess pipeline upstream failure"` across many jobs at once is usually the classify call's upstream (Anthropic API), not our pipeline; read the preprocess traceback tail and the provider status feed before planning a fix
metadata:
  type: feedback
---

When a photo spec misses its ceiling ("Needs you, 0", "Pairing, 1", "All N photos read")
and the shard's `convex-logs-*` shows `processEntryWorker` / `processHeavyEntryWorker`
failing with `preprocess HTTP 502: {"detail":"preprocess pipeline upstream failure"}`
on SEVERAL jobIds in the same minutes, the pipeline is doing its job: the fast pool
retries (5 attempts, 5 s doubling, jitter 0.5-1.5x, about 75 s nominal) and the
photo lands late or fails with Try again.

**Why:** that 502 is preprocess's catch-all for any exception out of the cascade
(`_process_entry`, `PIPELINE_UPSTREAM_FAILURE`). The Convex side cannot tell Vision from
Anthropic from a bug. Seen 2026-11 (NEO-538): every traceback tail was
`anthropic.InternalServerError` (500 "credential validation failed", some 503) from
`classify.py`, a ~35 min window that matched a published provider incident; extract,
pairing and the enqueue were all healthy, and the back photo read on attempt 5.

**How to apply:**
1. Trace the spec's jobId through the Convex log (`adapter_sync_call` lines, then
   `placeholder_pairing_done` / `placeholder_pair_decided`). Count attempts per entryIndex.
2. Read the preprocess service logs for the window: `textPayload:"Traceback"`, group by
   the LAST line. `anthropic.*` or `vision api error` = outside service;
   `PIL.UnidentifiedImageError` is the known 422 corpus noise, not this.
3. Check the provider status feed (status RSS) for the window.
4. Do not raise the spec's ceiling and do not change the retry ladder on this evidence.
   Whether an LLM-provider outage counts as an "outside service" rerun is the owner's
   call; plan it as a question.
Related: [[heavy-escalation-red-read-the-request-log-per-instance]],
[[heavy-preprocess-specs-share-the-dev-service]], [[photo-red-triage-starts-with-the-branch]].
