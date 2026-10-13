/**
 * NEO-335 Phase 2 — adversarial parity: the title the pre-save step predicts
 * (assessNewCardListing) against the row buildCardRowForInsert writes and
 * deriveCardAttention reads back, at the edges: the operator's answers, the
 * parallel/baseFeatures arguments the commit never passes, teams past the
 * cap, whitespace and unicode in names.
 */

import { describe, expect, test } from "vitest";
import type { Id } from "../_generated/dataModel";
import { buildCardRowForInsert, type NewCardRow } from "../cardRowCreate";
import { deriveCardAttention } from "./cardAttention";
import {
  assessNewCardListing,
  checkTitleAnswer,
  leftOutOfTitle,
  titleAttentionItems,
  type ListingSetContext,
} from "./listingInputs";
import { assessListingTitle } from "./generateListing";
import { ASPECT_VALUE_MAX, LISTING_TITLE_MAX } from "./listingLimits";

const SELECTOR_ID = "selector-1" as unknown as Id<"selectorOptions">;
const NOW = 1_700_000_000_000;
const LONG_SET: ListingSetContext = {
  sportValue: "Baseball",
  setNameValue: "Chrome Update Series Sapphire Edition Platinum Anniversary Collectors Box",
  inheritedFeatures: { manufacturer: "Topps", season: "2026" },
};

function row(over: Partial<NewCardRow> = {}): NewCardRow {
  return {
    selectorOptionId: SELECTOR_ID,
    cardNumber: "9",
    cardName: "x",
    platformData: {},
    pendingPlayerNames: [],
    pendingTeamNames: [],
    sortOrder: 0,
    playerNames: ["Shohei Ohtani"],
    teamNames: [],
    ...over,
  };
}
const attention = (r: ReturnType<typeof buildCardRowForInsert>["row"]) =>
  deriveCardAttention(r).map((i) => i.kind);

describe("parity with the stored row, with the operator's answers on it", () => {
  const predicted = assessNewCardListing({ cardNumber: "9" }, LONG_SET, {
    playerNames: ["Shohei Ohtani"],
  });

  test("kept = exactly the predicted title: stored title matches and the walker is quiet", () => {
    const built = buildCardRowForInsert(row({ listingTitleKept: predicted.assessment.title }), LONG_SET, NOW);
    expect(built.row.listingTitle).toBe(predicted.assessment.title);
    expect(attention(built.row)).not.toContain("titleTruncated");
  });

  test("kept = one character off: the walker still asks, because nobody saw this title", () => {
    const built = buildCardRowForInsert(
      row({ listingTitleKept: predicted.assessment.title.slice(1) }),
      LONG_SET,
      NOW,
    );
    expect(attention(built.row)).toContain("titleTruncated");
  });

  test("their own title at exactly 80: quiet; the predicted items are not what the row raises", () => {
    const mine = "m".repeat(LISTING_TITLE_MAX);
    const built = buildCardRowForInsert(row({ listingTitle: mine }), LONG_SET, NOW);
    expect(built.row.listingTitle).toBe(mine);
    expect(attention(built.row)).not.toContain("titleTruncated");
    expect(attention(built.row)).not.toContain("titleOverLimit");
  });

  test("an 81-character title that slipped past the callers is still caught by the walker, not hidden by the answer", () => {
    const built = buildCardRowForInsert(row({ listingTitle: "m".repeat(81) }), LONG_SET, NOW);
    expect(attention(built.row)).toContain("titleOverLimit");
  });

  test("a whitespace-only title is no answer: the row is generated and flagged", () => {
    const built = buildCardRowForInsert(row({ listingTitle: "   " }), LONG_SET, NOW);
    expect(built.row.listingTitle).toBe(predicted.assessment.title);
    expect(attention(built.row)).toContain("titleTruncated");
  });

  test("a variation at 65 raises nothing, at 66 raises the aspect item, in the step and on the row alike", () => {
    for (const [len, flagged] of [
      [ASPECT_VALUE_MAX, false],
      [ASPECT_VALUE_MAX + 1, true],
    ] as const) {
      const v = "v".repeat(len);
      const step = assessNewCardListing({ cardNumber: "9", cardVariation: v }, LONG_SET, {
        playerNames: ["Shohei Ohtani"],
      }).items.some((i) => i.kind === "aspectValueOverLimit");
      const stored = attention(buildCardRowForInsert(row({ cardVariation: v }), LONG_SET, NOW).row).includes(
        "aspectValueOverLimit",
      );
      expect(step).toBe(flagged);
      expect(stored).toBe(flagged);
    }
  });

  test("teams: the step and the insert title agree for 0, 1 and 8 team names", () => {
    for (const n of [0, 1, 8]) {
      const teamNames = Array.from({ length: n }, (_, i) => `Team Number${i}`);
      const before = assessNewCardListing({ cardNumber: "9" }, LONG_SET, {
        playerNames: ["Shohei Ohtani"],
        teamNames,
      });
      const built = buildCardRowForInsert(row({ teamNames }), LONG_SET, NOW);
      expect(built.row.listingTitle).toBe(before.assessment.title);
    }
  });

  test("padded and accented names are passed through verbatim by both sides", () => {
    const names = ["  José   Ramírez "];
    const before = assessNewCardListing({ cardNumber: "9" }, LONG_SET, { playerNames: names });
    const built = buildCardRowForInsert(row({ playerNames: names }), LONG_SET, NOW);
    expect(built.row.listingTitle).toBe(before.assessment.title);
  });

  test("the step ignores baseFeatures / parallelName (the commit never passes them), and so does the title", () => {
    const plain = assessNewCardListing({ cardNumber: "9" }, LONG_SET, { playerNames: ["A B"] });
    expect(plain.mergedFeatures.parallelName).toBeUndefined();
  });
});

