---
name: dndkit-row-control-is-a-handle-sibling
description: A real button inside a dnd-kit draggable row goes beside the handle (activator+listeners on a handle), every draggable needs an activator node, and a click-select on the handle is pointer-only (Enter starts a drag)
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

**Always set an activator node.** Without `setActivatorNodeRef`, dnd-kit's
KeyboardSensor accepts a Space or Enter keydown *bubbling up from any child*,
calls `preventDefault` and starts a drag. The child button never fires. Before
NEO-300, pressing Enter on the ✕ in `ParallelGroupingModal` picked up the row.
With an activator set, a keydown whose target is anything else is ignored.

If the drag container has to wrap buttons, as `ParallelGroupingModal`'s
`DraggableRow` does, pass `useDraggable({ attributes: { role: "group" } })`
and name it with `aria-labelledby` pointing at the row's text. Keyboard drag
still works, because it runs on `tabIndex` and the `onKeyDown` listener, not
on the role. Pin it in happy-dom with `fireEvent.keyDown(child, {code:"Enter"})`:
it returns `false` when a handler called `preventDefault`.

**A click handler on the handle is pointer-only.** `onClick` on the handle div
never fires from the keyboard: Enter and Space on it start a KeyboardSensor
drag. So with a KeyboardSensor registered, the drag IS the keyboard path; a
"click to select" mirror is not. Pass `DndContext accessibility={{
announcements, screenReaderInstructions }}` that describe that real drag
(dnd-kit's defaults speak the raw dnd id, "Picked up draggable item sl-11").
Resolve announcement labels from the id the same way the drop handler does
(NEO-325 `ReconciliationModal`). Before trusting a brief that says "drag is
pointer-only", grep for `useSensor(KeyboardSensor)`.

Related: [[maestro-web-text-is-direct-text-nodes-only]], [[dndkit-pointerwithin-kills-keyboard-drops]].
