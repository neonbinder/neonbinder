---
name: selected-column-collapses-to-card
description: Selecting a row in a set-builder column collapses it to a card — the column header, search box and row list are GONE, but its action row (Sync / + Custom / Group Parallels) stays
metadata:
  type: feedback
---

Rule: after a spec clicks a row in an EntityColumn, do not assert or act on that
column's search box, its heading or any row in it: `EntitySelector.select()` calls
`setExpanded(false)` and the column renders only its collapsed card
(`aria-label "<Title>: <name> — change"`). What survives the collapse is
EntityColumn's own action row underneath: `Sync ...`, `Add custom <Title>` and
`extraActions` (`Group Parallels`). That is why the parallel-grouping specs can
press `+ Custom` and `Group Parallels` right after a row auto-selects, and why a
search-box locator that worked BEFORE the click finds nothing after it.

**Why:** a first NEO-293 draft scrolled to the Insert column's search box right
after a step that had clicked the insert row. The box did not exist any more; the
step would have burned its budget and failed on a healthy page.

**How to apply:**
- Need the list back? Click the collapsed card
  (`getByRole("button", { name: /<Title>: <name> — change/ })`, em-dash): that is
  what an operator does. Or re-drill with the helper.
- Need a deterministic page position whichever branch ran? Re-enter through the
  launch-gate heading (`Build set parameters using marketplace APIs` on the set
  builder) and work from there.
- Once something is typed into an input, locate it by its label / accessible name
  (`getByRole("combobox", { name: ... })`, `getByLabel`), not by placeholder text;
  the placeholder is not a name once a value is present.
