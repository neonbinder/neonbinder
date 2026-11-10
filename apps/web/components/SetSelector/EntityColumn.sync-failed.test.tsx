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

import { act, fireEvent, render, screen, within } from "@testing-library/react";
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

/**
 * The column's failed-sync box, found the way assistive tech reaches it: the
 * "Sync Years" button (its retry) is described by it. A bare
 * getByRole("status") is ambiguous: the column has other status regions.
 */
function failureBox(): HTMLElement {
  const id = screen
    .getByRole("button", { name: "Sync Years" })
    .getAttribute("aria-describedby");
  expect(id).toBeTruthy();
  const box = document.getElementById(id as string);
  expect(box).not.toBeNull();
  return box as HTMLElement;
}

/**
 * NEO-450: a STORED error (nothing this session ran just failed) names the
 * column in a polite, atomic status, never an alert.
 */
function expectStoredFailure() {
  const box = failureBox();
  expect(box.textContent).toBe(YEARS_FAILED);
  expect(box.getAttribute("role")).toBe("status");
  expect(box.getAttribute("aria-atomic")).toBe("true");
  expect(screen.queryByRole("alert")).toBeNull();
}

/** A failure this session's own attempt just produced: an alert. */
function expectFreshFailure(): HTMLElement {
  const box = failureBox();
  expect(box.textContent).toBe(YEARS_FAILED);
  expect(box.getAttribute("role")).toBe("alert");
  expect(box.getAttribute("aria-atomic")).toBe("true");
  expect(screen.getByRole("alert")).toBe(box);
  return box;
}

