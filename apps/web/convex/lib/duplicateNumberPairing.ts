/**
 * NEO-339 — BSC↔SportLots number pairing when a card number is NOT unique.
 *
 * `fetchCardChecklist` pairs a BSC card to the SportLots row carrying the same
 * card number. That is the strongest key there is, but it is not guaranteed
 * unique (product invariant 7): 2014 Topps Chrome "All Time Rookie Reprints"
 * prints #482 twice, Rickey Henderson and Tony Gwynn. The old index kept the
 * FIRST SportLots #482 it scraped, so both BSC #482s paired to it (one SL row in
 * two pairs) and the other SportLots #482 was offered as SL-only. Which player
 * won depended on scrape order.
 *
 * The rule implemented here, per card number:
 *
 *  - The number is AMBIGUOUS when either side carries more than one
 *    non-variation card under it. (NEO-189: SportLots files variations under
 *    the parent's number; those are paired by label elsewhere and never make a
 *    number ambiguous.)
 *  - An unambiguous number is not touched: the caller's number lookup runs
 *    exactly as before, including the one-card-each-with-different-players case,
 *    which pairs and raises a name/players conflict for the operator.
 *  - On an ambiguous number, a BSC card pairs with a SportLots row only when
 *    their rosters say the same thing (`playersKey`, the fold the merge and the
 *    pairing dialog already use) AND that is the only such row for the BSC card
 *    AND the only such BSC card for the row. Everything else is left unmatched
 *    for the operator to pair in the Match Cards dialog (invariant 8): a tie is
 *    never given to the first candidate.
 *  - Cards decided here are kept out of the fuzzy name fallback in both
 *    directions. The fallback picks the best Jaro-Winkler score with the first
 *    candidate winning a tie, which is exactly the guess this rule refuses.
 *
 * Higher-ranked pairings stay ahead of all of this: the operator's stored
 * pairing, BSC's sportlotsRef cross-reference and the NEO-189 variation pairing
 * are passed in as `shortCircuit`, the BSC cards they settle are never
 * number-matched, and the SportLots rows they take are not offered to anyone
 * else on the number.
 *
 * Variations have their own pass, `decideVariationPairs` below, and the same
 * exactly-one rule ends it: a variation that its label cannot pair is paired
 * by player only when that fits both ways.
 *
 * Pure: no Convex imports, so it is tested directly as well as through the
 * action.
 */

import { playersKey } from "../../lib/cards/card-name";
import {
  cardNumberStem,
  suggestVariationPairings,
} from "../../lib/cards/variations";

export type NumberPairingCard = {
  cardNumber: string;
  cardName?: string;
  players?: string[];
  isVariation?: boolean;
  cardVariation?: string;
};

export type DuplicateNumberDecisions<B, S> = {
  /**
   * BSC cards whose number lookup is settled here. A row means "pair with this
   * one"; `null` means "leave unmatched, and do not try the fuzzy fallback".
   * A BSC card absent from the map takes the ordinary number lookup.
   */
  decided: Map<B, S | null>;
  /** SportLots rows on an ambiguous number: never offered to the fuzzy fallback. */
  fuzzyExcluded: Set<S>;
};

/**
 * Who a card says it shows. The structured roster when there is one; otherwise
 * the card name as a single subject, which is what the fuzzy fallback already
 * reads a SportLots row by. No name at all is no evidence, and matches nothing.
 */
function rosterKey(card: NumberPairingCard): string {
  const players = (card.players ?? []).map((n) => n.trim()).filter(Boolean);
  if (players.length > 0) return playersKey(players);
  const name = (card.cardName ?? "").trim();
  return name ? playersKey([name]) : "";
}

function playersAgree(a: NumberPairingCard, b: NumberPairingCard): boolean {
  const ka = rosterKey(a);
  return ka !== "" && ka === rosterKey(b);
}

/**
 * The pairs where a left card's players match exactly one right card AND that
 * right card's players match exactly one left card. Anything else (no match,
 * or a tie on either side) is not paired: invariant 8.
 */
export function pairExactlyOneByPlayer<
  L extends NumberPairingCard,
  R extends NumberPairingCard,
