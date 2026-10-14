/**
 * NEO-345 — the wizard's "Autographed cards" step: how a leaf's autographs
 * are signed, asked when a card the save will CREATE carries "AU" and the
 * leaf has no format. Between teams and titles, counted in "Step x of y",
 * and REQUIRED: nothing after it is reachable until it is answered.
 *
 * The pure rules are pinned in entity-review-steps.test.tsx and the step's
 * own keyboard model in AutographFormatStep.test.tsx; this file is the
 * wiring. The harness is EntityReviewWizard.steps.test.tsx's.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Id } from "../../convex/_generated/dataModel";

vi.mock("../../convex/_generated/api", () => {
  const moduleProxy = (mod: string) =>
    new Proxy({}, { get: (_t, fn) => `${mod}.${String(fn)}` });
  return { api: new Proxy({}, { get: (_t, mod) => moduleProxy(String(mod)) }) };
});

let currentRows: unknown[];

vi.mock("convex/react", () => ({
  useQuery: (ref: string, args: unknown) => {
    if (args === "skip") return undefined;
    if (ref === "entityReviewQueue.getBatch") return currentRows;
    return undefined;
  },
  useQueries: (queries: Record<string, { args: { players: unknown[] } }>) => {
    const out: Record<string, unknown> = {};
    for (const [key, { args }] of Object.entries(queries)) {
      out[key] = {
        setYear: 1998,
        players: args.players.map(() => ({ playerId: null, answer: null, candidates: [] })),
      };
    }
    return out;
  },
  useMutation: () => vi.fn(() => Promise.resolve(0)),
  useAction: () => vi.fn(() => Promise.resolve(undefined)),
}));

vi.mock("./EntityLinkSearch", () => ({ default: () => null }));

import EntityReviewWizard from "./EntityReviewWizard";
import {
  AUTOGRAPH_CHOICE_LABEL,
  AUTOGRAPH_NEXT_BLOCKED,
  autographStepQuestion,
} from "./AutographFormatStep";
import { STEP_SUBTITLE } from "./entity-review-steps";

const NEXT_NAME = "Next (Enter)";
const SUBTITLE = STEP_SUBTITLE.autograph;
/** A set name long enough that every new card's title is trimmed to fit. */
const LONG_TITLES = {
  sportValue: "Baseball",
  setNameValue: "Chrome Update Series Sapphire Edition Platinum Anniversary Collectors Box",
  inheritedFeatures: { manufacturer: "Topps", season: "2026" },
  setTeamNames: [],
  players: [],
  teams: [],
};

type Card = {
  cardNumber: string;
  cardName: string;
  players?: string[];
  teams?: string[];
  attributes?: string[];
};

/** Two new cards, both teamed, one an autograph. */
const TEAMED: Card[] = [
  { cardNumber: "A-MT", cardName: "Autographs", players: ["Mike Trout"], teams: ["Angels"], attributes: ["AU"] },
  { cardNumber: "1", cardName: "Base", players: ["Pete Rose"], teams: ["Reds"] },
];

function wizard(props: Record<string, unknown> = {}, cards: Card[] = TEAMED) {
  return (
    <EntityReviewWizard
      isOpen
      selectorOptionId={"selopt-1" as unknown as Id<"selectorOptions">}
      batchId=""
      teamsOnly
      summary={{ cardCount: cards.length, deleteCount: 0, reviewDecisionCount: 0 }}
      onConfirm={vi.fn()}
      onCancel={vi.fn()}
      previewCards={cards}
      onTeamAnswersChange={vi.fn()}
      {...props}
    />
  );
}

const counter = () =>
  screen
    .getAllByRole("status")
    .map((el) => el.textContent ?? "")
    .find((t) => /^Step \d+ of \d+$/.test(t)) ?? "";
const next = () => screen.getByRole("button", { name: NEXT_NAME });
const choice = (label: string) => screen.getByRole("radio", { name: label });
const ON_CARD = AUTOGRAPH_CHOICE_LABEL["On Card"];
const STICKER = AUTOGRAPH_CHOICE_LABEL["Sticker/Label"];

beforeEach(() => {
  currentRows = [];
});

