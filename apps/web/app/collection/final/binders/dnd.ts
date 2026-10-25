/**
 * Drag-and-drop helpers for My Binders, copied from prototype 2's page:
 * arrow keys hop between pockets (or box rows) during a keyboard drag, and a
 * drop target's id names where it is: a binder pocket by binder, page and
 * slot; a box row by box and row; a box's unsorted strip by box.
 */

import type { KeyboardCoordinateGetter, UniqueIdentifier } from "@dnd-kit/core";
import type { ContainerId } from "../data/types";
import type { SlotRef } from "./model";

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

/** A pocket's droppable id. */
export function pocketDropId(slot: SlotRef): string {
  return `pocket:${slot.binderId}:${slot.page}:${slot.slot}`;
}

/** A box row's droppable id (`row` 0-4). */
export function rowDropId(boxId: ContainerId, row: number): string {
  return `row:${boxId}:${row}`;
}

/** A box's "not sorted into a row yet" strip. */
export function unsortedDropId(boxId: ContainerId): string {
  return `unsorted:${boxId}`;
}

/** Where a drop on a box landed: a row (0-4), or `null` for the unsorted strip. */
export function parseRowId(id: UniqueIdentifier): { boxId: ContainerId; row: number | null } | null {
  const parts = String(id).split(":");
  if (parts[0] === "row" && parts.length === 3) return { boxId: parts[1], row: Number(parts[2]) };
  if (parts[0] === "unsorted" && parts.length === 2) return { boxId: parts[1], row: null };
  return null;
}

/** A dragged card from the hunt tray: `card:<cardId>`. */
export function cardDragId(cardId: string): string {
  return `card:${cardId}`;
}

/** A dragged copy already in the open box: `copy:<copyId>`. */
export function copyDragId(copyId: string): string {
  return `copy:${copyId}`;
}
