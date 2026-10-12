/**
 * NEO-335 — `card-titles.ts`: who is on the wizard's "Card titles" step, what
 * each title says, and what reaches the commit.
 *
 * `.test.tsx` although it renders nothing: the components project collects
 * only `.tsx` (vitest.include.mjs).
 */

import { describe, expect, test } from "vitest";
import type { Id } from "../../convex/_generated/dataModel";
import type { TitleContext } from "../../convex/features/listingInputs";
import { ASPECT_VALUE_MAX, LISTING_TITLE_MAX } from "../../convex/features/listingLimits";
import {
  buildTitleGroups,
  cardsNeedingTitleReview,
  teamIdNamesFromRefs,
  titleAnswersForCommit,
  titleDraftState,
  withTitleAnswer,
  type PreviewCardForTitles,
  type TitleReviewRow,
} from "./card-titles";

const LONG_SET =
  "Chrome Update Series Sapphire Edition Platinum Anniversary Collectors Box";
const LONG_VARIATION =
  "Image Variation; Wearing a throwback uniform with the 1970s powder blue logo";

function context(overrides: Partial<TitleContext> = {}): TitleContext {
  return {
    sportValue: "Baseball",
    setNameValue: LONG_SET,
    inheritedFeatures: { manufacturer: "Topps", season: "2026" },
    setTeamNames: [],
    players: [
      { printed: "Shohei Ohtani", name: "Shohei Ohtani" },
      { printed: "Doc Gooden", name: "Dwight Gooden" },
    ],
    teams: [{ printed: "LA Dodgers", name: "Los Angeles Dodgers" }],
    ...overrides,
  };
}

const SHORT = context({ setNameValue: "Chrome" });

function card(n: string, extra: Partial<PreviewCardForTitles> = {}): PreviewCardForTitles {
  return { cardNumber: n, cardName: `Card ${n}`, players: ["Shohei Ohtani"], ...extra };
}

describe("cardsNeedingTitleReview — who is on the step", () => {
  test("a NEW card whose core is cut, or whose variation is over 65; not one that fits", () => {
    const cards = [
      card("1"),
      card("2", { cardVariation: LONG_VARIATION }),
    ];
    expect(cardsNeedingTitleReview(cards, context())).toEqual([0, 1]);
    expect(cardsNeedingTitleReview([card("1")], SHORT)).toEqual([]);
    expect(cardsNeedingTitleReview([card("2", { cardVariation: LONG_VARIATION })], SHORT)).toEqual([
      0,
    ]);
  });

  test("a card that re-syncs a stored row is never asked about", () => {
    expect(
      cardsNeedingTitleReview([card("1"), card("2")], context(), undefined, {
        existingIndexes: [0],
      }),
    ).toEqual([1]);
  });

  test("never moved by the step's own answers (membership reads the printed variation)", () => {
    const cards = [card("2", { cardVariation: LONG_VARIATION })];
    const { variationGroups } = buildTitleGroups(cards, SHORT, undefined, {
      answers: [{ cardVariation: "Throwback" }],
    });
    expect(variationGroups).toHaveLength(1);
  });
});

