/**
 * NEO-343 — the set builder checklist's search box: which cards a typed query
 * finds.
 *
 * A checklist can run to hundreds of rows in a virtualised list (only the rows
 * near the viewport exist in the DOM), so "scroll until you see #6a" is not a
 * way to reach a card — for an operator or for an E2E flow. The search box
 * narrows the list to the cards the query names.
 *
 * ## What the rule is
 *
 * - The query splits on whitespace into terms. EVERY term must match (AND),
 *   and a term matches when it matches ANY of the card's fields (OR).
 * - The card number is a PREFIX match: "6" finds 6, 6a and 60–69 but not 16,
 *   and "6a" does not also find 16a and 26a. Every other field is a
 *   substring match ("gronk" finds Gronkowski). A number is the strongest
 *   handle on a card, and a substring match on it buries the one card asked
 *   for among every number that merely contains the digits.
 * - Case- and accent-insensitive: "jose" finds "José".
 * - A leading "#" on a term is ignored, so "#6a" and "6a" both find card 6a —
 *   the row prints the number as "#6a", and that is what people type.
 *
 * ## What it reads: what the row shows
 *
 * The fields are the strings `CardChecklistItem` renders, so what you can see
 * on a row is what you can find it by:
 *
 * - numbers  — the card number (prefix match, see above);
 * - names    — the card name, each linked player's name, and the name each
 *              card printed for its players;
 * - teams    — each linked team's full name ("New England Patriots"); an
 *              operator-typed team with no row yet, as the row shows it;
 * - features — the attribute badges (RC, AU, RELIC, SP, SSP, #'d, …) and the
 *              words a collector uses for them ("rookie", "auto",
 *              "short print", "numbered"), the print run ("/99"), the
 *              variation text, the autograph line, and a cross-release card's
 *              home set;
 * - platform — which marketplace slots are filled ON NB'S OWN ROW: "BSC" /
 *              "BuySportsCards", "SL" / "SportLots". Nothing here queries a
 *              marketplace; it reads whether `platformData.<side>` is present.
 *              A term that exactly equals one of those four (after "#" and
 *              case folding) matches this field ONLY, so "sl" never finds
 *              "Islanders".
 *
 * Deliberately NOT read: `bscTeamName`. It is a marketplace's hint, never NB
 * data (CLAUDE.md product invariant), and the row does not render it.
 *
 * ## Keep in step
 *
 * `badgeTerms` mirrors `badgeLabel` in `components/SetSelector/CardChecklistItem.tsx`
 * (the row's badge text). CardChecklist.search.test.tsx renders the REAL row and
 * checks that every badge it prints is findable, so a new badge that is not
 * added here fails a test rather than silently becoming unsearchable.
 *
 * Pure: no Convex, no React. Team and player names arrive as lookups the
 * caller resolved.
 */

import { foldDiacritics } from "../entities/normalize-name";

/** The parts of a checklist row the search reads. Structural, so any row shape fits. */
export type SearchableCard = {
  cardNumber: string;
  cardName: string;
  playerIds?: readonly string[];
  /** NEO-254: the name each card PRINTED for its players. */
  playerLinks?: ReadonlyArray<{ playerId: string; nameOnCard: string }>;
  /** Typed player names that link to nobody yet. */
  pendingPlayerNames?: readonly string[];
  teamOnCardIds?: readonly string[];
  /** Typed team names no `teams` row exists for yet; the row prints them. */
  pendingTeamNames?: readonly string[];
  attributes?: readonly string[];
  isRookie?: boolean;
  isRelic?: boolean;
  printRun?: number;
  cardVariation?: string;
  features?: Record<string, string>;
  platformData: { bsc?: unknown; sportlots?: unknown };
  isCrossListed?: boolean;
  homeSetLabel?: string;
};

/**
 * Names the caller resolved for the ids on the cards: team id → full name
 * ("San Diego Padres", `teamFullName`), player id → the player's name. An id
 * missing from a map (not loaded yet, or past a read bound) simply contributes
 * nothing; the card's own name and printed names still match.
 */
export type CardSearchLookups = {
  teamNames: ReadonlyMap<string, string>;
  playerNames: ReadonlyMap<string, string>;
};

export const EMPTY_CARD_SEARCH_LOOKUPS: CardSearchLookups = {
  teamNames: new Map(),
  playerNames: new Map(),
};

/** The searchable strings of one card, by field. Display strings, not folded. */
export type CardSearchFields = {
  numbers: string[];
  names: string[];
  teams: string[];
  features: string[];
  platforms: string[];
};

/** Case- and accent-fold one string for comparison. */
export function foldSearchText(raw: string): string {
  return foldDiacritics(raw).toLowerCase();
}

/**
 * The query's terms, folded, with a leading "#" dropped from each. Empty when
 * the query has nothing to search for (blank, or only "#"s) — the caller then
 * shows every card.
 */
