/**
 * NEO-102 — the `missingTeam` derivation in convex/features/cardAttention.ts.
 *
 * Pure function, so these are plain unit tests with no convex-test harness:
 * the whole point of the module is that it runs identically in a Convex query
 * and in the browser, and a test that needed a database would not be testing
 * that.
 *
 * The matrix below is the specification. Read together, the "no team" rows say
 * the thing that is easy to get wrong: empty `teamOnCardIds` is NOT by itself
 * a missing team. It is missing when nobody — not the BSC background lookup,
 * not a human confirming "none", not a human who typed a team name the sync
 * has yet to resolve — has answered the question yet.
 */

import { describe, expect, test } from "vitest";
import { deriveCardAttention, needsAttention } from "./cardAttention";

const MISSING_TEAM = [{ kind: "missingTeam" as const }];

describe("deriveCardAttention — missingTeam", () => {
  test("a custom card with no team and no BSC ref is flagged immediately", () => {
    // Nothing will ever answer this automatically: no BSC ref means no
    // per-card lookup, and SportLots deliberately never scrapes team at all.
    // So there is nothing to wait for.
    expect(deriveCardAttention({ platformData: {} })).toEqual(MISSING_TEAM);
  });

  test("a SportLots-only card with no team is flagged immediately", () => {
    expect(
      deriveCardAttention({
        teamOnCardIds: [],
        platformData: { sportlots: { ref: "some SL description" } },
      }),
    ).toEqual(MISSING_TEAM);
  });

  test("a BSC card whose lookup has NOT run yet is not flagged", () => {
    // The queue drains at one request every 300ms after a commit. Badging
    // during the drain would flood a 900-card checklist with items that
    // resolve themselves, which is how a badge gets trained out of usefulness.
    expect(
      deriveCardAttention({
        teamOnCardIds: [],
        platformData: { bsc: { ref: "bsc-1" } },
      }),
    ).toEqual([]);
  });

  test("a BSC card whose lookup HAS run and found nothing is flagged", () => {
    // `teamCheckDoneAt` means "asked, regardless of outcome". BSC having no
    // team on file is exactly the case a human has to settle — and it is the
    // state every pre-NEO-102 teamless card is already sitting in.
    expect(
      deriveCardAttention({
        teamOnCardIds: [],
        teamCheckDoneAt: 1_700_000_000_000,
        platformData: { bsc: { ref: "bsc-1" } },
      }),
    ).toEqual(MISSING_TEAM);
  });

  test("an operator-confirmed 'no team' card is never flagged", () => {
    expect(
      deriveCardAttention({
        teamOnCardIds: [],
        teamCheckDoneAt: 1_700_000_000_000,
        teamNoneConfirmedAt: 1_700_000_001_000,
        platformData: { bsc: { ref: "bsc-1" } },
      }),
    ).toEqual([]);
  });

  test("a confirmation suppresses the flag even with no lookup ever having run", () => {
    expect(
      deriveCardAttention({
        teamNoneConfirmedAt: 1_700_000_001_000,
        platformData: {},
      }),
    ).toEqual([]);
  });

  test("a card that HAS a team is never flagged, in any lookup state", () => {
    for (const extra of [
      {},
      { teamCheckDoneAt: 1 },
      { teamNoneConfirmedAt: 1 },
      { platformData: { bsc: { ref: "bsc-1" } } },
    ]) {
      expect(
        deriveCardAttention({ teamOnCardIds: ["team_1"], ...extra }),
      ).toEqual([]);
    }
  });

  test("absent and empty teamOnCardIds are the same statement", () => {
    expect(deriveCardAttention({ teamOnCardIds: [] })).toEqual(
      deriveCardAttention({}),
    );
  });

  test("a custom card with a PENDING team name is not flagged", () => {
    // The add-card form's "Team (optional)" field writes the typed name to
    // `pendingTeamNames` and leaves `teamOnCardIds` empty until the next sync
    // resolves it. Reading only `teamOnCardIds` badged that card "no team" and
    // sent the walker to ask the operator for the team they had just typed.
    expect(
      deriveCardAttention({
        teamOnCardIds: [],
        pendingTeamNames: ["Savannah Bananas"],
        platformData: {},
      }),
    ).toEqual([]);
    expect(
      needsAttention({ pendingTeamNames: ["Savannah Bananas"] }),
    ).toBe(false);
  });

  test("an EMPTY pendingTeamNames array is still a missing team", () => {
    // `[]` is not an answer. The resolve pass in selectorOptions.ts strips
    // names as it resolves them and can leave the array behind empty, so this
    // is a real stored shape — and it must read exactly like an absent one.
    expect(
      deriveCardAttention({
        teamOnCardIds: [],
        pendingTeamNames: [],
        platformData: {},
      }),
    ).toEqual(MISSING_TEAM);
  });

  test("an empty-string bsc.ref is treated as no ref — flagged immediately, not held for the lookup", () => {
    // Every other reader of platformData.bsc.ref in this codebase (see
    // selectorOptions.ts's `!!c.platformData.bsc?.ref` checks) treats a falsy
    // ref as "no linkage", not "linked with nothing to say". This pins the
    // same convention here: a card cannot be stuck waiting forever on
    // `teamCheckDoneAt` for a ref that was never a real one.
    expect(
      deriveCardAttention({
        teamOnCardIds: [],
        platformData: { bsc: { ref: "" } },
      }),
    ).toEqual(MISSING_TEAM);
  });
});

// ===========================================================================
// NEO-101 — the listing-length kinds
// ===========================================================================
//
// A row that HAS a team is used throughout, so `missingTeam` stays out of the
// way and each assertion is about exactly one rule.

