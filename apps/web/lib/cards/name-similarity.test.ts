import { describe, expect, test } from "vitest";
import {
  NAME_PAIRING_MAX_CELLS,
  NAME_PAIRING_MAX_WORK,
  PLAYER_NAME_AUTO_LINK,
  jaroSimilarity,
  jaroWinkler,
  jaroWinklerLengthBound,
  pairNamesBySimilarity,
  playerNameScore,
} from "./name-similarity";

describe("jaroSimilarity / jaroWinkler (moved from convex/selectorOptions.ts, unchanged)", () => {
  test("identical and empty strings", () => {
    expect(jaroSimilarity("abc", "abc")).toBe(1);
    expect(jaroSimilarity("", "abc")).toBe(0);
    expect(jaroSimilarity("abc", "")).toBe(0);
    expect(jaroWinkler("", "")).toBe(1);
  });

  test("the textbook pairs", () => {
    expect(jaroSimilarity("martha", "marhta")).toBeCloseTo(0.9444, 4);
    expect(jaroWinkler("martha", "marhta")).toBeCloseTo(0.9611, 4);
    expect(jaroWinkler("dwayne", "duane")).toBeCloseTo(0.84, 2);
    expect(jaroWinkler("dixon", "dicksonx")).toBeCloseTo(0.8133, 4);
  });

  test("no characters in common scores 0", () => {
    expect(jaroWinkler("abc", "xyz")).toBe(0);
  });
});

describe("playerNameScore", () => {
  test("folds both names the way the players table does", () => {
    expect(playerNameScore("José Ramírez", "Jose Ramirez")).toBe(1);
    expect(playerNameScore("KEN GRIFFEY JR.", "Ken Griffey Jr")).toBe(1);
  });

  test("spelling slips clear the threshold; other players and nicknames do not", () => {
    expect(playerNameScore("Shohei Ohtani", "Shohei Otani")).toBeGreaterThanOrEqual(
      PLAYER_NAME_AUTO_LINK,
    );
    expect(playerNameScore("Jose Ramirez", "Jose Ramires")).toBeGreaterThanOrEqual(
      PLAYER_NAME_AUTO_LINK,
    );
    expect(playerNameScore("Mike Trout", "Mike Stanton")).toBeLessThan(PLAYER_NAME_AUTO_LINK);
    expect(playerNameScore("Mike Trout", "Michael Trout")).toBeLessThan(PLAYER_NAME_AUTO_LINK);
  });

  test("a name that folds to nothing scores 0", () => {
    expect(playerNameScore("", "Mike Trout")).toBe(0);
    expect(playerNameScore("...", "Mike Trout")).toBe(0);
  });

  test("the threshold is 0.92", () => {
    expect(PLAYER_NAME_AUTO_LINK).toBe(0.92);
  });
});

describe("pairNamesBySimilarity", () => {
  test("pairs each left name with its own best", () => {
    expect(
      pairNamesBySimilarity(["mike trout", "mookie betts"], ["mookie bets", "mike troutt"]),
    ).toEqual([
      { leftIndex: 0, rightIndex: 1, score: expect.any(Number) },
      { leftIndex: 1, rightIndex: 0, score: expect.any(Number) },
    ]);
  });

  test("nothing at or above the threshold pairs nothing", () => {
    expect(pairNamesBySimilarity(["mike trout"], ["mike stanton"])).toEqual([]);
  });

  test("a tie on the right side (two equal names) leaves the left unmatched", () => {
    expect(pairNamesBySimilarity(["mike trout"], ["mike trout", "mike trout"])).toEqual([]);
  });

  test("two left names wanting one right name equally leave it unmatched", () => {
    expect(pairNamesBySimilarity(["mike trout", "mike trout"], ["mike troutt"])).toEqual([]);
  });

  test("the better of two left names wins a contested right name; the other takes its next best", () => {
    // "shohei ohtani" scores higher against "shohei ohtani" than "shohei otani" does.
    const pairs = pairNamesBySimilarity(
      ["shohei otani", "shohei ohtani"],
      ["shohei ohtani", "shohei ohtanii"],
    );
    expect(pairs.map((p) => [p.leftIndex, p.rightIndex])).toEqual([
      [0, 1],
      [1, 0],
    ]);
  });

  test("the answer does not depend on list order", () => {
    const left = ["shohei otani", "shohei ohtani", "mike trout"];
    const right = ["mike troutt", "shohei ohtanii", "shohei ohtani"];
    const forward = pairNamesBySimilarity(left, right).map(
      (p) => `${left[p.leftIndex]}=${right[p.rightIndex]}`,
    );
    const lr = [...left].reverse();
    const rr = [...right].reverse();
    const backward = pairNamesBySimilarity(lr, rr).map(
      (p) => `${lr[p.leftIndex]}=${rr[p.rightIndex]}`,
    );
    expect(new Set(backward)).toEqual(new Set(forward));
  });

  test("undefined and empty names take part in nothing", () => {
    expect(pairNamesBySimilarity([undefined, ""], ["mike trout"])).toEqual([]);
    expect(pairNamesBySimilarity(["mike trout"], [undefined, ""])).toEqual([]);
  });
});

