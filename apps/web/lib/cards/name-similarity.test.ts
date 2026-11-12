import { describe, expect, test } from "vitest";
import {
  PLAYER_NAME_AUTO_LINK,
  jaroSimilarity,
  jaroWinkler,
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
