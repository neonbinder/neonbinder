---
name: inner-scroller-clip-is-invisible-to-maestro
description: maestro-web never sees an `overflow-y-auto` clip — a row scrolled out of an inner list is "not visible" only once its rect leaves the 1024x629 viewport, and a row clipped by the list's bottom edge is "visible" while its rect is still inside the viewport. To assert an inner list's scroll position, put the WHOLE box in the viewport first and reason in page geometry.
metadata:
  type: project
---

Proven on NEO-276 (2026-09-13), `set-selector/column-reexpand-opens-at-selection.yaml`,
by reading `maestro-web.js` out of `maestro-client.jar` (2.8.0) and by the failure
hierarchy of the deliberate main-code run.

## The mechanism

`traverse()` emits `getBoundingClientRect()` for every node; the ONLY pruning is
`ViewHierarchyKt.filterOutOfBounds` against the viewport (<10% inside → gone, see
[[maestro-web-driver-primitives]] §3a). Nothing tests `overflow`, `clip`, or an
ancestor's scroll box. Measured: with an EntitySelector listbox (`max-h-[400px]
overflow-y-auto`, rows 50px on a 58px pitch) at y=106–506, the dump listed rows
down to y=583 — 77px past the list's bottom edge, painted nowhere — as visible.

So for a list that scrolls INSIDE the page:

* "row absent from the hierarchy" ⇔ its rect left the viewport — because the
  list scrolled it above the list's top (rect now above y=0) OR because the
  page put it below y=629. Only the first is the thing you want to assert.
* "row present" ⇔ rect inside the viewport — whether or not it is inside the
  list's fold.

## The recipe that makes the asserts mean what they say

1. Scroll the WINDOW so the whole inner box is inside the viewport (the
   EntityColumn fold is 400px: one driver swipe of `innerHeight/2 = 314px`
   from a fresh `/set-selector` puts the Sports list at y≈105–505). Anchor on
   the element just BELOW the box (`id: "Add custom <Column>"`, no
   `centerElement`), then assert the element just ABOVE it (`id: "Search
   <column>"`) is still on screen: both ends visible ⇒ the box is entirely
   inside the viewport ⇒ a missing row was scrolled away by the LIST.
2. Assert the row you expect in the fold with `below: {id: search input}` +
   `above: {id: custom button}` so nothing outside the column (the attributes
   panel's breadcrumb repeats the selected name) can satisfy it.
3. Assert the row you expect scrolled OUT (the first row, y<0) with the same
   anchors, and never alone — pair it with the positive asserts above.
4. Pick the target row so it is pruned on the broken build even with the
   page scrolled: viewport bottom at list-offset ≈524 here, so a row at
   index ≥10 (offset ≥580) is absent unless the list itself moved. And keep
   ≥3.5 rows AFTER it, or the list cannot centre it (clamps at max scroll).

Do not try to scroll the inner list from a flow: maestro-web's only scroll
primitive is `window.scroll` ([[maestro-web-driver-primitives]] §4).
That is `scrollUntilVisible`'s primitive; a raw `swipe` is a TOUCH drag and
does scroll the scroller under the finger — the dialog-body recipe is
[[touch-swipe-scrolls-a-dialog-body]].

Correction to [[entity-column-shapes-and-cold-sync]]: its closing line said a
dump "lists only nodes that are not clipped by an inner overflow-y-auto
container". Wrong — it lists only nodes inside the VIEWPORT; the clip is
irrelevant. That note's advice (filter a long column before dumping it) still
stands, because the list's lower rows are usually past y=629 anyway.
