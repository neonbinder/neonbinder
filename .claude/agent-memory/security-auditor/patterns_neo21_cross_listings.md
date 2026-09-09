---
name: patterns-neo21-cross-listings
description: NEO-21 cardCrossListings junction table — all 5 surfaces requireAdmin-gated; the recurring gap is cascade-delete coverage (only deleteCard cascades) and no server-side array cap on addCrossListingsByCardNumbers
metadata:
  type: project
---

NEO-21 added `cardCrossListings` (`{cardChecklistId, selectorOptionId, createdByUserId?, lastUpdated}`,
indexes `by_selector_option` / `by_card`) so a card printed in one product can also render in a
second product's checklist. `cardChecklist.selectorOptionId` stays pinned to the HOME set — the
junction row only adds a display location.

**Auth posture (verified clean):** `addCrossListingsByCardNumbers`, `removeCrossListing`,
`getCrossListingsForCard`, plus the modified `getCardChecklist` and `deleteCard`, all call
`await requireAdmin(ctx)` as the first handler line — consistent with every sibling in
`convex/selectorOptions.ts`. See [[patterns_convex_auth_boundary]]. Unit tests in
`convex/selectorOptions.crossListings.test.ts` assert non-admin rejection.

**Tenancy:** `cardChecklist` and `selectorOptions` carry NO per-user scoping field (only an
informational `createdByUserId` on selectorOptions). This is single-tenant, globally-shared
admin taxonomy — so "IDOR" on a caller-supplied `Id<"cardChecklist">`/`Id<"selectorOptions">`
is not a meaningful category here. Don't file it as a finding; the whole file works this way.

**How to apply when auditing anything that deletes `cardChecklist` or `selectorOptions` rows:**
`deleteCard` cascades to `cardCrossListings` via `by_card`, but the BULK deletion paths do NOT:
`commitCardChecklist` (~L4621) and `storeCardChecklist` (~L1386) both drop non-custom rows
missing from a fresh marketplace fetch, the base-variantType insert/parallel cleanup mutation
(~L2600) drops cardChecklist rows, and `resetCardChecklistBatch`/`resetSelectorOptionsBatch`
(the internal full-reset used by the e2e reset) have no `cardCrossListings` sibling batch.
Result is orphan junction rows. Read paths fail safe (`getCardChecklist` does `if (!card) continue`;
`buildSetLabel` breaks on a missing node and returns ""), so this is data hygiene, not exposure.

**Server-side input bounds:** `addCrossListingsByCardNumbers` takes unbounded
`cardNumbers: v.array(v.string())` and does one indexed lookup + insert PER entry sequentially.
The only cap is client-side (`MAX_EXPANDED_NUMBERS = 1000` in `CrossListingImportModal.tsx`) and
it is applied PER comma-chunk, not to the total — "1-1000,1001-2000,…" sails past it. Same
unbounded-array shape as NEO-71/74's `manualCareerTeams` (see
[[patterns_neo92_entity_review_queue]]) — a recurring pattern in this file worth a standing
recommendation: bound the array server-side. Fails closed (Convex aborts the whole transaction),
admin-only, so it stays LOW.

**Also unvalidated (admin foot-gun, LOW):** `v.id("selectorOptions")` validates the id's SHAPE,
never that the document exists or sits at the expected `variantType` level. The only guard is
`source !== target`. Applies to any new Convex function in this repo taking a caller-supplied id.

**Clean:** no credentials/PII, no injection (card numbers are index equality operands, never
interpolated), no `dangerouslySetInnerHTML`/`href` — `homeSetLabel`/`setLabel` render as JSX
text and `title=` attributes only. `deleteCard`'s cascade is a single Convex transaction with no
intervening external await, and returns `v.null()` regardless of how many links existed, so it's
not an enumeration oracle. `buildSetLabel`'s unguarded `parentId` walk (no cycle/depth cap)
mirrors the pre-existing `getAncestorChain` walk — not a NEO-21 regression.
