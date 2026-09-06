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
import {
  conflictingNames,
  conflictingPlayers,
  nameKey,
  playersKey,
} from "./card-name";

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

/**
 * NEO-251 — the same contract one field over, for the player LIST.
 *
 * `playersKey` deliberately diverges from `nameKey` on word order (see its own
 * doc comment): the list arrives already split, so a reordering carries no
 * information and would flag most multi-subject cards in a set. These tests
 * pin that divergence, because it is the one place a reader would reasonably
 * expect the two functions to agree and they must not.
 */
describe("playersKey — order-insensitive at both levels", () => {
  test("list order does not matter", () => {
    expect(playersKey(["Alec Bohm", "Spencer Howard"])).toBe(
      playersKey(["Spencer Howard", "Alec Bohm"]),
    );
  });

  test("token order within one name does not matter", () => {
    // BSC files some multi-subject rows surname-first.
    expect(playersKey(["Bohm, Alec"])).toBe(playersKey(["Alec Bohm"]));
  });

  test("diacritics, casing and punctuation fold, as they do for nameKey", () => {
    expect(playersKey(["José Ramírez"])).toBe(playersKey(["jose ramirez"]));
    expect(playersKey(["KEN GRIFFEY JR."])).toBe(playersKey(["Ken Griffey Jr"]));
  });

  test("empty and whitespace-only entries drop out rather than keying", () => {
    expect(playersKey(["Alec Bohm", "  ", ""])).toBe(playersKey(["Alec Bohm"]));
  });

  test("a longer list is a different key — a subset is not a match", () => {
    expect(playersKey(["Mike Yastrzemski"])).not.toBe(
      playersKey(["Mike Yastrzemski", "Carl Yastrzemski"]),
    );
  });

  test("an empty list keys to the empty string", () => {
    expect(playersKey([])).toBe("");
  });
});

describe("conflictingPlayers", () => {
  /** The motivating row, one field over from `conflictingNames`'. */
  test("a subset is a disagreement, with both lists verbatim", () => {
    expect(
      conflictingPlayers(
        ["Mike Yastrzemski"],
        ["Mike Yastrzemski", "Carl Yastrzemski"],
      ),
    ).toEqual({
      bsc: ["Mike Yastrzemski"],
      sportlots: ["Mike Yastrzemski", "Carl Yastrzemski"],
    });
  });

  test("the same roster in a different order is not a disagreement", () => {
    expect(
      conflictingPlayers(
        ["Alec Bohm", "Spencer Howard"],
        ["Spencer Howard", "Alec Bohm"],
      ),
    ).toBeUndefined();
  });

  test("a spelling difference is not a disagreement", () => {
    expect(
      conflictingPlayers(["Jose Ramirez"], ["José Ramírez"]),
    ).toBeUndefined();
  });

  test("does not hand back the folded form", () => {
    const conflict = conflictingPlayers(["Jose Ramirez"], ["José Ramírez", "Bo Bichette"]);
    expect(conflict?.sportlots).toEqual(["José Ramírez", "Bo Bichette"]);
  });

  test("outer whitespace is trimmed and is not itself a disagreement", () => {
    expect(
      conflictingPlayers(["  Alec Bohm  "], ["Alec Bohm"]),
    ).toBeUndefined();
    expect(conflictingPlayers(["  Alec Bohm  "], ["Carl Yastrzemski"])?.bsc).toEqual([
      "Alec Bohm",
    ]);
  });

  /**
   * SportLots-only and BSC-only cards are the common case on a set one
   * marketplace carries and the other does not; neither is a disagreement.
   */
  test("an empty, whitespace-only or missing side is not a disagreement", () => {
    expect(conflictingPlayers([], ["Alec Bohm"])).toBeUndefined();
    expect(conflictingPlayers(["Alec Bohm"], [])).toBeUndefined();
    expect(conflictingPlayers(["Alec Bohm"], ["   "])).toBeUndefined();
    expect(conflictingPlayers(undefined, ["Alec Bohm"])).toBeUndefined();
    expect(conflictingPlayers(["Alec Bohm"], undefined)).toBeUndefined();
    expect(conflictingPlayers(undefined, undefined)).toBeUndefined();
  });
});
