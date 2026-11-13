---
name: heavy-cold-start-notice-is-order-dependent
description: pipeline-escalation-cold-start can miss its notice when the heavy pool is warm; the notice ends at the first resolved escalation, before the seed page redirects
metadata:
  type: project
---

The placeholder "A few of these need a closer look…" notice (`deriveHeavyWarming`) is up only while an escalated image is processing and none has resolved. Since NEO-484 (#454: direct-ORT BiRefNet, dev result cache, gen2) a warm heavy instance answers in about 2 s and a cold one in about 25 s (was 180-240 s). The deployment-wide heavy warm-up (NEO-299, 330 s window, fired by any intake page mount on any shard) often leaves instances warm, so the first escalation resolves before `/testing/seed-placeholder-upload` finishes uploading and redirects. The spec then never sees the notice. Seen 2026-11-13: first heavy answer arrived 0.4 s before the assert started.

**Why:** the spec's premise (heavy is cold) depends on what other shards did in the previous few minutes.

**How to apply:** a red here showing "All 6 photos read" with no notice = warm pool, not a product bug. Check heavy `duration_ms` on processHeavyEntryWorker and `preprocessWarmupHeavy` calls before the job. The edit renderer's warm-up (NEO-481) is FAST-only and keyed separately, so it cannot cause this. A fix needs the wait armed before the upload starts, or the notice proved below E2E; see [[heavy-preprocess-specs-share-the-dev-service]].
