/**
 * NEO-379 — the intake matcher's rules, pinned on fixtures shaped like the
 * cases the plan's collector review listed: shared numbers, variations,
 * number/player conflicts, multi-player cards, prefixed numbers and OCR
 * look-alikes.
 */

import { describe, expect, test } from "vitest";
import {
  INTAKE_MATCHED_MIN,
  INTAKE_NONE_BELOW,
  intakeBandFor,
  intakeNamesFor,
  matchIntakePair,
  normalizeIntakeCardNumber,
  type IntakeCandidate,
} from "./intakeMatch";

const set: IntakeCandidate[] = [
  { id: "c1", cardNumber: "1", names: ["Shohei Ohtani"], team: "Los Angeles Dodgers" },
  { id: "c2", cardNumber: "2", names: ["Mike Trout"], team: "Los Angeles Angels" },
  { id: "c27", cardNumber: "27", names: ["Aaron Judge"], team: "New York Yankees" },
  // #27 has a photo variation of Judge.
  { id: "c27v", cardNumber: "27", names: ["Aaron Judge"], team: "New York Yankees", variationOf: "c27" },
  // Two different cards share #150 (an SP image swap with a different player).
  { id: "c150a", cardNumber: "150", names: ["Juan Soto"], team: "New York Yankees" },
  { id: "c150b", cardNumber: "150", names: ["Gunnar Henderson"], team: "Baltimore Orioles" },
  // Two Ohtani cards, so the player alone is a tie.
  { id: "c300", cardNumber: "300", names: ["Shohei Ohtani"], team: "Los Angeles Dodgers" },
  // Multi-player card.
  { id: "c400", cardNumber: "400", names: ["Aaron Judge", "Juan Soto"], team: "New York Yankees" },
  // An auto with a lettered number.
  { id: "cRA", cardNumber: "RA-MT", names: ["Mike Trout"], team: "Los Angeles Angels" },
];

const read = (cardNumber: string | null, players: string[] = [], team: string | null = null) => ({
  cardNumber,
  players,
  team,
});

describe("normalizeIntakeCardNumber", () => {
  test("drops #, spaces, case and leading zeros, keeps letter prefixes", () => {
    expect(normalizeIntakeCardNumber("#007")).toBe("7");
    expect(normalizeIntakeCardNumber(" no. 27 ")).toBe("27");
    expect(normalizeIntakeCardNumber("ra-mt")).toBe("RA-MT");
    expect(normalizeIntakeCardNumber("PR-012")).toBe("PR-12");
    expect(normalizeIntakeCardNumber("0")).toBe("0");
  });
});

describe("intakeBandFor", () => {
  test("no card is none; the thresholds split matched from check", () => {
    expect(intakeBandFor(null, 99)).toBe("none");
    expect(intakeBandFor("x", INTAKE_NONE_BELOW - 1)).toBe("none");
    expect(intakeBandFor("x", INTAKE_MATCHED_MIN - 1)).toBe("check");
    expect(intakeBandFor("x", INTAKE_MATCHED_MIN)).toBe("matched");
  });
});

