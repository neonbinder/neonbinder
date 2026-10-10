/**
 * NEO-333 — the shared splitter that cuts one marketplace free-text value into
 * the players or teams it names.
 *
 * Pure functions, so no convex-test harness. The two named wrappers are what
 * the adapters call; `splitMarketplaceNames` is covered through them.
 */

import { describe, expect, test } from "vitest";
import {
  GENERATIONAL_SUFFIX_ONLY,
  boundParsedNames,
  splitMarketplacePlayerNames,
  splitMarketplaceTeamNames,
  stripZeroWidth,
} from "./marketplaceNames";
import { MAX_CARD_PLAYERS, MAX_CARD_TEAMS } from "../features/cardAttention";
import { MAX_PLAYER_NAME_LENGTH } from "../../lib/players/name-limits";

describe("splitMarketplacePlayerNames: separators", () => {
  test.each([
    ["comma and space", "Mike Trout, Shohei Ohtani"],
    ["comma, no space", "Mike Trout,Shohei Ohtani"],
    ["slash with spaces", "Mike Trout / Shohei Ohtani"],
    ["slash, no spaces", "Mike Trout/Shohei Ohtani"],
    ["pipe with spaces", "Mike Trout | Shohei Ohtani"],
    ["pipe, no spaces", "Mike Trout|Shohei Ohtani"],
  ])("%s splits into two players", (_label, raw) => {
    expect(splitMarketplacePlayerNames(raw)).toEqual({
      names: ["Mike Trout", "Shohei Ohtani"],
      unrepresentable: false,
    });
  });

  test("a mix of all three separators splits on each", () => {
    expect(splitMarketplacePlayerNames("A One, B Two / C Three | D Four").names).toEqual(
      ["A One", "B Two", "C Three", "D Four"],
    );
  });

  test("a single name comes back whole", () => {
    expect(splitMarketplacePlayerNames("Jonah Tong")).toEqual({
      names: ["Jonah Tong"],
      unrepresentable: false,
    });
  });

  test("an empty or whitespace-only value yields no names and is not flagged", () => {
    expect(splitMarketplacePlayerNames("")).toEqual({ names: [], unrepresentable: false });
    expect(splitMarketplacePlayerNames("  \t ")).toEqual({
      names: [],
      unrepresentable: false,
    });
  });
});

describe("splitMarketplaceTeamNames: comma only", () => {
  test.each([
    ["comma and space", "Cleveland Guardians, Washington Nationals"],
    ["comma, no space", "Cleveland Guardians,Washington Nationals"],
  ])("%s splits into two teams", (_label, raw) => {
    expect(splitMarketplaceTeamNames(raw)).toEqual({
      names: ["Cleveland Guardians", "Washington Nationals"],
      unrepresentable: false,
    });
  });

  test("a slash is NOT a team separator: 'Bodø/Glimt' stays whole", () => {
    expect(splitMarketplaceTeamNames("Bodø/Glimt").names).toEqual(["Bodø/Glimt"]);
  });

  test("a spaced slash and a pipe also stay whole in a team value", () => {
    expect(splitMarketplaceTeamNames("Browns / Stogies").names).toEqual(["Browns / Stogies"]);
    expect(splitMarketplaceTeamNames("Team A | Team B").names).toEqual(["Team A | Team B"]);
  });

  test("a slash inside one of several comma parts stays inside that part", () => {
    expect(splitMarketplaceTeamNames("Bodø/Glimt, Browns/Stogies").names).toEqual([
      "Bodø/Glimt",
      "Browns/Stogies",
    ]);
  });
});

