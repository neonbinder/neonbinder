---
name: patterns-neo170-workpool-pipeline
description: NEO-170 Convex workpool → preprocess batch pipeline — the auth/no-path invariants that hold, and the four structural gaps (extract bypasses the pool, unbounded upload queue, two pixel ceilings, wedged-job unrecoverability)
metadata:
  type: project
---

Audited 2026-08-17 in worktree `neo-170-workpool` (pre-PR). Convex owns all
orchestration; `services/preprocess` is stateless with two JSON routes
(`/extract`, `/process-entry`).

## Invariants that HOLD — re-verify these on any change, don't re-derive

- **No `objectPath` on the wire, anywhere.** Grep confirms the only occurrences
  are `placeholderJobs.objectPath` (server-only column), `insertPlaceholderJob`
  (internal), and doc comments. `getPlaceholderJob` deliberately omits it;
  pinned by `placeholderPipeline.test.ts` "never returns the server-only
  objectPath" and by both preprocess route tests
  ("response_never_carries_object_paths").
- **`userId` is always server-derived.** All 5 public functions
  (`startPlaceholderBatch`, `cancelPlaceholderBatch`, `getPlaceholderJob`,
  `listPlaceholderImages`, `listPlaceholderPairs`) take `jobId` only, resolve
  through `findOwnedJob`, and pass `job.userId` (never an arg) downstream. The
  preprocess service *trusts* the supplied `user_id` — that is only safe
  because of this. Any new entry point that takes `userId` as an arg breaks the
  whole model.
- **No existence oracle.** `findOwnedJob` returns null for missing AND unowned;
  mutations throw the identical `"Job not found"`, queries return `null`/`[]`.
- Everything else in the pipeline is `internalMutation`/`internalQuery`/
  `internalAction`. Five public functions total.
- `convex/lib/cloudRunAuth.ts` is a **verbatim** extraction from
  credentials.ts — the non-loopback-http refusal and the google-auth-library-v10
  `Headers.forEach` gotcha both survived. Single-slot cache became a Map keyed
  by audience (correct: two services now).
- The internal key is never logged, never in telemetry (`recordAdapterCall`
  takes `error_class` from `classifyAdapterError`, a fixed bucket string, never
  the raw message).
- **Both NEO-149 zip bypasses are fixed and pinned**: `_read_zip64_override`
  mirrors `_EndRecData64`, plus `_ReadCappedStream` bounds the actual
  `fp.read(size_cd)` independently; `app/imaging.py` adds a real pixel cap.
  The NEO-149 *slot-leak* class is gone too — the routes are synchronous, no
  background task, no `_active_jobs`.

## The four structural gaps found (fix or accept deliberately)

1. **`/extract` bypasses the workpool.** `startPlaceholderBatch` →
   `ctx.scheduler.runAfter(0, runExtract)` with no concurrency bound;
   `runExtract` has its own 3-attempt inline ladder. So the adapter's central
   claim ("the pool physically cannot have more than N requests outstanding")
   covers `/process-entry` only. N concurrent jobs = N concurrent extracts
   against a 3-instance / concurrency-1 service, starving the pool.
2. **Unbounded `ThreadPoolExecutor.submit` queue** in `main._extract_entries`.
   Futures retain the `upright` bytes; the producer (decompress + a no-op EXIF
   pass) massively outruns 8 network uploads. Ceiling is
   `MAX_TOTAL_UNCOMPRESSED_BYTES` = 2 GiB on a 4 GiB instance that already
   holds BiRefNet. Reachable with ~76 level-0-compressed PNGs from a ~100 MB
   archive. **Streaming the zip buys nothing if the sink queue is unbounded.**
3. **Two divergent pixel ceilings.** `main.MAX_IMAGE_PIXELS = 60_000_000` vs
   `imaging.MAX_IMAGE_PIXELS = 50_000_000` (which is also assigned to
   `Image.MAX_IMAGE_PIXELS` process-wide). `_read_upload` hand-rolls the check
   instead of calling the `check_raster_size` it already imports, and its
   `except Exception: return data` swallows `DecompressionBombError`, so
   >100 MP bombs get a 502 instead of a 413. `cropper/sam.py:68`'s blanket
   `warnings.filterwarnings("ignore")` still hides the 50–100 MP warning band.
4. **A wedged job is unrecoverable by the user.** `STARTABLE_STATUSES` is
   {pending, uploaded, failed}; `cancelPlaceholderBatch` skips rows with no
   `workId` and never sets a terminal status. So anything that stalls the
   counters (a failed `enqueueImageChunk` chain, a throw in `runPairing` —
   which has no try/catch — an oversized Convex doc from unbounded
   classifier strings) leaves the job in `processing`/`pairing` forever with
   no reaper and no user-facing escape.

## Cost/fairness shape worth remembering

