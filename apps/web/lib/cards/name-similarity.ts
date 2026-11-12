/**
 * NEO-496 — how alike two player names are, and the one rule that turns
 * "alike" into an automatic link.
 *
 * Two pairings use it: BuySportsCards against SportLots in
 * `fetchCardChecklist` (since NEO-137), and a fetched card against a
 * publisher's checklist row (`lib/checklists/match-published-checklist.ts`).
 * Both link a card by a player name only when no number linked it, and both
 * must agree on what "the same name" means, so the score, the threshold and
 * the pairing rule live here once.
 *
 * Pure: no Convex, no DOM. Imported by convex/ and by lib/.
 *
 * ## The pairing rule (product rule 8)
 *
 * A name pair is made only when it is each side's ONE best answer at or above
 * `PLAYER_NAME_AUTO_LINK`: the left name's best right name is unique, and that
 * right name's best left name is this one. A tie on either side leaves both
 * unmatched for the operator; nothing is ever given to the first candidate in
 * list order. Rounds repeat over what is left, so a name whose best was claimed
 * by a better pair may still pair with its next best, and the answer never
 * depends on the order of either list.
 */

import { normalizeEntityName } from "../entities/normalize-name";

/**
 * The score at or above which two player names link without the operator.
 * 0.92 picks up a spelling slip ("Shohei Otani" ≈ "Shohei Ohtani", 0.98;
 * "Jose Ramires", 0.97) while keeping "Mike Trout" and "Mike Stanton" apart
 * (0.87). A nickname is NOT a slip: "Mike Trout" against "Michael Trout"
 * scores 0.89 and stays with the operator. Below it, a name is only offered.
 */
export const PLAYER_NAME_AUTO_LINK = 0.92;

/**
 * Jaro similarity between two strings, 0..1. The canonical algorithm: count
 * matching characters within a window of floor(max(|a|,|b|)/2)-1 positions,
 * then count transpositions.
 */
export function jaroSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;

  const matchDistance = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aMatches = new Array<boolean>(a.length).fill(false);
  const bMatches = new Array<boolean>(b.length).fill(false);
  let matches = 0;

  for (let i = 0; i < a.length; i++) {
    const start = Math.max(0, i - matchDistance);
    const end = Math.min(i + matchDistance + 1, b.length);
    for (let j = start; j < end; j++) {
      if (bMatches[j] || a[i] !== b[j]) continue;
      aMatches[i] = true;
      bMatches[j] = true;
      matches++;
      break;
    }
  }
  if (!matches) return 0;

  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aMatches[i]) continue;
    while (!bMatches[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }
  transpositions /= 2;

  return (
    (matches / a.length + matches / b.length + (matches - transpositions) / matches) / 3
  );
}

/**
 * Jaro-Winkler: Jaro plus a bonus for a shared prefix of up to four
 * characters. Compares the strings as given; see `playerNameScore` for two
 * raw names.
 */
export function jaroWinkler(a: string, b: string): number {
  const jaro = jaroSimilarity(a, b);
  let prefix = 0;
  const max = Math.min(4, a.length, b.length);
  for (let i = 0; i < max; i++) {
    if (a[i] === b[i]) prefix++;
    else break;
  }
  return jaro + prefix * 0.1 * (1 - jaro);
}

/**
 * Two raw player names, scored the way every pairing scores them: each
 * folded with `normalizeEntityName` (the key the players table uses), then
 * Jaro-Winkler. Either name empty after folding scores 0.
 */
export function playerNameScore(a: string, b: string): number {
  const na = normalizeEntityName(a);
  const nb = normalizeEntityName(b);
  if (!na || !nb) return 0;
  return jaroWinkler(na, nb);
}

export type NamePair = { leftIndex: number; rightIndex: number; score: number };

/**
 * Pair two lists of ALREADY-FOLDED names by Jaro-Winkler under the rule in
 * the header: a pair is each side's unique best at or above `threshold`,
 * rounds repeat over the leftovers, ties stay unmatched. `undefined` or an
 * empty name takes part in nothing. Indexes are positions in the lists given.
 *
 * Returned in left order.
 */
export function pairNamesBySimilarity(
  left: ReadonlyArray<string | undefined>,
  right: ReadonlyArray<string | undefined>,
  threshold: number = PLAYER_NAME_AUTO_LINK,
): NamePair[] {
  // Every score at or above the threshold, once. Sparse: a real set has a
  // handful of leftovers with a candidate each, not a full matrix.
  const byLeft = new Map<number, Array<{ r: number; score: number }>>();
  const byRight = new Map<number, Array<{ l: number; score: number }>>();
  left.forEach((ln, l) => {
    if (!ln) return;
    right.forEach((rn, r) => {
      if (!rn) return;
      const score = jaroWinkler(ln, rn);
      if (score < threshold) return;
      const ls = byLeft.get(l);
      if (ls) ls.push({ r, score });
      else byLeft.set(l, [{ r, score }]);
      const rs = byRight.get(r);
      if (rs) rs.push({ l, score });
      else byRight.set(r, [{ l, score }]);
    });
  });

  const takenLeft = new Set<number>();
  const takenRight = new Set<number>();
  const pairs: NamePair[] = [];
  /** The one best among the untaken, or null when none or a tie. */
  const uniqueBest = <T extends { score: number }>(
    list: readonly T[] | undefined,
    taken: (item: T) => boolean,
  ): T | null => {
    let best: T | null = null;
    let tied = false;
    for (const item of list ?? []) {
      if (taken(item)) continue;
      if (!best || item.score > best.score) {
        best = item;
        tied = false;
      } else if (item.score === best.score) {
        tied = true;
      }
    }
    return tied ? null : best;
  };

  for (;;) {
    const round: NamePair[] = [];
    for (const [l, list] of byLeft) {
      if (takenLeft.has(l)) continue;
      const best = uniqueBest(list, (c) => takenRight.has(c.r));
      if (!best) continue;
      const back = uniqueBest(byRight.get(best.r), (c) => takenLeft.has(c.l));
      if (back?.l !== l) continue;
      round.push({ leftIndex: l, rightIndex: best.r, score: best.score });
    }
    if (round.length === 0) break;
    for (const p of round) {
      takenLeft.add(p.leftIndex);
      takenRight.add(p.rightIndex);
      pairs.push(p);
    }
  }
  return pairs.sort((a, b) => a.leftIndex - b.leftIndex);
}
