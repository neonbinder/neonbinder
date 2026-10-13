---
name: ref-cleanup-sees-focus-before-removal
description: To park focus when a conditionally rendered control unmounts while focused, use a React 19 callback-ref cleanup — it runs while the node is still in the document; a parent's effect/layout-effect cleanup runs too late
metadata:
  type: reference
---

When a control rendered under `{count > 0 && …}` disappears while it has focus,
focus drops to `<body>`. To know it HAD focus:

- A callback ref returning a cleanup (React 19) runs during the deletion pass,
  before the host node is removed, so `document.activeElement === node` is
  still true there. Set a park flag; an effect keyed on the condition then
  focuses a stable target only if `activeElement` is body/null.
- A useLayoutEffect cleanup in the PARENT component runs after the child
  deletion has already happened (mutation pass handles child deletions first),
  so `activeElement` is already body — useless for this.
- happy-dom reproduces it: focus the button in `act`, rerender with the
  condition false, assert `document.activeElement`.

Used for CardChecklist's "N need you" pill (NEO-335). Related:
[[inert-the-opener-behind-confirmdialog]], [[focus-centres-and-scroll-margins-add]].
