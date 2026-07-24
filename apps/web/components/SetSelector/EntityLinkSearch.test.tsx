/**
 * NEO-92: coverage for `EntityLinkSearch` — the single-select existing-
 * player/team search used by EntityReviewWizard's "Link to Existing…"
 * action. Modeled on PlayerPicker/TeamPicker's list+client-filter typeahead
 * (see PlayerPicker.test.tsx's "ranks prefix matches above substring
 * matches" convention, mirrored here), but single-select and chip-free:
 * there is deliberately NO "+ Create" escape hatch in this component (the
 * wizard's own "Add as New" action already covers that case) — one test
 * below locks that absence in explicitly.
 *
 * --- Mocking strategy (identity-routed useQuery, per PlayerPicker.test.tsx /
 * TeamPicker.test.tsx conventions) ---
 * convex/react's useQuery is module-mocked, routed by the (string-mocked)
 * query reference, so `players.list` and `teams.list` resolve independently
 * depending on the `kind` prop (the component "skip"s whichever one isn't
 * relevant).
 */

import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks — declared before the component import
// ---------------------------------------------------------------------------

vi.mock("../../convex/_generated/api", () => ({
  api: {
    players: { list: "players.list" },
    teams: { list: "teams.list" },
  },
}));

let currentPlayers: unknown;
let currentTeams: unknown;

vi.mock("convex/react", () => ({
  useQuery: (ref: string, args: unknown) => {
    if (args === "skip") return undefined;
    if (ref === "players.list") return currentPlayers;
    if (ref === "teams.list") return currentTeams;
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
      sport="Baseball"
      onSelect={onSelect}
      onCancel={onCancel}
      {...props}
    />,
  );
  return { ...utils, onSelect, onCancel };
}

beforeEach(() => {
  currentPlayers = undefined;
  currentTeams = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("EntityLinkSearch", () => {
  it("shows a 'Loading…' placeholder while candidates are still being fetched", () => {
    currentPlayers = undefined;
    renderSearch({ kind: "player" });

    expect(screen.getByText("Loading…")).toBeTruthy();
  });

  it("queries players.list for kind='player' and teams.list for kind='team' (mutually exclusive)", () => {
    currentPlayers = [makeCandidate("p1", "Mike Trout")];
    currentTeams = [makeCandidate("t1", "Los Angeles Angels")];

    const { rerender } = render(
      <EntityLinkSearch kind="player" sport="Baseball" onSelect={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(screen.getByText("Mike Trout")).toBeTruthy();
    expect(screen.queryByText("Los Angeles Angels")).toBeNull();

    rerender(
      <EntityLinkSearch kind="team" sport="Baseball" onSelect={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(screen.getByText("Los Angeles Angels")).toBeTruthy();
    expect(screen.queryByText("Mike Trout")).toBeNull();
  });

  it("lists every candidate (unfiltered) when the query is empty", () => {
    currentPlayers = [makeCandidate("p1", "Mike Trout"), makeCandidate("p2", "Aaron Judge")];
    renderSearch();

    expect(screen.getByLabelText("Link to Mike Trout")).toBeTruthy();
    expect(screen.getByLabelText("Link to Aaron Judge")).toBeTruthy();
  });

  it("filters out non-matching candidates by substring once a query is typed", () => {
    currentPlayers = [makeCandidate("p1", "Mike Trout"), makeCandidate("p2", "Aaron Judge")];
    renderSearch();

    fireEvent.change(screen.getByRole("textbox", { name: "Search existing players" }), {
      target: { value: "Trout" },
    });

    expect(screen.getByLabelText("Link to Mike Trout")).toBeTruthy();
    expect(screen.queryByLabelText("Link to Aaron Judge")).toBeNull();
  });

  it("ranks prefix matches above substring matches for the typed query", () => {
    currentPlayers = [
      makeCandidate("p1", "Brand Newington"), // "new" is a substring, not a prefix
      makeCandidate("p2", "Newt Adamson"), // prefix match
      makeCandidate("p3", "New York Slugger"), // prefix match, alphabetically first
    ];
    renderSearch();

    fireEvent.change(screen.getByRole("textbox", { name: "Search existing players" }), {
      target: { value: "New" },
    });

    const options = screen.getAllByRole("option").map((el) => el.textContent);
    expect(options).toEqual(["New York Slugger", "Newt Adamson", "Brand Newington"]);
  });

  it("shows 'No matching players found.' when the query matches nothing", () => {
    currentPlayers = [makeCandidate("p1", "Mike Trout")];
    renderSearch();

    fireEvent.change(screen.getByRole("textbox", { name: "Search existing players" }), {
      target: { value: "Zzzznomatch" },
    });

    expect(screen.getByText("No matching players found.")).toBeTruthy();
  });

  it("clicking a candidate calls onSelect(id, name)", () => {
    currentPlayers = [makeCandidate("p1", "Mike Trout")];
    const { onSelect } = renderSearch();

    fireEvent.click(screen.getByLabelText("Link to Mike Trout"));

    expect(onSelect).toHaveBeenCalledWith("p1", "Mike Trout");
  });

  it("caps the candidate list at 8 results", () => {
    currentPlayers = Array.from({ length: 12 }, (_, i) => makeCandidate(`p${i}`, `Player ${i}`));
    renderSearch();

    expect(screen.getAllByRole("option")).toHaveLength(8);
  });

  // -------------------------------------------------------------------------
  // No create/chip affordance — deliberately absent, unlike PlayerPicker/
  // TeamPicker (the wizard's own "Add as New" action covers that case).
  // -------------------------------------------------------------------------

  it("never shows a '+ Create' option, even for a completely unmatched query", () => {
    currentPlayers = [makeCandidate("p1", "Mike Trout")];
    renderSearch();

    fireEvent.change(screen.getByRole("textbox", { name: "Search existing players" }), {
      target: { value: "Someone Totally New" },
    });

    expect(screen.queryByText(/create/i)).toBeNull();
    expect(screen.queryByLabelText(/^Create/)).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Keyboard contract
  // -------------------------------------------------------------------------

  it("ArrowDown/ArrowUp move the highlighted option", () => {
    currentPlayers = [makeCandidate("p1", "Aaron Judge"), makeCandidate("p2", "Mike Trout")];
    renderSearch();

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

    const input = screen.getByRole("textbox", { name: "Search existing players" });
    fireEvent.keyDown(input, { key: "ArrowDown" }); // highlight Mike Trout
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onSelect).toHaveBeenCalledWith("p2", "Mike Trout");
  });

  it("Escape calls onCancel", () => {
    currentPlayers = [makeCandidate("p1", "Aaron Judge")];
    const { onCancel } = renderSearch();

    fireEvent.keyDown(screen.getByRole("textbox", { name: "Search existing players" }), { key: "Escape" });

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("clicking the Cancel (Esc) button calls onCancel", () => {
    currentPlayers = [];
    const { onCancel } = renderSearch();

    fireEvent.click(screen.getByLabelText("Cancel linking"));

    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