describe("names — a data claim, never a guess", () => {
  test("a printed name that resolved is titled by its CANONICAL name", () => {
    const [group] = buildTitleGroups([card("1", { players: ["Doc Gooden"] })], context()).titleGroups;
    expect(group.cards[0].title).not.toContain("Doc");
    // The core is cut: the canonical name is what it left out.
    expect(group.cards[0].leftOut.join(" ")).toContain("Gooden");
  });

  test("a printed name that did not resolve and has no wizard answer is not on the card", () => {
    const [group] = buildTitleGroups(
      [card("1", { players: ["Unknown Rookie"] })],
      context(),
    ).titleGroups;
    expect(group.cards[0].leftOut.join(" ")).not.toContain("Unknown");
    expect(group.cards[0].title).not.toContain("Unknown");
  });

  test("wizard decisions: create keeps the row's name, link takes the candidate's, skip drops it", () => {
    const rows: TitleReviewRow[] = [
      { kind: "player", name: "Jim Thome", decision: { action: "create" } },
      {
        kind: "player",
        name: "Ron Artest",
        decision: { action: "link", linkedPlayerId: "p1" },
        enrichment: { existingCandidates: [{ playerId: "p1", name: "Metta World Peace" }] },
      },
      { kind: "player", name: "CHECKLIST", decision: { action: "skip" } },
    ];
    const cards = [card("1", { players: ["Jim Thome", "Ron Artest", "CHECKLIST"] })];
    const [group] = buildTitleGroups(cards, context(), undefined, { names: { rows } }).titleGroups;
    const said = `${group.cards[0].title} ${group.cards[0].leftOut.join(" ")}`;
    expect(said).toContain("Thome");
    expect(said).toContain("Metta World Peace");
    expect(said).not.toContain("Artest");
    expect(said).not.toContain("CHECKLIST");
  });
});

describe("recomputed from the team answers", () => {
  const teamId = "t1" as Id<"teams">;
  const names = { teamNameById: new Map([[teamId, "Los Angeles Dodgers"]]) };

  test("a team answer changes what the trim left out", () => {
    const cards = [card("1")];
    const without = buildTitleGroups(cards, context(), [undefined], { names }).titleGroups;
    const withTeam = buildTitleGroups(cards, context(), [{ teamIds: [teamId] }], {
      names,
    }).titleGroups;
    expect(without[0].cards[0].leftOut).not.toContain("Los Angeles Dodgers");
    expect(withTeam[0].cards[0].leftOut).toContain("Los Angeles Dodgers");
  });

  test("a printed team resolves through the context; none at all takes the set's team", () => {
    const printed = buildTitleGroups([card("1", { teams: ["LA Dodgers"] })], context()).titleGroups;
    expect(printed[0].cards[0].leftOut).toContain("Los Angeles Dodgers");
    const setTeam = buildTitleGroups(
      [card("1")],
      context({ setTeamNames: ["Los Angeles Angels"] }),
    ).titleGroups;
    expect(setTeam[0].cards[0].leftOut).toContain("Los Angeles Angels");
  });

  test("the team answer's strings REPLACE the printed ones", () => {
    const groups = buildTitleGroups(
      [card("1", { teams: ["LA Dodgers"] })],
      context({ teams: [
        { printed: "LA Dodgers", name: "Los Angeles Dodgers" },
        { printed: "Seattle Mariners", name: "Seattle Mariners" },
      ] }),
      [{ teams: ["Seattle Mariners"] }],
    ).titleGroups;
    expect(groups[0].cards[0].leftOut).toContain("Seattle Mariners");
    expect(groups[0].cards[0].leftOut).not.toContain("Los Angeles Dodgers");
  });

  test("teamIdNamesFromRefs keeps only refs with an id", () => {
    expect(
      teamIdNamesFromRefs([
        { teamId: "t1", label: "Reds" },
        { label: "Staged Team" },
      ]),
    ).toEqual(new Map([["t1", "Reds"]]));
  });
});

describe("the over-long variation is asked about once", () => {
  test("a card on the variation list does not also list that variation as a title loss", () => {
    const cards = [card("2", { cardVariation: LONG_VARIATION })];
    const { variationGroups, titleGroups } = buildTitleGroups(cards, context());
    expect(variationGroups).toHaveLength(1);
    expect(titleGroups[0].cards[0].leftOut).not.toContain(LONG_VARIATION);
  });
});

