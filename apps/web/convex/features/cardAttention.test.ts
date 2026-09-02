/**
 * NEO-102 — the `missingTeam` derivation in convex/features/cardAttention.ts.
 *
 * Pure function, so these are plain unit tests with no convex-test harness:
 * the whole point of the module is that it runs identically in a Convex query
 * and in the browser, and a test that needed a database would not be testing
 * that.
 *
 * The matrix below is the specification. Read together, the four "no team"
 * rows say the thing that is easy to get wrong: empty `teamOnCardIds` is NOT
 * by itself a missing team. It is missing when nobody — neither the BSC
 * background lookup nor a human — has answered the question yet.
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
});

describe("needsAttention", () => {
  test("agrees with deriveCardAttention", () => {
    const rows: Array<Parameters<typeof deriveCardAttention>[0]> = [
      {},
      { teamOnCardIds: ["team_1"] },
      { platformData: { bsc: { ref: "b" } } },
      { platformData: { bsc: { ref: "b" } }, teamCheckDoneAt: 1 },
      { teamNoneConfirmedAt: 1 },
    ];
    for (const row of rows) {
      expect(needsAttention(row)).toBe(deriveCardAttention(row).length > 0);
    }
  });
});
