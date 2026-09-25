/**
 * NEO-307 — the team search inside the review wizard's Possible matches panel.
 *
 * Jason's case, as fixtures: a New Team step for "Brooklyn Dodgers" whose near
 * matches are four OTHER Brooklyn clubs, while NB already holds the Brooklyn
 * Dodgers (MLB, 1911–1957). What is locked in:
 *
 *  - The field opens holding the proposed name, and while it does its options
 *    are the near matches — with league and years under each — and no search
 *    is sent.
 *  - Typing hands the finding to `teams.search` (server-backed, sport-scoped,
 *    debounced), never to a client-side filter of a bulk list.
 *  - An option is "Location Name" with "League · years" on its own line, so
 *    the five Dodgers can be told apart.
 *  - A pick, by mouse or by keyboard, reports the team's id and full name to
 *    `onPick` and nothing else — the wizard owns what linking does.
 *  - The accessible name "Search all teams" is an E2E contract.
 */

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Id } from "../../convex/_generated/dataModel";
import type { NearMatch } from "./NearMatchPanel";

const SPORT_ID = "selopt-sport-baseball" as unknown as Id<"selectorOptions">;
/** Matches SEARCH_DEBOUNCE_MS in the component. */
const DEBOUNCE_MS = 200;

vi.mock("../../convex/_generated/api", () => ({
  api: {
    teams: { search: "teams.search", getManyByIds: "teams.getManyByIds" },
    leagues: { list: "leagues.list" },
  },
}));

type TeamRow = {
  _id: string;
  name: string;
  location?: string;
  leagueId?: string;
  league?: string;
  yearsActive?: { from: number; to?: number };
};

const MLB = { _id: "lg-mlb", name: "Major League Baseball", abbreviation: "MLB" };
const NEGRO = { _id: "lg-nnl", name: "Negro National League" };

const BROOKLYN_DODGERS: TeamRow = {
  _id: "t-bkn-dodgers",
  location: "Brooklyn",
  name: "Dodgers",
  leagueId: MLB._id,
  yearsActive: { from: 1911, to: 1957 },
};
const LA_DODGERS: TeamRow = {
  _id: "t-la-dodgers",
  location: "Los Angeles",
  name: "Dodgers",
  leagueId: MLB._id,
  yearsActive: { from: 1958 },
};
const BRIDEGROOMS: TeamRow = {
  _id: "t-bridegrooms",
  location: "Brooklyn",
  name: "Bridegrooms",
  leagueId: MLB._id,
  yearsActive: { from: 1888, to: 1898 },
};
const EAGLES: TeamRow = {
  _id: "t-eagles",
  location: "Brooklyn",
  name: "Eagles",
  leagueId: NEGRO._id,
  yearsActive: { from: 1935, to: 1935 },
};
const CYCLONES: TeamRow = {
  _id: "t-cyclones",
  location: "Brooklyn",
  name: "Cyclones",
  // No league row, only the deprecated free-text one; and no years.
  league: "NY-Penn League",
};

const NEAR: NearMatch[] = [
  { _id: BRIDEGROOMS._id, name: "Brooklyn Bridegrooms", confidence: "close", yearsActive: BRIDEGROOMS.yearsActive },
  { _id: CYCLONES._id, name: "Brooklyn Cyclones", confidence: "close" },
  { _id: EAGLES._id, name: "Brooklyn Eagles", confidence: "close", yearsActive: EAGLES.yearsActive },
];

/** What the server search "finds" for a term — a crude stand-in for the index. */
const ALL_TEAMS = [BROOKLYN_DODGERS, LA_DODGERS, BRIDEGROOMS, EAGLES, CYCLONES];
let searchResponds = true;
let queryCalls: Array<{ ref: string; args: unknown }>;

vi.mock("convex/react", () => ({
  useQuery: (ref: string, args: unknown) => {
    queryCalls.push({ ref, args });
    if (args === "skip") return undefined;
    if (ref === "leagues.list") return [MLB, NEGRO];
    if (ref === "teams.getManyByIds") {
      const ids = (args as { ids: string[] }).ids;
      return ALL_TEAMS.filter((t) => ids.includes(t._id));
    }
    if (ref === "teams.search") {
      if (!searchResponds) return undefined;
      const q = (args as { query: string }).query.toLowerCase();
      return ALL_TEAMS.filter((t) =>
        `${t.location ?? ""} ${t.name}`.toLowerCase().includes(q),
      );
    }
    return undefined;
  },
}));

