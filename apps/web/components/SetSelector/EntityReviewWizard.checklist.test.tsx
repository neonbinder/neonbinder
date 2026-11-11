/**
 * NEO-478 — the wizard's "Checklist says otherwise" step: it is step 1, the
 * name steps shift down by one, Next is held until every card is answered,
 * and Back from the first name returns to it with the answers kept.
 *
 * The step's own markup is pinned in ChecklistConflictStep.test.tsx and the
 * pure rules in checklist-conflict.test.tsx; this file is the wiring.
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
import type { ChecklistChoice, ChecklistConflict } from "./checklist-conflict";

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

type Card = {
  cardNumber: string;
  cardName: string;
  players?: string[];
  teams?: string[];
  checklistConflict?: ChecklistConflict;
};

const CONFLICT_CARD: Card = {
  cardNumber: "60",
  cardName: "Pete Rose",
  players: ["Pete Rose"],
  teams: ["Reds"],
  checklistConflict: { players: { marketplace: ["Pete Rose"], checklist: ["Pete Rosa"] } },
};
const PLAIN_CARD: Card = {
  cardNumber: "61",
  cardName: "Johnny Bench",
  players: ["Johnny Bench"],
  teams: ["Reds"],
};

let onChecklistChoicesChange: ReturnType<typeof vi.fn>;

function wizard(cards: Card[], onCancel: () => void = vi.fn()) {
  return (
    <EntityReviewWizard
      isOpen
      selectorOptionId={"selopt-1" as unknown as Id<"selectorOptions">}
      batchId="batch-1"
      summary={{ cardCount: cards.length, deleteCount: 0, reviewDecisionCount: 0 }}
      onConfirm={vi.fn()}
      onCancel={onCancel}
      previewCards={cards}
      onTeamAnswersChange={vi.fn()}
      onChecklistChoicesChange={onChecklistChoicesChange}
    />
  );
}

const counter = () =>
  screen
    .getAllByRole("status")
    .map((el) => el.textContent ?? "")
    .find((t) => /^Step \d+ of \d+$/.test(t)) ?? "";
const NEXT = () => screen.getByRole("button", { name: "Next (Enter)" });
const keep = () => screen.getByRole("radio", { name: "Keep the marketplace's" });
const use = () => screen.getByRole("radio", { name: "Use the checklist's" });

beforeEach(() => {
  seq = 0;
  onChecklistChoicesChange = vi.fn();
  // The server queues the names on BOTH sides of the disagreement.
  currentRows = [
    row({ name: "Pete Rose" }),
    row({ name: "Pete Rosa" }),
    row({ name: "Johnny Bench" }),
  ];
});

describe("the checklist step in the wizard (NEO-478)", () => {
  it("opens on the checklist step, as step 1, before any name", () => {
    render(wizard([CONFLICT_CARD, PLAIN_CARD]));
    expect(screen.getByRole("heading", { name: "Checklist says otherwise" })).toBeTruthy();
    expect(screen.getByText("Checklist disagreements")).toBeTruthy();
    expect(counter()).toMatch(/^Step 1 of \d+$/);
    // No name step is on screen yet.
    expect(screen.queryByText("New player")).toBeNull();
  });

  it("holds Next with the hint until the card is answered, then lets it through", () => {
    render(wizard([CONFLICT_CARD, PLAIN_CARD]));
    fireEvent.click(NEXT());
    expect(screen.getByRole("heading", { name: "Checklist says otherwise" })).toBeTruthy();
    expect(screen.getByText("Pick a side on every card first — then Next.")).toBeTruthy();
    fireEvent.click(use());
    fireEvent.click(NEXT());
    expect(screen.queryByRole("heading", { name: "Checklist says otherwise" })).toBeNull();
    expect(screen.getByText("New player")).toBeTruthy();
  });

  it("reports the answers up, aligned with the preview cards", () => {
    render(wizard([CONFLICT_CARD, PLAIN_CARD]));
    expect(onChecklistChoicesChange).toHaveBeenLastCalledWith([undefined, undefined]);
    fireEvent.click(use());
    expect(onChecklistChoicesChange).toHaveBeenLastCalledWith(["checklist", undefined]);
  });

  it("shifts every name step down by one: the first name is step 2, not step 1", () => {
    const { unmount } = render(wizard([PLAIN_CARD]));
    expect(counter()).toMatch(/^Step 1 of \d+$/);
    unmount();

    render(wizard([CONFLICT_CARD, PLAIN_CARD]));
    expect(counter()).toMatch(/^Step 1 of \d+$/);
    fireEvent.click(use());
    fireEvent.click(NEXT());
    // The checklist step is 1; the names follow it, then Save.
    expect(counter()).toBe("Step 2 of 4");
  });

  it.each([
    ["checklist", "Pete Rosa", "Pete Rose"],
    ["marketplace", "Pete Rose", "Pete Rosa"],
  ] as const)(
    "after answering %s, the walk asks about %s and never the side turned down (%s)",
    (side, asked, notAsked) => {
      // Bench already decided, so the next name on screen is the contested one.
      currentRows = [
        row({ name: "Pete Rose" }),
        row({ name: "Pete Rosa" }),
        row({ name: "Johnny Bench", decision: { action: "create" } }),
      ];
      render(wizard([CONFLICT_CARD, PLAIN_CARD]));
      fireEvent.click(side === "checklist" ? use() : keep());
      fireEvent.click(NEXT());
      const text = document.querySelector('[role="dialog"]')!.textContent ?? "";
      expect(text).toContain(asked);
      expect(text).not.toContain(notAsked);
    },
  );

  it("Back from the first name returns to the checklist step with the answer still lit", () => {
    render(wizard([CONFLICT_CARD, PLAIN_CARD]));
    fireEvent.click(use());
    fireEvent.click(NEXT());
    expect(screen.queryByRole("heading", { name: "Checklist says otherwise" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Back to previous step" }));
    expect(screen.getByRole("heading", { name: "Checklist says otherwise" })).toBeTruthy();
    expect(counter()).toMatch(/^Step 1 of \d+$/);
    expect(use().getAttribute("aria-checked")).toBe("true");
    expect(keep().getAttribute("aria-checked")).toBe("false");
    // Nothing was reported as unanswered on the way back.
    const last = onChecklistChoicesChange.mock.calls.at(-1)![0] as (ChecklistChoice | undefined)[];
    expect(last).toEqual(["checklist", undefined]);
  });

  it("the answer can be changed on the way back, and the new one is reported", () => {
    render(wizard([CONFLICT_CARD, PLAIN_CARD]));
    fireEvent.click(use());
    fireEvent.click(NEXT());
    fireEvent.click(screen.getByRole("button", { name: "Back to previous step" }));
    fireEvent.click(keep());
    expect(onChecklistChoicesChange).toHaveBeenLastCalledWith(["marketplace", undefined]);
    fireEvent.click(NEXT());
    expect(screen.queryByRole("heading", { name: "Checklist says otherwise" })).toBeNull();
  });

  it("Cancel with only checklist picks made asks before discarding them (NEO-482)", async () => {
    const onCancel = vi.fn();
    render(wizard([CONFLICT_CARD, PLAIN_CARD], onCancel));
    fireEvent.click(use());
    fireEvent.click(screen.getByRole("button", { name: /^Cancel \(Esc\)/ }));
    // The pick is a decision: the existing confirmation stands between it and the bin.
    expect(screen.getByText("Discard 1 decision?")).toBeTruthy();
    expect(onCancel).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("Cancel with nothing picked still closes at once", async () => {
    const onCancel = vi.fn();
    render(wizard([CONFLICT_CARD, PLAIN_CARD], onCancel));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Cancel \(Esc\)/ }));
    });
    expect(screen.queryByText(/^Discard \d+ decisions?\?$/)).toBeNull();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("counts checklist picks and decided names together", () => {
    currentRows = [
      row({ name: "Pete Rose" }),
      row({ name: "Pete Rosa" }),
      row({ name: "Johnny Bench", decision: { action: "create" } }),
    ];
    render(wizard([CONFLICT_CARD, PLAIN_CARD]));
    fireEvent.click(use());
    fireEvent.click(screen.getByRole("button", { name: /^Cancel \(Esc\)/ }));
    expect(screen.getByText("Discard 2 decisions?")).toBeTruthy();
  });

  it("puts the lookup status on the buttons' line while the checklist step is up (NEO-482)", () => {
    currentRows = [
      row({ name: "Pete Rose" }),
      row({ name: "Pete Rosa" }),
      row({ name: "Johnny Bench", status: "pending" }),
    ];
    render(wizard([CONFLICT_CARD, PLAIN_CARD]));
    const live = screen
      .getAllByRole("status")
      .find((el) => el.textContent === "1 still looking up — wait or skip");
    expect(live).toBeTruthy();
    // Row 2 sits FIRST in the footer's one flex line, beside the row that holds Next.
    const statusRow = live!.parentElement as HTMLElement;
    const footer = statusRow.parentElement as HTMLElement;
    expect(statusRow.className).toContain("order-first");
    expect(footer.className).toContain("flex");
    expect(footer.className).not.toContain("space-y-2");
    expect(footer.contains(NEXT())).toBe(true);
    // It wraps rather than truncating; a phone gives it a line of its own.
    expect(live!.className).not.toContain("truncate");
    expect(statusRow.className).toContain("max-sm:basis-full");
  });

  it("a wizard with no checklistConflict never shows the step", () => {
    render(wizard([PLAIN_CARD]));
    expect(screen.queryByRole("heading", { name: "Checklist says otherwise" })).toBeNull();
    expect(screen.getByText("New player")).toBeTruthy();
  });

  it("without the host's answer channel the step is not offered (the host would drop the answers)", () => {
    render(
      <EntityReviewWizard
        isOpen
        selectorOptionId={"selopt-1" as unknown as Id<"selectorOptions">}
        batchId="batch-1"
        summary={{ cardCount: 2, deleteCount: 0, reviewDecisionCount: 0 }}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        previewCards={[CONFLICT_CARD, PLAIN_CARD]}
        onTeamAnswersChange={vi.fn()}
      />,
    );
    expect(screen.queryByRole("heading", { name: "Checklist says otherwise" })).toBeNull();
  });
});
