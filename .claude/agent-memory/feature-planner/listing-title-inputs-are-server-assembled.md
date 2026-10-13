---
name: listing-title-inputs-are-server-assembled
description: assessListingTitle is pure and browser-safe but its INPUTS (canonical player/team names, leaf feature snapshot, setName/sport/brand-unknown role) are assembled only in server code (cardRowCreate.buildCardRowForInsert, previewListingTitle); a pre-save title preview needs a context query plus an extracted pure input builder, never a third hand-mirrored mapping
metadata:
  type: project
---
`convex/features/generateListing.ts` (`assessListingTitle`) and
`convex/features/cardAttention.ts` are pure and already imported by the SPA.
What is NOT importable is the input assembly: `cardRowCreate.buildCardRowForInsert`
merges the leaf's `features` snapshot with `deriveCardObservedFeatures`, and reads
`CardRowSetContext` (sportValue, setNameValue, manufacturerBrandUnknown, leaf
features) that the commit prelude resolves; `previewListingTitle` hand-mirrors it
("if you change one, change the other"). `cardRowCreate.ts` pulls in `sku.ts` and
`cardPlayerLinks.ts`, so it is server-only.

**Why:** NEO-335 phase 2 moves the titleTruncated / aspectValueOverLimit warnings
pre-save onto preview cards; computing them client-side is right (titles recompute
instantly as team answers change) but a third copy of the mapping is how the
title written at insert and the one shown before save drift.

**How to apply:** plan a pure `listingInputsForCard(card, setContext, names)` in
`convex/features/` used by cardRowCreate, previewListingTitle and the client, plus
a server context (set facts + canonical names for pre-resolved printed names)
delivered before the wizard opens (ride it on the resolve action's result rather
than a second round trip). Canonical names matter: the title says "Dwight Gooden",
not the printed "Doc Gooden".
