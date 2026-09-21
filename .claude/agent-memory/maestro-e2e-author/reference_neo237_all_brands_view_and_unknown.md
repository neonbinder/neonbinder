---
name: neo237-all-brands-view-and-unknown
description: NEO-237 — "All Brands" is a PINNED VIEW entry (aria `All Brands — every set in <year>`), the brand-unknown row is minted as `Unknown`; the selectors, the back-fill card assertion, the content-gate race on the pinned tap, and why the collapsed cards make a re-drill safer than a card tap
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
  `Sets in Unknown whose names start with '<v>' move here.`, and — only when
  the year carries SportLots ids — the toggle
  `SportLots has no brand for this — match its sets by name (starting with '<v>')`.
- **Candidates**: pill `N new on SportLots` (aria `… — review new sets`),
  modal heading `New on SportLots`, per root `Name for "<label>"` (value =
  `<prefix> <label>`), `Create set from "<label>"`, `Skip "<label>"`,
  footer status `N to look at` → `Created '<name>'`, Close
  `Close — the rest stay listed`. The new set's Base shows the `SL` pill.
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
   re-opening a column from its card. Card taps that are safe: the card at
   the top of the document with a `direction: UP`, UNCENTRED scroll (no
   headroom above it to centre with — R8 case 2).
