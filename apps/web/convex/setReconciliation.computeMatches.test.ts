/**
 * NEO-137 phase 2 — behaviour pin for `computeMatches`.
 *
 * WRITTEN BEFORE the ranked-candidates change, deliberately. `computeMatches`
 * is the matcher behind Base, inserts AND parallels for every set in the
 * catalog, and it had zero test coverage. Any change to it can silently
 * re-bucket thousands of existing rows on their next sync, so its current
 * auto-match output is nailed down here first; the NEO-137 work must leave
 * every assertion in the "auto-match output" block byte-identical.
 *
 * The three passes being pinned (convex/setReconciliation.ts):
 *   1. exact match on normalised strings           -> confidence 1.0
 *   2. bag-of-words (same token multiset, any order) -> confidence 0.95
 *   3. Levenshtein ratio < 0.40 AND token subset/superset -> 1 - ratio
 */

import { expect, test, describe } from "vitest";
import { computeMatches } from "./setReconciliation";

const item = (value: string, platformValue = `pv-${value}`) => ({
  value,
  platformValue,
});

describe("computeMatches — auto-match output (pinned)", () => {
  test("pass 1: exact match on normalised strings scores 1.0", () => {
    const r = computeMatches([item("Gold Refractor")], [item("gold refractor")]);
    expect(r.autoMatched).toHaveLength(1);
    expect(r.autoMatched[0].confidence).toBe(1.0);
    expect(r.autoMatched[0].displayName).toBe("Gold Refractor");
    expect(r.unmatchedBsc).toHaveLength(0);
    expect(r.unmatchedSl).toHaveLength(0);
  });

  test("pass 1: punctuation and whitespace are normalised away", () => {
    const r = computeMatches(
      [item("Artist's  Proofs")],
      [item("Artists Proofs")],
    );
    expect(r.autoMatched).toHaveLength(1);
    expect(r.autoMatched[0].confidence).toBe(1.0);
  });

  test("pass 1: token synonyms collapse (Autos -> autograph)", () => {
    const r = computeMatches([item("Autos")], [item("Autographs")]);
    expect(r.autoMatched).toHaveLength(1);
    expect(r.autoMatched[0].confidence).toBe(1.0);
  });

  test("pass 2: bag-of-words match on reordered tokens scores 0.95", () => {
    const r = computeMatches([item("Prizms Red")], [item("Red Prizm")]);
    expect(r.autoMatched).toHaveLength(1);
    expect(r.autoMatched[0].confidence).toBe(0.95);
  });

  test("pass 3: fuzzy subset match scores 1 - ratio, below 1.0", () => {
    const r = computeMatches(
      [item("Aqua Lava Refractors")],
      [item("Chrome Aqua Lava Refractor")],
    );
    expect(r.autoMatched).toHaveLength(1);
    expect(r.autoMatched[0].confidence).toBeGreaterThan(0.6);
    expect(r.autoMatched[0].confidence).toBeLessThan(1.0);
  });

  test("pass 3: a single differing meaningful token blocks the match", () => {
    // The subset/superset guard: "Red" vs "Chrome" are not sub/supersets, so
    // no pair is emitted however close the edit distance.
    const r = computeMatches([item("Red Prizm")], [item("Chrome Prizm")]);
    expect(r.autoMatched).toHaveLength(0);
    expect(r.unmatchedBsc).toHaveLength(1);
    expect(r.unmatchedSl).toHaveLength(1);
  });

  test("unrelated names stay unmatched on both sides", () => {
    const r = computeMatches([item("Dugout Collection")], [item("Stadium Club")]);
    expect(r.autoMatched).toHaveLength(0);
    expect(r.unmatchedBsc.map((i) => i.value)).toEqual(["Dugout Collection"]);
    expect(r.unmatchedSl.map((i) => i.value)).toEqual(["Stadium Club"]);
  });

  test("the emitted pair carries the original (unstripped) SL value", () => {
    const r = computeMatches(
      [item("Blue")],
      [item("Prizm Stars & Stripes Blue")],
      "Prizm Stars & Stripes",
    );
    expect(r.autoMatched).toHaveLength(1);
    // Display name comes from BSC; the SL side keeps its full marketplace name
    // so the UI shows what the operator would see on SportLots.
    expect(r.autoMatched[0].displayName).toBe("Blue");
    expect(r.autoMatched[0].sl.value).toBe("Prizm Stars & Stripes Blue");
  });

  test("earlier passes win: an exact match is not stolen by a fuzzy one", () => {
    const r = computeMatches(
      [item("Gold")],
      [item("Gold Refractor"), item("Gold")],
    );
    expect(r.autoMatched).toHaveLength(1);
    expect(r.autoMatched[0].confidence).toBe(1.0);
    expect(r.autoMatched[0].sl.value).toBe("Gold");
    expect(r.unmatchedSl.map((i) => i.value)).toEqual(["Gold Refractor"]);
  });

  test("empty inputs produce empty buckets, not a throw", () => {
    expect(computeMatches([], [])).toEqual({
      autoMatched: [],
      unmatchedBsc: [],
      unmatchedSl: [],
      slCandidates: [],
    });
  });

  /**
   * THE NEO-137 CASE, pinned as it behaves TODAY.
   *
   * BSC splits Dugout Collection Artist's Proofs into Series 1 and Series 2;
   * SportLots carries one combined set. Because every pass splices its match
   * out of BOTH arrays, the first BSC row to match consumes the single SL
   * item and the other is left with nothing. That is the bug NEO-137 exists
   * to address, and it is structural, not a threshold to tune.
   *
   * Auto-match output must NOT change — the fix is to additionally OFFER the
   * consumed SL set to the loser as a ranked candidate for an operator to
   * confirm.
   */
  test("a shared SL set is consumed by exactly one BSC row (the bug)", () => {
    const r = computeMatches(
      [
        item("Dugout Collection Artist's Proofs Series 1"),
        item("Dugout Collection Artist's Proofs Series 2"),
      ],
      [item("Dugout Collection Artists Proofs")],
    );

    expect(r.autoMatched).toHaveLength(1);
    expect(r.unmatchedSl).toHaveLength(0);
    // Exactly one of the two series is left with nothing to match.
    expect(r.unmatchedBsc).toHaveLength(1);
    expect(r.unmatchedBsc[0].value).toMatch(/Artist's Proofs Series [12]$/);
  });
});

/**
 * NEO-137 — ranked candidates.
 *
 * Strictly additive: everything pinned above must still hold. These cover the
 * new `slCandidates` bucket, which is what lets an operator create the
 * M-NB-rows-to-1-marketplace-set mapping explicitly.
 */
describe("computeMatches — ranked SL candidates (NEO-137)", () => {
  test("the losing series is offered the SL set that the winner consumed", () => {
    const r = computeMatches(
      [
        item("Dugout Collection Artist's Proofs Series 1"),
        item("Dugout Collection Artist's Proofs Series 2"),
      ],
      [item("Dugout Collection Artists Proofs")],
    );

    // Auto-match output is unchanged — see the pinned test above.
    expect(r.autoMatched).toHaveLength(1);
    expect(r.unmatchedBsc).toHaveLength(1);

    // ...but the row left with nothing is now offered the consumed set,
    // flagged so the UI can say "already linked to Series 2".
    expect(r.slCandidates).toHaveLength(1);
    const offered = r.slCandidates[0].candidates;
    expect(offered.length).toBeGreaterThan(0);
    expect(offered[0].sl.value).toBe("Dugout Collection Artists Proofs");
    expect(offered[0].alreadyMatched).toBe(true);
    expect(offered[0].confidence).toBeGreaterThan(0.5);
  });

  test("candidates are ranked best-first", () => {
    const r = computeMatches(
      [item("Dugout Collection Series 1")],
      [
        item("Stadium Club"),
        item("Dugout Collection Set A"),
        item("Dugout Collection Series 1 Proofs"),
      ],
    );
    const c = r.slCandidates[0].candidates;
    expect(c.length).toBeGreaterThan(1);
    for (let i = 1; i < c.length; i++) {
      expect(c[i - 1].confidence).toBeGreaterThanOrEqual(c[i].confidence);
    }
  });

  test("an unrelated SL set falls below the floor and is not offered", () => {
    const r = computeMatches(
      [item("Dugout Collection Artist's Proofs Series 1")],
      [item("Stadium Club")],
    );
    expect(r.slCandidates[0].candidates).toHaveLength(0);
  });

  test("rows that auto-matched get no candidate entry — only unmatched ones do", () => {
    // "Gold" pairs off cleanly; of the two series, one takes the single
    // shared SL set and the other is left over. Only the leftover gets
    // candidates.
    const r = computeMatches(
      [
        item("Gold"),
        item("Dugout Collection Artist's Proofs Series 1"),
        item("Dugout Collection Artist's Proofs Series 2"),
      ],
      [item("Gold"), item("Dugout Collection Artists Proofs")],
    );
    expect(r.slCandidates).toHaveLength(1);
    expect(r.slCandidates[0].bsc.value).toMatch(
      /Artist's Proofs Series [12]$/,
    );
    expect(r.slCandidates.map((e) => e.bsc.value)).not.toContain("Gold");
  });

  test("alreadyMatched is false for a set no auto-match claimed", () => {
    const r = computeMatches(
      [item("Dugout Collection Series 1")],
      [item("Dugout Collection Set A")],
    );
    const c = r.slCandidates[0].candidates;
    expect(c.length).toBeGreaterThan(0);
    expect(c.every((x) => x.alreadyMatched === false)).toBe(true);
  });

  test("candidates honour the SL base-prefix strip", () => {
    // Without the strip, "Blue" vs "Prizm Stars & Stripes Cracked Ice" scores
    // far too low to clear the floor.
    const r = computeMatches(
      [item("Blue")],
      [item("Prizm Stars & Stripes Blue Wave")],
      "Prizm Stars & Stripes",
    );
    const c = r.slCandidates[0]?.candidates ?? [];
    expect(c.length).toBeGreaterThan(0);
    // The offered item keeps its full marketplace name for display.
    expect(c[0].sl.value).toBe("Prizm Stars & Stripes Blue Wave");
  });
});
