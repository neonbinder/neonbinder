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
 *
 * ## Two second chances, each under the same guard (NEO-312 fix round)
 *
 *   • SPELLING (hobby A9). A card whose who-key finds nothing — the two
 *     marketplaces spell a name differently ("Jose Ramirez Jr." against
 *     "José Ramírez") — links on its NUMBER (variation-aware, same tiers) when
 *     that number has exactly one card in the parallel's list, that card is
 *     reachable by number from no other insert card and wanted by nobody else,
 *     AND the names LOOSELY AGREE: after folding case, accents and
 *     punctuation and dropping the suffixes Jr/Sr/II/III/IV, at least one
 *     SURNAME (a name's last remaining word) is the same on both. A different
 *     player on the same number is a different card and is never linked —
 *     that would be a guess (invariant 7). Team cards are unaffected: they are
 *     keyed on the number alone to begin with.
 *   • EARLIER LINK (security 2). An ambiguous card whose candidates include
 *     exactly one ref that an OLD parallel card with the same key (`cardKey`)
 *     already held links to that ref: the operator's earlier pairing is the
 *     tiebreak, and a live link survives the rebuild. Two cards proposing the
 *     same ref both stay ambiguous.
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

/** How a link was made: the full key, the number alone, or an earlier link. */
export type LinkVia = "key" | "number" | "earlierLink";

export type CardLinkOutcome =
  | { kind: "linked"; card: FetchedParallelCard; via: LinkVia }
  | { kind: "ambiguous" }
  | { kind: "none" };

export type SideLinkResult = {
  /** One entry per NB card id, in input order. */
  outcomes: Map<string, CardLinkOutcome>;
  linked: number;
  ambiguous: number;
  none: number;
  /**
   * Fetched cards no insert card matched at all — not linked, and not a
   * candidate of any card (so an ambiguous card's rivals are NOT here). In
   * fetch order.
   */
  unclaimed: FetchedParallelCard[];
};

export type LinkOptions = {
  /**
   * `cardKey` of an OLD parallel card → the refs it held on this side. Read
   * only to break a tie between candidates (see the header).
   */
  earlierRefsByKey?: ReadonlyMap<string, ReadonlySet<string>>;
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

/**
 * The identity of an NB card for "is this the same card" questions ACROSS a
 * rebuild: its number, who is on it, and whether it is a variation. Two NB
 * rows with the same key are the same checklist entry as far as the build can
 * tell — used to find the old parallel card a new copy replaces (earlier-link
 * tiebreak, SKU carry). Never unique on its own: callers apply exactly-one.
 */
export function cardKey(card: Omit<LinkableNbCard, "id">): string {
  const who = identityOf({ ...card, id: "" });
  const whoKey =
    who.kind === "number" ? "#team" : who.kind === "players" ? `p:${who.key}` : `n:${who.key}`;
  return `${card.cardNumber.trim().toUpperCase()}\u0000${whoKey}\u0000${card.isVariation ? 1 : 0}`;
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

/** Name suffixes that are not a surname: "Ken Griffey Jr." → "griffey". */
const NAME_SUFFIXES: ReadonlySet<string> = new Set(["jr", "sr", "ii", "iii", "iv"]);

/** Each name's surname, folded: its last word once suffixes are dropped. */
function surnamesOf(names: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const name of names) {
    const words = nameKey(name)
      .split(" ")
      .filter((w) => w.length > 0 && !NAME_SUFFIXES.has(w));
    const last = words[words.length - 1];
    if (last) out.add(last);
  }
  return out;
}

/** A marketplace card's names: its roster, else its title split on joiners. */
function fetchedNames(f: FetchedParallelCard): string[] {
  const players = (f.players ?? []).map((n) => n.trim()).filter(Boolean);
  return players.length > 0 ? players : f.cardName.split(/\s*[/|&]\s*/);
}

/**
 * The spelling fallback's name test (see the header): at least one surname in
 * common between the NB card's printed names (else its title) and the
 * marketplace card's.
 */
function namesLooselyAgree(card: LinkableNbCard, f: FetchedParallelCard): boolean {
  const nbNames = card.namesOnCard.map((n) => n.trim()).filter(Boolean);
  const mine = surnamesOf(nbNames.length > 0 ? nbNames : [card.cardName]);
  if (mine.size === 0) return false;
  for (const surname of surnamesOf(fetchedNames(f))) {
    if (mine.has(surname)) return true;
  }
  return false;
}

/**
 * Is a FETCHED marketplace card a variation of another? The one reading the
 * link uses, exported (NEO-325) so the Base match probe picks the "first card"
 * of a marketplace set by the same rule.
 */
export function fetchedIsVariation(
  f: Pick<FetchedParallelCard, "isVariation" | "cardVariation">,
): boolean {
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
  options: LinkOptions = {},
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

  const numberTiers = (card: LinkableNbCard): Array<number[] | undefined> => {
    const s = stripPrefix(card.cardNumber, prefixes.nb);
    return [
      exact.get(card.cardNumber.trim()),
      stripped.get(s),
      card.isVariation ? stem.get(cardNumberStem(s).toUpperCase()) : undefined,
    ];
  };
  const sameVariation = (card: LinkableNbCard, i: number): boolean =>
    fetchedIsVariation(fetched[i]) === card.isVariation;

  /** The full key: number tier, variation, and who. */
  const candidatesOf = (card: LinkableNbCard): number[] => {
    const who = identityOf(card);
    const accept = (i: number): boolean =>
      sameVariation(card, i) && sameWho(who, fetched[i]);
    for (const tier of numberTiers(card)) {
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

  /** The number alone (variation-aware): the first tier with any hit. */
  const numberCandidatesOf = (card: LinkableNbCard): number[] => {
    for (const tier of numberTiers(card)) {
      const hits = (tier ?? []).filter((i) => sameVariation(card, i));
      if (hits.length > 0) return hits;
    }
    return [];
  };

  // Every NB card that COUNTS a fetched card among its candidates claims it,
  // not only the cards with a single candidate: a fetched card two NB cards
  // could both be is not known to be either's.
  const candidates = new Map<string, number[]>();
  const claimsByFetched = new Map<number, number>();
  // Reachable by NUMBER at any tier, from any card — the reverse end of the
  // spelling fallback's guard, deliberately wider than the forward end.
  const numberReach = new Map<number, number>();
  for (const card of nbCards) {
    const hits = candidatesOf(card);
    candidates.set(card.id, hits);
    for (const i of hits) {
      claimsByFetched.set(i, (claimsByFetched.get(i) ?? 0) + 1);
    }
    const reach = new Set<number>();
    for (const tier of numberTiers(card)) {
      for (const i of tier ?? []) if (sameVariation(card, i)) reach.add(i);
    }
    for (const i of reach) numberReach.set(i, (numberReach.get(i) ?? 0) + 1);
  }

  const outcomes = new Map<string, CardLinkOutcome>();
  const taken = new Set<number>();
  for (const card of nbCards) {
    const hits = candidates.get(card.id) ?? [];
    if (hits.length === 0) {
      outcomes.set(card.id, { kind: "none" });
    } else if (hits.length === 1 && claimsByFetched.get(hits[0]) === 1) {
      outcomes.set(card.id, { kind: "linked", card: fetched[hits[0]], via: "key" });
      taken.add(hits[0]);
    } else {
      // Two candidates for this card, or one candidate two cards want.
      outcomes.set(card.id, { kind: "ambiguous" });
    }
  }

  // Second chances. Each proposes; a fetched card proposed twice, or already
  // taken, or wanted by any card's full key, is refused for everyone.
  const proposals = new Map<number, Array<{ id: string; via: LinkVia }>>();
  const propose = (id: string, i: number, via: LinkVia) => {
    const list = proposals.get(i);
    if (list) list.push({ id, via });
    else proposals.set(i, [{ id, via }]);
  };
  for (const card of nbCards) {
    const outcome = outcomes.get(card.id);
    if (outcome?.kind === "none") {
      // Spelling: exactly one by number, reachable by number from this card
      // alone, no card's full key wants it, and a surname agrees — never a
      // different player on the same number.
      const byNumber = numberCandidatesOf(card);
      if (
        byNumber.length === 1 &&
        numberReach.get(byNumber[0]) === 1 &&
        (claimsByFetched.get(byNumber[0]) ?? 0) === 0 &&
        namesLooselyAgree(card, fetched[byNumber[0]])
      ) {
        propose(card.id, byNumber[0], "number");
      }
    } else if (outcome?.kind === "ambiguous" && options.earlierRefsByKey) {
      const earlier = options.earlierRefsByKey.get(cardKey(card));
      if (!earlier || earlier.size === 0) continue;
      const held = (candidates.get(card.id) ?? []).filter((i) =>
        earlier.has(fetched[i].ref),
      );
      if (held.length === 1) propose(card.id, held[0], "earlierLink");
    }
  }
  for (const [i, list] of proposals) {
    if (list.length !== 1 || taken.has(i)) continue;
    const { id, via } = list[0];
    outcomes.set(id, { kind: "linked", card: fetched[i], via });
    taken.add(i);
  }

  let linked = 0;
  let ambiguous = 0;
  let none = 0;
  for (const outcome of outcomes.values()) {
    if (outcome.kind === "linked") linked++;
    else if (outcome.kind === "ambiguous") ambiguous++;
    else none++;
  }
  const unclaimed = fetched.filter(
    (_, i) => !taken.has(i) && (claimsByFetched.get(i) ?? 0) === 0,
  );
  return { outcomes, linked, ambiguous, none, unclaimed };
}
