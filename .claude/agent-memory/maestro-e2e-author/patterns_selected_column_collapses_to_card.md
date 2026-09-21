---
name: selected-column-collapses-to-card
description: Selecting a row in a set-builder column collapses it to a card — the column header, search box and row list are GONE, but its action row (Sync / + Custom / Group Parallels) stays; and how to get a deterministic page position across flow branches without knowing where each left the page
metadata:
  type: feedback
---

Rule: after a flow taps a row in an EntityColumn, do not anchor a later step
on that column's search box (`id: "Search <level>"`), its `<h2>` title or any
row in it — `EntitySelector.select()` calls `setExpanded(false)` and the
column renders only its collapsed card (`aria-label "<Title>: <name> — change"`).
What survives the collapse is EntityColumn's own action row underneath:
`Sync …`, `Add custom <Title>` and `extraActions` (`Group Parallels`). That is
why the parallel-grouping flows can press `+ Custom` and `Group Parallels`
right after a row auto-selects, and why a `below: id: "Search inserts"` that
worked BEFORE the tap finds nothing after it.

**Why:** a first NEO-293 draft scrolled UP to `id: "Search inserts"` right
after a step that had tapped the insert row. The box did not exist any more;
the step would have burned its budget and failed on a healthy page.

**How to apply:**
- Need the list back? Tap the collapsed card (`id: "<Title>: <name> — change"`,
  em-dash) — that is what an operator does. Or re-drill (the utils reset both
  scroll axes), which is what the long flows do after a dialog.
- Need a scroll position that is the same whichever branch of the flow ran?
  Scroll UP to the page's launch-gate heading (`.*Build set parameters using
  marketplace APIs.*` on the set builder): it is the first thing on the page,
  UP reaches it from anywhere and is a no-op when it is already visible, and
  everything else is then BELOW, so the next centring scroll is the ordinary
  DOWN case instead of a guess (README R5: a DOWN scroll cannot recover an
  anchor above it).
- An input's node text is its VALUE once something is typed (README →
  getNodeText), so a placeholder-text selector like `.*Search inserts.*`
  stops matching after `inputText` — use the aria-label `id:` for anything
  that runs after typing, and `below: id:` to keep an exact row match off the
  input's own value.
