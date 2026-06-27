/**
 * NEO-47 — EntityColumn new "ensureSync" path (sync redesign).
 *
 * The legacy path stranded a column in sync mode when the form's onDone handoff
 * was dropped (the #28 stuck-"Syncing" race). The new path has NO sync mode and
 * NO onDone: the column's display is derived purely from the reactive
 * selectorSyncStatus query, so the dropped-handoff race is structurally
 * impossible. These deterministic tests pin that behavior:
 *   1. empty column → triggers ensureSelectorOptions once + shows "+ Custom"
 *      immediately (no sync mode hiding it).
 *   2. status=syncing → loading box (flow-asserted heading) + "+ Custom" hidden.
 *   3. status=error → error message, "+ Custom" still available (not stranded).
 *
 * Mocking mirrors EntityColumn.field-class.test.tsx but branches useQuery /
 * useMutation by reference so items vs syncStatus (and ensure vs addCustom) can
 * be controlled independently.
 */

import { act, render } from "@testing-library/react";
import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../../convex/_generated/api", () => ({
  api: {
    selectorOptions: {
      getSelectorOptions: "getSelectorOptions",
      getSelectorSyncStatus: "getSelectorSyncStatus",
      addCustomSelectorOption: "addCustomSelectorOption",
      ensureSelectorOptions: "ensureSelectorOptions",
    },
  },
}));

const mockEnsure = vi.fn();
const mockAddCustom = vi.fn();
// Mutable holders read lazily by the mocked hooks at call time.
const state: { items: unknown; status: unknown } = {
  items: undefined,
  status: null,
};

vi.mock("convex/react", () => ({
  useMutation: () => mockAddCustom,
  useAction: (ref: string) =>
    ref === "ensureSelectorOptions" ? mockEnsure : vi.fn(),
  useQuery: (ref: string) =>
    ref === "getSelectorSyncStatus" ? state.status : state.items,
}));

import EntityColumn from "./EntityColumn";

function renderVT() {
  return render(
    <EntityColumn
      selector={<div>selector</div>}
      renderForm={() => <div>legacy-form</div>}
      addButtonText="Sync Variant Types"
      isVisible={true}
      level="variantType"
      useEnsureSync
      syncingLabel="Syncing Variant Types"
    />,
  );
}

describe("EntityColumn — ensureSync new path (NEO-47)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.items = undefined;
    state.status = null;
    mockEnsure.mockResolvedValue({ scheduled: true, reason: "scheduled" });
  });

  it("empty column triggers ensureSelectorOptions once + shows + Custom (no sync mode, no legacy form)", async () => {
    state.items = [];
    state.status = null;
    const { getByText, queryByText } = renderVT();
    await act(async () => {});
    expect(mockEnsure).toHaveBeenCalledTimes(1);
    expect(getByText("+ Custom")).toBeTruthy();
    expect(queryByText("Syncing Variant Types")).toBeNull();
    expect(queryByText("legacy-form")).toBeNull();
  });

  it("status=syncing shows the loading box heading and hides + Custom", async () => {
    state.items = [];
    state.status = { status: "syncing" };
    const { getByText, queryByText } = renderVT();
    await act(async () => {});
    expect(getByText("Syncing Variant Types")).toBeTruthy();
    expect(queryByText("+ Custom")).toBeNull();
    expect(queryByText("legacy-form")).toBeNull();
  });

  it("status=error surfaces the message but keeps + Custom available (not stranded)", async () => {
    state.items = [];
    state.status = { status: "error", message: "Couldn't sync options." };
    const { getByText } = renderVT();
    await act(async () => {});
    expect(getByText("Couldn't sync options.")).toBeTruthy();
    expect(getByText("+ Custom")).toBeTruthy();
  });
});
