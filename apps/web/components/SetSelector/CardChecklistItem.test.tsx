/**
 * NEO-71-74 regression coverage — CardChecklistItem row-level onEdit.
 *
 * The whole row `<div>` now carries `onClick={() => onEdit(card._id)}`
 * (previously only the inner name/subtitle div did — clicking the card
 * number, badges, or empty row space silently did nothing). The Edit/
 * Delete/Confirm-delete buttons call `e.stopPropagation()` in their own
 * onClick handlers so clicking them doesn't ALSO trigger the row-level
 * onEdit redundantly.
 *
 * This file locks in:
 *   1. Clicking anywhere on the row (e.g. the card number, not just the
 *      name) calls onEdit.
 *   2. Clicking the Edit button calls onEdit exactly once (not twice via
 *      bubbling).
 *   3. Clicking Delete then Confirm calls the delete mutation and does NOT
 *      also call onEdit.
 *
 * --- Mocking strategy (mirrors CardFeaturesEditor.test.tsx) ---
 * convex/react's useQuery/useMutation are module-mocked, routed by the
 * (string-mocked) query/mutation reference.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks — declared before the component import
// ---------------------------------------------------------------------------

vi.mock("../../convex/_generated/api", () => ({
  api: {
    teams: {
      getManyByIds: "teams.getManyByIds",
    },
    selectorOptions: {
      deleteCard: "deleteCard",
    },
  },
}));

const mockDeleteCard = vi.fn();

vi.mock("convex/react", () => ({
  useQuery: () => undefined,
  useMutation: (ref: string) => (ref === "deleteCard" ? mockDeleteCard : vi.fn()),
}));

// ---------------------------------------------------------------------------
// Component under test — imported after mocks
// ---------------------------------------------------------------------------

import CardChecklistItem from "./CardChecklistItem";
import type { Id } from "../../convex/_generated/dataModel";

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

const CARD_ID = "card-1" as unknown as Id<"cardChecklist">;

function makeCard(overrides: Partial<Parameters<typeof CardChecklistItem>[0]["card"]> = {}) {
  return {
    _id: CARD_ID,
    selectorOptionId: "vt-1" as unknown as Id<"selectorOptions">,
    cardNumber: "42",
    cardName: "Mike Trout",
    platformData: {},
    ...overrides,
  };
}

function renderItem(
  props: Partial<Parameters<typeof CardChecklistItem>[0]> = {},
) {
  const onEdit = vi.fn();
  const utils = render(
    <CardChecklistItem card={makeCard()} onEdit={onEdit} {...props} />,
  );
  return { ...utils, onEdit };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CardChecklistItem", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDeleteCard.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("clicking the card number area (not just the name) calls onEdit", () => {
    const { onEdit } = renderItem();

    fireEvent.click(screen.getByText("#42"));

    expect(onEdit).toHaveBeenCalledWith(CARD_ID);
  });

  it("clicking empty row space (the row container itself) calls onEdit", () => {
    const { onEdit, container } = renderItem();

    fireEvent.click(container.firstElementChild as Element);

    expect(onEdit).toHaveBeenCalledWith(CARD_ID);
  });

  it("clicking the card name calls onEdit", () => {
    const { onEdit } = renderItem();

    fireEvent.click(screen.getByText("Mike Trout"));

    expect(onEdit).toHaveBeenCalledWith(CARD_ID);
  });

  it("clicking the Edit button calls onEdit exactly once (stopPropagation prevents a second, bubbled call)", () => {
    const { onEdit } = renderItem();

    fireEvent.click(screen.getByLabelText("Edit card 42"));

    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onEdit).toHaveBeenCalledWith(CARD_ID);
  });

  it("clicking Delete then Confirm calls the delete mutation and does NOT also call onEdit", async () => {
    const { onEdit } = renderItem();

    fireEvent.click(screen.getByLabelText("Delete card 42"));
    fireEvent.click(screen.getByLabelText("Confirm delete card 42"));

    expect(mockDeleteCard).toHaveBeenCalledWith({ id: CARD_ID });
    expect(onEdit).not.toHaveBeenCalled();
  });

  it("clicking Delete (without confirming) does not call onEdit or the delete mutation", () => {
    const { onEdit } = renderItem();

    fireEvent.click(screen.getByLabelText("Delete card 42"));

    expect(onEdit).not.toHaveBeenCalled();
    expect(mockDeleteCard).not.toHaveBeenCalled();
    // The button flips into a "Confirm?" state instead.
    expect(screen.getByLabelText("Confirm delete card 42")).toBeTruthy();
  });
});

/**
 * NEO-189 — variation grouping.
 *
 * Covers what the click-behaviour tests above never touched: the subtitle
 * composition (parent "N variations" count, child "Variation of #X", and
 * cardVariation), the disclosure's aria-expanded + label flip, the
 * always-present fixed-width disclosure slot (so row width never depends on
 * whether a given row has variations — that stability is what keeps the
 * virtualized list from re-measuring), and that the disclosure's click does
 * NOT also open the card detail panel.
 */
