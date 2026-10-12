/**
 * NEO-335 Phase 2 — adversarial pass over `card-titles.ts`: the "kept"
 * default (it carries the very title the step showed), recompute on team
 * and variation answers, the 80 / 81 and 65 / 66 edges on the browser side,
 * grouping that must never key on a card number, and positional answers
 * beside re-synced rows.
 *
 * `.test.tsx` because `.test.ts` is not collected under components/.
 */

import { describe, expect, it, test } from "vitest";
import type { Id } from "../../convex/_generated/dataModel";
import type { TitleContext } from "../../convex/features/listingInputs";
import { ASPECT_VALUE_MAX, LISTING_TITLE_MAX } from "../../convex/features/listingLimits";
import { MAX_CARD_TEAMS } from "../../convex/features/cardAttention";
import {
  buildTitleGroups,
  cardsNeedingTitleReview,
  effectiveVariation,
  titleAnswersForCommit,
  titleDraftState,
  type PreviewCardForTitles,
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
    teams: [],
    ...overrides,
  };
}
const SHORT = context({ setNameValue: "Chrome" });

function card(n: string, extra: Partial<PreviewCardForTitles> = {}): PreviewCardForTitles {
  return { cardNumber: n, cardName: `Card ${n}`, players: ["Shohei Ohtani"], ...extra };
}

const tid = (n: number) => `team_${n}` as Id<"teams">;

/** What the step shows for one card. */
const shown = (
  c: PreviewCardForTitles,
  ctx: TitleContext = context(),
  teamAnswers?: Parameters<typeof buildTitleGroups>[2],
  options?: Parameters<typeof buildTitleGroups>[3],
) => buildTitleGroups([c], ctx, teamAnswers, options).titleGroups[0]?.cards[0];

describe("the 'kept' default carries the title the step showed", () => {
  test("it is the generated title, byte for byte, never a flag", () => {
    const [out] = titleAnswersForCommit([card("1")], context());
    expect(out).toEqual({ listingTitleKept: shown(card("1"))!.title });
    expect(out?.listingTitleKept).toBeTypeOf("string");
  });

  test("a team answer changes the title the step shows; 'kept' follows it", () => {
    const withTeam = [{ teamIds: [tid(1)] }];
    const names = { teamNameById: new Map([[tid(1), "A".repeat(60)]]) };
    const before = shown(card("1"))!.title;
    const after = shown(card("1"), context(), withTeam, { names })!.title;
    const [kept] = titleAnswersForCommit([card("1")], context(), withTeam, { names });
    expect(kept?.listingTitleKept).toBe(after);
    // The long team can only make the title shorter or leave it alone; whichever,
    // 'kept' is what the step now shows, not what it showed before the answer.
    expect(after.length).toBeLessThanOrEqual(LISTING_TITLE_MAX);
    expect(before.length).toBeLessThanOrEqual(LISTING_TITLE_MAX);
  });

  test("a valid variation answer changes the title; 'kept' is the title with the trimmed variation", () => {
    const c = card("1", { cardVariation: LONG_VARIATION });
    const [out] = titleAnswersForCommit([c], context(), undefined, {
      answers: [{ cardVariation: "Throwback" }],
    });
    const after = shown(c, context(), undefined, { answers: [{ cardVariation: "Throwback" }] })!.title;
    expect(out).toEqual({
      listingTitleKept: after,
      cardVariation: "Throwback",
      cardVariationAnswered: true,
    });
  });

  test("an INVALID variation answer (66) leaves the printed variation in the title that 'kept' carries", () => {
    const c = card("1", { cardVariation: LONG_VARIATION });
    const bad = { cardVariation: "v".repeat(ASPECT_VALUE_MAX + 1) };
    const [out] = titleAnswersForCommit([c], context(), undefined, { answers: [bad] });
    expect(out?.cardVariationAnswered).toBeUndefined();
    expect(out?.listingTitleKept).toBe(shown(c)!.title);
  });

  test("a card that is on the step ONLY for its variation sends no 'kept'", () => {
    const c = card("1", { cardVariation: LONG_VARIATION });
    const [out] = titleAnswersForCommit([c], SHORT, undefined, {
      answers: [{ cardVariation: "Throwback" }],
    });
    expect(out).toEqual({ cardVariation: "Throwback", cardVariationAnswered: true });
  });

  test("a typed title on a card on the step only for its variation is not sent", () => {
    const c = card("1", { cardVariation: LONG_VARIATION });
    const [out] = titleAnswersForCommit([c], SHORT, undefined, {
      answers: [{ listingTitle: "My own title", cardVariation: "Throwback" }],
    });
    expect(out?.listingTitle).toBeUndefined();
  });
});

