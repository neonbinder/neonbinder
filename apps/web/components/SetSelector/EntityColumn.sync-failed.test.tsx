/**
 * NEO-445 — a failed sync must not read as an empty result.
 *
 * `ensureSelectorOptions` records `status: "error"` when a column's sync fails.
 * `EntityColumn` drew that error, but `EntitySelector` kept its default line
 * above it ("No years available. Sync from marketplaces to populate."), which
 * says the marketplaces answered and had nothing. CI's ARIA snapshot of a failed
 * seed showed both, with the error below the fold of the 1024x629 viewport.
 *
 * These render the REAL column around the REAL selector: the line and the error
 * live in different components, so a test of either alone cannot see the defect.
 */

import { fireEvent, render, screen, within } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../convex/_generated/api", () => ({
  api: {
    selectorOptions: {
      getSelectorOptions: "getSelectorOptions",
      getSelectorSyncStatus: "getSelectorSyncStatus",
      ensureSelectorOptions: "ensureSelectorOptions",
    },
  },
}));

const mockEnsure = vi.fn();
const state: { items: unknown; status: unknown } = { items: [], status: null };

vi.mock("convex/react", () => ({
  useMutation: () => vi.fn(),
  useConvex: () => ({ query: vi.fn() }),
  useAction: (ref: string) =>
    ref === "ensureSelectorOptions" ? mockEnsure : vi.fn(),
  // Honours "skip", as the real hook does: the status query only runs on the
  // ensure-sync path, and the legacy-path test below depends on that.
  useQuery: (ref: string, args: unknown) => {
    if (args === "skip") return undefined;
    if (ref === "getSelectorSyncStatus") return state.status;
    if (ref === "getSelectorOptions") return state.items;
    return undefined;
  },
}));

import type { FunctionReference } from "convex/server";
import EntityColumn from "./EntityColumn";
import EntitySelector, { displayByValue } from "./EntitySelector";
import type { PinnedEntry } from "./EntitySelector";

const YEAR_PARENT = "sport-baseball" as never;
const EMPTY_LINE = "No years available. Sync from marketplaces to populate.";
const FAILED: { status: string; message: string } = {
  status: "error",
  message: "Couldn't sync options — please try again.",
};
const ALL_BRANDS: PinnedEntry[] = [
  { id: "all-brands", name: "All Brands", ariaLabel: "All Brands, every set" },
];

function selector(pinnedEntries?: PinnedEntry[]) {
  return (
    <EntitySelector
      title="Years"
      query={"getSelectorOptions" as unknown as FunctionReference<"query">}
      queryArgs={{ level: "year", parentId: YEAR_PARENT }}
      selectedId={null}
      onSelect={() => {}}
      expanded
      setExpanded={() => {}}
      getDisplayName={displayByValue}
      selectedColor="bg-pick-blue"
      pinnedEntries={pinnedEntries}
    />
  );
}

function renderYears({
  pinnedEntries,
  useEnsureSync = true,
}: { pinnedEntries?: PinnedEntry[]; useEnsureSync?: boolean } = {}) {
  return render(
    <EntityColumn
      selector={selector(pinnedEntries)}
      renderForm={() => <div>legacy-form</div>}
      addButtonText="Sync Years"
      isVisible
      level="year"
      parentId={YEAR_PARENT}
      useEnsureSync={useEnsureSync}
    />,
  );
}

describe("EntityColumn + EntitySelector — a failed sync (NEO-445)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.items = [];
    state.status = null;
    mockEnsure.mockResolvedValue({
      ran: true,
      reason: "synced",
      skippedSides: [],
      pausedSides: [],
    });
  });

  it("with no options, drops the empty line and shows the error and its retry", () => {
    state.status = FAILED;
    renderYears();

    expect(screen.queryByText(EMPTY_LINE)).toBeNull();
    expect(screen.getByText(FAILED.message)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sync Years" })).toBeTruthy();
    // Not stranded: an operator can still add the year by hand.
    expect(screen.getByRole("button", { name: "Add custom Years" })).toBeTruthy();
  });

  it("the retry forces a fresh sync of this column", () => {
    state.status = FAILED;
    renderYears();
    mockEnsure.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "Sync Years" }));

    expect(mockEnsure).toHaveBeenCalledTimes(1);
    expect(mockEnsure).toHaveBeenCalledWith({
      level: "year",
      parentId: YEAR_PARENT,
      force: true,
    });
  });

  it("with no error, an empty column still shows its line and no error", () => {
    renderYears();

    expect(screen.getByText(EMPTY_LINE)).toBeTruthy();
    expect(screen.queryByText(FAILED.message)).toBeNull();
    expect(screen.getByRole("button", { name: "Sync Years" })).toBeTruthy();
  });

  it("a sync that finished with a notice is not a failure: the line stays", () => {
    // The paused-SportLots path: "done", nothing stored, and the seed waits on
    // this line.
    state.status = {
      status: "done",
      message: "SportLots is on pause: nothing from SportLots was asked for or changed.",
    };
    renderYears();

    expect(screen.getByText(EMPTY_LINE)).toBeTruthy();
  });

  it("with options and a failed sync, the list and the error both stay", () => {
    state.items = [{ _id: "y2024", value: "2024" }];
    state.status = FAILED;
    renderYears();

    const list = screen.getByRole("listbox", { name: "Years" });
    expect(within(list).getByRole("option", { name: "2024" })).toBeTruthy();
    expect(screen.getByText(FAILED.message)).toBeTruthy();
    expect(screen.queryByText(EMPTY_LINE)).toBeNull();
  });

  it("the line under a pinned view goes too, and the view stays listed", () => {
    state.status = FAILED;
    renderYears({ pinnedEntries: ALL_BRANDS });

    expect(
      within(screen.getByRole("listbox", { name: "Years" })).getByRole("option", {
        name: "All Brands, every set",
      }),
    ).toBeTruthy();
    expect(screen.queryByText(EMPTY_LINE)).toBeNull();
    expect(screen.getByText(FAILED.message)).toBeTruthy();
  });

  it("the line under a pinned view stays when nothing failed", () => {
    renderYears({ pinnedEntries: ALL_BRANDS });

    expect(screen.getByText(EMPTY_LINE)).toBeTruthy();
  });

  it("a typed search still answers 'No matches found' after a failed sync", () => {
    // The search box stays usable, and the E2E `selectOrCreate` helper settles
    // on this line before it opens "+ Custom".
    state.status = FAILED;
    renderYears();

    fireEvent.change(screen.getByRole("combobox", { name: "Search years" }), {
      target: { value: "1999" },
    });

    expect(screen.getByText("No matches found")).toBeTruthy();
    expect(screen.queryByText(EMPTY_LINE)).toBeNull();
  });

  it("the line stays away while the custom form is open over a failed sync", () => {
    state.status = FAILED;
    renderYears();

    fireEvent.click(screen.getByRole("button", { name: "Add custom Years" }));

    expect(screen.getByRole("heading", { name: "Add Custom Entry" })).toBeTruthy();
    expect(screen.queryByText(EMPTY_LINE)).toBeNull();
  });

  it("a column on the legacy sync path keeps its line", () => {
    // That path never reads the status, so it has no error box to defer to.
    state.status = FAILED;
    renderYears({ useEnsureSync: false });

    expect(screen.getByText(EMPTY_LINE)).toBeTruthy();
  });

  it("a selector rendered outside any column keeps its line", () => {
    render(selector());

    expect(screen.getByText(EMPTY_LINE)).toBeTruthy();
  });
});
