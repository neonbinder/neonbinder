/**
 * NEO-463 — the wizard's fragment step: a one-word player name that is a piece
 * of a fuller one on file ("Walker" when "Devin Walker" exists).
 *
 * The server decides (`players.nameFragmentCheck`); the step shows the fuller
 * names as `Link to …` choices and turns "Add as New Player" into "Add as a
 * one-name player", which records `oneNamePlayer: true` on the decision.
 *
 * Mocking follows `EntityReviewWizard.teamMatchSearch.test.tsx` (string-routed
 * `useQuery`, `EntityLinkSearch` stubbed).
 */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Id } from "../../convex/_generated/dataModel";

const SPORT_ID = "selopt-sport-baseball";

vi.mock("../../convex/_generated/api", () => ({
  api: {
    entityReviewQueue: {
      getBatch: "entityReviewQueue.getBatch",
      recordDecision: "entityReviewQueue.recordDecision",
      clearDecision: "entityReviewQueue.clearDecision",
      cancelBatch: "entityReviewQueue.cancelBatch",
      recordAllRemainingAsCreate: "entityReviewQueue.recordAllRemainingAsCreate",
      recordAllRemainingAsSkip: "entityReviewQueue.recordAllRemainingAsSkip",
      stageCareerTeamRows: "entityReviewQueue.stageCareerTeamRows",
      clearCareerTeamStint: "entityReviewQueue.clearCareerTeamStint",
      stageLeagueRows: "entityReviewQueue.stageLeagueRows",
    },
    players: {
      nearMatches: "players.nearMatches",
      nameFragmentCheck: "players.nameFragmentCheck",
      search: "players.search",
      getManyByIds: "players.getManyByIds",
    },
    teams: {
      nearMatches: "teams.nearMatches",
      pickerCandidates: "teams.pickerCandidates",
      getManyByIds: "teams.getManyByIds",
      resolveNames: "teams.resolveNames",
    },
    leagues: { list: "leagues.list" },
  },
}));

let currentRows: unknown;
let currentNearMatches: unknown;
let currentFragmentCheck: unknown;
let queryCalls: Array<{ ref: string; args: unknown }>;
const mockRecordDecision = vi.fn();

vi.mock("convex/react", () => ({
  useQuery: (ref: string, args: unknown) => {
    queryCalls.push({ ref, args });
    if (args === "skip") return undefined;
    if (ref === "entityReviewQueue.getBatch") return currentRows;
    if (ref === "players.nearMatches" || ref === "teams.nearMatches")
      return currentNearMatches;
    if (ref === "players.nameFragmentCheck") return currentFragmentCheck;
    if (ref === "leagues.list") return [];
    return undefined;
  },
  useMutation: (ref: string) => {
    if (ref === "entityReviewQueue.recordDecision") return mockRecordDecision;
    return vi.fn(() => Promise.resolve(undefined));
  },
  useAction: () => vi.fn(() => Promise.resolve({ decided: 0, hasMore: false, cursor: null })),
}));

vi.mock("./EntityLinkSearch", () => ({
  default: () => <div aria-label="Entity link search (stub)" />,
}));

import EntityReviewWizard from "./EntityReviewWizard";

let nextRowId = 0;
function makeRow(overrides: Record<string, unknown> = {}) {
  nextRowId += 1;
  return {
    _id: `row-${nextRowId}` as unknown as Id<"entityReviewQueue">,
    _creationTime: nextRowId,
    selectorOptionId: "selopt-1",
    batchId: "batch-1",
    kind: "player",
    name: "Walker",
    sportId: SPORT_ID,
    sportValue: "Baseball",
    status: "ready",
    ...overrides,
  };
}

function renderWizard() {
  return render(
    <EntityReviewWizard
      isOpen
      selectorOptionId={"selopt-1" as unknown as Id<"selectorOptions">}
      batchId="batch-1"
      summary={{ cardCount: 3, deleteCount: 0, reviewDecisionCount: 0 }}
      onConfirm={vi.fn()}
      onCancel={vi.fn()}
    />,
  );
}

const WALKER = {
  isFragment: true,
  matches: [
    { _id: "p-devin", name: "Devin Walker" },
    { _id: "p-larry", name: "Larry Walker" },
  ],
};
const QUESTION =
  "Just Walker? We've got Devin Walker and Larry Walker. Pick one, or add Walker as a one-name player.";

beforeEach(() => {
  vi.clearAllMocks();
  mockRecordDecision.mockResolvedValue(null);
  currentRows = [];
  currentNearMatches = [];
  currentFragmentCheck = undefined;
  queryCalls = [];
  nextRowId = 0;
});

