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

**⚠️ 2026-09-07, measured on PR #242's preview — the chicken-and-egg does NOT
apply to Hockey, and the "no marketplace ids" claim above is WRONG there.**
`All Brands` is a row in **SportLots' own hockey brand list**, so the ordinary
manufacturer sync creates it — with a SportLots id — before any Sets column has
mounted. Hockey 1995 and 1997 both return the same 18 rows
(`All Brands, Bowman, Classic, Donruss, Finest, Fleer, ITG, O-Pee-Chee, Pacific,
Panini, Pinnacle, Score, Skybox, SP, Stadium Club, Topps, Ultra, Upper Deck`).
**One `util-drill-to-cold-real-set` pass is enough**; the two-pass drill was
~60s of taps buying nothing. `syncSetsAcrossManufacturers` still creates the row
when a marketplace does not offer it, so the old paragraph may hold for other
sports — check the Manufacturers column before assuming either way.

Consequence: **SportLots IS resolvable under Hockey's All Brands**, and the base
picker offers the year's whole SportLots catalogue (measured: 1 BSC candidate,
**321** SportLots candidates, and the "no base set" line below never renders).

**A set under All Brands is still ONE-SIDED**, for a different reason than this
note used to give: `attachedSidesOf` counts a SportLots id only on a row at
`SL_SET_LEVELS` = `setName | variantType | insert | parallel`. A MANUFACTURER's
id is deliberately not enough. The set row and its `Base` row carry a BSC id and
no SportLots id, so what keeps the set one-sided is simply that the flow
CANCELS the picker rather than attaching one.

Do **not** assert `SportLots returned no base set for <set>` under All Brands —
it never appears. Assert `id: "BSC base candidate: .*"` (BSC really answers) and
let the product state the outcome itself at the result line, `Kept all N cards
from BSC. Nothing to match, no other marketplace attached.` Cancelling writes
nothing and leaves the SL slot empty — and `CardChecklist` still mounts, because `cardChecklistId` is the
variantType id the moment a Base row is selected, regardless of `baseHasMapping`.

Careful: if BOTH sides come back empty AND the set carries no BSC slug,
`BaseMappingForm` takes its "nothing to link" branch and the picker never opens
at all — such a set is unusable as this fixture.

And the picker's after-state is a dead end for scrolling:
[[maestro-web-cannot-scroll-after-base-picker]]. See also
[[neo255-one-marketplace-surfaces]] and
[[probe-a-fixture-without-draining-it]].
