---
name: neo304-armed-subtree-wipe
description: Armed one-off destructive scripts (NEO-214 shape) — a confirm phrase built only from display names does not bind the target when duplicates exist; the checklist for per-mutation re-arming, membership and the schema-derived reference-graph pin
metadata:
  type: project
---

From the NEO-304 audit (2026-09-24, `convex/wipeVariantTypeSubtree.ts`).

1. **A confirm phrase made of display names is not a target binding.**
   `wipe <value> under <path>` is identical for two variant types with the
   same name under the same set, and for twins under duplicated sets — the
   exact damage these tools exist to clean up (the module's own `locate`
   returns every duplicate). If the header claims "the right command pointed
   at the wrong id refuses", check the phrase carries the id (or a suffix).

2. **Re-arm inside every deleting mutation, not just the entry action.**
   The good shape: each internal batch mutation re-reads the env flag,
   recomputes the phrase from live rows, and walks the node's parent chain
   to the target (bounded, fail-closed on a missing parent or depth cap;
   the kept root is NOT a member). Test it by calling the batch mutations
   directly with sibling ids, the root id, unarmed, and wrong phrase, and
   snapshotting the whole DB unchanged.

3. **Pin the reference graph against schema.ts in the test.** Strip
   comments first; include named field objects that `defineTable(x)` takes
   (e.g. `selectorOptionFields`). The regex pin misses ids carried inside
   shared validators defined above `defineSchema` other than the one it
   splices in — re-check by grepping `v.id("<wiped table>")` over the whole
   file, and check workpool contexts / scheduled args hold ids too (the
   entity-review workpool tolerates a deleted row; verify for any new pool).

4. **Sideways pointers dangle between pages** (sync-status notices keyed on
   the parent, queue `source` rows, variation children): each must be
   deleted in the same transaction as its target. A test that loops the
   entry point at batchSize 1 with a zero time budget and scans for
   dangling ids after EVERY call is the proof to ask for.

Minor recurring nits: `Math.max(0, Math.min(NaN, cap))` is NaN, so a NaN
time budget disables the budget; `.take(N)` on a "unique per key" index is
fine only while the key really is unique.

**How to apply:** any armed `internalAction` + batch `internalMutation`
cleanup script, any `*FromCli` reset, any one-off prod delete.