import { TeamMatchSearch, TEAM_MATCH_SEARCH_LABEL } from "./TeamMatchSearch";

function renderSearch(defaultMatches: NearMatch[] = NEAR) {
  const onPick = vi.fn();
  render(
    <TeamMatchSearch
      sportId={SPORT_ID}
      initialQuery="Brooklyn Dodgers"
      defaultMatches={defaultMatches}
      onPick={onPick}
    />,
  );
  return { onPick };
}

const field = () =>
  screen.getByRole("combobox", { name: TEAM_MATCH_SEARCH_LABEL }) as HTMLInputElement;
const options = () =>
  within(screen.getByRole("listbox", { name: `${TEAM_MATCH_SEARCH_LABEL} suggestions` }))
    .queryAllByRole("option")
    .filter((o) => o.getAttribute("aria-disabled") !== "true");
/** An option's label — its direct text, which is what a Maestro flow matches. */
const labelOf = (option: HTMLElement) =>
  Array.from(option.childNodes)
    .filter((n) => n.nodeType === Node.TEXT_NODE)
    .map((n) => n.textContent)
    .join("");
/** Its second line. */
const secondLineOf = (option: HTMLElement) =>
  option.querySelector("span.block")?.textContent ?? null;

function typeInto(value: string) {
  fireEvent.change(field(), { target: { value } });
  act(() => {
    vi.advanceTimersByTime(DEBOUNCE_MS);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  queryCalls = [];
  searchResponds = true;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("TeamMatchSearch", () => {
  it("is named 'Search all teams' — the E2E contract — and opens holding the proposed name", () => {
    renderSearch();
    expect(field().value).toBe("Brooklyn Dodgers");
    // The visible caption is the same words as the accessible name (SC 2.5.3).
    expect(screen.getByText(TEAM_MATCH_SEARCH_LABEL)).toBeTruthy();
  });

  it("offers the near matches, with league and years under each, and sends no search", () => {
    renderSearch();
    fireEvent.focus(field());

    const opts = options();
    expect(opts.map(labelOf)).toEqual([
      "Brooklyn Bridegrooms",
      "Brooklyn Cyclones",
      "Brooklyn Eagles",
    ]);
    // League from the league row (abbreviation when it has one, else its
    // name), then the era; the deprecated free-text league as a fallback; a
    // row with neither fact has no second line.
    expect(opts.map(secondLineOf)).toEqual([
      "MLB · 1888–1898",
      "NY-Penn League",
      "Negro National League · 1935–1935",
    ]);

    const searches = queryCalls.filter((c) => c.ref === "teams.search");
    expect(searches.length).toBeGreaterThan(0);
    expect(searches.every((c) => c.args === "skip")).toBe(true);
  });

  it("puts an exact near match first and says why each near match is there, in the old panel's words", () => {
    renderSearch([
      NEAR[0],
      { _id: BROOKLYN_DODGERS._id, name: "Brooklyn Dodgers", confidence: "exact" },
      { _id: EAGLES._id, name: "Brooklyn Eagles", confidence: "exact", matchedAlias: "Bkn Eagles" },
    ]);
    fireEvent.focus(field());
    const opts = options();
    expect(opts.map(labelOf)).toEqual([
      "Brooklyn Dodgers",
      "Brooklyn Eagles",
      "Brooklyn Bridegrooms",
    ]);
    expect(opts.map(secondLineOf)).toEqual([
      "same name · MLB · 1911–1957",
      "also known as “Bkn Eagles” · Negro National League · 1935–1935",
      "MLB · 1888–1898",
    ]);
  });

  it("is headed 'Possible matches' and announces the count only when there are near matches", () => {
    const { container } = render(
      <TeamMatchSearch
        sportId={SPORT_ID}
        initialQuery="Brooklyn Dodgers"
        defaultMatches={NEAR}
        onPick={vi.fn()}
      />,
    );
    expect(screen.getByText("Possible matches")).toBeTruthy();
    expect(container.querySelector("[aria-live='polite']")?.textContent).toBe(
      "3 possible matches",
    );
  });

  it("with no near matches: just the caption and the field, and the list stays shut until the operator types", () => {
    const { onPick } = renderSearch([]);
    expect(screen.queryByText("Possible matches")).toBeNull();
    expect(screen.getByText(TEAM_MATCH_SEARCH_LABEL)).toBeTruthy();
    expect(field().value).toBe("Brooklyn Dodgers");

    fireEvent.focus(field());
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(field().getAttribute("aria-expanded")).toBe("false");
    // Enter on the shut list picks nothing.
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(onPick).not.toHaveBeenCalled();

    typeInto("Dodgers");
    expect(options().map(labelOf)).toEqual(["Brooklyn Dodgers", "Los Angeles Dodgers"]);
  });

  it("renders the still-loading near-match query exactly as 'none'", () => {
    render(
      <TeamMatchSearch
        sportId={SPORT_ID}
        initialQuery="Brooklyn Dodgers"
        defaultMatches={undefined}
        onPick={vi.fn()}
      />,
    );
    expect(screen.queryByText("Possible matches")).toBeNull();
    fireEvent.focus(field());
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("selects the pre-fill on focus, so typing replaces it rather than appending", () => {
    renderSearch();
    fireEvent.focus(field());
    expect(field().selectionStart).toBe(0);
    expect(field().selectionEnd).toBe("Brooklyn Dodgers".length);
  });

  it("carries no DOM id on the input — flows find it by its accessible name", () => {
    renderSearch();
    expect(field().id).toBe("");
    expect(field().getAttribute("aria-label")).toBe("Search all teams");
  });

  it("typing searches every team in the sport on the server, debounced", () => {
    renderSearch();
    fireEvent.focus(field());
    typeInto("Dodgers");

    const sent = queryCalls
      .filter((c) => c.ref === "teams.search" && c.args !== "skip")
      .map((c) => c.args);
    expect(sent.at(-1)).toEqual({ query: "Dodgers", sportId: SPORT_ID, limit: 25 });
    // Never an unfiltered bulk read.
    expect(queryCalls.some((c) => c.ref === "teams.list")).toBe(false);
  });

  it("finds the existing Brooklyn Dodgers the near matches missed, and a click picks it", () => {
    const { onPick } = renderSearch();
    fireEvent.focus(field());
    typeInto("Dodgers");

    const opts = options();
    expect(opts.map(labelOf)).toEqual(["Brooklyn Dodgers", "Los Angeles Dodgers"]);
    expect(opts.map(secondLineOf)).toEqual(["MLB · 1911–1957", "MLB · 1958–present"]);

    // Autocomplete picks on mousedown (the input's blur would close the list
    // before a click landed).
    fireEvent.mouseDown(opts[0]);
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith(BROOKLYN_DODGERS._id, "Brooklyn Dodgers");
    // The pick stays in the field.
    expect(field().value).toBe("Brooklyn Dodgers");
  });

  it("is keyboard-first: ArrowDown moves the highlight and Enter picks", () => {
    const { onPick } = renderSearch();
    fireEvent.focus(field());
    typeInto("Dodgers");

    fireEvent.keyDown(field(), { key: "ArrowDown" });
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith(LA_DODGERS._id, "Los Angeles Dodgers");
  });

  it("says it is searching — not the stale near matches — while an answer is on its way", () => {
    searchResponds = false;
    renderSearch();
    fireEvent.focus(field());
    // Mid-debounce: nothing sent yet.
    fireEvent.change(field(), { target: { value: "Dodg" } });
    expect(options()).toEqual([]);
    expect(screen.getByText("Searching…")).toBeTruthy();
    // Sent, not back.
    act(() => {
      vi.advanceTimersByTime(DEBOUNCE_MS);
    });
    expect(options()).toEqual([]);
    expect(screen.getByText("Searching…")).toBeTruthy();
  });

  it("says so when nothing by that name exists", () => {
    renderSearch();
    fireEvent.focus(field());
    typeInto("Robins");
    expect(options()).toEqual([]);
    expect(screen.getByText("No teams by that name")).toBeTruthy();
  });

  it("returns to the near matches when the proposed name is typed back", () => {
    renderSearch();
    fireEvent.focus(field());
    typeInto("Dodgers");
    expect(options().map(labelOf)).toContain("Los Angeles Dodgers");
    typeInto("Brooklyn Dodgers");
    expect(options().map(labelOf)).toEqual([
      "Brooklyn Bridegrooms",
      "Brooklyn Cyclones",
      "Brooklyn Eagles",
    ]);
  });
});