>(left: readonly L[], right: readonly R[]): Map<L, R> {
  const out = new Map<L, R>();
  for (const l of left) {
    const mine = right.filter((r) => playersAgree(l, r));
    if (mine.length !== 1) continue;
    const claimants = left.filter((other) => playersAgree(other, mine[0]));
    if (claimants.length === 1) out.set(l, mine[0]);
  }
  return out;
}

export function decideDuplicateNumberPairs<
  B extends NumberPairingCard,
  S extends NumberPairingCard,
>(args: {
  bscCards: readonly B[];
  slCards: readonly S[];
  /**
   * The numbers a BSC card is looked up under, in order — its own number,
   * then the prefix-stripped one. The first that SportLots carries at all is
   * the one the lookup lands on, exactly as `get(n) || get(stripped)` did.
   */
  numberKeysOf: (bsc: B) => readonly string[];
  /** The SportLots row a higher-ranked rule already gives this BSC card. */
  shortCircuit: (bsc: B) => S | undefined;
}): DuplicateNumberDecisions<B, S> {
  const { bscCards, slCards, numberKeysOf, shortCircuit } = args;
  const decided = new Map<B, S | null>();
  const fuzzyExcluded = new Set<S>();

  const slAtNumber = new Map<string, S[]>();
  for (const c of slCards) {
    const rows = slAtNumber.get(c.cardNumber);
    if (rows) rows.push(c);
    else slAtNumber.set(c.cardNumber, [c]);
  }
  // The SportLots rows a number lookup may answer with: the non-variation rows
  // (NEO-189), or, when the number carries only variations, the first row —
  // the same row the caller's preferred-row index returns.
  const slCandidatesAt = (n: string): S[] => {
    const rows = slAtNumber.get(n) ?? [];
    const base = rows.filter((c) => !c.isVariation);
    return base.length > 0 ? base : rows.slice(0, 1);
  };

  const takenByShortCircuit = new Set<S>();
  const bscAtNumber = new Map<string, B[]>();
  for (const b of bscCards) {
    const sc = shortCircuit(b);
    if (sc) takenByShortCircuit.add(sc);
    const n = numberKeysOf(b).find((k) => slAtNumber.has(k));
    if (n === undefined) continue;
    const list = bscAtNumber.get(n);
    if (list) list.push(b);
    else bscAtNumber.set(n, [b]);
  }

  for (const [n, bscHere] of bscAtNumber) {
    const slRaw = slCandidatesAt(n);
    const bscBaseCount = bscHere.filter((b) => !b.isVariation).length;
    if (slRaw.length <= 1 && bscBaseCount <= 1) continue; // unambiguous

    for (const s of slRaw) fuzzyExcluded.add(s);
    const slOpen = slRaw.filter((s) => !takenByShortCircuit.has(s));
    const bscOpen = bscHere.filter((b) => !shortCircuit(b));
    // A BSC variation that fell through to the number is not one of the cards
    // the number names; on an ambiguous number it gets no guess.
    const byPlayer = pairExactlyOneByPlayer(
      bscOpen.filter((b) => !b.isVariation),
      slOpen,
    );
    for (const b of bscOpen) decided.set(b, byPlayer.get(b) ?? null);
  }

  return { decided, fuzzyExcluded };
}

export type VariationDecisions<B, S> = {
  /** BSC variation → the SportLots variation it pairs with. */
  pairs: Map<B, S>;
  /**
   * BSC variations that had SportLots variations to contend for and won none
   * of them: unmatched, with no number lookup and no fuzzy guess.
   */
  unmatched: Set<B>;
  /** SportLots variations that were contended for: never offered to the fuzzy fallback. */
  fuzzyExcluded: Set<S>;
  /** For the `variation_pairing` log line. */
  stats: { bscVariations: number; slVariations: number; byLabel: number; byPlayer: number };
};

