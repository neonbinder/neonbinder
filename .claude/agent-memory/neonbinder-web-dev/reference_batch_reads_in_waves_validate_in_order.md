---
name: batch-reads-in-waves-validate-in-order
description: Turning a Convex validate-as-you-read loop into concurrent Promise.all read waves without changing which refusal fires first; the mutation check that proves it, and the moveSubtree pin-test regex trap
metadata:
  type: reference
---

Convex batches concurrent reads (`db.get`, `.collect()`) issued together;
writes never batch. A mutation that validates inside its read loop (`read
row → check → read next`) pays one round trip per iteration. The safe
rewrite (NEO-418, `applyParallelGroupings`):

1. **Read first, in waves.** Wave 1 = everything the ARGS name (ids and
   index ranges keyed by arg ids). Wave 2 = what wave-1 rows point at
   (`row.parentId`, targets that depend on a wave-1 field). Dedupe, skip
   cached, `Promise.all`, write into the existing cache map.
2. **Validate after, over the cache, in the original loop order.** Keep the
   old `readRow`/`parallelsOf` helpers as cache-first with a real-read
   fallback, so the check loops barely change and an unforeseen id still
   works. Never throw inside a wave callback.
3. **Read only what the valid path read.** Mirror the old skip conditions
   when planning wave 2 (no-op entries, "last entry wins" Maps that a
   skipped entry does NOT overwrite). A refused plan may read extra rows; it
   throws, so that costs nothing.
4. **A row read before a patch can stand in for a re-read after it** only
   for fields the patch does not write; say which fields in the comment.

**Prove the order with a mutation check.** Refusal-pair tests (fault A
first in loop order, fault B whose evidence lands in an EARLIER wave)
pass on the old code too, so install a throw that validates in wave order
and confirm they go red, then restore byte-exact
([[a-green-suite-can-mean-the-test-stopped-testing]]). Each pair test also
runs fault B alone so the pair is not vacuous.

**Gate trap:** `cardCounts.pin.test.ts` greps for `.moveSubtree(ctx, ` on
ONE line within ~400 chars after each `parentId` patch. Prettier-style
argument wrapping (`.moveSubtree(\n  ctx,`) fails it; keep the call on one
line and put any comment before the patch, not between.

Related: [[convex-test-transaction-limits-pin-the-read-set]].
