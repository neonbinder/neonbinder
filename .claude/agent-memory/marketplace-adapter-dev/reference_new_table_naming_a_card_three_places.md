---
name: new-table-naming-a-card-three-places
description: A new Convex table (or a new nested field on an existing one) holding a v.id("cardChecklist") or v.id("selectorOptions") must be handled in the wipe reference graph, the global set-builder reset, the per-user testing reset and the reference-seed dependant list
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

4. `scripts/reference-seed/cli.mjs` `SELECTOR_DEPENDANT_TABLES` (drained by
   the reset) or `SELECTOR_DEPENDANT_UNDRAINED_TABLES`, plus the mirror list
   `DEPENDANTS` in `convex/resetSetBuilderData.test.ts`. `cli.test.mjs` walks
   the exported schema for ANY `v.id("selectorOptions")`, nested ones too (a
   sale line's `items[].listed.sportId` tripped it), so it goes red on its own,
   but only in the full `vitest run`, not in the area tests.

**How to apply:** when a schema change adds such a table, grep for an
existing sibling table name (e.g. `marketplaceSales`) across `convex/` and
add the new one beside it everywhere it appears, then tell the coordinator
the reset test (`resetSetBuilderData.test.ts` DEPENDANTS) does not seed it.
See [[generated-api-needs-hand-edit-in-worktrees]] for the other hand step a
new module needs.
