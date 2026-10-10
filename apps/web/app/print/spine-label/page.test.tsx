/**
 * NEO-236 — the spine-label designer names teams by their FULL name.
 *
 * A spine label is the most physical surface in the product: it gets printed,
 * cut out and slid into a binder, and "Padres" without "San Diego" is a label
 * a collector has to guess at. `teams.name` is the nickname now and the place
 * lives in `teams.location`, so every one of this page's three team surfaces —
 * the career-team chips, the any-team search's filter, and the text that
 * search drops into the box — composes the two.
 *
 * This is the first test file for this page. It covers the team surfaces only;
 * the print/format half is already covered by `lib/print/*.test.ts`.
 *
 * --- Mocking strategy (identity-routed useQuery, per TeamPicker.test.tsx) ---
 * `convex/react`'s `useQuery` is module-mocked and routed by the
 * (string-mocked) query reference, so `teams.getManyByIds`,
 * `teams.listForPicker` and `leagues.list` resolve independently.
 * `PlayerAutocomplete` is stubbed with a button that hands the page a player
 * fixture, which is how the career-team branch is reached at all.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/convex/_generated/api", () => ({
  api: {
    teams: {
      getManyByIds: "teams.getManyByIds",
      listForPicker: "teams.listForPicker",
      // NEO-330 — the picker's two-characters-and-up path.
      search: "teams.search",
    },
    leagues: { list: "leagues.list" },
  },
}));

type TeamRow = {
  _id: string;
  name: string;
  location?: string;
  leagueId?: string;
  colors?: { primary?: string; secondary?: string };
};

let careerTeams: TeamRow[];
let allTeams: TeamRow[];
/** NEO-330 — `teams.search`'s answer; `undefined` (in flight) by default. */
let searchedTeams: TeamRow[] | undefined;
let searchCalls: unknown[];

vi.mock("convex/react", () => ({
  useQuery: (ref: string, args: unknown) => {
    if (ref === "teams.getManyByIds") {
      return args === "skip" ? undefined : careerTeams;
    }
    if (ref === "teams.listForPicker") return allTeams;
    if (ref === "teams.search") {
      if (args === "skip") return undefined;
      searchCalls.push(args);
      return searchedTeams;
    }
    if (ref === "leagues.list") return [];
    return undefined;
  },
}));

/**
 * The real one is a server-backed search. All this page needs from it is the
 * selected player, so the stub is a button that hands one over.
 */
const PLAYER_FIXTURE = {
  _id: "player-1",
  name: "Fernando Tatis Jr.",
  teamYears: [{ teamId: "team-1", startYear: 2019, endYear: 2026 }],
};

vi.mock("@/components/PlayerAutocomplete", () => ({
  PlayerAutocomplete: ({
    onSelect,
  }: {
    onSelect: (p: typeof PLAYER_FIXTURE) => void;
  }) => (
    <button type="button" onClick={() => onSelect(PLAYER_FIXTURE)}>
      Stub pick player
    </button>
  ),
}));

import SpineLabelPage from "./page";

describe("SpineLabelPage — NEO-236 team names", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    careerTeams = [];
    allTeams = [];
    searchedTeams = undefined;
    searchCalls = [];
  });

  it("labels a career-team chip with the composed full name", () => {
    careerTeams = [
      {
        _id: "team-1",
        name: "Padres",
        location: "San Diego",
        colors: { primary: "#2F241D", secondary: "#FFC425" },
      },
    ];
    render(<SpineLabelPage />);

    fireEvent.click(screen.getByText("Stub pick player"));

    expect(screen.getByText("San Diego Padres")).toBeTruthy();
  });

  it("leaves a location-less career team reading exactly as its name", () => {
    careerTeams = [{ _id: "team-1", name: "Nippon-Ham Fighters" }];
    render(<SpineLabelPage />);

    fireEvent.click(screen.getByText("Stub pick player"));

    expect(screen.getByText("Nippon-Ham Fighters")).toBeTruthy();
  });

  // The any-team search is the path for a hand-typed name — no player, no
  // career teams. Someone typing "San Diego" there is naming a team; matching
  // `name` alone would tell them the Padres are not in the database.
  it("finds a split row by its location and offers it by its full name", () => {
    allTeams = [{ _id: "team-1", name: "Padres", location: "San Diego" }];
    render(<SpineLabelPage />);

    fireEvent.change(screen.getByLabelText("Find a team"), {
      target: { value: "San Diego" },
    });

    expect(screen.getByText("San Diego Padres")).toBeTruthy();
  });

  it("drops the full name into the box when a split row is picked", () => {
    allTeams = [
      {
        _id: "team-1",
        name: "Padres",
        location: "San Diego",
        colors: { primary: "#2F241D", secondary: "#FFC425" },
      },
    ];
    render(<SpineLabelPage />);

    const input = screen.getByLabelText("Find a team") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Padres" } });
    // mouseDown, not click: the shared Autocomplete selects on mousedown so
    // the input's blur cannot close the list first.
    fireEvent.mouseDown(screen.getByText("San Diego Padres"));

    expect(input.value).toBe("San Diego Padres");
  });
});

