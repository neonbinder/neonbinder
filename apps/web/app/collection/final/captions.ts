import { getSet, playerNames, setLabel, variantLabel, type Card } from "../prototypes/_shared/data";

/**
 * The line under a card thumbnail: season, set, and the insert or parallel
 * when there is one. "1993 Finest", "2024 Topps Chrome Gold Refractor",
 * "1996-97 Upper Deck Game Jerseys". A variation rides along in brackets so
 * two thumbnails never read the same.
 *
 * Base is left out by the variant type's kind (its title, NEO-334), never by
 * matching the display text of a name.
 */
export function cardCaption(card: Card): string {
  const variant = card.variantPath.type === "Base" ? "" : ` ${variantLabel(card.variantPath)}`;
  const variation = card.variation ? ` (${card.variation})` : "";
  return `${setLabel(getSet(card.setId))}${variant}${variation}`;
}

/** The second line of a card's identity slip: "#12 Jim Kelly". */
export function cardNumberLine(card: Card): string {
  return `#${card.cardNumber} ${playerNames(card)}`;
}
