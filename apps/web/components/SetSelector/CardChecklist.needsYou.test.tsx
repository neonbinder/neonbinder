/**
 * NEO-335 — the checklist header's one attention control, "N need you".
 *
 * It replaced three controls: the "N need attention" filter chip, the set-wide
 * "N cards need a team" Fill pill, and the "Fix them one at a time" link (plus
 * the post-commit banner's own call-to-action, pinned in CardChecklist.test.tsx).
 * Pinned here: what N counts (every attention kind, live), that it is the one
 * amber pill and the only control in its row, that its visible text is its
 * accessible name, that it opens the walker only when pressed (click or Enter),
 * that a build holding the checklist holds it too, and that the grid is never
 * filtered any more.
 *
 * The walker itself is stubbed: its queue, order and done line are covered in
 * CardAttentionWalker.test.tsx. Heavy children that play no part here are
 * stubbed so the mocked Convex surface stays small.
 */

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Id } from "../../convex/_generated/dataModel";
import type { ParallelBuildRunner } from "./ParallelBuildPanel";

vi.mock("../../convex/_generated/api", () => ({
  api: {
    selectorOptions: {
      getCardChecklist: "getCardChecklist",
      getSelectorOptionById: "getSelectorOptionById",
      getAncestorChain: "getAncestorChain",
      fetchCardChecklist: "fetchCardChecklist",
      diffChecklistAgainstExisting: "diffChecklistAgainstExisting",
      resolveChecklistEntities: "resolveChecklistEntities",
      commitCardChecklist: "commitCardChecklist",
      addCustomCard: "addCustomCard",
    },
    checklistCandidates: {
      getReadyCandidates: "getReadyCandidates",
      discardCandidates: "discardCandidates",
    },
    marketplacePause: { getPausedPlatforms: "getPausedPlatforms" },
    // NEO-335: CardChecklist reads the set's skip records itself (for the
    // wizard's teams step), not only through the mocked SkippedNamesPanel.
    entityReviewSkips: { listForSet: "entityReviewSkips.listForSet" },
    // NEO-343: the search box's team and player names (skipped until the
    // field is focused, but the references still have to resolve).
    teams: { getManyByIds: "teams.getManyByIds" },
    players: { getManyByIds: "players.getManyByIds" },
  },
}));

vi.mock("react-virtuoso", () => ({
  Virtuoso: ({
    data,
    itemContent,
  }: {
    data: unknown[];
    itemContent: (index: number, item: unknown) => React.ReactNode;
  }) => <div>{data.map((item, i) => <div key={i}>{itemContent(i, item)}</div>)}</div>,
}));

// Children with their own Convex surfaces, none of which this file is about.
vi.mock("./CardChecklistItem", () => ({
  default: ({ card }: { card: { cardName: string } }) => <div>{card.cardName}</div>,
}));
vi.mock("./CardDetailPanel", () => ({ default: () => null }));
vi.mock("./EntityReviewWizard", () => ({ default: () => null }));
vi.mock("./CardPairingModal", () => ({ default: () => null }));
vi.mock("./sync-review-modal", () => ({
  default: () => null,
  needsSyncReview: () => false,
}));
vi.mock("./CrossListingImportModal", () => ({ default: () => null }));
// A visible stand-in, so "the walker opened" is observable without its queue.
vi.mock("./CardAttentionWalker", () => ({
  default: () => <div role="dialog" aria-label="Walker stand-in" />,
}));
vi.mock("./SkippedNamesPanel", () => ({ default: () => null }));
vi.mock("./TeamPicker", () => ({ default: () => null }));
vi.mock("./PlayerPicker", () => ({ default: () => null }));

const state: { cards: unknown } = { cards: [] };

vi.mock("convex/react", () => ({
  useQuery: (ref: string) => {
    if (ref === "getCardChecklist") return state.cards;
    if (ref === "getSelectorOptionById") return { value: "Base" };
    if (ref === "getAncestorChain") return [];
    if (ref === "getReadyCandidates") return null;
    if (ref === "getPausedPlatforms") return [];
    return undefined;
  },
  useMutation: () => vi.fn(),
  useAction: () => vi.fn(),
  useConvex: () => ({ query: vi.fn(), action: vi.fn() }),
}));

import CardChecklist from "./CardChecklist";
import { SET_ROW_ACTION_TONE_CLASSES } from "./SetRowActionButton";

const VARIANT_ID = "variant-1" as unknown as Id<"selectorOptions">;