describe("when the step is asked", () => {
  it("opens on it for a new AU card on a leaf with no format: Step 1 of 2", () => {
    render(wizard({ onAutographFormatChange: vi.fn() }));
    expect(counter()).toBe("Step 1 of 2");
    expect(screen.getByText(SUBTITLE)).toBeTruthy();
    expect(screen.getByRole("radiogroup", { name: autographStepQuestion(1) })).toBeTruthy();
  });

  it("counts every new AU card in the question", () => {
    const cards = TEAMED.map((c) => ({ ...c, attributes: ["AU"] }));
    render(wizard({ onAutographFormatChange: vi.fn() }, cards));
    expect(screen.getByRole("radiogroup", { name: autographStepQuestion(2) })).toBeTruthy();
  });

  it("is not asked when the leaf already has a format", () => {
    render(wizard({ onAutographFormatChange: vi.fn(), hasAutographFormat: true }));
    expect(screen.queryByText(SUBTITLE)).toBeNull();
    expect(counter()).toBe("Step 1 of 1");
  });

  it("is not asked about a card that re-syncs a stored row", () => {
    render(wizard({ onAutographFormatChange: vi.fn(), existingCardIndexes: [0] }));
    expect(screen.queryByText(SUBTITLE)).toBeNull();
  });

  it("is not asked when no card carries AU", () => {
    render(wizard({ onAutographFormatChange: vi.fn() }, [TEAMED[1]]));
    expect(screen.queryByText(SUBTITLE)).toBeNull();
  });

  it("is not asked by a host that does not take the answer", () => {
    render(wizard());
    expect(screen.queryByText(SUBTITLE)).toBeNull();
  });
});

describe("the answer is required", () => {
  it("focuses the first choice, and Next is held — focusable, says why, does nothing", () => {
    const onAutographFormatChange = vi.fn();
    render(wizard({ onAutographFormatChange }));
    expect(document.activeElement).toBe(choice(ON_CARD));
    const button = next();
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(button.getAttribute("title")).toBe(AUTOGRAPH_NEXT_BLOCKED);
    expect(document.getElementById(button.getAttribute("aria-describedby") ?? "")?.textContent).toBe(
      autographStepQuestion(1),
    );
    fireEvent.click(button);
    fireEvent.keyDown(button, { key: "Enter" });
    expect(counter()).toBe("Step 1 of 2");
    expect(screen.getByText(SUBTITLE)).toBeTruthy();
    expect(screen.queryByText("Save 2 cards?")).toBeNull();
    // Nothing to send yet.
    expect(onAutographFormatChange.mock.calls.every(([v]) => v === undefined)).toBe(true);
  });

  it("a pick releases Next and reports the answer for the commit", () => {
    const onAutographFormatChange = vi.fn();
    render(wizard({ onAutographFormatChange }));
    fireEvent.click(choice(STICKER));
    expect(next().getAttribute("aria-disabled")).toBeNull();
    expect(next().getAttribute("title")).toBeNull();
    expect(onAutographFormatChange).toHaveBeenLastCalledWith("Sticker/Label");
    fireEvent.click(next());
    expect(counter()).toBe("Step 2 of 2");
    expect(screen.getByText("Save 2 cards?")).toBeTruthy();
  });

  it("Enter on a choice picks it and moves on", () => {
    const onAutographFormatChange = vi.fn();
    render(wizard({ onAutographFormatChange }));
    act(() => {
      fireEvent.keyDown(choice(ON_CARD), { key: "Enter" });
    });
    expect(onAutographFormatChange).toHaveBeenLastCalledWith("On Card");
    expect(counter()).toBe("Step 2 of 2");
    expect(screen.getByText("Save 2 cards?")).toBeTruthy();
  });

  it("Back from Save returns to it with the answer kept, and focus on Next", () => {
    render(wizard({ onAutographFormatChange: vi.fn() }));
    fireEvent.click(choice(STICKER));
    fireEvent.click(next());
    fireEvent.click(screen.getByRole("button", { name: "Back to previous step" }));
    expect(screen.getByText(SUBTITLE)).toBeTruthy();
    expect(choice(STICKER).getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(next());
  });
});

describe("its place in the walk", () => {
  it("sits between teams and titles: teams, autograph, titles, save", () => {
    const cards: Card[] = [
      { cardNumber: "A-MT", cardName: "Autographs", players: ["Mike Trout"], attributes: ["AU"] },
    ];
    render(
      wizard({ onAutographFormatChange: vi.fn(), titleContext: LONG_TITLES }, cards),
    );
    expect(counter()).toBe("Step 1 of 4");
    expect(screen.getByText("Cards with no team")).toBeTruthy();
    fireEvent.click(next());
    expect(counter()).toBe("Step 2 of 4");
    expect(screen.getByText(SUBTITLE)).toBeTruthy();
    fireEvent.click(choice(ON_CARD));
    fireEvent.click(next());
    expect(counter()).toBe("Step 3 of 4");
    expect(screen.getByText("Card titles")).toBeTruthy();
    fireEvent.click(next());
    expect(counter()).toBe("Step 4 of 4");
    fireEvent.click(screen.getByRole("button", { name: "Back to previous step" }));
    fireEvent.click(screen.getByRole("button", { name: "Back to previous step" }));
    expect(screen.getByText(SUBTITLE)).toBeTruthy();
    expect(counter()).toBe("Step 2 of 4");
  });

  it("names nothing on its screen but the cards' question (no decided-names list)", () => {
    render(wizard({ onAutographFormatChange: vi.fn() }));
    expect(screen.queryByText(/Already decided/)).toBeNull();
  });
});

void React;
