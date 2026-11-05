/**
 * NEO-427 — the idle buttons never draw before the read that can move them.
 *
 * A column's sync status is a separate read from its rows. A `done` row left by
 * an earlier sync renders its notice ABOVE the button row, so when the buttons
 * drew first the notice landed under the mouse and pushed "+ Custom" away
 * mid-press: the release missed the button and the click was lost. Holding the
 * row back until the read lands means the buttons and the notice arrive
 * together, in their final place.
 *
 * Mocking mirrors EntityColumn.ensure-sync.test.tsx, with the real
 * EntitySelector as the column's list.
 */

import { act, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EntityColumnProps } from "./EntityColumn";

vi.mock("../../convex/_generated/api", () => ({
  api: {
    selectorOptions: {
      getSelectorOptions: "getSelectorOptions",
      getSelectorSyncStatus: "getSelectorSyncStatus",
      addCustomSelectorOption: "addCustomSelectorOption",
      ensureSelectorOptions: "ensureSelectorOptions",
    },
    slSetReview: { getSlSetReviewSummary: "getSlSetReviewSummary" },
  },
}));

const state: { items: unknown; status: unknown } = { items: [], status: undefined };
const mockEnsure = vi.fn();

vi.mock("convex/react", () => ({
  useMutation: () => vi.fn(),
  useConvex: () => ({ query: vi.fn() }),
  useAction: (ref: string) =>
    ref === "ensureSelectorOptions" ? mockEnsure : vi.fn(),
  useQuery: (ref: string) => {
    if (ref === "getSelectorSyncStatus") return state.status;
    return ref === "getSelectorOptions" ? state.items : undefined;
  },
}));

import EntityColumn from "./EntityColumn";
import EntitySelector, { displayByValue } from "./EntitySelector";
import type { SelectorItem } from "./EntitySelector";

const FORM = "Add Custom Entry";
const SKIPPED = "SportLots skipped: no SportLots ids on this path.";
const ROWS = [{ _id: "s1", value: "Topps Chrome", level: "setName" }];

const onSelect = vi.fn();

function column(parentId = "brand-1", onLoadingChange?: (loading: boolean) => void) {
  const props: EntityColumnProps = {
    onLoadingChange,
    selector: (
      <EntitySelector
        title="Sets"
        query={"getSelectorOptions" as never}
        queryArgs={{ level: "setName", parentId } as never}
        selectedId={null}
        onSelect={onSelect}
        expanded
        setExpanded={vi.fn()}
        getDisplayName={displayByValue as (i: SelectorItem) => string}
        selectedColor="bg-pick-purple"
      />
    ),
    addButtonText: "Sync Sets",
    isVisible: true,
    level: "setName",
    parentId: parentId as never,
    useEnsureSync: true,
    syncingLabel: "Syncing Sets",
  };
  return <EntityColumn {...props} />;
}

const customButton = () => screen.queryByRole("button", { name: "Add custom Sets" });
const syncButton = () => screen.queryByRole("button", { name: "Sync Sets" });
const option = () => screen.getByRole("option", { name: "Topps Chrome" });

describe("EntityColumn — idle buttons wait for the status read (NEO-427)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnsure.mockResolvedValue({ ran: false });
    state.items = ROWS;
    state.status = undefined; // the read has not landed
  });

  it("draws no idle buttons while the status read is out, with the list already there", () => {
    render(column());

    expect(option()).toBeTruthy();
    expect(customButton()).toBeNull();
    expect(syncButton()).toBeNull();
  });

  it("draws the buttons and a stored notice in the same commit", () => {
    const { rerender } = render(column());
    expect(screen.queryByText(SKIPPED)).toBeNull();
    expect(customButton()).toBeNull();

    state.status = { status: "done", message: SKIPPED };
    rerender(column());

    expect(screen.getByText(SKIPPED)).toBeTruthy();
    expect(customButton()).toBeTruthy();
    expect(syncButton()).toBeTruthy();
    // The notice is already above the row, so the row has nowhere left to go.
    expect(
      screen.getByText(SKIPPED).compareDocumentPosition(customButton()!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("draws the buttons when the read lands empty (idle), with no notice", () => {
    const { rerender } = render(column());

    state.status = null;
    rerender(column());

    expect(customButton()).toBeTruthy();
    expect(screen.queryByText(SKIPPED)).toBeNull();
  });

  it("opens the form on a press of + Custom once they are drawn", () => {
    state.status = { status: "done", message: SKIPPED };
    render(column());

    fireEvent.click(customButton()!);

    expect(screen.getByText(FORM)).toBeTruthy();
  });

  it("still asks the backend to fill an empty column while the read is out", async () => {
    state.items = [];
    render(column());
    await act(async () => {});

    expect(mockEnsure).toHaveBeenCalledTimes(1);
    // The column says what it is, with no button yet to press.
    expect(screen.getByText(/No sets available/)).toBeTruthy();
    expect(customButton()).toBeNull();
  });

  it("reports loading while the status read is out, so a stall gets the backstop", () => {
    const onLoading = vi.fn();
    const { rerender } = render(column("brand-1", onLoading));
    expect(option()).toBeTruthy(); // items are in; only the status read is out
    expect(onLoading).toHaveBeenLastCalledWith(true);

    state.status = null;
    rerender(column("brand-1", onLoading));
    expect(onLoading).toHaveBeenLastCalledWith(false);
  });

  it("NEO-219 still holds: a parent change closes an open form", async () => {
    state.status = null;
    const { rerender } = render(column("brand-1"));
    fireEvent.click(customButton()!);
    expect(screen.getByText(FORM)).toBeTruthy();

    // The new parent's read lands in the same render, so the row is back.
    await act(async () => {
      rerender(column("brand-2"));
    });

    expect(customButton()).toBeTruthy();
    expect(screen.queryByText(FORM)).toBeNull();
  });

  it("on a parent change the buttons wait for the new read, and the list stays usable", async () => {
    state.status = { status: "done", message: SKIPPED };
    const { rerender } = render(column("brand-1"));
    expect(customButton()).toBeTruthy();

    // Convex answers undefined for new args until they are read.
    state.status = undefined;
    await act(async () => {
      rerender(column("brand-2"));
    });
    expect(customButton()).toBeNull();
    expect(screen.queryByText(SKIPPED)).toBeNull();

    fireEvent.click(option());
    expect(onSelect).toHaveBeenCalledWith("s1");

    state.status = null;
    await act(async () => {
      rerender(column("brand-2"));
    });
    expect(customButton()).toBeTruthy();
  });
});
