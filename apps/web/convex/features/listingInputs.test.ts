/**
 * NEO-335 — the title inputs shared by the insert and the wizard's pre-save
 * "Card titles" step.
 *
 * The parity block is the point of the module: the SAME card, assessed the way
 * the step assesses it before save and then born through
 * `buildCardRowForInsert` and read back through `deriveCardAttention`, must
 * come to the same title and the same title kinds. If the two ever drift, the
 * step asks about cards the walker will not flag (or the reverse).
 */

import { describe, expect, test } from "vitest";
import type { Id } from "../_generated/dataModel";
import { buildCardRowForInsert, type NewCardRow } from "../cardRowCreate";
import { deriveCardAttention } from "./cardAttention";
import {
  assessNewCardListing,
  checkShortNameAnswer,
  checkTitleAnswer,
  isFillerToken,
  leftOutOfTitle,
  listingInputsForCard,
  mergeCardFeatures,
  suggestShortSetName,
  titleAttentionItems,
  type ListingCardFacts,
  type ListingSetContext,
} from "./listingInputs";
import { assessListingTitle } from "./generateListing";
import { ASPECT_VALUE_MAX, LISTING_TITLE_MAX } from "./listingLimits";

const SELECTOR_ID = "selector-1" as unknown as Id<"selectorOptions">;
const NOW = 1_700_000_000_000;

const SET: ListingSetContext = {
  sportValue: "Baseball",
  setNameValue: "Chrome",
  inheritedFeatures: { manufacturer: "Topps", season: "2026" },
};

/** A set name long enough that the core cannot fit with a player and a number. */
const LONG_SET: ListingSetContext = {
  ...SET,
  setNameValue:
    "Chrome Update Series Sapphire Edition Platinum Anniversary Collectors Box",
};

const LONG_VARIATION =
  "Image Variation; Wearing a throwback uniform with the 1970s powder blue logo";

type Case = {
  name: string;
  set: ListingSetContext;
  card: ListingCardFacts;
  playerNames: string[];
  teamNames: string[];
};

const CASES: Case[] = [
  {
    name: "a plain card that fits",
    set: SET,
    card: { cardNumber: "12", isRookie: true },
    playerNames: ["Mike Trout"],
    teamNames: ["Los Angeles Angels"],
  },
  {
    name: "a core cut short by a long set name",
    set: LONG_SET,
    card: { cardNumber: "300", isRookie: true },
    playerNames: ["Shohei Ohtani"],
    teamNames: ["Los Angeles Dodgers"],
  },
  {
    name: "a variation over the aspect cap",
    set: SET,
    card: { cardNumber: "300b", cardVariation: LONG_VARIATION },
    playerNames: ["Aaron Judge"],
    teamNames: ["New York Yankees"],
  },
  {
    name: "both at once, with an autograph and a print run",
    set: LONG_SET,
    card: {
      cardNumber: "RA-1",
      autographType: "On-Card",
      printRun: 99,
      cardVariation: LONG_VARIATION,
      attributes: ["SP"],
    },
    playerNames: ["Ken Griffey Jr.", "Ken Griffey Sr."],
    teamNames: ["Seattle Mariners", "Cincinnati Reds"],
  },
  {
    name: "a variation that fits once its stray space is trimmed",
    set: SET,
    card: { cardNumber: "44b", cardVariation: `${"v".repeat(ASPECT_VALUE_MAX)} ` },
    playerNames: ["Paul Skenes"],
    teamNames: [],
  },
  {
    name: "a brand NB has not identified",
    set: { ...LONG_SET, manufacturerBrandUnknown: true },
    card: { cardNumber: "7" },
    playerNames: ["Bobby Witt Jr."],
    teamNames: [],
  },
  {
    // NEO-335 — both labels, from the chain's ROLES.
    name: "a parallel of an insert, labelled",
    set: {
      ...SET,
      insertNameValue: "Dugout Collection",
      insertIsRole: true,
      parallelLeafValue: "Gold",
    },
    card: { cardNumber: "DC-5" },
    playerNames: ["Ken Griffey Jr."],
    teamNames: ["Seattle Mariners"],
  },
  {
    // NEO-335 — "Rookie" → "RC" in the insert's name, because it is needed.
    name: "a rookie insert that only fits as RC",
    set: { ...SET, insertNameValue: "Rookie Debut Patch Autographs", insertIsRole: true },
    card: { cardNumber: "RD-12", isRookie: true, isRelic: true, autographType: "On-Card", printRun: 99 },
    playerNames: ["Elly De La Cruz"],
    teamNames: [],
  },
];

