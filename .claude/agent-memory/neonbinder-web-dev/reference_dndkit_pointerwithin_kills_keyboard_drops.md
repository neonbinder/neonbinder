---
name: dndkit-pointerwithin-kills-keyboard-drops
description: dnd-kit gives a KEYBOARD drag null pointerCoordinates, so collisionDetection={pointerWithin} returns [] and Space-arrows-Space never lands on a droppable; fall back to rectIntersection
metadata:
  type: reference
---

`pointerWithin` returns `[]` when `pointerCoordinates` is null. dnd-kit computes
those coordinates from the activator event (`getEventCoordinates`), and a
KeyboardEvent has none. So any `DndContext` using `collisionDetection={pointerWithin}`
with a `KeyboardSensor` lets a keyboard user lift a row and move it, but the drop
never lands: `over` is always null. The keyboard sensor still preventDefaults,
so nothing looks broken until you check where the row ended up.

Fix (NEO-300, ParallelGroupingModal `groupingCollision`):
`(args) => args.pointerCoordinates ? pointerWithin(args) : rectIntersection(args)`.
Pointer drags behave exactly as before.

**Why:** this was found while adding keyboard parity to multi-select in Group Parallels.
CardPairingModal and ReconciliationModal still used bare `pointerWithin` at
the time. Check them before claiming either one is keyboard-operable.

**How to apply:** any new or touched dnd-kit surface in apps/web. It can't be
proven in happy-dom (all rects are zero), so unit-test the collision function
directly with made-up rects. For a drop in a component test, capture the
`DndContext` props through a passthrough `vi.mock("@dnd-kit/core")` and call
`onDragEnd` yourself. A real keyboard lift (keyDown Space on the activator)
DOES render `DragOverlay` children in happy-dom, so an overlay can be asserted
that way. Also: dnd-kit mounts its own `role="status"` live region, so
`getByRole("status")` in those tests is ambiguous. Tag your own region with a data attribute.

Related: [[dndkit-row-control-is-a-handle-sibling]]
