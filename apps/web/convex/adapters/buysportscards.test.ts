import { describe, expect, test } from "vitest";
import {
  isBscVariationRow,
  parsePlayersField,
  parseVariationDescription,
} from "./buysportscards";
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
