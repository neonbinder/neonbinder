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
  checkTitleAnswer,
  leftOutOfTitle,
  listingInputsForCard,
  mergeCardFeatures,
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
    const left = leftOutOfTitle(inputs, assessment);
    expect(left).toContain("Shohei Ohtani");
    expect(left.at(-1)).toBe("Baseball");
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
   * Every identity length from "the core fits" down to "only the year fits",
   * so the cut is tried at EVERY boundary inside the names, including the one
   * right before the suffix.
   */
  function sweep(playerNames: string[]) {
    const out: Array<{ title: string; coreFits: boolean; left: string[] }> = [];
    for (let pad = 0; pad < 70; pad += 1) {
      const inputs = listingInputsForCard(
        { cardNumber: "1" },
        { sportValue: "Baseball", setNameValue: `Upper Deck ${"x".repeat(pad)}`.trim() },
        { playerNames },
      );
      const a = assessListingTitle(inputs);
      out.push({ title: a.title, coreFits: a.coreFits, left: leftOutOfTitle(inputs, a) });
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
    expect(results.some((r) => /Shohei #1$/.test(r.title))).toBe(true);
    // …and is reported whole.
    expect(
      results.filter((r) => /Shohei #1$/.test(r.title)).every((r) => r.left.includes("Shohei Ohtani")),
    ).toBe(true);
  });
});