describe("the title draft — 80 / 81 on the browser side", () => {
  const gen = "Generated #1";

  test("exactly 80 is theirs; 81 is over; padding is not counted", () => {
    expect(titleDraftState("t".repeat(80), gen)).toEqual({ kind: "own", title: "t".repeat(80) });
    expect(titleDraftState(`  ${"t".repeat(80)}  `, gen)).toEqual({
      kind: "own",
      title: "t".repeat(80),
    });
    expect(titleDraftState("t".repeat(81), gen)).toEqual({ kind: "over", length: 81 });
    expect(titleDraftState(` ${"t".repeat(81)} `, gen)).toEqual({ kind: "over", length: 81 });
  });

  test("a draft equal to the generated title is kept, whatever the padding or the tabs around it", () => {
    expect(titleDraftState(`\t${gen}\n`, gen)).toEqual({ kind: "kept" });
  });

  test("a draft that differs only by case is THEIRS (not kept)", () => {
    expect(titleDraftState(gen.toUpperCase(), gen)).toEqual({
      kind: "own",
      title: gen.toUpperCase(),
    });
  });

  test("astral characters count two each, the way the commit counts them: 40 fit, 41 are over", () => {
    expect(titleDraftState("\u{1F3C0}".repeat(40), gen).kind).toBe("own");
    expect(titleDraftState("\u{1F3C0}".repeat(41), gen)).toEqual({ kind: "over", length: 82 });
  });

  test("an over-cap draft sends neither a title nor 'kept': the server titles it and flags it", () => {
    const [out] = titleAnswersForCommit([card("1")], context(), undefined, {
      answers: [{ listingTitle: "t".repeat(81) }],
    });
    expect(out).toBeUndefined();
  });

  test("exactly 80 characters is sent, trimmed, and never alongside 'kept'", () => {
    const [out] = titleAnswersForCommit([card("1")], context(), undefined, {
      answers: [{ listingTitle: ` ${"t".repeat(80)} ` }],
    });
    expect(out).toEqual({ listingTitle: "t".repeat(80) });
  });
});

describe("the variation answer — 65 / 66 and what counts as an answer", () => {
  const c = card("1", { cardVariation: LONG_VARIATION });

  test("exactly 65 is sent; 66 is not; padding is not counted", () => {
    const send = (v: string) =>
      titleAnswersForCommit([c], SHORT, undefined, { answers: [{ cardVariation: v }] })[0];
    expect(send("v".repeat(ASPECT_VALUE_MAX))).toEqual({
      cardVariation: "v".repeat(ASPECT_VALUE_MAX),
      cardVariationAnswered: true,
    });
    expect(send(` ${"v".repeat(ASPECT_VALUE_MAX)} `)?.cardVariation).toBe("v".repeat(ASPECT_VALUE_MAX));
    expect(send("v".repeat(ASPECT_VALUE_MAX + 1))).toBeUndefined();
  });

  test("a blank draft, or the printed variation retyped, is no answer", () => {
    const send = (v: string) =>
      titleAnswersForCommit([c], SHORT, undefined, { answers: [{ cardVariation: v }] })[0];
    expect(send("")).toBeUndefined();
    expect(send("   ")).toBeUndefined();
    expect(send(`  ${LONG_VARIATION}  `)).toBeUndefined();
  });

  test("effectiveVariation: a valid answer wins; an invalid or blank one falls back to the printed text", () => {
    expect(effectiveVariation(c, { cardVariation: "Short" })).toBe("Short");
    expect(effectiveVariation(c, { cardVariation: "v".repeat(66) })).toBe(LONG_VARIATION);
    expect(effectiveVariation(c, { cardVariation: "  " })).toBe(LONG_VARIATION);
    expect(effectiveVariation(card("2"), undefined)).toBeUndefined();
  });

  test("a variation of exactly 65 printed characters is not on the step; 66 is", () => {
    expect(
      cardsNeedingTitleReview([card("1", { cardVariation: "v".repeat(65) })], SHORT),
    ).toEqual([]);
    expect(
      cardsNeedingTitleReview([card("1", { cardVariation: "v".repeat(66) })], SHORT),
    ).toEqual([0]);
  });

  // The step measures the PRINTED length (untrimmed) for membership, but the
  // operator can only answer with the trimmed text, and retyping the trimmed
  // text is "no answer" (above). So a variation that is 65 characters once
  // trimmed but printed with a stray space puts the card on the step with
  // nothing the operator can do: the server stores the untrimmed 66 and the
  // walker flags it again after save. Reported to the coordinator.
  it.fails("a variation that fits once trimmed is not asked about", () => {
    const padded = card("1", { cardVariation: `${"v".repeat(ASPECT_VALUE_MAX)} ` });
    expect(cardsNeedingTitleReview([padded], SHORT)).toEqual([]);
  });
});