const HAS_TEAM = { teamOnCardIds: ["team_1"] } as const;

describe("deriveCardAttention — titleOverLimit", () => {
  test("a title at exactly the cap is fine; one character more is not", () => {
    expect(
      deriveCardAttention({ ...HAS_TEAM, listingTitle: "x".repeat(80) }),
    ).toEqual([]);
    expect(
      deriveCardAttention({ ...HAS_TEAM, listingTitle: "x".repeat(81) }),
    ).toEqual([{ kind: "titleOverLimit", length: 81 }]);
  });

  test("carries the measured length so the label need not re-measure", () => {
    expect(
      deriveCardAttention({ ...HAS_TEAM, listingTitle: "x".repeat(94) }),
    ).toEqual([{ kind: "titleOverLimit", length: 94 }]);
  });

  test("an absent or empty title is not over the limit", () => {
    expect(deriveCardAttention({ ...HAS_TEAM })).toEqual([]);
    expect(deriveCardAttention({ ...HAS_TEAM, listingTitle: "" })).toEqual([]);
  });
});

describe("deriveCardAttention — titleTruncated", () => {
  test("fires on the stored flag alone", () => {
    expect(
      deriveCardAttention({
        ...HAS_TEAM,
        listingTitle: "2024 Topps Chrome An Absurdly Long Player Full Name #1",
        listingTitleTruncated: true,
      }),
    ).toEqual([{ kind: "titleTruncated" }]);
  });

  test("clears once the flag is gone — which is what an operator title write does", () => {
    // `updateCard` patches `listingTitleTruncated: undefined` on any title
    // write, so this is the after state of a human rewriting the title. The
    // item clears by construction; nothing has to remember to retract it.
    expect(
      deriveCardAttention({ ...HAS_TEAM, listingTitle: "A hand-written title" }),
    ).toEqual([]);
  });

  test("`false` is the same as absent", () => {
    expect(
      deriveCardAttention({ ...HAS_TEAM, listingTitleTruncated: false }),
    ).toEqual([]);
  });

  test("an over-limit title suppresses it — the two are mutually exclusive", () => {
    // Both true is reachable (an operator pasted an over-long title onto a row
    // whose generated title had been cut, before updateCard gained its cap).
    // "is 94 characters" and "was cut short" read as a contradiction, and
    // rewriting the title fixes both, so only the blocking one is reported.
    expect(
      deriveCardAttention({
        ...HAS_TEAM,
        listingTitle: "x".repeat(94),
        listingTitleTruncated: true,
      }),
    ).toEqual([{ kind: "titleOverLimit", length: 94 }]);
  });
});

describe("deriveCardAttention — aspectValueOverLimit", () => {
  test("a cardVariation at exactly 65 is fine; 66 is flagged", () => {
    expect(
      deriveCardAttention({ ...HAS_TEAM, cardVariation: "v".repeat(65) }),
    ).toEqual([]);
    expect(
      deriveCardAttention({ ...HAS_TEAM, cardVariation: "v".repeat(66) }),
    ).toEqual([
      { kind: "aspectValueOverLimit", field: "cardVariation", length: 66 },
    ]);
  });

  test("names the field, so a future second aspect field does not need a second kind", () => {
    const [item] = deriveCardAttention({
      ...HAS_TEAM,
      cardVariation: "v".repeat(100),
    });
    expect(item).toEqual({
      kind: "aspectValueOverLimit",
      field: "cardVariation",
      length: 100,
    });
  });

  test("warn-only: an over-length variation is a real stored value, not a rejected one", () => {
    // `updateCard` deliberately does NOT cap cardVariation — see the note
    // there. This item existing at all is the whole enforcement.
    expect(
      deriveCardAttention({ ...HAS_TEAM, cardVariation: "v".repeat(200) }),
    ).toHaveLength(1);
  });
});

describe("deriveCardAttention — kinds compose", () => {
  test("one row can owe a human several different things at once", () => {
    expect(
      deriveCardAttention({
        platformData: {},
        listingTitle: "x".repeat(120),
        cardVariation: "v".repeat(90),
      }),
    ).toEqual([
      { kind: "missingTeam" },
      { kind: "titleOverLimit", length: 120 },
      { kind: "aspectValueOverLimit", field: "cardVariation", length: 90 },
    ]);
  });

  test("a fully-settled row owes nothing", () => {
    expect(
      deriveCardAttention({
        ...HAS_TEAM,
        listingTitle: "2024 Topps Chrome Elly De La Cruz #50 RC",
        cardVariation: "Image Variation; Wearing sunglasses",
      }),
    ).toEqual([]);
  });
});

describe("needsAttention", () => {
  test("agrees with deriveCardAttention", () => {
    const rows: Array<Parameters<typeof deriveCardAttention>[0]> = [
      {},
      { teamOnCardIds: ["team_1"] },
      { platformData: { bsc: { ref: "b" } } },
      { platformData: { bsc: { ref: "b" } }, teamCheckDoneAt: 1 },
      { teamNoneConfirmedAt: 1 },
      { pendingTeamNames: ["Savannah Bananas"] },
      { pendingTeamNames: [] },
      // NEO-101 kinds, on rows that are otherwise settled.
      { ...HAS_TEAM, listingTitle: "x".repeat(81) },
      { ...HAS_TEAM, listingTitleTruncated: true },
      { ...HAS_TEAM, cardVariation: "v".repeat(66) },
      { ...HAS_TEAM, listingTitle: "x".repeat(80), cardVariation: "v".repeat(65) },
    ];
    for (const row of rows) {
      expect(needsAttention(row)).toBe(deriveCardAttention(row).length > 0);
    }
  });
});
