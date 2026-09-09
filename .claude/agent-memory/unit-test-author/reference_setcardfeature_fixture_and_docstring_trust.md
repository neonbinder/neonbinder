---
name: reference-setcardfeature-fixture-and-docstring-trust
description: Raw cardChecklist+players fixture pattern for per-card mutation tests; don't trust a test file's docstring claim of coverage without grepping for the describe block
metadata:
  type: reference
---

## Don't trust a test file's header comment about what it covers

`convex/featurePropagation.test.ts`'s docstring claims to cover
`setCardFeature`, but as of NEO-71-74 it only had `describe` blocks for
`setSelectorOptionFeature` and `commitCardChecklist` — no dedicated
`setCardFeature` tests existed at all. Always `grep -n "describe(\"<thing>"`
the actual file before assuming a mutation has coverage; a docstring is
aspirational/stale, not proof.

## Fixture pattern for testing a single-card mutation (no ancestor tree needed)

For mutations like `setCardFeature` that only read one `cardChecklist` row
(+ maybe `players`/`teams` it links to), skip building a full
sport→setName→variantType chain via `addCustomSelectorOption`. Just raw
`ctx.db.insert` two minimal `selectorOptions` rows (sport + variantType,
enough to satisfy `cardChecklist.selectorOptionId`) and insert `players`
directly:

```ts
async function seedCard(t: ReturnType<typeof convexTest>, opts: SeedOpts = {}) {
  return t.run(async (ctx) => {
    const sportId = await ctx.db.insert("selectorOptions", { level: "sport", value: "Baseball", platformData: {}, children: [], lastUpdated: Date.now() });
    const variantTypeId = await ctx.db.insert("selectorOptions", { level: "variantType", value: "Base", platformData: {}, parentId: sportId, children: [], lastUpdated: Date.now() });
    // insert players, build cardChecklist with playerIds/features as needed
  });
}
```

This matches the existing raw-insert convention in
`featurePropagation.test.ts`'s `seedSubtree` and
`updateCardChecklistFields.test.ts`'s `seed` — reserve the real
`addCustomSelectorOption`/`addCustomCard` mutation chain for tests that are
actually exercising copy-down/inheritance (see
`cardFeatureDerivation.test.ts`).

**Ordering-sensitive joins**: to prove a multi-value join (e.g. `signedBy`
from multiple `playerIds`) follows array order and not table-insertion
order, insert entities in one order but build the id array in a
deliberately different order (`playerIdOrder: [1, 0]` mapping into
insertion-order ids) — a same-order fixture can't distinguish the two.

## File organization decision

A new, self-contained behavior on an existing mutation (e.g. `setCardFeature`
gaining a `signedBy` auto-fill side effect) that needs 6+ test cases and is
orthogonal to what the mutation's existing test file already covers
warrants its own file: `<mutation>.<feature>.test.ts` (e.g.
`convex/setCardFeature.signedByAutofill.test.ts`), not shoehorned into the
existing propagation-engine file — keeps `describe` blocks scoped to one
behavior each.
