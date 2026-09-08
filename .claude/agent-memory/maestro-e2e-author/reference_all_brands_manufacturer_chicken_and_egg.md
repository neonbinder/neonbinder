---
name: all-brands-is-where-the-one-sided-sets-live
description: "All Brands" collects the BSC sets no SportLots brand claims — and it does not exist until some OTHER manufacturer's Sets column has mounted once
metadata:
  type: reference
---

`syncSetsAcrossManufacturers` (`convex/selectorOptions.ts`) is **BSC-only**. It
fetches one flat BSC set list for a sport+year and buckets it under the
SportLots-derived Manufacturer rows by **name prefix** (longest brand name
first). Anything whose name starts with no brand goes under **"All Brands"** —
minor-league, junior, college, team and food-issue sets. That row is created by
`addCustomSelectorOption` and therefore carries **no marketplace ids of its
own**, which is what makes SportLots unresolvable beneath it (SL needs sport +
year + **manufacturer**). So a set under All Brands is one-sided through the
product's own rules, not by our declining to attach.

**The chicken-and-egg:** `ensureSelectorOptions` dispatches the `setName` level
to that action, and it runs at the **year** level. So "All Brands" is minted as
a side effect of some manufacturer's Sets column mounting — it is **not in the
Manufacturers column until then**, and a drill that asks for it first will hang.
Selecting a row also COLLAPSES its `EntitySelector` to a chip, so re-picking a
different manufacturer in place means re-expanding by hand.

The clean shape is to call `util-drill-to-cold-real-set` **twice**: pass 1 with
any real SL brand for that year (nothing is selected under it), pass 2 with
`"All Brands"`. Pass 2 re-enters at `/set-selector`, which clears pass 1's
selection, and every level it re-walks is warm.

**The copy-stable one-sidedness precondition** is `BaseSetPicker`'s own line:

> `SportLots returned no base set for <set>`

paired with at least one `id: "BSC base candidate: .*"`. That is a positive
assertion that the marketplace has no counterpart, far stronger than "we chose
not to attach one". Cancelling the picker then writes nothing and leaves the SL
slot empty — and `CardChecklist` still mounts, because `cardChecklistId` is the
variantType id the moment a Base row is selected, regardless of `baseHasMapping`.

Careful: if BOTH sides come back empty AND the set carries no BSC slug,
`BaseMappingForm` takes its "nothing to link" branch and the picker never opens
at all — such a set is unusable as this fixture. See
[[base-mapping-picker-paths]] and [[neo255-one-marketplace-surfaces]].