/**
 * NEO-330 — `listForPicker` is a capped window, so a team outside it could
 * never be offered. From two typed characters the picker asks `teams.search`,
 * which reaches every team.
 */
describe("SpineLabelPage — the team picker reaches every team (NEO-330)", () => {
  beforeEach(() => {
    careerTeams = [];
    allTeams = [];
    searchedTeams = undefined;
    searchCalls = [];
  });

  it("offers a team the window does not hold, once the search answers", async () => {
    searchedTeams = [{ _id: "team-9", name: "Expos", location: "Montreal" }];
    render(<SpineLabelPage />);

    fireEvent.change(screen.getByLabelText("Find a team"), {
      target: { value: "Expos" },
    });

    expect(await screen.findByText("Montreal Expos")).toBeTruthy();
    expect(searchCalls).toContainEqual({ query: "Expos", limit: 25 });
  });

  it("applies the league filter to the search's answer", async () => {
    searchedTeams = [
      { _id: "team-9", name: "Expos", location: "Montreal", leagueId: "l-nl" },
      { _id: "team-8", name: "Royals", location: "Montreal", leagueId: "l-il" },
    ];
    render(<SpineLabelPage />);
    // No league options are mocked, so the select is driven to a value the
    // page treats as a filter all the same.
    const leagueSelect = screen.getByLabelText("League") as HTMLSelectElement;
    const option = document.createElement("option");
    option.value = "l-nl";
    leagueSelect.appendChild(option);
    fireEvent.change(leagueSelect, { target: { value: "l-nl" } });

    fireEvent.change(screen.getByLabelText("Find a team"), {
      target: { value: "Montreal" },
    });

    expect(await screen.findByText("Montreal Expos")).toBeTruthy();
    expect(screen.queryByText("Montreal Royals")).toBeNull();
  });

  it("says Searching… while a search is in flight, never a false 'No teams match'", async () => {
    // Nothing in the window matches, and the server has not answered yet.
    render(<SpineLabelPage />);
    fireEvent.change(screen.getByLabelText("Find a team"), {
      target: { value: "Expos" },
    });

    expect(screen.getByText("Searching…")).toBeTruthy();
    expect(screen.queryByText("No teams match")).toBeNull();
    // Past the debounce, still unanswered: still searching.
    await waitFor(() => expect(searchCalls).toContainEqual({ query: "Expos", limit: 25 }));
    expect(screen.getByText("Searching…")).toBeTruthy();
    expect(screen.queryByText("No teams match")).toBeNull();
  });

  it("says No teams match once the search answers with nothing", async () => {
    searchedTeams = [];
    render(<SpineLabelPage />);
    fireEvent.change(screen.getByLabelText("Find a team"), {
      target: { value: "zzzz" },
    });

    expect(await screen.findByText("No teams match")).toBeTruthy();
    expect(screen.queryByText("Searching…")).toBeNull();
  });

  it("keeps showing window matches, not Searching…, while the search is in flight", () => {
    allTeams = [{ _id: "team-1", name: "Expos", location: "Montreal" }];
    render(<SpineLabelPage />);
    fireEvent.change(screen.getByLabelText("Find a team"), {
      target: { value: "Expos" },
    });

    expect(screen.getByText("Montreal Expos")).toBeTruthy();
    expect(screen.queryByText("Searching…")).toBeNull();
  });

  it("does not search on a single character", async () => {
    render(<SpineLabelPage />);
    fireEvent.change(screen.getByLabelText("Find a team"), {
      target: { value: "m" },
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await waitFor(() => expect(searchCalls).toEqual([]));
  });
});
