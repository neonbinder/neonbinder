---
name: dual-layout-rows-and-card-face-text
description: Tables that draw each row twice (wide columns + a phone cell) and CardFace thumbnails that print the player/set make getByText in a row a strict-mode error; use filter({visible:true}) or a cell by name
metadata:
  type: reference
---

Seen on the NEO-500 Pick List (`support/pick-list.ts`), and likely anywhere a
collection table hides columns with `max-md:hidden` and adds a `md:hidden`
"Card" cell for phones:

- **Every row's text exists twice in the DOM**, one copy display:none. `getByText`
  counts hidden elements, so strict mode trips. Wrap it in
  `locator.filter({ visible: true })` (the `seen()` helper). `getByRole` already
  skips hidden nodes, so a cell located by role needs no filter.
- **`CardFace` thumbnails print the player and set name as text** inside the
  "Bigger picture of …" button, so `row.getByText("Mike Trout")` hits the
  thumbnail as well. Scope by cell name instead: `row.getByRole("cell", { name: /^(#27 )?Mike Trout/ })`
  (wide Player column or the phone's Card cell). The same goes for a dialog
  that shows a big CardFace: assert its `img` by accessible name, not the subtitle text.
- **A `role="status"` with `empty:hidden` is NOT in the tree while empty**, so
  `toHaveText("")` waits forever on "element not found". Assert `toBeHidden()`
  and pair it with a positive assert (GUIDE R2).
- Phone vs wide differences there (column sort buttons vs a "Sort by" select,
  filters under "More filters", row click vs check-box tap) belong in the
  support helper behind `isMobile`, so specs stay single-path.

Related: [[negative-asserts-pass-on-a-dead-page]], [[runtime-names-need-regex-escaping]].
