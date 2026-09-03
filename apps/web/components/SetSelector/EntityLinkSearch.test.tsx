/**
 * NEO-92 / NEO-212: coverage for `EntityLinkSearch` — the single-select
 * existing-player/team search used by EntityReviewWizard's "Link to Existing…"
 * action. Single-select and chip-free: there is deliberately NO "+ Create"
 * escape hatch here (the wizard's own "Add as New" action already covers that
 * case) — one test below locks that absence in explicitly.
 *
 * NEO-212 rewrote the data half. This file previously asserted the component
 * read `players.list` / `teams.list` with `limit: 500` and filtered in the
 * browser; it now asserts the search-index path, because the 500-row cap was a
 * correctness bug and not merely a slow one: past 500 players in a sport, the
 * row you needed was simply absent and the operator created a duplicate of
 * someone we already had.
 *
 * The tests that DO NOT change are the ones that matter most for E2E: every
 * accessible name here ("Search existing players", "Link to {name}", "Cancel
 * linking") is a Maestro matcher and is asserted unchanged below.
 *
 * --- Mocking strategy (identity-routed useQuery, per PlayerPicker.test.tsx /
 * TeamPicker.test.tsx conventions) ---
 * convex/react's useQuery is module-mocked, routed by the (string-mocked)
 * query reference, so `players.search` and `teams.search` resolve independently
 * depending on the `kind` prop (the component "skip"s whichever one isn't
 * relevant, and skips BOTH while the query is blank). The mock records the args
 * it was handed so the debounce and the sport filter can be asserted directly
 * rather than inferred from what rendered.
 */

import { act, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Id } from "../../convex/_generated/dataModel";

// NEO-96: the sport-level selectorOptions ROW ID, not a display string.
const SPORT_ID = "selopt-sport-1" as unknown as Id<"selectorOptions">;

/** Matches SEARCH_DEBOUNCE_MS in the component. */
const DEBOUNCE_MS = 200;

// ---------------------------------------------------------------------------
// Module mocks — declared before the component import
// ---------------------------------------------------------------------------

vi.mock("../../convex/_generated/api", () => ({
  api: {
    players: { search: "players.search", list: "players.list" },
    teams: { search: "teams.search", list: "teams.list" },
  },
}));

let currentPlayers: unknown;
let currentTeams: unknown;
/** Every (ref, args) pair useQuery was called with, in render order. */
let queryCalls: Array<{ ref: string; args: unknown }>;

vi.mock("convex/react", () => ({
  useQuery: (ref: string, args: unknown) => {
    queryCalls.push({ ref, args });
    if (args === "skip") return undefined;
    if (ref === "players.search") return currentPlayers;
    if (ref === "teams.search") return currentTeams;
    return undefined;
  },
}));

// ---------------------------------------------------------------------------
// Component under test — imported after mocks
// ---------------------------------------------------------------------------

import EntityLinkSearch from "./EntityLinkSearch";

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

function makeCandidate(id: string, name: string) {
  return { _id: id, name };
}

function renderSearch(props: Partial<Parameters<typeof EntityLinkSearch>[0]> = {}) {
  const onSelect = vi.fn();
  const onCancel = vi.fn();
  const utils = render(
    <EntityLinkSearch
      kind="player"
      sportId={SPORT_ID}
      onSelect={onSelect}
      onCancel={onCancel}
      {...props}
    />,
  );
  return { ...utils, onSelect, onCancel };
}

/** Type into the search field and let the debounce elapse. */
function typeAndSettle(label: string, value: string) {
  fireEvent.change(screen.getByRole("textbox", { name: label }), {
    target: { value },
  });
  act(() => {
    vi.advanceTimersByTime(DEBOUNCE_MS);
  });
}

/** Args of the LAST call for a given query ref, or undefined if never called. */
function lastArgsFor(ref: string): unknown {
  const calls = queryCalls.filter((c) => c.ref === ref);
  return calls.length > 0 ? calls[calls.length - 1].args : undefined;
}

