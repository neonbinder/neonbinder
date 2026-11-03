---
name: batch-reads-in-waves-validate-in-order
description: Turning a Convex validate-as-you-read loop into concurrent Promise.all read waves without changing which refusal fires first or reading past the caller's scope; the mutation check and read-cap test that prove it, and the moveSubtree pin-test regex trap
metadata:
  type: reference
---

Convex batches concurrent reads (`db.get`, `.collect()`) issued together;
writes never batch. A mutation that validates inside its read loop (`read
row → check → read next`) pays one round trip per iteration. The safe
rewrite (NEO-418, `applyParallelGroupings`):

1. **Read first, in waves.** Wave 1 = every ROW the args name, no
   ranges. Wave 2 = what wave-1 rows point at (`row.parentId`) plus the
   index ranges of the arg rows that passed the scope check. Dedupe, skip
   cached, `Promise.all`, write into the existing cache map.
2. **Validate after, over the cache, in the original loop order.** Keep the
   old `readRow`/`parallelsOf` helpers as cache-first with a real-read
   fallback, so the check loops barely change and an unforeseen id still
   works. Never throw inside a wave callback.
3. **Never reach past the scope the caller named.** A wave may read a
   RANGE keyed on an argument id only after that id's row has passed the
   cheap scope check from the cache (right level, under the parent the call
   names). The args are caller-controlled: an unguarded prefetch lets one
   call walk the largest ranges anywhere in the deployment, and can die on
   the transaction read limit with a system error instead of the
   operator's sentence. A refused plan may read a few extra single ROWS,
   never a range. Mirror the old skip conditions too (no-op entries, "last
   entry wins" Maps a skipped entry does NOT overwrite), and keep the lazy
   fallback for anything the gate skipped.
4. **A row read before a patch can stand in for a re-read after it** only
   for fields the patch does not write; say which fields in the comment.

**Prove the order with a mutation check.** Refusal-pair tests (fault A
first in loop order, fault B whose evidence lands in an EARLIER wave)
pass on the old code too, so install a throw that validates in wave order
and confirm they go red, then restore byte-exact
([[a-green-suite-can-mean-the-test-stopped-testing]]). Each pair test also
runs fault B alone so the pair is not vacuous.

**Prove the scope gate with a read cap.** Seed an out-of-scope row with
dozens of children, refuse a plan naming it under `transactionLimits:
{ documentsRead: N }` with N between the gated and ungated read counts,
and assert the exact `ConvexError` sentence: an ungated prefetch fails
with "Scanned too many documents" instead
([[convex-test-transaction-limits-pin-the-read-set]]).

**Gate trap:** `cardCounts.pin.test.ts` greps for `.moveSubtree(ctx, ` on
ONE line within ~400 chars after each `parentId` patch. Prettier-style
argument wrapping (`.moveSubtree(\n  ctx,`) fails it; keep the call on one
line and put any comment before the patch, not between.

Related: [[convex-test-transaction-limits-pin-the-read-set]].
