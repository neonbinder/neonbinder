/**
 * Unit tests for convex/lib/pairing/names.ts — a case-for-case mirror of the
 * preprocess service's `tests/unit/test_pairing_names.py`.
 *
 * Covers: normalisation ordering (suffix stripping before punctuation
 * stripping, which is what keeps "Jr." working), the ported standalone-`v`
 * quirk, last-name extraction, and every rung of the player-name ladder —
 * exact, surname-only, single initial, truncated-first-name prefix with its
 * 2-character floor, and the disagreement case. Plus team matching by
 * equality and by containment.
 */

import { describe, expect, test } from "vitest";

import {
  MIN_PREFIX_CHARS,
  lastName,
  normalizePlayerName,
  playerNamesMatch,
  teamNamesMatch,
} from "./names";

describe("normalizePlayerName", () => {
  test("lowercases", () => {
    expect(normalizePlayerName("Walker BUEHLER")).toBe("walker buehler");
  });

  test.each([
    ["Ken Griffey Jr.", "ken griffey"],
    ["Ken Griffey Jr", "ken griffey"],
    ["Cal Ripken Sr.", "cal ripken"],
    ["Robert Griffin III", "robert griffin"],
    ["Robert Griffin II", "robert griffin"],
    ["Robert Griffin IV", "robert griffin"],
  ])("strips generational suffixes: %s", (raw, expected) => {
    expect(normalizePlayerName(raw)).toBe(expected);
  });

  test("suffix stripping precedes punctuation stripping", () => {
    // The suffix pattern absorbs its own trailing period. If punctuation
    // were stripped first the ordering assumption in the port would be
    // inverted, so this pins the observable outcome of the source order.
    expect(normalizePlayerName("Ken Griffey Jr.")).toBe("ken griffey");
  });

  test.each([
    ["P. Mahomes", "p mahomes"],
    ["Shaquille O'Neal", "shaquille oneal"],
    ["Jean-Luc Picard", "jeanluc picard"],
  ])("strips punctuation: %s", (raw, expected) => {
    expect(normalizePlayerName(raw)).toBe(expected);
  });

  test("collapses whitespace and trims", () => {
    expect(normalizePlayerName("  Walker   Buehler  ")).toBe("walker buehler");
  });

  test("standalone v quirk is ported verbatim", () => {
    // `\b(...|v)\b` strips a lone `v` from ANYWHERE in the name, not just a
    // trailing Roman-numeral suffix. Ported deliberately; documented in
    // names.ts. This test exists to make the quirk a decision, not a bug.
    expect(normalizePlayerName("Bobby V")).toBe("bobby");
  });

  test("v inside a word is untouched", () => {
    expect(normalizePlayerName("Vlad Guerrero")).toBe("vlad guerrero");
  });

  test("empty string", () => {
    expect(normalizePlayerName("")).toBe("");
  });
});

describe("lastName", () => {
  test("multi part", () => {
    expect(lastName("walker buehler")).toBe("buehler");
  });

  test("single part", () => {
    expect(lastName("buehler")).toBe("buehler");
  });

  test("three parts takes the last", () => {
    expect(lastName("jean luc picard")).toBe("picard");
  });
});

describe("playerNamesMatch", () => {
  test("identical names are exact", () => {
    expect(playerNamesMatch("Walker Buehler", "Walker Buehler")).toEqual({
      match: true,
      exact: true,
    });
  });

  test("case and suffix differences still exact", () => {
    // Both normalise to the same string, so this is an exact match.
    expect(playerNamesMatch("KEN GRIFFEY JR.", "Ken Griffey")).toEqual({
      match: true,
      exact: true,
    });
  });

  test("surname-only front matches full-name back", () => {
    // The headline fix from the source commit: a front printing only
    // "BUEHLER" must pair with a back reading "Walker Buehler".
    const result = playerNamesMatch("BUEHLER", "Walker Buehler");
    expect(result.match).toBe(true);
    expect(result.exact).toBe(false);
  });

  test("surname-only match is symmetric", () => {
    const result = playerNamesMatch("Walker Buehler", "BUEHLER");
    expect(result.match).toBe(true);
    expect(result.exact).toBe(false);
  });

  test.each([
    ["P. Mahomes", "Patrick Mahomes"],
    ["Patrick Mahomes", "P. Mahomes"],
  ])("single initial matches full first name: %s vs %s", (a, b) => {
    const result = playerNamesMatch(a, b);
    expect(result.match).toBe(true);
    expect(result.exact).toBe(false);
  });

  test("single initial that does not prefix is rejected", () => {
    expect(playerNamesMatch("T. Mahomes", "Patrick Mahomes").match).toBe(false);
  });

  test.each([
    ["Rob Gronkowski", "Robert Gronkowski"],
    ["Pat Mahomes", "Patrick Mahomes"],
    ["Robert Gronkowski", "Rob Gronkowski"],
  ])("truncated first-name prefix matches: %s vs %s", (a, b) => {
    const result = playerNamesMatch(a, b);
    expect(result.match).toBe(true);
    expect(result.exact).toBe(false);
  });

  test("prefix floor is driven by the production constant", () => {
    // A first name shorter than the floor may only match through the
    // single-initial rung, which requires a genuine prefix.
    const shorter = "x".repeat(MIN_PREFIX_CHARS - 1);
    expect(playerNamesMatch(`${shorter} Smith`, "Adam Smith").match).toBe(false);
  });

  test("different surnames never match", () => {
    expect(playerNamesMatch("Walker Buehler", "Walker Kershaw").match).toBe(false);
  });

  test("different first names with same surname do not match", () => {
    expect(playerNamesMatch("Walker Buehler", "Clayton Buehler").match).toBe(false);
  });
});

describe("teamNamesMatch", () => {
  test("identical is exact", () => {
    expect(teamNamesMatch("Dodgers", "Dodgers")).toEqual({ match: true, exact: true });
  });

  test("case and whitespace insensitive exact", () => {
    expect(teamNamesMatch("  DODGERS ", "dodgers")).toEqual({
      match: true,
      exact: true,
    });
  });

  test.each([
    ["Chiefs", "Kansas City Chiefs"],
    ["Kansas City Chiefs", "Chiefs"],
  ])("containment is a fuzzy match: %s vs %s", (a, b) => {
    const result = teamNamesMatch(a, b);
    expect(result.match).toBe(true);
    expect(result.exact).toBe(false);
  });

  test("unrelated teams do not match", () => {
    expect(teamNamesMatch("Chiefs", "Dodgers").match).toBe(false);
  });
});
