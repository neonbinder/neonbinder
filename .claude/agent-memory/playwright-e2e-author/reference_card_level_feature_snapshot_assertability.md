---
name: card-level feature-snapshot assertability (CardDetailPanel drawer)
description: How to E2E-assert that a CARD ROW inherits the write-once feature snapshot from its ancestor chain; which drawer values render, and the fresh-leaf discipline
metadata:
  type: reference
---
Card-level companion to the set-panel snapshot assertions (feature defaults asserted at
the SET panel).

**The card-level feature: both card-creation paths seed `cardChecklist.features`
byte-identically**: `addCustomCard` = `{...parentNode.features, ...deriveCardObservedFeatures(...)}`
and `commitCardChecklist`'s marketplace INSERT branch = `{...inheritedFeaturesOrUndefined,
...deriveCardObservedFeatures(card)}`, where `inheritedFeaturesOrUndefined ===
leafNode.features === parentNode.features`. So a per-worker hand-made CARD under a FRESH
hand-made leaf is the faithful, collision-free proxy for a "freshly-synced" card's
inherited defaults. A genuinely marketplace-synced card cannot prove this locally:
(a) a hand-made subtree resolves neither marketplace side so it never gets synced cards;
(b) real shared sets were synced on shared dev BEFORE these defaults existed, so their
leaf snapshots predate them (write-once, never recomputed); and editing a real shared set
concurrently violates data isolation (R7a). In CI's fresh preview the real synced cards DO
carry them, but that path isn't locally assertable.

**"Edit card N" opens the CardDetailPanel DRAWER, not an inline form.** The drawer header
reads "Card #N" with up/down/close controls; its body embeds the CardFeaturesEditor
(Show/Hide features editor toggle plus a "Cancel card edit" footer button). Fields are
located by their `Value for <Label>` accessible names (e.g. `getByLabel("Value for Card
Size")`), so assert with `toHaveValue(...)`; Playwright scrolls the drawer's inner
container to the target itself.

**Which card-feature VALUES render (custom sport = no League row):** near top: Era
(select), Vintage (derived span), Season (text, the year value), Manufacturer, Card Type
("Insert"/"Base"), Variation (label renamed from "Parallel/Variety" in NEO-71-74, so the
accessible name is "Value for Variation"), Short Print (select), Reprint (checkbox),
Signed By, Rookie/Prospect (checkbox). Further down: Memorabilia Relic (checkbox),
Country of Origin="USA", Card Size="Standard", Material="Card Stock" (key cardMaterial),
Card Thickness="20pt", Language="English", Event/Tournament, Convention/Event, UPC.
**AUTOGRAPHED IS NOT IN THIS EDITOR**: CardFeaturesEditor filters `key==="autographed"`;
it is an always-visible grid cell in the CardDetailPanel body below the whole expanded
editor, so `Value for Autographed` is unreachable from inside the expanded editor. Assert
its default ("None") from the collapsed-editor state in the autograph spec instead.

**Fresh-leaf discipline:** the set basename must be NEW to the suite so its FIRST creation
carries the current derivation (write-once; the reset never wipes... check
`SET-REGISTRY.md` for the current reset scope). If a NEW setName-level default is added
and asserted here, BUMP the basename so the set is recreated fresh; same generation-bump
rule as any new-chain spec.
