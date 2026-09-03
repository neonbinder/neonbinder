/**
 * NEO-101 — `TitleFixer`, the attention-walker fixer for the three
 * title-shaped kinds.
 *
 * The behaviours worth pinning are the ones the locked fixer contract makes
 * possible but does not enforce:
 *
 *   1. it reads ALL of the card's items, not just the one that routed to it —
 *      a card flagged twice must be asked once;
 *   2. it writes only the fields it showed, so it cannot stomp a field it never
 *      asked about;
 *   3. it calls `onSaved()` only after the write lands, because the walker
 *      counts that call as "fixed" and advances on it;
 *   4. over the cap it refuses, in a way that a keyboard user can still reach
 *      the reason for.
 *
 * `convex/react` is module-mocked and routed by the (string-mocked) reference,
 * mirroring `CardAttentionWalker.test.tsx`.
 */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConvexError } from "convex/values";
import type { Id } from "../../convex/_generated/dataModel";

vi.mock("../../convex/_generated/api", () => ({
  api: {
    selectorOptions: {
      updateCard: "updateCard",
      previewListingTitle: "previewListingTitle",
    },
  },
}));

const mockUpdateCard = vi.fn();
let previewResult: unknown;

vi.mock("convex/react", () => ({
  useMutation: (ref: string) => (ref === "updateCard" ? mockUpdateCard : vi.fn()),
  useQuery: (ref: string, args: unknown) =>
    ref === "previewListingTitle" && args !== "skip" ? previewResult : undefined,
}));

import TitleFixer from "./TitleFixer";
import type { AttentionItem } from "./card-attention";
import type { CardChecklistRow } from "./cardAttentionRegistry";

const CARD_ID = "card-1" as unknown as Id<"cardChecklist">;

function makeRow(overrides: Partial<CardChecklistRow> = {}): CardChecklistRow {
  return {
    _id: CARD_ID,
    cardNumber: "300b",
    cardName: "Julio Rodriguez",
    listingTitle: "2024 Topps Chrome Julio Rodriguez #300b",
    ...overrides,
  };
}

function renderFixer(items: AttentionItem[], row = makeRow()) {
  const onSaved = vi.fn();
  const onSkip = vi.fn();
  render(<TitleFixer row={row} items={items} onSaved={onSaved} onSkip={onSkip} />);
  return { onSaved, onSkip };
}

const overLimit = (length: number): AttentionItem =>
  ({ kind: "titleOverLimit", length }) as AttentionItem;
const truncated = (): AttentionItem => ({ kind: "titleTruncated" }) as AttentionItem;
const aspectOver = (length: number): AttentionItem =>
  ({
    kind: "aspectValueOverLimit",
    field: "cardVariation",
    length,
  }) as AttentionItem;

const titleField = () =>
  screen.getByLabelText("Card title for #300b") as HTMLInputElement;
const saveButton = () => screen.getByRole("button", { name: /^Save/ });

beforeEach(() => {
  vi.clearAllMocks();
  mockUpdateCard.mockResolvedValue(undefined);
  previewResult = {
    title: "2024 Topps Chrome Julio Rodriguez #300b",
    coreFits: false,
    dropped: ["SP"],
    inputs: {
      cardNumber: "300b",
      playerNames: ["Julio Rodriguez"],
      year: "2024",
      setName: "Topps Chrome",
      teamNames: ["Seattle Mariners"],
      sport: "Baseball",
    },
  };
});

