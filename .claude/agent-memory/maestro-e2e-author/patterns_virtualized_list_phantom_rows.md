---
name: virtualized-list-phantom-rows
description: react-virtuoso overscan rows report as 100% visible to Maestro and steal taps — anchor with below:, whose semantics are top-edge comparison + distance sort
metadata:
  type: project
---

**A tap on a row in the card checklist can silently land on unrelated page
chrome.** `CardChecklist.tsx` renders the list with
`increaseViewportBy={{ top: 200, bottom: 400 }}`, so react-virtuoso always
renders ~3–4 rows ABOVE its own scroll viewport. Those rows are CSS-clipped,
but their layout bounds are real and inside the browser viewport, so Maestro's
CDP hit-test calls them **100% visible**. `scrollUntilVisible` on a row then
matches a clipped row, logs `Visibility Percent: 1.0`, scrolls nothing, and the
tap lands wherever those phantom coordinates fall on the page.

**Why:** verified from CI run 33589796484's `screen-hierarchy` dump + `maestro.log`
(the tap went to "Edit card 73" at (687,284), visually the attributes panel).
Two related facts from the same source: `initialTopMostItemIndex` opens the list
at its END, and page-level scrolling does not move the list's own scroller — so
`scrollUntilVisible` can never bring a specific row into the container.

**How to apply:** anchor row selection with `below:` on the nearest
non-virtualised element above the list. Maestro's `below` is
`candidate.bounds.y > anchor.bounds.y` — **top edges**, not centres or bottoms —
and `relativeTo` returns survivors **sorted by ascending distance**, so index 0
is the topmost row below the anchor. (Both verified by `javap -c` on
`maestro/Filters.class` in `~/.maestro/lib/maestro-client.jar`; that is the way
to settle any selector-semantics question rather than guessing.) Worked example
with the geometry spelled out: STEP 7a of
`apps/web/.maestro/flows/set-selector/inserts-1996-score-one-nb-set-two-bsc-sources.yaml`.

Related: a `<input type="checkbox">`'s aria-label IS exposed as Maestro's
resource-id (precedent: `id: "Value for Reprint"`), but its CHECKED state is not
observable at all — assert the persisted effect instead. And maestro-web splits
node text at child ELEMENT boundaries only, so `<h2>Cards <span>(220)</span></h2>`
is two nodes while a `<p>` of text + JSX expressions is one.