const ENSURE_FAILED = {
  ran: true,
  reason: "error",
  skippedSides: [],
  pausedSides: [],
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

type YearsOptions = {
  pinnedEntries?: PinnedEntry[];
  useEnsureSync?: boolean;
  parentId?: string;
};

function yearsColumn({
  pinnedEntries,
  useEnsureSync = true,
  parentId = YEAR_PARENT,
}: YearsOptions = {}) {
  return (
    <EntityColumn
      selector={selector(pinnedEntries)}
      renderForm={() => <div>legacy-form</div>}
      addButtonText="Sync Years"
      isVisible
      level="year"
      parentId={parentId as never}
      useEnsureSync={useEnsureSync}
    />
  );
}

function renderYears(options: YearsOptions = {}) {
  return render(yearsColumn(options));
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
    expectStoredFailure();
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
    expectStoredFailure();
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
    expectStoredFailure();
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
    expectStoredFailure();
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

    expectStoredFailure();
    expect(screen.queryByText(unrelated, { exact: false })).toBeNull();
  });

  it("an error with no stored message still names the column", () => {
    state.status = { status: "error" };
    renderYears();

    expectStoredFailure();
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

  it("a pinned view over rows and a failed sync: every option stays, one failure box", () => {
    state.items = [{ _id: "y2024", value: "2024" }];
    state.status = FAILED;
    renderYears({ pinnedEntries: ALL_BRANDS });

    const list = screen.getByRole("listbox", { name: "Years" });
    expect(within(list).getByRole("option", { name: "All Brands, every set" })).toBeTruthy();
    expect(within(list).getByRole("option", { name: "2024" })).toBeTruthy();
    expectStoredFailure();
    expect(screen.queryByText(EMPTY_LINE)).toBeNull();
  });

  it("a pinned view whose search hides it still answers 'No matches found'", () => {
    state.status = FAILED;
    renderYears({ pinnedEntries: ALL_BRANDS });

    fireEvent.change(screen.getByRole("combobox", { name: "Search years" }), {
      target: { value: "zzz" },
    });

    expect(screen.getByText("No matches found")).toBeTruthy();
    expectStoredFailure();
  });

  it("recovering from the error removes the box, its description and brings the line back", () => {
    state.status = FAILED;
    const view = renderYears();
    expectStoredFailure();

    state.status = { status: "done" };
    view.rerender(yearsColumn());

    expect(screen.queryByText(YEARS_FAILED)).toBeNull();
    expect(
      screen.getByRole("button", { name: "Sync Years" }).hasAttribute("aria-describedby"),
    ).toBe(false);
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

describe("EntityColumn — how loudly the failure speaks (NEO-450 a11y)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.items = [{ _id: "y2024", value: "2024" }];
    state.status = FAILED;
    mockEnsure.mockResolvedValue({
      ran: true,
      reason: "synced",
      skippedSides: [],
      pausedSides: [],
    });
  });

  async function pressSync() {
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Sync Years" }));
    });
  }

  it("a stored error the column only read is a status, not an alert", async () => {
    renderYears();
    await act(async () => {});

    expectStoredFailure();
    expect(mockEnsure).not.toHaveBeenCalled();
  });

  it("a stored error is still a status after this session's sync succeeded", async () => {
    renderYears();
    await pressSync();

    expect(mockEnsure).toHaveBeenCalledTimes(1);
    expectStoredFailure();
  });

  it("the Sync button is described by the box only while the status is error", async () => {
    const view = renderYears();
    const sync = screen.getByRole("button", { name: "Sync Years" });
    expect(sync.getAttribute("aria-describedby")).toBe(failureBox().id);

    state.status = { status: "done" };
    view.rerender(yearsColumn());

    expect(
      screen.getByRole("button", { name: "Sync Years" }).hasAttribute("aria-describedby"),
    ).toBe(false);
  });

  it("a forced Sync that comes back reason 'error' turns the box into an alert", async () => {
    mockEnsure.mockResolvedValue(ENSURE_FAILED);
    renderYears();
    expectStoredFailure();

    await pressSync();

    expect(mockEnsure).toHaveBeenCalledWith({
      level: "year",
      parentId: YEAR_PARENT,
      force: true,
    });
    expectFreshFailure();
  });

  it("the column's own first ensure failing is an alert too", async () => {
    // Empty column: the mount-time ensure runs, and it is this session's attempt.
    state.items = [];
    mockEnsure.mockResolvedValue(ENSURE_FAILED);
    renderYears();
    await act(async () => {});

    expect(mockEnsure).toHaveBeenCalledWith({ level: "year", parentId: YEAR_PARENT });
    expectFreshFailure();
  });

  it("a Sync that rejects is an alert, and the rejection still surfaces", async () => {
    // A hand-rolled thenable instead of a rejected promise: the column re-throws
    // from its rejection handler so error reporting sees it, and a real promise
    // would turn that into an unhandled rejection that fails the run.
    const boom = new Error("ensureSelectorOptions blew up");
    let rethrown: unknown = null;
    mockEnsure.mockImplementation(() => ({
      then(_onOk: unknown, onFail: (err: unknown) => void) {
        try {
          onFail(boom);
        } catch (err) {
          rethrown = err;
        }
      },
    }));
    renderYears();

    await pressSync();

    expectFreshFailure();
    expect(rethrown).toBe(boom);
  });

  it("a repeat failure remounts the alert so it is announced again", async () => {
    mockEnsure.mockResolvedValue(ENSURE_FAILED);
    renderYears();
    await pressSync();
    const first = expectFreshFailure();

    await pressSync();
    const second = expectFreshFailure();

    // Same words, but a NEW node: a live region that merely re-renders the same
    // text is not re-announced; a freshly inserted alert is.
    expect(second).not.toBe(first);
    expect(first.isConnected).toBe(false);
  });

  it("+ Custom then Cancel brings the box back as a status, not a second alert", async () => {
    mockEnsure.mockResolvedValue(ENSURE_FAILED);
    renderYears();
    await pressSync();
    expectFreshFailure();

    fireEvent.click(screen.getByRole("button", { name: "Add custom Years" }));
    expect(screen.queryByText(YEARS_FAILED)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Cancel/ }));

    expectStoredFailure();
  });

  it("after a Cancel calmed it, the next failed Sync is an alert again", async () => {
    mockEnsure.mockResolvedValue(ENSURE_FAILED);
    renderYears();
    await pressSync();
    fireEvent.click(screen.getByRole("button", { name: "Add custom Years" }));
    fireEvent.click(screen.getByRole("button", { name: /^Cancel/ }));
    expectStoredFailure();

    await pressSync();

    expectFreshFailure();
  });

  it("moving to another parent resets the urgency: the new parent's stored error is a status", async () => {
    mockEnsure.mockResolvedValue(ENSURE_FAILED);
    const view = renderYears();
    await pressSync();
    expectFreshFailure();

    view.rerender(yearsColumn({ parentId: "sport-football" }));

    expectStoredFailure();
  });

  it("a failure answered after the column moved parent is not announced on the new one", async () => {
    let answer: (value: unknown) => void = () => {};
    mockEnsure.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    const view = renderYears();
    await pressSync();

    view.rerender(yearsColumn({ parentId: "sport-football" }));
    await act(async () => {
      answer(ENSURE_FAILED);
    });

    expectStoredFailure();
  });

  it("coming back to the first parent after a reset starts calm", async () => {
    mockEnsure.mockResolvedValue(ENSURE_FAILED);
    const view = renderYears();
    await pressSync();
    expectFreshFailure();

    view.rerender(yearsColumn({ parentId: "sport-football" }));
    view.rerender(yearsColumn());

    expectStoredFailure();
  });
});

