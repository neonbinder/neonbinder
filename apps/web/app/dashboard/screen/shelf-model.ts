/**
 * NEO-464 combined dashboard — the binders on the one shelf, what each holds,
 * what came in since the last visit, what a pocket page shows, and which of
 * your cards COULD FIT a smart binder (block 5).
 *
 * The shape only. Each binder arrives with its pockets already laid out by
 * whoever built it: the demo's fake shelf (`bindersOf` in `../fake-data`) or
 * the signed-in collection (`../real/useRealDashboard`). Nothing here reads
 * a source of its own.
 */

import type { DashCard } from "../dash-card";

/** One pocket on a page: a card you have, or an empty pocket (naming the card it waits for, when known). */
export type Pocket =
  | { kind: "card"; card: DashCard; isNew: boolean; key: string }
  | { kind: "empty"; key: string; card: DashCard | null };

/** One spine on the shelf. */
export interface ShelfBinder {
  /** Stable id; also the `?binder=` value that opens it. */
  id: string;
  name: string;
  kind: "manual" | "smart";
  /** A smart binder's rule in words ("Red Wings on the card"); null for a manual one, or one with no words yet. */
  ruleText: string | null;
  /** Physical cards filed in it (copies, stacks counted). */
  cardCount: number;
  /** Cards filed in it since the last visit, newest first. */
  newCards: DashCard[];
  /** Smart only: cards of yours its rule matches that are not filed in it yet. */
  couldFit: DashCard[];
  /**
   * How many could fit, when `couldFit` names only the first few (the
   * signed-in page hydrates just the strip's preview). `more`: there are
   * more than `count`. Absent: `couldFit` is all of them.
   */
  couldFitTotal?: { count: number; more: boolean };
  /** Only when a smart binder's rule names a checklist. */
  checklist: { have: number; total: number; percent: number } | null;
  /** The spine's vinyl and the stripe above its label. */
  vinyl: string;
  stripe: string;
  /**
   * Its pockets, nine to a page, in the order the pages show them. Empty
   * when not laid out (the signed-in shelf reads only the open binder's).
   */
  pockets: Pocket[];
  /**
   * A smart binder whose rule names a checklist: every card of it, in order,
   * and whether it is filed here. Null otherwise.
   */
  checklistCards: { card: DashCard; filed: boolean }[] | null;
}

export const POCKETS_PER_PAGE = 9;

/** House vinyl for a binder with no colours of its own (Main, or a binder with no label). */
export const HOUSE_VINYL = { vinyl: "#1f2a44", stripe: "#00c2ff" };

/**
 * The shelf's order, which is also how the capped shelf picks its binders:
 * binders with new cards first, most new first; then the fullest binders
 * (most cards). Ties keep the given order. Take the first 24 for the shelf;
 * fewer than that and they all stand.
 */
export function shelfOrder(binders: ShelfBinder[]): ShelfBinder[] {
  return [...binders].sort((a, b) => b.newCards.length - a.newCards.length || b.cardCount - a.cardCount);
}

/** The binder's pockets, nine to a page. */
export function pocketsOf(binder: ShelfBinder): Pocket[] {
  return binder.pockets;
}

/** A smart binder's checklist, card by card, when its rule names one (else null). */
export function checklistOf(binder: ShelfBinder): { card: DashCard; filed: boolean }[] | null {
  if (binder.kind !== "smart" || !binder.checklist) return null;
  return binder.checklistCards;
}

export function pageCount(binder: ShelfBinder): number {
  return Math.max(1, Math.ceil(pocketsOf(binder).length / POCKETS_PER_PAGE));
}
