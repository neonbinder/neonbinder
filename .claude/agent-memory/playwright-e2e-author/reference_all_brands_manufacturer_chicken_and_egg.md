---
name: all-brands-is-where-the-one-sided-sets-live
description: "All Brands" collects the BSC sets no SportLots brand claims — in some sports it does not exist until another manufacturer's Sets column has mounted once; in Hockey it is a SportLots brand and exists from the start
metadata:
  type: reference
---

`syncSetsAcrossManufacturers` (`convex/selectorOptions.ts`) is **BSC-only**. It
fetches one flat BSC set list for a sport+year and buckets it under the
SportLots-derived Manufacturer rows by **name prefix** (longest brand name first).
Anything whose name starts with no brand goes under **"All Brands"**: minor-league,
junior, college, team and food-issue sets. Where the row is created by
`addCustomSelectorOption` it carries **no marketplace ids of its own**, which makes
SportLots unresolvable beneath it (SL needs sport + year + **manufacturer**).

**Measured 2026-09-07 on PR #242's preview: Hockey differs.** `All Brands` is a
row in **SportLots' own hockey brand list**, so the ordinary manufacturer sync
creates it, with a SportLots id, before any Sets column has mounted. Hockey 1995
and 1997 both return the same 18 rows (All Brands, Bowman, Classic, Donruss,
Finest, Fleer, ITG, O-Pee-Chee, Pacific, Panini, Pinnacle, Score, Skybox, SP,
Stadium Club, Topps, Ultra, Upper Deck). **One cold-drill pass is enough**
(`drillToColdManufacturer`); a two-pass drill buys nothing. Check the
Manufacturers column before assuming either way for another sport.

Consequence: **SportLots IS resolvable under Hockey's All Brands**, and the base
picker offers the year's whole SportLots catalogue (measured: 1 BSC candidate, 321
SportLots candidates, and the "no base set" line never renders).

**A set under All Brands is still ONE-SIDED**, for this reason: `attachedSidesOf`
counts a SportLots id only on a row at `SL_SET_LEVELS` = `setName | variantType |
insert | parallel`. A MANUFACTURER's id is deliberately not enough. The set row and
its `Base` row carry a BSC id and no SportLots id, so what keeps the set one-sided
is that the spec CANCELS the picker rather than attaching one.

Do **not** assert `SportLots returned no base set for <set>` under All Brands: it
never appears. Assert the BSC base candidate option (`getByRole("option", { name:
/^BSC base candidate: / })`) and let the product state the outcome itself at the
result line, `Kept all N cards from BSC. Nothing to match, no other marketplace
attached.` Cancelling writes nothing and leaves the SL slot empty, and
`CardChecklist` still mounts, because `cardChecklistId` is the variantType id the
moment a Base row is selected, regardless of `baseHasMapping`.

Careful: if BOTH sides come back empty AND the set carries no BSC slug,
`BaseMappingForm` takes its "nothing to link" branch and the picker never opens at
all; such a set is unusable as this fixture.

See also [[neo255-one-marketplace-surfaces]].