/** No team, no marketplace lookup to wait for: `missingTeam`. */
function teamless(n: number, overrides: Record<string, unknown> = {}) {
  return {
    _id: `card-${n}` as unknown as Id<"cardChecklist">,
    selectorOptionId: VARIANT_ID,
    cardNumber: String(n),
    cardName: `Teamless ${n}`,
    platformData: {},
    lastUpdated: 1_000,
    ...overrides,
  };
}

/** Teamed, but its title is over the limit: attention WITHOUT `missingTeam`. */
function overLongTitle(n: number) {
  return teamless(n, {
    cardName: `Long title ${n}`,
    teamOnCardIds: ["team-1"],
    listingTitle: "x".repeat(200),
  });
}

/** Teamed, but a typed player name links to nobody: `unreviewedName`. */
function unlinkedName(n: number) {
  return teamless(n, {
    cardName: `Unlinked ${n}`,
    teamOnCardIds: ["team-1"],
    pendingPlayerNames: ["Somebody"],
  });
}

function settled(n: number) {
  return teamless(n, { cardName: `Settled ${n}`, teamOnCardIds: ["team-1"] });
}

/** BSC-linked, no team, lookup not back yet: NOT flagged (it may still answer). */
function awaitingLookup(n: number) {
  return teamless(n, {
    cardName: `Awaiting ${n}`,
    platformData: { bsc: { ref: `bsc-${n}` } },
  });
}

function ui(parallelRun?: ParallelBuildRunner) {
  return (
    <CardChecklist
      variantId={VARIANT_ID}
      sourceChips={{}}
      sourceLabelMaps={{ bsc: {}, sportlots: {} }}
      parallelRun={parallelRun}
    />
  );
}

const pill = (name: string | RegExp = /^\d+ needs? you$/) =>
  screen.getByRole("button", { name });
const queryPill = () => screen.queryByRole("button", { name: /^\d+ needs? you$/ });
/** The header's "N cards need you" live region — mounted even when empty. */
const attentionStatus = () =>
  document.querySelector<HTMLElement>('[role="status"][data-attention-status]');
const announcedStatus = () => attentionStatus()?.textContent ?? null;

