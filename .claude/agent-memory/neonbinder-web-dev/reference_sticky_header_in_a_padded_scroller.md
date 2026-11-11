---
name: sticky-header-in-a-padded-scroller
description: A sticky table header inside a padded overflow box sticks at the padding edge (rows show above it) and a <thead> background does not paint; fix the scroller and put sticky + bg on each th
metadata:
  type: reference
---

Seen on the NEO-478 publisher's-checklist preview (NEO-482 fix): `thead.sticky.top-0.bg-*`
inside a dialog body that was `overflow-y-auto p-5`.

- `top-0` sticks at the scroller's padding edge, not its border edge, so a
  `p-5` scroller leaves a 20px strip above the header that rows scroll
  through. Move the padding onto an inner wrapper; keep the scroller bare.
- A background on `<thead>` did not paint under the stuck row (Chrome,
  Tailwind preflight's `border-collapse: collapse`). Put `sticky top-0 z-10
  bg-<role>` on every `th`, and switch the table to `border-separate
  border-spacing-0` with the rules on the cells (a collapsed border does not
  travel with a sticky cell). Row rules: `[&>td]:border-b
  [&:last-child>td]:border-b-0` on the `tr`.
- Rounding the table's frame: `overflow-clip`, never `overflow-hidden` —
  hidden makes the frame a scroll container and the header sticks to it
  (i.e. never moves).

The header was "sticky" all along; it only looked broken. Check the stuck
position in a screenshot before assuming the wrong scroller.