describe("splitMarketplaceNames: tidying", () => {
  test("a trailing comma is dropped, not kept as an empty name", () => {
    expect(splitMarketplacePlayerNames("Mike Trout,").names).toEqual(["Mike Trout"]);
    expect(splitMarketplaceTeamNames("Chicago Cubs, ").names).toEqual(["Chicago Cubs"]);
  });

  test("a doubled or leading separator leaves no empty parts", () => {
    expect(splitMarketplacePlayerNames(", A One,, B Two").names).toEqual(["A One", "B Two"]);
  });

  test("interior whitespace runs (including a non-breaking space) collapse to one space", () => {
    expect(splitMarketplacePlayerNames("Mike   Trout, Shohei  Ohtani").names).toEqual([
      "Mike Trout",
      "Shohei Ohtani",
    ]);
  });

  test("duplicates are removed case-insensitively and the first spelling wins", () => {
    expect(splitMarketplacePlayerNames("Mike Trout, mike trout, MIKE TROUT").names).toEqual([
      "Mike Trout",
    ]);
    expect(splitMarketplaceTeamNames("Chicago Cubs, chicago cubs").names).toEqual([
      "Chicago Cubs",
    ]);
  });

  test("zero-width characters (U+200B-U+200D, U+FEFF) are stripped before trimming", () => {
    expect(splitMarketplacePlayerNames("Mike Trout\u200B, \u200CShohei Ohtani\u200D").names).toEqual([
      "Mike Trout",
      "Shohei Ohtani",
    ]);
    // A zero-width copy of a name dedupes against the plain one.
    expect(splitMarketplacePlayerNames("Mike Trout, Mike\uFEFF Trout\u200B").names).toEqual([
      "Mike Trout",
    ]);
    // A part that is nothing but zero-width characters is an empty part.
    expect(splitMarketplaceTeamNames("Cleveland Guardians,\u200B\u200D,Washington Nationals").names).toEqual([
      "Cleveland Guardians",
      "Washington Nationals",
    ]);
    expect(splitMarketplaceTeamNames("\u200B\uFEFF")).toEqual({ names: [], unrepresentable: false });
  });

  test("stripZeroWidth removes only the zero-width characters", () => {
    expect(stripZeroWidth("Bod\u200Bø/Glimt\uFEFF")).toBe("Bodø/Glimt");
    expect(stripZeroWidth("Korea, South")).toBe("Korea, South");
  });

  test("a fullwidth comma is NOT a separator (documented limit: the value stays whole)", () => {
    expect(splitMarketplaceTeamNames("Chicago Cubs，Texas Rangers").names).toEqual([
      "Chicago Cubs，Texas Rangers",
    ]);
  });
});

