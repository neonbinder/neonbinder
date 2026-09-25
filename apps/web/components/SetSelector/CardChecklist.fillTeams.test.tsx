/**
 * NEO-306 — "Fill N missing teams" in the card checklist's header.
 *
 * Fill teams left the Set attributes panel for the checklist, beside the
 * attention chip whose lane it clears, as the amber attention pill. Pinned
 * here: where it renders (beside the chip, only with the SET id handed down,
 * only when N > 0), what N counts (cards on THIS checklist whose attention
 * includes `missingTeam` — not every attention kind), that it fills the set
 * rather than the open node, that its results land in the checklist's own
 * notice line (structurally an alert on a failed check), and that the row it
 * sits in stays mounted while a fill it started is open even when the fill
 * empties the lane underneath it.
 *
 * The dialog's own states, copy and ledger are covered in
 * FillTeamsControl.test.tsx. Heavy children that play no part here are
 * stubbed so the mocked Convex surface stays small; the real
 * `ChecklistSourceFilter` (its `Chip` is the attention chip) is kept.
 */

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Id } from "../../convex/_generated/dataModel";

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
    teamFill: {
      previewTeamFill: "teamFill.previewTeamFill",
      applyTeamFill: "teamFill.applyTeamFill",
    },
    marketplacePause: { getPausedPlatforms: "getPausedPlatforms" },
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
vi.mock("./CardAttentionWalker", () => ({ default: () => null }));
vi.mock("./SkippedNamesPanel", () => ({ default: () => null }));
vi.mock("./TeamPicker", () => ({ default: () => null }));
vi.mock("./PlayerPicker", () => ({ default: () => null }));

const mockPreview = vi.fn();
const mockApply = vi.fn();

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
  useAction: (ref: string) => {
    if (ref === "teamFill.previewTeamFill") return mockPreview;
    if (ref === "teamFill.applyTeamFill") return mockApply;
    return vi.fn();
  },
  useConvex: () => ({ query: vi.fn() }),
}));

import CardChecklist from "./CardChecklist";
import { SET_ROW_ACTION_TONE_CLASSES } from "./SetRowActionButton";

const VARIANT_ID = "variant-1" as unknown as Id<"selectorOptions">;
const SET_ID = "set-1" as unknown as Id<"selectorOptions">;

/** No team, lookup settled: `missingTeam`. */
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

function settled(n: number) {
  return teamless(n, { cardName: `Settled ${n}`, teamOnCardIds: ["team-1"] });
}

/** `null` renders with no set id at all (a default parameter would swallow `undefined`). */
function ui(setId: Id<"selectorOptions"> | null = SET_ID) {
  return (
    <CardChecklist
      variantId={VARIANT_ID}
      sourceChips={{}}
      sourceLabelMaps={{ bsc: {}, sportlots: {} }}
      setId={setId ?? undefined}
    />
  );
}

function makePreview(fillable: number) {
  return {
    candidates: fillable,
    fillable,
    byRule: { samePlayerInSet: fillable, oneTeamCareer: 0, oneStintInYear: 0 },
    remaining: 0,
    setYear: 2026,
    groups: [
      {
        playerNames: ["Johnny Bench"],
        teamNames: ["Cincinnati Reds"],
        rule: "samePlayerInSet",
        scope: "sameNode",
        mixed: false,
        nodeNames: ["Base"],
        nodeCount: 1,
        cardCount: fillable,
      },
    ],
    groupsTotal: 1,
  };
}

const attentionChip = () =>
  screen.getByRole("button", { name: /Show only cards needing attention/ });