describe("pairNamesBySimilarity — bounded work", () => {
  /** A deterministic lower-case string of `length` letters. */
  const letters = (seed: number, length: number) => {
    let x = seed >>> 0;
    let out = "";
    for (let i = 0; i < length; i++) {
      x = (Math.imul(x, 1103515245) + 12345) >>> 0;
      out += String.fromCharCode(97 + ((x >>> 16) % 26));
    }
    return out;
  };

  test("the length bound is never below a real score", () => {
    const words = ["a", "ab", "mike", "trout", "mike trout", "michael trout", "shohei ohtani", "x".repeat(40)];
    for (const a of words) {
      for (const b of words) {
        expect(jaroWinklerLengthBound(a.length, b.length)).toBeGreaterThanOrEqual(jaroWinkler(a, b) - 1e-12);
      }
    }
    for (let i = 0; i < 2000; i++) {
      const a = letters(i, 1 + (i % 17));
      const b = letters(i * 7 + 3, 1 + ((i * 5) % 23));
      expect(jaroWinklerLengthBound(a.length, b.length)).toBeGreaterThanOrEqual(jaroWinkler(a, b) - 1e-12);
    }
    // The bound is tight: a prefix of a longer name reaches it exactly.
    expect(jaroWinklerLengthBound(4, 10)).toBeCloseTo(jaroWinkler("mike", "mike trout"), 12);
  });

  test("at the 0.92 threshold, a name under 0.6 of the other's length is never scored", () => {
    // With the full prefix bonus Jaro-Winkler is 0.4 + 0.6 × Jaro, so Jaro
    // must reach 0.8667: (2 + s/L)/3 ≥ 0.8667 means s/L ≥ 0.6.
    expect(jaroWinklerLengthBound(6, 10)).toBeCloseTo(PLAYER_NAME_AUTO_LINK, 12);
    expect(jaroWinklerLengthBound(5, 10)).toBeLessThan(PLAYER_NAME_AUTO_LINK);
    expect(jaroWinklerLengthBound(1, 2)).toBeLessThan(PLAYER_NAME_AUTO_LINK);
    expect(pairNamesBySimilarity(["abcde"], ["abcdexxxxx"])).toEqual([]);
    expect(pairNamesBySimilarity(["abcdefg"], ["abcdefgxxx"])).toEqual([
      { leftIndex: 0, rightIndex: 0, score: jaroWinkler("abcdefg", "abcdefgxxx") },
    ]);
  });

  test("past the cell cap only names identical and single on both sides pair; the rest stay unmatched", () => {
    expect(NAME_PAIRING_MAX_CELLS).toBe(250_000);
    const n = 600; // 360,000 cells
    const left = Array.from({ length: n }, (_, i) => `player ${letters(i, 8)}`);
    const right = Array.from({ length: n }, (_, i) => `player ${letters(i + 10_000, 8)}`);
    right[5] = left[3]; // identical, once each side
    right[6] = "shohei otani"; // a spelling slip the full pass would pair...
    left[7] = "shohei ohtani"; // ...left unmatched over the cap
    left[8] = "twin"; // twice on the left: a tie, never paired
    left[9] = "twin";
    right[10] = "twin";
    const started = performance.now();
    const pairs = pairNamesBySimilarity(left, right);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(pairs).toEqual([{ leftIndex: 3, rightIndex: 5, score: 1 }]);
    // Under the cap the same slip does pair, so the cap is what left it.
    expect(pairNamesBySimilarity(["shohei ohtani"], ["shohei otani"])).toHaveLength(1);
  });

  test("2,000 × 2,000 names of 120 characters finish at once instead of minutes", () => {
    const left = Array.from({ length: 2000 }, (_, i) => letters(i, 120));
    const right = Array.from({ length: 2000 }, (_, i) => letters(i + 50_000, 120));
    const started = performance.now();
    expect(pairNamesBySimilarity(left, right)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test("under the cell cap, a matrix too costly to score (long names) is held to identical names too", () => {
    // 500 × 500 is within the cell cap, but 120-character names cost
    // 500² × 120² ≈ 3.6e9 comparisons, past the work cap (~8 s uncapped).
    expect(500 * 500).toBeLessThanOrEqual(NAME_PAIRING_MAX_CELLS);
    expect(500 * 500 * 120 * 120).toBeGreaterThan(NAME_PAIRING_MAX_WORK);
    const left = Array.from({ length: 500 }, (_, i) => letters(i, 120));
    const right = Array.from({ length: 500 }, (_, i) => letters(i + 50_000, 120));
    right[42] = left[17];
    const started = performance.now();
    expect(pairNamesBySimilarity(left, right)).toEqual([{ leftIndex: 17, rightIndex: 42, score: 1 }]);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test("a few hundred real-length names still get the full fuzzy pass", () => {
    const left = Array.from({ length: 400 }, (_, i) => `${letters(i, 6)} ${letters(i + 1, 8)}`);
    const right = left.map((name) => `${name.slice(0, -1)}q`); // one-letter slip each
    const pairs = pairNamesBySimilarity(left, right);
    expect(pairs.length).toBeGreaterThan(350);
    for (const p of pairs) expect(p.leftIndex).toBe(p.rightIndex);
  });
});
