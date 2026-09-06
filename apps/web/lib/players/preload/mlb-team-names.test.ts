/**
 * NEO-254 — the Lahman team-name split.
 *
 * Two things matter here and neither is "does the table have the right number
 * of rows": the default rule must reconstruct the name it was given, and a
 * name the table does not know but plainly needs must FAIL rather than split
 * wrongly. The second is what stops a Lahman refresh from silently producing
 * "Chicago Green" / "Sox".
 */

import { describe, expect, test } from "vitest";

import {
  MLB_TEAM_NAME_SPLITS,
  splitMlbTeamName,
} from "./mlb-team-names";

describe("splitMlbTeamName", () => {
  test("default rule: the last word is the nickname", () => {
    expect(splitMlbTeamName("Milwaukee Brewers")).toEqual({
      location: "Milwaukee",
      nickname: "Brewers",
    });
  });

  test("a two-word location still works, because only the LAST word is taken", () => {
    expect(splitMlbTeamName("Tampa Bay Rays")).toEqual({
      location: "Tampa Bay",
      nickname: "Rays",
    });
    expect(splitMlbTeamName("St. Louis Cardinals")).toEqual({
      location: "St. Louis",
      nickname: "Cardinals",
    });
  });

  test("multi-word nicknames come from the table", () => {
    expect(splitMlbTeamName("Boston Red Sox")).toEqual({
      location: "Boston",
      nickname: "Red Sox",
    });
    expect(splitMlbTeamName("Hartford Dark Blues")).toEqual({
      location: "Hartford",
      nickname: "Dark Blues",
    });
    expect(splitMlbTeamName("Houston Colt .45's")).toEqual({
      location: "Houston",
      nickname: "Colt .45's",
    });
    expect(splitMlbTeamName("Los Angeles Angels of Anaheim")).toEqual({
      location: "Los Angeles",
      nickname: "Angels of Anaheim",
    });
  });

  test("a name with no place in it gets a blank location, not a guessed one", () => {
    // The 2025 Athletics dropped their city outright.
    expect(splitMlbTeamName("Athletics")).toEqual({
      location: "",
      nickname: "Athletics",
    });
  });

  test("REFUSES a name whose nickname clearly runs long but is not listed", () => {
    // The guard that keeps the table honest across a dataset refresh.
    expect(() => splitMlbTeamName("Chicago Green Sox")).toThrow(
      /MLB_TEAM_NAME_SPLITS/,
    );
    expect(() => splitMlbTeamName("Buffalo Golden Bisons")).toThrow(
      /multi-word nickname/,
    );
  });

  test("REFUSES an unknown single-word name rather than inventing a location", () => {
    expect(() => splitMlbTeamName("Guardians")).toThrow(/single word/);
  });

  test("refuses an empty name", () => {
    expect(() => splitMlbTeamName("   ")).toThrow(/empty team name/);
  });

  test("every table entry reconstructs the name it is keyed by", () => {
    // A typo in a location or nickname would otherwise mean the row NB creates
    // and the halves NEO-236 will split it into disagree.
    for (const [name, split] of Object.entries(MLB_TEAM_NAME_SPLITS)) {
      const rebuilt = split.location
        ? `${split.location} ${split.nickname}`
        : split.nickname;
      expect(rebuilt).toBe(name);
      expect(split.nickname).not.toBe("");
    }
  });

  test("no table entry is redundant with the default rule", () => {
    // An entry the default already gets right is dead weight that will drift.
    // Checked by splitting the name with the default rule directly.
    for (const [name, split] of Object.entries(MLB_TEAM_NAME_SPLITS)) {
      const words = name.split(/\s+/);
      if (words.length < 2) continue; // no-location entries are legitimately here
      const defaultSplit = {
        location: words.slice(0, -1).join(" "),
        nickname: words[words.length - 1],
      };
      expect(
        defaultSplit.location === split.location &&
          defaultSplit.nickname === split.nickname,
      ).toBe(false);
    }
  });
});
