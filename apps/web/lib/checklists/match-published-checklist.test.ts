/**
 * PR 451 (NEO-478) — `matchPublishedChecklist` under product rule 7: a card
 * number is the strongest key and still not unique, so a card and a row pair
 * only when the normalised number names exactly one card AND exactly one row.
 */
import { describe, expect, test } from "vitest";
import {
  MAX_CHECKLIST_MISREADS,
  exactChecklistNumber,
  isNoNumber,
  matchPublishedChecklist,
  normalizeChecklistNumber,
  pairByPlayerName,
  playersAgree,
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
    const r = matchPublishedChecklist([card("BCP-12")], [row("#BCP-12")]);
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
  test("the same player under a different number pairs by player name when no number pairs (NEO-490)", () => {
    const r = matchPublishedChecklist(
      [card("10", ["Rhett Lowder"])],
      [row("60", ["Rhett Lowder"])],
    );
    expect(r.matches.map((m) => [m.cardIndex, m.rowIndex, m.via])).toEqual([[0, 0, "playerName"]]);
    expect(r.fallback).toBe("playerName");
    expect(r.unmatchedCardIndices).toEqual([]);
    expect(r.misreads).toEqual([]);
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

describe("matchPublishedChecklist: checklist surnames (collector review S4)", () => {
  test("Alonso/Schwarber/Soto against the marketplace's full names is agreement, and nothing is written", () => {
    const r = matchPublishedChecklist(
      [card("11", ["Pete Alonso", "Kyle Schwarber", "Juan Soto"])],
      [row("11", ["Alonso", "Schwarber", "Soto"])],
    );
    expect(r.matches).toEqual([{ cardIndex: 0, rowIndex: 0, via: "number" }]);
  });

  test("a one-player card agrees with its surname, suffixes and multi-word surnames included", () => {
    expect(playersAgree(["Pete Alonso"], ["Alonso"])).toBe(true);
    expect(playersAgree(["Ken Griffey Jr."], ["Griffey"])).toBe(true);
    expect(playersAgree(["Elly De La Cruz"], ["De La Cruz"])).toBe(true);
    expect(playersAgree(["Elly De La Cruz"], ["Cruz"])).toBe(true);
  });

  test("a mix of full names and surnames agrees, full names paired first", () => {
    expect(playersAgree(["Will Smith", "Dominic Smith"], ["Smith", "Will Smith"])).toBe(true);
    expect(playersAgree(["Will Smith", "Dominic Smith"], ["Will Smith", "Smith"])).toBe(true);
  });

  test("different counts are a disagreement, even when every surname appears", () => {
    expect(playersAgree(["Pete Alonso", "Kyle Schwarber", "Juan Soto"], ["Alonso", "Soto"])).toBe(
      false,
    );
    const r = matchPublishedChecklist(
      [card("11", ["Pete Alonso", "Kyle Schwarber", "Juan Soto"])],
      [row("11", ["Alonso", "Soto"])],
    );
    expect(r.matches[0].conflict?.players).toEqual({
      marketplace: ["Pete Alonso", "Kyle Schwarber", "Juan Soto"],
      checklist: ["Alonso", "Soto"],
    });
  });

  test("a surname that is not a marketplace name's ending is a disagreement", () => {
    expect(playersAgree(["Pete Alonso", "Juan Soto"], ["Alonso", "Judge"])).toBe(false);
    // A name's first word is not its surname.
    expect(playersAgree(["Pete Alonso"], ["Pete"])).toBe(false);
    // Part of a word is not a word.
    expect(playersAgree(["Pete Alonso"], ["lonso"])).toBe(false);
  });

  test("one marketplace name answers one surname only", () => {
    expect(playersAgree(["Will Smith", "Pete Alonso"], ["Smith", "Smith"])).toBe(false);
  });

  test("the comparison runs one way: a full checklist name against a marketplace surname disagrees", () => {
    expect(playersAgree(["Alonso"], ["Pete Alonso"])).toBe(false);
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

// PR 451 (D-B) — an NNO row pairs with a no-number card by player, under the
// same exactly-one guard on both sides; never with a numbered card.
const nno = (players: string[] = [], teams: string[] = []) => ({
  number: "NNO",
  players,
  teams,
  noNumber: true as const,
});

describe("matchPublishedChecklist: NNO rows pair by player (D-B)", () => {
  test("isNoNumber: blank and NNO in any print are no number; a number is one", () => {
    for (const raw of ["", "  ", "NNO", "nno", "#NNO", "NNO.", "No. NNO"]) {
      expect(isNoNumber(raw)).toBe(true);
    }
    for (const raw of ["1", "BCP-12", "NNO1", "N"]) expect(isNoNumber(raw)).toBe(false);
  });

  test("one NNO card and one NNO row naming the same player pair, via player", () => {
    const r = matchPublishedChecklist(
      [card("NNO", ["Chris Potter"]), card("NNO", ["Jon Larson"]), card("", ["Craig Herr"])],
      [nno(["Jon Larson"], ["Roanoke Express"]), nno(["craig herr"]), nno(["Chris Potter"])],
    );
    expect(r.matches.map((m) => [m.cardIndex, m.rowIndex, m.via])).toEqual([
      [0, 2, "player"],
      [1, 0, "player"],
      [2, 1, "player"],
    ]);
    expect(r.unmatchedCardIndices).toEqual([]);
    expect(r.matches.every((m) => m.conflict === undefined && m.fillPlayers === undefined)).toBe(true);
  });

  test("two no-number cards with the same player leave both unmatched", () => {
    const r = matchPublishedChecklist(
      [card("NNO", ["Chris Potter"]), card("NNO", ["Chris Potter"])],
      [nno(["Chris Potter"], ["Roanoke Express"])],
    );
    expect(r.matches).toEqual([]);
    expect(r.unmatchedCardIndices).toEqual([0, 1]);
    // Same (missing) number on both sides: no misread either.
    expect(r.misreadCount).toBe(0);
  });

  test("two NNO rows with the same player leave the card unmatched", () => {
    const r = matchPublishedChecklist(
      [card("NNO", ["Chris Potter"])],
      [nno(["Chris Potter"], ["Roanoke Express"]), nno(["Chris Potter"], ["Richmond Renegades"])],
    );
    expect(r.matches).toEqual([]);
    expect(r.unmatchedCardIndices).toEqual([0]);
  });

  test("an NNO row never pairs with a numbered card, even the only one with that player", () => {
    const r = matchPublishedChecklist(
      [card("12", ["Mike Trout"])],
      [nno(["Mike Trout"], ["Los Angeles Angels"])],
    );
    expect(r.matches).toEqual([]);
    expect(r.unmatchedCardIndices).toEqual([0]);
  });

  test("a numbered row never pairs with a no-number card by player", () => {
    const r = matchPublishedChecklist(
      [card("NNO", ["Mike Trout"])],
      [row("12", ["Mike Trout"], ["Los Angeles Angels"])],
    );
    expect(r.matches).toEqual([]);
  });

  test("a row numbered NNO without the flag is still a no-number row", () => {
    const r = matchPublishedChecklist(
      [card("NNO", ["Mike Trout"]), card("NNO", ["Juan Soto"])],
      [row("NNO", ["Mike Trout"], ["Los Angeles Angels"])],
    );
    expect(r.matches.map((m) => [m.cardIndex, m.rowIndex, m.via])).toEqual([[0, 0, "player"]]);
    expect(r.unmatchedCardIndices).toEqual([1]);
  });

  test("a no-number card or row with no players has nothing to pair by", () => {
    const r = matchPublishedChecklist([card("NNO")], [nno([], ["Roanoke Express"])]);
    expect(r.matches).toEqual([]);
  });

  test("an NNO pair still surfaces a team disagreement", () => {
    const r = matchPublishedChecklist(
      [card("NNO", ["Chris Potter"], ["Richmond Renegades"])],
      [nno(["Chris Potter"], ["Roanoke Express"])],
    );
    expect(r.matches[0]).toMatchObject({
      via: "player",
      conflict: { teams: { marketplace: ["Richmond Renegades"], checklist: ["Roanoke Express"] } },
    });
  });

  test("numbered cards keep matching by number beside NNO pairs", () => {
    const r = matchPublishedChecklist(
      [card("1", ["Chris Potter"]), card("NNO", ["Chris Potter"])],
      [row("1", ["Chris Potter"]), nno(["Chris Potter"])],
    );
    expect(r.matches.map((m) => [m.cardIndex, m.rowIndex, m.via])).toEqual([
      [0, 0, "number"],
      [1, 1, "player"],
    ]);
  });
});

describe("matchPublishedChecklist: NEO-489 numbers read as printed (case)", () => {
  test("exactChecklistNumber keeps case but drops #, No. and spaces", () => {
    expect(exactChecklistNumber("#1a")).toBe("1a");
    expect(exactChecklistNumber("No. 1A")).toBe("1A");
    expect(exactChecklistNumber(" PPR - DLa ")).toBe("PPR-DLa");
    expect(normalizeChecklistNumber("PPR-DLa")).toBe("PPR-DLA");
  });

  test("cards 1a and 1A pair with rows 1a and 1A, each by its exact number", () => {
    const r = matchPublishedChecklist(
      [card("1a"), card("1A")],
      [row("1a", ["Low"]), row("1A", ["Up"])],
    );
    expect(r.matches.map((m) => [m.cardIndex, m.rowIndex, m.via])).toEqual([
      [0, 0, "number"],
      [1, 1, "number"],
    ]);
  });

  test("cards 1a and 1A with only row 1A: 1A pairs exactly, 1a stays unmatched", () => {
    const r = matchPublishedChecklist([card("1a"), card("1A")], [row("1A", ["Up"])]);
    expect(r.matches.map((m) => [m.cardIndex, m.rowIndex, m.via])).toEqual([[1, 0, "number"]]);
    expect(r.unmatchedCardIndices).toEqual([0]);
  });

  test("cards x1a and X1A with row X1a: the folded key names two cards, so both stay unmatched", () => {
    const r = matchPublishedChecklist([card("x1a"), card("X1A")], [row("X1a", ["P"])]);
    expect(r.matches).toEqual([]);
    expect(r.unmatchedCardIndices).toEqual([0, 1]);
  });

  test("card 1a with rows 1A and 1A: the folded key names two rows, so it stays unmatched", () => {
    const r = matchPublishedChecklist([card("1a")], [row("1A", ["A"]), row("1A", ["B"])]);
    expect(r.matches).toEqual([]);
    expect(r.unmatchedCardIndices).toEqual([0]);
  });

  test("card PPR-DLa with row ppr-dla pairs once, via caseFolded", () => {
    const r = matchPublishedChecklist([card("PPR-DLa")], [row("ppr-dla", ["Derrek Lee"])]);
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0]).toMatchObject({ cardIndex: 0, rowIndex: 0, via: "caseFolded" });
  });

  test("an exact pair is never reported as caseFolded", () => {
    const r = matchPublishedChecklist([card("PPR-DLa")], [row("PPR-DLa")]);
    expect(r.matches[0].via).toBe("number");
  });
});

describe("matchPublishedChecklist: NEO-489 a No Team row", () => {
  const noTeamRow = (number: string, players: string[] = []) => ({
    number,
    players,
    teams: [] as string[],
    noTeam: true as const,
  });

  test("a card that already has a team against a No Team row is a team conflict with an empty checklist side", () => {
    const r = matchPublishedChecklist(
      [card("1", ["Mike Trout"], ["Los Angeles Angels"])],
      [noTeamRow("1", ["Mike Trout"])],
    );
    expect(r.matches[0].conflict).toEqual({
      teams: { marketplace: ["Los Angeles Angels"], checklist: [] },
    });
  });

  test("a card that carries only the legacy singular team conflicts too", () => {
    const legacy = { cardNumber: "1", players: ["Mike Trout"], team: "Los Angeles Angels" };
    const r = matchPublishedChecklist([legacy as never], [noTeamRow("1", ["Mike Trout"])]);
    expect(r.matches[0].conflict?.teams).toEqual({
      marketplace: ["Los Angeles Angels"],
      checklist: [],
    });
  });

  test("a card with no team against a No Team row is no conflict", () => {
    const r = matchPublishedChecklist([card("1", ["Mike Trout"])], [noTeamRow("1", ["Mike Trout"])]);
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0].conflict).toBeUndefined();
  });

  test("a teamed card against a row that merely lists no team is still no conflict", () => {
    const r = matchPublishedChecklist(
      [card("1", ["Mike Trout"], ["Los Angeles Angels"])],
      [row("1", ["Mike Trout"])],
    );
    expect(r.matches[0].conflict).toBeUndefined();
  });
});

describe("matchPublishedChecklist: NEO-490 player-name fallback", () => {
  const sigCards = (n: number) =>
    Array.from({ length: n }, (_, i) => card(`SIG-${i + 1}A`, [`Player ${i + 1}`]));
  const numberedRows = (n: number) =>
    Array.from({ length: n }, (_, i) => row(String(i + 1), [`Player ${i + 1}`]));

  test("SIG-xx cards against rows 1..N with equal counts all pair by player name", () => {
    const r = matchPublishedChecklist(sigCards(14), numberedRows(14));
    expect(r.fallback).toBe("playerName");
    expect(r.matches).toHaveLength(14);
    expect(r.matches.every((m) => m.via === "playerName")).toBe(true);
    expect(r.matches.map((m) => [m.cardIndex, m.rowIndex])).toEqual(
      Array.from({ length: 14 }, (_, i) => [i, i]),
    );
    expect(r.needsOperator).toBe(false);
    expect(r.unusedRowIndices).toEqual([]);
  });

  test("a name pair never produces a conflict about the card number", () => {
    const r = matchPublishedChecklist(sigCards(2), numberedRows(2));
    expect(r.matches.every((m) => m.conflict === undefined)).toBe(true);
  });

  test("a name tie leaves both cards unmatched and asks the operator", () => {
    const r = matchPublishedChecklist(
      [card("SIG-A", ["Same Name"]), card("SIG-B", ["Same Name"])],
      [row("1", ["Same Name"]), row("2", ["Other Person"])],
    );
    expect(r.matches).toEqual([]);
    expect(r.unmatchedCardIndices).toEqual([0, 1]);
    expect(r.unusedRowIndices).toEqual([0, 1]);
    expect(r.fallback).toBe("playerName");
    expect(r.needsOperator).toBe(true);
  });

  test("a tie on the row side also leaves both rows unmatched", () => {
    const r = matchPublishedChecklist(
      [card("SIG-A", ["Same Name"]), card("SIG-B", ["Other Person"])],
      [row("1", ["Same Name"]), row("2", ["Same Name"])],
    );
    expect(r.matches).toEqual([]);
    expect(r.needsOperator).toBe(true);
  });

  test("equal counts with one card and one row left over need the operator", () => {
    const r = matchPublishedChecklist(
      [card("SIG-A", ["A One"]), card("SIG-B", ["B Two"])],
      [row("1", ["A One"]), row("2", ["Someone Else"])],
    );
    expect(r.matches.map((m) => m.cardIndex)).toEqual([0]);
    expect(r.unmatchedCardIndices).toEqual([1]);
    expect(r.unusedRowIndices).toEqual([1]);
    expect(r.needsOperator).toBe(true);
  });

  test("a count mismatch makes no matches, falls back to the operator and suggests the name pairs", () => {
    const r = matchPublishedChecklist(sigCards(3), numberedRows(2));
    expect(r.fallback).toBe("operator");
    expect(r.matches).toEqual([]);
    expect(r.needsOperator).toBe(true);
    expect(r.unmatchedCardIndices).toEqual([0, 1, 2]);
    expect(r.suggestions).toEqual([
      { cardIndex: 0, rowIndex: 0 },
      { cardIndex: 1, rowIndex: 1 },
    ]);
    expect(r.unusedRowIndices).toEqual([0, 1]);
  });

  test("suggestions are exactly what pairByPlayerName returns on the numbered cards and rows", () => {
    const cards = [card("SIG-A", ["A One"]), card("SIG-B", ["B Two"]), card("SIG-C", ["C Three"])];
    const rows = [row("1", ["C Three"]), row("2", ["A One"])];
    const r = matchPublishedChecklist(cards, rows);
    expect(r.suggestions).toEqual(pairByPlayerName(cards, rows));
    expect(r.suggestions).toEqual([
      { cardIndex: 0, rowIndex: 1 },
      { cardIndex: 2, rowIndex: 0 },
    ]);
  });

  test("any number match means no fallback", () => {
    const r = matchPublishedChecklist(
      [card("1", ["A One"]), card("SIG-B", ["B Two"])],
      [row("1", ["A One"]), row("2", ["B Two"])],
    );
    expect(r.fallback).toBe("none");
    expect(r.needsOperator).toBe(false);
    expect(r.matches.map((m) => [m.cardIndex, m.via])).toEqual([[0, "number"]]);
    expect(r.unmatchedCardIndices).toEqual([1]);
    expect(r.suggestions).toEqual([]);
  });

  test("a prefix-stripped pair also counts as a number match", () => {
    const r = matchPublishedChecklist(
      [card("BCP-12", ["A One"]), card("SIG-B", ["B Two"])],
      [row("12", ["A One"]), row("2", ["B Two"])],
    );
    expect(r.fallback).toBe("none");
    expect(r.matches.map((m) => m.via)).toEqual(["prefixStripped"]);
  });

  test("an all-NNO checklist is unchanged: pairs by player as before, no fallback", () => {
    const r = matchPublishedChecklist(
      [card("NNO", ["Chris Potter"]), card("NNO", ["Jon Larson"])],
      [
        { number: "NNO", players: ["Chris Potter"], teams: [], noNumber: true },
        { number: "NNO", players: ["Jon Larson"], teams: [], noNumber: true },
      ],
    );
    expect(r.fallback).toBe("none");
    expect(r.needsOperator).toBe(false);
    expect(r.matches.map((m) => m.via)).toEqual(["player", "player"]);
  });

  test("numbered cards with only NNO rows never reach the fallback", () => {
    const r = matchPublishedChecklist(
      [card("12", ["Chris Potter"])],
      [{ number: "NNO", players: ["Chris Potter"], teams: [], noNumber: true }],
    );
    expect(r.fallback).toBe("none");
    expect(r.matches).toEqual([]);
  });

  test("multi-player cards pair on the whole set of players, in any order", () => {
    const r = matchPublishedChecklist(
      [card("SIG-A", ["Pete Alonso", "Juan Soto"])],
      [row("1", ["Juan Soto", "Pete Alonso"])],
    );
    expect(r.matches.map((m) => m.via)).toEqual(["playerName"]);
  });

  test("a card sharing only one of two players does not pair", () => {
    const r = matchPublishedChecklist(
      [card("SIG-A", ["Pete Alonso", "Juan Soto"])],
      [row("1", ["Pete Alonso"])],
    );
    expect(r.matches).toEqual([]);
    expect(r.needsOperator).toBe(true);
  });

  test("Bobby Witt Jr. equals Bobby Witt Jr", () => {
    const r = matchPublishedChecklist(
      [card("SIG-BW", ["Bobby Witt Jr."])],
      [row("8", ["Bobby Witt Jr"])],
    );
    expect(r.matches.map((m) => m.via)).toEqual(["playerName"]);
    expect(pairByPlayerName([{ players: ["Bobby Witt Jr."] }], [{ players: ["Bobby Witt Jr"] }])).toEqual([
      { cardIndex: 0, rowIndex: 0 },
    ]);
  });

  test("a name pair still carries a team disagreement and keeps the card's number out of it", () => {
    const r = matchPublishedChecklist(
      [card("SIG-A", ["A One"], ["Boston Red Sox"])],
      [row("1", ["A One"], ["Chicago Cubs"])],
    );
    expect(r.matches[0].conflict).toEqual({
      teams: { marketplace: ["Boston Red Sox"], checklist: ["Chicago Cubs"] },
    });
  });

  test("unusedRowIndices is sorted ascending", () => {
    const r = matchPublishedChecklist(
      [card("SIG-A", ["B Two"]), card("SIG-B", ["Nobody Listed"]), card("SIG-C", ["Also Missing"])],
      [row("1", ["X"]), row("2", ["B Two"]), row("3", ["Y"])],
    );
    expect(r.unusedRowIndices).toEqual([0, 2]);
  });

  test("pairByPlayerName gives no key to a card or row with no players", () => {
    expect(pairByPlayerName([{ players: [] }, {}], [{ players: [] }])).toEqual([]);
  });
});

describe("matchPublishedChecklist: NEO-489 No Team × NEO-490 player-name fallback", () => {
  const noTeamRow = (number: string, players: string[] = []) => ({
    number,
    players,
    teams: [] as string[],
    noTeam: true as const,
  });

  test("a No Team row paired by player name against a teamed card is a conflict with an empty checklist side", () => {
    const r = matchPublishedChecklist(
      [card("SIG-A", ["A One"], ["Boston Red Sox"]), card("SIG-B", ["B Two"])],
      [noTeamRow("1", ["A One"]), noTeamRow("2", ["B Two"])],
    );
    expect(r.fallback).toBe("playerName");
    expect(r.matches.map((m) => [m.cardIndex, m.rowIndex, m.via])).toEqual([
      [0, 0, "playerName"],
      [1, 1, "playerName"],
    ]);
    expect(r.matches[0].conflict).toEqual({
      teams: { marketplace: ["Boston Red Sox"], checklist: [] },
    });
    // A teamless card against a No Team row disagrees with nothing.
    expect(r.matches[1].conflict).toBeUndefined();
  });

  test("a card with only the legacy singular team conflicts with a No Team row paired by name too", () => {
    const legacy = { cardNumber: "SIG-A", players: ["A One"], team: "Boston Red Sox" };
    const r = matchPublishedChecklist([legacy], [noTeamRow("1", ["A One"])]);
    expect(r.matches[0]).toMatchObject({ via: "playerName" });
    expect(r.matches[0].conflict?.teams).toEqual({ marketplace: ["Boston Red Sox"], checklist: [] });
  });

  test("a case-folded number pair counts as a number pair, so the name fallback never runs", () => {
    const r = matchPublishedChecklist(
      [card("PPR-DLa", ["Derrek Lee"]), card("SIG-B", ["B Two"])],
      [noTeamRow("ppr-dla", ["Derrek Lee"]), noTeamRow("2", ["B Two"])],
    );
    expect(r.fallback).toBe("none");
    expect(r.matches.map((m) => [m.cardIndex, m.via])).toEqual([[0, "caseFolded"]]);
    expect(r.unmatchedCardIndices).toEqual([1]);
  });

  test("case-only twin numbers pair nothing, so the name fallback pairs them under the exactly-one guard", () => {
    // Cards "x1a" and "X1A" against one row "X1a": no number pair (the folded
    // key names two cards), counts differ, so nothing is applied and the
    // unique name pair is only a suggestion.
    const r = matchPublishedChecklist(
      [card("x1a", ["A One"]), card("X1A", ["B Two"])],
      [noTeamRow("X1a", ["A One"])],
    );
    expect(r.fallback).toBe("operator");
    expect(r.matches).toEqual([]);
    expect(r.suggestions).toEqual([{ cardIndex: 0, rowIndex: 0 }]);
  });
});
