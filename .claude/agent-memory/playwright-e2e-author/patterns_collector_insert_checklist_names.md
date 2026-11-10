---
name: collector-insert-checklist-names
description: Drilling the collector cascade (Checklists, Add cards "Set:") to an insert or parallel, and how such a checklist is named on its heading, card drawer and Sync status; seller-spec price traps (BSC $900, eBay sandbox under $20)
metadata:
  type: project
---

Collector cascade below Variant Types: pick the type ("Insert", "Parallel"), then the next
listbox is named for the type's own title, then pick the row. `CollectorSet.checklist =
{ type, name }` in `support/collection.ts` (`drillToCollectorChecklist`, `checklistTitle`,
`pickIntakeSet`, `emptyBoxCards` all take it; `drillToCollectorBase`/`baseChecklistTitle`
stay Base-only). Since NEO-475 the seller specs use `TOPPS_CHROME_2024_FUTURE_STARS`.

Names a spec asserts (NEO-475, read from code):
- checklist heading/region and Add cards `Set: ...` = `useDrillState.checklistTitle`:
  `<season> <set> <row>` ("2024 Topps Chrome Future Stars"); Base is "<set> Base".
- Sync status set label (`convex/lib/listingLabels.ts setAndVariantLabel`): Base reads as
  the set alone ("2024 Topps Chrome"), an insert/parallel row as "<set> <row>", a parallel
  under an insert as "<set> <insert> <row>". So for an insert SET_LABEL === TITLE; for Base
  they differ.
- card drawer dialog (`data/labels.ts cardLabel`): an insert's name sits in the set part
  ("2024 Topps Chrome Future Stars #FS-1 ..."), a parallel's trails after the team.

**Why:** the 1988 Base specs built SET_LABEL from year+set by hand; that is wrong for any
non-Base checklist, and a wrong label makes every Sync status wait hang at 7 s.

**How to apply:** derive TITLE from `checklistTitle(target)`; for SET_LABEL check the
variant's level against `setAndVariantLabel` before reusing TITLE.

Price traps: a BSC seller spec lists at $900 (under BSC_MAX_PRICE_CENTS $999) so a killed
run's leftover never sells. The eBay sandbox spec must stay UNDER $20: $20+ routes to the
calculated "NB Tracked" policy the sandbox cannot rate (publish 25007). See
[[marketplace-listing-spec-shape]], [[ebay-listing-spec-shape]].
