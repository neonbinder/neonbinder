import type { ReactNode } from "react";
import CardFace from "@/app/collection/prototypes/_shared/CardFace";
import type { DashCard } from "../_shared/data";

/**
 * NEO-464 prototype 5 — small pieces both sides of the desk use.
 */

/** Keyboard focus, the house way: an outline, never a ring. */
export const FOCUS = "focus-outline";

/** A section's heading row: the vernacular title and a quiet note beside it. */
export function SectionHead({ id, title, aside }: { id: string; title: string; aside?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <h3 id={id} className="text-lg font-bold leading-tight text-ink">
        {title}
      </h3>
      {aside && <p className="text-sm text-ink-3">{aside}</p>}
    </div>
  );
}

/** "Gold Refractor /50", or "Base #11" for a base card. */
export function variantLine(card: DashCard): string {
  if (!card.variantName) return `Base #${card.cardNumber}`;
  return card.printRun ? `${card.variantName} ${card.printRun}` : card.variantName;
}

/**
 * A card with its caption under it: player, year + set, and the parallel or
 * insert name (or the base number). `numbered` puts the card number on the
 * set line, for lists where the number is how you hunt it (the Want List).
 * The face already carries the card's full name for a screen reader, so the
 * caption is hidden from it.
 */
export function CardTile({ card, numbered = false, extra }: { card: DashCard; numbered?: boolean; extra?: ReactNode }) {
  return (
    <figure className="flex min-w-0 flex-col gap-1.5">
      <CardFace model={card.card} size="fill" />
      <figcaption aria-hidden="true" className="min-w-0 text-xs leading-snug">
        <span className="block truncate font-semibold text-ink">{card.player}</span>
        <span className="block truncate text-ink-3">
          {card.setLabel}
          {numbered && ` #${card.cardNumber}`}
        </span>
        {(card.variantName || !numbered) && (
          <span className={`block truncate ${card.variantName ? "text-neon-purple-text" : "text-ink-2"}`}>
            {variantLine(card)}
          </span>
        )}
        {extra}
      </figcaption>
    </figure>
  );
}

/** A small card thumbnail at a fixed width (no caption). */
export function Thumb({ card, className = "w-10" }: { card: DashCard; className?: string }) {
  return (
    <span className={`block shrink-0 ${className}`}>
      <CardFace model={card.card} size="fill" />
    </span>
  );
}

/** "1 card", "34 cards". */
export function cards(n: number): string {
  return `${n} ${n === 1 ? "card" : "cards"}`;
}

const WEEKDAYS = /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/;

/** A relative-day label set mid-sentence: "Today" → "today", "Tuesday" stays. */
export function midSentence(label: string): string {
  return WEEKDAYS.test(label) ? label : label.charAt(0).toLowerCase() + label.slice(1);
}
