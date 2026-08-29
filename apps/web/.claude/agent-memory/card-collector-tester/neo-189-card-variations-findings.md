---
name: neo-189-card-variations-findings
description: Collector's-eye findings on the NEO-189 card-variation model (parent/child, BSC vs SportLots naming, Legend/SSSP edge cases)
metadata:
  type: project
---

Findings from a hands-on review of NEO-189 (variations as first-class children
of a card) against real synced 2021 Topps and 2021 Topps Heritage data in the
dev deployment (via Fetch from Marketplaces preview, never committed — see
[[testing-set-builder-safely]]).

**What's right:**
- Stem-grouping (BSC `11b`/`11c` vs SportLots `#11 [ VAR ... ]`) correctly
  reconstructs real hobby checklists: 2021 Topps #1a/b/c Tatis Jr. (Sliding /
  In Dugout), #52b/c/d Mickey Mantle Legend swap under Archie Bradley's slot,
  2021 Heritage #51 Javier Baez base/Action/Error/Missing Stars all resolved
  correctly.
- "Nothing inherits from the parent" is the right call and is exercised by
  real data: Heritage #11 "Phillies Rookie Stars (Alec Bohm/Spencer Howard)"
  vs its own variations #11b/#11c which are SOLO Bohm cards — a variation can
  legitimately drop a co-star from a multi-player parent. A model that
  inherited players would get this wrong.
- SP/SSP as a structured attribute (badge), separate from the variation name
  string, matches how sellers actually describe these cards (identity +
  scarcity are separate facts).
- One-level-deep is enforced server-side both directions
  (`setCardVariationParent` in `convex/selectorOptions.ts`): can't parent to a
  card that already has children (must move them first), can't parent to a
  card that is itself a child. Real hobby nested-variation-of-a-variation
  cases are vanishingly rare; the sibling-with-descriptive-name escape hatch
  is adequate.
- "Error"/UER is modeled as a variation (a full card row named "Error"), NOT
  as an attribute — confirmed directly in real BSC data (`#51c Javier Baez -
  Error`). This is the right call; there's no ERR/UER token in
  `EDITABLE_ATTRIBUTES` (`CardDetailPanel.tsx`), only RC/AU/RELIC/SP/SSP/NUM.
- Orphaned-variation handling (a cross-listed or filtered-out variation whose
  parent isn't in view) is explicitly handled: renders at top level labeled
  "Variation of #X" rather than vanishing (`CardChecklist.tsx` ~line 472).

**Real edge cases worth a product decision:**
1. **Cross-platform name precedence on a Legend/identity-swap card.**
   `CardPairingModal.mergePair` does `cardName: bsc.cardName || sl.cardName`.
   For a Legend/SSSP card where BSC's title is just the modern player's name
   with an empty `cardVariation` (catalog gap) while SportLots' title encodes
   the full swap (`Mike Yastrzemski|Carl Yastrzemski · SSSP`), a manual link
   keeps BSC's less-informative/misleading name. Worth surfacing both names
   or forcing a manual name check when merging a card with `isVariation` true
   and disagreeing names.
2. **Auto-pairing conservatively skips ambiguous variations by design** — a
   BSC variation row with an empty `cardVariation` label can never
   auto-pair via `suggestVariationPairings` (it skips empty labels), even
   when the SportLots side is unambiguous. Correct to punt to a human rather
   than guess, but means real sets will show more `BSC only` / `SportLots
   only` leftovers than an admin might expect for well-known Legend/SSSP
   subsets — worth calling out in reviewer-facing copy so nobody assumes the
   Matched bucket is the complete truth.
3. **No jump-to-card-number search in the checklist view** (only BSC/SL
   source-filter chips). Not a NEO-189 regression, but variations collapsing
   183 of 908 Heritage rows makes manual scroll-hunting for a specific number
   more painful — a search-by-number box would pay for itself here.
4. **Grouped-by-default is right for Set Builder** (an import/curation tool)
   but the same grouped model will likely resurface in Inventory/listing
   flows later, where a seller processing a physical stack wants a flat,
   number-sorted view regardless of variation status. Flag this before that
   feature is built — don't assume Set Builder's UX generalizes.