describe("grouping identical drops", () => {
  test("cards that lost the same words share one line, whoever is on them; a different drop is its own", () => {
    const cards = [
      card("1"),
      card("2", { players: ["Doc Gooden"] }),
      card("3", { isRookie: true }),
    ];
    const { titleGroups } = buildTitleGroups(cards, context());
    expect(titleGroups.map((g) => g.cards.map((c) => c.cardNumber))).toEqual([["1", "2"], ["3"]]);
    // Each card's own names stay on its own row, never on the shared line.
    expect(titleGroups[0].leftOut.join(" ")).not.toMatch(/Ohtani|Gooden/);
    expect(titleGroups[0].cards[0].ownLeftOut).toEqual(["Shohei Ohtani"]);
    expect(titleGroups[0].cards[1].ownLeftOut).toEqual(["Dwight Gooden"]);
    expect(titleGroups[1].leftOut).toContain("Rookie");
  });

  test("cards printing the same over-long variation share one field", () => {
    const cards = [
      card("1", { cardVariation: LONG_VARIATION }),
      card("2", { cardVariation: `  ${LONG_VARIATION}` }),
      card("3", { cardVariation: `${LONG_VARIATION}, again` }),
    ];
    const { variationGroups } = buildTitleGroups(cards, SHORT);
    expect(variationGroups.map((g) => g.cards.map((c) => c.index))).toEqual([[0, 1], [2]]);
  });
});

describe("titleDraftState", () => {
  test("blank or unchanged is kept; within the cap is theirs; past it is over", () => {
    expect(titleDraftState(undefined, "Gen")).toEqual({ kind: "kept" });
    expect(titleDraftState("  ", "Gen")).toEqual({ kind: "kept" });
    expect(titleDraftState(" Gen ", "Gen")).toEqual({ kind: "kept" });
    expect(titleDraftState("Mine", "Gen")).toEqual({ kind: "own", title: "Mine" });
    expect(titleDraftState("t".repeat(LISTING_TITLE_MAX + 1), "Gen")).toEqual({
      kind: "over",
      length: LISTING_TITLE_MAX + 1,
    });
  });
});

describe("titleAnswersForCommit — never blocks, never invents", () => {
  test("an untouched title card sends 'kept'; a card not on the step sends nothing", () => {
    const out = titleAnswersForCommit([card("1"), card("2")], context(), undefined, {
      existingIndexes: [1],
    });
    expect(out).toEqual([{ listingTitleKept: true }, undefined]);
    expect(titleAnswersForCommit([card("1")], SHORT)).toEqual([undefined]);
  });

  test("their own title within the cap is sent; over the cap sends nothing at all", () => {
    expect(
      titleAnswersForCommit([card("1")], context(), undefined, {
        answers: [{ listingTitle: " 2026 Topps Chrome Ohtani #1 " }],
      }),
    ).toEqual([{ listingTitle: "2026 Topps Chrome Ohtani #1" }]);
    expect(
      titleAnswersForCommit([card("1")], context(), undefined, {
        answers: [{ listingTitle: "t".repeat(LISTING_TITLE_MAX + 1) }],
      }),
    ).toEqual([undefined]);
  });

  test("a trimmed variation within 65 is sent, flagged as the operator's; over 65 is not", () => {
    const cards = [card("2", { cardVariation: LONG_VARIATION })];
    expect(
      titleAnswersForCommit(cards, SHORT, undefined, { answers: [{ cardVariation: "Throwback " }] }),
    ).toEqual([{ cardVariation: "Throwback", cardVariationAnswered: true }]);
    expect(
      titleAnswersForCommit(cards, SHORT, undefined, {
        answers: [{ cardVariation: "v".repeat(ASPECT_VALUE_MAX + 1) }],
      }),
    ).toEqual([undefined]);
  });

  test("withTitleAnswer: no answer is the same object; an answer replaces the variation", () => {
    const c = card("2", { cardVariation: LONG_VARIATION });
    expect(withTitleAnswer(c, undefined)).toBe(c);
    expect(
      withTitleAnswer(c, { cardVariation: "Throwback", cardVariationAnswered: true }),
    ).toMatchObject({ cardVariation: "Throwback", cardVariationAnswered: true, cardNumber: "2" });
  });
});
