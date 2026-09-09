---
name: workpool-oncomplete-inline-batched
description: "@convex-dev/workpool runs onComplete callbacks INLINE and batches several into ONE transaction (Promise.all) — so a shared-doc read-modify-write across completions loses updates unless serialized"
metadata:
  type: reference
---

`@convex-dev/workpool` (apps/web, pinned `^0.4.9`) does NOT give each work item's
`onComplete` its own transaction. Its `complete` handler (node_modules/@convex-dev/workpool/dist/component/complete.js)
runs the callbacks **inline** (`runOnCompleteInline`) and, on the main-loop /
recovery / multi-job path, settles a whole batch of work items by awaiting their
onCompletes with `Promise.all` **inside a single transaction**. So two (or more)
onComplete callbacks for the same pool can execute in ONE Convex transaction and
interleave at their `await` points.

**Consequence:** any onComplete that does a read-modify-write on a SHARED
document — the classic being `counter = doc.counter + 1` — loses updates. Both
callbacks read the same pre-increment value and both write the same `+1`, so all
but one increment vanishes. Per-transaction serializability (OCC) does NOT save
you here: it protects across transactions, and these run in the SAME one.

This is exactly what stranded the NEO-170 placeholder pipeline's E2E gate: images
all reached `done` (distinct rows, no contention) but `placeholderJobs.processedImages`
fell short of `totalImages`, so "N of 6 images processed" never reached 6 and the
job sat in "collecting" forever. The stuck count varied run-to-run (4/6, 5/6)
because it depended on how many completions the pool happened to batch together.

**Fix pattern:** serialize the onComplete body per shared key with a module-level
async lock (a self-cleaning `Map<key, Promise>` chain) so concurrent inline
completions run one at a time. See `withJobSettleLock` /
`recordImageOutcomeImpl` in convex/placeholderPipeline.ts. Deriving the counter
from a full row scan also works but is O(N²) over a batch — rejected here (see
the convex-schema-specialist NEO-170 memory). Reproducible deterministically in
convex-test by calling the onComplete impl for several rows via `Promise.all`
inside one `t.run` (convex/placeholderCounterRace.test.ts).

**When it's SAFE (no lock needed):** the hazard is a shared-doc read-modify-write.
If each onComplete writes only its OWN distinct row (keyed by the work item's id)
and there is no shared counter, batched inline completions cannot interfere —
they touch different documents. NEO-99's `wikidataPool` onComplete backstop
(convex/wikidataPool.ts → `backstopEntityReviewRowImpl`) is exactly this: each
completion ages its own `entityReviewQueue` row to "error" if still pending, and
the wizard's "N of M reviewed" is DERIVED by `getBatch` counting rows live, not
stored — so no `withJobSettleLock` is needed there. The batched-completion
safety is proven the same way (Promise.all of the backstop over several rows in
one `t.run`, convex/entityReviewResilience.test.ts). Rule of thumb: shared
mutable doc → lock; per-item rows + derived aggregates → safe.
