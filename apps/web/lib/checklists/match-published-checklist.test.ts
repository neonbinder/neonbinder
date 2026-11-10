/**
 * PR 451 (NEO-478) — `matchPublishedChecklist` under product rule 7: a card
 * number is the strongest key and still not unique, so a card and a row pair
 * only when the normalised number names exactly one card AND exactly one row.
 */
import { describe, expect, test } from "vitest";
import {
  matchPublishedChecklist,
  normalizeChecklistNumber,
  stripLetterPrefix,
} from "./match-published-checklist";

const card = (cardNumber: string, players: string[] = [], teams: string[] = []) => ({
  cardNumber,
  players,
  teams,
});
const row = (number: string, players: string[] = [], teams: string[] = []) => ({
  number,
  players,
  teams,
});

describe("matchPublishedChecklist: the exactly-one guard", () => {
  test("pairs a card and a row whose number is exactly one on each side", () => {
    const r = matchPublishedChecklist(
      [card("1"), card("2")],
      [row("2"), row("1")],
    );
    expect(r.matches.map((m) => [m.cardIndex, m.rowIndex, m.via])).toEqual([
      [0, 1, "number"],
      [1, 0, "number"],
    ]);
    expect(r.unmatchedCardIndices).toEqual([]);
  });

  test("pairs nothing when two cards share the number, even with one row", () => {
    const r = matchPublishedChecklist([card("5"), card("5"), card("6")], [row("5"), row("6")]);
    expect(r.matches.map((m) => m.cardIndex)).toEqual([2]);
    expect(r.unmatchedCardIndices).toEqual([0, 1]);
  });

  test("pairs nothing when two rows share the number, even with one card", () => {
    const r = matchPublishedChecklist([card("5")], [row("5", ["A"]), row("5", ["B"])]);
    expect(r.matches).toEqual([]);
    expect(r.unmatchedCardIndices).toEqual([0]);
  });

  test("a duplicate on one side does not block a different number on the other", () => {
    const r = matchPublishedChecklist([card("7"), card("7"), card("8")], [row("8")]);
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0]).toMatchObject({ cardIndex: 2, rowIndex: 0 });
  });

  test("compares numbers as written on the card, ignoring #, No., spaces and case", () => {
    expect(normalizeChecklistNumber("#12")).toBe("12");
    expect(normalizeChecklistNumber("No. 12")).toBe("12");
    expect(normalizeChecklistNumber(" bcp - 12 ")).toBe("BCP-12");
    const r = matchPublishedChecklist([card("bcp-12")], [row("#BCP-12")]);
    expect(r.matches[0]).toMatchObject({ via: "number" });
  });

  test("a card with a blank number is never paired", () => {
    const r = matchPublishedChecklist([card("  ")], [row("")]);
    expect(r.matches).toEqual([]);
    expect(r.unmatchedCardIndices).toEqual([0]);
  });
});

describe("matchPublishedChecklist: the letter-prefix fallback", () => {
  test("strips a letter prefix only before a digit", () => {
    expect(stripLetterPrefix("BCP-12")).toBe("12");
    expect(stripLetterPrefix("US12")).toBe("12");
    expect(stripLetterPrefix("12")).toBeNull();
    expect(stripLetterPrefix("ABC")).toBeNull();
  });

  test("pairs a prefixed card number with a bare row number", () => {
    const r = matchPublishedChecklist([card("BCP-12")], [row("12")]);
    expect(r.matches[0]).toMatchObject({ cardIndex: 0, rowIndex: 0, via: "prefixStripped" });
  });

  test("pairs a bare card number with a prefixed row number", () => {
    const r = matchPublishedChecklist([card("12")], [row("US12")]);
    expect(r.matches[0]).toMatchObject({ via: "prefixStripped" });
  });

  test("pairs nothing when two cards strip to the same number", () => {
    const r = matchPublishedChecklist([card("BCP-12"), card("US12")], [row("12")]);
    expect(r.matches).toEqual([]);
    expect(r.unmatchedCardIndices).toEqual([0, 1]);
  });

  test("a row already taken by an exact number is not offered to a prefixed card", () => {
    const r = matchPublishedChecklist([card("12"), card("BCP-12")], [row("12")]);
    expect(r.matches.map((m) => [m.cardIndex, m.via])).toEqual([[0, "number"]]);
    expect(r.unmatchedCardIndices).toEqual([1]);
  });
});

describe("matchPublishedChecklist: disagreements and fills", () => {
  test("the same player under a different number is never paired, only reported as a misread", () => {
    const r = matchPublishedChecklist(
      [card("10", ["Rhett Lowder"])],
      [row("60", ["Rhett Lowder"])],
    );
    expect(r.matches).toEqual([]);
    expect(r.unmatchedCardIndices).toEqual([0]);
    expect(r.misreads).toEqual([{ cardIndex: 0, rowIndex: 0 }]);
  });

  test("a matched pair whose players differ carries both sides and keeps the pairing", () => {
    const r = matchPublishedChecklist(
      [card("3", ["Pete Alonso"])],
      [row("3", ["Kyle Schwarber"])],
    );
    expect(r.matches[0].conflict).toEqual({
      players: { marketplace: ["Pete Alonso"], checklist: ["Kyle Schwarber"] },
    });
  });

  test("a matched pair whose teams differ carries a team conflict", () => {
    const r = matchPublishedChecklist(
      [card("3", ["A"], ["Mets"])],
      [row("3", ["A"], ["Phillies"])],
    );
    expect(r.matches[0].conflict).toEqual({
      teams: { marketplace: ["Mets"], checklist: ["Phillies"] },
    });
  });

  test("same names in another order, case or accents are no conflict", () => {
    const r = matchPublishedChecklist(
      [card("3", ["José Ramírez", "A. J. Smith"], ["Cleveland Guardians"])],
      [row("3", ["a j smith", "JOSE RAMIREZ"], ["cleveland guardians"])],
    );
    expect(r.matches[0].conflict).toBeUndefined();
  });

  test("fills the players when the card has none, and calls it no conflict", () => {
    const r = matchPublishedChecklist([card("4")], [row("4", ["Soto", "Judge"])]);
    expect(r.matches[0].fillPlayers).toEqual(["Soto", "Judge"]);
    expect(r.matches[0].conflict).toBeUndefined();
  });

  test("never fills when the card already has players", () => {
    const r = matchPublishedChecklist([card("4", ["Soto"])], [row("4", ["Soto"])]);
    expect(r.matches[0].fillPlayers).toBeUndefined();
  });

  test("a card with a team and a row with none is no team conflict", () => {
    const r = matchPublishedChecklist([card("4", ["A"], ["Mets"])], [row("4", ["A"])]);
    expect(r.matches[0].conflict).toBeUndefined();
  });
});
