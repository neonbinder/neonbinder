/**
 * NEO-339 — the card evidence a name-only Reconcile pair needs: shared
 * numbers that name the same players.
 */
import { describe, expect, test } from "vitest";
import { evidenceText, MAX_DIFFERING_SHARE, pairCardEvidence } from "./pair-evidence";

const shared = (differ: boolean, extra: Record<string, unknown> = {}) => ({
  confidence: 1,
  card: { players: ["Aaron Judge"], ...(differ ? { playersConflict: { bsc: ["Aaron Judge"], sportlots: ["Andruw Jones"] } } : {}), ...extra },
});

describe("pairCardEvidence", () => {
  test("no shared card number is not evidence", () => {
    expect(pairCardEvidence({ matched: [] })).toEqual({ verdict: "no-shared", shared: 0, differing: 0 });
    // A fuzzy name match (confidence below 1) shares no number.
    expect(pairCardEvidence({ matched: [{ confidence: 0.94, card: { players: ["Aaron Judge"] } }] }).verdict).toBe("no-shared");
  });

  test(`agree up to ${Math.round(MAX_DIFFERING_SHARE * 100)}% differing shared numbers; past it, disagree`, () => {
    expect(pairCardEvidence({ matched: [shared(false)] })).toEqual({ verdict: "agree", shared: 1, differing: 0 });
    expect(pairCardEvidence({ matched: [shared(false), shared(false), shared(true)] })).toEqual({ verdict: "agree", shared: 3, differing: 1 });
    expect(pairCardEvidence({ matched: [shared(false), shared(true)] })).toEqual({ verdict: "disagree", shared: 2, differing: 1 });
    expect(pairCardEvidence({ matched: [shared(true)] }).verdict).toBe("disagree");
  });

  test("a card with no roster on it is judged by its names", () => {
    const noRoster = (nameConflict: boolean) => ({ confidence: 1, card: nameConflict ? { nameConflict: { bsc: "A", sportlots: "B" } } : {} });
    expect(pairCardEvidence({ matched: [noRoster(true)] }).verdict).toBe("disagree");
    expect(pairCardEvidence({ matched: [noRoster(false)] }).verdict).toBe("agree");
    // With a roster that agrees, a title difference is not a different player.
    expect(pairCardEvidence({ matched: [shared(false, { nameConflict: { bsc: "Judge RC", sportlots: "Judge" } })] }).verdict).toBe("agree");
  });

  test("the evidence in words", () => {
    expect(evidenceText({ verdict: "disagree", shared: 3, differing: 2 })).toBe("2 of 3 shared card numbers name different players");
    expect(evidenceText({ verdict: "disagree", shared: 1, differing: 1 })).toBe("1 of 1 shared card number names different players");
    expect(evidenceText({ verdict: "no-shared", shared: 0, differing: 0 })).toBe("their checklists share no card number");
  });
});
