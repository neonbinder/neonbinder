import { describe, expect, it } from "vitest";
import {
  blockedCollectedReason,
  collectedCardRefusal,
  keptCollectedNote,
  mergeCollectorCounts,
} from "./collectors";

/** NEO-358 — the collector-count wording every delete refusal shares. */
describe("collector counts in the operator's words", () => {
  it("says how many collectors hold a card a delete refused", () => {
    expect(collectedCardRefusal({ collectors: 1, atLeast: false })).toBe(
      "Hold up! A collector has this card, so it stays in the catalog.",
    );
    expect(collectedCardRefusal({ collectors: 3, atLeast: false })).toBe(
      "Hold up! 3 collectors have this card, so it stays in the catalog.",
    );
    expect(collectedCardRefusal({ collectors: 1200, atLeast: true })).toBe(
      "Hold up! 1,200+ collectors have this card, so it stays in the catalog.",
    );
  });

  it("a floor of one still reads 'a collector', which stays true however many more there are", () => {
    expect(collectedCardRefusal({ collectors: 1, atLeast: true })).toBe(
      "Hold up! A collector has this card, so it stays in the catalog.",
    );
  });

  it("names the collectors behind a blocked parallel rebuild", () => {
    expect(blockedCollectedReason({ collectors: 1, atLeast: false })).toBe(
      "a collector owns copies of its cards, and a rebuild would pull those cards out from under them",
    );
    expect(blockedCollectedReason({ collectors: 4, atLeast: true })).toBe(
      "4+ collectors own copies of its cards, and a rebuild would pull those cards out from under them",
    );
  });

  it("the commit banner counts the cards it kept and the collectors in the way", () => {
    expect(keptCollectedNote(1, { collectors: 1, atLeast: false })).toBe(
      "Kept 1 card: a collector has it, so it stays in the catalog.",
    );
    expect(keptCollectedNote(2, { collectors: 5, atLeast: false })).toBe(
      "Kept 2 cards: 5 collectors have them, so they stay in the catalog.",
    );
  });

  it("merges two page counts into a floor, never a sum that could count one collector twice", () => {
    expect(mergeCollectorCounts(null, { collectors: 2, atLeast: false })).toEqual({ collectors: 2, atLeast: false });
    expect(mergeCollectorCounts({ collectors: 2, atLeast: false }, { collectors: 3, atLeast: false })).toEqual({
      collectors: 3,
      atLeast: true,
    });
  });
});