describe("recompute on team change", () => {
  const names = (...pairs: Array<[number, string]>) => ({
    teamNameById: new Map(pairs.map(([n, name]) => [tid(n), name])),
  });

  test("a team answer can change what is left out but never who is on the step", () => {
    const longTeam = names([1, "T".repeat(70)]);
    expect(cardsNeedingTitleReview([card("1")], SHORT, [{ teamIds: [tid(1)] }], { names: longTeam })).toEqual([]);
    expect(cardsNeedingTitleReview([card("1")], context(), [{ teamIds: [tid(1)] }], { names: longTeam })).toEqual([0]);
  });

  test("answering a team never splits a line: a card's own team is its own row's business, not the shared drop", () => {
    const opts = { names: names([1, "Los Angeles Dodgers"]) };
    const cards = [card("1"), card("2")];
    const split = buildTitleGroups(cards, context(), [{ teamIds: [tid(1)] }, undefined], opts).titleGroups;
    expect(split).toHaveLength(1);
    expect(split[0].cards[0].ownLeftOut).toContain("Los Angeles Dodgers");
    expect(split[0].cards[1].ownLeftOut).not.toContain("Los Angeles Dodgers");
  });

  test("two cards given the SAME team answer stay on one line", () => {
    const opts = { names: names([1, "Los Angeles Dodgers"]) };
    const groups = buildTitleGroups(
      [card("1"), card("2")],
      context(),
      [{ teamIds: [tid(1)] }, { teamIds: [tid(1)] }],
      opts,
    ).titleGroups;
    expect(groups).toHaveLength(1);
  });

  test("a team answer's ids are named once each and no more than MAX_CARD_TEAMS", () => {
    const many = Array.from({ length: MAX_CARD_TEAMS + 2 }, (_, i) => [i, `Team Number${i}`] as [number, string]);
    const ids = [...many.map(([i]) => tid(i)), tid(0), tid(1)];
    const out = shown(card("1"), context(), [{ teamIds: ids }], { names: names(...many) })!;
    const said = `${out.title} ${out.leftOut.join(" ")}`;
    expect(said).toContain("Team Number0");
    expect(said).toContain(`Team Number${MAX_CARD_TEAMS - 1}`);
    // Past the cap is never named, exactly as the commit's per-card cap drops it.
    expect(said).not.toContain(`Team Number${MAX_CARD_TEAMS}`);
    expect(said).not.toContain(`Team Number${MAX_CARD_TEAMS + 1}`);
    expect(out.leftOut.filter((x) => x === "Team Number0")).toHaveLength(1);
  });

  test("an id the browser has no name for is simply not named, never printed as an id", () => {
    const out = shown(card("1"), context(), [{ teamIds: [tid(99)] }], { names: names() })!;
    expect(`${out.title} ${out.leftOut.join(" ")}`).not.toContain("team_99");
  });

  test("'No team' (teamNone) falls back to the set's team, as the commit's default does", () => {
    const ctx = context({ setTeamNames: ["Los Angeles Angels"] });
    const out = shown(card("1"), ctx, [{ teamNone: true }])!;
    expect(out.leftOut).toContain("Los Angeles Angels");
  });

  test("a card with both teamNone and teamIds is titled by the ids (teams win, as at commit)", () => {
    const ctx = context({ setTeamNames: ["Los Angeles Angels"] });
    const out = shown(card("1"), ctx, [{ teamNone: true, teamIds: [tid(1)] }], {
      names: names([1, "Los Angeles Dodgers"]),
    })!;
    expect(out.leftOut).toContain("Los Angeles Dodgers");
    expect(out.leftOut).not.toContain("Los Angeles Angels");
  });
});

