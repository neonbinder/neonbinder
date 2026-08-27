import { describe, expect, test } from "vitest";
import {
  isBscVariationRow,
  parsePlayersField,
  parseVariationDescription,
} from "./buysportscards";

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

/**
 * NEO-189 — every fixture below is an exact `playerAttributeDesc` string
 * pulled live from BSC's bulk-upload catalog on 2026-08-27 for the 2021 Topps
 * Heritage baseball base set (908 rows). Distribution of rows carrying text in
 * that field: VAR: ×183, BASE/BASE: ×21, UER: ×1, no prefix ×29.
 *
 * The 51 BASE/unprefixed rows are the regression this suite pins: they used to
 * land in `cardVariation`, which feeds eBay's Parallel/Variety aspect via
 * `deriveCardFeatures`' `parallelName`.
 */
describe("parseVariationDescription", () => {
  test("VAR: is a variety — the marker is kept and the label is clean", () => {
    expect(parseVariationDescription("VAR: Action")).toEqual({
      marker: "VAR",
      text: "Action",
      isVariety: true,
    });
    expect(parseVariationDescription("VAR: Alternate")).toEqual({
      marker: "VAR",
      text: "Alternate",
      isVariety: true,
    });
    expect(parseVariationDescription("VAR: City / Throwback")).toEqual({
      marker: "VAR",
      text: "City / Throwback",
      isVariety: true,
    });
  });

  test("a compound VAR description keeps its whole label", () => {
    expect(parseVariationDescription("VAR: Error, Missing name on front")).toEqual({
      marker: "VAR",
      text: "Error, Missing name on front",
      isVariety: true,
    });
  });

  test("UER is an ATTRIBUTE, not a variation — it never becomes a variety name", () => {
    // An uncorrected error is a property of one card, not a second version of
    // it, so it has no parent to hang off. BSC also carries it as a token in
    // playerAttribute ("UER", "SP, UER"), which is where it belongs.
    expect(
      parseVariationDescription(
        'UER: Last name misspelled "Hendricks" on front and back',
      ),
    ).toEqual({
      marker: "UER",
      text: 'Last name misspelled "Hendricks" on front and back',
      isVariety: false,
    });
    expect(
      isBscVariationRow({
        attributes: ["UER"],
        playerAttributeDesc: "UER: Last name misspelled Stephenson",
      }),
    ).toBe(false);
  });

  test("REGRESSION: a bare BASE marker is not a variety (2021 Heritage #17, #45)", () => {
    expect(parseVariationDescription("BASE")).toEqual({
      text: "BASE",
      isVariety: false,
    });
  });

  test("REGRESSION: BASE: posed no longer becomes the variety 'posed' (2021 Heritage #99, #121)", () => {
    const parsed = parseVariationDescription("BASE: posed");
    expect(parsed).toEqual({ marker: "BASE", text: "posed", isVariety: false });
    // The specific old bug: the prefix was stripped and "posed" was surfaced
    // as if it named a parallel.
    expect(parsed?.isVariety).toBe(false);
  });

  test("REGRESSION: an unprefixed shelf note is not a variety (2021 Heritage #10, #14, #114)", () => {
    expect(
      parseVariationDescription("Puzzle piece B2 on back; see Comments"),
    ).toEqual({
      text: "Puzzle piece B2 on back; see Comments",
      isVariety: false,
    });
    expect(
      parseVariationDescription("Puzzle piece DD3 on back; see Comments"),
    ).toEqual({
      text: "Puzzle piece DD3 on back; see Comments",
      isVariety: false,
    });
  });

  test("empty, whitespace and non-string inputs yield undefined", () => {
    expect(parseVariationDescription("")).toBeUndefined();
    expect(parseVariationDescription("   ")).toBeUndefined();
    expect(parseVariationDescription(undefined)).toBeUndefined();
    expect(parseVariationDescription(null)).toBeUndefined();
    expect(parseVariationDescription(42)).toBeUndefined();
  });

  test("a marker with nothing after it is not a variety and never returns empty text", () => {
    expect(parseVariationDescription("VAR:")).toEqual({
      marker: "VAR",
      text: "VAR",
      isVariety: false,
    });
  });
});
