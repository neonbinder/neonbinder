/**
 * NEO-358 — a card delete the server refuses is said, not swallowed.
 *
 * `deleteCard` refuses a card collectors own with a ConvexError carrying a
 * counted sentence ("Hold up! 3 collectors have this card, so it stays in the
 * catalog.", `lib/collection/collectors.ts`). The row used to await it with no
 * catch: an unhandled rejection, nothing on screen, and "Confirm?" left up.
 *
 * Pinned end to end through the REAL row inside the checklist: the sentence
 * lands in the checklist's notice banner as an alert (the set builder's one
 * live region for results, not a new region per virtualised row), the confirm
 * closes, focus is back on the row's Del control, and the same refusal twice
 * is announced twice (the banner remounts on a repeat).
 *
 * Harness: the same stubs as CardChecklist.search.test.tsx, with `deleteCard`
 * routed to a mock.
 */

import { act, fireEvent, render, screen } from "@testing-library/react";
import { ConvexError } from "convex/values";
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
      deleteCard: "deleteCard",
      removeCrossListing: "removeCrossListing",
    },
    checklistCandidates: {
      getReadyCandidates: "getReadyCandidates",
      discardCandidates: "discardCandidates",
    },
    marketplacePause: { getPausedPlatforms: "getPausedPlatforms" },
    entityReviewSkips: { listForSet: "entityReviewSkips.listForSet" },
    teams: { getManyByIds: "teams.getManyByIds" },
    players: { getManyByIds: "players.getManyByIds" },
  },
}));

vi.mock("react-virtuoso", () => ({
  Virtuoso: function VirtuosoStub({
    data,
    itemContent,
    computeItemKey,
  }: {
    data: unknown[];
    itemContent: (index: number, item: unknown) => React.ReactNode;
    computeItemKey?: (index: number, item: unknown) => React.Key;
  }) {
    return (
      <div>
        {data.map((item, i) => (
          <div key={computeItemKey ? computeItemKey(i, item) : i}>
            {itemContent(i, item)}
          </div>
        ))}
      </div>
    );
  },
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

const mockDeleteCard = vi.fn();
const state: { cards: unknown[] } = { cards: [] };

vi.mock("convex/react", () => ({
  useQuery: (ref: string) => {
    if (ref === "getCardChecklist") return state.cards;
    if (ref === "getSelectorOptionById") return { value: "Base" };
    if (ref === "getAncestorChain") return [];
    if (ref === "getReadyCandidates") return null;
    if (ref === "getPausedPlatforms") return [];
    if (ref === "entityReviewSkips.listForSet") return [];
    if (ref === "teams.getManyByIds") {
      return [{ _id: "team-sd", name: "Padres", location: "San Diego" }];
    }
    return undefined;
  },
  useMutation: (ref: string) => (ref === "deleteCard" ? mockDeleteCard : vi.fn()),
  useAction: () => vi.fn(),
  useConvex: () => ({ query: vi.fn(), action: vi.fn() }),
}));

import CardChecklist from "./CardChecklist";

const VARIANT_ID = "variant-1" as unknown as Id<"selectorOptions">;
const REFUSAL =
  "Hold up! 3 collectors have this card, so it stays in the catalog.";

function card(n: string, name: string) {
  return {
    _id: `card-${n}` as unknown as Id<"cardChecklist">,
    selectorOptionId: VARIANT_ID,
    cardNumber: n,
    cardName: name,
    // Teamed and settled, so no attention row joins the toolbar.
    teamOnCardIds: ["team-sd"],
    platformData: {},
    sortOrder: 0,
    lastUpdated: 1_000,
  };
}

function ui() {
  return (
    <CardChecklist
      variantId={VARIANT_ID}
      sourceChips={{}}
      sourceLabelMaps={{ bsc: {}, sportlots: {} }}
    />
  );
}

async function deleteAndConfirm(identity: string) {
  fireEvent.click(screen.getByRole("button", { name: `Delete card ${identity}` }));
  await act(async () => {
    fireEvent.click(
      screen.getByRole("button", { name: `Confirm delete card ${identity}` }),
    );
  });
}

describe("CardChecklist — a refused card delete (NEO-358)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.cards = [card("1", "Fernando Tatís Jr."), card("6", "Manny Machado")];
  });

  it("says the server's sentence as an alert, closes the confirm and puts focus on the row's Del", async () => {
    mockDeleteCard.mockRejectedValue(new ConvexError(REFUSAL));
    render(ui());

    await deleteAndConfirm("6, Manny Machado");

    expect(mockDeleteCard).toHaveBeenCalledWith({ id: "card-6" });
    // Shown and announced: the banner is the checklist's live region, and a
    // failure makes it an alert (assertive, implied by the role).
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe(REFUSAL);
    // The confirm is gone; the row is back to its Del control, focused.
    expect(
      screen.queryByRole("button", { name: "Confirm delete card 6, Manny Machado" }),
    ).toBeNull();
    const del = screen.getByRole("button", { name: "Delete card 6, Manny Machado" });
    expect(document.activeElement).toBe(del);
    // The card is still listed.
    expect(screen.getByRole("button", { name: "Edit card 6, Manny Machado" })).toBeTruthy();
  });

  it("announces the same refusal again on a second try", async () => {
    mockDeleteCard.mockRejectedValue(new ConvexError(REFUSAL));
    render(ui());

    await deleteAndConfirm("6, Manny Machado");
    const first = screen.getByRole("alert");

    await deleteAndConfirm("6, Manny Machado");
    const second = screen.getByRole("alert");

    // A live region only speaks on a change, so the repeat remounts it.
    expect(second).not.toBe(first);
    expect(second.textContent).toBe(REFUSAL);
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Delete card 6, Manny Machado" }),
    );
  });
});