describe("answers are positional beside re-synced rows", () => {
  test("a stored row in the middle: answers for the new cards on either side land on those cards", () => {
    const cards = [card("1"), card("2"), card("3")];
    const out = titleAnswersForCommit(cards, context(), undefined, {
      existingIndexes: [1],
      answers: [{ listingTitle: "First #1" }, { listingTitle: "Stored #2" }, { listingTitle: "Third #3" }],
    });
    expect(out).toEqual([{ listingTitle: "First #1" }, undefined, { listingTitle: "Third #3" }]);
  });

  test("an answers array shorter than the cards leaves the rest on the 'kept' default", () => {
    const cards = [card("1"), card("2")];
    const out = titleAnswersForCommit(cards, context(), undefined, {
      answers: [{ listingTitle: "Mine #1" }],
    });
    expect(out[0]).toEqual({ listingTitle: "Mine #1" });
    expect(out[1]?.listingTitleKept).toBe(shown(card("2"))!.title);
  });

  test("a team answer for a stored row's index is harmless", () => {
    const cards = [card("1"), card("2")];
    const out = titleAnswersForCommit(cards, context(), [{ teamIds: [tid(1)] }, undefined], {
      existingIndexes: [0],
    });
    expect(out[0]).toBeUndefined();
    expect(out[1]?.listingTitleKept).toBe(shown(card("2"))!.title);
  });
});

describe("grouping never keys on a card number", () => {
  test("two cards sharing a number but losing different words are two lines, each with its own index", () => {
    const cards = [card("5"), card("5", { isRookie: true })];
    const { titleGroups } = buildTitleGroups(cards, context());
    expect(titleGroups.map((g) => g.cards.map((c) => c.index))).toEqual([[0], [1]]);
  });

  test("two cards sharing a number and losing the same words share one line, both listed", () => {
    const { titleGroups } = buildTitleGroups([card("5"), card("5")], context());
    expect(titleGroups).toHaveLength(1);
    expect(titleGroups[0].cards.map((c) => c.index)).toEqual([0, 1]);
  });

  test("the same over-long variation on two cards sharing a number is one field with both positions", () => {
    const { variationGroups } = buildTitleGroups(
      [card("5", { cardVariation: LONG_VARIATION }), card("5", { cardVariation: LONG_VARIATION })],
      SHORT,
    );
    expect(variationGroups).toHaveLength(1);
    expect(variationGroups[0].cards.map((c) => c.index)).toEqual([0, 1]);
  });

  test("variations that differ only in case are two fields (they are two spellings)", () => {
    const upper = LONG_VARIATION.toUpperCase();
    const { variationGroups } = buildTitleGroups(
      [card("1", { cardVariation: LONG_VARIATION }), card("2", { cardVariation: upper })],
      SHORT,
    );
    expect(variationGroups).toHaveLength(2);
  });

  test("a card on both lists appears once in each, never twice in one", () => {
    const { variationGroups, titleGroups } = buildTitleGroups(
      [card("1", { cardVariation: LONG_VARIATION })],
      context(),
    );
    expect(variationGroups[0].cards).toHaveLength(1);
    expect(titleGroups[0].cards).toHaveLength(1);
  });

  test("groups keep the order of their first card", () => {
    const { titleGroups } = buildTitleGroups(
      [card("1", { isRookie: true }), card("2"), card("3", { isRookie: true })],
      context(),
    );
    expect(titleGroups.map((g) => g.cards.map((c) => c.index))).toEqual([[0, 2], [1]]);
  });
});

describe("unicode and whitespace in what the step reads", () => {
  test("a player printed with odd spacing resolves only by its exact printed string, never a guess", () => {
    const out = shown(card("1", { players: ["Shohei  Ohtani"] }))!;
    expect(`${out.title} ${out.leftOut.join(" ")}`).not.toContain("Ohtani");
  });

  test("a variation of exactly 65 accented letters fits; 66 does not", () => {
    expect(cardsNeedingTitleReview([card("1", { cardVariation: "é".repeat(65) })], SHORT)).toEqual([]);
    expect(cardsNeedingTitleReview([card("1", { cardVariation: "é".repeat(66) })], SHORT)).toEqual([0]);
  });
});
