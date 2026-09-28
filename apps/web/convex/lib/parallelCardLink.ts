/**
 * NEO-312 — which of the PARALLEL's marketplace cards is each of the INSERT's
 * NB cards, on one marketplace side.
 *
 * ## The model
 *
 * A parallel's checklist is a copy of its insert's NB cards. Each copy is then
 * re-linked, per side, to the parallel's OWN marketplace card, fetched from the
 * parallel's own ids. This module is the re-link: pure, no database, no
 * network, and no name from NB ever leaves it — it compares strings the NB card
 * RECORDED from a marketplace at creation (its card number and the names
 * printed on it) against the strings the parallel's fetch returned.
 *
 * ## The key (planner's call M1, option b)
 *
 *   1. The card NUMBER — exact first; then with each side's `cardNumberPrefix`
 *      stripped (the insert's prefix from the NB number, the parallel's from
 *      the fetched one); and, for a VARIATION only, the number's stem
 *      (`11b` ↔ SportLots' `11`), because the two marketplaces number a
 *      variation differently and neither spelling survives the other.
 *   2. WHO is on the card — `playersKey` of the names printed on it
 *      (`playerLinks[].nameOnCard` plus any still-pending names), else
 *      `nameKey(cardName)`. A team card (no names, a team on it) is keyed on
 *      its number alone.
 *   3. Whether it is a VARIATION, on both ends. SportLots files a card and its
 *      variations under one number with one player, so without this every base
 *      card that has a variation would match two SportLots rows and fail the
 *      guard below.
 *
 * The first number tier that yields any candidate is the one used; a later
 * tier never widens an earlier one.
 *
 * ## The guard, on BOTH ends (invariant 7)
 *
 * Card numbers are never unique at any scope. A card links on a side only when
 * it has EXACTLY ONE candidate there AND that candidate is claimed by no other
 * NB card. Anything else leaves the card unlinked on that side and counts it
 * `ambiguous` — never a guess, never first-wins.
 */

import { cardNumberStem } from "../../lib/cards/variations";
import { nameKey, playersKey } from "../../lib/cards/card-name";

/** One NB card of the insert, reduced to what the key reads. */
export type LinkableNbCard = {
  /** Opaque to this module; echoed back in the result. */
  id: string;
  cardNumber: string;
  cardName: string;
  /** `playerLinks[].nameOnCard` then `pendingPlayerNames`, as stored. */
  namesOnCard: string[];
  /** No names on the card and at least one team on it. */
  isTeamCard: boolean;
  /** Linked to a parent card, or carrying a variation name. */
  isVariation: boolean;
  cardVariation?: string;
};

/** One card the parallel's fetch returned on one side. */
export type FetchedParallelCard = {
  /** The marketplace's identity for the card (BSC id, SportLots description). */
  ref: string;
  /** The marketplace set it came from — one of the parallel's own ids. */
  setId?: string;
  cardNumber: string;
  cardName: string;
  players?: string[];
  isVariation?: boolean;
  cardVariation?: string;
  printRun?: number;
};

export type CardLinkOutcome =
  | { kind: "linked"; card: FetchedParallelCard }
  | { kind: "ambiguous" }
  | { kind: "none" };

export type SideLinkResult = {
  /** One entry per NB card id, in input order. */
  outcomes: Map<string, CardLinkOutcome>;
  linked: number;
  ambiguous: number;
  none: number;
};

type Identity =
  | { kind: "number" }
  | { kind: "players"; key: string; nameKey: string }
  | { kind: "name"; key: string };

function identityOf(card: LinkableNbCard): Identity {
  const names = card.namesOnCard.map((n) => n.trim()).filter(Boolean);
  if (names.length > 0) {
    return {
      kind: "players",
      key: playersKey(names),
      nameKey: nameKey(card.cardName),
    };
  }
  if (card.isTeamCard) return { kind: "number" };
  return { kind: "name", key: nameKey(card.cardName) };
}

function sameWho(id: Identity, f: FetchedParallelCard): boolean {
  if (id.kind === "number") return true;
  const fetchedPlayers = (f.players ?? []).map((n) => n.trim()).filter(Boolean);
  if (id.kind === "players") {
    return fetchedPlayers.length > 0
      ? playersKey(fetchedPlayers) === id.key
      : nameKey(f.cardName) === id.nameKey;
  }
  // A card with no recorded names: its title is the only string it kept.
  return id.key.length > 0 && nameKey(f.cardName) === id.key;
}