describe("CardChecklist — the one 'N need you' control (NEO-335)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.cards = [teamless(1), teamless(2), overLongTitle(3), unlinkedName(4), settled(5)];
  });

  it("counts every attention kind, not only missing teams, and wears the amber attention pill", () => {
    render(ui());
    const control = pill("4 need you");
    for (const cls of SET_ROW_ACTION_TONE_CLASSES.attention.split(" ")) {
      expect(control.classList.contains(cls)).toBe(true);
    }
    // SC 2.5.3: the visible text IS the name — no aria-label to drift from it.
    expect(control.getAttribute("aria-label")).toBeNull();
    expect(control.textContent).toBe("4 need you");
    expect(control.getAttribute("aria-haspopup")).toBe("dialog");
  });

  it("is singular for one card", () => {
    state.cards = [teamless(1), settled(2)];
    render(ui());
    expect(pill("1 needs you")).toBeTruthy();
  });

  it("is the only control in its row", () => {
    render(ui());
    const row = pill().parentElement!;
    expect(within(row).getAllByRole("button")).toEqual([pill()]);
  });

  it("retires the filter chip, the Fill teams pill and the 'Fix them one at a time' link", () => {
    render(ui());
    expect(screen.queryByRole("button", { name: /Show only cards needing attention/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /\bneeds? a team$/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /one at a time/ })).toBeNull();
    expect(screen.queryByText(/need attention/)).toBeNull();
  });

  it("never filters the grid: flagged and settled rows both stay listed", () => {
    render(ui());
    fireEvent.click(pill());
    for (const name of ["Teamless 1", "Long title 3", "Unlinked 4", "Settled 5"]) {
      expect(screen.getByText(name)).toBeTruthy();
    }
  });

  it("does not count a BSC card whose team lookup has not come back", () => {
    state.cards = [awaitingLookup(1), teamless(2)];
    render(ui());
    expect(pill("1 needs you")).toBeTruthy();
  });

  it("renders nothing — not even the row label — when nothing needs a person", () => {
    state.cards = [settled(1), awaitingLookup(2)];
    render(ui());
    expect(queryPill()).toBeNull();
    expect(screen.queryByText("Attention")).toBeNull();
  });

  it("announces the count in a polite live region, since the pill's own text changes silently", () => {
    render(ui());
    const announced = screen
      .getAllByRole("status")
      .map((el) => el.textContent ?? "")
      .join(" | ");
    expect(announced).toContain("4 cards need you on this checklist");
  });

  it("follows the live rows: the count drops as cards are answered, and the row leaves at zero", () => {
    vi.useFakeTimers();
    try {
      const { rerender } = render(ui());
      expect(pill("4 need you")).toBeTruthy();

      state.cards = [settled(1), teamless(2), settled(3), settled(4), settled(5)];
      rerender(ui());
      // The pill is immediate; the announcement waits for the count to settle.
      expect(pill("1 needs you")).toBeTruthy();
      act(() => {
        vi.advanceTimersByTime(1500);
      });
      expect(announcedStatus()).toBe("1 card needs you on this checklist");

      state.cards = [settled(1), settled(2)];
      rerender(ui());
      expect(queryPill()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("parks focus on the Sync button when the pill leaves while focused, instead of dropping it to body", () => {
    const { rerender } = render(ui());
    const button = pill("4 need you");
    act(() => button.focus());
    expect(document.activeElement).toBe(button);

    // The last cards are answered elsewhere (a background lookup) while the
    // operator is standing on the pill.
    state.cards = [settled(1), settled(2)];
    rerender(ui());
    expect(queryPill()).toBeNull();
    expect(document.activeElement).toBe(screen.getByLabelText("Sync card checklist"));
  });

  it("leaves focus alone when the pill leaves while focus is elsewhere", () => {
    const { rerender } = render(ui());
    const sync = screen.getByLabelText("Sync card checklist") as HTMLElement;
    act(() => sync.blur());
    expect(document.activeElement).toBe(document.body);
    state.cards = [settled(1), settled(2)];
    rerender(ui());
    expect(document.activeElement).toBe(document.body);
  });

  it("announces a burst of changes ONCE, with where the count landed", () => {
    vi.useFakeTimers();
    try {
      const { rerender } = render(ui());
      expect(announcedStatus()).toBe("4 cards need you on this checklist");

      // Three fixes inside the debounce window.
      state.cards = [settled(1), teamless(2), teamless(3), teamless(4), settled(5)];
      rerender(ui());
      act(() => {
        vi.advanceTimersByTime(500);
      });
      state.cards = [settled(1), teamless(2), teamless(3), settled(4), settled(5)];
      rerender(ui());
      act(() => {
        vi.advanceTimersByTime(500);
      });
      state.cards = [settled(1), teamless(2), settled(3), settled(4), settled(5)];
      rerender(ui());
      // None of the intermediate counts was ever put in the region.
      expect(announcedStatus()).toBe("4 cards need you on this checklist");
      act(() => {
        vi.advanceTimersByTime(1499);
      });
      expect(announcedStatus()).toBe("4 cards need you on this checklist");
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(announcedStatus()).toBe("1 card needs you on this checklist");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the live region mounted, empty, when nothing needs a person — so the first count after a save is read", () => {
    vi.useFakeTimers();
    try {
      state.cards = [settled(1), settled(2)];
      const { rerender } = render(ui());
      const region = attentionStatus();
      expect(region).not.toBeNull();
      expect(region!.textContent).toBe("");

      state.cards = [settled(1), teamless(2)];
      rerender(ui());
      act(() => {
        vi.advanceTimersByTime(1500);
      });
      // The SAME element, now carrying the count.
      expect(attentionStatus()).toBe(region);
      expect(region!.textContent).toBe("1 card needs you on this checklist");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not open the walker on its own — not on mount, not when rows change", () => {
    const { rerender } = render(ui());
    expect(screen.queryByRole("dialog")).toBeNull();
    state.cards = [teamless(1), teamless(2), teamless(9)];
    rerender(ui());
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens the walker when clicked", () => {
    render(ui());
    fireEvent.click(pill());
    expect(screen.getByRole("dialog", { name: "Walker stand-in" })).toBeTruthy();
  });

  it("opens the walker on Enter — maestro-web's pressKey is a synthetic keydown with no default action", () => {
    render(ui());
    const control = pill();
    control.focus();
    fireEvent.keyDown(control, { key: "Enter" });
    expect(screen.getByRole("dialog", { name: "Walker stand-in" })).toBeTruthy();
  });

  it("is held, described by the build note, and opens nothing while this checklist's own build is in flight", () => {
    const held: ParallelBuildRunner = {
      run: null,
      active: false,
      inFlight: new Set([VARIANT_ID as unknown as string]),
      start: vi.fn(),
      stop: vi.fn(),
      buildOne: vi.fn(),
    };
    render(ui(held));
    const control = pill();
    expect(control.getAttribute("aria-disabled")).toBe("true");
    // Mirrors CardChecklist.tsx's private `MANUAL_BUILD_NOTE_ID`.
    expect(control.getAttribute("aria-describedby")).toBe("parallel-build-own-note");
    fireEvent.click(control);
    fireEvent.keyDown(control, { key: "Enter" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