describe("splitMarketplaceNames: generational suffixes", () => {
  test("'Ken Griffey, Jr., Mike Trout' is two names, the suffix re-attached", () => {
    expect(splitMarketplacePlayerNames("Ken Griffey, Jr., Mike Trout").names).toEqual([
      "Ken Griffey Jr.",
      "Mike Trout",
    ]);
  });

  test("'Vladimir Guerrero Jr., George Springer' stays as is", () => {
    expect(splitMarketplacePlayerNames("Vladimir Guerrero Jr., George Springer").names).toEqual([
      "Vladimir Guerrero Jr.",
      "George Springer",
    ]);
  });

  test.each(["Jr", "jr.", "Sr.", "II", "iii", "IV."])(
    "a bare %s part is attached to the name before it",
    (suffix) => {
      expect(splitMarketplacePlayerNames(`Ken Griffey, ${suffix}`).names).toEqual([
        `Ken Griffey ${suffix}`,
      ]);
    },
  );

  test("a bare 'Jr.' with nothing before it is dropped, naming nobody", () => {
    expect(splitMarketplacePlayerNames("Jr.")).toEqual({ names: [], unrepresentable: false });
    expect(splitMarketplacePlayerNames("Jr., Mike Trout").names).toEqual(["Mike Trout"]);
  });

  test("a suffix after an empty part ('A,,Jr.') still attaches to the name before the gap (documented: the shared splitter ignores empty parts)", () => {
    expect(splitMarketplacePlayerNames("Ken Griffey,,Jr.").names).toEqual(["Ken Griffey Jr."]);
  });

  test("a doubled suffix collapses to the first: 'Ken Griffey Jr, Jr.' is 'Ken Griffey Jr'", () => {
    expect(splitMarketplacePlayerNames("Ken Griffey Jr, Jr.").names).toEqual(["Ken Griffey Jr"]);
    expect(splitMarketplacePlayerNames("Ken Griffey Jr., JR, Mike Trout").names).toEqual([
      "Ken Griffey Jr.",
      "Mike Trout",
    ]);
    // Two bare suffixes after one name: the first attaches, the second is dropped.
    expect(splitMarketplacePlayerNames("Ken Griffey, Jr., Sr.").names).toEqual(["Ken Griffey Jr."]);
    // A suffix after a DIFFERENT, suffix-free name still attaches to it.
    expect(splitMarketplacePlayerNames("Ken Griffey Jr., Cal Ripken, Jr.").names).toEqual([
      "Ken Griffey Jr.",
      "Cal Ripken Jr.",
    ]);
  });

  test("a suffix does not count toward the cap", () => {
    const names = Array.from({ length: MAX_CARD_PLAYERS }, (_, i) => `Player${i}`);
    names[1] = `${names[1]}, Jr.`;
    expect(splitMarketplacePlayerNames(names.join(", ")).names).toHaveLength(MAX_CARD_PLAYERS);
  });

  test("'V' is not treated as a suffix (a bare 'V' stays a name)", () => {
    expect(GENERATIONAL_SUFFIX_ONLY.test("V")).toBe(false);
    expect(splitMarketplacePlayerNames("Ken Griffey, V").names).toEqual(["Ken Griffey", "V"]);
  });

  test("a suffix repeated on the same base name dedupes with the plain form only when identical", () => {
    expect(splitMarketplacePlayerNames("Ken Griffey, Jr., Ken Griffey Jr.").names).toEqual([
      "Ken Griffey Jr.",
    ]);
    expect(splitMarketplacePlayerNames("Ken Griffey, Ken Griffey Jr.").names).toEqual([
      "Ken Griffey",
      "Ken Griffey Jr.",
    ]);
  });
});

describe("splitMarketplaceNames: the cap", () => {
  test("a team list over MAX_CARD_TEAMS is refused whole, never trimmed", () => {
    const raw = Array.from({ length: MAX_CARD_TEAMS + 1 }, (_, i) => `Team ${i}`).join(", ");
    expect(splitMarketplaceTeamNames(raw)).toEqual({ names: [], unrepresentable: true });
  });

  test("a team list exactly at MAX_CARD_TEAMS is kept", () => {
    const raw = Array.from({ length: MAX_CARD_TEAMS }, (_, i) => `Team ${i}`).join(", ");
    const out = splitMarketplaceTeamNames(raw);
    expect(out.names).toHaveLength(MAX_CARD_TEAMS);
    expect(out.unrepresentable).toBe(false);
  });

  test("a player list over MAX_CARD_PLAYERS is refused whole", () => {
    const raw = Array.from({ length: MAX_CARD_PLAYERS + 1 }, (_, i) => `Player ${i}`).join(" / ");
    expect(splitMarketplacePlayerNames(raw)).toEqual({ names: [], unrepresentable: true });
  });

  test("repeats do not push a list over the cap (dedupe runs first)", () => {
    const raw = Array.from({ length: MAX_CARD_TEAMS + 5 }, () => "Chicago Cubs").join(", ");
    expect(splitMarketplaceTeamNames(raw).names).toEqual(["Chicago Cubs"]);
  });

  test("an over-length name is dropped and flagged; its neighbours survive", () => {
    const long = "X".repeat(MAX_PLAYER_NAME_LENGTH + 1);
    expect(splitMarketplacePlayerNames(`Mike Trout, ${long}`)).toEqual({
      names: ["Mike Trout"],
      unrepresentable: true,
    });
  });

  test("boundParsedNames keeps a name at exactly the length limit", () => {
    const atLimit = "X".repeat(MAX_PLAYER_NAME_LENGTH);
    expect(boundParsedNames([atLimit], 3)).toEqual({ names: [atLimit], unrepresentable: false });
  });
});