One global pool, `maxParallelism = 3`, no per-user quota and no rate limit on
`startPlaceholderBatch` or `createPlaceholderUploadUrl`. Restart-from-failed
deletes **all** images including `done` ones, so every restart re-pays the full
Cloud Vision + Anthropic bill for every image (the GCS write 412s, but the
inference already ran). A cancel→restart loop is an unmetered paid-API replay
and a multi-hour monopoly of the only queue.

## Streaming intake delta (audited 2026-08-17, commits 954c782 / 0c0225d)

**The reusable lesson: a validation guard that lives in one writer protects a
shared prefix only while that writer is the ONLY one.** `/extract` enforced the
pixel ceiling at `main.py:570` (`check_raster_size` immediately before
`apply_exif_orientation`, with a comment saying exactly why the order matters),
and `/process-entry` inherited the guarantee for free because everything in
`extracted/` had come through `/extract`. Streaming intake hands the browser a
signed POST straight into `extracted/`, and that single change silently voids
the inherited guarantee — `/process-entry` never called `check_raster_size`
itself. **On any new ingestion path into an existing prefix, re-derive which
guards were the writer's rather than the reader's.**

Two decode-guard details worth keeping:
- A signed POST policy can bound BYTES and CONTENT-TYPE. It can never bound
  PIXELS. Byte caps are not decompression-bomb caps.
- `Image.MAX_IMAGE_PIXELS = N` only *raises* above **2N**; between N and 2N it
  merely warns, and `cropper/sam.py:68`'s blanket `warnings.filterwarnings
  ("ignore")` eats that warning. So the process-wide setting is a 2x-loose
  backstop, never the ceiling — only an explicit `check_raster_size` is exact.
- `apply_exif_orientation` fails OPEN on a bomb: `read_exif_orientation`
  swallows `DecompressionBombError`, returns AS_STORED, and the function passes
  the bytes through untouched. It is not a decode gate.

Auth/path invariants that HOLD across the new surface (don't re-derive): no
`objectPath` on the wire (`createPlaceholderImageUploadUrl` deliberately omits
it); all keys server-derived from a `CLERK_USER_ID_RE`-checked subject + a
server UUID + a transactionally-allocated index; entry allocation capped at
1000; confirm idempotent; `ACTIVE_STATUSES` shared so the per-user cap counts
both modes; `insertPlaceholderJob` never sets `mode`, so a zip job can never be
driven through the stream path into its own `extracted/` prefix.

Residual gaps: confirm never checks GCS, so allocate+confirm floods the pool
with doomed work at zero upload cost; incremental pairing's latch bounds queued
runs but not their RATE, giving O(N²) reads per batch in stream mode; signed
POST policies outlive close/cancel (only the bucket lifecycle rule bounds
orphans).

## NEO-176: per-user active-batch cap is now env-configurable (audited 2026-08-23, be8e581)

`MAX_ACTIVE_JOBS_PER_USER` (was hardcoded 2) is resolved at module load from
`process.env` via `resolveMaxActiveJobsPerUser`, a verbatim mirror of
`preprocessCapacity.ts::resolveMaxParallelism`: base-10 integer in [1,10] else
fall back to default 2 + `console.warn` (NOT clamp). Reviewed clean. The two
security-load-bearing properties, reusable for any future "env-driven guard":
- **Fails CLOSED to the conservative default.** The range+`Number.isInteger`
  gate means the resolver can never return NaN/0/negative — so a misconfig can
  never turn the `activeCount >= cap` guard OFF (NaN would make it always-false =
  unlimited) or invert it. This is why fallback-not-clamp is correct for a cost
  guard: clamping a typo'd "30"→10 still honours 5x; falling back to 2 is known-safe.
- **Operator-only, not user-influenceable.** Convex deployment env is set via
  dashboard/CLI/terraform by admins; `process.env` is read-only in the isolate and
  no function writes it. The 3 new exports are plain `const`/`function` (no
  query/mutation/action wrapper) → NOT registered RPCs, unreachable by clients.
- `console.warn` payload = `{msg, configured:<raw env str>, using:2, accepted}` —
  a capacity number to the operator log channel, no secret/PII/credential.

Cost-amplification delta from raising 2→3 (or ≤10): the PAID work
(`/process-entry`, Vision+inference) is always pooled at `fastPreprocessPool`
maxParallelism=20 deployment-wide, so peak spend RATE is pool-bounded regardless
of per-user batch count — the cap does not widen it. The ONE per-user-cap-governed
UNPOOLED path is `/extract` (gap #1 above): scheduled only from
`startPlaceholderBatch` (zip), one-shot per job, stream jobs never extract
(`startPlaceholderStream`/`confirm` enqueue straight into the pool). Post-NEO-175
extract targets the 20-instance fast service, so 3 concurrent extracts/user is
marginal; the aggregate-across-users unboundedness of extract is pre-existing,
not introduced here.

Related: [[patterns-neo149-zip-ingest]], [[patterns-preprocess-service]],
[[patterns-convex-auth-boundary]], [[feedback-reviewing-a-live-worktree]].
