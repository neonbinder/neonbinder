/**
 * NEO-254 — the era arithmetic, and the one asymmetry in it.
 *
 * Two Winnipeg Jets exist: 1972-1996 (which became the Coyotes and then Utah)
 * and 2011- (the revived name on the old Atlanta Thrashers). Under the NEO-236
 * key they were one row, so a 1985 card and a 2015 card pointed at the same
 * team. These functions are what tells them apart.
 *
 * The property worth guarding hardest is the one a future simplification would
 * quietly drop: **an undated row is never excluded**. "We never recorded this
 * team's years" and "this team was not active then" are different facts, and
 * collapsing them is how a card silently binds to the wrong era.
 */

import { describe, expect, test } from "vitest";
import {
  eraCoversYear,
  eraLabel,
  erasOverlap,
  teamOptionLabel,
  teamsActiveInYear,
} from "./team-era";

const OLD_JETS = { yearsActive: { from: 1972, to: 1996 } };
const NEW_JETS = { yearsActive: { from: 2011 } };
const UNDATED = {};

describe("eraLabel", () => {
  test.each([
    [{ from: 1972, to: 1996 }, "1972–1996"],
    [{ from: 2011 }, "2011–present"],
    [{ from: 1969, to: 1969 }, "1969–1969"],
  ])("%o reads as %s", (years, expected) => {
    expect(eraLabel(years)).toBe(expected);
  });

  test("an undated row gets no label rather than an empty range", () => {
    // "Winnipeg Jets · " with nothing after it reads as a rendering bug.
    expect(eraLabel(undefined)).toBe("");
  });
});

describe("eraCoversYear", () => {
  test.each([
    ["the first season", 1972, true],
    ["the last season", 1996, true],
    ["mid-era", 1985, true],
    ["the year before", 1971, false],
    ["the year after", 1997, false],
  ])("a closed era and %s", (_label, year, expected) => {
    expect(eraCoversYear(OLD_JETS.yearsActive, year)).toBe(expected);
  });

  test("an open era runs forever", () => {
    expect(eraCoversYear(NEW_JETS.yearsActive, 2011)).toBe(true);
    expect(eraCoversYear(NEW_JETS.yearsActive, 2_099)).toBe(true);
    expect(eraCoversYear(NEW_JETS.yearsActive, 2010)).toBe(false);
  });

  test("an UNDATED era covers every year", () => {
    // The rule the whole module rests on. Not "matches nothing" — unknown.
    expect(eraCoversYear(undefined, 1900)).toBe(true);
    expect(eraCoversYear(undefined, 2100)).toBe(true);
  });

  test("no tolerance window, unlike the player narrowing", () => {
    // A career span is assembled from stints that may be missing their first
    // or last season, so it needs slack. `yearsActive` is one recorded fact
    // about when a franchise existed, and widening it would let a 1997 card
    // match a team that had already folded.
    expect(eraCoversYear(OLD_JETS.yearsActive, 1997)).toBe(false);
    expect(eraCoversYear(OLD_JETS.yearsActive, 1998)).toBe(false);
  });
});

describe("erasOverlap", () => {
  test("the two Jets do not overlap — that is what makes them two rows", () => {
    expect(erasOverlap(OLD_JETS.yearsActive, NEW_JETS.yearsActive)).toBe(false);
  });

  test("touching at a single season counts as overlapping", () => {
    expect(erasOverlap({ from: 1972, to: 1996 }, { from: 1996, to: 2000 })).toBe(
      true,
    );
  });

  test("an open era overlaps anything that starts before it ends", () => {
    expect(erasOverlap({ from: 2011 }, { from: 1990, to: 2015 })).toBe(true);
    expect(erasOverlap({ from: 2011 }, { from: 1990, to: 2010 })).toBe(false);
  });

  test("an undated side is unknown, so NOT ruled out", () => {
    // The asymmetry with `eraCoversYear`'s filter: this decides whether two
    // ROWS are the same team, and errs toward refusing the write rather than
    // toward creating a second Winnipeg Jets by accident.
    expect(erasOverlap(undefined, OLD_JETS.yearsActive)).toBe(true);
    expect(erasOverlap(OLD_JETS.yearsActive, undefined)).toBe(true);
    expect(erasOverlap(undefined, undefined)).toBe(true);
  });
});

describe("teamsActiveInYear", () => {
  const rows = [OLD_JETS, NEW_JETS, UNDATED];

  test("a 1985 card sees the old Jets — and the undated row", () => {
    expect(teamsActiveInYear(rows, 1985)).toEqual([OLD_JETS, UNDATED]);
  });

  test("a 2015 card sees the new Jets — and the undated row", () => {
    expect(teamsActiveInYear(rows, 2015)).toEqual([NEW_JETS, UNDATED]);
  });

  test("with no year NOTHING is narrowed", () => {
    // Rule 1 of the player narrowing, restated: the year is the evidence, and
    // with no evidence the answer is a human — never the first row an index
    // returned.
    expect(teamsActiveInYear(rows, undefined)).toEqual(rows);
    expect(teamsActiveInYear(rows, Number.NaN)).toEqual(rows);
  });

  test("returns a new array — the caller's list is never mutated", () => {
    const out = teamsActiveInYear(rows, undefined);
    expect(out).not.toBe(rows);
  });
});

describe("teamOptionLabel", () => {
  test("names the era when there is one", () => {
    expect(teamOptionLabel("Winnipeg Jets", OLD_JETS.yearsActive)).toBe(
      "Winnipeg Jets · 1972–1996",
    );
  });

  test("leaves an undated row as its plain name", () => {
    expect(teamOptionLabel("Winnipeg Jets", undefined)).toBe("Winnipeg Jets");
  });
});
