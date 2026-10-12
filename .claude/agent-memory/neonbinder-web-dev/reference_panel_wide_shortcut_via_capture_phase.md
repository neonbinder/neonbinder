---
name: panel-wide-shortcut-via-capture-phase
description: A "Ctrl+Enter saves from anywhere" shortcut over a panel holding a typeahead goes on onKeyDownCapture with stopPropagation, plus a nested-role=dialog guard; how to pin it in tests
metadata:
  type: reference
---

A panel-wide modifier shortcut (NEO-330 MissingTeamFixer: Ctrl/Cmd+Enter saves)
must be handled in `onKeyDownCapture` on the panel root, with
`preventDefault()` + `stopPropagation()`:

- TeamPicker's typeahead input handles `e.key === "Enter"` with NO modifier
  check, so a bubble-phase handler would let it pick a team AND save. React
  capture on an ancestor runs first, and `stopPropagation` there keeps the
  target's own React handler from running — through portals too, because React
  events follow the component tree (PickerPopover portals to document.body).
- `preventDefault` stops a focused button's native Enter activation (a chip
  toggling as well as saving).
- Guard nested dialogs: TeamPicker's NewTeamDialog is a portalled
  `role="dialog"` inside the same React tree. Skip when
  `target.closest('[role="dialog"]')` is non-null AND differs from
  `root.closest('[role="dialog"]')`. A body-portalled popover has a null
  closest dialog, so it still gets the shortcut.

Testing: the test-file stub can use a raw `<input>` (eslint ignores
`*.test.tsx`) with an `onKeyDown` spy; assert the spy is NOT called on
Ctrl+Enter. For the nested-dialog guard, append a DOM `role="dialog"` node
inside a React-rendered stub — React dispatches from the nearest fibered
ancestor. Mutation-check both (drop the guard, see the test go red).

Related: [[reference_autocomplete_list_is_a_fixed_layer]],
[[reference_inert_the_opener_behind_confirmdialog]].