export function parseCardSearchTerms(query: string): string[] {
  return query
    .split(/\s+/)
    .map((term) => foldSearchText(term.replace(/^#+/, "")))
    .filter((term) => term.length > 0);
}

/**
 * The words one attribute badge answers to: the badge text the row prints,
 * plus the collector's words for it. Mirrors `badgeLabel` in
 * CardChecklistItem.tsx — see the module note.
 */
function badgeTerms(token: string): string[] {
  switch (token) {
    case "RC":
      return ["RC", "rookie"];
    case "AU":
      return ["AU", "auto", "autograph"];
    case "RELIC":
      return ["RELIC"];
    case "SP":
      return ["SP", "short print"];
    case "SSP":
      return ["SSP", "super short print"];
    case "NUM":
      return ["#'d", "numbered"];
    // The row prints the side the card IS on, not the token's name.
    case "unmatched-bsc":
      return ["SL only"];
    case "unmatched-sl":
      return ["BSC only"];
    default:
      return [token];
  }
}

/** Every searchable string of one card, grouped by field. */
export function cardSearchFields(
  card: SearchableCard,
  lookups: CardSearchLookups = EMPTY_CARD_SEARCH_LOOKUPS,
): CardSearchFields {
  const names: string[] = [];
  if (card.cardName) names.push(card.cardName);
  for (const id of card.playerIds ?? []) {
    const name = lookups.playerNames.get(id);
    if (name) names.push(name);
  }
  for (const link of card.playerLinks ?? []) {
    if (link.nameOnCard) names.push(link.nameOnCard);
  }
  for (const pending of card.pendingPlayerNames ?? []) {
    if (pending) names.push(pending);
  }

  const teams: string[] = [];
  for (const id of card.teamOnCardIds ?? []) {
    const name = lookups.teamNames.get(id);
    if (name) teams.push(name);
  }
  // As the row prints it: "Wisconsin Badgers (unconfirmed)".
  for (const pending of card.pendingTeamNames ?? []) {
    if (pending) teams.push(`${pending} (unconfirmed)`);
  }

  const features: string[] = [];
  for (const token of card.attributes ?? []) features.push(...badgeTerms(token));
  // The flags can be set without the matching badge token; a rookie is
  // findable as one either way.
  if (card.isRookie) features.push(...badgeTerms("RC"));
  if (card.isRelic) features.push(...badgeTerms("RELIC"));
  if (card.printRun) features.push(`/${card.printRun}`);
  if (card.cardVariation) features.push(card.cardVariation);
  // NEO-217: `features.autographed` is the one autograph truth the row prints
  // ("On-Card auto"); "None" is a stored "not an autograph" and prints nothing.
  const autographed = card.features?.autographed;
  if (autographed && autographed !== "None") {
    features.push(`${autographed} auto`, "autograph");
  }
  if (card.isCrossListed) {
    features.push("cross-release");
    if (card.homeSetLabel) features.push(card.homeSetLabel);
  }

  const platforms: string[] = [];
  if (card.platformData.bsc) platforms.push("BSC", "BuySportsCards");
  if (card.platformData.sportlots) platforms.push("SL", "SportLots");

  return {
    numbers: card.cardNumber ? [card.cardNumber] : [],
    names,
    teams,
    features,
    platforms,
  };
}

/**
 * One card, folded and ready to match: its number (prefix-matched) and every
 * other field in one string (substring-matched). The other fields are joined
 * with a newline, which no term can contain (terms split on whitespace), so a
 * term never matches across the seam between two fields.
 */
export type CardSearchHaystack = {
  number: string;
  text: string;
  /** The platform aliases of the filled slots, folded ("bsc", "sl", …). */
  platforms: readonly string[];
};

/**
 * A term that IS a platform's name or code reads as "linked on that
 * platform" and nothing else. Otherwise "sl" would also find every
 * "New York Islanders" card. A longer or different term ("slo",
 * "sportl") is an ordinary substring term.
 */
const PLATFORM_ALIASES: ReadonlySet<string> = new Set([
  "bsc",
  "buysportscards",
  "sl",
  "sportlots",
]);

export function cardSearchHaystack(
  card: SearchableCard,
  lookups: CardSearchLookups = EMPTY_CARD_SEARCH_LOOKUPS,
): CardSearchHaystack {
  const fields = cardSearchFields(card, lookups);
  return {
    number: foldSearchText(card.cardNumber ?? ""),
    text: foldSearchText(
      [
        ...fields.names,
        ...fields.teams,
        ...fields.features,
        ...fields.platforms,
      ].join("\n"),
    ),
    platforms: fields.platforms.map(foldSearchText),
  };
}

/**
 * Every term matches. A platform alias matches the platform field only;
 * any other term matches the start of the card number or somewhere in the
 * other fields. No terms matches everything.
 */
export function haystackMatches(
  haystack: CardSearchHaystack,
  terms: readonly string[],
): boolean {
  return terms.every((term) =>
    PLATFORM_ALIASES.has(term)
      ? haystack.platforms.includes(term)
      : haystack.number.startsWith(term) || haystack.text.includes(term),
  );
}

/** Convenience for one card: does `query` find it? */
export function cardMatchesSearch(
  card: SearchableCard,
  query: string,
  lookups: CardSearchLookups = EMPTY_CARD_SEARCH_LOOKUPS,
): boolean {
  return haystackMatches(
    cardSearchHaystack(card, lookups),
    parseCardSearchTerms(query),
  );
}
