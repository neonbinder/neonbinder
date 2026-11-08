import CardFace from "@/app/collection/prototypes/_shared/CardFace";
import { MARKETPLACES, type DashCard, type Marketplace } from "../_shared/data";

/**
 * NEO-464 prototype 1 ("To-do first") — the small pieces every section uses:
 * a thumbnail at any width, the marketplace badge, a count with its noun.
 */

/** "1 card", "5 cards". */
export function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** A card drawn at the width of its box (`w-*` on `className`). */
export function Thumb({ card, className = "", need = false }: { card: DashCard; className?: string; need?: boolean }) {
  return (
    <div className={`shrink-0 ${className}`}>
      <CardFace model={card.card} size="fill" state={need ? "need" : "owned"} />
    </div>
  );
}

const BADGE: Record<Marketplace, string> = {
  bsc: "bg-pick-blue border-pick-blue-rule text-pick-blue-ink",
  sportlots: "bg-pick-green border-pick-green-rule text-pick-green-ink",
  ebay: "bg-pick-amber border-pick-amber-rule text-pick-amber-ink",
};

/** Where the order came from: the short name on the pill, the full name for a reader. */
export function MarketBadge({ marketplace }: { marketplace: Marketplace }) {
  const m = MARKETPLACES[marketplace];
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-bold ${BADGE[marketplace]}`}>
      <span aria-hidden="true">{m.short}</span>
      <span className="sr-only">{m.name}</span>
    </span>
  );
}

/** Ids the hero's jump links land on. */
export const ANCHOR = {
  ship: "p1-out-the-door",
  look: "p1-needs-a-look",
  pulls: "p1-fresh-pulls",
} as const;

export function orderAnchor(saleId: string): string {
  return `p1-order-${saleId}`;
}