/**
 * NEO-189 + NEO-339 — pair BSC variations to SportLots variations of the same
 * card.
 *
 * Neither side's number can do this on its own: BSC suffixes a variation
 * (`16b`), SportLots reuses the parent's number and tags the description
 * (`#16 … [ VAR ]`). So both sides are grouped by card-number STEM, the one
 * thing they agree on.
 *
 * Within a stem:
 *  1. Label first, via `suggestVariationPairings`: exact wording, then
 *     containment ("Action" in "Action Image").
 *  2. Then by player for what the labels left (a bare `[ VAR ]` has no label
 *     at all), exactly one both ways. 16b Pete Crow-Armstrong against the one
 *     unlabelled #16 VAR pairs; 122b and 122c, both Wyatt Langford, against
 *     one #122 VAR are a tie and all three stay unmatched (invariant 8).
 *  3. A BSC variation still unpaired while its stem HAD SportLots variations
 *     to contend for is decided unmatched: it must not fall back to the base
 *     row's number or to the fuzzy name match, which hands a tie to the first
 *     candidate. With no SportLots variation on the stem at all, nothing is
 *     decided and the card takes the ordinary path as before.
 *
 * A BSC variation is a row BSC flags (`isVariation`), or a suffixed number
 * whose bare stem BSC also lists ("16b" beside "16") when SportLots does not
 * list the suffixed number itself. The second reading is the stem rule in
 * `resolveVariationParents`: a group's bare-numbered row is the parent. It is
 * not applied without the bare sibling, because some sets suffix their BASE
 * cards (2021 Topps ships 1a, 1b, 1c and no #1).
 */
export function decideVariationPairs<
  B extends NumberPairingCard,
  S extends NumberPairingCard,
>(args: {
  bscCards: readonly B[];
  slCards: readonly S[];
}): VariationDecisions<B, S> {
  const { bscCards, slCards } = args;
  const slNumbers = new Set(slCards.map((c) => c.cardNumber));
  const bscNumbers = new Set(bscCards.map((c) => c.cardNumber));
  const isBscVariation = (c: B): boolean => {
    if (c.isVariation) return true;
    const stem = cardNumberStem(c.cardNumber);
    return (
      stem !== c.cardNumber.trim() &&
      bscNumbers.has(stem) &&
      !slNumbers.has(c.cardNumber)
    );
  };

  const group = <T extends NumberPairingCard>(
    cards: readonly T[],
    keep: (c: T) => boolean,
  ) => {
    const out = new Map<string, T[]>();
    for (const c of cards) {
      if (!keep(c)) continue;
      const stem = cardNumberStem(c.cardNumber);
      const list = out.get(stem);
      if (list) list.push(c);
      else out.set(stem, [c]);
    }
    return out;
  };
  const bscByStem = group(bscCards, isBscVariation);
  const slByStem = group(slCards, (c) => !!c.isVariation);

  const pairs = new Map<B, S>();
  const unmatched = new Set<B>();
  const fuzzyExcluded = new Set<S>();
  const stats = { bscVariations: 0, slVariations: 0, byLabel: 0, byPlayer: 0 };
  for (const list of bscByStem.values()) stats.bscVariations += list.length;
  for (const list of slByStem.values()) stats.slVariations += list.length;

  for (const [stem, bscVars] of bscByStem) {
    const slVars = slByStem.get(stem);
    if (!slVars?.length) continue;
    const byLabel = suggestVariationPairings(
      bscVars.map((c) => c.cardVariation ?? ""),
      slVars.map((c) => c.cardVariation ?? ""),
    );
    for (const pair of byLabel.pairs) {
      const b = bscVars[pair.leftIndex];
      const s = slVars[pair.rightIndex];
      if (b && s) {
        pairs.set(b, s);
        stats.byLabel++;
      }
    }
    const bscLeft = bscVars.filter((b) => !pairs.has(b));
    const taken = new Set(pairs.values());
    const slLeft = slVars.filter((s) => !taken.has(s));
    if (bscLeft.length === 0 || slLeft.length === 0) continue;

    for (const s of slLeft) fuzzyExcluded.add(s);
    const byPlayer = pairExactlyOneByPlayer(bscLeft, slLeft);
    for (const b of bscLeft) {
      const s = byPlayer.get(b);
      if (s) {
        pairs.set(b, s);
        stats.byPlayer++;
      } else {
        unmatched.add(b);
      }
    }
  }

  return { pairs, unmatched, fuzzyExcluded, stats };
}
