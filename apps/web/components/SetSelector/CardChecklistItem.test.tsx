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
