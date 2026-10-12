/**
 * NEO-335 — the cards that would save with no team, on the wizard's teams
 * step (Phase 2: its own step, before Save).
 *
 * Pins the contract the coordinator and the E2E flows rely on:
 *  - no teams step at K = 0 — the wizard goes straight to "Save N cards?" (and
 *    the parent still hears an all-empty answer list, so a stale answer
 *    cannot outlive the card it was given for);
 *  - at K > 0, a "Cards with no team" step with its intro line, then Save;
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
/** While true, every suggestion query is still loading (answers undefined). */
let suggestionsPending: boolean;
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
      out[key] = suggestionsPending
        ? undefined
        : { setYear: 1985, players: args.players.map((p) => serverAnswer(p)) };
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
const NEXT_NAME = "Next (Enter)";
const TEAMS_INTRO = "Pick a team for each card, or leave it for later.";
/** The header's one counter. */
const counter = () =>
  screen
    .getAllByRole("status")
    .map((el) => el.textContent ?? "")
    .find((t) => /^Step \d+ of \d+$/.test(t));
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
  suggestionsPending = false;
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

describe("TeamsOnCardsSection on the wizard's teams step", () => {
  it("is absent when every card will save with a team: no teams step, straight to Save", () => {
    const { onTeamAnswersChange } = renderWizard([
      { cardNumber: "1", cardName: "Rookie Card", players: ["Rookie Guy"], teams: ["Reds"] },
    ]);
    expect(screen.getByText("Save 1 card?")).toBeTruthy();
    // Two names + Save — no teams step was ever counted.
    expect(counter()).toBe("Step 3 of 3");
    expect(screen.getByText("Ready to save")).toBeTruthy();
    expect(screen.queryByText(TEAMS_INTRO)).toBeNull();
    expect(screen.queryByText(/no team yet/)).toBeNull();
    expect(screen.getByRole("button", { name: CONFIRM_SAVE_NAME })).toBeTruthy();
    // Nothing to ask, nothing to apply — and the parent is told so.
    expect(lastAnswers(onTeamAnswersChange)).toEqual([undefined]);
    expect(suggestionCalls).toEqual([]);
  });

  it("is absent when the parent marks every teamless card settled (a set-level team covering a new card)", () => {
    renderWizard([{ cardNumber: "1", cardName: "Card", players: ["Johnny Bench"] }], {
      cardsWithSettledTeam: [0],
    });
    expect(screen.queryByText(/no team yet/)).toBeNull();
    expect(suggestionCalls).toEqual([]);
  });

  it("is its own step at K > 0, before Save, and never gates Confirm & Save", () => {
    const { onConfirm } = renderWizard([
      { cardNumber: "1", cardName: "Rookie Card", players: ["Rookie Guy"] },
      { cardNumber: "2", cardName: "Base", players: ["Johnny Bench"] },
      { cardNumber: "3", cardName: "Team", players: ["Pete Rose"], teams: ["Reds"] },
    ]);
    // Two names, the teams step, Save.
    expect(counter()).toBe("Step 3 of 4");
    expect(screen.getByText("Cards with no team")).toBeTruthy();
    const intro = screen.getByText(TEAMS_INTRO);
    const group = screen.getByRole("radiogroup", { name: "Team for Rookie Guy" });
    // DOCUMENT_POSITION_FOLLOWING: the lines come after the intro.
    expect(intro.compareDocumentPosition(group) & 4).toBe(4);
    // Not on Save yet: no Save heading, no Confirm. Next has the focus.
    expect(screen.queryByText("Save 3 cards?")).toBeNull();
    expect(screen.queryByRole("button", { name: CONFIRM_SAVE_NAME })).toBeNull();
    const next = screen.getByRole("button", { name: NEXT_NAME });
    expect(document.activeElement).toBe(next);

    // Nothing answered — every line left for later — and Save is still one
    // press away.
    fireEvent.click(next);
    expect(counter()).toBe("Step 4 of 4");
    expect(screen.getByText("Save 3 cards?")).toBeTruthy();
    expect(screen.getByText("Ready to save")).toBeTruthy();
    // The lines are hidden on Save, not unmounted (they keep reporting).
    expect(screen.queryByRole("radiogroup", { name: "Team for Rookie Guy" })).toBeNull();

    const confirm = screen.getByRole("button", { name: CONFIRM_SAVE_NAME });
    expect(document.activeElement).toBe(confirm);
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
    fireEvent.click(screen.getByRole("radio", { name: "No team on this card — Cards with no players (1)" }));
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

  it("says loading ONCE for the section, marks the waiting line busy, then says suggestions arrived", () => {
    suggestionsPending = true;
    const cards = [
      { cardNumber: "1", cardName: "Base", players: ["Johnny Bench"] },
      { cardNumber: "2", cardName: "Base", players: ["Pete Rose"] },
    ];
    const { rerender } = renderWizard(cards);
    const statuses = () =>
      screen.getAllByRole("status").map((el) => el.textContent ?? "");
    // One line for the section — never one per player set.
    expect(statuses().filter((t) => t === "Checking teams…")).toHaveLength(1);
    expect(
      screen.getByRole("radiogroup", { name: "Team for Johnny Bench" }).getAttribute("aria-busy"),
    ).toBe("true");

    suggestionsPending = false;
    rerender(
      <EntityReviewWizard
        isOpen
        selectorOptionId={"selopt-1" as unknown as Id<"selectorOptions">}
        batchId="batch-1"
        summary={{ cardCount: 2, deleteCount: 0, reviewDecisionCount: 0 }}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        previewCards={cards}
        onTeamAnswersChange={vi.fn()}
      />,
    );
    expect(statuses()).toContain("Teams suggested");
    expect(statuses()).not.toContain("Checking teams…");
    expect(
      screen.getByRole("radiogroup", { name: "Team for Johnny Bench" }).getAttribute("aria-busy"),
    ).toBeNull();
  });

  it("says nothing about loading when no server suggestion was needed", () => {
    renderWizard([{ cardNumber: "1", cardName: "Rookie Card", players: ["Rookie Guy"] }]);
    const statuses = screen.getAllByRole("status").map((el) => el.textContent ?? "");
    expect(statuses).not.toContain("Checking teams…");
    expect(statuses).not.toContain("Teams suggested");
  });

  it("Next is described by the step's intro; Confirm & Save keeps its name and no description", () => {
    renderWizard([{ cardNumber: "1", cardName: "Rookie Card", players: ["Rookie Guy"] }]);
    const intro = screen.getByText(TEAMS_INTRO);
    const next = screen.getByRole("button", { name: NEXT_NAME });
    expect(intro.id).not.toBe("");
    expect(next.getAttribute("aria-describedby")).toBe(intro.id);

    fireEvent.click(next);
    const confirm = screen.getByRole("button", { name: CONFIRM_SAVE_NAME });
    expect(confirm.getAttribute("aria-describedby")).toBeNull();
  });

  it("keeps an answer through Save and Back", () => {
    const { onTeamAnswersChange } = renderWizard([
      { cardNumber: "1", cardName: "Checklist", players: [] },
    ]);
    fireEvent.click(screen.getByRole("radio", { name: "No team on this card — Cards with no players (1)" }));
    expect(lastAnswers(onTeamAnswersChange)).toEqual([{ teamNone: true }]);

    fireEvent.click(screen.getByRole("button", { name: NEXT_NAME }));
    expect(screen.getByText("Save 1 card?")).toBeTruthy();
    // Back from Save is the teams step, answer intact.
    fireEvent.click(screen.getByRole("button", { name: "Back to previous step" }));
    expect(counter()).toBe("Step 3 of 4");
    expect(
      screen
        .getByRole("radio", { name: "No team on this card — Cards with no players (1)" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(lastAnswers(onTeamAnswersChange)).toEqual([{ teamNone: true }]);

    // Both names were decided before this sitting, so — as on the names'
    // own steps — there is no "previous decision" for Back to return to.
    expect(screen.queryByRole("button", { name: "Back to previous step" })).toBeNull();
  });

  it("Enter on Next steps to Save; an auto-repeated Enter on Confirm & Save does not commit", () => {
    const { onConfirm } = renderWizard([
      { cardNumber: "1", cardName: "Rookie Card", players: ["Rookie Guy"] },
    ]);
    fireEvent.keyDown(screen.getByRole("button", { name: NEXT_NAME }), { key: "Enter" });
    const confirm = screen.getByRole("button", { name: CONFIRM_SAVE_NAME });
    expect(document.activeElement).toBe(confirm);
    fireEvent.keyDown(confirm, { key: "Enter", repeat: true });
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.keyDown(confirm, { key: "Enter" });
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("Confirm & Save carries no description when the section is not shown", () => {
    renderWizard([
      { cardNumber: "1", cardName: "Rookie Card", players: ["Rookie Guy"], teams: ["Reds"] },
    ]);
    const confirm = screen.getByRole("button", { name: CONFIRM_SAVE_NAME });
    expect(confirm.getAttribute("aria-describedby")).toBeNull();
  });

  // NEO-335 Phase 2 (unit C): the section's own "K cards have no team yet"
  // heading is gone — no per-type counts anywhere. The wizard draws the
  // step's subtitle and intro line; the section draws only the lines.
  it("the section draws no count heading of its own; the intro line is the wizard's, once", () => {
    renderWizard([{ cardNumber: "1", cardName: "Rookie Card", players: ["Rookie Guy"] }]);
    expect(screen.queryByText(/no team yet/)).toBeNull();
    expect(screen.getAllByText("Pick a team for each card, or leave it for later.")).toHaveLength(1);
  });

  it("a long owner line wraps rather than truncating behind a mouse-only title", () => {
    renderWizard([
      {
        cardNumber: "1",
        cardName: "Father and Son",
        players: ["Ken Griffey Jr.", "Ken Griffey Sr."],
      },
    ]);
    const owner = screen.getByText("Ken Griffey Jr. & Ken Griffey Sr.");
    expect(owner.className).toContain("break-words");
    expect(owner.className).not.toContain("truncate");
    expect(owner.getAttribute("title")).toBeNull();
  });

  it("without preview cards there is no teams step: the names, then Save", () => {
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
    expect(screen.getByText("Save 1 card?")).toBeTruthy();
    expect(counter()).toBe("Step 3 of 3");
    expect(screen.queryByText(/no team yet/)).toBeNull();
    expect(screen.queryAllByRole("radiogroup")).toEqual([]);
  });
});

/**
 * NEO-335 — no names to review, but cards that would save with no team: the
 * wizard opens straight onto its teams step ("Step 1 of 2", then Save) and
 * reads no batch.
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

  it("opens on the teams step as Step 1 of 2, reads no batch, and says nothing about names", () => {
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
    expect(screen.getByRole("dialog", { name: "Tidy up this set" })).toBeTruthy();
    expect(counter()).toBe("Step 1 of 2");
    expect(screen.getByText("Cards with no team")).toBeTruthy();
    expect(screen.getByText(TEAMS_INTRO)).toBeTruthy();
    expect(screen.getByRole("radiogroup", { name: "Team for Johnny Bench" })).toBeTruthy();
    expect(screen.queryByText(/reviewed$/)).toBeNull();
    expect(screen.queryByText(/0 of 0/)).toBeNull();
    expect(lastAnswers(onTeamAnswersChange)).toEqual([{ teamIds: [REDS] }, undefined]);
    // No name was decided, so there is nowhere for Back to go.
    expect(screen.queryByRole("button", { name: "Back to previous step" })).toBeNull();

    const next = screen.getByRole("button", { name: NEXT_NAME });
    expect(document.activeElement).toBe(next);
    fireEvent.click(next);
    expect(counter()).toBe("Step 2 of 2");
    expect(screen.getByText("Save 2 cards?")).toBeTruthy();
    expect(screen.getByText("Ready to save")).toBeTruthy();
    // The answer outlives the move to Save.
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