function newCardRow(c: Case): NewCardRow {
  return {
    selectorOptionId: SELECTOR_ID,
    cardNumber: c.card.cardNumber,
    cardName: c.playerNames.join(" & "),
    isRookie: c.card.isRookie,
    isRelic: c.card.isRelic,
    autographType: c.card.autographType,
    cardVariation: c.card.cardVariation,
    attributes: c.card.attributes ? [...c.card.attributes] : undefined,
    printRun: c.card.printRun,
    platformData: {},
    pendingPlayerNames: [],
    pendingTeamNames: [],
    sortOrder: 0,
    playerNames: c.playerNames,
    teamNames: c.teamNames,
  };
}

const TITLE_KINDS = new Set(["titleOverLimit", "titleTruncated", "aspectValueOverLimit"]);

describe("listingInputs — the pre-save step and the insert agree (parity)", () => {
  test.each(CASES)("$name: same title, same title kinds", (c) => {
    const before = assessNewCardListing(c.card, c.set, {
      playerNames: c.playerNames,
      teamNames: c.teamNames,
    });
    const built = buildCardRowForInsert(newCardRow(c), c.set, NOW);
    const after = deriveCardAttention(built.row).filter((i) => TITLE_KINDS.has(i.kind));

    expect(built.row.listingTitle).toBe(before.assessment.title);
    expect(after).toEqual(before.items);
    // Signed By is defaulted on top at insert; it is not a title input.
    expect(built.row.features).toMatchObject(before.mergedFeatures);
  });

  test("the cases cover every kind the step asks about", () => {
    const kinds = new Set(
      CASES.flatMap((c) =>
        assessNewCardListing(c.card, c.set, { playerNames: c.playerNames, teamNames: c.teamNames })
          .items.map((i) => i.kind),
      ),
    );
    expect(kinds).toEqual(new Set(["titleTruncated", "aspectValueOverLimit"]));
  });
});

describe("the stored variation is the trimmed one (NEO-335 adversarial pass)", () => {
  test("a padded variation is stored trimmed, and neither side flags it", () => {
    const padded = CASES.find((c) => c.card.cardNumber === "44b")!;
    const built = buildCardRowForInsert(newCardRow(padded), padded.set, NOW);
    expect(built.row.cardVariation).toBe("v".repeat(ASPECT_VALUE_MAX));
    expect(
      assessNewCardListing(padded.card, padded.set, { playerNames: padded.playerNames }).items,
    ).toEqual([]);
  });

  test("a blank variation is stored as none", () => {
    const c = { ...CASES[0], card: { ...CASES[0].card, cardVariation: "   " } };
    expect(buildCardRowForInsert(newCardRow(c), c.set, NOW).row.cardVariation).toBeUndefined();
  });
});

describe("titleAttentionItems — the rules deriveCardAttention had, unchanged", () => {
  test("over the cap wins over truncated: one thing to say", () => {
    expect(
      titleAttentionItems({ listingTitle: "x".repeat(LISTING_TITLE_MAX + 4), listingTitleTruncated: true }),
    ).toEqual([{ kind: "titleOverLimit", length: LISTING_TITLE_MAX + 4 }]);
  });

  test("truncated alone", () => {
    expect(titleAttentionItems({ listingTitle: "short", listingTitleTruncated: true })).toEqual([
      { kind: "titleTruncated" },
    ]);
  });

  test("a variation one past the aspect cap is flagged; at the cap it is not", () => {
    expect(titleAttentionItems({ cardVariation: "v".repeat(ASPECT_VALUE_MAX) })).toEqual([]);
    expect(titleAttentionItems({ cardVariation: "v".repeat(ASPECT_VALUE_MAX + 1) })).toEqual([
      { kind: "aspectValueOverLimit", field: "cardVariation", length: ASPECT_VALUE_MAX + 1 },
    ]);
  });

  test("deriveCardAttention keeps the same order: title kinds before unreviewedName", () => {
    expect(
      deriveCardAttention({
        teamOnCardIds: ["t1"],
        listingTitleTruncated: true,
        cardVariation: "v".repeat(ASPECT_VALUE_MAX + 1),
        pendingPlayerNames: ["Somebody"],
      }).map((i) => i.kind),
    ).toEqual(["titleTruncated", "aspectValueOverLimit", "unreviewedName"]);
  });
});

describe("mergeCardFeatures / listingInputsForCard", () => {
  test("observed facts beat the set snapshot; a variation becomes the parallel name", () => {
    const merged = mergeCardFeatures(
      { cardNumber: "1", isRookie: true, cardVariation: "Sliding" },
      { ...SET, inheritedFeatures: { ...SET.inheritedFeatures, isRookie: "false" } },
    );
    expect(merged).toMatchObject({ isRookie: "true", parallelName: "Sliding", season: "2026" });
  });

  test("the inputs read the merged snapshot and the set's facts", () => {
    const inputs = listingInputsForCard({ cardNumber: "1" }, SET, {
      playerNames: ["A"],
      teamNames: ["B"],
    });
    expect(inputs).toMatchObject({
      cardNumber: "1",
      year: "2026",
      manufacturer: "Topps",
      setName: "Chrome",
      sport: "Baseball",
      playerNames: ["A"],
      teamNames: ["B"],
    });
  });
});