describe("EntityColumn — focus after a sync ends (NEO-450 a11y)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.items = [{ _id: "y2024", value: "2024" }];
    state.status = FAILED;
    mockEnsure.mockResolvedValue(ENSURE_FAILED);
  });

  async function syncFromTheButton(view: ReturnType<typeof renderYears>) {
    const sync = screen.getByRole("button", { name: "Sync Years" });
    sync.focus();
    expect(document.activeElement).toBe(sync);
    await act(async () => {
      fireEvent.click(sync);
    });
    // The server flips the row to syncing: the panel replaces the button row.
    state.status = { status: "syncing" };
    view.rerender(yearsColumn());
    expect(screen.queryByRole("button", { name: "Sync Years" })).toBeNull();
  }

  it("returns focus to the Sync button, now described by the failure, when the retry fails", async () => {
    const view = renderYears();
    await syncFromTheButton(view);

    state.status = FAILED;
    view.rerender(yearsColumn());

    const sync = screen.getByRole("button", { name: "Sync Years" });
    expect(document.activeElement).toBe(sync);
    expect(sync.getAttribute("aria-describedby")).toBe(expectFreshFailure().id);
  });

  it("returns focus to the Sync button when the retry succeeds", async () => {
    mockEnsure.mockResolvedValue({
      ran: true,
      reason: "synced",
      skippedSides: [],
      pausedSides: [],
    });
    const view = renderYears();
    await syncFromTheButton(view);

    state.status = { status: "done" };
    view.rerender(yearsColumn());

    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Sync Years" }),
    );
  });

  it("never steals focus the operator moved elsewhere in the column meanwhile", async () => {
    const view = renderYears();
    await syncFromTheButton(view);
    const search = screen.getByRole("combobox", { name: "Search years" });
    search.focus();

    state.status = FAILED;
    view.rerender(yearsColumn());

    expect(document.activeElement).toBe(search);
  });

  it("never pulls focus into a column the operator never touched", async () => {
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    try {
      const view = renderYears();
      outside.focus();
      // A background sync flips the untouched column through syncing and back.
      state.status = { status: "syncing" };
      view.rerender(yearsColumn());
      state.status = FAILED;
      view.rerender(yearsColumn());

      expect(document.activeElement).toBe(outside);
    } finally {
      outside.remove();
    }
  });
});

describe("EntityColumn — a fresh failure calms once the column recovers (NEO-450 a11y)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.items = [{ _id: "y2024", value: "2024" }];
    state.status = FAILED;
    mockEnsure.mockResolvedValue(ENSURE_FAILED);
  });

  async function pressSync() {
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Sync Years" }));
    });
  }

  function settle(view: ReturnType<typeof renderYears>, status: unknown) {
    state.status = status;
    view.rerender(yearsColumn());
  }

  it("after a later success, an error nobody here caused reads as a status", async () => {
    const view = renderYears();
    await pressSync();
    expectFreshFailure();

    // A later sync (another session's, or a background one) succeeds...
    settle(view, { status: "done" });
    expect(screen.queryByText(YEARS_FAILED)).toBeNull();
    // ...and then some other sync fails, with no new attempt from this column.
    settle(view, FAILED);

    expect(mockEnsure).toHaveBeenCalledTimes(1);
    expectStoredFailure();
  });

  it("the status row disappearing also ends the fresh failure", async () => {
    const view = renderYears();
    await pressSync();
    expectFreshFailure();

    settle(view, null);
    settle(view, FAILED);

    expectStoredFailure();
  });

  it("answered over the OLD stored error, then syncing, then error: still an alert", async () => {
    // The action answers while the previous stored error still shows; the row
    // then passes through "syncing" before landing on the new failure.
    const view = renderYears();
    await pressSync();
    expectFreshFailure();

    settle(view, { status: "syncing" });
    settle(view, FAILED);

    expectFreshFailure();
  });

  it("answered before the query caught up from a stale 'done': still an alert once error lands", async () => {
    // The column showed no failure; the retry's action says "error" while the
    // status query still reports the pre-retry "done".
    state.status = { status: "done" };
    const view = renderYears();
    await pressSync();
    expect(screen.queryByText(YEARS_FAILED)).toBeNull();

    settle(view, { status: "done" });
    settle(view, FAILED);

    expectFreshFailure();
  });

  it("a fresh failure after a calm-down is an alert again", async () => {
    const view = renderYears();
    await pressSync();
    settle(view, { status: "done" });
    settle(view, FAILED);
    expectStoredFailure();

    await pressSync();

    expectFreshFailure();
  });

  it("a null ensure result neither throws nor counts as a failure", async () => {
    // Hand-rolled thenable so a throw from the success handler is caught here,
    // deterministically, instead of escaping as an unhandled rejection.
    let thrown: unknown = null;
    mockEnsure.mockImplementation(() => ({
      then(onOk: (res: unknown) => void) {
        try {
          onOk(null);
        } catch (err) {
          thrown = err;
        }
      },
    }));
    renderYears();

    await pressSync();

    expect(mockEnsure).toHaveBeenCalledTimes(1);
    expect(thrown).toBeNull();
    expectStoredFailure();
  });
});
