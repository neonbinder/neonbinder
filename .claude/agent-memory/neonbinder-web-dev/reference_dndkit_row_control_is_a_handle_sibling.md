---
name: dndkit-row-control-is-a-handle-sibling
description: To put a real button inside a dnd-kit draggable row, split the node — setNodeRef on the row box, setActivatorNodeRef + attributes + listeners on a handle div — and render the button as the handle's SIBLING, never its child
metadata:
  type: reference
---

dnd-kit's `attributes` give the element that spreads them `role="button"` and
`tabIndex=0`, and `listeners` start a drag from pointer and keyboard input
(Space and Enter start a keyboard drag). A `<button>` nested inside that element
disappears from the accessibility tree (a widget nested in a widget), and
pressing it can start a drag.

**Pattern** (NEO-300, `ReconciliationModal` `DraggableItem` `action` prop):
- `setNodeRef` goes on the outer row box, so the whole row, button area
  included, stays the droppable and sortable rect that pairing drops land on.
- `setActivatorNodeRef`, `{...attributes}`, `{...listeners}` and the
  click-to-select `onClick` go on an inner `flex-1` handle div (the badge and
  the name).
- The row's control is rendered after the handle, inside the row.

A test can pin it without layout: `handle = getByText(name).closest(".cursor-grab")`,
then assert `handle.parentElement.contains(button)`, `!handle.contains(button)`
and `handle.getAttribute("role") === "button"`.

`ParallelGroupingModal`'s `DraggableRow` still spreads `attributes` on the outer
div around its inner buttons. Its comment claims no role is set, but dnd-kit
sets one. Fix it the same way when that file is next reshaped.

Related: [[maestro-web-text-is-direct-text-nodes-only]].
