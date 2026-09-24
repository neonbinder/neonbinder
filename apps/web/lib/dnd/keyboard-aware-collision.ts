import {
  pointerWithin,
  rectIntersection,
  type CollisionDetection,
} from "@dnd-kit/core";

/**
 * NEO-300 — which droppable a drag is over, for a pointer AND a keyboard.
 *
 * `pointerWithin` is the right answer for a mouse or a finger: the droppable
 * under the pointer. But dnd-kit derives the pointer from the event that
 * started the drag, and a KeyboardEvent has no coordinates, so a keyboard drag
 * reaches collision detection with `pointerCoordinates: null` — and
 * `pointerWithin` answers "nothing". Space, arrows, Space then drops every row
 * back where it started, with no error anywhere.
 *
 * With no pointer, the droppable the dragged item's rectangle overlaps most
 * wins. Pointer drags are exactly as before.
 *
 * Shared by every drag-and-drop dialog in the set builder
 * (ParallelGroupingModal, ReconciliationModal, CardPairingModal) so the three
 * cannot drift apart again.
 */
export const keyboardAwareCollision: CollisionDetection = (args) =>
  args.pointerCoordinates ? pointerWithin(args) : rectIntersection(args);
