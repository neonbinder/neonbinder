/**
 * NEO-330 — the one definition of "this team matches what was typed", shared
 * by `teams.searchForManagement` and Team Management's own filter. If the two
 * disagreed, the list would reshuffle the moment the server's answer replaced
 * the browser's.
 */

import { describe, expect, it } from "vitest";
import { normalizeEntityName } from "../entities/normalize-name";
import { teamFilterReadings, teamMatchesFilter } from "./team-filter";

const team = (fullName: string, aliases?: string[]) => ({
  nameNormalized: normalizeEntityName(fullName),
  aliases,
});

const matches = (fullName: string, typed: string, aliases?: string[]) =>
  teamMatchesFilter(team(fullName, aliases), teamFilterReadings(typed));

describe("teamMatchesFilter", () => {
  it("needs every typed word to start a word of the full name", () => {
    expect(matches("Pittsburgh Crawfords", "pittsburgh crawfords")).toBe(true);
    expect(matches("Pittsburgh Pirates", "pittsburgh crawfords")).toBe(false);
  });

  it("matches word starts, in any order, case- and punctuation-blind", () => {
    expect(matches("San Diego Padres", "san die")).toBe(true);
    expect(matches("San Diego Padres", "Padres SAN")).toBe(true);
    expect(matches("St. Louis Cardinals", "st louis")).toBe(true);
  });

  it("does not match the middle of a word", () => {
    expect(matches("San Diego Padres", "adres")).toBe(false);
  });

  it("matches on an alias, word by word", () => {
    expect(matches("Louisiana State Tigers", "lsu", ["LSU"])).toBe(true);
    expect(matches("Louisiana State Tigers", "lsu tig", ["LSU Tigers baseball"])).toBe(true);
    expect(matches("Louisiana State Tigers", "lsu", ["Louisiana State"])).toBe(false);
  });

  it("keeps a team listed on the keystroke after a run of initials (NEO-322)", () => {
    // "N. C. S" joins to "ncs", which starts no word of "nc state"; the second
    // reading keeps the last letter apart.
    expect(matches("N.C. State Wolfpack", "N. C. S")).toBe(true);
  });

  it("matches a minted single-token name by its whole token", () => {
    expect(matches("Loc0 TMTw0a112345", "TMTw0a112345")).toBe(true);
    expect(matches("Loc0 TMTw0a112345", "TMTw0a11234")).toBe(true);
    expect(matches("Loc0 TMTw0a112345", "TMTw0a1123456")).toBe(false);
  });

  it("matches every team when nothing matchable was typed", () => {
    expect(matches("Montreal Expos", "")).toBe(true);
    expect(matches("Montreal Expos", " .. ")).toBe(true);
    expect(teamFilterReadings("...")).toEqual([]);
  });
});
