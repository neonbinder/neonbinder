/**
 * NEO-343 — the checklist search matcher. Each field, the AND-across-terms /
 * OR-across-fields rule, the "#" prefix, case and accent folding, the platform
 * aliases, and the no-match case.
 *
 * The component half (typing filters the rows, the count, the empty state, and
 * that every badge the REAL row renders is findable) is in
 * components/SetSelector/CardChecklist.search.test.tsx.
 */

import { describe, expect, test } from "vitest";
import {
  cardMatchesSearch,
  cardSearchFields,
  cardSearchHaystack,
  haystackMatches,
  parseCardSearchTerms,
  type CardSearchLookups,
  type SearchableCard,
} from "./card-search";

function card(overrides: Partial<SearchableCard> = {}): SearchableCard {
  return {
    cardNumber: "6a",
    cardName: "Bryce Harper",
    platformData: {},
    ...overrides,
  };
}

const lookups: CardSearchLookups = {
  teamNames: new Map([
    ["team-ne", "New England Patriots"],
    ["team-sd", "San Diego Padres"],
  ]),
  playerNames: new Map([
    ["player-jr", "José Ramírez"],
    ["player-tb", "Tom Brady"],
  ]),
};

describe("parseCardSearchTerms", () => {
  test("splits on any whitespace and folds case", () => {
    expect(parseCardSearchTerms("  Tom\tBRADY \n rc ")).toEqual([
      "tom",
      "brady",
      "rc",
    ]);
  });

  test("drops a leading '#' (one or more) from each term", () => {
    expect(parseCardSearchTerms("#6a ##12 a#b")).toEqual(["6a", "12", "a#b"]);
  });

  test("folds accents", () => {
    expect(parseCardSearchTerms("Ramírez")).toEqual(["ramirez"]);
  });

  test("a blank query or bare '#' has no terms", () => {
    expect(parseCardSearchTerms("")).toEqual([]);
    expect(parseCardSearchTerms("   ")).toEqual([]);
    expect(parseCardSearchTerms("# ##")).toEqual([]);
  });
});

describe("numbers", () => {
  test("'6a' and '#6a' both find card 6a", () => {
    expect(cardMatchesSearch(card(), "6a")).toBe(true);
    expect(cardMatchesSearch(card(), "#6a")).toBe(true);
    expect(cardMatchesSearch(card(), "#6A")).toBe(true);
  });

  test("PREFIX, not substring: '6' finds 6, 6a and 60-69, never 16", () => {
    const finds = (cardNumber: string, query: string) =>
      cardMatchesSearch(card({ cardNumber, cardName: "Nobody" }), query);
    for (const n of ["6", "6a", "60", "69", "6B"]) expect(finds(n, "6")).toBe(true);
    for (const n of ["16", "26", "106", "7"]) expect(finds(n, "6")).toBe(false);
    expect(finds("6a", "6a")).toBe(true);
    expect(finds("16a", "6a")).toBe(false);
    expect(finds("26a", "#6a")).toBe(false);
  });

  test("a prefixed number: 'bcp' finds BCP-120, '120' alone does not", () => {
    expect(cardMatchesSearch(card({ cardNumber: "BCP-120" }), "bcp")).toBe(true);
    expect(cardMatchesSearch(card({ cardNumber: "BCP-120" }), "bcp-12")).toBe(true);
    expect(cardMatchesSearch(card({ cardNumber: "BCP-120" }), "120")).toBe(false);
  });

  test("a different number does not", () => {
    expect(cardMatchesSearch(card(), "7b")).toBe(false);
  });
});

describe("names", () => {
  test("the card name", () => {
    expect(cardMatchesSearch(card(), "harper")).toBe(true);
  });

  test("a linked player's name, from the lookup", () => {
    const c = card({ cardName: "League Leaders", playerIds: ["player-tb"] });
    expect(cardMatchesSearch(c, "brady", lookups)).toBe(true);
    // Without the lookup the id alone is nothing to match.
    expect(cardMatchesSearch(c, "brady")).toBe(false);
  });

  test("the name the card printed for a player", () => {
    const c = card({
      cardName: "Checklist",
      playerLinks: [{ playerId: "player-x", nameOnCard: "Doc Gooden" }],
    });
    expect(cardMatchesSearch(c, "gooden")).toBe(true);
  });

  test("a typed player name that links to nobody yet", () => {
    const c = card({ cardName: "Checklist", pendingPlayerNames: ["Somebody New"] });
    expect(cardMatchesSearch(c, "somebody")).toBe(true);
  });

  test("accents fold in both directions", () => {
    const c = card({ cardName: "Leaders", playerIds: ["player-jr"] });
    expect(cardMatchesSearch(c, "jose ramirez", lookups)).toBe(true);
    expect(cardMatchesSearch(card({ cardName: "Jose Ramirez" }), "José")).toBe(
      true,
    );
  });
});

describe("teams", () => {
  const teamed = card({ cardName: "Rob Gronkowski", teamOnCardIds: ["team-ne"] });

  test("the full name, and each part on its own", () => {
    expect(cardMatchesSearch(teamed, "New England Patriots", lookups)).toBe(true);
    expect(cardMatchesSearch(teamed, "patriots", lookups)).toBe(true);
    expect(cardMatchesSearch(teamed, "new england", lookups)).toBe(true);
  });

  test("an operator-typed team the row shows as unconfirmed", () => {
    const c = card({ pendingTeamNames: ["Wisconsin Badgers"] });
    expect(cardMatchesSearch(c, "badgers")).toBe(true);
  });

  test("a team the card is not on does not match", () => {
    expect(cardMatchesSearch(teamed, "padres", lookups)).toBe(false);
  });

  test("the marketplace's team hint is never read", () => {
    const c = { ...card(), bscTeamName: "Seattle Seahawks" } as SearchableCard;
    expect(cardMatchesSearch(c, "seahawks")).toBe(false);
  });
});

