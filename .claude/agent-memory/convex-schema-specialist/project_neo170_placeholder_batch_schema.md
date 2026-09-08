---
name: project-neo170-placeholder-batch-schema
description: NEO-170 placeholder batch pipeline — the three-table design (placeholderJobs/Images/Pairs), its load-bearing invariants, and the review findings from 2026-08-17
metadata:
  type: project
---

NEO-170 turned the NEO-148 `placeholderJobs` ownership row into a full batch state machine and added two tables. Reviewed 2026-08-17 in the `neo-170-workpool` worktree (uncommitted at the time).

**Shape:** `placeholderJobs` (one per upload, carries lifecycle status + progress counters) → `placeholderImages` (one per accepted zip entry, one ⇄ one workpool item) → `placeholderPairs` (one per matched front/back). Images and pairs are keyed to the job by the string `jobId`, **not** by `v.id("placeholderJobs")`, because `jobId` is the client-facing handle the whole security model is built on.

**Load-bearing invariants that must survive any future schema work:**

- The `objectPath` hard rule now covers all three tables. Every function takes `jobId` only; ownership is `row.userId === identity.subject` on the job row. Both `neonbinder-convex` and the preprocess SA hold bucket-wide read on the placeholder bucket, so an `objectPath` argument would be a cross-user read oracle.
- **`placeholderImages.index` must be unique per job.** `storePairs` / `markUnmatchedImages` use `.withIndex("by_job_index").unique()`, which *throws* on a duplicate. Nothing enforces uniqueness — the extract step in `services/preprocess` assigns it. A duplicate strands the job in `"pairing"` (no catch in `runPairing`).
- **`MAX_ZIP_ENTRIES = 1000` in `services/preprocess/app/jobs/zipsafe.py` is a Convex transaction-size invariant.** `registerExtractedImages` inserts one row per accepted entry in a single mutation; the reset path in `startPlaceholderBatch` deletes up to 1000 images + ~500 pairs in one user-facing mutation. Both are sized by a constant in the *other repo*. Same drift class as `PREPROCESS_MAX_PARALLELISM` ⇄ `preprocess_max_instances`, but without the all-caps banner that one got.
- Every stranding failure mode is the same shape: a throw inside a completion/pairing path leaves the job in a non-terminal status with nothing scheduled → permanent spinner, no error surfaced. `runExtract` is explicitly written so no path gives up quietly; `runPairing` is not.

**Index findings:** `placeholderImages.by_job` is fully redundant with the `by_job_and_index`-style compound (`["jobId","index"]`) — a prefix query covers it. Its only two call sites are the reset and cancel collects. Dropping it is free while the table has no production data.

**Counters-on-the-job-row under concurrent `onComplete`:** safe. The pool caps concurrency at 3, transactions are tiny, and Convex's serializability is what makes "exactly one invocation observes `processed + failed === total`" true. Do not replace this with a separate counter table.

**Why the phases don't produce an N² reactive blowup:** processing writes image rows (invalidating the image-list query) while pairing writes pair rows (invalidating the job query). They never overlap, and the pool caps throughput at ~3 completions in flight, so the invalidation *rate* stays low even at 1000 images. Pagination is a NEO-152 decision, not a NEO-170 blocker.

See [[patterns-service-derived-field-validators]] for the validator rule this pipeline established.
