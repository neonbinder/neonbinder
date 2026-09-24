---
name: dndkit-pointerwithin-kills-keyboard-drops
description: dnd-kit gives a KEYBOARD drag null pointerCoordinates, so bare pointerWithin never finds a drop target; use lib/dnd/keyboard-aware-collision, and prove it with lib/testing/keyboard-drag (a real keyboard drag in happy-dom)
metadata:
  type: reference
---

`pointerWithin` returns `[]` when `pointerCoordinates` is null. dnd-kit derives
those coordinates from the activator event (`getEventCoordinates`), and a
KeyboardEvent has none. So a `DndContext` with `collisionDetection={pointerWithin}`
and a `KeyboardSensor` lets a keyboard user lift and move an item, but `over`
is always null and the drop lands nowhere. Nothing errors.

The fix is shared: `lib/dnd/keyboard-aware-collision.ts` uses `pointerWithin`
when there is a pointer and `rectIntersection` when there isn't. Every
set-builder drag dialog uses it (ParallelGroupingModal, ReconciliationModal,
CardPairingModal since NEO-300). Never write bare `pointerWithin` again.

**Proving it in happy-dom (it CAN be done):** `lib/testing/keyboard-drag.ts`.
`stubLayout(new Map([[el, box]]))` gives the chosen elements a rectangle.
`keyboardDrag(handle, ["ArrowDown", ...])` presses Space, then the arrows
(25px each), then Space. This runs dnd-kit's own KeyboardSensor and collision
code, and the drop reaches the real `onDragEnd`. Two things are easy to miss:
- dnd-kit measures the DragOverlay wrapper's only CHILD, not the wrapper it
  styled. The stub falls back to the parent's inline `position: fixed` box.
- The KeyboardSensor attaches its keydown listener on a `setTimeout` after
  the lift, so wait one tick before sending the arrows.
Stub the droppable nodes (for sortable rows, the row node that `setNodeRef`
is on, not the handle) and the dragged item.

**Why:** found while adding keyboard parity to Group Parallels multi-select.
**How to apply:** any new or touched dnd-kit surface. Also set an activator
node ([[dndkit-row-control-is-a-handle-sibling]]). Without one, Space or Enter
on ANY child button starts a drag. CardPairingModal had exactly that bug:
Select, Link and Keep were dead from the keyboard. dnd-kit also mounts its own
`role="status"`, so `getByRole("status")` is ambiguous in those tests.
