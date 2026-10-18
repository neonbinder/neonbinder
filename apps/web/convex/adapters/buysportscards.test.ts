import { describe, expect, test } from "vitest";
import {
  isBscVariationRow,
  normalizeBscAttributeTokens,
  parsePlayerAttributeTokens,
  parsePlayersField,
  parseVariationDescription,
} from "./buysportscards";
import {
  MAX_BSC_ATTRIBUTE_TOKENS,
  MAX_BSC_ATTRIBUTE_TOKEN_LENGTH,
  boundBscAttributeTokens,
  isBscAttributeLabel,
  normalizeBscAttributeTokensDetailed,
} from "../lib/bscAttributeTokens";
import { MAX_PLAYER_NAME_LENGTH } from "../../lib/players/name-limits";
import { MAX_CARD_PLAYERS, MAX_CARD_TEAMS } from "../features/cardAttention";

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

  test("NEO-333: a pipe separates players, with or without surrounding spaces", () => {
    expect(parsePlayersField("Mike Trout | Shohei Ohtani")).toEqual({
      players: ["Mike Trout", "Shohei Ohtani"],
      teams: [],
    });
    expect(parsePlayersField("Mike Trout|Shohei Ohtani")).toEqual({
      players: ["Mike Trout", "Shohei Ohtani"],
      teams: [],
    });
  });

  test("NEO-333: a pipe inside a parenthetical list splits too", () => {
    expect(parsePlayersField("Muscle Men (Aaron Judge|Cody Bellinger) CPC")).toEqual({
      players: ["Aaron Judge", "Cody Bellinger"],
      teams: [],
      namePrefix: "Muscle Men CPC",
    });
  });

  test("NEO-333: a suffix after a comma re-attaches instead of becoming a player", () => {
    expect(parsePlayersField("Ken Griffey, Jr., Mike Trout")).toEqual({
      players: ["Ken Griffey Jr.", "Mike Trout"],
      teams: [],
    });
  });

  test("NEO-333: a Team Checklist value is NOT split, even when the team name carries a comma or slash", () => {
    // The TC branch reports the whole team name; the comma/pipe splitter is a
    // player rule and must not cut a team.
    expect(parsePlayersField("Korea, South TC")).toEqual({
      players: ["Korea, South"],
      teams: ["Korea, South"],
    });
    expect(parsePlayersField("Bodø/Glimt TC")).toEqual({
      players: ["Bodø/Glimt"],
      teams: ["Bodø/Glimt"],
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

  test("NEO-343: a Team Leaders card (TL) parses exactly like a Team Checklist card", () => {
    // 2014 Topps Football: BSC sends "Buffalo Bills TL" where SportLots sends
    // "Buffalo Bills". Before the fix the whole string became a "player", no
    // team was set, and the card name read "Buffalo Bills TL" — a name AND a
    // players conflict on every team card in the Match Cards dialog.
    expect(parsePlayersField("Buffalo Bills TL")).toEqual({
      players: ["Buffalo Bills"],
      teams: ["Buffalo Bills"],
    });
    expect(parsePlayersField("Buffalo Bills TL")).toEqual(
      parsePlayersField("Buffalo Bills TC"),
    );
    // Single-word team name, as for TC.
    expect(parsePlayersField("Packers TL")).toEqual({
      players: ["Packers"],
      teams: ["Packers"],
    });
    // Surrounding whitespace is trimmed before the suffix is read.
    expect(parsePlayersField("  Buffalo Bills TL  ")).toEqual({
      players: ["Buffalo Bills"],
      teams: ["Buffalo Bills"],
    });
  });

  test("NEO-343: 'TL' counts only as a whitespace-separated, upper-case final token", () => {
    // A surname ending in "tl" is a player, not a team card.
    expect(parsePlayersField("Kevin Battl")).toEqual({
      players: ["Kevin Battl"],
      teams: [],
    });
    // No preceding whitespace — not a suffix.
    expect(parsePlayersField("PlayerNamedTL")).toEqual({
      players: ["PlayerNamedTL"],
      teams: [],
    });
    // Lower/mixed case is not the BSC marker (the match is case-sensitive,
    // as it is for TC).
    expect(parsePlayersField("Kevin Tl")).toEqual({
      players: ["Kevin Tl"],
      teams: [],
    });
    // Anchored at the end: a leading or interior "TL" is part of a name.
    expect(parsePlayersField("TL Hardy")).toEqual({
      players: ["TL Hardy"],
      teams: [],
    });
    expect(parsePlayersField("Buffalo TL Bills")).toEqual({
      players: ["Buffalo TL Bills"],
      teams: [],
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
 * NEO-246/NEO-251 — this parser cannot emit a card the commit boundary would
 * refuse, and it never invents one either.
 *
 * `assertCardBatchWithinLimits` (convex/selectorOptions.ts) throws on a card
 * carrying more than `MAX_CARD_PLAYERS` / `MAX_CARD_TEAMS` names or a name
 * over `MAX_PLAYER_NAME_LENGTH`. That is the right answer for a payload a
 * client hands us and the wrong one for a real upstream row, which would fail
 * an operator's whole sync over a page NB merely read — so the bound is closed
 * here as well. The strings below are shaped like the failure that motivates
 * it: a checklist blob landing in the single free-text player field.
 *
 * The two bounds resolve DIFFERENTLY, and that is the point of this suite:
 *
 *   - Over the COUNT cap, the roster is REFUSED whole. Keeping the first 20 of
 *     27 mints a plausible roster out of a field NB has misread, and a wrong
 *     roster that looks right is worse than none — nothing downstream can tell
 *     it from a real one. Same rule the pairing conflict states.
 *   - Over the per-name LENGTH cap, that ONE name is dropped and its
 *     neighbours stand, because a long name says nothing about them.
 *
 * Either way the row reports `unrepresentable` so `fetchBscChecklist` can
 * count it. Every bound is asserted against the imported constant, never a
 * literal, so lowering a cap tightens the parser instead of stranding it above
 * the DB.
 */
describe("parsePlayersField bounds what one card can carry (NEO-246, NEO-251)", () => {
  const longName = "Z".repeat(MAX_PLAYER_NAME_LENGTH + 1);
  const atLimitName = "Y".repeat(MAX_PLAYER_NAME_LENGTH);

  test("a plain list past the player cap is REFUSED whole, never trimmed", () => {
    const names = Array.from(
      { length: MAX_CARD_PLAYERS + 7 },
      (_, i) => `Player ${String(i).padStart(2, "0")}`,
    );
    const parsed = parsePlayersField(names.join(", "));

    // Not `names.slice(0, MAX_CARD_PLAYERS)`. A truncated roster is a wrong
    // roster that looks right, and it would be committed and listed as fact.
    expect(parsed.players).toEqual([]);
    expect(parsed.teams).toEqual([]);
    expect(parsed.unrepresentable).toBe(true);
  });

  test("the parenthetical multi-player path is refused the same way, and keeps its description", () => {
    const names = Array.from(
      { length: MAX_CARD_PLAYERS + 3 },
      (_, i) => `Player ${String(i).padStart(2, "0")}`,
    );
    const parsed = parsePlayersField(
      `National League Leaders RBI (${names.join(", ")}) LL`,
    );

    expect(parsed.players).toEqual([]);
    expect(parsed.unrepresentable).toBe(true);
    // The surrounding text is NB card-name data, not a roster — the refusal
    // does not take it along.
    expect(parsed.namePrefix).toBe("National League Leaders RBI LL");
  });

  test("an over-long name is DROPPED, not truncated — the rest of the row survives", () => {
    const parsed = parsePlayersField(`Mike Trout, ${longName}, Zach Neto`);

    expect(parsed.players).toEqual(["Mike Trout", "Zach Neto"]);
    // Truncating would mint a person who does not exist and hand them to
    // `players.findOrCreate` looking exactly like a real name.
    expect(parsed.players.some((n) => n.startsWith("Z".repeat(20)))).toBe(false);
    // Dropped, but not silently.
    expect(parsed.unrepresentable).toBe(true);
  });

  test("a list exactly AT the player cap is kept whole, and reports nothing", () => {
    // The other side of the off-by-one: the cap must not tighten below what
    // the DB accepts, or the adapter drops names NB would have taken.
    const names = Array.from(
      { length: MAX_CARD_PLAYERS },
      (_, i) => `Player ${String(i).padStart(2, "0")}`,
    );
    expect(parsePlayersField(names.join(", "))).toEqual({
      players: names,
      teams: [],
    });
  });

  test("a name exactly at the length limit is kept", () => {
    expect(parsePlayersField(atLimitName)).toEqual({
      players: [atLimitName],
      teams: [],
    });
  });

  test("a Team Checklist row with an over-long team name emits nothing, and says so", () => {
    // Both sides drop it: a team NB would refuse is not a team to link, and
    // the players row this path also creates would carry the same bad name.
    // The card then falls through to `Card #<n>`, which is exactly why this
    // must report rather than look like an ordinary nameless row.
    expect(parsePlayersField(`${longName} TC`)).toEqual({
      players: [],
      teams: [],
      unrepresentable: true,
    });
  });

  test("an ordinary row carries no marker at all", () => {
    // `unrepresentable` is absent, not `false`, so the common case still
    // compares equal to a plain `{ players, teams }` — which is what every
    // real-data fixture above asserts.
    expect(parsePlayersField("Mike Trout, Shohei Ohtani")).toEqual({
      players: ["Mike Trout", "Shohei Ohtani"],
      teams: [],
    });
  });

  test("a Team Checklist row stays within the narrower TEAM cap", () => {
    // This path emits one name per side, so it is inside `MAX_CARD_TEAMS` by
    // construction — asserted against the constant so a future multi-team
    // parse cannot quietly outgrow it.
    const { teams } = parsePlayersField("Kansas City Royals TC");
    expect(teams.length).toBeLessThanOrEqual(MAX_CARD_TEAMS);
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

/**
 * NEO-345 — BSC attribute tokens read into NB's vocabulary. The raw strings
 * below are the exact `playerAttribute` values BSC's public card-listing
 * endpoint returned when probed for autograph cards ("AU, SN1",
 * "AU ,  SN50", "AU, MEM, SN49, EXCH", "FY, AU, RC").
 */
describe("normalizeBscAttributeTokens (NEO-345)", () => {
  const norm = (raw: string) =>
    normalizeBscAttributeTokens(parsePlayerAttributeTokens(raw));

  test("SN<n> becomes NUM with the print run, replacing the raw token", () => {
    expect(norm("AU, SN25")).toEqual({ attributes: ["AU", "NUM"], printRun: 25 });
  });

  test("odd spacing around BSC's comma still reads", () => {
    expect(norm("AU ,  SN50")).toEqual({ attributes: ["AU", "NUM"], printRun: 50 });
  });

  test("1/1 and SN1 are both a print run of one", () => {
    expect(norm("1/1")).toEqual({ attributes: ["NUM"], printRun: 1 });
    expect(norm("AU, SN1")).toEqual({ attributes: ["AU", "NUM"], printRun: 1 });
  });

  test("memorabilia tokens become RELIC; unknown tokens are kept raw", () => {
    expect(norm("AU, MEM, SN49, EXCH")).toEqual({
      attributes: ["AU", "RELIC", "EXCH", "NUM"],
      printRun: 49,
    });
    expect(norm("JSY").attributes).toEqual(["RELIC"]);
    expect(norm("Patch, Jersey").attributes).toEqual(["RELIC"]);
  });

  test("case-folded: known tokens take their canonical spelling", () => {
    expect(norm("au, rc, sn10")).toEqual({
      attributes: ["AU", "RC", "NUM"],
      printRun: 10,
    });
  });

  test("RC, SP, SSP, VAR, UER and the descriptive tokens are kept, never dropped", () => {
    expect(norm("FY, AU, RC").attributes).toEqual(["FY", "AU", "RC"]);
    expect(norm("ASR, SP, VAR").attributes).toEqual(["ASR", "SP", "VAR"]);
    expect(norm("SSP, UER, IA, BP, FBC, MGR, HC, PC").attributes).toEqual([
      "SSP",
      "UER",
      "IA",
      "BP",
      "FBC",
      "MGR",
      "HC",
      "PC",
    ]);
  });

  test("an out-of-range serial is not a print run and is kept raw", () => {
    expect(norm("SN0")).toEqual({ attributes: ["SN0"] });
    expect(norm("SN1000001")).toEqual({ attributes: ["SN1000001"] });
    expect(norm("SN1000000")).toEqual({ attributes: ["NUM"], printRun: 1_000_000 });
  });

  test("two different print runs on one card: NUM, no print run, BSC's tokens kept", () => {
    expect(norm("SN25, SN50")).toEqual({ attributes: ["NUM", "SN25", "SN50"] });
  });

  test("idempotent: a normalised list normalises to itself", () => {
    const once = norm("AU, MEM, SN49, RC");
    expect(normalizeBscAttributeTokens(once.attributes)).toEqual({
      attributes: once.attributes,
    });
  });

  test("the detailed form names the raw tokens that carried the print run", () => {
    expect(normalizeBscAttributeTokensDetailed(["AU", "SN25"])).toEqual({
      attributes: ["AU", "NUM"],
      printRun: 25,
      printRunTokens: ["SN25"],
    });
  });

  test("never decides an autograph format: AU is only AU", () => {
    expect(norm("AU").attributes).toEqual(["AU"]);
  });

  test("VAR still marks a variation after normalising", () => {
    const { attributes } = norm("SP, VAR");
    expect(isBscVariationRow({ attributes })).toBe(true);
  });
});

describe("boundBscAttributeTokens (NEO-345)", () => {
  test("drops an over-long token, never truncates it", () => {
    const long = "X".repeat(MAX_BSC_ATTRIBUTE_TOKEN_LENGTH + 1);
    expect(boundBscAttributeTokens(["AU", long, "  "]).tokens).toEqual(["AU"]);
  });

  test("refuses an over-long list whole", () => {
    const many = Array.from({ length: MAX_BSC_ATTRIBUTE_TOKENS + 1 }, (_, i) => `T${i}`);
    expect(boundBscAttributeTokens(many)).toEqual({ tokens: [], refused: true });
  });
});

describe("isBscAttributeLabel (NEO-345)", () => {
  test("the live case: teamName 'AU  SN1' with no playerAttribute", () => {
    expect(isBscAttributeLabel("AU  SN1", [])).toBe(true);
  });

  test("a value equal to the payload's own tokens is the label", () => {
    expect(isBscAttributeLabel("AU SN25 XYZ", ["AU", "SN25", "XYZ"])).toBe(true);
  });

  test("a real team is never the label", () => {
    expect(isBscAttributeLabel("Seattle Mariners", ["AU", "SN50"])).toBe(false);
    expect(isBscAttributeLabel("New York Yankees", [])).toBe(false);
    expect(isBscAttributeLabel("Korea, South", [])).toBe(false);
  });

  test("a team name that merely contains a token word is not the label", () => {
    expect(isBscAttributeLabel("RC Lens", [])).toBe(false);
  });

  test("empty is not a label", () => {
    expect(isBscAttributeLabel("", [])).toBe(false);
    expect(isBscAttributeLabel("   ", ["AU"])).toBe(false);
  });
});