describe("CardChecklist — Fill N missing teams (NEO-306)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.cards = [teamless(1), teamless(2), overLongTitle(3), settled(4)];
  });

  it("renders beside the attention chip as the amber attention pill, counting only missing-team cards", () => {
    render(ui());
    // Three cards need attention, two of them for a missing team.
    expect(attentionChip().textContent).toContain("3 need attention");
    const fill = screen.getByRole("button", { name: "Fill 2 missing teams" });
    // Directly after the chip, in the same row.
    expect(attentionChip().nextElementSibling).toBe(fill);
    for (const cls of SET_ROW_ACTION_TONE_CLASSES.attention.split(" ")) {
      expect(fill.classList.contains(cls)).toBe(true);
    }
    expect(fill.getAttribute("aria-label")).toBeNull();
  });

  it("is singular for one card", () => {
    state.cards = [teamless(1), settled(2)];
    render(ui());
    expect(screen.getByRole("button", { name: "Fill 1 missing team" })).toBeTruthy();
  });

  it("is absent when no card on the checklist is missing a team, even with other attention", () => {
    state.cards = [overLongTitle(1), settled(2)];
    render(ui());
    expect(attentionChip()).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Fill\b/ })).toBeNull();
  });

  it("is absent without the set id — it never guesses the set from the open node", () => {
    render(ui(null));
    expect(screen.queryByRole("button", { name: /^Fill\b/ })).toBeNull();
  });

  it("previews and fills the SET, not the checklist's own node", async () => {
    mockPreview.mockResolvedValue(makePreview(2));
    mockApply.mockResolvedValue({
      applied: 2,
      skipped: 0,
      byRule: { samePlayerInSet: 2, oneTeamCareer: 0, oneStintInYear: 0 },
    });
    render(ui());
    fireEvent.click(screen.getByRole("button", { name: "Fill 2 missing teams" }));
    await screen.findByRole("dialog");
    expect(mockPreview).toHaveBeenCalledWith({ selectorOptionId: SET_ID });
    fireEvent.click(screen.getByRole("button", { name: "Yes, fill" }));
    await waitFor(() =>
      expect(mockApply).toHaveBeenCalledWith({ selectorOptionId: SET_ID, expectedFillable: 2 }),
    );
  });

  it("reports the result in the checklist's notice line, and keeps its row up until the dialog closes even when the fill empties the lane", async () => {
    state.cards = [teamless(1), settled(2)];
    mockPreview.mockResolvedValue(makePreview(1));
    let resolveApply!: (value: unknown) => void;
    mockApply.mockReturnValue(
      new Promise((resolve) => {
        resolveApply = resolve;
      }),
    );
    const { rerender } = render(ui());
    fireEvent.click(screen.getByRole("button", { name: "Fill 1 missing team" }));
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Yes, fill" }));

    // The fill lands on the card before the action resolves: nothing needs
    // attention any more. The row — and the dialog in it — stays.
    state.cards = [settled(1), settled(2)];
    rerender(ui());
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Filling…" })).toBeTruthy();

    await act(async () => {
      resolveApply({
        applied: 1,
        skipped: 0,
        byRule: { samePlayerInSet: 1, oneTeamCareer: 0, oneStintInYear: 0 },
      });
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const notice = screen
      .getAllByRole("status")
      .find((el) => el.textContent === "Filled teams on 1 card");
    expect(notice).toBeTruthy();
    // Window closed, nothing left: the row and the trigger are gone.
    expect(screen.queryByRole("button", { name: /^Fill\b/ })).toBeNull();
    expect(screen.queryByText(/need attention/)).toBeNull();
  });

  it("a failed check is an alert in the notice line, never a quiet status", async () => {
    mockPreview.mockRejectedValue(new Error("network blew up"));
    render(ui());
    fireEvent.click(screen.getByRole("button", { name: "Fill 2 missing teams" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Failed: Could not check the cards. Nothing changed.");
  });

  it("names nothing in the row the same as anything else in it", () => {
    render(ui());
    const row = attentionChip().parentElement!;
    const names = within(row)
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label") ?? b.textContent ?? "");
    for (const a of names) {
      for (const b of names) {
        if (a === b) continue;
        expect(a.includes(b)).toBe(false);
      }
    }
  });
});
