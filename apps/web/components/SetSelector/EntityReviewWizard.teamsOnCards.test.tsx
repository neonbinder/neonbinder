/**
 * NEO-335 — "K cards have no team yet" on the wizard's final step.
 *
 * Pins the contract the coordinator and the E2E flows rely on:
 *  - absent at K = 0 (and the parent still hears an all-empty answer list, so
 *    a stale answer cannot outlive the card it was given for);
 *  - present at K > 0, BELOW the unchanged "All reviewed — save N cards?";
 *  - Confirm & Save is never gated by it;
 *  - pre-fills are visible and checked, ties are not, and a pick reaches the
 *    parent as a positional answer;
 *  - radio-group keyboard semantics.
 *
 * The pure decisions are in teams-on-cards.test.tsx; this file is the wiring.
 */

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Id } from "../../convex/_generated/dataModel";

/** Every `api.module.fn` is the string "module.fn" — routing is by string. */
vi.mock("../../convex/_generated/api", () => {
  const moduleProxy = (mod: string) =>
    new Proxy({}, { get: (_t, fn) => `${mod}.${String(fn)}` });
  return { api: new Proxy({}, { get: (_t, mod) => moduleProxy(String(mod)) }) };
});

let currentRows: unknown;
type SuggestionArgs = {
  selectorOptionId?: string;
  players: Array<{ playerId?: string; name?: string }>;
};
let serverAnswer: (player: { playerId?: string; name?: string }) => unknown;
let suggestionCalls: SuggestionArgs[];
/** Every getBatch subscription the wizard asked for (not skipped). */
let batchReads: number;
const mockCancelBatch = vi.fn(() => Promise.resolve(null));

vi.mock("convex/react", () => ({
  useQuery: (ref: string, args: unknown) => {
    if (args === "skip") return undefined;
    if (ref === "entityReviewQueue.getBatch") {
      batchReads += 1;
      return currentRows;
    }
    return undefined;
  },
  useQueries: (queries: Record<string, { query: string; args: SuggestionArgs }>) => {
    const out: Record<string, unknown> = {};
    for (const [key, { query, args }] of Object.entries(queries)) {
      expect(query).toBe("cardChecklist.teamSuggestionsForPreview");
      suggestionCalls.push(args);
      out[key] = { setYear: 1985, players: args.players.map((p) => serverAnswer(p)) };
    }
    return out;
  },
  useMutation: (ref: string) =>
    ref === "entityReviewQueue.cancelBatch"
      ? mockCancelBatch
      : vi.fn(() => Promise.resolve(undefined)),
  useAction: () => vi.fn(() => Promise.resolve(undefined)),
}));

vi.mock("./EntityLinkSearch", () => ({ default: () => null }));

import EntityReviewWizard from "./EntityReviewWizard";

const CONFIRM_SAVE_NAME = "Confirm & Save (Enter) — commit this review";
const CANCEL_NAME = "Cancel (Esc) — leave without committing";
const REDS = "team_reds" as Id<"teams">;
const YANKEES = "team_yankees" as Id<"teams">;

let rowId = 0;
function row(overrides: Record<string, unknown>) {
  rowId += 1;
  return {
    _id: `row-${rowId}`,
    _creationTime: rowId,
    selectorOptionId: "selopt-1",
    batchId: "batch-1",
    kind: "player",
    name: "Rookie Guy",
    sportId: "sport-1",
    sportValue: "Baseball",
    setSportId: "sport-1",
    setSportValue: "Baseball",
    status: "ready",
    ...overrides,
  };
}

type Card = { cardNumber: string; cardName: string; players?: string[]; teams?: string[] };

function renderWizard(previewCards: Card[], extra: Record<string, unknown> = {}) {
  const onConfirm = vi.fn();
  const onTeamAnswersChange = vi.fn();
  const utils = render(
    <EntityReviewWizard
      isOpen
      selectorOptionId={"selopt-1" as unknown as Id<"selectorOptions">}
      batchId="batch-1"
      summary={{ cardCount: previewCards.length, deleteCount: 0, reviewDecisionCount: 0 }}
      onConfirm={onConfirm}
      onCancel={vi.fn()}
      previewCards={previewCards}
      onTeamAnswersChange={onTeamAnswersChange}
      {...extra}
    />,
  );
  return { ...utils, onConfirm, onTeamAnswersChange };
}

const lastAnswers = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls.at(-1)?.[0];

beforeEach(() => {
  rowId = 0;
  suggestionCalls = [];
  batchReads = 0;
  mockCancelBatch.mockClear();
  serverAnswer = () => ({ playerId: null, answer: null, candidates: [] });
  // One created player whose only career team is a team staged in this batch.
  currentRows = [
    row({
      kind: "team",
      name: "Reds",
      enrichment: { colors: { primary: "#C6011F" } },
      decision: { action: "create", create: { location: "Cincinnati", name: "Reds" } },
    }),
    row({
      name: "Rookie Guy",
      enrichment: { careerTeams: [{ name: "Reds", fromYear: 1984 }] },
      decision: { action: "create" },
    }),
  ];
});

