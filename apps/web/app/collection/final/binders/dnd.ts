/**
 * Drag-and-drop helpers for My Binders, copied from prototype 2's page:
 * arrow keys hop between pockets during a keyboard drag, and a pocket's
 * droppable id names its binder, page and slot.
 */

import type { KeyboardCoordinateGetter, UniqueIdentifier } from "@dnd-kit/core";
import type { Binder } from "../../prototypes/_shared/data";
import type { SlotRef } from "../../prototypes/p2/model";

/** Arrow keys hop to the nearest drop target in that direction. */
export const pocketHop: KeyboardCoordinateGetter = (event, { context }) => {
  const dirs: Record<string, [number, number]> = {
    ArrowUp: [0, -1],
    ArrowDown: [0, 1],
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
  };
  const d = dirs[event.code];
  const { collisionRect, droppableRects, droppableContainers } = context;
  if (!d || !collisionRect) return undefined;
  event.preventDefault();
  const cx = collisionRect.left + collisionRect.width / 2;
  const cy = collisionRect.top + collisionRect.height / 2;
  let best: { left: number; top: number; width: number; height: number } | null = null;
  let bestScore = Infinity;
  for (const container of droppableContainers.getEnabled()) {
    const r = droppableRects.get(container.id);
    if (!r) continue;
    const dx = r.left + r.width / 2 - cx;
    const dy = r.top + r.height / 2 - cy;
    const along = dx * d[0] + dy * d[1];
    if (along <= 4) continue;
    const across = Math.abs(dx * d[1]) + Math.abs(dy * d[0]);
    const score = along + across * 2.5;
    if (score < bestScore) {
      bestScore = score;
      best = r;
    }
  }
  if (!best) return undefined;
  return {
    x: best.left + best.width / 2 - collisionRect.width / 2,
    y: best.top + best.height / 2 - collisionRect.height / 2,
  };
};

export function parseSlotId(id: UniqueIdentifier): SlotRef | null {
  const parts = String(id).split(":");
  if (parts[0] !== "pocket" || parts.length !== 4) return null;
  return { binderId: parts[1], page: Number(parts[2]), slot: Number(parts[3]) };
}

/** The copy in that pocket, or null when it is empty (or not a real pocket). */
export function slotCopyId(binder: Binder | undefined, slot: SlotRef): string | null {
  if (!binder || binder.kind !== "manual") return null;
  return binder.layout?.[slot.page]?.slots[slot.slot] ?? null;
}
