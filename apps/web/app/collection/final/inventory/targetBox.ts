/**
 * NEO-364 — the inventory's quick quantity entry: which box the Checklists
 * fields count and fill (the target box), and what "the quantity" of a card
 * in a box means. Pure, so both stores and the tests read the same rules.
 *
 * The target box (D8): `box=<id>` on the URL wins; else the collector's last
 * pick on this device (`localStorage`, one key per signed-in collector, one
 * for the demo); else Unsorted. An id that is not one of the collector's
 * boxes (deleted, a binder, the trade pile, someone else's) reads as
 * Unsorted, quietly. Every storage access is wrapped: a private window or
 * blocked site data just forgets the pick.
 *
 * The quantity (D9): how many PLAIN copies of the card sit in the box. A
 * plain line is raw (no grade), with no condition, serial, cost, location or
 * notes, and not up for trade; its pocket or row and its acquired date do
 * not matter. Everything else the card has in the box is read-only beside
 * the field ("+2 more: PSA 9, Raw Mint") and never touched by it.
 */

import { boxesOf, systemContainer } from "../data/store";
import type { Container, ContainerId, Copy } from "../data/types";

/** The URL param that names the target box (and, on the Inventory list, the rail's box). */
export const TARGET_BOX_PARAM = "box";

/**
 * The most copies a box line can hold. Keep in step with
 * `MAX_COPY_QUANTITY` in `convex/collection.ts` (a client module cannot
 * import the server's; the server refuses past it anyway).
 */
export const MAX_BOX_QUANTITY = 999;

/** The demo's key: one visitor, no account. */
export const DEMO_TARGET_BOX_KEY = "nb.demo.targetBox";

/**
 * Where the last pick is kept on this device: per collector in the app,
 * one key in the demo. `null` while the app does not know who is signed in
 * (nothing is read or kept until it does).
 */
export function targetBoxStorageKey(userId: string | null | undefined, demo: boolean): string | null {
  if (demo) return DEMO_TARGET_BOX_KEY;
  return userId ? `nb.inventory.targetBox.${userId}` : null;
}

/** The kept pick, or null (none, or storage refused). */
export function readStoredTargetBox(key: string | null): string | null {
  if (!key) return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Keeps the pick; a refusal is ignored (the pick still holds on the URL). */
export function writeStoredTargetBox(key: string | null, id: ContainerId): void {
  if (!key) return;
  try {
    window.localStorage.setItem(key, id);
  } catch {
    // Private window or blocked site data: the device forgets, the URL remembers.
  }
}

/**
 * The box the fields count: the URL's, else the kept one, else Unsorted (the
 * first box when the shelf has no Unsorted yet). Only a box can be the
 * target. `undefined` while the shelf loads.
 */
export function resolveTargetBox(
  containers: readonly Container[] | undefined,
  urlId: string | null,
  storedId: string | null,
): Container | undefined {
  if (!containers) return undefined;
  const boxes = boxesOf(containers);
  const find = (id: string | null) => (id ? boxes.find((b) => b.id === id) : undefined);
  return find(urlId) ?? find(storedId) ?? systemContainer(containers, "unsorted") ?? boxes[0];
}

// ---------------------------------------------------------------------------
// The quantity
// ---------------------------------------------------------------------------

/** True when a line is plain: raw, nothing noted about it, not up for trade (D9). */
export function isPlainLine(copy: Copy): boolean {
  return (
    !copy.graded &&
    !copy.condition &&
    !copy.serialNumber &&
    (copy.costBasis === undefined || copy.costBasis === null) &&
    !copy.location &&
    !copy.notes &&
    !copy.upForTrade
  );
}

/** A card's lines in one box. */
export function linesInBox(copies: readonly Copy[] | undefined, boxId: ContainerId | undefined): Copy[] {
  if (!copies || !boxId) return [];
  return copies.filter((c) => c.homeId === boxId && c.quantity > 0);
}

/** The field's value: the card's plain copies in the box, quantities summed. */
export function plainQuantity(lines: readonly Copy[]): number {
  return lines.reduce((n, c) => (isPlainLine(c) ? n + c.quantity : n), 0);
}

/** "PSA 9", "Raw Mint ×3", "Raw · 23/50", "Raw, for trade": one other line, short. */
function otherLineText(copy: Copy): string {
  let text = copy.graded
    ? `${copy.graded.grader} ${copy.graded.grade || "?"}`.trim()
    : copy.condition
      ? `Raw ${copy.condition}`
      : "Raw";
  if (copy.serialNumber) text += ` ${copy.serialNumber}`;
  if (copy.upForTrade) text += " for trade";
  else if (!copy.graded && !copy.condition && !copy.serialNumber) text += " with notes";
  if (copy.quantity > 1) text += ` ×${copy.quantity}`;
  return text;
}

/**
 * The card's other lines in the box, read-only beside the field: how many
 * copies and what they are. `null` when every copy there is plain.
 */
export function otherLines(lines: readonly Copy[]): { count: number; text: string } | null {
  const others = lines.filter((c) => !isPlainLine(c));
  if (others.length === 0) return null;
  const count = others.reduce((n, c) => n + c.quantity, 0);
  return { count, text: `+${count} more: ${others.map(otherLineText).join(", ")}` };
}

/**
 * What a typed value commits as: a whole number from 0 to the cap, or
 * `null` (blank or unreadable: the field goes back to what it was).
 */
export function parseQuantity(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  return Math.min(Number(trimmed), MAX_BOX_QUANTITY);
}

// ---------------------------------------------------------------------------
// The commit queue (D10)
// ---------------------------------------------------------------------------

/**
 * One page's writes, in the order the fields were left: a blur never waits
 * for the write before it, and the writes never pass one another. A task's
 * failure is its own; the queue carries on.
 */
export interface CommitQueue {
  enqueue<T>(task: () => Promise<T>): Promise<T>;
}

export function createCommitQueue(): CommitQueue {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    enqueue<T>(task: () => Promise<T>): Promise<T> {
      const run = tail.then(task);
      tail = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
  };
}