describe("leftOutOfTitle", () => {
  test("a core cut reports the identity words it lost, then the dropped tokens", () => {
    const inputs = listingInputsForCard({ cardNumber: "300", isRookie: true }, LONG_SET, {
      playerNames: ["Shohei Ohtani"],
      teamNames: ["Los Angeles Dodgers"],
    });
    const assessment = assessListingTitle(inputs);
    expect(assessment.coreFits).toBe(false);
    // NEO-339: the set's last words are cut, never the player.
    expect(assessment.title).toContain("Shohei Ohtani #300");
    const left = leftOutOfTitle(inputs, assessment);
    expect(left).toEqual(["Anniversary Collectors Box", "Los Angeles Dodgers"]);
    // The sport and the second rookie spelling are FILLER: dropped, never
    // listed as a loss.
    expect(assessment.dropped).toEqual(expect.arrayContaining(["Rookie", "Baseball"]));
    expect(left).not.toContain("Baseball");
    expect(left).not.toContain("Rookie");
    for (const entry of left) {
      expect(assessment.title.toLowerCase()).not.toContain(entry.toLowerCase());
    }
  });

  test("a title that fits whole reports nothing", () => {
    const inputs = listingInputsForCard({ cardNumber: "1" }, SET, { playerNames: ["A B"] });
    expect(leftOutOfTitle(inputs, assessListingTitle(inputs))).toEqual([]);
  });

  test("an unknown brand is never reported as left out — it was never in", () => {
    const set = { ...LONG_SET, manufacturerBrandUnknown: true };
    const inputs = listingInputsForCard({ cardNumber: "7" }, set, { playerNames: ["Bobby Witt Jr."] });
    expect(leftOutOfTitle(inputs, assessListingTitle(inputs))).not.toContain("Topps");
  });
});

