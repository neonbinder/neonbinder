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

import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/convex/_generated/api", () => ({
  api: {
    teams: {
      getManyByIds: "teams.getManyByIds",
      listForPicker: "teams.listForPicker",
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

vi.mock("convex/react", () => ({
  useQuery: (ref: string, args: unknown) => {
    if (ref === "teams.getManyByIds") {
      return args === "skip" ? undefined : careerTeams;
    }
    if (ref === "teams.listForPicker") return allTeams;
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
