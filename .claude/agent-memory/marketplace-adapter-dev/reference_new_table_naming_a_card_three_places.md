---
name: new-table-naming-a-card-three-places
description: A new Convex table holding a v.id("cardChecklist") (or a selector/variant id) must be handled in the wipe reference graph, the global set-builder reset and the per-user testing reset; only the first fails a test
metadata:
  type: reference
---

Adding a table whose fields hold `v.id("cardChecklist")`, `v.id("selectorOptions")`
or another id the variant-type wipe deletes touches three places:

1. `wipeVariantTypeSubtree.ts` `SUBTREE_REFERENCE_GRAPH`: an entry saying
   whether the table refuses the wipe or is left untouched, and why.
   `wipeVariantTypeSubtree.test.ts` re-derives the referencing tables from
   schema.ts source, so this one goes red on its own.
2. `selectorOptions.ts` reset batches (`resetMarketplaceListingBatch` for the
   listing tables): the global set-builder reset deletes cards, so a table
   naming them must drain before them. Nothing fails if you forget.
3. `testing.ts` per-user reset (`resetMyTestData`-style handler): clear the
   caller's rows by an owner-first index. Nothing fails if you forget.

**How to apply:** when a schema change adds such a table, grep for an
existing sibling table name (e.g. `marketplaceSales`) across `convex/` and
add the new one beside it everywhere it appears, then tell the coordinator
the reset test (`resetSetBuilderData.test.ts` DEPENDANTS) does not seed it.
See [[generated-api-needs-hand-edit-in-worktrees]] for the other hand step a
new module needs.
