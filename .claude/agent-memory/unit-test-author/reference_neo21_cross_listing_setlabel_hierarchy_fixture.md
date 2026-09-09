---
name: reference-neo21-cross-listing-setlabel-hierarchy-fixture
description: NEO-21 cardCrossListings tests need a full sport->year->manufacturer->setName->variantType chain, not the usual shortcut, because buildSetLabel reads year/manufacturer/setName off parentId ancestors
metadata:
  type: reference
---

# NEO-21 cross-listing tests: full selectorOptions hierarchy needed for label assertions

`convex/selectorOptions.ts`'s `buildSetLabel(ctx, selectorOptionId)` walks the `parentId` chain from a variant-level node upward, collecting `{level: value}` for every node it passes, then joins `["year","manufacturer","setName"]` (skipping absent levels) into a display string like `"2021 Panini Score"`. It backs both `getCardChecklist`'s `homeSetLabel` (on cross-listed guest rows) and `getCrossListingsForCard`'s `setLabel`.

Most existing fixtures in this codebase shortcut the chain (`sport -> setName -> variantType`, e.g. `featurePropagation.test.ts`'s `seedSubtree`) because they don't touch label building. **Don't reuse that shortcut for cross-listing tests** — with year/manufacturer absent, `buildSetLabel` degrades to just the setName value, which trivially passes without exercising the ancestor walk. Build the full chain instead:

```ts
async function seedHierarchy(t, opts: {sport, year, manufacturer, setName, variantType?}) {
  return t.run(async (ctx) => {
    const sportId = await ctx.db.insert("selectorOptions", { level: "sport", value: opts.sport, platformData: {}, lastUpdated: now });
    const yearId = await ctx.db.insert("selectorOptions", { level: "year", value: opts.year, platformData: {}, parentId: sportId, lastUpdated: now });
    const manufacturerId = await ctx.db.insert("selectorOptions", { level: "manufacturer", value: opts.manufacturer, platformData: {}, parentId: yearId, lastUpdated: now });
    const setNameId = await ctx.db.insert("selectorOptions", { level: "setName", value: opts.setName, platformData: {}, parentId: manufacturerId, lastUpdated: now });
    const variantTypeId = await ctx.db.insert("selectorOptions", { level: "variantType", value: opts.variantType ?? "Base", platformData: {}, parentId: setNameId, lastUpdated: now });
    return { sportId, yearId, manufacturerId, setNameId, variantTypeId };
  });
}
```
No `children` array maintenance needed — `buildSetLabel`/`addCrossListingsByCardNumbers`/`getCardChecklist`/`deleteCard`/`getCrossListingsForCard` only ever read `parentId` upward, never `children` downward.

## Ordering-fix regression fixture (sortOrder vs cardNumber)

`getCardChecklist`'s NEO-21 change sorts the merged home+guest array with `compareCardNumbers`, not `sortOrder` (a guest row's `sortOrder` is inherited from its *home* checklist and is meaningless in the guest context). To actually exercise this instead of getting a coincidental pass, pick values where the two orderings disagree: give the guest card a numerically-high `cardNumber` (e.g. `"301"`) but a `sortOrder` *lower* than the target's own home rows (e.g. `-100` vs `0`/`1`). Correct (cardNumber) order puts it last; buggy (sortOrder) order would put it first — the assertion `checklist.map(c => c.cardNumber)` distinguishes the two implementations immediately.

## Full-value equality check for "untouched by delete/remove" assertions

For `removeCrossListing` / `deleteCard` cascade tests ("the home card survives unchanged"), snapshot the full doc via `ctx.db.get(id)` before the mutation and `toEqual()` it against the post-mutation fetch, rather than re-asserting individual fields — catches an accidental `lastUpdated` bump or stray field write that field-by-field checks would miss.

See also [[project_vitest_projects_setup]] for the convex-test harness/module-glob setup this file uses (`convex/selectorOptions.crossListings.test.ts`, colocated per the existing `selectorOptions.addCustom.test.ts` naming convention).
