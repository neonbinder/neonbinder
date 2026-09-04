/**
 * NEO-219 — the custom-entry form is a three-state form now.
 *
 * Before this ticket, "+ Custom" wrote on the first Enter: no validation (so
 * `2o24` became a `year` row nothing can parse), a duplicate check scoped to
 * this column only (so a set that already existed under a sibling manufacturer
 * became a second, unsyncable copy), and a `mode`/`customValue` that survived a
 * parent change (so a half-typed value could be written under a parent the
 * operator had already navigated away from).
 *
 * What this file locks in:
 *   1. client-side validation refuses `2o24` at the `year` level, inline, with
 *      NO mutation and no cross-parent lookup;
 *   2. a genuinely-new value opens a CONFIRM naming the parent it will be
 *      created under, and writes nothing until it is confirmed;
 *   3. the confirm mounts with focus already on "Create" (decision 3), and a
 *      second Enter pressed while the lookup is still in flight is replayed
 *      onto it — creating exactly ONCE, never twice;
 *   4. a value that exists under a DIFFERENT parent offers "Go to it", which
 *      drills instead of writing, and "Create here anyway", which writes with
 *      the explicit `allowDuplicateElsewhere` flag;
 *   5. a parent change clears the form.
 *
 * The select-existing path (same parent) is unchanged and lives in
 * EntityColumn.custom-select.test.tsx.
 *
 * --- Mocking strategy (mirrors EntityColumn.custom-select.test.tsx) ---
 * convex/react is module-mocked. `useQuery` is routed by the string-mocked
 * query reference so the column's items and the parent's ancestor chain are
 * controlled independently; `useConvex().query` is the one-shot cross-parent
 * lookup.
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

const mockAddCustom = vi.fn();
const mockFindElsewhere = vi.fn();
const state: {
  items: unknown;
  chain: unknown;
} = { items: [], chain: undefined };

vi.mock("convex/react", () => ({
  useMutation: () => mockAddCustom,
  useAction: () => vi.fn(),
  useConvex: () => ({
    query: (...args: unknown[]) => mockFindElsewhere(...args),
  }),
  useQuery: (ref: string) =>
    ref === "getAncestorChain" ? state.chain : state.items,
}));

// ---------------------------------------------------------------------------
// Component under test — imported AFTER the mocks are declared above
// ---------------------------------------------------------------------------

import EntityColumn from "./EntityColumn";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MFR_ID = "mfr-topps-id" as unknown as OptionId;
const OTHER_MFR_ID = "mfr-allbrands-id" as unknown as OptionId;

/** `getAncestorChain(parentId)` is root-first and includes the parent itself. */
const TOPPS_CHAIN = [
  { _id: "sport-id", level: "sport", value: "Baseball" },
  { _id: "year-id", level: "year", value: "2021" },
  { _id: MFR_ID, level: "manufacturer", value: "Topps" },
];

/** Non-empty so the column renders its idle buttons instead of auto-syncing. */
const EXISTING_ITEMS = [
  {
    _id: "set-existing-id" as unknown as OptionId,
    value: "Existing Set",
    isCustom: false,
  },
];

const MATCH_ELSEWHERE = {
  _id: "set-bowman-under-allbrands" as unknown as OptionId,
  value: "Bowman Chrome",
  parentId: OTHER_MFR_ID,
  // Root-first, INCLUDING the matched row itself — the server's contract.
  path: [
    { _id: "sport-id" as unknown as OptionId, level: "sport", value: "Baseball" },
    { _id: "year-id" as unknown as OptionId, level: "year", value: "2021" },
    { _id: OTHER_MFR_ID, level: "manufacturer", value: "All Brands" },
    {
      _id: "set-bowman-under-allbrands" as unknown as OptionId,
      level: "setName",
      value: "Bowman Chrome",
    },
  ],
};

function renderColumn(
  overrides: {
    level?: "sport" | "year" | "setName";
    parentId?: OptionId;
    onDrillToExisting?: (path: unknown) => void;
    onSelectExisting?: (id: OptionId) => void;
  } = {},
) {
  return render(
    <EntityColumn
      selector={<div>selector</div>}
      renderForm={() => <div>form</div>}
      addButtonText="Sync Sets"
      isVisible={true}
      level={overrides.level ?? "setName"}
      parentId={overrides.parentId ?? MFR_ID}
      onSelectExisting={overrides.onSelectExisting}
      onDrillToExisting={
        overrides.onDrillToExisting as EntityColumnDrill | undefined
      }
    />,
  );
}