describe("titleAttentionItems — exactly at the caps", () => {
  test("80 / 81 and 65 / 66, with truncated alongside", () => {
    expect(titleAttentionItems({ listingTitle: "t".repeat(80), listingTitleTruncated: true })).toEqual([
      { kind: "titleTruncated" },
    ]);
    expect(titleAttentionItems({ listingTitle: "t".repeat(81), listingTitleTruncated: true })).toEqual([
      { kind: "titleOverLimit", length: 81 },
    ]);
    expect(titleAttentionItems({ cardVariation: "v".repeat(65) })).toEqual([]);
    expect(titleAttentionItems({ cardVariation: "v".repeat(66) })).toHaveLength(1);
  });

  test("nothing at all, and an empty title, raise nothing", () => {
    expect(titleAttentionItems({})).toEqual([]);
    expect(titleAttentionItems({ listingTitle: "" })).toEqual([]);
  });
});

describe("checkTitleAnswer — edges", () => {
  test("kept and title are each held to the cap; an unanswered variation is never checked", () => {
    expect(() => checkTitleAnswer({ listingTitleKept: "k".repeat(81) }, "c")).toThrow(/81 characters/);
    expect(() => checkTitleAnswer({ listingTitle: "t".repeat(81) }, "c")).toThrow(/81 characters/);
    expect(checkTitleAnswer({ cardVariation: "v".repeat(72) }, "c")).toEqual({});
    expect(checkTitleAnswer({ cardVariation: "v".repeat(72), cardVariationAnswered: false }, "c")).toEqual({});
  });

  test("blank answers produce nothing; padded ones come back trimmed", () => {
    expect(checkTitleAnswer({ listingTitle: " ", listingTitleKept: "\t", cardVariation: " ", cardVariationAnswered: true }, "c")).toEqual({});
    expect(checkTitleAnswer({ listingTitle: " a ", listingTitleKept: " b ", cardVariation: " c ", cardVariationAnswered: true }, "c")).toEqual({
      listingTitle: "a",
      listingTitleKept: "b",
      cardVariation: "c",
    });
  });

  test("the message names the card exactly as the caller gave it", () => {
    expect(() => checkTitleAnswer({ cardVariation: "v".repeat(66), cardVariationAnswered: true }, "card #12")).toThrow(
      "card #12: the variation is 66 characters; the limit is 65.",
    );
  });
});

describe("leftOutOfTitle — odd inputs", () => {
  test("a card with no players, a fitting core: nothing left out and no crash", () => {
    const inputs = assessNewCardListing({ cardNumber: "1" }, { sportValue: "Baseball", setNameValue: "Chrome" }, {
      playerNames: [],
    });
    expect(leftOutOfTitle(inputs.inputs, inputs.assessment)).toEqual([]);
  });

  test("an ampersand between two players is never reported as a loss", () => {
    const { inputs, assessment } = assessNewCardListing({ cardNumber: "1" }, LONG_SET, {
      playerNames: ["Mike Trout", "Shohei Ohtani"],
    });
    expect(assessment.coreFits).toBe(false);
    expect(leftOutOfTitle(inputs, assessment)).not.toContain("&");
    expect(assessListingTitle(inputs).title).toBe(assessment.title);
  });
});
