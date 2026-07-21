/**
 * NEO-71-74 — coverage for `PlayerPicker`, a brand-new component with zero
 * prior test coverage. Mirrors `TeamPicker`'s chip/popover typeahead (see
 * `TeamPicker.test.tsx`, written alongside this file with the same
 * structure), plus the one behavior PlayerPicker adds on top: when the
 * typed query has no exact (case-insensitive) name match among the fetched
 * candidates, a "+ Create '<name>'" row appears; selecting it calls the
 * already-public `players.findOrCreate` mutation and adds the resulting id
 * as a chip. This is what lets a custom (non-marketplace-synced) card
 * attach players at all.
 *
 * --- Mocking strategy (identity-routed useQuery/useMutation, per
 * CardFeaturesEditor.test.tsx / BaseMappingForm.test.tsx conventions) ---
 * `convex/react`'s `useQuery`/`useMutation` are module-mocked, routed by the
 * (string-mocked) query/mutation reference, so `players.getManyByIds` and
 * `players.list` resolve independently, and `players.findOrCreate` resolves
 * to its own spy.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks — declared before the component import
// ---------------------------------------------------------------------------

vi.mock("../../convex/_generated/api", () => ({
  api: {
    players: {
      getManyByIds: "players.getManyByIds",
      list: "players.list",
      findOrCreate: "players.findOrCreate",
    },
  },
}));

let currentSelectedRows: unknown;
let currentCandidates: unknown;
const mockFindOrCreate = vi.fn();

vi.mock("convex/react", () => ({
  useQuery: (ref: string) => {
    if (ref === "players.getManyByIds") return currentSelectedRows;
    if (ref === "players.list") return currentCandidates;
    return undefined;
  },
  useMutation: (ref: string) =>
    ref === "players.findOrCreate" ? mockFindOrCreate : vi.fn(),
}));

// ---------------------------------------------------------------------------
// Component under test — imported after mocks
// ---------------------------------------------------------------------------

import PlayerPicker from "./PlayerPicker";
import type { Id } from "../../convex/_generated/dataModel";

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

function pid(n: string): Id<"players"> {
  return n as unknown as Id<"players">;
}

function makePlayer(id: string, name: string) {
  return { _id: pid(id), name };
}

function renderPicker(
  props: Partial<Parameters<typeof PlayerPicker>[0]> = {},
) {
  const onChange = vi.fn();
  const utils = render(
    <PlayerPicker value={[]} onChange={onChange} sport="Baseball" {...props} />,
  );
  return { ...utils, onChange };
}

function openPopover() {
  fireEvent.click(screen.getByLabelText("Add player"));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PlayerPicker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentSelectedRows = [];
    currentCandidates = [];
    mockFindOrCreate.mockResolvedValue(pid("new-player-1"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Chip rendering (players.getManyByIds)
  // -------------------------------------------------------------------------

  it("renders a chip per selected id, labeled from players.getManyByIds", () => {
    currentSelectedRows = [makePlayer("p1", "Mike Trout")];
    renderPicker({ value: [pid("p1")] });

    expect(screen.getByLabelText("Player: Mike Trout")).toBeTruthy();
    expect(screen.getByLabelText("Remove player Mike Trout")).toBeTruthy();
  });

  it("shows a 'Loading…' placeholder label for a chip not yet resolved by getManyByIds", () => {
    currentSelectedRows = undefined;
    renderPicker({ value: [pid("p1")] });

    expect(screen.getByLabelText("Player: Loading…")).toBeTruthy();
  });

  it("clicking a chip's × button removes it via onChange", () => {
    currentSelectedRows = [makePlayer("p1", "Mike Trout"), makePlayer("p2", "Aaron Judge")];
    const { onChange } = renderPicker({ value: [pid("p1"), pid("p2")] });

    fireEvent.click(screen.getByLabelText("Remove player Mike Trout"));

    expect(onChange).toHaveBeenCalledWith([pid("p2")]);
  });

  // -------------------------------------------------------------------------
  // Candidate list (players.list), filtered/ranked by typed query
  // -------------------------------------------------------------------------

  it("lists candidates from players.list when the popover opens", () => {
    currentCandidates = [makePlayer("p1", "Mike Trout"), makePlayer("p2", "Aaron Judge")];
    renderPicker();

    openPopover();

    expect(screen.getByLabelText("Add Mike Trout")).toBeTruthy();
    expect(screen.getByLabelText("Add Aaron Judge")).toBeTruthy();
  });

  it("excludes already-selected ids from the candidate list", () => {
    currentSelectedRows = [makePlayer("p1", "Mike Trout")];
    currentCandidates = [makePlayer("p1", "Mike Trout"), makePlayer("p2", "Aaron Judge")];
    renderPicker({ value: [pid("p1")] });

    openPopover();

    expect(screen.queryByLabelText("Add Mike Trout")).toBeNull();
    expect(screen.getByLabelText("Add Aaron Judge")).toBeTruthy();
  });

  it("ranks prefix matches above substring matches when a query is typed", () => {
    currentCandidates = [
      makePlayer("p1", "Brand Newington"), // "new" is a substring, not a prefix
      makePlayer("p2", "Newt Adamson"), // prefix match
      makePlayer("p3", "New York Slugger"), // prefix match, alphabetically first
    ];
    renderPicker();

    openPopover();
    fireEvent.change(screen.getByLabelText("Search players"), {
      target: { value: "New" },
    });

    // Filter out the trailing "+ Create" row (also role="option") — a
    // non-exact-match query always shows it alongside real matches.
    const options = screen
      .getAllByRole("option")
      .filter((el) => el.getAttribute("aria-label")?.startsWith("Add "))
      .map((el) => el.textContent);
    expect(options).toEqual(["New York Slugger", "Newt Adamson", "Brand Newington"]);
  });

  it("filters out non-matching candidates once a query is typed", () => {
    currentCandidates = [makePlayer("p1", "Mike Trout"), makePlayer("p2", "Aaron Judge")];
    renderPicker();

    openPopover();
    fireEvent.change(screen.getByLabelText("Search players"), {
      target: { value: "Trout" },
    });

    expect(screen.getByLabelText("Add Mike Trout")).toBeTruthy();
    expect(screen.queryByLabelText("Add Aaron Judge")).toBeNull();
  });

  it("clicking a candidate adds its id via onChange and clears the query", () => {
    currentCandidates = [makePlayer("p1", "Mike Trout")];
    const { onChange } = renderPicker({ value: [] });

    openPopover();
    fireEvent.click(screen.getByLabelText("Add Mike Trout"));

    expect(onChange).toHaveBeenCalledWith([pid("p1")]);
  });

  // -------------------------------------------------------------------------
  // Keyboard contract (docstring: Enter/arrows/Escape/Backspace)
  // -------------------------------------------------------------------------

  it("ArrowDown/ArrowUp move the highlighted option", () => {
    currentCandidates = [makePlayer("p1", "Aaron Judge"), makePlayer("p2", "Mike Trout")];
    renderPicker();
    openPopover();

    const input = screen.getByLabelText("Search players");
    // Default highlight is index 0.
    expect(screen.getByLabelText("Add Aaron Judge").getAttribute("aria-selected")).toBe(
      "true",
    );

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(screen.getByLabelText("Add Mike Trout").getAttribute("aria-selected")).toBe(
      "true",
    );

    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(screen.getByLabelText("Add Aaron Judge").getAttribute("aria-selected")).toBe(
      "true",
    );
  });

  it("Enter selects the highlighted match", () => {
    currentCandidates = [makePlayer("p1", "Aaron Judge"), makePlayer("p2", "Mike Trout")];
    const { onChange } = renderPicker();
    openPopover();

    const input = screen.getByLabelText("Search players");
    fireEvent.keyDown(input, { key: "ArrowDown" }); // highlight Mike Trout
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onChange).toHaveBeenCalledWith([pid("p2")]);
  });

  it("Escape closes the popover without selecting anything", () => {
    currentCandidates = [makePlayer("p1", "Aaron Judge")];
    const { onChange } = renderPicker();
    openPopover();

    fireEvent.keyDown(screen.getByLabelText("Search players"), { key: "Escape" });

    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("Backspace on an empty query removes the last chip", () => {
    currentSelectedRows = [makePlayer("p1", "Aaron Judge"), makePlayer("p2", "Mike Trout")];
    const { onChange } = renderPicker({ value: [pid("p1"), pid("p2")] });
    openPopover();

    fireEvent.keyDown(screen.getByLabelText("Search players"), { key: "Backspace" });

    expect(onChange).toHaveBeenCalledWith([pid("p1")]);
  });

  it("Backspace does nothing when the query is non-empty (caret editing, not chip removal)", () => {
    currentSelectedRows = [makePlayer("p1", "Aaron Judge")];
    const { onChange } = renderPicker({ value: [pid("p1")] });
    openPopover();

    fireEvent.change(screen.getByLabelText("Search players"), {
      target: { value: "M" },
    });
    fireEvent.keyDown(screen.getByLabelText("Search players"), { key: "Backspace" });

    expect(onChange).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Create-new flow (PlayerPicker's one addition beyond TeamPicker's baseline)
  // -------------------------------------------------------------------------

  it("shows a '+ Create' row when the typed query has no exact match among candidates", () => {
    currentCandidates = [makePlayer("p1", "Mike Trout")];
    renderPicker();
    openPopover();

    fireEvent.change(screen.getByLabelText("Search players"), {
      target: { value: "Bobby Witt Jr" },
    });

    expect(screen.getByLabelText('Create player Bobby Witt Jr')).toBeTruthy();
  });

  it("does NOT show the '+ Create' row when an exact (case-insensitive) match exists", () => {
    currentCandidates = [makePlayer("p1", "Mike Trout")];
    renderPicker();
    openPopover();

    fireEvent.change(screen.getByLabelText("Search players"), {
      target: { value: "mike trout" },
    });

    expect(screen.queryByLabelText(/^Create player/)).toBeNull();
  });

  it("does not show the '+ Create' row when the query is empty", () => {
    currentCandidates = [makePlayer("p1", "Mike Trout")];
    renderPicker();
    openPopover();

    expect(screen.queryByLabelText(/^Create player/)).toBeNull();
  });

  it("clicking '+ Create' calls players.findOrCreate({ name, sport }) and adds the resulting id as a chip", async () => {
    currentCandidates = [];
    mockFindOrCreate.mockResolvedValue(pid("new-player-1"));
    const { onChange } = renderPicker({ sport: "Baseball" });
    openPopover();

    fireEvent.change(screen.getByLabelText("Search players"), {
      target: { value: "Bobby Witt Jr" },
    });
    fireEvent.click(screen.getByLabelText('Create player Bobby Witt Jr'));

    await waitFor(() => {
      expect(mockFindOrCreate).toHaveBeenCalledWith({
        name: "Bobby Witt Jr",
        sport: "Baseball",
      });
    });
    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith([pid("new-player-1")]);
    });
  });

  it("pressing Enter with the create row highlighted (no matches) also creates and adds", async () => {
    currentCandidates = [];
    mockFindOrCreate.mockResolvedValue(pid("new-player-2"));
    const { onChange } = renderPicker({ sport: "Baseball" });
    openPopover();

    const input = screen.getByLabelText("Search players");
    fireEvent.change(input, { target: { value: "Bobby Witt Jr" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(mockFindOrCreate).toHaveBeenCalledWith({
        name: "Bobby Witt Jr",
        sport: "Baseball",
      });
    });
    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith([pid("new-player-2")]);
    });
  });

  it("passes an empty-string sport to findOrCreate when no sport prop is given", async () => {
    currentCandidates = [];
    mockFindOrCreate.mockResolvedValue(pid("new-player-3"));
    renderPicker({ sport: undefined });
    openPopover();

    fireEvent.change(screen.getByLabelText("Search players"), {
      target: { value: "Bobby Witt Jr" },
    });
    fireEvent.click(screen.getByLabelText('Create player Bobby Witt Jr'));

    await waitFor(() => {
      expect(mockFindOrCreate).toHaveBeenCalledWith({
        name: "Bobby Witt Jr",
        sport: "",
      });
    });
  });
});