type EntityColumnDrill = React.ComponentProps<
  typeof EntityColumn
>["onDrillToExisting"];

/** Opens "+ Custom", types `typed`, presses Enter once. */
async function typeAndSubmit(typed: string) {
  await act(async () => {
    fireEvent.click(screen.getByText("+ Custom"));
  });
  const input = screen.getByPlaceholderText(
    "Enter custom value...",
  ) as HTMLInputElement;
  await act(async () => {
    fireEvent.change(input, { target: { value: typed } });
  });
  await act(async () => {
    fireEvent.keyDown(input, { key: "Enter" });
  });
  return input;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("EntityColumn — custom-entry validation + confirm (NEO-219)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.items = EXISTING_ITEMS;
    state.chain = TOPPS_CHAIN;
    mockAddCustom.mockResolvedValue("newly-created-id");
    mockFindElsewhere.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refuses '2o24' at the year level inline, with no mutation and no lookup", async () => {
    state.chain = undefined;
    render(
      <EntityColumn
        selector={<div>selector</div>}
        renderForm={() => <div>form</div>}
        addButtonText="Sync Years"
        isVisible={true}
        level="year"
      />,
    );

    await typeAndSubmit("2o24");

    expect(screen.getByText("Year must be a four-digit number")).toBeTruthy();
    expect(mockAddCustom).not.toHaveBeenCalled();
    expect(mockFindElsewhere).not.toHaveBeenCalled();
    // Still on the input, not in a confirm.
    expect(screen.getByPlaceholderText("Enter custom value...")).toBeTruthy();
  });

  it("opens a confirm that NAMES the parent and writes nothing until Create", async () => {
    renderColumn();

    await typeAndSubmit("Bowman Chrome");

    await waitFor(() => {
      expect(
        screen.getByText("Create set 'Bowman Chrome' under 2021 › Topps?"),
      ).toBeTruthy();
    });
    expect(mockAddCustom).not.toHaveBeenCalled();
    // The heading brackets the whole interaction — eleven Maestro flows wait on
    // it appearing and then disappearing.
    expect(screen.getByText("Add Custom Entry")).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByText("Create"));
    });

    expect(mockAddCustom).toHaveBeenCalledTimes(1);
    expect(mockAddCustom).toHaveBeenCalledWith({
      level: "setName",
      value: "Bowman Chrome",
      parentId: MFR_ID,
    });
  });

  it("mounts the confirm with focus already on Create", async () => {
    renderColumn();

    await typeAndSubmit("Bowman Chrome");

    await waitFor(() => {
      expect(screen.getByText("Create")).toBeTruthy();
    });
    expect(document.activeElement?.textContent).toBe("Create");
  });

  it("Enter pressed twice in a row creates exactly ONCE", async () => {
    // Hold the cross-parent lookup open so the second Enter genuinely lands
    // mid-flight — the race the E2E drills hit, where Maestro sends two
    // pressKey: Enter commands back to back.
    let releaseLookup: ((v: unknown[]) => void) | undefined;
    mockFindElsewhere.mockReturnValue(
      new Promise<unknown[]>((resolve) => {
        releaseLookup = resolve;
      }),
    );

    renderColumn();
    const input = await typeAndSubmit("Bowman Chrome");

    // Second Enter, while the lookup is still in flight.
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    expect(mockAddCustom).not.toHaveBeenCalled();

    await act(async () => {
      releaseLookup?.([]);
    });

    await waitFor(() => {
      expect(mockAddCustom).toHaveBeenCalledTimes(1);
    });
    expect(mockAddCustom).toHaveBeenCalledWith({
      level: "setName",
      value: "Bowman Chrome",
      parentId: MFR_ID,
    });
  });

  it("offers the row that exists elsewhere; 'Go to it' drills and does NOT write", async () => {
    mockFindElsewhere.mockResolvedValue([MATCH_ELSEWHERE]);
    const onDrillToExisting = vi.fn();
    renderColumn({ onDrillToExisting });

    await typeAndSubmit("Bowman Chrome");

    await waitFor(() => {
      expect(
        screen.getByText(
          "'Bowman Chrome' already exists under 2021 › All Brands",
        ),
      ).toBeTruthy();
    });
    expect(mockFindElsewhere).toHaveBeenCalledWith(
      "findSelectorOptionElsewhere",
      { level: "setName", value: "Bowman Chrome", parentId: MFR_ID },
    );

    await act(async () => {
      fireEvent.click(screen.getByText("Go to it"));
    });

    expect(mockAddCustom).not.toHaveBeenCalled();
    expect(onDrillToExisting).toHaveBeenCalledTimes(1);
    expect(onDrillToExisting).toHaveBeenCalledWith([
      { _id: "sport-id", level: "sport" },
      { _id: "year-id", level: "year" },
      { _id: OTHER_MFR_ID, level: "manufacturer" },
      { _id: MATCH_ELSEWHERE._id, level: "setName" },
    ]);
  });

  it("'Create here anyway' sends the explicit allowDuplicateElsewhere flag", async () => {
    mockFindElsewhere.mockResolvedValue([MATCH_ELSEWHERE]);
    renderColumn({ onDrillToExisting: vi.fn() });

    await typeAndSubmit("Bowman Chrome");

    await waitFor(() => {
      expect(screen.getByText("Create here anyway")).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(screen.getByText("Create here anyway"));
    });

    expect(mockAddCustom).toHaveBeenCalledTimes(1);
    expect(mockAddCustom).toHaveBeenCalledWith({
      level: "setName",
      value: "Bowman Chrome",
      parentId: MFR_ID,
      allowDuplicateElsewhere: true,
    });
  });

  it("a parent change closes the form and clears what was typed", async () => {
    const { rerender } = renderColumn();

    await act(async () => {
      fireEvent.click(screen.getByText("+ Custom"));
    });
    const input = screen.getByPlaceholderText(
      "Enter custom value...",
    ) as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: "Half typed" } });
    });
    expect(input.value).toBe("Half typed");

    await act(async () => {
      rerender(
        <EntityColumn
          selector={<div>selector</div>}
          renderForm={() => <div>form</div>}
          addButtonText="Sync Sets"
          isVisible={true}
          level="setName"
          parentId={OTHER_MFR_ID}
        />,
      );
    });

    expect(screen.queryByText("Add Custom Entry")).toBeNull();

    // Reopening under the new parent starts empty.
    await act(async () => {
      fireEvent.click(screen.getByText("+ Custom"));
    });
    expect(
      (screen.getByPlaceholderText("Enter custom value...") as HTMLInputElement)
        .value,
    ).toBe("");
  });

  it("renders a server CUSTOM_VALUE_INVALID refusal structurally, never its raw text", async () => {
    mockAddCustom.mockRejectedValueOnce({
      message: "[Request ID: xyz] Server Error: convex/selectorOptions.ts:1801",
      data: { code: "CUSTOM_VALUE_INVALID", reason: "Year must be a four-digit number" },
    });
    renderColumn();

    await typeAndSubmit("Bowman Chrome");
    await waitFor(() => {
      expect(screen.getByText("Create")).toBeTruthy();
    });
    await act(async () => {
      fireEvent.click(screen.getByText("Create"));
    });

    const error = await screen.findByText("Year must be a four-digit number");
    expect(error.textContent).not.toContain("Request ID");
    expect(error.textContent).not.toContain("selectorOptions.ts");
  });

  it("re-offers the drill when the SERVER is the one that finds the duplicate", async () => {
    // The client lookup came back empty (a race, or a failed read), so the
    // operator got the plain create confirm — and the mutation refused.
    mockAddCustom.mockRejectedValueOnce({
      data: { code: "CUSTOM_EXISTS_ELSEWHERE", matches: [MATCH_ELSEWHERE] },
    });
    renderColumn({ onDrillToExisting: vi.fn() });

    await typeAndSubmit("Bowman Chrome");
    await waitFor(() => {
      expect(screen.getByText("Create")).toBeTruthy();
    });
    await act(async () => {
      fireEvent.click(screen.getByText("Create"));
    });

    expect(
      await screen.findByText(
        "'Bowman Chrome' already exists under 2021 › All Brands",
      ),
    ).toBeTruthy();
  });
});
