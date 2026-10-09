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
      getAncestorChain: "getAncestorChain",
      findSelectorOptionElsewhere: "findSelectorOptionElsewhere",
    },
  },
}));

// convex/react — useMutation returns the addCustom spy; useQuery returns the
// controlled items list. Each test reconfigures these before rendering.
const mockAddCustom = vi.fn();
const mockQuery = vi.fn();
// NEO-219: the cross-parent duplicate lookup is a one-shot client query, not a
// subscription. Default: nothing found anywhere, which is the plain-create path.
const mockFindElsewhere = vi.fn();

vi.mock("convex/react", () => ({
  useMutation: () => mockAddCustom,
  useAction: () => vi.fn(),
  useConvex: () => ({ query: (...args: unknown[]) => mockFindElsewhere(...args) }),
  useQuery: (ref: string) =>
    ref === "getAncestorChain" ? undefined : mockQuery(),
}));

// ---------------------------------------------------------------------------
// Component under test — imported AFTER the mocks are declared above
// ---------------------------------------------------------------------------

import EntityColumn from "./EntityColumn";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Two existing options at the "sport" column: one that came from a sync and
// one that was typed in by hand. NEO-239: the rows are indistinguishable — a
// set either carries marketplace ids or it does not, and both behave the same
// here — so the fixture no longer flags one of them.
// `value` is what the user types to match; `_id` is what onSelectExisting must
// receive. The other fields satisfy the row shape EntityColumn reads.
const EXISTING_ITEMS = [
  {
    _id: "sport-football-id" as unknown as OptionId,
    value: "Football",
  },
  {
    _id: "sport-cricket-id" as unknown as OptionId,
    value: "Cricket",
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

/**
 * NEO-219: a genuinely-new value no longer writes on the first Enter — it opens
 * a confirm whose primary button ("Create") already has focus, so the keyboard
 * flow is type → Enter → Enter. Tests that assert the WRITE press it.
 */
async function confirmCreate() {
  await waitFor(() => {
    expect(screen.getByText("Create")).toBeTruthy();
  });
  await act(async () => {
    fireEvent.click(screen.getByText("Create"));
  });
}

describe("EntityColumn — '+ Custom' select-on-match (NEO-46)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Every test runs with the two existing options present.
    mockQuery.mockReturnValue(EXISTING_ITEMS);
    // Default resolve so the new-value path never rejects unexpectedly.
    mockAddCustom.mockResolvedValue("newly-created-id");
    mockFindElsewhere.mockResolvedValue([]);
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
    // NEO-219: the first Enter opens the confirm and writes nothing.
    expect(mockAddCustom).not.toHaveBeenCalled();
    await confirmCreate();

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

describe("EntityColumn — '+ Custom' when two rows already carry the name (NEO-325)", () => {
  const TWIN_ITEMS = [
    {
      _id: "anime-a" as unknown as OptionId,
      value: "Anime",
      platformData: { sportlots: { s0: "111" } },
    },
    {
      _id: "anime-b" as unknown as OptionId,
      value: "Anime",
      platformData: { sportlots: { s0: "222" } },
    },
    { _id: "sport-solo-id" as unknown as OptionId, value: "Solo" },
  ];
  const pickButtons = () =>
    screen.getAllByRole("button", { name: /^Go to sport / }) as HTMLButtonElement[];

  beforeEach(() => {
    vi.clearAllMocks();
    mockQuery.mockReturnValue(TWIN_ITEMS);
    mockAddCustom.mockResolvedValue("newly-created-id");
    mockFindElsewhere.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("a name two rows carry opens the picker: nothing is selected or created until the operator picks", async () => {
    const onSelectExisting = vi.fn();

    await submitCustomValue("anime", onSelectExisting);

    await waitFor(() => expect(pickButtons()).toHaveLength(2));
    expect(onSelectExisting).not.toHaveBeenCalled();
    expect(mockAddCustom).not.toHaveBeenCalled();
    // Told apart by the ids the column list shows for them.
    expect(pickButtons().map((b) => b.textContent)).toEqual([
      "Anime (#111)",
      "Anime (#222)",
    ]);
  });

  it("picking one selects that row's id, and only that", async () => {
    const onSelectExisting = vi.fn();
    await submitCustomValue("Anime", onSelectExisting);
    await waitFor(() => expect(pickButtons()).toHaveLength(2));

    await act(async () => {
      fireEvent.click(pickButtons()[1]);
    });

    expect(onSelectExisting).toHaveBeenCalledTimes(1);
    expect(onSelectExisting).toHaveBeenCalledWith("anime-b");
    expect(mockAddCustom).not.toHaveBeenCalled();
    // The picker is gone and the custom field is closed again.
    expect(screen.queryAllByRole("button", { name: /^Go to sport / })).toHaveLength(0);
  });

  it("Back returns to the typed name without selecting anything", async () => {
    const onSelectExisting = vi.fn();
    await submitCustomValue("Anime", onSelectExisting);
    await waitFor(() => expect(pickButtons()).toHaveLength(2));

    await act(async () => {
      fireEvent.click(screen.getByText("Back"));
    });

    expect(screen.getByPlaceholderText("Enter custom value...")).toBeTruthy();
    expect(onSelectExisting).not.toHaveBeenCalled();
    expect(mockAddCustom).not.toHaveBeenCalled();
  });

  it("exactly one row with the name is still selected straight away", async () => {
    const onSelectExisting = vi.fn();

    await submitCustomValue("Solo", onSelectExisting);

    await waitFor(() => expect(onSelectExisting).toHaveBeenCalledWith("sport-solo-id"));
    expect(screen.queryAllByRole("button", { name: /^Go to sport / })).toHaveLength(0);
  });

  it("a server CUSTOM_NAME_SHARED (the rows arrived after the list loaded) opens the same picker with '+ N more'", async () => {
    mockQuery.mockReturnValue([{ _id: "sport-solo-id" as unknown as OptionId, value: "Solo" }]);
    mockAddCustom.mockRejectedValueOnce({
      data: {
        code: "CUSTOM_NAME_SHARED",
        matches: [
          { _id: "anime-a", value: "Anime", path: [] },
          { _id: "anime-b", value: "Anime", path: [] },
        ],
        total: 5,
      },
    });
    const onSelectExisting = vi.fn();

    await submitCustomValue("Anime", onSelectExisting);
    await confirmCreate();

    await waitFor(() => expect(pickButtons()).toHaveLength(2));
    expect(mockAddCustom).toHaveBeenCalledTimes(1);
    // The list the column holds cannot tell them apart, so their place does.
    expect(pickButtons().map((b) => b.textContent)).toEqual([
      "Anime, 1 of 2",
      "Anime, 2 of 2",
    ]);
    expect(screen.getByText("+ 3 more")).toBeTruthy();
    expect(onSelectExisting).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(pickButtons()[0]);
    });
    expect(onSelectExisting).toHaveBeenCalledWith("anime-a");
  });
});