function fetchedIsVariation(f: FetchedParallelCard): boolean {
  return f.isVariation === true || !!f.cardVariation?.trim();
}

/** Upper-cased, trimmed; with `prefix` removed from the front when present. */
function stripPrefix(cardNumber: string, prefix: string | undefined): string {
  const n = cardNumber.trim().toUpperCase();
  const p = prefix?.trim().toUpperCase();
  return p && n.startsWith(p) && n.length > p.length ? n.slice(p.length) : n;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const bucket = map.get(key);
  if (bucket) bucket.push(value);
  else map.set(key, [value]);
}

/**
 * Link every NB card to at most one of `fetched`, under the guard.
 *
 * `prefixes.nb` is the `cardNumberPrefix` in force on the INSERT's chain,
 * `prefixes.fetched` the one on the PARALLEL's. Either may be absent.
 */
export function linkCardsToSide(
  nbCards: readonly LinkableNbCard[],
  fetched: readonly FetchedParallelCard[],
  prefixes: { nb?: string; fetched?: string } = {},
): SideLinkResult {
  // Three indexes over the fetched list, one per number tier. Indexed by
  // POSITION so two fetched rows that happen to share a ref (SportLots'
  // indistinguishable descriptions) stay two candidates and fail the guard.
  const exact = new Map<string, number[]>();
  const stripped = new Map<string, number[]>();
  const stem = new Map<string, number[]>();
  fetched.forEach((f, i) => {
    push(exact, f.cardNumber.trim(), i);
    const s = stripPrefix(f.cardNumber, prefixes.fetched);
    push(stripped, s, i);
    push(stem, cardNumberStem(s).toUpperCase(), i);
  });

  const candidatesOf = (card: LinkableNbCard): number[] => {
    const who = identityOf(card);
    const accept = (i: number): boolean => {
      const f = fetched[i];
      return (
        fetchedIsVariation(f) === card.isVariation && sameWho(who, f)
      );
    };
    const s = stripPrefix(card.cardNumber, prefixes.nb);
    const tiers: Array<number[] | undefined> = [
      exact.get(card.cardNumber.trim()),
      stripped.get(s),
      card.isVariation ? stem.get(cardNumberStem(s).toUpperCase()) : undefined,
    ];
    for (const tier of tiers) {
      const hits = (tier ?? []).filter(accept);
      if (hits.length === 0) continue;
      if (hits.length > 1 && card.isVariation && card.cardVariation?.trim()) {
        // Several variations of one card by one player: the variation's own
        // name is the only thing left that can tell them apart, and it has to
        // leave exactly one.
        const label = nameKey(card.cardVariation);
        const named = hits.filter(
          (i) => nameKey(fetched[i].cardVariation ?? "") === label,
        );
        if (named.length === 1) return named;
      }
      return hits;
    }
    return [];
  };

  // Every NB card that COUNTS a fetched card among its candidates claims it,
  // not only the cards with a single candidate: a fetched card two NB cards
  // could both be is not known to be either's.
  const candidates = new Map<string, number[]>();
  const claimsByFetched = new Map<number, number>();
  for (const card of nbCards) {
    const hits = candidatesOf(card);
    candidates.set(card.id, hits);
    for (const i of hits) {
      claimsByFetched.set(i, (claimsByFetched.get(i) ?? 0) + 1);
    }
  }

  const outcomes = new Map<string, CardLinkOutcome>();
  let linked = 0;
  let ambiguous = 0;
  let none = 0;
  for (const card of nbCards) {
    const hits = candidates.get(card.id) ?? [];
    if (hits.length === 0) {
      outcomes.set(card.id, { kind: "none" });
      none++;
    } else if (hits.length === 1 && claimsByFetched.get(hits[0]) === 1) {
      outcomes.set(card.id, { kind: "linked", card: fetched[hits[0]] });
      linked++;
    } else {
      // Two candidates for this card, or one candidate two cards want.
      outcomes.set(card.id, { kind: "ambiguous" });
      ambiguous++;
    }
  }
  return { outcomes, linked, ambiguous, none };
}