describe("TitleFixer (NEO-101)", () => {
  it("anchors on the card number and states every reason the card was flagged", () => {
    renderFixer([overLimit(84), truncated()]);

    expect(screen.getByText(/#300b/)).toBeTruthy();
    expect(screen.getByText("Julio Rodriguez", { exact: false })).toBeTruthy();
    expect(screen.getByText("title is over the 80-character limit")).toBeTruthy();
    expect(screen.getByText("auto-generated title was cut short")).toBeTruthy();
  });

  it("pre-fills the stored title and focuses it, so the operator can just type", async () => {
    renderFixer([truncated()], makeRow({ listingTitle: "2024 Topps Chrome #300b" }));

    expect(titleField().value).toBe("2024 Topps Chrome #300b");
    await waitFor(() => expect(document.activeElement).toBe(titleField()));
  });

  it("refuses to save over the cap and keeps the reason reachable", async () => {
    renderFixer([overLimit(84)], makeRow({ listingTitle: "z".repeat(84) }));

    expect(screen.getByText("84/80")).toBeTruthy();
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("4 over the 80-character limit");

    const save = saveButton();
    expect(save.getAttribute("aria-disabled")).toBe("true");
    expect(save.hasAttribute("disabled")).toBe(false);
    expect(save.getAttribute("aria-describedby")).toBe(alert.id);

    await act(async () => {
      fireEvent.click(save);
    });
    expect(mockUpdateCard).not.toHaveBeenCalled();
  });

  it("writes the trimmed title, then reports the fix so the walker advances", async () => {
    const { onSaved } = renderFixer([overLimit(84)]);

    fireEvent.change(titleField(), { target: { value: "  2024 Topps Chrome #300b  " } });
    await act(async () => {
      fireEvent.click(saveButton());
    });

    await waitFor(() =>
      expect(mockUpdateCard).toHaveBeenCalledWith({
        id: CARD_ID,
        listingTitle: "2024 Topps Chrome #300b",
      }),
    );
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it("saves on Enter in the title field", async () => {
    const { onSaved } = renderFixer([overLimit(84)]);

    fireEvent.change(titleField(), { target: { value: "2024 Topps Chrome #300b" } });
    await act(async () => {
      fireEvent.keyDown(titleField(), { key: "Enter" });
    });

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(mockUpdateCard.mock.calls[0][0].listingTitle).toBe(
      "2024 Topps Chrome #300b",
    );
  });

  it("does not save on Enter while the title is over the cap", async () => {
    const { onSaved } = renderFixer([overLimit(84)], makeRow({ listingTitle: "z".repeat(84) }));

    await act(async () => {
      fireEvent.keyDown(titleField(), { key: "Enter" });
    });

    expect(mockUpdateCard).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("shows the variation field only when the variation is what is over the limit", () => {
    renderFixer([overLimit(84)]);
    expect(screen.queryByLabelText("Card variation for #300b")).toBeNull();
  });

  it("edits and writes the variation when that is the flagged field", async () => {
    const { onSaved } = renderFixer(
      [aspectOver(70)],
      makeRow({ listingTitle: "2024 Topps Chrome #300b", cardVariation: "v".repeat(70) }),
    );

    const variation = screen.getByLabelText(
      "Card variation for #300b",
    ) as HTMLInputElement;
    expect(variation.value.length).toBe(70);
    expect(screen.getByText("70/65")).toBeTruthy();
    // Warn-only: an over-length variation must not block the write.
    expect(saveButton().getAttribute("aria-disabled")).toBeNull();

    fireEvent.change(variation, { target: { value: " Image Variation " } });
    await act(async () => {
      fireEvent.click(saveButton());
    });

    await waitFor(() =>
      expect(mockUpdateCard).toHaveBeenCalledWith({
        id: CARD_ID,
        listingTitle: "2024 Topps Chrome #300b",
        cardVariation: "Image Variation",
      }),
    );
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it("Regenerate rebuilds the title and shows what it was built from", async () => {
    renderFixer([truncated()], makeRow({ listingTitle: "2024 Topps #300b" }));

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Regenerate card title"));
    });

    await waitFor(() =>
      expect(titleField().value).toBe("2024 Topps Chrome Julio Rodriguez #300b"),
    );
    const chips = screen.getByLabelText("Title built from");
    expect(chips.textContent).toContain("Topps Chrome");
    expect(chips.textContent).toContain("#300b");
    expect(chips.textContent).toContain("Seattle Mariners");
    expect(chips.textContent).toContain("Baseball");
    expect(chips.querySelector("a")).toBeNull();
    expect(screen.getByText("Left out to fit: SP")).toBeTruthy();
  });

  it("renders no team or sport chip when the preview carries neither", async () => {
    previewResult = {
      title: "2024 Topps Chrome Julio Rodriguez #300b",
      coreFits: true,
      dropped: [],
      inputs: { cardNumber: "300b", playerNames: ["Julio Rodriguez"], year: "2024" },
    };
    renderFixer([truncated()], makeRow({ listingTitle: "2024 Topps #300b" }));

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Regenerate card title"));
    });

    const chips = await screen.findByLabelText("Title built from");
    expect(chips.textContent).toContain("Julio Rodriguez");
    expect(chips.textContent).not.toContain("Team");
    expect(chips.textContent).not.toContain("Sport");
    expect(chips.textContent).not.toContain("undefined");
  });

  it("surfaces a refused write inline, and does not report a fix that did not land", async () => {
    mockUpdateCard.mockRejectedValueOnce(
      new ConvexError("Listing title is 84 characters; the limit is 80."),
    );
    const { onSaved } = renderFixer([overLimit(84)]);

    fireEvent.change(titleField(), { target: { value: "2024 Topps Chrome #300b" } });
    await act(async () => {
      fireEvent.click(saveButton());
    });

    await waitFor(() =>
      expect(
        screen.getByText("Listing title is 84 characters; the limit is 80."),
      ).toBeTruthy(),
    );
    expect(onSaved).not.toHaveBeenCalled();
  });
});
