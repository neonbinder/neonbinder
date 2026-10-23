/**
 * NEO-335 Phase 2 — the wizard wearing the shared chrome: one "Step x of y"
 * over every screen, a subtitle per screen type, growth announced politely,
 * nothing added on Save, and the teams / titles / save steps in order.
 *
 * The rules themselves are pure and pinned in entity-review-steps.test.tsx;
 * this file is the wiring.
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

const CONFIRM_SAVE_NAME = "Confirm & Save (Enter) — commit this review";
const TITLES_LEAD = "Trimmed to fit. Keep it, or make it yours.";
const SET_TEAM_HINT =
  "Most of these share one team? Set a whole-set team in Set details and every new card gets it.";
/** A set name long enough that every new card's title is trimmed to fit. */
const LONG_TITLES = {
  sportValue: "Baseball",
  setNameValue: "Chrome Update Series Sapphire Edition Platinum Anniversary Collectors Box",
  inheritedFeatures: { manufacturer: "Topps", season: "2026" },
  setTeamNames: [],
  players: [],
  teams: [],
};
/** The same set with a short name: nothing to trim. */
const SHORT_TITLES = { ...LONG_TITLES, setNameValue: "Chrome" };
const NEXT_NAME = "Next (Enter)";

let seq = 0;
function row(overrides: Record<string, unknown>) {
  seq += 1;
  return {
    _id: `row-${seq}`,
    _creationTime: seq,
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

function wizard(props: Record<string, unknown> = {}, cards?: Card[]) {
  return (
    <EntityReviewWizard
      isOpen
      selectorOptionId={"selopt-1" as unknown as Id<"selectorOptions">}
      batchId="batch-1"
      summary={{ cardCount: cards?.length ?? 2, deleteCount: 0, reviewDecisionCount: 0 }}
      onConfirm={vi.fn()}
      onCancel={vi.fn()}
      {...(cards ? { previewCards: cards, onTeamAnswersChange: vi.fn() } : {})}
      {...props}
    />
  );
}

const counter = () =>
  screen
    .getAllByRole("status")
    .map((el) => el.textContent ?? "")
    .find((t) => /^Step \d+ of \d+$/.test(t)) ?? "";
const growthRegion = () => {
  const header = document.querySelector("header")!;
  return header.querySelector('[aria-live="polite"]')!;
};

beforeEach(() => {
  seq = 0;
  currentRows = [];
});

describe("the chrome on every screen", () => {
  it("titles the dialog 'Tidy up this set' and never shows the old header", () => {
    currentRows = [row({ name: "Mike Trout" })];
    render(wizard());
    expect(screen.getByRole("dialog", { name: "Tidy up this set" })).toBeTruthy();
    expect(screen.queryByText("Confirm New Players & Teams")).toBeNull();
    expect(screen.queryByText(/of \d+ reviewed/)).toBeNull();
  });

  it.each([
    [{ kind: "league", name: "ABL" }, "New league"],
    [{ kind: "team", name: "Sydney Blue Sox" }, "New team"],
    [{ kind: "player", name: "Mike Trout" }, "New player"],
  ])("subtitles a %o step", (overrides, subtitle) => {
    currentRows = [row(overrides)];
    render(wizard());
    expect(screen.getByText(subtitle)).toBeTruthy();
    expect(counter()).toBe("Step 1 of 2");
  });

  it("subtitles a NEO-332 same-name pick as 'Which player is this?', and counts it as one step", () => {
    currentRows = [
      row({
        name: "Bob Allen",
        enrichment: {
          existingCandidates: [
            { playerId: "p1", name: "Bob Allen", birthYear: 1937, careerSummary: "" },
            { playerId: "p2", name: "Bob Allen", birthYear: 1867, careerSummary: "" },
          ],
        },
      }),
      row({ name: "Other Guy" }),
    ];
    render(wizard());
    expect(screen.getByText("Which player is this?")).toBeTruthy();
    expect(counter()).toBe("Step 1 of 3");
  });
});

describe("growth", () => {
  it("announces staged career steps — '2 more steps: teams for {player}' — and clears on the next move", () => {
    const thome = row({ name: "Jim Thome" });
    const other = row({ name: "Other Guy" });
    currentRows = [thome, other];
    const { rerender } = render(wizard());
    expect(counter()).toBe("Step 1 of 3");
    expect(growthRegion().textContent).toBe("");

    // His lookup lands and stages two New Team steps ahead of him.
    currentRows = [
      row({ kind: "team", name: "Indians", source: { kind: "careerTeamOf", playerRowId: thome._id } }),
      row({ kind: "team", name: "Phillies", source: { kind: "careerTeamOf", playerRowId: thome._id } }),
      thome,
      other,
    ];
    rerender(wizard());
    expect(counter()).toBe("Step 1 of 5");
    expect(growthRegion().textContent).toBe("2 more steps: teams for Jim Thome");

    // The operator answers the first staged step: the line has been said.
    currentRows = [
      { ...(currentRows[0] as object), decision: { action: "create" } },
      ...currentRows.slice(1),
    ];
    rerender(wizard());
    expect(counter()).toBe("Step 2 of 5");
    expect(growthRegion().textContent).toBe("");
  });

  it("a skipped team name adds the teams step — '1 more step: cards with no team'", () => {
    const reds = row({ kind: "team", name: "Reds" });
    const rose = row({ name: "Pete Rose", decision: { action: "create" } });
    currentRows = [reds, rose];
    const cards = [{ cardNumber: "1", cardName: "Base", players: ["Pete Rose"], teams: ["Reds"] }];
    const { rerender } = render(wizard({}, cards));
    // The team name is assumed to resolve: no teams step yet.
    expect(counter()).toBe("Step 2 of 3");

    currentRows = [{ ...reds, decision: { action: "skip" } }, rose];
    rerender(wizard({}, cards));
    expect(counter()).toBe("Step 3 of 4");
    expect(screen.getByText("Cards with no team")).toBeTruthy();
    expect(growthRegion().textContent).toBe("1 more step: cards with no team");
  });

  it("never shrinks: a staged step that goes away keeps its place in y", () => {
    const player = row({ name: "Jim Thome" });
    const staged = row({
      kind: "team",
      name: "Indians",
      source: { kind: "careerTeamOf", playerRowId: player._id },
    });
    currentRows = [staged, player];
    const { rerender } = render(wizard());
    expect(counter()).toBe("Step 1 of 3");
    currentRows = [player];
    rerender(wizard());
    expect(counter()).toBe("Step 1 of 3");
  });
});

describe("the post-review steps", () => {
  const decidedRows = () => [
    row({ name: "Pete Rose", decision: { action: "create" } }),
    row({ name: "Johnny Bench", decision: { action: "create" } }),
  ];
  const teamless: Card[] = [
    { cardNumber: "1", cardName: "Base", players: ["Pete Rose"] },
    { cardNumber: "2", cardName: "Base", players: ["Johnny Bench"] },
  ];

  it("walks teams → titles → save, each in the chrome, Save always y of y", () => {
    currentRows = decidedRows();
    render(wizard({ titleContext: LONG_TITLES }, teamless));
    expect(counter()).toBe("Step 3 of 5");
    expect(screen.getByText("Cards with no team")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: NEXT_NAME }));
    expect(counter()).toBe("Step 4 of 5");
    expect(screen.getByText("Card titles")).toBeTruthy();
    // Unit B's CardTitlesStep, mounted in the slot.
    expect(screen.getByRole("heading", { name: TITLES_LEAD })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: NEXT_NAME }));

    fireEvent.click(screen.getByRole("button", { name: NEXT_NAME }));
    expect(counter()).toBe("Step 5 of 5");
    expect(screen.getByText("Ready to save")).toBeTruthy();
    expect(screen.getByText("Save 2 cards?")).toBeTruthy();

    // Back walks the same road the other way.
    fireEvent.click(screen.getByRole("button", { name: "Back to previous step" }));
    expect(screen.getByText("Card titles")).toBeTruthy();
  });

  it("the one-step Back is an outlined secondary button beside the footer buttons", () => {
    currentRows = decidedRows();
    render(wizard({ onBack: vi.fn() }, teamless));
    fireEvent.click(screen.getByRole("button", { name: NEXT_NAME }));
    const back = screen.getByRole("button", { name: "Back to previous step" });
    expect(back.textContent).toBe("Back");
    expect(back.className).toContain("border-neon-blue-text");
    expect(back.className).toContain("h-8");
    expect(back.className).not.toContain("underline");
    // In the buttons' group, next to Cancel — not in the decision slot.
    const cancel = screen.getByRole("button", { name: /^Cancel \(Esc\)/ });
    expect(back.parentElement).toBe(cancel.parentElement);
    // And "Back to Match Cards" sits before it at link weight.
    const matchCards = screen.getByRole("button", { name: "Back to Match Cards" });
    expect(matchCards.compareDocumentPosition(back) & 4).toBe(4);
  });

  it("a new screen starts at the top of the scrolling body", () => {
    const rose = row({ name: "Pete Rose" });
    currentRows = [rose, row({ name: "Johnny Bench" })];
    const { rerender } = render(wizard({}, [teamless[0]]));
    const body = document.querySelector<HTMLElement>(".overflow-y-auto")!;
    body.scrollTop = 240;
    expect(body.scrollTop).toBe(240);

    // A new row on screen (the first was decided): back to the top.
    currentRows = [{ ...rose, decision: { action: "create" } }, currentRows[1]];
    rerender(wizard({}, [teamless[0]]));
    expect(screen.getByRole("heading", { name: /Johnny Bench/ })).toBeTruthy();
    expect(body.scrollTop).toBe(0);

    // And into the post-name steps: the teams step opens at the top too.
    body.scrollTop = 180;
    currentRows = [
      { ...rose, decision: { action: "create" } },
      { ...(currentRows[1] as object), decision: { action: "create" } },
    ];
    rerender(wizard({}, [teamless[0]]));
    expect(screen.getByText("Cards with no team")).toBeTruthy();
    expect(body.scrollTop).toBe(0);
  });

  it("has no titles step when no new card's title needs a look", () => {
    currentRows = decidedRows();
    render(wizard({ titleContext: SHORT_TITLES }, teamless));
    expect(counter()).toBe("Step 3 of 4");
    fireEvent.click(screen.getByRole("button", { name: NEXT_NAME }));
    expect(counter()).toBe("Step 4 of 4");
    expect(screen.queryByText("Card titles")).toBeNull();
  });

  it("adds nothing once the operator is on Save — and sends no title answer for it", () => {
    currentRows = decidedRows();
    const onTitleAnswersChange = vi.fn();
    const { rerender } = render(
      wizard({ titleContext: SHORT_TITLES, onTitleAnswersChange }, teamless),
    );
    fireEvent.click(screen.getByRole("button", { name: NEXT_NAME }));
    expect(counter()).toBe("Step 4 of 4");

    // A titles step turning up now is the walker's, after the save.
    rerender(wizard({ titleContext: LONG_TITLES, onTitleAnswersChange }, teamless));
    expect(counter()).toBe("Step 4 of 4");
    expect(screen.getByText("Ready to save")).toBeTruthy();
    expect(growthRegion().textContent).toBe("");
    // Never shown, so never "kept": the walker still flags them after save.
    expect(onTitleAnswersChange.mock.calls.every(([fields]) => fields === undefined)).toBe(true);
  });

  it("teams-only plus titles is three steps", () => {
    render(
      wizard({ teamsOnly: true, batchId: "", titleContext: LONG_TITLES }, [
        { cardNumber: "1", cardName: "Base", players: ["Pete Rose"] },
      ]),
    );
    expect(counter()).toBe("Step 1 of 3");
    expect(screen.getByText("Cards with no team")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: NEXT_NAME }));
    expect(counter()).toBe("Step 2 of 3");
    expect(screen.getByText("Card titles")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: NEXT_NAME }));
    expect(counter()).toBe("Step 3 of 3");
    expect(screen.getByText("Save 1 card?")).toBeTruthy();
  });

  it("D7: with no names and every card teamed, opens on Card titles as Step 1 of 2", () => {
    const onTitleAnswersChange = vi.fn();
    render(
      wizard({ teamsOnly: true, batchId: "", titleContext: LONG_TITLES, onTitleAnswersChange }, [
        { cardNumber: "1", cardName: "Base", players: ["Pete Rose"], teams: ["Reds"] },
      ]),
    );
    expect(counter()).toBe("Step 1 of 2");
    expect(screen.getByText("Card titles")).toBeTruthy();
    expect(screen.getByRole("heading", { name: TITLES_LEAD })).toBeTruthy();
    expect(screen.queryByText("Cards with no team")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: NEXT_NAME }));
    // Shown, so the commit hears "kept" for the card.
    expect(onTitleAnswersChange.mock.calls.at(-1)?.[0]).toEqual([
      { listingTitleKept: expect.stringMatching(/#1$/) },
    ]);
    // Nothing decided in this sitting: no Back out of the first step.
    expect(screen.queryByRole("button", { name: "Back to previous step" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: NEXT_NAME }));
    expect(counter()).toBe("Step 2 of 2");
    expect(screen.getByText("Save 1 card?")).toBeTruthy();
    // Back from Save returns to the titles step.
    fireEvent.click(screen.getByRole("button", { name: "Back to previous step" }));
    expect(screen.getByText("Card titles")).toBeTruthy();
  });

  it("reports title answers only once the step has shown the cards, defaulting to kept", () => {
    currentRows = decidedRows();
    const onTitleAnswersChange = vi.fn();
    render(wizard({ titleContext: LONG_TITLES, onTitleAnswersChange }, teamless));
    // On the teams step: the titles step is counted, not yet shown.
    expect(screen.getByText("Cards with no team")).toBeTruthy();
    expect(onTitleAnswersChange.mock.calls.every(([fields]) => fields === undefined)).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: NEXT_NAME }));
    expect(screen.getByText("Card titles")).toBeTruthy();
    // "Kept" carries the title the operator was shown, so the server keeps
    // exactly that one.
    expect(onTitleAnswersChange.mock.calls.at(-1)?.[0]).toEqual([
      { listingTitleKept: expect.stringMatching(/#1$/) },
      { listingTitleKept: expect.stringMatching(/#2$/) },
    ]);
  });

  it("never asks about a card that re-syncs a stored row", () => {
    currentRows = decidedRows();
    const onTitleAnswersChange = vi.fn();
    render(
      wizard(
        { titleContext: LONG_TITLES, existingCardIndexes: [0], onTitleAnswersChange },
        teamless,
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: NEXT_NAME }));
    expect(onTitleAnswersChange.mock.calls.at(-1)?.[0]).toEqual([
      undefined,
      { listingTitleKept: expect.stringMatching(/#2$/) },
    ]);
  });

  it("Back from the teams step returns to the name decided in this sitting", async () => {
    const rose = row({ name: "Pete Rose" });
    currentRows = [rose];
    const { rerender } = render(wizard({}, [teamless[0]]));
    expect(counter()).toBe("Step 1 of 3");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Add as New Player/ }));
    });
    currentRows = [{ ...rose, decision: { action: "create" } }];
    rerender(wizard({}, [teamless[0]]));
    expect(counter()).toBe("Step 2 of 3");
    expect(screen.getByText("Cards with no team")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Back to previous step" }));
    expect(screen.getByText(/Already decided/)).toBeTruthy();
    expect(counter()).toBe("Step 1 of 3");
    expect(screen.getByText("New player")).toBeTruthy();
    expect(screen.queryByRole("button", { name: CONFIRM_SAVE_NAME })).toBeNull();
  });

  it("C7: flags the set-team hint for a long teams step only when the set has no set-level team", () => {
    currentRows = [];
    const many: Card[] = Array.from({ length: 8 }, (_, i) => ({
      cardNumber: String(i + 1),
      cardName: "Base",
      players: [`Player ${i}`],
    }));
    const { rerender } = render(wizard({ teamsOnly: true, batchId: "" }, many));
    const hint = () => screen.queryByText(SET_TEAM_HINT);
    expect(hint()).toBeTruthy();

    rerender(wizard({ teamsOnly: true, batchId: "", hasSetTeam: true }, many));
    expect(hint()).toBeNull();

    rerender(wizard({ teamsOnly: true, batchId: "" }, many.slice(0, 7)));
    expect(hint()).toBeNull();
  });
});

void React;
