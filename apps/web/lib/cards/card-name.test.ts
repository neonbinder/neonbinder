/**
 * NEO-199 — the shared wrong-player predicate.
 *
 * `CardPairingModal` and `fetchCardChecklist` both call this, and they must
 * agree: a disagreement an operator hand-linked into existence and one the
 * server auto-matched are the same fact about the same card, and the operator
 * cannot tell which path produced the row in front of them. These tests pin the
 * contract in the one place both sides share, so a change here shows up as one
 * failure rather than as two consumers quietly drifting apart.
 *
 * The end-to-end halves live with their consumers:
 *   - manual path — CardPairingModal.test.tsx
 *   - auto path   — convex/fetchCardChecklist.nameConflict.test.ts
 */

import { describe, expect, test } from "vitest";
import { conflictingNames, nameKey } from "./card-name";

describe("nameKey — fold spelling, keep meaning", () => {
  test("diacritics fold, because BSC strips the accents SportLots keeps", () => {
    expect(nameKey("José Ramírez")).toBe(nameKey("Jose Ramirez"));
  });

  test("punctuation and casing fold", () => {
    expect(nameKey("KEN GRIFFEY JR.")).toBe(nameKey("Ken Griffey Jr"));
  });

  test("the two multi-player joins fold to the same key", () => {
    // BSC writes " / ", SportLots writes "|". Neither is a disagreement.
    expect(nameKey("Mike Trout / Shohei Ohtani")).toBe(
      nameKey("Mike Trout|Shohei Ohtani"),
    );
  });

  /**
   * Deliberately NOT folded. Two sources listing the same players in a
   * different order on a multi-player card is worth a glance, and this control
   * costs a glance rather than a click.
   */
  test("word order is significant", () => {
    expect(nameKey("Mike Trout|Shohei Ohtani")).not.toBe(
      nameKey("Shohei Ohtani|Mike Trout"),
    );
  });
});

describe("conflictingNames", () => {
  /** The motivating row: the card is Carl, and BSC only says Mike. */
  test("reports a real disagreement with both names verbatim", () => {
    expect(
      conflictingNames("Mike Yastrzemski", "Mike Yastrzemski|Carl Yastrzemski"),
    ).toEqual({
      bsc: "Mike Yastrzemski",
      sportlots: "Mike Yastrzemski|Carl Yastrzemski",
    });
  });

  /**
   * Names are returned as the marketplace spelled them, NOT folded. The fold
   * decides whether to speak; the operator is then shown the real strings,
   * because "Jose" vs "José" being collapsed to one is the whole point of
   * having a human look.
   */
  test("does not hand back the folded form", () => {
    const conflict = conflictingNames("Griffey", "José Ramírez");
    expect(conflict?.sportlots).toBe("José Ramírez");
  });

  test("outer whitespace is not a disagreement, and is trimmed off", () => {
    expect(conflictingNames("  Ken Griffey Jr.  ", "Ken Griffey Jr.")).toBeUndefined();
    expect(conflictingNames("  Mike  ", "Carl")?.bsc).toBe("Mike");
  });

  /**
   * A side with no name has nothing to disagree with, and every merge already
   * falls through to the side that has one. Flagging it would put a two-option
   * choice on a row with one real option.
   */
  test("an empty or missing side is not a disagreement", () => {
    expect(conflictingNames("", "Wander Franco")).toBeUndefined();
    expect(conflictingNames("Wander Franco", "   ")).toBeUndefined();
    expect(conflictingNames(undefined, "Wander Franco")).toBeUndefined();
    expect(conflictingNames("Wander Franco", undefined)).toBeUndefined();
  });
});