beforeEach(() => {
  vi.useFakeTimers();
  currentPlayers = undefined;
  currentTeams = undefined;
  queryCalls = [];
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// NEO-212 — the search-index data path
// ---------------------------------------------------------------------------

describe("EntityLinkSearch — search source", () => {
  it("queries players.search (never players.list) for kind='player'", () => {
    currentPlayers = [makeCandidate("p1", "Mike Trout")];
    renderSearch({ kind: "player" });
    typeAndSettle("Search existing players", "Trout");

    expect(lastArgsFor("players.search")).toEqual({
      query: "Trout",
      sportId: SPORT_ID,
    });
    // The 500-row list path is gone entirely — not merely unused.
    expect(queryCalls.some((c) => c.ref === "players.list")).toBe(false);
    expect(queryCalls.some((c) => c.ref === "teams.list")).toBe(false);
  });

  it("queries teams.search for kind='team', and skips the player query", () => {
    currentTeams = [makeCandidate("t1", "Los Angeles Angels")];
    renderSearch({ kind: "team" });
    typeAndSettle("Search existing teams", "Angels");

    expect(lastArgsFor("teams.search")).toEqual({
      query: "Angels",
      sportId: SPORT_ID,
    });
    expect(lastArgsFor("players.search")).toBe("skip");
  });

  it("trims the query before sending it", () => {
    currentPlayers = [];
    renderSearch();
    typeAndSettle("Search existing players", "  Trout  ");

    expect(lastArgsFor("players.search")).toEqual({
      query: "Trout",
      sportId: SPORT_ID,
    });
  });

  it("debounces: one search for a typing burst, not one per keystroke", () => {
    currentPlayers = [];
    renderSearch();

    const input = screen.getByRole("textbox", { name: "Search existing players" });
    for (const value of ["T", "Tr", "Tro", "Trou", "Trout"]) {
      fireEvent.change(input, { target: { value } });
      act(() => {
        vi.advanceTimersByTime(DEBOUNCE_MS / 4);
      });
    }
    act(() => {
      vi.advanceTimersByTime(DEBOUNCE_MS);
    });

    const searched = queryCalls
      .filter((c) => c.ref === "players.search" && c.args !== "skip")
      .map((c) => (c.args as { query: string }).query);
    // Only the settled value ever reaches Convex; the intermediate prefixes
    // would each have opened their own reactive subscription.
    expect(new Set(searched)).toEqual(new Set(["Trout"]));
  });

  it("skips the query entirely while the field is blank", () => {
    renderSearch();

    expect(lastArgsFor("players.search")).toBe("skip");
    expect(lastArgsFor("teams.search")).toBe("skip");
  });
});

// ---------------------------------------------------------------------------
// The three empty states — conflating any two of them is how a typeahead lies
// ---------------------------------------------------------------------------

describe("EntityLinkSearch — empty states", () => {
  it("says 'Type to search' before anything is typed", () => {
    renderSearch();

    expect(screen.getByText("Type to search")).toBeTruthy();
    expect(screen.queryByText("No matches")).toBeNull();
    expect(screen.queryByText("Loading…")).toBeNull();
  });

  it("says 'Loading…' while a typed search is in flight", () => {
    currentPlayers = undefined; // query still resolving
    renderSearch();
    typeAndSettle("Search existing players", "Trout");

    expect(screen.getByText("Loading…")).toBeTruthy();
    // "No matches" here would be a lie — nothing has come back yet.
    expect(screen.queryByText("No matches")).toBeNull();
  });

  it("says 'No matches' only once the search returned nothing", () => {
    currentPlayers = [];
    renderSearch();
    typeAndSettle("Search existing players", "Zzzznomatch");

    expect(screen.getByText("No matches")).toBeTruthy();
    expect(screen.queryByText("Type to search")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Results, ranking and selection — labels UNCHANGED (Maestro contract)
// ---------------------------------------------------------------------------

describe("EntityLinkSearch — results", () => {
  it("renders each result as a 'Link to {name}' option", () => {
    currentPlayers = [makeCandidate("p1", "Mike Trout"), makeCandidate("p2", "Aaron Judge")];
    renderSearch();
    typeAndSettle("Search existing players", "a");

    expect(screen.getByLabelText("Link to Mike Trout")).toBeTruthy();
    expect(screen.getByLabelText("Link to Aaron Judge")).toBeTruthy();
  });

  it("keeps the listbox/input accessible names ('Search existing players'/'…teams')", () => {
    renderSearch({ kind: "player" });
    expect(screen.getByRole("listbox", { name: "Search existing players" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Search existing players" })).toBeTruthy();

    renderSearch({ kind: "team" });
    expect(screen.getByRole("listbox", { name: "Search existing teams" })).toBeTruthy();
  });

  it("ranks prefix matches above non-prefix matches for the typed query", () => {
    // The search index orders by relevance; "starts with what I typed" is what
    // a typeahead user expects to see first, so the component re-sorts.
    currentPlayers = [
      makeCandidate("p1", "Brand Newington"), // contains "new", not a prefix
      makeCandidate("p2", "Newt Adamson"), // prefix match
      makeCandidate("p3", "New York Slugger"), // prefix match, alphabetically first
    ];
    renderSearch();
    typeAndSettle("Search existing players", "New");

    const options = screen.getAllByRole("option").map((el) => el.textContent);
    expect(options).toEqual(["New York Slugger", "Newt Adamson", "Brand Newington"]);
  });

  it("clicking a candidate calls onSelect(id, name)", () => {
    currentPlayers = [makeCandidate("p1", "Mike Trout")];
    const { onSelect } = renderSearch();
    typeAndSettle("Search existing players", "Trout");

    fireEvent.click(screen.getByLabelText("Link to Mike Trout"));

    expect(onSelect).toHaveBeenCalledWith("p1", "Mike Trout");
  });

  it("caps the rendered list at 8 results", () => {
    currentPlayers = Array.from({ length: 12 }, (_, i) => makeCandidate(`p${i}`, `Player ${i}`));
    renderSearch();
    typeAndSettle("Search existing players", "Player");

    expect(screen.getAllByRole("option")).toHaveLength(8);
  });

  // -------------------------------------------------------------------------
  // No create/chip affordance — deliberately absent, unlike PlayerPicker/
  // TeamPicker (the wizard's own "Add as New" action covers that case).
  // -------------------------------------------------------------------------

  it("never shows a '+ Create' option, even for a completely unmatched query", () => {
    currentPlayers = [];
    renderSearch();
    typeAndSettle("Search existing players", "Someone Totally New");

    expect(screen.queryByText(/create/i)).toBeNull();
    expect(screen.queryByLabelText(/^Create/)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Keyboard contract
// ---------------------------------------------------------------------------

describe("EntityLinkSearch — keyboard", () => {
  it("ArrowDown/ArrowUp move the highlighted option", () => {
    currentPlayers = [makeCandidate("p1", "Aaron Judge"), makeCandidate("p2", "Mike Trout")];
    renderSearch();
    typeAndSettle("Search existing players", "a");

    const input = screen.getByRole("textbox", { name: "Search existing players" });
    expect(screen.getByLabelText("Link to Aaron Judge").getAttribute("aria-selected")).toBe("true");

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(screen.getByLabelText("Link to Mike Trout").getAttribute("aria-selected")).toBe("true");

    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(screen.getByLabelText("Link to Aaron Judge").getAttribute("aria-selected")).toBe("true");
  });

  it("Enter selects the highlighted candidate", () => {
    currentPlayers = [makeCandidate("p1", "Aaron Judge"), makeCandidate("p2", "Mike Trout")];
    const { onSelect } = renderSearch();
    typeAndSettle("Search existing players", "a");

    const input = screen.getByRole("textbox", { name: "Search existing players" });
    fireEvent.keyDown(input, { key: "ArrowDown" }); // highlight Mike Trout
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onSelect).toHaveBeenCalledWith("p2", "Mike Trout");
  });

  it("Escape calls onCancel", () => {
    const { onCancel } = renderSearch();

    fireEvent.keyDown(screen.getByRole("textbox", { name: "Search existing players" }), {
      key: "Escape",
    });

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("clicking the Cancel (Esc) button calls onCancel", () => {
    const { onCancel } = renderSearch();

    fireEvent.click(screen.getByLabelText("Cancel linking"));

    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