describe("EntityReviewWizard — NEO-463 fragment step", () => {
  it("asks the check about the player row's own name, in its sport", () => {
    currentRows = [makeRow()];
    renderWizard();
    expect(
      queryCalls.some(
        (c) =>
          c.ref === "players.nameFragmentCheck" &&
          c.args !== "skip" &&
          (c.args as { name: string }).name === "Walker" &&
          (c.args as { sportId: string }).sportId === SPORT_ID,
      ),
    ).toBe(true);
  });

  it("shows the question with the fuller names as links, and relabels the primary", () => {
    currentRows = [makeRow()];
    currentFragmentCheck = WALKER;
    renderWizard();

    expect(screen.getByRole("group", { name: QUESTION })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Link to Devin Walker" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Link to Larry Walker" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add as a one-name player" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add as New Player" })).toBeNull();
  });

  it("is the ordinary New Player step for a name that is not a fragment", () => {
    currentRows = [makeRow({ name: "Ichiro" })];
    currentFragmentCheck = { isFragment: false, matches: [] };
    renderWizard();

    expect(screen.queryByRole("group", { name: /^Just Ichiro\?/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Add as New Player" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add as a one-name player" })).toBeNull();
  });

  it("'Add as a one-name player' records a create with oneNamePlayer: true", async () => {
    const row = makeRow();
    currentRows = [row];
    currentFragmentCheck = WALKER;
    renderWizard();

    fireEvent.click(screen.getByRole("button", { name: "Add as a one-name player" }));

    await waitFor(() =>
      expect(mockRecordDecision).toHaveBeenCalledWith(
        expect.objectContaining({
          reviewRowId: row._id,
          action: "create",
          oneNamePlayer: true,
        }),
      ),
    );
  });

  it("a plain create on a non-fragment never sends oneNamePlayer", async () => {
    const row = makeRow({ name: "Ichiro" });
    currentRows = [row];
    currentFragmentCheck = { isFragment: false, matches: [] };
    renderWizard();

    fireEvent.click(screen.getByRole("button", { name: "Add as New Player" }));

    await waitFor(() => expect(mockRecordDecision).toHaveBeenCalled());
    expect(mockRecordDecision.mock.calls[0][0]).not.toHaveProperty("oneNamePlayer");
  });

  it("a fuller-name choice links the row to that player", async () => {
    const row = makeRow();
    currentRows = [row];
    currentFragmentCheck = WALKER;
    renderWizard();

    fireEvent.click(screen.getByRole("button", { name: "Link to Larry Walker" }));

    await waitFor(() =>
      expect(mockRecordDecision).toHaveBeenCalledWith(
        expect.objectContaining({
          reviewRowId: row._id,
          action: "link",
          linkedPlayerId: "p-larry",
        }),
      ),
    );
  });

  it("never lists a fuller name twice: Possible matches drops what the question owns", () => {
    currentRows = [makeRow()];
    currentFragmentCheck = WALKER;
    currentNearMatches = [
      { _id: "p-larry", name: "Larry Walker", confidence: "close" },
      { _id: "p-walken", name: "Walken", confidence: "close" },
    ];
    renderWizard();

    expect(screen.getAllByRole("button", { name: "Link to Larry Walker" })).toHaveLength(1);
    // A close spelling the question does not own stays in its own list.
    expect(screen.getByRole("button", { name: "Link to Walken" })).toBeTruthy();
  });

  it("moves focus to the question when the answer relabels a focused primary", () => {
    currentRows = [makeRow()];
    currentFragmentCheck = undefined;
    const { rerender } = renderWizard();

    const primary = screen.getByRole("button", { name: "Add as New Player" });
    act(() => primary.focus());
    expect(document.activeElement).toBe(primary);

    currentFragmentCheck = WALKER;
    rerender(
      <EntityReviewWizard
        isOpen
        selectorOptionId={"selopt-1" as unknown as Id<"selectorOptions">}
        batchId="batch-1"
        summary={{ cardCount: 3, deleteCount: 0, reviewDecisionCount: 0 }}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(document.activeElement).toBe(screen.getByRole("group", { name: QUESTION }));
    // The focused panel's name says it; the live region stays quiet so the
    // sentence is not read twice.
    expect(
      screen.getAllByRole("status").some((el) => el.textContent === QUESTION),
    ).toBe(false);
  });

  it("announces the question in an already-mounted live region when focus is elsewhere", () => {
    currentRows = [makeRow()];
    currentFragmentCheck = undefined;
    const { rerender } = renderWizard();

    // The region is on screen, empty, before the answer lands.
    const before = screen.getAllByRole("status");
    expect(before.some((el) => el.textContent === QUESTION)).toBe(false);

    currentFragmentCheck = WALKER;
    rerender(
      <EntityReviewWizard
        isOpen
        selectorOptionId={"selopt-1" as unknown as Id<"selectorOptions">}
        batchId="batch-1"
        summary={{ cardCount: 3, deleteCount: 0, reviewDecisionCount: 0 }}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const region = screen
      .getAllByRole("status")
      .find((el) => el.textContent === QUESTION);
    expect(region).toBeTruthy();
    expect(region!.getAttribute("aria-live")).toBe("polite");
    // The same node that was mounted empty, not one inserted with its text.
    expect(before).toContain(region);
    // Focus stayed where the operator had it.
    expect(document.activeElement).not.toBe(
      screen.getByRole("group", { name: QUESTION }),
    );
  });

  it("a truncated read asks for the whole name, with no choices, and keeps the one-name primary", () => {
    currentRows = [makeRow()];
    currentFragmentCheck = { isFragment: true, truncated: true, matches: [] };
    currentNearMatches = [];
    renderWizard();

    expect(
      screen.getByRole("group", {
        name: "Just Walker? That's part of a fuller name we've got. Type the whole name to find them, or add Walker as a one-name player.",
      }),
    ).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Fuller names for Walker" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Link to .*Walker/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Add as a one-name player" })).toBeTruthy();
  });

  it("a truncated read that found no clash is the ordinary New Player step", () => {
    currentRows = [makeRow({ name: "Smith" })];
    currentFragmentCheck = { isFragment: false, truncated: true, matches: [] };
    renderWizard();

    expect(screen.queryByRole("group", { name: /^Just Smith\?/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Add as New Player" })).toBeTruthy();
  });
});
