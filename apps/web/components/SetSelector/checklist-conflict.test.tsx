/**
 * NEO-478 — the pure helpers behind the "Checklist says otherwise" step.
 * `.test.tsx` because `.test.ts` is not collected under components/ (see
 * vitest.include.mjs).
 */
import { describe, expect, it } from "vitest";
import {
  applyChecklistChoice,
  checklistConflictIndexes,
  hasChecklistConflict,
  orphanedReviewRowIds,
  sideText,
  type ChecklistConflictCard,
} from "./checklist-conflict";

const norm = (n: string) => n.trim().toLowerCase();

const base = (over: Partial<ChecklistConflictCard> = {}): ChecklistConflictCard => ({
  cardNumber: "60",
  cardName: "Rhett Lowder",
  players: ["Rhett Lowder"],
  teams: ["Reds"],
  ...over,
});

describe("hasChecklistConflict / checklistConflictIndexes", () => {
  it("is false with no conflict and with an empty conflict object", () => {
    expect(hasChecklistConflict({})).toBe(false);
    expect(hasChecklistConflict({ checklistConflict: {} })).toBe(false);
  });

  it("is true for a players-only or teams-only conflict", () => {
    const sides = { marketplace: ["a"], checklist: ["b"] };
    expect(hasChecklistConflict({ checklistConflict: { players: sides } })).toBe(true);
    expect(hasChecklistConflict({ checklistConflict: { teams: sides } })).toBe(true);
  });

  it("lists the positions of cards that carry one, in order", () => {
    const sides = { marketplace: ["a"], checklist: ["b"] };
    expect(
      checklistConflictIndexes([
        {},
        { checklistConflict: { teams: sides } },
        { checklistConflict: {} },
        { checklistConflict: { players: sides } },
      ]),
    ).toEqual([1, 3]);
  });
});

describe("applyChecklistChoice", () => {
  const conflict = {
    players: { marketplace: ["Rhett Lowder"], checklist: ["Rhett Loder"] },
    teams: { marketplace: ["Reds"], checklist: ["Cincinnati Reds"] },
  };

  it("the checklist's side: players, teams, a checklist stamp, and no conflict left", () => {
    const out = applyChecklistChoice(base({ checklistConflict: conflict }), "checklist");
    expect(out.players).toEqual(["Rhett Loder"]);
    expect(out.teams).toEqual(["Cincinnati Reds"]);
    expect(out.teamLookup).toBe("checklist");
    expect("checklistConflict" in out).toBe(false);
  });

  it("the marketplace's side: its players and teams, stamped as the lookup's answer", () => {
    const out = applyChecklistChoice(base({ checklistConflict: conflict }), "marketplace");
    expect(out.players).toEqual(["Rhett Lowder"]);
    expect(out.teams).toEqual(["Reds"]);
    expect(out.teamLookup).toBe("answered");
    expect("checklistConflict" in out).toBe(false);
  });

  it("renames a one-player card whose name WAS the losing player, and only then", () => {
    const renamed = applyChecklistChoice(base({ checklistConflict: conflict }), "checklist");
    expect(renamed.cardName).toBe("Rhett Loder");
    const other = applyChecklistChoice(
      base({ cardName: "Future Stars", checklistConflict: conflict }),
      "checklist",
    );
    expect(other.cardName).toBe("Future Stars");
  });

  it("does not rename a multi-player card", () => {
    const out = applyChecklistChoice(
      base({
        cardName: "A",
        checklistConflict: { players: { marketplace: ["A"], checklist: ["A", "B"] } },
      }),
      "checklist",
    );
    expect(out.players).toEqual(["A", "B"]);
    expect(out.cardName).toBe("A");
  });

  it("a players-only conflict leaves teams and teamLookup alone", () => {
    const out = applyChecklistChoice(
      base({
        teams: ["Reds"],
        teamLookup: "failed",
        checklistConflict: { players: conflict.players },
      }),
      "checklist",
    );
    expect(out.teams).toEqual(["Reds"]);
    expect(out.teamLookup).toBe("failed");
  });

  it("never mutates its input and copies the arrays it hands on", () => {
    const input = base({ checklistConflict: conflict });
    const out = applyChecklistChoice(input, "checklist");
    expect(input.checklistConflict).toBe(conflict);
    expect(input.players).toEqual(["Rhett Lowder"]);
    expect(out.players).not.toBe(conflict.players.checklist);
  });

  it("an empty chosen side is applied as empty, not skipped", () => {
    const out = applyChecklistChoice(
      base({ checklistConflict: { teams: { marketplace: ["Reds"], checklist: [] } } }),
      "checklist",
    );
    expect(out.teams).toEqual([]);
    expect(out.teamLookup).toBe("checklist");
  });

  it("a card with nothing to settle comes back as it is", () => {
    const input = base();
    expect(applyChecklistChoice(input, "checklist")).toEqual(input);
  });
});

describe("sideText", () => {
  it("names nobody, one, two and three", () => {
    expect(sideText([], "Nobody listed")).toBe("Nobody listed");
    expect(sideText(["A"], "x")).toBe("A");
    expect(sideText(["A", "B"], "x")).toBe("A and B");
    expect(sideText(["A", "B", "C"], "x")).toBe("A, B and C");
  });
});

describe("orphanedReviewRowIds", () => {
  const cards: ChecklistConflictCard[] = [
    base({
      checklistConflict: { players: { marketplace: ["Rhett Lowder"], checklist: ["Rhett Loder"] } },
    }),
  ];
  const rows = [
    { _id: "lowder", kind: "player" as const, name: "Rhett Lowder" },
    { _id: "loder", kind: "player" as const, name: "Rhett Loder" },
    { _id: "loderTeam", kind: "team" as const, name: "Some Team", source: { kind: "careerTeamOf" as const, playerRowId: "loder" } },
  ];

  it("while unanswered, neither contested name is carried yet, so both rows are named", () => {
    // Pins the documented "not counting a field still in dispute" rule: the
    // wizard applies the answer before it leaves rows out of the walk.
    const out = orphanedReviewRowIds(rows, cards, {}, norm);
    expect(out.has("lowder")).toBe(true);
    expect(out.has("loder")).toBe(true);
  });

  it("drops the turned-down side's row and the steps staged for it", () => {
    const out = orphanedReviewRowIds(rows, cards, { 0: "checklist" }, norm);
    expect([...out].sort()).toEqual(["lowder"]);
    const other = orphanedReviewRowIds(rows, cards, { 0: "marketplace" }, norm);
    expect([...other].sort()).toEqual(["loder", "loderTeam"]);
  });

  it("keeps a name the rest of the set also carries", () => {
    const both = [...cards, base({ cardNumber: "61", players: ["Rhett Lowder"] })];
    const out = orphanedReviewRowIds(rows, both, { 0: "checklist" }, norm);
    expect(out.has("lowder")).toBe(false);
  });

  it("returns nothing when no card carries a conflict", () => {
    expect(orphanedReviewRowIds(rows, [base()], {}, norm).size).toBe(0);
  });
});