describe("features", () => {
  test("RC finds by badge text and by 'rookie'; the flag alone counts too", () => {
    expect(cardMatchesSearch(card({ attributes: ["RC"] }), "rc")).toBe(true);
    expect(cardMatchesSearch(card({ attributes: ["RC"] }), "rookie")).toBe(true);
    expect(cardMatchesSearch(card({ isRookie: true }), "rookie")).toBe(true);
  });

  test("autograph: the AU badge and the row's '<type> auto' line", () => {
    expect(cardMatchesSearch(card({ attributes: ["AU"] }), "auto")).toBe(true);
    const onCard = card({ features: { autographed: "On-Card" } });
    expect(cardMatchesSearch(onCard, "on-card auto")).toBe(true);
    expect(cardMatchesSearch(onCard, "autograph")).toBe(true);
  });

  test("'None' is a stored not-an-autograph and finds nothing", () => {
    expect(
      cardMatchesSearch(card({ features: { autographed: "None" } }), "auto"),
    ).toBe(false);
  });

  test("relic, short prints and the numbered badge", () => {
    expect(cardMatchesSearch(card({ isRelic: true }), "relic")).toBe(true);
    expect(cardMatchesSearch(card({ attributes: ["SP"] }), "short print")).toBe(
      true,
    );
    expect(cardMatchesSearch(card({ attributes: ["SSP"] }), "ssp")).toBe(true);
    expect(cardMatchesSearch(card({ attributes: ["NUM"] }), "#'d")).toBe(true);
    expect(cardMatchesSearch(card({ attributes: ["NUM"] }), "numbered")).toBe(
      true,
    );
  });

  test("print run as the row prints it, and the variation text", () => {
    expect(cardMatchesSearch(card({ printRun: 99 }), "/99")).toBe(true);
    expect(
      cardMatchesSearch(card({ cardVariation: "Gold Refractor" }), "refractor"),
    ).toBe(true);
  });

  test("an unknown badge token is findable as itself", () => {
    expect(cardMatchesSearch(card({ attributes: ["VAR"] }), "var")).toBe(true);
  });

  test("a cross-release card's home set", () => {
    const guest = card({
      isCrossListed: true,
      homeSetLabel: "2021 Topps Update",
    });
    expect(cardMatchesSearch(guest, "topps update")).toBe(true);
    expect(cardMatchesSearch(guest, "cross-release")).toBe(true);
  });
});

describe("platform", () => {
  const bsc = card({ platformData: { bsc: { ref: "b1" } } });
  const sl = card({ platformData: { sportlots: { ref: "s1" } } });
  const both = card({
    platformData: { bsc: { ref: "b1" }, sportlots: { ref: "s1" } },
  });
  const neither = card();

  test.each(["BSC", "bsc", "BuySportsCards", "buy sports cards"])(
    "'%s' finds a BSC-linked card only",
    (query) => {
      expect(cardMatchesSearch(bsc, query)).toBe(true);
      expect(cardMatchesSearch(sl, query)).toBe(false);
      expect(cardMatchesSearch(neither, query)).toBe(false);
    },
  );

  test.each(["SL", "sl", "SportLots", "sportlots"])(
    "'%s' finds a SportLots-linked card only",
    (query) => {
      expect(cardMatchesSearch(sl, query)).toBe(true);
      expect(cardMatchesSearch(bsc, query)).toBe(false);
      expect(cardMatchesSearch(neither, query)).toBe(false);
    },
  );

  test("'bsc sl' finds only a card linked on both sides", () => {
    expect(cardMatchesSearch(both, "bsc sl")).toBe(true);
    expect(cardMatchesSearch(bsc, "bsc sl")).toBe(false);
  });

  test("the fields list names the platforms as the row's badges do", () => {
    expect(cardSearchFields(both).platforms).toEqual([
      "BSC",
      "BuySportsCards",
      "SL",
      "SportLots",
    ]);
  });
});

describe("terms combine: AND across terms, OR across fields", () => {
  const c = card({
    cardNumber: "6a",
    cardName: "Rob Gronkowski",
    teamOnCardIds: ["team-ne"],
    attributes: ["RC"],
    platformData: { bsc: { ref: "b1" } },
  });

  test("every term may come from a different field", () => {
    expect(cardMatchesSearch(c, "#6a gronk patriots rc bsc", lookups)).toBe(true);
  });

  test("one term that matches nothing fails the card", () => {
    expect(cardMatchesSearch(c, "gronk padres", lookups)).toBe(false);
    expect(cardMatchesSearch(c, "gronk sl", lookups)).toBe(false);
  });

  test("a term never matches across the seam between two fields", () => {
    // Name "Rob Gronkowski" then team "New England…": joined without a
    // separator "gronkowskinew" would match. It must not; nor may the number
    // run into the name.
    expect(cardMatchesSearch(c, "gronkowskinew", lookups)).toBe(false);
    expect(cardMatchesSearch(c, "6arob", lookups)).toBe(false);
  });

  test("digits elsewhere on the card still match as a substring", () => {
    // The number is prefix-only; a print run is an ordinary field.
    const numbered = card({ cardNumber: "12", printRun: 166 });
    expect(cardMatchesSearch(numbered, "/16")).toBe(true);
  });

  test("no terms matches every card", () => {
    expect(cardMatchesSearch(c, "")).toBe(true);
    expect(haystackMatches(cardSearchHaystack(c), [])).toBe(true);
  });
});

describe("no match", () => {
  test("nothing on the card answers the query", () => {
    expect(cardMatchesSearch(card(), "zzz-not-here")).toBe(false);
  });
});