describe("matchIntakePair", () => {
  test("number and player agree: matched", () => {
    const m = matchIntakePair(read("2", ["M. Trout"]), set);
    expect(m).toMatchObject({ cardId: "c2", band: "matched", reason: "numberAndPlayer" });
  });

  test("a unique number with no player read is still matched", () => {
    const m = matchIntakePair(read("#002"), set);
    expect(m).toMatchObject({ cardId: "c2", band: "matched", reason: "numberOnly" });
  });

  test("a number/player disagreement proposes the number's card and asks", () => {
    // Read #2 but the name says Judge: the number ranks higher, the band says check.
    const m = matchIntakePair(read("2", ["Aaron Judge"]), set);
    expect(m.cardId).toBe("c2");
    expect(m.band).toBe("check");
    expect(m.reason).toBe("numberPlayerConflict");
    expect(m.candidates).toEqual(["c2", "c27", "c400"]);
  });

  test("a player the variant does not know leaves a unique number at check", () => {
    const m = matchIntakePair(read("2", ["Somebody Else"]), set);
    expect(m).toMatchObject({ cardId: "c2", band: "check", reason: "playerUnconfirmed" });
  });

  test("a variation is not a tie: the parent is proposed, the variation listed", () => {
    const m = matchIntakePair(read("27", ["Judge"]), set);
    expect(m).toMatchObject({ cardId: "c27", band: "matched", variations: ["c27v"] });
  });

  test("a shared number is picked by the player, but only to check", () => {
    const m = matchIntakePair(read("150", ["Gunnar Henderson"]), set);
    expect(m).toMatchObject({ cardId: "c150b", band: "check", reason: "numberSharedPlayerPicked" });
    expect(m.candidates).toEqual(["c150b", "c150a"]);
  });

  test("a shared number nothing breaks stays unmatched, never the first card", () => {
    const m = matchIntakePair(read("150"), set);
    expect(m).toMatchObject({ cardId: null, band: "none", reason: "numberShared" });
    expect(m.candidates).toEqual(["c150a", "c150b"]);
  });

  test("a multi-player card matches on any one name read", () => {
    const m = matchIntakePair(read("400", ["Juan Soto"]), set);
    expect(m).toMatchObject({ cardId: "c400", band: "matched", reason: "numberAndPlayer" });
  });

  test("a lettered auto number keeps its prefix", () => {
    const m = matchIntakePair(read("RA-MT", ["Mike Trout"]), set);
    expect(m).toMatchObject({ cardId: "cRA", band: "matched" });
  });

  test("the variant's marketplace prefix is taken off the read number", () => {
    const dk: IntakeCandidate[] = [{ id: "dk12", cardNumber: "12", names: ["Ken Griffey Jr."] }];
    const m = matchIntakePair(read("DK-12", ["Ken Griffey"]), dk, "DK-");
    expect(m).toMatchObject({ cardId: "dk12", band: "matched" });
    // Without the prefix known, nothing matches on the number.
    expect(matchIntakePair(read("DK-12"), dk).cardId).toBeNull();
  });

  test("an OCR look-alike number is a lead, never matched on its own", () => {
    const m = matchIntakePair(read("2O"), [{ id: "c20", cardNumber: "20", names: ["X Y"] }]);
    expect(m).toMatchObject({ cardId: "c20", band: "check", reason: "numberFuzzy" });
    const withPlayer = matchIntakePair(read("2O", ["X Y"]), [{ id: "c20", cardNumber: "20", names: ["X Y"] }]);
    expect(withPlayer.band).toBe("check");
  });

  test("no number hit: a player naming one card is proposed to check", () => {
    const m = matchIntakePair(read("999", ["Mike Trout"]), set.filter((c) => c.id !== "cRA"));
    expect(m).toMatchObject({ cardId: "c2", band: "check", reason: "playerOnly" });
  });

  test("no number hit: a player on several cards is a tie unless the team breaks it", () => {
    const tie = matchIntakePair(read(null, ["Shohei Ohtani"]), set);
    expect(tie).toMatchObject({ cardId: null, reason: "playerShared" });
    expect(tie.candidates).toEqual(["c1", "c300"]);
    const teams: IntakeCandidate[] = [
      { id: "a", cardNumber: "1", names: ["Will Smith"], team: "Los Angeles Dodgers" },
      { id: "b", cardNumber: "2", names: ["Will Smith"], team: "Atlanta Braves" },
    ];
    const byTeam = matchIntakePair(read(null, ["Will Smith"], "Braves"), teams);
    expect(byTeam).toMatchObject({ cardId: "b", band: "check" });
  });

  test("nothing read, and nothing fitting", () => {
    expect(matchIntakePair(read(null), set).reason).toBe("nothingRead");
    expect(matchIntakePair(read("999", ["Nobody Here"]), set)).toMatchObject({
      cardId: null,
      band: "none",
      reason: "noMatch",
    });
  });
});

describe("intakeNamesFor", () => {
  test("printed names plus the card name split on multi-player separators", () => {
    expect(
      intakeNamesFor("Aaron Judge / Juan Soto", [{ nameOnCard: "Aaron Judge" }]),
    ).toEqual(["Aaron Judge", "Juan Soto"]);
    expect(intakeNamesFor("Doc Gooden", undefined)).toEqual(["Doc Gooden"]);
  });
});