describe("CardChecklistItem — variation grouping (NEO-189)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDeleteCard.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("a parent's subtitle reports its variation count, pluralized", () => {
    renderItem({ variationCount: 3 });
    expect(screen.getByText("3 variations")).toBeTruthy();
  });

  it("a parent's subtitle uses the singular for exactly one variation", () => {
    renderItem({ variationCount: 1 });
    expect(screen.getByText("1 variation")).toBeTruthy();
  });

  it("a variation row's subtitle names its parent by card number", () => {
    renderItem({ isVariation: true, parentCardNumber: "11" });
    expect(screen.getByText("Variation of #11")).toBeTruthy();
  });

  it("cardVariation appears in the subtitle line alongside other parts", () => {
    const { container } = renderItem({
      card: makeCard({ cardVariation: "Refractor", printRun: 99 }),
    });
    // Composed as "<team> · /99 · Refractor · ..." — assert the whole line
    // rather than a lone getByText so the join-with-others is exercised too.
    const subtitle = container.querySelector(".truncate.min-h-\\[1rem\\]");
    expect(subtitle?.textContent).toBe("/99 · Refractor");
  });

  it("a variation row's subtitle joins 'Variation of #X' with its own cardVariation", () => {
    renderItem({
      isVariation: true,
      parentCardNumber: "13",
      card: makeCard({ cardVariation: "Pointing Up" }),
    });
    expect(
      screen.getByText("Variation of #13 · Pointing Up"),
    ).toBeTruthy();
  });

  it("the disclosure slot is present even on a row with no variations (fixed-width, so row widths never vary by content)", () => {
    const { container } = renderItem();
    // No variationCount/onToggleVariations passed — the slot span still
    // renders, just empty, so this row is exactly as wide as one with
    // variations.
    const slot = container.querySelector(".w-6.h-6.shrink-0");
    expect(slot).toBeTruthy();
    expect(slot?.querySelector("button")).toBeNull();
  });

  it("the disclosure slot is present and populated on a parent row with variations", () => {
    const onToggleVariations = vi.fn();
    renderItem({ variationCount: 2, onToggleVariations });
    const slot = document.querySelector(".w-6.h-6.shrink-0");
    expect(slot?.querySelector("button")).toBeTruthy();
  });

  it('disclosure aria-expanded is false and labelled "Show" when collapsed', () => {
    renderItem({
      variationCount: 2,
      isExpanded: false,
      onToggleVariations: vi.fn(),
    });
    const disclosure = screen.getByLabelText("Show 2 variations of card 42");
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
  });

  it('disclosure aria-expanded is true and labelled "Hide" when expanded', () => {
    renderItem({
      variationCount: 2,
      isExpanded: true,
      onToggleVariations: vi.fn(),
    });
    const disclosure = screen.getByLabelText("Hide 2 variations of card 42");
    expect(disclosure.getAttribute("aria-expanded")).toBe("true");
  });

  it("the disclosure label uses the singular for exactly one variation", () => {
    renderItem({
      variationCount: 1,
      isExpanded: false,
      onToggleVariations: vi.fn(),
    });
    expect(screen.getByLabelText("Show 1 variation of card 42")).toBeTruthy();
  });

  it("clicking the disclosure toggles variations and does NOT also open the card detail panel", () => {
    const onToggleVariations = vi.fn();
    const { onEdit } = renderItem({
      variationCount: 2,
      isExpanded: false,
      onToggleVariations,
    });

    fireEvent.click(screen.getByLabelText("Show 2 variations of card 42"));

    expect(onToggleVariations).toHaveBeenCalledWith(CARD_ID);
    expect(onEdit).not.toHaveBeenCalled();
  });
});
