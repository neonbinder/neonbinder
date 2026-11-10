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
import { columnSyncFailedMessage } from "./column-sync-failed";

const YEAR_PARENT = "sport-baseball" as never;
const EMPTY_LINE = "No years available. Sync from marketplaces to populate.";
// NEO-450: the column names itself and never echoes the server's message, so
// the stored message here is deliberately one the column must NOT show.
const SERVER_MESSAGE = "Couldn't sync options — please try again.";
const FAILED: { status: string; message: string } = {
  status: "error",
  message: SERVER_MESSAGE,
};
const YEARS_FAILED = columnSyncFailedMessage("Years");

/** The column's one failed-sync box: an alert that names the column. */
function expectYearsAlert() {
  expect(screen.getByRole("alert").textContent).toBe(YEARS_FAILED);
}
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
    expectYearsAlert();
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
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(YEARS_FAILED)).toBeNull();
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
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("with options and a failed sync, the list and the error both stay", () => {
    state.items = [{ _id: "y2024", value: "2024" }];
    state.status = FAILED;
    renderYears();

    const list = screen.getByRole("listbox", { name: "Years" });
    expect(within(list).getByRole("option", { name: "2024" })).toBeTruthy();
    expectYearsAlert();
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
    expectYearsAlert();
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
    expectYearsAlert();
  });

  it("the line stays away while the custom form is open over a failed sync", () => {
    state.status = FAILED;
    renderYears();

    fireEvent.click(screen.getByRole("button", { name: "Add custom Years" }));

    expect(screen.getByRole("heading", { name: "Add Custom Entry" })).toBeTruthy();
    expect(screen.queryByText(EMPTY_LINE)).toBeNull();
    // The form replaces the sync row, alert included: any alert in the column
    // now belongs to the form, so a column-scoped alert locator stays single.
    expect(screen.queryByText(YEARS_FAILED)).toBeNull();
  });

  it("a column on the legacy sync path keeps its line", () => {
    // That path never reads the status, so it has no error box to defer to.
    state.status = FAILED;
    renderYears({ useEnsureSync: false });

    expect(screen.getByText(EMPTY_LINE)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a selector rendered outside any column keeps its line", () => {
    render(selector());

    expect(screen.getByText(EMPTY_LINE)).toBeTruthy();
  });
});

describe("EntityColumn — the failed-sync alert names its column (NEO-450)", () => {
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

  it("shows the column's sentence, not whatever message the server stored", () => {
    const unrelated = "BSC facet lookup returned HTTP 503 for parent sport-baseball";
    state.status = { status: "error", message: unrelated };
    renderYears();

    expectYearsAlert();
    expect(screen.queryByText(unrelated, { exact: false })).toBeNull();
  });

  it("an error with no stored message still names the column", () => {
    state.status = { status: "error" };
    renderYears();

    expectYearsAlert();
  });

  it.each([
    ["idle (no status row)", null],
    ["syncing", { status: "syncing" }],
    ["done", { status: "done" }],
    [
      "done with a partial-failure notice",
      {
        status: "done",
        message: "SportLots couldn't be reached: only BSC's years were synced.",
      },
    ],
  ])("renders no alert when the status is %s", (_label, status) => {
    state.status = status;
    renderYears();

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(YEARS_FAILED)).toBeNull();
  });

  it("a done-with-notice status over rows keeps the rows and raises no alert", () => {
    state.items = [{ _id: "y2024", value: "2024" }];
    state.status = {
      status: "done",
      message: "SportLots is on pause: nothing from SportLots was asked for or changed.",
    };
    renderYears();

    expect(
      within(screen.getByRole("listbox", { name: "Years" })).getByRole("option", {
        name: "2024",
      }),
    ).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a pinned view over rows and a failed sync: every option stays, one alert", () => {
    state.items = [{ _id: "y2024", value: "2024" }];
    state.status = FAILED;
    renderYears({ pinnedEntries: ALL_BRANDS });

    const list = screen.getByRole("listbox", { name: "Years" });
    expect(within(list).getByRole("option", { name: "All Brands, every set" })).toBeTruthy();
    expect(within(list).getByRole("option", { name: "2024" })).toBeTruthy();
    expectYearsAlert();
    expect(screen.queryByText(EMPTY_LINE)).toBeNull();
  });

  it("a pinned view whose search hides it still answers 'No matches found'", () => {
    state.status = FAILED;
    renderYears({ pinnedEntries: ALL_BRANDS });

    fireEvent.change(screen.getByRole("combobox", { name: "Search years" }), {
      target: { value: "zzz" },
    });

    expect(screen.getByText("No matches found")).toBeTruthy();
    expectYearsAlert();
  });

  it("recovering from the error removes the alert and brings the line back", () => {
    state.status = FAILED;
    const view = renderYears();
    expectYearsAlert();

    state.status = { status: "done" };
    view.rerender(
      <EntityColumn
        selector={selector()}
        renderForm={() => <div>legacy-form</div>}
        addButtonText="Sync Years"
        isVisible
        level="year"
        parentId={YEAR_PARENT}
        useEnsureSync
      />,
    );

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText(EMPTY_LINE)).toBeTruthy();
  });

  it("the legacy sync path over rows shows no alert even if a status says error", () => {
    state.items = [{ _id: "y2024", value: "2024" }];
    state.status = FAILED;
    renderYears({ useEnsureSync: false });

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(YEARS_FAILED)).toBeNull();
  });
});
