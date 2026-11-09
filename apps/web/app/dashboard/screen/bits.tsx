import type { ReactNode } from "react";
import CardFace from "@/app/collection/prototypes/_shared/CardFace";
import "@/app/collection/final/cards/cards.css";
import { MARKETPLACES, type DashCard, type Marketplace } from "../fake-data";

/**
 * NEO-464 combined dashboard — the small pieces every block uses: a count
 * with its noun, a thumbnail at any width, the marketplace badge, and the
 * quiet section heading.
 */

/** "1 card", "5 cards". */
export function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * A card drawn at the width of its box (`w-*` on `className`). Always beside
 * its title, so the picture is hidden from a reader: the title names the card
 * once, not twice.
 */
export function Thumb({ card, className = "" }: { card: DashCard; className?: string }) {
  return (
    <div aria-hidden="true" className={`shrink-0 ${className}`}>
      <CardFace model={card.card} size="fill" />
    </div>
  );
}

/**
 * A card's full listing title (up to 80 characters). Clamped to `lines` on
 * screen, never cut in the text: a reader gets all of it, and so does a
 * hover (`title`).
 */
export function CardTitle({ card, lines = 2, className = "" }: { card: DashCard; lines?: 1 | 2 | 3; className?: string }) {
  const clamp = lines === 1 ? "truncate" : lines === 2 ? "line-clamp-2" : "line-clamp-3";
  return (
    <span title={card.title} className={`block min-w-0 break-words ${clamp} ${className}`}>
      {card.title}
    </span>
  );
}

/** The Want List mark: a star and short words, so it never rests on colour alone. */
export function WantFlag({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-bold text-neon-yellow-text ${className}`}>
      <span aria-hidden="true" className="mc-star">
        ★
      </span>
      On your Want List
    </span>
  );
}

/**
 * The distinct border a Want List card wears, beside its `WantFlag`. The
 * yellow's ink role, not the fill: the bright fill is about 1.2:1 on the light
 * theme's paper.
 */
export const WANT_RING = "rounded-[6%] outline-2 outline-offset-2 outline-dashed outline-neon-yellow-text";

/** A row: a small card and its full title, for lists where a card is named. */
export function CardLine({
  card,
  thumb = "w-10",
  wanted = false,
  children,
}: {
  card: DashCard;
  thumb?: string;
  wanted?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-start gap-2.5">
      <div className={wanted ? WANT_RING : undefined}>
        <Thumb card={card} className={thumb} />
      </div>
      <div className="min-w-0 flex-1 text-xs leading-snug">
        <CardTitle card={card} className="text-ink" />
        {wanted && <WantFlag className="mt-0.5" />}
        {children}
      </div>
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

/** A block's heading with an optional one-line note beside it. */
export function BlockHeading({ id, children, note }: { id: string; children: string; note?: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      <h2 id={id} className="text-2xl font-bold text-ink">
        {children}
      </h2>
      {note && <p className="text-sm text-ink-3">{note}</p>}
    </div>
  );
}

/** A rail panel's heading: smaller, with a note on the right. */
export function RailHeading({ id, children, note }: { id: string; children: string; note?: string }) {
  return (
    <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-3">
      <h2 id={id} className="text-lg font-bold text-ink">
        {children}
      </h2>
      {note && <p className="text-xs text-ink-3">{note}</p>}
    </div>
  );
}

export const RAIL_PANEL = "rounded-2xl border border-rule bg-raised p-4";

/** Anchors the order rows and problem lines jump between. */
export function orderAnchor(saleId: string): string {
  return `cb-order-${saleId}`;
}