describe("TeamsOnCardsSection in the wizard's final step", () => {
  it("is absent when every card will save with a team, and Confirm & Save is there", () => {
    const { onTeamAnswersChange } = renderWizard([
      { cardNumber: "1", cardName: "Rookie Card", players: ["Rookie Guy"], teams: ["Reds"] },
    ]);
    expect(screen.getByText("All reviewed — save 1 card?")).toBeTruthy();
    expect(screen.queryByText(/no team yet/)).toBeNull();
    expect(screen.getByRole("button", { name: CONFIRM_SAVE_NAME })).toBeTruthy();
    // Nothing to ask, nothing to apply — and the parent is told so.
    expect(lastAnswers(onTeamAnswersChange)).toEqual([undefined]);
    expect(suggestionCalls).toEqual([]);
  });

  it("is absent when the node's set-level team covers every new card", () => {
    renderWizard([{ cardNumber: "1", cardName: "Card", players: ["Johnny Bench"] }], {
      cardsInheritSetTeam: true,
    });
    expect(screen.queryByText(/no team yet/)).toBeNull();
    expect(suggestionCalls).toEqual([]);
  });

  it("is present at K > 0, below the unchanged heading, and never gates Confirm & Save", () => {
    const { onConfirm } = renderWizard([
      { cardNumber: "1", cardName: "Rookie Card", players: ["Rookie Guy"] },
      { cardNumber: "2", cardName: "Base", players: ["Johnny Bench"] },
      { cardNumber: "3", cardName: "Team", players: ["Pete Rose"], teams: ["Reds"] },
    ]);
    const heading = screen.getByRole("heading", { name: "2 cards have no team yet" });
    const allReviewed = screen.getByText("All reviewed — save 3 cards?");
    // DOCUMENT_POSITION_FOLLOWING: the section comes after the existing line.
    expect(allReviewed.compareDocumentPosition(heading) & 4).toBe(4);

    const confirm = screen.getByRole("button", { name: CONFIRM_SAVE_NAME });
    expect(confirm.getAttribute("aria-disabled")).toBeNull();
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("pre-fills a single answer (staged team, composed name) and reports it positionally", () => {
    const { onTeamAnswersChange } = renderWizard([
      { cardNumber: "1", cardName: "Rookie Card", players: ["Rookie Guy"] },
      { cardNumber: "2", cardName: "Team", players: ["Pete Rose"], teams: ["Reds"] },
    ]);
    const group = screen.getByRole("radiogroup", { name: "Team for Rookie Guy" });
    const reds = within(group).getByRole("radio", { name: "Cincinnati Reds — Rookie Guy" });
    expect(reds.getAttribute("aria-checked")).toBe("true");
    // The review row's own name is what the commit's decision map is keyed on.
    expect(lastAnswers(onTeamAnswersChange)).toEqual([{ teams: ["Reds"] }, undefined]);
  });

  it("asks the server about known players; a tie stays unselected and defaults to later", () => {
    serverAnswer = (p) =>
      p.name === "Johnny Bench"
        ? {
            playerId: "player_bench",
            answer: null,
            candidates: [
              { teamId: REDS, name: "Cincinnati Reds" },
              { teamId: YANKEES, name: "New York Yankees" },
            ],
          }
        : { playerId: null, answer: null, candidates: [] };
    const { onTeamAnswersChange } = renderWizard([
      { cardNumber: "7", cardName: "Base", players: ["Johnny Bench"] },
      { cardNumber: "8", cardName: "Highlights", players: ["Johnny Bench"] },
    ]);
    // Asked by name, once, however many cards carry him.
    expect(suggestionCalls.at(-1)).toEqual({
      selectorOptionId: "selopt-1",
      players: [{ name: "Johnny Bench" }],
    });

    const group = screen.getByRole("radiogroup", { name: "Team for Johnny Bench, 2 cards" });
    const radios = within(group).getAllByRole("radio");
    expect(radios.map((r) => r.getAttribute("aria-checked"))).toEqual([
      "false",
      "false",
      "false",
      "true",
    ]);
    expect(within(group).getByRole("radio", { name: "Leave for later — Johnny Bench, 2 cards" }))
      .toBeTruthy();
    expect(lastAnswers(onTeamAnswersChange)).toEqual([undefined, undefined]);

    // One press answers the whole collapsed line.
    fireEvent.click(
      within(group).getByRole("radio", { name: "New York Yankees — Johnny Bench, 2 cards" }),
    );
    expect(lastAnswers(onTeamAnswersChange)).toEqual([
      { teamIds: [YANKEES] },
      { teamIds: [YANKEES] },
    ]);
  });

  it("No team on this card answers teamNone", () => {
    const { onTeamAnswersChange } = renderWizard([
      { cardNumber: "1", cardName: "Checklist", players: [] },
    ]);
    fireEvent.click(screen.getByRole("radio", { name: "No team on this card — #1 Checklist" }));
    expect(lastAnswers(onTeamAnswersChange)).toEqual([{ teamNone: true }]);
  });

  it("is a radio group: one Tab stop, arrows move the selection, Enter chooses without saving", () => {
    const { onConfirm, onTeamAnswersChange } = renderWizard([
      { cardNumber: "1", cardName: "Rookie Card", players: ["Rookie Guy"] },
    ]);
    const group = screen.getByRole("radiogroup", { name: "Team for Rookie Guy" });
    const radios = within(group).getAllByRole("radio");
    expect(radios.map((r) => r.tabIndex)).toEqual([0, -1, -1]);

    fireEvent.keyDown(radios[0], { key: "ArrowRight" });
    expect(lastAnswers(onTeamAnswersChange)).toEqual([{ teamNone: true }]);
    expect(document.activeElement).toBe(within(group).getAllByRole("radio")[1]);

    fireEvent.keyDown(within(group).getAllByRole("radio")[2], { key: "Enter" });
    expect(lastAnswers(onTeamAnswersChange)).toEqual([undefined]);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("holds still while saving", () => {
    const { onTeamAnswersChange } = renderWizard(
      [{ cardNumber: "1", cardName: "Rookie Card", players: ["Rookie Guy"] }],
      { saving: true },
    );
    const before = onTeamAnswersChange.mock.calls.length;
    const none = screen.getByRole("radio", { name: "No team on this card — Rookie Guy" });
    expect(none.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(none);
    expect(onTeamAnswersChange.mock.calls.length).toBe(before);
  });

  it("without preview cards the final step is exactly as before", () => {
    render(
      <EntityReviewWizard
        isOpen
        selectorOptionId={"selopt-1" as unknown as Id<"selectorOptions">}
        batchId="batch-1"
        summary={{ cardCount: 1, deleteCount: 0, reviewDecisionCount: 0 }}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText("All reviewed — save 1 card?")).toBeTruthy();
    expect(screen.queryByText(/no team yet/)).toBeNull();
    expect(screen.queryAllByRole("radiogroup")).toEqual([]);
  });
});

/**
 * NEO-335 — no names to review, but cards that would save with no team: the
 * wizard opens straight onto its final step and reads no batch.
 */
describe("EntityReviewWizard teams-only", () => {
  function renderTeamsOnly(previewCards: Card[], batchId = "") {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const onTeamAnswersChange = vi.fn();
    render(
      <EntityReviewWizard
        isOpen
        teamsOnly
        selectorOptionId={"selopt-1" as unknown as Id<"selectorOptions">}
        batchId={batchId}
        summary={{ cardCount: previewCards.length, deleteCount: 0, reviewDecisionCount: 0 }}
        onConfirm={onConfirm}
        onCancel={onCancel}
        previewCards={previewCards}
        onTeamAnswersChange={onTeamAnswersChange}
      />,
    );
    return { onConfirm, onCancel, onTeamAnswersChange };
  }

  it("opens on the final step with the section, reads no batch, and says nothing about names", () => {
    serverAnswer = () => ({
      playerId: "p",
      answer: { tier: "sameNode", teams: [{ teamId: REDS, name: "Cincinnati Reds" }] },
      candidates: [],
    });
    const { onConfirm, onTeamAnswersChange } = renderTeamsOnly([
      { cardNumber: "1", cardName: "Base", players: ["Johnny Bench"] },
      { cardNumber: "2", cardName: "Base", players: ["Pete Rose"], teams: ["Reds"] },
    ]);
    expect(batchReads).toBe(0);
    expect(screen.getByText("All reviewed — save 2 cards?")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "1 card has no team yet" })).toBeTruthy();
    expect(screen.queryByText(/reviewed$/)).toBeNull();
    expect(screen.queryByText(/0 of 0/)).toBeNull();
    expect(lastAnswers(onTeamAnswersChange)).toEqual([{ teamIds: [REDS] }, undefined]);

    const confirm = screen.getByRole("button", { name: CONFIRM_SAVE_NAME });
    expect(document.activeElement).toBe(confirm);
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("Cancel with no batch closes without asking the server", async () => {
    const { onCancel } = renderTeamsOnly([
      { cardNumber: "1", cardName: "Base", players: ["Johnny Bench"] },
    ]);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: CANCEL_NAME }));
    });
    expect(mockCancelBatch).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("Cancel with a batch left open still discards it", async () => {
    const { onCancel } = renderTeamsOnly(
      [{ cardNumber: "1", cardName: "Base", players: ["Johnny Bench"] }],
      "batch-open",
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: CANCEL_NAME }));
    });
    expect(mockCancelBatch).toHaveBeenCalledWith({
      selectorOptionId: "selopt-1",
      batchId: "batch-open",
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

// Keep React in scope for the JSX transform this project's tests use.
void React;
