/**
 * NEO-335 — `card-titles.ts`: who is on the wizard's "Card titles" step, what
 * each title says, and what reaches the commit.
 *
 * `.test.tsx` although it renders nothing: the components project collects
 * only `.tsx` (vitest.include.mjs).
 */

import { describe, expect, test } from "vitest";
import type { Id } from "../../convex/_generated/dataModel";
import { assessNewCardListing, type TitleContext } from "../../convex/features/listingInputs";
import { ASPECT_VALUE_MAX, LISTING_TITLE_MAX } from "../../convex/features/listingLimits";
import {
  buildTitleGroups,
  cardsNeedingTitleReview,
  shortNameFieldApplies,
  teamIdNamesFromRefs,
  titleAnswersForCommit,
  titleDraftState,
  validShortName,
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
    // The core is cut, but the set's words go first (NEO-339): the canonical
    // name is in the title.
    expect(group.cards[0].title).toContain("Dwight Gooden #1");
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

describe("a generational suffix stays on the name (shared with the insert)", () => {
  test("a father-and-son card never titles as two bare 'Ken Griffey's", () => {
    for (let pad = 0; pad < 40; pad += 1) {
      const ctx = context({
        setNameValue: `Upper Deck ${"x".repeat(20 + pad)}`,
        players: [
          { printed: "Ken Griffey Jr.", name: "Ken Griffey Jr." },
          { printed: "Ken Griffey Sr.", name: "Ken Griffey Sr." },
        ],
      });
      const groups = buildTitleGroups(
        [card("1", { players: ["Ken Griffey Jr.", "Ken Griffey Sr."] })],
        ctx,
      ).titleGroups;
      for (const c of groups.flatMap((g) => g.cards)) {
        expect(c.title).not.toMatch(/Griffey(?! (Jr|Sr)\.)/);
        expect(c.leftOut).not.toContain("Jr.");
        expect(c.leftOut).not.toContain("Sr.");
      }
    }
  });
});

describe("grouping identical drops", () => {
  test("cards that lost the same words share one line, whoever is on them; a different drop is its own", () => {
    const cards = [
      card("1", { teams: ["LA Dodgers"] }),
      card("2", { players: ["Doc Gooden"] }),
      // A dropped variation is a real loss ("Rookie" is filler and hidden).
      card("3", { cardVariation: "Sapphire Throwback Gold Refractor" }),
    ];
    const { titleGroups } = buildTitleGroups(cards, context());
    expect(titleGroups.map((g) => g.cards.map((c) => c.cardNumber))).toEqual([["1", "2"], ["3"]]);
    // NEO-339: the set's last words are what the cut cost; the players stay.
    expect(titleGroups[0].leftOut).toEqual(["Anniversary Collectors Box"]);
    // Each card's own names stay on its own row, never on the shared line.
    expect(titleGroups[0].leftOut.join(" ")).not.toMatch(/Ohtani|Gooden|Dodgers/);
    expect(titleGroups[0].cards[0].ownLeftOut).toEqual(["Los Angeles Dodgers"]);
    expect(titleGroups[0].cards[1].ownLeftOut).toEqual([]);
    expect(titleGroups[1].leftOut).toContain("Sapphire Throwback Gold Refractor");
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
    // The kept answer carries the very title the step showed.
    const shown = buildTitleGroups([card("1")], context()).titleGroups[0].cards[0].title;
    expect(out).toEqual([{ listingTitleKept: shown }, undefined]);
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

describe("NEO-335 — the short name on the step", () => {
  const cards = [card("1"), card("2", { players: ["Doc Gooden"] })];

  test("the field applies only with trimmed titles and no stored short name", () => {
    expect(shortNameFieldApplies(cards, context())).toBe(true);
    // Nothing trimmed: no field.
    expect(shortNameFieldApplies(cards, SHORT)).toBe(false);
    // Only a variation over 65 on the step: no field (the name would not help).
    expect(
      shortNameFieldApplies([card("3", { cardVariation: LONG_VARIATION })], SHORT),
    ).toBe(false);
    // A short name already stored in the chain: no field.
    expect(shortNameFieldApplies(cards, context({ listingShortName: "Topps Sapphire" }))).toBe(
      false,
    );
  });

  test("a stored short name titles the cards, so they are not on the step at all", () => {
    expect(cardsNeedingTitleReview(cards, context({ listingShortName: "Topps Sapphire" }))).toEqual(
      [],
    );
  });

  test("the list empties as titles fit; membership of the STEP ignores the draft", () => {
    const before = buildTitleGroups(cards, context());
    expect(before.titleGroups.flatMap((g) => g.cards.map((c) => c.index))).toEqual([0, 1]);
    const after = buildTitleGroups(cards, context(), undefined, {
      listingShortName: "Topps Sapphire",
    });
    expect(after.titleGroups).toEqual([]);
    // The step itself stays: its membership is never read with the draft.
    expect(cardsNeedingTitleReview(cards, context())).toEqual([0, 1]);
  });

  test("a short name that still cuts one card leaves that card, titled with it", () => {
    const longPlayer = card("3", {
      players: ["Shohei Ohtani", "Doc Gooden"],
    });
    const { titleGroups } = buildTitleGroups([card("1"), longPlayer], context(), undefined, {
      listingShortName: "Topps Chrome Update Series Sapphire Edition Platinum",
    });
    const shown = titleGroups.flatMap((g) => g.cards);
    expect(shown.map((c) => c.index)).toEqual([1]);
    // Titled with the short name, cut from its end (NEO-339: the set words go
    // before the players).
    for (const c of shown) {
      expect(c.title.startsWith("2026 Topps Chrome Update Series Sapphire ")).toBe(true);
      expect(c.title).toContain("Shohei Ohtani & Dwight Gooden #3");
    }
  });

  test("the commit's kept titles are generated with the short name; fitted cards send nothing", () => {
    const fields = titleAnswersForCommit(cards, context(), undefined, {
      listingShortName: "Topps Sapphire",
    });
    expect(fields).toEqual([undefined, undefined]);
    const without = titleAnswersForCommit(cards, context());
    expect(without[0]?.listingTitleKept).toContain("Chrome Update");
  });

  test("validShortName: the server's rule, read without throwing", () => {
    expect(validShortName("  Topps Sapphire ")).toBe("Topps Sapphire");
    expect(validShortName("")).toBeUndefined();
    expect(validShortName(undefined)).toBeUndefined();
    expect(validShortName("x".repeat(61))).toBeUndefined();
    expect(validShortName("Topps\tSapphire")).toBeUndefined();
  });
});

describe("NEO-335 — an operator's own title is never dropped by the short name", () => {
  const cards = [card("1"), card("2", { players: ["Doc Gooden"] })];
  const SHORT_NAME = "Topps Sapphire";

  test("their own title keeps the card on the list, marked as fitting now, and is what saves", () => {
    const answers = [{ listingTitle: "My Ohtani title #1" }, undefined];
    const { titleGroups } = buildTitleGroups(cards, context(), undefined, {
      answers,
      listingShortName: SHORT_NAME,
    });
    const shown = titleGroups.flatMap((g) => g.cards);
    expect(shown.map((c) => [c.index, c.fitsNow])).toEqual([[0, true]]);
    expect(shown[0].title).toContain(SHORT_NAME);
    expect(
      titleAnswersForCommit(cards, context(), undefined, { answers, listingShortName: SHORT_NAME }),
    ).toEqual([{ listingTitle: "My Ohtani title #1" }, undefined]);
  });

  test("a draft typed back to the generated title stays on the list but sends nothing", () => {
    const generated = buildTitleGroups([card("1")], context(), undefined, {
      listingShortName: SHORT_NAME,
      answers: [{ listingTitle: "x" }],
    }).titleGroups[0].cards[0].title;
    const answers = [{ listingTitle: ` ${generated} ` }];
    const { titleGroups } = buildTitleGroups([card("1")], context(), undefined, {
      answers,
      listingShortName: SHORT_NAME,
    });
    expect(titleGroups.flatMap((g) => g.cards.map((c) => c.fitsNow))).toEqual([true]);
    expect(
      titleAnswersForCommit([card("1")], context(), undefined, {
        answers,
        listingShortName: SHORT_NAME,
      }),
    ).toEqual([undefined]);
  });

  test("an over-cap own title on a card that now fits sends nothing: the generated one fits", () => {
    const answers = [{ listingTitle: "t".repeat(90) }];
    expect(
      titleAnswersForCommit([card("1")], context(), undefined, {
        answers,
        listingShortName: SHORT_NAME,
      }),
    ).toEqual([undefined]);
  });

  test("never 'fits now' without a short name, nor for a card that was never trimmed", () => {
    const answers = [{ listingTitle: "Mine #1" }];
    const plain = buildTitleGroups([card("1")], context(), undefined, { answers });
    expect(plain.titleGroups.flatMap((g) => g.cards.map((c) => c.fitsNow))).toEqual([undefined]);
    const neverTrimmed = buildTitleGroups([card("1")], SHORT, undefined, {
      answers,
      listingShortName: SHORT_NAME,
    });
    expect(neverTrimmed.titleGroups).toEqual([]);
  });
});

describe("NEO-335 — the Insert / Parallel labels on the step", () => {
  const labelled = context({
    setNameValue: "Chrome",
    insertNameValue: "Dugout Collection",
    insertIsRole: true,
    parallelLeafValue: "Gold",
  });

  test("a card that loses only the labels is not on the step", () => {
    // Fits without the labels; the team leaves no room for either word.
    const c = card("5", { teams: ["LA Dodgers"] });
    const { assessment } = assessNewCardListing(
      { cardNumber: "5" },
      labelled,
      { playerNames: ["Shohei Ohtani"], teamNames: ["Los Angeles Dodgers"] },
    );
    expect(assessment.title).toBe(
      "2026 Topps Chrome Dugout Collection Shohei Ohtani #5 Gold Los Angeles Dodgers",
    );
    expect(assessment.dropped).toEqual(["Baseball", "Parallel", "Insert"]);
    expect(cardsNeedingTitleReview([c], labelled)).toEqual([]);
  });

  test("the shown title carries them; the left-out list never names them", () => {
    const fits = card("5");
    const cut = card("6", {
      players: ["Shohei Ohtani", "Doc Gooden"],
      cardVariation: "Wearing a throwback uniform",
    });
    const roomy = context({
      setNameValue: "Chrome",
      insertNameValue: "Dugout Collection Sapphire Platinum Anniversary",
      insertIsRole: true,
      parallelLeafValue: "Gold",
    });
    expect(cardsNeedingTitleReview([fits], labelled)).toEqual([]);
    const { titleGroups } = buildTitleGroups([cut], roomy);
    const shown = titleGroups.flatMap((g) => g.cards);
    expect(shown).toHaveLength(1);
    expect(shown[0].coreFits).toBe(false);
    expect(shown[0].leftOut).not.toContain("Insert");
    expect(shown[0].leftOut).not.toContain("Parallel");
  });
});
