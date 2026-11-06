/**
 * NEO-426 — the one reader of "this sport has no teams", and the commit's
 * half of the default. The client's half (autoNoTeamIndexes) is pinned in
 * components/SetSelector/teams-on-cards.teamlessSport.test.tsx; the two must
 * agree.
 */
import { describe, expect, test } from "vitest";
import { defaultsToNoTeamOnCommit, isTeamlessSport } from "./teamlessSport";

describe("isTeamlessSport", () => {
  test.each([
    [{ level: "sport", hasNoTeams: true }, true],
    [{ level: "sport", hasNoTeams: false }, false],
    [{ level: "sport" }, false],
    // The flag means nothing below the sport, even if a row somehow carries it.
    [{ level: "setName", hasNoTeams: true }, false],
    [{ level: "year", hasNoTeams: true }, false],
    [null, false],
    [undefined, false],
  ] as const)("%j -> %s", (row, expected) => {
    expect(isTeamlessSport(row)).toBe(expected);
  });

  test("never reads the sport's name: a row called 'Baseball' with the flag is teamless", () => {
    expect(isTeamlessSport({ level: "sport", hasNoTeams: true, value: "Baseball" } as never)).toBe(true);
    expect(isTeamlessSport({ level: "sport", value: "Pokemon" } as never)).toBe(false);
  });
});

describe("defaultsToNoTeamOnCommit", () => {
  const base = {
    playerIds: ["p1"],
    unaccountedPlayerNameCount: 0,
    teamlessPlayerIds: new Set(["p1"]),
    teamCount: 0,
    pendingTeamCount: 0,
    hasListedTeamClaim: false,
    hasBscRef: false,
  };

  test("the plain case is true", () => {
    expect(defaultsToNoTeamOnCommit(base)).toBe(true);
  });

  test("with no BSC ref an absent lookup is fine; an answered one too", () => {
    expect(defaultsToNoTeamOnCommit({ ...base, teamLookup: "answered" })).toBe(true);
    expect(defaultsToNoTeamOnCommit({ ...base, teamLookup: undefined })).toBe(true);
  });

  test("with a BSC ref only an ANSWERED lookup defaults; undefined and failed do not", () => {
    const bsc = { ...base, hasBscRef: true };
    expect(defaultsToNoTeamOnCommit({ ...bsc, teamLookup: "answered" })).toBe(true);
    expect(defaultsToNoTeamOnCommit({ ...bsc, teamLookup: undefined })).toBe(false);
    expect(defaultsToNoTeamOnCommit({ ...bsc, teamLookup: "failed" })).toBe(false);
  });

  test.each([
    ["no players", { playerIds: [], teamlessPlayerIds: new Set<string>() }],
    ["a player in a sport with teams", { playerIds: ["p1", "p2"] }],
    ["a player not in the flagged set at all", { teamlessPlayerIds: new Set<string>() }],
    ["an unaccounted printed name", { unaccountedPlayerNameCount: 1 }],
    ["a team on the card", { teamCount: 1 }],
    ["a pending team name", { pendingTeamCount: 1 }],
    ["a listed team claim", { hasListedTeamClaim: true }],
    ["a failed team lookup", { teamLookup: "failed" as const }],
  ])("is false with %s", (_label, override) => {
    expect(defaultsToNoTeamOnCommit({ ...base, ...override })).toBe(false);
  });

  test("a flagged set larger than the card's players does not matter", () => {
    expect(
      defaultsToNoTeamOnCommit({ ...base, teamlessPlayerIds: new Set(["p1", "p9", "p10"]) }),
    ).toBe(true);
  });
});
