/**
 * NEO-350 — My Cards, the pure decisions behind the wall.
 *
 * Kept apart from the components so the two rules Jason cares about can be
 * pinned by tests: an un-Have never silently deletes more than one card, and
 * a card number two cards share never adds either until the collector says
 * which one is theirs.
 */

import { variantLabel } from "../data/labels";
import type { Card, CardId, Copy } from "../data/types";
import type { RangePick as AnyRangePick } from "./range";

type RangePick = AnyRangePick<Card>;

/**
 * What a press on a tile does, given the card's copies in scope.
 *
 * - none in scope: add one (to the target binder);
 * - exactly one line item holding exactly one card: remove that line (Undo
 *   puts it back);
 * - anything more (two line items, or one line of five): open the drawer and
 *   let the collector pick which copy goes. Never delete them all at once.
 */
export type TilePress =
  | { kind: "add" }
  | { kind: "remove"; copy: Copy }
  | { kind: "pick"; owned: number };

export function tilePress(copiesInScope: readonly Copy[]): TilePress {
  const live = copiesInScope.filter((c) => c.quantity > 0);
  if (live.length === 0) return { kind: "add" };
  if (live.length === 1 && live[0].quantity === 1) return { kind: "remove", copy: live[0] };
  return { kind: "pick", owned: live.reduce((n, c) => n + c.quantity, 0) };
}

/**
 * The cards a range adds: every number that matched exactly one card, plus,
 * for a number several cards share, only the ones the collector ticked.
 * A shared number nobody answered adds nothing; `unanswered` lists them.
 */
export function rangeSelection(
  range: RangePick | null,
  picks: ReadonlySet<CardId>,
): { cards: Card[]; unanswered: RangePick["shared"] } {
  if (!range) return { cards: [], unanswered: [] };
  const cards = [
    ...range.single,
    ...range.shared.flatMap((s) => s.cards.filter((c) => picks.has(c.id))),
  ];
  const unanswered = range.shared.filter((s) => !s.cards.some((c) => picks.has(c.id)));
  return { cards, unanswered };
}

/**
 * Everything a "run of numbers" box needs to decide, shared by My Cards'
 * Quick add and the Checklists tab's "Mark a range as Have" so the two can
 * never drift.
 *
 * Stop and ask (Jason's rule): while any shared number is unanswered the
 * whole run is `blocked`. Nothing is added, not even the numbers that
 * matched one card, so pressing Enter can never quietly skip one. The
 * collector picks theirs, or types `-N` to leave the number out.
 */
export interface RunPlan {
  /** Every card the run names (singles plus picks), owned or not. */
  cards: Card[];
  /** The ones not already owned: what committing would add. */
  toAdd: Card[];
  /** How many named cards are already owned and stay as they are. */
  already: number;
  /** Shared numbers with no card picked yet. */
  unanswered: RangePick["shared"];
  blocked: boolean;
}

export function runPlan(
  range: RangePick | null,
  picks: ReadonlySet<CardId>,
  owned: (cardId: CardId) => boolean,
): RunPlan {
  const { cards, unanswered } = rangeSelection(range, picks);
  const toAdd = cards.filter((c) => !owned(c.id));
  return { cards, toAdd, already: cards.length - toAdd.length, unanswered, blocked: unanswered.length > 0 };
}

/** The commit button while blocked: "Pick your #13 first". */
export function pickFirstLabel(plan: RunPlan): string | null {
  return plan.blocked ? `Pick your #${plan.unanswered[0].number} first` : null;
}

/** Why the run is held, and the two ways out. Null when nothing is held. */
export function blockedMessage(plan: RunPlan): string | null {
  if (!plan.blocked) return null;
  const n = plan.unanswered.length;
  return `${n === 1 ? "One number is" : `${n} numbers are`} on more than one card. Pick yours below and the run goes in. Got neither? Add -${plan.unanswered[0].number} to leave it out.`;
}

/** Wanted cards first, each half kept in checklist order. */
export function wantedFirst(cards: Card[], isWanted: (cardId: CardId) => boolean): Card[] {
  const wanted: Card[] = [];
  const rest: Card[] = [];
  for (const c of cards) (isWanted(c.id) ? wanted : rest).push(c);
  return [...wanted, ...rest];
}

/** "Base #4 Reggie White" / "Blue Foil #4 Reggie White (Sliding)". */
export function wallName(card: Card, players: string): string {
  const row = variantLabel(card.variant);
  const who = players ? ` ${players}` : "";
  return `${row} #${card.cardNumber}${card.cardVariation ? ` (${card.cardVariation})` : ""}${who}`;
}
