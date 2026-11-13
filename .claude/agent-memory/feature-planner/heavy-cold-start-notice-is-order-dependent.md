---
name: heavy-cold-start-notice-is-order-dependent
description: The heavy cold-start notice ends at the first resolved escalation; /print/placeholders mounts its run view only after the LAST photo uploads, so moving the spec to the real screen alone does not fix the race
metadata:
  type: project
---

The placeholder "A few of these need a closer look…" notice (`deriveHeavyWarming`) is up only while an escalated image is processing and none has resolved. Since NEO-484 a warm heavy instance answers in about 2-3.5 s and a cold one in about 25-28 s. Entry 0 escalates about 2.2 s after the stream opens, so on a warm pool the notice lives roughly from +2.2 s to +4.3 s.

The real intake (`app/print/placeholders/intake.tsx`) puts `?jobId=` in the URL only after `await upload(...)` resolves, and the run view (notice, Still reading, pairs) renders only under `jobId`. Six fixture uploads take 4.1-10.6 s on CI (sequential createUploadUrl + signed POST + confirm, 0.65-1.4 s per file). So the run view mounts at about the moment the warm notice clears: on the red seed-page run the upload ended 0.16 s before the first heavy answer. Moving the spec from the test-only seed page to the real screen does NOT close that race (NEO-529 planning, 2026-11-13). Only mounting the run view at session open (a product change, Jason's call) or opening the run from "Recent runs" mid-upload arms the assert in time. The per-image "Escalating — deeper processing…" badge lasts until the LAST escalation resolves, so it survives the end-of-upload mount.

**Why:** the spec's premise (heavy is cold) depends on what other shards did in the previous few minutes, and the page itself hides the run until the upload ends.

**How to apply:** a red showing "All 6 photos read" with no notice = warm pool, not a product bug. Check heavy `duration_ms` on processHeavyEntryWorker against the last `confirmPlaceholderImageUpload`. Expect windows of about 1 s or more are caught (web-first asserts poll at most 1 s apart) only if the assert is already running when the window opens. See [[heavy-preprocess-specs-share-the-dev-service]] and [[pw-step-timings-live-in-the-blob-report]].