describe("checkTitleAnswer — the write path's caps", () => {
  test("a title at the cap is accepted, trimmed", () => {
    const title = "t".repeat(LISTING_TITLE_MAX);
    expect(checkTitleAnswer({ listingTitle: `  ${title}  ` }, "card #1")).toEqual({
      listingTitle: title,
    });
  });

  test("a title one past the cap is refused, naming the card", () => {
    expect(() =>
      checkTitleAnswer({ listingTitle: "t".repeat(LISTING_TITLE_MAX + 1) }, "card #1"),
    ).toThrow(/card #1: the title is 81 characters; the limit is 80/);
  });

  test("a kept title is held to the same cap", () => {
    expect(() =>
      checkTitleAnswer({ listingTitleKept: "t".repeat(LISTING_TITLE_MAX + 1) }, "card #3"),
    ).toThrow(/card #3: the title is 81 characters; the limit is 80/);
    expect(checkTitleAnswer({ listingTitleKept: " Shown #3 " }, "card #3")).toEqual({
      listingTitleKept: "Shown #3",
    });
  });

  test("a blank title is no answer", () => {
    expect(checkTitleAnswer({ listingTitle: "   " }, "card #1")).toEqual({});
  });

  test("an answered variation is held to the aspect cap; an unanswered one is not", () => {
    const long = "v".repeat(ASPECT_VALUE_MAX + 1);
    expect(() =>
      checkTitleAnswer({ cardVariation: long, cardVariationAnswered: true }, "card #2"),
    ).toThrow(/card #2: the variation is 66 characters; the limit is 65/);
    expect(checkTitleAnswer({ cardVariation: long }, "card #2")).toEqual({});
    expect(
      checkTitleAnswer({ cardVariation: " Sliding ", cardVariationAnswered: true }, "card #2"),
    ).toEqual({ cardVariation: "Sliding" });
  });
});

describe("buildCardRowForInsert — the operator's pre-save answer", () => {
  const truncatedCase = CASES[1];

  test("no answer: the generated title, flagged cut short, exactly as before", () => {
    const built = buildCardRowForInsert(newCardRow(truncatedCase), truncatedCase.set, NOW);
    expect(built.row.listingTitleTruncated).toBe(true);
  });

  test("kept: the generated title, NOT flagged — the question was asked before save", () => {
    const plain = buildCardRowForInsert(newCardRow(truncatedCase), truncatedCase.set, NOW);
    const kept = buildCardRowForInsert(
      { ...newCardRow(truncatedCase), listingTitleKept: plain.row.listingTitle },
      truncatedCase.set,
      NOW,
    );
    expect(kept.row.listingTitle).toBe(plain.row.listingTitle);
    expect(kept.row).not.toHaveProperty("listingTitleTruncated");
  });

  test("kept, but the server generated a different title: flagged as before", () => {
    const kept = buildCardRowForInsert(
      { ...newCardRow(truncatedCase), listingTitleKept: "A title nobody generated #300" },
      truncatedCase.set,
      NOW,
    );
    expect(kept.row.listingTitle).not.toBe("A title nobody generated #300");
    expect(kept.row.listingTitleTruncated).toBe(true);
  });

  test("their own title: written verbatim, NOT flagged; the description is still generated", () => {
    const own = buildCardRowForInsert(
      { ...newCardRow(truncatedCase), listingTitle: "2026 Topps Chrome Update Shohei Ohtani #300 RC" },
      truncatedCase.set,
      NOW,
    );
    expect(own.row.listingTitle).toBe("2026 Topps Chrome Update Shohei Ohtani #300 RC");
    expect(own.row).not.toHaveProperty("listingTitleTruncated");
    expect(own.row.listingDescription).toContain("Shohei Ohtani");
  });
});

describe("a generational suffix is never trimmed off a name (NEO-335 visual pass)", () => {
  /**
   * Every players budget from "the core fits" down to "only a first name
   * fits", so the cut is tried at EVERY boundary inside the names, including
   * the one right before the suffix. The players are the last thing a title
   * gives up (Jason, 2026-10-19: the set words, the number and the year all
   * go first), so a name is only cut when the players ALONE exceed the cap:
   * the budget is squeezed with an unbroken leading name of growing length.
   */
  function sweep(playerNames: string[]) {
    const out: Array<{ title: string; coreFits: boolean; left: string[]; players: string }> = [];
    for (let pad = 0; pad < 79; pad += 1) {
      const inputs = listingInputsForCard(
        { cardNumber: "19" },
        {
          sportValue: "Baseball",
          setNameValue: "Upper Deck",
          inheritedFeatures: { season: "1989" },
        },
        { playerNames: pad === 0 ? playerNames : ["Q".repeat(pad), ...playerNames] },
      );
      const a = assessListingTitle(inputs);
      out.push({
        title: a.title,
        coreFits: a.coreFits,
        left: leftOutOfTitle(inputs, a),
        players: (inputs.playerNames ?? []).join(" & "),
      });
    }
    return out;
  }

  test("Jr. and Sr. on one card: each name is kept whole or dropped whole", () => {
    const results = sweep(["Ken Griffey Jr.", "Ken Griffey Sr."]);
    for (const { title, coreFits, left } of results) {
      // "Griffey" never ends up without its suffix right after it…
      expect(title).not.toMatch(/Griffey(?! (Jr|Sr)\.)/);
      // …a bare suffix is never reported as what was left out…
      expect(left).not.toContain("Jr.");
      expect(left).not.toContain("Sr.");
      // …and a title that lost a name is still flagged.
      if (left.some((l) => l.startsWith("Ken Griffey"))) expect(coreFits).toBe(false);
    }
    // The sweep did reach the case that used to split them.
    expect(results.some((r) => r.left.includes("Ken Griffey Sr."))).toBe(true);
    expect(results.some((r) => r.left.includes("Ken Griffey Jr."))).toBe(true);
  });

  test("NEO-339: a player word is lost only when the players alone exceed the cap", () => {
    // Jason, 2026-10-19: the set words, the year and the number all go before
    // any player word. (The few characters a whole-word cut leaves are still
    // spent: a year or a short set word may fill them.)
    for (const names of [["Ken Griffey Jr.", "Ken Griffey Sr."], ["Shohei Ohtani"]]) {
      for (const { left, players } of sweep(names)) {
        if (left.some((l) => names.includes(l))) {
          expect(players.length).toBeGreaterThan(LISTING_TITLE_MAX);
        }
      }
    }
  });

  test("a single Jr. stays attached", () => {
    for (const { title } of sweep(["Bobby Witt Jr."])) {
      expect(title).not.toMatch(/Witt(?! Jr\.)/);
    }
  });

  test("a suffix without a period (Jr, III) stays attached too", () => {
    for (const { title } of sweep(["Ken Griffey Jr"])) {
      expect(title).not.toMatch(/Griffey(?! Jr\b)/);
    }
    for (const { title } of sweep(["Cal Ripken III"])) {
      expect(title).not.toMatch(/Ripken(?! III\b)/);
    }
  });

  test("a name with no suffix is cut exactly as before (a partial name is still possible)", () => {
    const results = sweep(["Shohei Ohtani"]);
    expect(results.some((r) => / & Shohei$/.test(r.title))).toBe(true);
    // …and is reported whole.
    expect(
      results.filter((r) => / & Shohei$/.test(r.title)).every((r) => r.left.includes("Shohei Ohtani")),
    ).toBe(true);
  });
});

describe("filler is never listed as a loss (collector review)", () => {
  test("a set or player word that reads like the sport is still reported; the sport TOKEN is not", () => {
    // NEO-339: the core gives up set words before the player, so the set's
    // last two words go and the player stays; the 9-character " Baseball"
    // sport token then does not fit either. (A 60-character first word, so
    // the set's "Baseball" does not fit even once " #1" is weighed: the
    // number is kept after the set words, Jason 2026-10-19.)
    const inputs = listingInputsForCard(
      { cardNumber: "1" },
      { sportValue: "Baseball", setNameValue: `${"x".repeat(60)} Baseball Heroes` },
      { playerNames: ["Shohei Ohtani"] },
    );
    const a = assessListingTitle(inputs);
    expect(a.coreFits).toBe(false);
    expect(a.title).toBe(`${"x".repeat(60)} Shohei Ohtani #1`);
    expect(a.dropped).toContain("Baseball");
    const left = leftOutOfTitle(inputs, a);
    // "Baseball" here is a SET word the core cut lost, so it is a real loss;
    // the sport token dropped beside it is filler and not listed again.
    expect(left).toEqual(["Baseball Heroes"]);
  });

  test("isFillerToken: the sport, and Rookie only beside RC", () => {
    const base = { cardNumber: "1", sport: "Baseball" };
    expect(isFillerToken("Baseball", base)).toBe(true);
    expect(isFillerToken("Rookie", { ...base, isRookie: true })).toBe(true);
    expect(isFillerToken("Rookie", base)).toBe(false);
    expect(isFillerToken("RC", { ...base, isRookie: true })).toBe(false);
    expect(isFillerToken("Los Angeles Dodgers", base)).toBe(false);
  });

  test("isFillerToken: the Insert / Parallel labels, only on their roles", () => {
    const base = { cardNumber: "1", sport: "Baseball" };
    expect(isFillerToken("Insert", { ...base, insertName: "Dugout Collection" })).toBe(true);
    expect(isFillerToken("Insert", base)).toBe(false);
    expect(isFillerToken("Parallel", { ...base, parallelIsRole: true })).toBe(true);
    expect(isFillerToken("Parallel", base)).toBe(false);
  });

  test("the dropped labels are never listed as left out (NEO-335)", () => {
    const inputs = listingInputsForCard(
      { cardNumber: "5" },
      {
        ...SET,
        insertNameValue: "Dugout Collection",
        insertIsRole: true,
        parallelLeafValue: "Gold",
      },
      { playerNames: ["Ken Griffey Jr."], teamNames: ["Seattle Mariners"] },
    );
    const a = assessListingTitle(inputs);
    expect(a.title).toBe("2026 Topps Chrome Dugout Collection Ken Griffey Jr. #5 Gold Seattle Mariners");
    expect(a.dropped).toEqual(["Baseball", "Parallel", "Insert"]);
    expect(leftOutOfTitle(inputs, a)).toEqual([]);
  });

  test("a core cut on an RC-shortened insert does not report \"Rookie\" as lost", () => {
    const inputs = listingInputsForCard(
      { cardNumber: "RD-12", isRookie: true },
      {
        ...SET,
        insertNameValue: "Rookie Debut Patch Autographs Sapphire Platinum Anniversary Edition",
        insertIsRole: true,
      },
      { playerNames: ["Elly De La Cruz"] },
    );
    const a = assessListingTitle(inputs);
    expect(a.coreFits).toBe(false);
    expect(a.rookieAsRcUsed).toBe(true);
    const left = leftOutOfTitle(inputs, a);
    expect(left.some((entry) => /\bRookie\b/.test(entry))).toBe(false);
    // Jason, 2026-10-19: the insert's name and the player are never cut, so
    // the year, set words and number are what the core lost.
    expect(a.title).toBe(
      "RC Debut Patch Autographs Sapphire Platinum Anniversary Edition Elly De La Cruz",
    );
    expect(left).toEqual(["2026", "Topps", "Chrome", "#RD-12"]);
  });
});

describe("NEO-335 — the insert name, the parallel leaf and the short name reach the inputs", () => {
  test("the insert name joins only on the insert ROLE", () => {
    const withRole = listingInputsForCard(
      { cardNumber: "5" },
      { ...SET, insertNameValue: "Dugout Collection", insertIsRole: true },
      { playerNames: ["Ken Griffey Jr."] },
    );
    expect(withRole.insertName).toBe("Dugout Collection");
    expect(assessListingTitle(withRole).title).toBe(
      "2026 Topps Chrome Dugout Collection Insert Ken Griffey Jr. #5 Baseball",
    );
    // An insert-level row without the role (a parallels-type child) is not an insert.
    for (const insertIsRole of [undefined, false]) {
      const inputs = listingInputsForCard(
        { cardNumber: "5" },
        { ...SET, insertNameValue: "Dugout Collection", insertIsRole },
        { playerNames: ["Ken Griffey Jr."] },
      );
      expect(inputs).not.toHaveProperty("insertName");
    }
  });

  test("no role, no labels: a set with neither inputs exactly what it did", () => {
    const inputs = listingInputsForCard(
      { cardNumber: "5", cardVariation: "Image Variation" },
      SET,
      { playerNames: ["Ken Griffey Jr."] },
    );
    expect(inputs).not.toHaveProperty("parallelIsRole");
    expect(inputs).not.toHaveProperty("insertName");
    expect(assessListingTitle(inputs).title).toBe(
      "2026 Topps Chrome Ken Griffey Jr. #5 Image Variation Baseball",
    );
  });

  test("a parallel leaf's own value is the parallel token when the features name none", () => {
    const inputs = listingInputsForCard(
      { cardNumber: "5" },
      { ...SET, parallelLeafValue: "Gold Refractor" },
      { playerNames: ["A"] },
    );
    expect(inputs.parallelName).toBe("Gold Refractor");
    expect(inputs.parallelIsRole).toBe(true);
    expect(assessListingTitle(inputs).title).toBe(
      "2026 Topps Chrome A #5 Gold Refractor Parallel Baseball",
    );
  });

  test("a parallel the features already name wins over the leaf's value", () => {
    const inputs = listingInputsForCard(
      { cardNumber: "5" },
      {
        ...SET,
        inheritedFeatures: { ...SET.inheritedFeatures, parallelName: "Refractor" },
        parallelLeafValue: "Gold Refractor",
      },
      { playerNames: ["A"] },
    );
    expect(inputs.parallelName).toBe("Refractor");
  });

  test("the short name rides through trimmed; blank is none", () => {
    const set = { ...SET, listingShortName: "  Topps Hologram  " };
    expect(listingInputsForCard({ cardNumber: "1" }, set, { playerNames: [] }).setShortName).toBe(
      "Topps Hologram",
    );
    expect(
      listingInputsForCard({ cardNumber: "1" }, { ...SET, listingShortName: " " }, { playerNames: [] }),
    ).not.toHaveProperty("setShortName");
  });
});

describe("NEO-335 — leftOutOfTitle reports the set and insert words", () => {
  const LONG_INSERT: ListingSetContext = {
    ...SET,
    setNameValue: "Chrome Update Series",
    insertNameValue: "Sapphire Edition Platinum Anniversary Collectors Box",
    insertIsRole: true,
  };

  test("a cut core reports the set words it lost; the insert's name stays whole", () => {
    const inputs = listingInputsForCard({ cardNumber: "300" }, LONG_INSERT, {
      playerNames: ["Shohei Ohtani"],
    });
    const assessment = assessListingTitle(inputs);
    expect(assessment.coreFits).toBe(false);
    // Jason, 2026-10-19: the insert's name is never cut. The card number
    // goes first, then the set words from the end (before NEO-339's fix it
    // was the insert's tail).
    expect(assessment.title).toBe(
      "2026 Topps Sapphire Edition Platinum Anniversary Collectors Box Shohei Ohtani",
    );
    const left = leftOutOfTitle(inputs, assessment);
    expect(left).toEqual(["Chrome Update Series", "#300"]);
  });

  test("with the short name in use, the full names are not reported — they were replaced", () => {
    const inputs = listingInputsForCard(
      { cardNumber: "300" },
      { ...LONG_INSERT, listingShortName: "Topps Sapphire" },
      { playerNames: ["Shohei Ohtani"] },
    );
    const assessment = assessListingTitle(inputs);
    expect(assessment.shortNameUsed).toBe(true);
    expect(assessment.coreFits).toBe(true);
    expect(leftOutOfTitle(inputs, assessment)).toEqual([]);
  });
});

describe("NEO-335 — suggestShortSetName", () => {
  const COLLECTORS_CHOICE: ListingSetContext = {
    sportValue: "Baseball",
    setNameValue: "Collector's Choice",
    inheritedFeatures: { manufacturer: "Upper Deck", season: "1990" },
  };

  test("the maker and the insert's first word: Upper Deck Hologram", () => {
    expect(
      suggestShortSetName({ ...COLLECTORS_CHOICE, insertNameValue: "Hologram", insertIsRole: true }),
    ).toBe("Upper Deck Hologram");
  });

  test("no insert: the first word of the set name that is not the maker's", () => {
    expect(
      suggestShortSetName({ ...COLLECTORS_CHOICE, setNameValue: "Upper Deck Collector's Choice" }),
    ).toBe("Upper Deck Collector's");
  });

  test("an insert-level row without the role is not read", () => {
    expect(
      suggestShortSetName({ ...COLLECTORS_CHOICE, insertNameValue: "Hologram", insertIsRole: false }),
    ).toBe("Upper Deck Collector's");
  });

  test("an unknown brand is never offered", () => {
    expect(
      suggestShortSetName({
        ...COLLECTORS_CHOICE,
        manufacturerBrandUnknown: true,
        inheritedFeatures: { manufacturer: "All Brands" },
        insertNameValue: "Hologram Heroes",
        insertIsRole: true,
      }),
    ).toBe("Hologram");
  });

  test("nothing shorter to offer: undefined", () => {
    expect(
      suggestShortSetName({ sportValue: "Baseball", setNameValue: "Topps", inheritedFeatures: { manufacturer: "Topps" } }),
    ).toBeUndefined();
    expect(suggestShortSetName({ sportValue: "Baseball" })).toBeUndefined();
  });
});

describe("NEO-335 — checkShortNameAnswer (the write paths' rule, without throwing)", () => {
  test("trimmed; blank and absent are nothing to send", () => {
    expect(checkShortNameAnswer("  Upper Deck Hologram ")).toEqual({ value: "Upper Deck Hologram" });
    expect(checkShortNameAnswer("   ")).toEqual({});
    expect(checkShortNameAnswer(undefined)).toEqual({});
  });

  test("60 is the cap", () => {
    expect(checkShortNameAnswer("x".repeat(60))).toEqual({ value: "x".repeat(60) });
    expect(checkShortNameAnswer("x".repeat(61)).error).toMatch(/60/);
  });

  test("control and invisible characters are refused with the server's sentence", () => {
    expect(checkShortNameAnswer("Upper\tDeck").error).toMatch(/control characters/);
    expect(checkShortNameAnswer("Upper\u200bDeck").error).toMatch(/invisible/);
  });
});

describe("NEO-345 — the leaf's autograph format, through mergeCardFeatures", () => {
  const leaf = (format: string): ListingSetContext => ({
    ...SET,
    inheritedFeatures: { ...SET.inheritedFeatures, autographed: "None", autographFormat: format },
  });

  test.each(["On Card", "Sticker/Label"])(
    "an AU card under a %s leaf is autographed with it, and the format is stripped",
    (format) => {
      const merged = mergeCardFeatures({ cardNumber: "1", attributes: ["AU"] }, leaf(format));
      expect(merged.autographed).toBe(format);
      expect(merged).not.toHaveProperty("autographFormat");
    },
  );

  test("a card without AU stays None and loses the leaf's key too", () => {
    const merged = mergeCardFeatures({ cardNumber: "1", attributes: ["RC"] }, leaf("On Card"));
    expect(merged.autographed).toBe("None");
    expect(merged).not.toHaveProperty("autographFormat");
  });

  test("fill-empty: a copy's own autographed (its base features) wins", () => {
    const merged = mergeCardFeatures(
      { cardNumber: "1", attributes: ["AU"], baseFeatures: { autographed: "On Card" } },
      leaf("Sticker/Label"),
    );
    expect(merged.autographed).toBe("On Card");
  });

  test("a marketplace autographType is never the format", () => {
    const merged = mergeCardFeatures(
      { cardNumber: "1", attributes: ["AU"], autographType: "Unknown" },
      { ...SET, inheritedFeatures: { ...SET.inheritedFeatures, autographed: "None" } },
    );
    expect(merged.autographed).toBe("None");
  });

  test("the pre-save title (draft answer on titleContext) and the insert agree: both say AUTO", () => {
    const card: ListingCardFacts = { cardNumber: "7", attributes: ["AU"] };
    // The UI puts the wizard's draft answer here before save; the commit
    // writes it onto the leaf, so the insert reads the same key.
    const set = leaf("On Card");
    const preview = assessNewCardListing(card, set, { playerNames: ["Mike Trout"] });
    const built = buildCardRowForInsert(
      {
        selectorOptionId: SELECTOR_ID,
        cardNumber: "7",
        cardName: "Mike Trout",
        attributes: ["AU"],
        platformData: {},
        pendingPlayerNames: [],
        pendingTeamNames: [],
        sortOrder: 0,
        playerNames: ["Mike Trout"],
      } satisfies NewCardRow,
      set,
      NOW,
    );
    expect(preview.assessment.title).toMatch(/\bAUTO\b/);
    expect(built.row.listingTitle).toBe(preview.assessment.title);
    expect(built.row.features?.autographed).toBe("On Card");
    expect(built.row.features?.signedBy).toBe("Mike Trout");
  });
});

describe("NEO-339 — a long insert name never pushes the player out of the title, nor loses its own words", () => {
  // 2023 Topps Chrome as the set builder files it: a flat insert whose name
  // carries its parallel's words ("Authentics Relics Orange Refractor").
  const chrome = (insert: string): ListingSetContext => ({
    sportValue: "Baseball",
    setNameValue: "Topps Chrome",
    inheritedFeatures: { manufacturer: "Topps", season: "2023" },
    insertNameValue: insert,
    insertIsRole: true,
  });
  const ORANGE_RELIC = "Authentics Relics Orange Refractor";

  test("the tester's card: the number goes, the player and \"Orange Refractor\" stay, and the row is flagged", () => {
    const { assessment, inputs, items } = assessNewCardListing(
      { cardNumber: "TCA-VG", isRelic: true, printRun: 25 },
      chrome(ORANGE_RELIC),
      { playerNames: ["Vladimir Guerrero Jr."], teamNames: ["Toronto Blue Jays"] },
    );
    // Before NEO-339 this card came out as "2023 Topps Chrome Authentics
    // Relics Orange Refractor #TCA-VG RELIC /25 Baseball": every set word, no
    // player. Then as "... Authentics Relics Orange Vladimir Guerrero Jr.
    // #TCA-VG RELIC": the parallel's "Refractor" and the /25 lost. Jason,
    // 2026-10-19: the insert's (and parallel's) name and the print run are
    // never dropped, RELIC beside "Relics" is the redundant word, and the card
    // number goes before a set word ("Topps Chrome" stays "Topps Chrome").
    expect(assessment.title).toBe(
      "2023 Topps Chrome Authentics Relics Orange Refractor Vladimir Guerrero Jr. /25",
    );
    expect(assessment.title.length).toBeLessThanOrEqual(LISTING_TITLE_MAX);
    // The core was still cut, so the row is born `listingTitleTruncated`.
    expect(assessment.coreFits).toBe(false);
    expect(items).toEqual([{ kind: "titleTruncated" }]);
    // "Left out to fit" names the number, then the real tokens; the redundant
    // RELIC and the sport are filler, not listed.
    expect(leftOutOfTitle(inputs, assessment)).toEqual(["#TCA-VG", "Toronto Blue Jays"]);
  });

  test("a dual-player card keeps both names whole; the number and the set words go first", () => {
    const { assessment, inputs, items } = assessNewCardListing(
      { cardNumber: "DR-GT", isRelic: true, printRun: 25 },
      chrome(ORANGE_RELIC),
      { playerNames: ["Vladimir Guerrero Jr.", "Fernando Tatis Jr."] },
    );
    // The players, the insert and /25 alone are 81 characters: the fallback.
    // The print run and the players stay whole, the insert keeps its leading
    // words, the year takes what is left. Before: the insert kept only
    // "Authentics", and RELIC and /25 were dropped.
    expect(assessment.title).toBe(
      "2023 Authentics Relics Orange Vladimir Guerrero Jr. & Fernando Tatis Jr. /25",
    );
    expect(assessment.coreFits).toBe(false);
    expect(items).toEqual([{ kind: "titleTruncated" }]);
    expect(leftOutOfTitle(inputs, assessment)).toEqual(["Topps", "Chrome", "Refractor", "#DR-GT"]);
  });

  test("an insert that fits is untouched and not flagged", () => {
    const { assessment, inputs, items } = assessNewCardListing(
      { cardNumber: "YQ-1", isRookie: true },
      chrome("Youthquake"),
      { playerNames: ["Elly De La Cruz"], teamNames: ["Cincinnati Reds"] },
    );
    expect(assessment.title).toBe(
      "2023 Topps Chrome Youthquake Elly De La Cruz #YQ-1 RC Cincinnati Reds Rookie",
    );
    expect(assessment.coreFits).toBe(true);
    expect(items).toEqual([]);
    expect(leftOutOfTitle(inputs, assessment)).toEqual([]);
  });

  test("three players: the names stay whole and the insert keeps its leading words", () => {
    const { assessment } = assessNewCardListing(
      { cardNumber: "1" },
      chrome(ORANGE_RELIC),
      { playerNames: ["Vladimir Guerrero Jr.", "Fernando Tatis Jr.", "Julio Rodriguez"] },
    );
    expect(assessment.coreFits).toBe(false);
    // The fallback again (the names and the insert are 95 characters).
    // Before: "2023 Topps <names> #1", the insert dropped whole.
    expect(assessment.title).toBe(
      "Authentics Relics Vladimir Guerrero Jr. & Fernando Tatis Jr. & Julio Rodriguez",
    );
    expect(assessment.dropped).toContain("#1");
  });
});
