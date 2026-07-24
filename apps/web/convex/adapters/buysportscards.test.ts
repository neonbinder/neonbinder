import { describe, expect, test } from "vitest";
import { parsePlayersField } from "./buysportscards";

/**
 * Fixtures below are the exact real strings pulled live from BSC's
 * bulk-upload catalog endpoint (2026 Topps Baseball base set, 708 cards,
 * 49 affected rows) while designing this fix — not invented examples.
 */
describe("parsePlayersField", () => {
  test("plain single player — unchanged behavior", () => {
    expect(parsePlayersField("Jonah Tong")).toEqual({
      players: ["Jonah Tong"],
      teams: [],
    });
  });

  test("plain multi-player comma/slash split — unchanged behavior", () => {
    expect(parsePlayersField("Mike Trout, Shohei Ohtani")).toEqual({
      players: ["Mike Trout", "Shohei Ohtani"],
      teams: [],
    });
    expect(parsePlayersField("Mike Trout/Shohei Ohtani")).toEqual({
      players: ["Mike Trout", "Shohei Ohtani"],
      teams: [],
    });
  });

  test("League Leaders — parenthetical player list with description before AND tag after", () => {
    expect(
      parsePlayersField(
        "National League Leaders RBI (Kyle Schwarber, Pete Alonso, Juan Soto) LL",
      ),
    ).toEqual({
      players: ["Kyle Schwarber", "Pete Alonso", "Juan Soto"],
      teams: [],
      namePrefix: "National League Leaders RBI LL",
    });
  });

  test("a second, differently-suffixed insert type — proves the parenthetical handling is generic, not League-Leaders-specific", () => {
    expect(
      parsePlayersField(
        "Fall Fling (Vladimir Guerrero Jr., George Springer) CPC",
      ),
    ).toEqual({
      players: ["Vladimir Guerrero Jr.", "George Springer"],
      teams: [],
      namePrefix: "Fall Fling CPC",
    });
  });

  test("parenthetical list with a slash separator inside", () => {
    expect(parsePlayersField("Muscle Men (Aaron Judge/Cody Bellinger) CPC")).toEqual({
      players: ["Aaron Judge", "Cody Bellinger"],
      teams: [],
      namePrefix: "Muscle Men CPC",
    });
  });

  test("parenthetical with no trailing tag — namePrefix is just the leading description", () => {
    expect(parsePlayersField("Stars Align (Mike Trout, Zach Neto)")).toEqual({
      players: ["Mike Trout", "Zach Neto"],
      teams: [],
      namePrefix: "Stars Align",
    });
  });

  test("Team Checklist card — team name reported into BOTH players and teams", () => {
    expect(parsePlayersField("Kansas City Royals TC")).toEqual({
      players: ["Kansas City Royals"],
      teams: ["Kansas City Royals"],
    });
  });

  test("single-word team names — suffix strip doesn't assume multi-word", () => {
    expect(parsePlayersField("Athletics TC")).toEqual({
      players: ["Athletics"],
      teams: ["Athletics"],
    });
    expect(parsePlayersField("Angels TC")).toEqual({
      players: ["Angels"],
      teams: ["Angels"],
    });
  });

  test("word-boundary check — a name that merely CONTAINS 'TC' with no preceding space is not stripped", () => {
    // No space before "TC" — must not be treated as a team-card suffix.
    expect(parsePlayersField("PlayerNamedTC")).toEqual({
      players: ["PlayerNamedTC"],
      teams: [],
    });
  });

  test("empty / whitespace-only input", () => {
    expect(parsePlayersField("")).toEqual({ players: [], teams: [] });
    expect(parsePlayersField("   ")).toEqual({ players: [], teams: [] });
  });
});
