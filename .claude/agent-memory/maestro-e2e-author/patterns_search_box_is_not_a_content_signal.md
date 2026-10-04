---
name: search-box-is-not-a-content-signal
description: Since NEO-224 every open set-builder column renders its `Search <x>` box from its first frame (loading/empty/full), so `.*Search <x>.*` no longer means ">8 rows"/"sync done" — gate on the column LISTBOX `id: "<Title>"` or type-then-wait for the filtered row
metadata:
  type: feedback
---

Before NEO-224 `EntitySelector` rendered its search box only above 8 rows, and
dozens of flows (setup.yaml's cold Years/Manufacturers/Sets/Inserts/Parallels
gates, the cold drill util, paused-branch 240s gates, "view lists the year"
preconditions) used `extendedWaitUntil: ".*Search <x>.*"` as the CONTENT gate.
NEO-224 made the box unconditional (it is the column's combobox and the
cascade's focus target), so those gates pass in the first frame of a cold fetch
and the next row tap dies on its 17s lookup.

**Why:** a gate that passes before the thing it waits for is a false gate; the
seed (setup.yaml) is the costliest place to have one.

**How to apply — the replacement signals:**
- the column's LISTBOX, `id: "<Column title>"` (`Years`, `Sets`, `Inserts`,
  `${TYPE}s`): EntitySelector renders it only when the column has ≥1 row (no
  DOM id on it — the `aria-controls` id sits on a classless wrapper);
- type the target name FIRST (the filter survives rows landing), then wait for
  `{text: <row>, below: {id: "Search <x>"}}`; for an alternation with a dialog
  (`.*Reconcile Inserts.*|^Future Stars$`) type a PREFIX ("Future Star") so the
  box's own value can never full-match the row pattern;
- Manufacturers only (its listbox always holds the pinned All Brands entry):
  positive pinned-entry gate, then `notVisible` the idle empty text.
- "no search box ⇒ short column" fallbacks gated on the next column's header
  are dead code now and cost R10's ~7s `notVisible` poll — remove them, but
  first check what other outcome their guard caught
  ([[dead-branch-guards-can-cover-a-second-outcome]]).
Related: [[neo237-all-brands-view-and-unknown]], [[auto-id-shadows-aria-label]].
