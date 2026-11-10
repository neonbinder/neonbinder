/**
 * PR 451 (NEO-478) — `matchPublishedChecklist` under product rule 7: a card
 * number is the strongest key and still not unique, so a card and a row pair
 * only when the normalised number names exactly one card AND exactly one row.
 */
import { describe, expect, test } from "vitest";
import {
  MAX_CHECKLIST_MISREADS,
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
    expect(r.misreadCount).toBe(1);
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

describe("matchPublishedChecklist: the misreads list is capped", () => {
  test("one player on many rows times many unmatched cards lists the cap and counts the whole", () => {
    // 1,000 unmatched cards and 1,000 rows, all the same player, every number
    // different on the two sides: a million pairs before the cap.
    const n = 1000;
    // Bare numbers that never meet, so neither pass (nor the prefix strip) pairs.
    const cards = Array.from({ length: n }, (_, i) => card(String(i + 1), ["Shohei Ohtani"]));
    const rows = Array.from({ length: n }, (_, i) => row(String(n + i + 1), ["Shohei Ohtani"]));
    const started = performance.now();
    const r = matchPublishedChecklist(cards, rows);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(r.unmatchedCardIndices).toHaveLength(n);
    expect(r.misreadCount).toBe(n * n);
    expect(r.misreads).toHaveLength(MAX_CHECKLIST_MISREADS);
    // Card then row order: the first card's rows first.
    expect(r.misreads[0]).toEqual({ cardIndex: 0, rowIndex: 0 });
    expect(r.misreads[MAX_CHECKLIST_MISREADS - 1]).toEqual({
      cardIndex: 0,
      rowIndex: MAX_CHECKLIST_MISREADS - 1,
    });
  });

  test("rows at the card's own number are neither listed nor counted", () => {
    // Card 5 and its twin share the number, so neither pairs; the row at 5
    // is not a misread for them, the row at 9 is.
    const r = matchPublishedChecklist(
      [card("5", ["A One"]), card("5", ["A One"])],
      [row("5", ["A One"]), row("9", ["A One"])],
    );
    expect(r.matches).toEqual([]);
    expect(r.misreads).toEqual([
      { cardIndex: 0, rowIndex: 1 },
      { cardIndex: 1, rowIndex: 1 },
    ]);
    expect(r.misreadCount).toBe(2);
  });

  test("under the cap, the list is every pair and the count is its length", () => {
    const r = matchPublishedChecklist(
      [card("1", ["A One"]), card("2", ["B Two"])],
      [row("10", ["A One"]), row("11", ["A One"]), row("20", ["B Two"])],
    );
    expect(r.misreads).toEqual([
      { cardIndex: 0, rowIndex: 0 },
      { cardIndex: 0, rowIndex: 1 },
      { cardIndex: 1, rowIndex: 2 },
    ]);
    expect(r.misreadCount).toBe(3);
  });

  test("an unmatched card past the cap still counts", () => {
    const cards = Array.from({ length: 3 }, (_, i) => card(String(5000 + i), ["P"]));
    const rows = Array.from({ length: MAX_CHECKLIST_MISREADS }, (_, i) => row(String(i + 1), ["P"]));
    const r = matchPublishedChecklist(cards, rows);
    expect(r.misreads).toHaveLength(MAX_CHECKLIST_MISREADS);
    expect(r.misreads.every((m) => m.cardIndex === 0)).toBe(true);
    expect(r.misreadCount).toBe(3 * MAX_CHECKLIST_MISREADS);
  });
});
