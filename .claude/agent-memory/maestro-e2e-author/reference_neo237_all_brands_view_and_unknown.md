---
name: neo237-all-brands-view-and-unknown
description: NEO-237 — "All Brands" is a PINNED VIEW entry (aria `All Brands — every set in <year>`), the brand-unknown row is minted as `Unknown`, SportLots-only sets are auto-saved by Sync Sets (no pill/modal); the selectors, the back-fill card assertion, the content-gate race on the pinned tap, why the sync summary is NOT a UI surface, and why the collapsed cards make a re-drill safer than a card tap
metadata:
  type: reference
---

# What changed on the Manufacturers / Sets columns (NEO-237)

- **Pinned entry**: first option of every Manufacturers column, both modes,
  zero rows or eighteen. Visible text `All Brands` (its own span), aria-label
  `All Brands — every set in <year>` → target `id:` (the visible words also
  full-match the collapsed card's text once selected). Not counted toward the
  8-row search threshold, never filtered. `util-drill-to-cold-real-set` takes
  `MANUFACTURER: "All Brands"` and taps it in both modes.
- **View mode Sets column**: every set of the year, brand as a muted second
  line (sibling node, so `text: "<set>"` still matches the name alone); no
  `Add custom Sets`, the line `Pick a brand to add a set` in its place; a
  set pick BACK-FILLS the manufacturer → collapsed card
  `Manufacturers: <brand> — change` (em dash U+2014). That card is the
  cheapest live proof of "which row was this set filed under".
- **`Unknown`**: the year's brand-unknown row (`metadata.isBrandUnknown`),
  minted by the year-wide Sets sync's BSC phase, or live by the manufacturer
  sync when it routes SportLots' "All Brands" option onto it (its id attached,
  label never stored). Typing `All Brands` into "+ Custom" is refused inline:
  `All Brands is the view at the top of this column, not a brand.`
- **Brand attributes**: `Value for Brand` (wrapper `Set feature Brand`) = the
  set-name prefix, defaulted to the name at creation; a brand-row toggle
  `SportLots has no brand for this — match its sets by name` (aria-pressed).
- **Confirm-create at manufacturer level**: sentence
  `Create manufacturer '<v>' under <a> › <b>?`, line
  `Sets in Unknown whose names start with '<v>' move here.` — and nothing
  about SportLots (the opt-in toggle was removed 2026-09-21: a brand created
  under a year carrying SportLots ids links through All Brands by itself;
  the link is read afterwards in the attributes panel's SportLots cell and
  the narrowed base-picker pane).
- **SportLots-only sets are SAVED by the year-wide Sync Sets** (2026-09-21;
  the `N new on SportLots` pill + review modal are gone): each new root
  becomes a `setName` row named `<brand prefix> <label>` (label as-is under
  Unknown) with `platformData: {}` and a Base carrying the SL id
  (`insertSetWithBaseFromSl`). `routeSlSets` still hides every entry a
  known set EQUALS or word-boundary-PREFIXES, so nothing is minted beside
  a BSC flagship of the same name. Two E2E consequences: (1) a set row is
  NOT terminal, so the view shows no `SL` pill on it — the id is only
  visible on the Base after a pick; (2) the sync's `Synced sets (…, N sets
  added from SportLots)` summary is `res.message`, which
  `ensureSelectorOptions` DROPS on success (a clean sync deletes its status
  row; only paused/failed/skipped/unlinked notices reach `SyncDoneNotice`),
  so the fragment is not an E2E target until the done row carries it.
  Nothing on screen names a saved set, and its name is a marketplace label —
  never assert one as a literal.
- **Sync Sets is two-sided**: a hand-made brand's (or any brand's under the
  pause) Sets column ends "done" with `SportLots skipped: no SportLots ids on
  this path.` — a notice, not the failure copy the strict seed asserts on.
  Creating a brand with re-homes leaves `N sets moved out of Unknown` on the
  brand's Sets status row, and that column is then "already populated" so it
  does NOT sync (no SportLots phase, no pill) until "Sync Sets" is forced.

# Two traps

1. **Tapping the pinned entry too early.** The entry renders in the ~300ms
   before the manufacturer sync flips the status row to "syncing"; a tap
   there opens the view and fires the year-wide Sets sync against a year
   with no brand rows — everything lands under Unknown and the SportLots
   phase has no brand to scope. Gate on the sync's CONTENT first (live:
   `.*Search manufacturers.*`, which needs >8 rows; paused: the idle empty
   text or the `Unknown` row), exactly as the row path's
   `.*Search manufacturers.*|<row>` gate does.
2. **Collapsed cards share text with rows.** With a set selected, the Sets
   card's text is the set name and the Manufacturers card's text is the brand
   name; a brand created with the same name as its flagship set ("SPx") makes
   `text: "SPx" below: "Manufacturers"` ambiguous on the no-search shape.
   Re-drill through the util (fresh navigation, nothing selected) instead of
   re-opening a column from its card.
3. **Once a SET is selected the leading cards are off the LEFT edge.** The
   Variant Types column mounting runs `scrollColumnIntoView` on the columns
   ROW (horizontal); measured 2026-09-21 the `Manufacturers: … — change`
   card sat at x=-88..172 and no vertical scroll moves it (maestro-web
   scrolls only the window). To get the Manufacturers column EXPANDED again
   (for its "+ Custom"), `runFlow util-drill-to-custom.yaml` with only
   `SPORT` + `YEAR` — it stops at the deepest level given and selects
   existing rows on a warm path. A card tap is safe only while nothing
   deeper than the year is selected.
4. **Reaching the action row under the view's 400px Sets list parks the
   page at MAXIMUM scroll** (the `Sync Sets` gate does this). The `Search
   sets` input at the column head is then ABOVE the viewport — the next
   scroll to it is `direction: UP` (CI 35658444013 r2 burned 7 s on DOWN
   with the input rendered the whole time, root y=-677). The done notice
   sits directly ABOVE the idle `Sync Sets` button (`SyncDoneNotice` then
   `idleButtons`, same slot, same status-row render), so UP from the button.
