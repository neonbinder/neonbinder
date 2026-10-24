import { demoCard } from "./data/demoStore";
import { playerNames, setLabel, variantLabel } from "./data/labels";
import type { Card } from "./data/types";

/**
 * A card as these read it: the view model's `Card`, or a demo fixture card
 * (My Binders still hands those in), read through the demo store by its id.
 */
type CaptionCard = Card | { id: string; setId: string };

function viewOf(card: CaptionCard): Card | null {
  return "setId" in card ? demoCard(card.id) : card;
}

/**
 * The line under a card thumbnail: season, set, and the insert or parallel
 * when there is one. "1993 Finest", "2024 Topps Chrome Gold Refractor",
 * "1996-97 Upper Deck Game Jerseys". A variation rides along in brackets so
 * two thumbnails never read the same.
 *
 * Base is left out by the variant's kind (its type's title, NEO-334), never
 * by matching the display text of a name.
 */
export function cardCaption(input: CaptionCard): string {
  const card = viewOf(input);
  if (!card) return "No longer in the catalog";
  const variant = card.variant.kind === "base" ? "" : ` ${variantLabel(card.variant)}`;
  const variation = card.cardVariation ? ` (${card.cardVariation})` : "";
  return `${setLabel(card.set)}${variant}${variation}`;
}

/** The second line of a card's identity slip: "#12 Jim Kelly". */
export function cardNumberLine(input: CaptionCard): string {
  const card = viewOf(input);
  if (!card) return "";
  const players = playerNames(card);
  return players ? `#${card.cardNumber} ${players}` : `#${card.cardNumber}`;
}
