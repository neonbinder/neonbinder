import { describe, expect, it } from "vitest";
import { NO_TEAM_AND_A_TEAM, checklistClaimsNoTeam, isNoClaimTeamText, isNoTeamText } from "./no-team";

describe("isNoTeamText", () => {
  it.each(["No Team", "no team", "NO TEAM", "NO  TEAM", "  No\tTeam  ", "No Team", "Ｎｏ Ｔｅａｍ"])(
    "reads %j as No Team",
    (text) => {
      expect(isNoTeamText(text)).toBe(true);
    },
  );

  it.each(["None", "N/A", "No team listed", "-", "—", "TBD", "Unknown", "?", "No Team.", "", "  ", "NoTeam", "No Teams", "No Team Card", "No Team / Mets", "Team"])(
    "does not read %j as No Team",
    (text) => {
      expect(isNoTeamText(text)).toBe(false);
    },
  );

  it("exports the skip reason", () => {
    expect(NO_TEAM_AND_A_TEAM).toBe("Says No Team and names a team — pick one.");
  });
});

describe("checklistClaimsNoTeam", () => {
  it("claims when the lookup is checklist and the card has no team", () => {
    expect(checklistClaimsNoTeam({ teamLookup: "checklist" })).toBe(true);
    expect(checklistClaimsNoTeam({ teamLookup: "checklist", teams: [], team: "" })).toBe(true);
  });

  it("treats blank team strings as no team", () => {
    expect(checklistClaimsNoTeam({ teamLookup: "checklist", teams: ["", "  "], team: "  " })).toBe(true);
  });

  it("does not claim when a team string is present", () => {
    expect(checklistClaimsNoTeam({ teamLookup: "checklist", teams: ["Reds"] })).toBe(false);
  });

  it("does not claim when only the legacy singular team is present", () => {
    expect(checklistClaimsNoTeam({ teamLookup: "checklist", team: "Reds" })).toBe(false);
  });

  it.each(["answered", "failed", undefined])("does not claim for lookup %j", (teamLookup) => {
    expect(checklistClaimsNoTeam({ teamLookup, teams: [] })).toBe(false);
  });
});

describe("isNoClaimTeamText", () => {
  it.each([
    "none",
    "None",
    "N/A",
    "n/a",
    "No team listed",
    " no  team  listed ",
    "-",
    "Ｎ／Ａ",
    // Audit additions: dashes, placeholders, and a trailing period.
    "—",
    "–",
    " — ",
    "TBD",
    "tbd",
    "Unknown",
    "UNKNOWN",
    "?",
    "NA",
    "na",
    "n/a.",
    "N/A.",
    "None.",
    "TBD.",
    "Unknown.",
    "No team listed.",
    "n/a .",
  ])(
    "reads %j as a cell that says nothing",
    (text) => {
      expect(isNoClaimTeamText(text)).toBe(true);
    },
  );

  it.each([
    "No Team",
    "No Team.",
    "Reds",
    "",
    ".",
    "N/A / Reds",
    "--",
    "——",
    "??",
    "None of them",
    "n/a..",
    "Unknown Soldiers",
    "TBD Reds",
    "Nationals",
    "St. Louis Cardinals",
  ])(
    "does not read %j as a no-claim cell",
    (text) => {
      expect(isNoClaimTeamText(text)).toBe(false);
    },
  );
});
