import { describe, expect, test } from "vitest";
import {
  bscCardNumberStem,
  isBscVariationRow,
  parsePlayersField,
  parseVariationDescription,
  resolveVariationParents,
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

  test("UER: (uncorrected error) is a variety too", () => {
    expect(parseVariationDescription("UER: Stats reversed")).toEqual({
      marker: "UER",
      text: "Stats reversed",
      isVariety: true,
    });
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

/**
 * NEO-189 — variation grouping.
 *
 * Fixtures are exact rows from BSC payloads pulled live 2026-08-27. The
 * counter-example set (2021 Topps) is the reason this rule is not the obvious
 * "bare number is the parent" one.
 */
describe("bscCardNumberStem", () => {
  test("splits a numeric stem from its alpha suffix", () => {
    expect(bscCardNumberStem("11")).toBe("11");
    expect(bscCardNumberStem("11b")).toBe("11");
    expect(bscCardNumberStem("1a")).toBe("1");
    expect(bscCardNumberStem("110")).toBe("110");
  });

  test("is case-insensitive — 2022 Heritage ships one uppercase suffix", () => {
    expect(bscCardNumberStem("232C")).toBe("232");
  });

  test("a non-numeric card number is its own stem (insert codes)", () => {
    expect(bscCardNumberStem("CC-JA")).toBe("CC-JA");
    expect(bscCardNumberStem("MIR-AJ")).toBe("MIR-AJ");
  });
});

describe("isBscVariationRow", () => {
  test("the VAR attribute token marks a variation", () => {
    expect(isBscVariationRow({ attributes: ["ASR", "SP", "VAR"] })).toBe(true);
  });

  test("a VAR: description marks a variation even with no token (2021 Heritage insert #251)", () => {
    expect(
      isBscVariationRow({ playerAttributeDesc: "VAR: Large Print" }),
    ).toBe(true);
  });

  test("SP alone is not a variation, and neither is a BASE description", () => {
    expect(isBscVariationRow({ attributes: ["SP"] })).toBe(false);
    expect(
      isBscVariationRow({ attributes: [], playerAttributeDesc: "BASE: Batting" }),
    ).toBe(false);
  });

  test("UER is a variety but not a variation — it has no parent to hang off", () => {
    expect(isBscVariationRow({ playerAttributeDesc: "UER: Stats reversed" })).toBe(
      false,
    );
  });
});

describe("resolveVariationParents", () => {
  test("2021 Topps Heritage #11 — bare parent, two suffixed variations", () => {
    const { parentByCardNumber, unresolvedVariationStems } =
      resolveVariationParents([
        { cardNumber: "11", attributes: [] },
        { cardNumber: "11b", attributes: ["ASR", "SP", "VAR"], playerAttributeDesc: "VAR: Action" },
        { cardNumber: "11c", attributes: ["ASR", "SP", "VAR"], playerAttributeDesc: "VAR: Alternate" },
      ]);
    expect(parentByCardNumber.get("11b")).toBe("11");
    expect(parentByCardNumber.get("11c")).toBe("11");
    expect(unresolvedVariationStems).toEqual([]);
  });

  test("COUNTER-EXAMPLE: 2021 Topps #1 — the parent is 1a, there is no bare #1", () => {
    const { parentByCardNumber, unresolvedVariationStems } =
      resolveVariationParents([
        { cardNumber: "1a", attributes: [], playerAttributeDesc: "BASE: Rounding Base" },
        { cardNumber: "1b", attributes: ["SP", "VAR"], playerAttributeDesc: "VAR: Sliding" },
        { cardNumber: "1c", attributes: ["SSP", "VAR"], playerAttributeDesc: "VAR: In Dugout" },
      ]);
    // The old bare-is-parent rule would have found no parent at all here.
    expect(parentByCardNumber.get("1b")).toBe("1a");
    expect(parentByCardNumber.get("1c")).toBe("1a");
    expect(unresolvedVariationStems).toEqual([]);
  });

  test("2021 Topps #10 — an RC base card still parents its variation", () => {
    const { parentByCardNumber } = resolveVariationParents([
      { cardNumber: "10a", attributes: ["RC"], playerAttributeDesc: "BASE: Batting" },
      { cardNumber: "10b", attributes: ["SP", "VAR"], playerAttributeDesc: "VAR: Grey Jersey, Running" },
    ]);
    expect(parentByCardNumber.get("10b")).toBe("10a");
  });

  test("a card with no variations produces no links", () => {
    const { parentByCardNumber, unresolvedVariationStems } =
      resolveVariationParents([
        { cardNumber: "110", attributes: ["IA"] },
        { cardNumber: "111", attributes: [] },
      ]);
    expect(parentByCardNumber.size).toBe(0);
    expect(unresolvedVariationStems).toEqual([]);
  });

  test("ORPHAN: 2021 Heritage insert #251 — both rows are variations, no parent", () => {
    const { parentByCardNumber, unresolvedVariationStems } =
      resolveVariationParents([
        { cardNumber: "251", attributes: [], playerAttributeDesc: "VAR: Large Print" },
        { cardNumber: "251", attributes: [], playerAttributeDesc: "VAR: Small Print" },
      ]);
    expect(parentByCardNumber.size).toBe(0);
    expect(unresolvedVariationStems).toEqual(["251"]);
  });

  test("AMBIGUOUS: 2021 Heritage insert #18 — a stem shared by unrelated cards", () => {
    const { parentByCardNumber, unresolvedVariationStems } =
      resolveVariationParents([
        { cardNumber: "18", attributes: ["VAR"], playerAttributeDesc: "VAR: Yellow under C and S" },
        { cardNumber: "18", attributes: ["PR200"] },
        { cardNumber: "18", attributes: [] },
        { cardNumber: "18", attributes: ["VAR"], playerAttributeDesc: "VAR: Green under C and S" },
      ]);
    expect(parentByCardNumber.size).toBe(0);
    expect(unresolvedVariationStems).toEqual(["18"]);
  });

  test("two variations sharing one cardNumber are flagged, never silently merged", () => {
    const { parentByCardNumber, unresolvedVariationStems } =
      resolveVariationParents([
        { cardNumber: "7", attributes: [] },
        { cardNumber: "7b", attributes: ["VAR"], playerAttributeDesc: "VAR: Action" },
        { cardNumber: "7b", attributes: ["VAR"], playerAttributeDesc: "VAR: Nickname" },
      ]);
    expect(parentByCardNumber.has("7b")).toBe(false);
    expect(unresolvedVariationStems).toEqual(["7"]);
  });

  test("insert codes with no numeric stem never group together", () => {
    const { parentByCardNumber, unresolvedVariationStems } =
      resolveVariationParents([
        { cardNumber: "CC-JA", attributes: ["MEM"] },
        { cardNumber: "CC-JA", attributes: ["MEM", "SN99"] },
        { cardNumber: "MIR-AJ", attributes: ["MEM"] },
      ]);
    expect(parentByCardNumber.size).toBe(0);
    expect(unresolvedVariationStems).toEqual([]);
  });
});

/**
 * NEO-189 — the "Legend" short-print convention, and why a same-player guard
 * on variation linking would be wrong. All rows are live 2026-08-27 data.
 */
describe("resolveVariationParents — a variation can be a different player", () => {
  test("2021 Topps #52 — Mickey Mantle is a variation OF an Archie Bradley card", () => {
    const { parentByCardNumber, unresolvedVariationStems } =
      resolveVariationParents([
        { cardNumber: "52", attributes: [], playerAttributeDesc: "BASE: Archie Bradley" },
        {
          cardNumber: "52b",
          attributes: ["SP", "VAR"],
          playerAttributeDesc: "VAR: Legend; Batting (Series 2 insert)",
        },
        {
          cardNumber: "52c",
          attributes: ["SSP", "VAR"],
          playerAttributeDesc: "VAR: Legend; Holding three bats (Series 2 insert)",
        },
      ]);
    expect(parentByCardNumber.get("52b")).toBe("52");
    expect(parentByCardNumber.get("52c")).toBe("52");
    expect(unresolvedVariationStems).toEqual([]);
  });

  test("2022 Heritage #201 — five variations of one team-highlight card", () => {
    const { parentByCardNumber } = resolveVariationParents([
      { cardNumber: "201", attributes: [] },
      { cardNumber: "201b", attributes: ["SP", "VAR"], playerAttributeDesc: "VAR: Player Icon Color Swap" },
      { cardNumber: "201c", attributes: ["SP", "VAR"], playerAttributeDesc: "VAR: Throwback Uniform Variation" },
      { cardNumber: "201d", attributes: ["SP", "VAR"], playerAttributeDesc: "VAR: Image Variation" },
      { cardNumber: "201e", attributes: ["SP", "VAR"], playerAttributeDesc: "VAR: Team & Name Color Swap Variation" },
      { cardNumber: "201f", attributes: ["SP", "VAR"], playerAttributeDesc: "VAR: Nickname Variation" },
    ]);
    expect([...parentByCardNumber.values()]).toEqual(["201", "201", "201", "201", "201"]);
  });

  test("2021 Topps #52d — the VAR token carries the row when the desc prefix does not", () => {
    // desc is "Ultra SP, VAR: Legend; ..." — no leading [A-Z]{2,4}: marker, so
    // only the attribute token identifies this as a variation. This is why
    // isBscVariationRow reads BOTH signals.
    const row = {
      cardNumber: "52d",
      attributes: ["SSP", "VAR"],
      playerAttributeDesc: "Ultra SP, VAR: Legend; Bat on shoulder, 1952 Topps photo",
    };
    expect(isBscVariationRow(row)).toBe(true);
    const { parentByCardNumber } = resolveVariationParents([
      { cardNumber: "52", attributes: [], playerAttributeDesc: "BASE: Archie Bradley" },
      row,
    ]);
    expect(parentByCardNumber.get("52d")).toBe("52");
  });
});
