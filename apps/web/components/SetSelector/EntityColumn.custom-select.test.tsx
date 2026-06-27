/**
 * NEO-46 product-behavior guard — "+ Custom" select-on-match
 *
 * Product decision: typing a value into a column's "+ Custom" field that
 * ALREADY EXISTS at that column (whether marketplace-synced or a prior custom
 * entry) must be treated exactly like searching for and selecting it — it
 * drills into the existing row via the parent's level-select handler
 * (onSelectExisting) and does NOT mint a duplicate. Only a genuinely-NEW value
 * creates a custom entry through the addCustomSelectorOption mutation.
 *
 * Two branches under test:
 *   A. typed value matches an item in `items`  → onSelectExisting called with
 *      that item's _id; addCustom mutation NOT called
 *   B. typed value is brand new                → addCustom mutation called;
 *      onSelectExisting NOT called
 *
 * --- Mocking strategy (mirrors drill-forms-onDone.test.tsx) ---
 *
 * convex/react is mocked at the module level so:
 *   • useMutation returns a jest fn (the addCustom spy) we assert on
 *   • useQuery   returns the controlled `items` array that EntityColumn reads
 *
 * The convex generated api is mocked as a plain object — its members are only
 * used as useQuery/useMutation keys (compared by identity) and never reach the
 * real Convex runtime.
 *
 * NeonButton renders through @radix-ui/themes Button which produces a real
 * <button> in happy-dom, so no extra mocking is needed for it.
 */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { GenericId } from "convex/values";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type OptionId = GenericId<"selectorOptions">;

// ---------------------------------------------------------------------------
// Module mocks — hoisted before the component import resolves these paths
// ---------------------------------------------------------------------------

vi.mock("../../convex/_generated/api", () => ({
  api: {
    selectorOptions: {
      getSelectorOptions: "getSelectorOptions",
      addCustomSelectorOption: "addCustomSelectorOption",
    },
  },
}));

// convex/react — useMutation returns the addCustom spy; useQuery returns the
// controlled items list. Each test reconfigures these before rendering.
const mockAddCustom = vi.fn();
const mockQuery = vi.fn();

vi.mock("convex/react", () => ({
  useMutation: () => mockAddCustom,
  useAction: () => vi.fn(),
  useQuery: () => mockQuery(),
}));

// ---------------------------------------------------------------------------
// Component under test — imported AFTER the mocks are declared above
// ---------------------------------------------------------------------------

import EntityColumn from "./EntityColumn";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Two existing options at the "sport" column: one synced, one prior-custom.
// `value` is what the user types to match; `_id` is what onSelectExisting must
// receive. The other fields satisfy the row shape EntityColumn reads.
const EXISTING_ITEMS = [
  {
    _id: "sport-football-id" as unknown as OptionId,
    value: "Football",
    isCustom: false,
  },
  {
    _id: "sport-cricket-id" as unknown as OptionId,
    value: "Cricket",
    isCustom: true,
  },
];

// Renders the column already in "custom" mode by clicking "+ Custom", then
// types `typed` into the input and presses Enter to submit.
async function submitCustomValue(
  typed: string,
  onSelectExisting?: (id: OptionId) => void,
) {
  await act(async () => {
    render(
      <EntityColumn
        selector={<div>selector</div>}
        renderForm={() => <div>form</div>}
        addButtonText="Sync Sports"
        isVisible={true}
        level="sport"
        onSelectExisting={onSelectExisting}
      />,
    );
  });

  // Open the custom-entry form
  await act(async () => {
    fireEvent.click(screen.getByText("+ Custom"));
  });

  const input = screen.getByPlaceholderText(
    "Enter custom value...",
  ) as HTMLInputElement;

  await act(async () => {
    fireEvent.change(input, { target: { value: typed } });
  });

  // Enter submits handleCustomSubmit
  await act(async () => {
    fireEvent.keyDown(input, { key: "Enter" });
  });
}

describe("EntityColumn — '+ Custom' select-on-match (NEO-46)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Every test runs with the two existing options present.
    mockQuery.mockReturnValue(EXISTING_ITEMS);
    // Default resolve so the new-value path never rejects unexpectedly.
    mockAddCustom.mockResolvedValue("newly-created-id");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("drills into an EXISTING synced value: calls onSelectExisting with its _id, NOT the addCustom mutation", async () => {
    const onSelectExisting = vi.fn();

    await submitCustomValue("Football", onSelectExisting);

    await waitFor(() => {
      expect(onSelectExisting).toHaveBeenCalledTimes(1);
    });
    expect(onSelectExisting).toHaveBeenCalledWith("sport-football-id");
    expect(mockAddCustom).not.toHaveBeenCalled();
  });

  it("matches case-insensitively and against prior-custom entries too", async () => {
    const onSelectExisting = vi.fn();

    // "  cricket  " differs in case + surrounding whitespace from "Cricket"
    await submitCustomValue("  cricket  ", onSelectExisting);

    await waitFor(() => {
      expect(onSelectExisting).toHaveBeenCalledTimes(1);
    });
    expect(onSelectExisting).toHaveBeenCalledWith("sport-cricket-id");
    expect(mockAddCustom).not.toHaveBeenCalled();
  });

  it("creates a custom entry for a BRAND-NEW value: calls the addCustom mutation, NOT onSelectExisting", async () => {
    const onSelectExisting = vi.fn();

    await submitCustomValue("Pickleball", onSelectExisting);

    await waitFor(() => {
      expect(mockAddCustom).toHaveBeenCalledTimes(1);
    });
    expect(mockAddCustom).toHaveBeenCalledWith({
      level: "sport",
      value: "Pickleball",
      parentId: undefined,
    });
    expect(onSelectExisting).not.toHaveBeenCalled();
  });
});
