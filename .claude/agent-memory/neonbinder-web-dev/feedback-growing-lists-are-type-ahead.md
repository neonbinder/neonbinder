---
name: feedback-growing-lists-are-type-ahead
description: Picking one row from a table that grows (leagues, teams, players) must be the shared Autocomplete type-ahead, never a pill row or radiogroup — Jason rejected the League pills in NEO-307
metadata:
  type: feedback
---

Choosing one item from a table that only gets bigger is a type-ahead combobox
(`components/primitives/Autocomplete.tsx`), not a row of pills, a radiogroup or
a "Show all" disclosure. Pills are fine only for a small FIXED set (Level,
yes/no answers).

**Why:** Jason, 2026-09-25 (NEO-307), on the New Team step's League pills after
bulk-loaded leagues made Baseball wrap across many lines: "This is a terrible
interface for selecting a league. It should be a type ahead select like we use
for lots of other teams and such things." The pill row had already needed a
collapse toggle and a height cap to survive — both symptoms of the wrong control.

**How to apply:** when a spec or an existing screen offers one-of-N over a
Convex table, use Autocomplete in picker mode (`openOnEmpty`, `selectedKey`,
`onDismiss`, `selectOnFocus`, `listMaxHeightClassName`): the field shows the
current answer at rest, focus opens the whole list, typing narrows it (name +
aliases), a create-from-typed option replaces any separate "+ New…" button, and
"none" stays an explicit option. Options are `<li role="option">`, so the
Maestro one-`<select>`-per-page hazard ([[reference_maestro_multi_select_unreachable]])
does not apply. Related: [[feedback-linking-uis-are-drag-and-drop]] for pairing UIs.
