---
name: bsc-attach-only-functions-on-insert-rows
description: Known gap found in NEO-196 — a row's attached BSC ids only affect card fetching on `insert` rows; on variantType and parallel rows they are attribution-only. SportLots has no such gap.
metadata:
  type: project
---

Multi-source attach (`attachPlatformIds`) accepts BSC ids on variantType /
insert / parallel rows, but only **insert** rows actually source cards from
them. Confirmed by reading `fetchCardChecklist` (`convex/selectorOptions.ts`)
plus `fetchBscChecklist` (`convex/adapters/buysportscards.ts`) during NEO-196:

- The chain's per-level slot ids become `bscPlatformFilters[ancestor.level]`,
  then map through `LEVEL_TO_BSC_FACET`.
- `variantType` is explicitly `continue`d — the variant filter is re-derived
  from the display value instead, deliberately, because a mis-saved
  BaseSetPicker mapping used to corrupt it.
- `parallel` has no BSC facet at all, so it is dropped.
- Only `insert` → `variantName` survives, and that is fan-out'd per slug.

So on a Base or Parallel row, a second attached BSC set changes nothing about
which cards arrive; it only shows up in `sourceBscSetSlug` attribution chips.
SportLots has no equivalent gap — its dealsets id is the fetch unit at every
variant level, and `fetchSportLotsChecklist` picks the deepest attached one.

**Why:** this is not a bug NEO-196 introduced or could fix. Making a row's own
BSC ids meaningful at variantType/parallel needs the stored slot to record
WHICH facet the id belongs to (a schema change), and guessing the facet would
change checklist output for existing production data — the exact "mis-sources
an entire checklist" failure the attach surface is supposed to prevent.

**How to apply:** when someone reports "I attached a BSC set to a Base or
Parallel row and no cards came through", this is why — do not go hunting in
the attach dialog. Scoping a fix means a per-slot facet tag in
`convex/platformSlots.ts` + a migration, so size it as a schema ticket, not a
UI one. Verify the `LEVEL_TO_BSC_FACET` / `continue` behaviour still reads this
way before quoting it; it is the kind of thing a later ticket may have changed.
