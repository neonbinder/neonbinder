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
 * Pure: no Convex imports, so it is tested directly as well as through the
 * action.
 */

import { playersKey } from "../../lib/cards/card-name";

export type NumberPairingCard = {
  cardNumber: string;
  cardName?: string;
  players?: string[];
  isVariation?: boolean;
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
    const bscContenders = bscOpen.filter((b) => !b.isVariation);

    for (const b of bscOpen) {
      // A BSC variation that fell through to the number is not one of the
      // cards the number names; on an ambiguous number it gets no guess.
      if (b.isVariation) {
        decided.set(b, null);
        continue;
      }
      const mine = slOpen.filter((s) => playersAgree(b, s));
      if (mine.length !== 1) {
        decided.set(b, null);
        continue;
      }
      const claimants = bscContenders.filter((other) =>
        playersAgree(other, mine[0]),
      );
      decided.set(b, claimants.length === 1 ? mine[0] : null);
    }
  }

  return { decided, fuzzyExcluded };
}
