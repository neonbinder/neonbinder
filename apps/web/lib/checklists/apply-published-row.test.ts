/**
 * NEO-490 — `applyChecklistRow`: what one publisher-checklist row does to the
 * card it is paired with (wrapper rules 3 and 8). The fetch's step 3c and the
 * operator's own links share it, so the cases are pinned once, here.
 */
import { describe, expect, test, vi } from "vitest";
import { MAX_CARD_TEAMS } from "../../convex/features/cardAttention";
import { applyChecklistRow, checklistTeamTextNeedsResolving } from "./apply-published-row";

const noResolve = () => null;

describe("applyChecklistRow: teams", () => {
  test("a row naming one team answers the card with it", () => {
    const r = applyChecklistRow({ players: ["A One"], teams: [] }, { players: ["A One"], teams: ["Boston Red Sox"] }, noResolve);
    expect(r).toEqual({ teams: ["Boston Red Sox"], answered: true });
  });

  test("a row naming no team makes no claim: teams [] and not answered", () => {
    const r = applyChecklistRow({ players: ["A One"], teams: ["Boston Red Sox"] }, { players: ["A One"], teams: [] }, noResolve);
    expect(r.teams).toEqual([]);
    expect(r.answered).toBe(false);
    expect(r.conflict).toBeUndefined();
  });

  test("blank team texts count as naming no team", () => {
    const r = applyChecklistRow({}, { players: [], teams: ["  ", ""] }, noResolve);
    expect(r.teams).toEqual([]);
    expect(r.answered).toBe(false);
  });

  test("a refused comma text gives teams null, is not answered and offers no conflict", () => {
    const r = applyChecklistRow(
      { players: ["A One"], teams: ["New York Mets"] },
      { players: ["A One"], teams: ["Phillies, Braves"] },
      noResolve,
    );
    expect(r.teams).toBeNull();
    expect(r.answered).toBe(false);
    expect(r.conflict).toBeUndefined();
  });

  test("a list past MAX_CARD_TEAMS is refused as null", () => {
    const names = Array.from({ length: MAX_CARD_TEAMS + 1 }, (_, i) => `Team${i}`);
    const r = applyChecklistRow({}, { players: [], teams: ["many, teams"] }, () => names);
    expect(r.teams).toBeNull();
    expect(r.answered).toBe(false);
  });

  test("resolveText is asked only about a text with a comma", () => {
    const resolve = vi.fn(() => ["Philadelphia Phillies", "Atlanta Braves"]);
    const r = applyChecklistRow({}, { players: [], teams: ["Boston Red Sox", "Phillies, Braves"] }, resolve);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith("Phillies, Braves");
    expect(r.teams).toEqual(["Boston Red Sox", "Philadelphia Phillies", "Atlanta Braves"]);
  });

  test("resolved teams are deduped", () => {
    const r = applyChecklistRow({}, { players: [], teams: ["Boston Red Sox", "a, b"] }, () => ["Boston Red Sox"]);
    expect(r.teams).toEqual(["Boston Red Sox"]);
  });

  test("a team conflict keeps the marketplace's teams and carries both sides, resolved", () => {
    const r = applyChecklistRow(
      { players: ["A One"], teams: ["New York Mets"] },
      { players: ["A One"], teams: ["Phillies, Braves"] },
      () => ["Philadelphia Phillies", "Atlanta Braves"],
    );
    expect(r.conflict).toEqual({
      teams: { marketplace: ["New York Mets"], checklist: ["Philadelphia Phillies", "Atlanta Braves"] },
    });
    expect(r.answered).toBe(false);
    expect(r.teams).toEqual(["Philadelphia Phillies", "Atlanta Braves"]);
  });

  test("a team text that resolves to the card's own teams is no conflict and answers", () => {
    const r = applyChecklistRow(
      { players: ["A One"], teams: ["New York Mets", "New York Yankees"] },
      { players: ["A One"], teams: ["Yankees, Mets"] },
      () => ["New York Yankees", "New York Mets"],
    );
    expect(r.conflict).toBeUndefined();
    expect(r.answered).toBe(true);
  });

  test("a players-only conflict survives when the team conflict is dropped", () => {
    const r = applyChecklistRow(
      { players: ["A One"], teams: ["New York Mets"] },
      { players: ["B Two"], teams: ["Mets, Mets"] },
      () => ["New York Mets"],
    );
    expect(r.conflict).toEqual({ players: { marketplace: ["A One"], checklist: ["B Two"] } });
    expect(r.answered).toBe(true);
  });
});

describe("applyChecklistRow: players", () => {
  test("the row's players fill a card that has none", () => {
    const r = applyChecklistRow({ players: [], teams: [] }, { players: ["Juan Soto"], teams: [] }, noResolve);
    expect(r.fillPlayers).toEqual(["Juan Soto"]);
  });

  test("a card that has players is never filled, and a disagreement is a conflict", () => {
    const r = applyChecklistRow({ players: ["Pete Alonso"], teams: [] }, { players: ["Kyle Schwarber"], teams: [] }, noResolve);
    expect(r.fillPlayers).toBeUndefined();
    expect(r.conflict?.players).toEqual({ marketplace: ["Pete Alonso"], checklist: ["Kyle Schwarber"] });
  });

  test("a row with no players fills nothing", () => {
    const r = applyChecklistRow({ players: [], teams: [] }, { players: [], teams: [] }, noResolve);
    expect(r.fillPlayers).toBeUndefined();
  });
});

describe("checklistTeamTextNeedsResolving", () => {
  test("only a comma text needs resolving", () => {
    expect(checklistTeamTextNeedsResolving("A, B")).toBe(true);
    expect(checklistTeamTextNeedsResolving("Boston Red Sox")).toBe(false);
  });
});
