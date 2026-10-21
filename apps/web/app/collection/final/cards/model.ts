/**
 * NEO-350 — My Cards, the pure decisions behind the wall.
 *
 * Kept apart from the components so the two rules Jason cares about can be
 * pinned by tests: an un-Have never silently deletes more than one card, and
 * a card number two cards share never adds either until the collector says
 * which one is theirs.
 */

import type { Card, CardId, Copy } from "../../prototypes/_shared/data";
import type { RangePick } from "../../prototypes/p1/range";

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

export function tilePress(copiesInScope: Copy[]): TilePress {
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

/** Wanted cards first, each half kept in checklist order. */
export function wantedFirst(cards: Card[], isWanted: (cardId: CardId) => boolean): Card[] {
  const wanted: Card[] = [];
  const rest: Card[] = [];
  for (const c of cards) (isWanted(c.id) ? wanted : rest).push(c);
  return [...wanted, ...rest];
}

/** "Base #4 Reggie White" / "Blue Foil #4 Reggie White (Sliding)". */
export function wallName(card: Card, players: string): string {
  const row = card.variantPath.name ?? "Base";
  return `${row} #${card.cardNumber}${card.variation ? ` (${card.variation})` : ""} ${players}`;
}
