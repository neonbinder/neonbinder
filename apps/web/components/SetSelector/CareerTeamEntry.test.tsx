/**
 * NEO-92 follow-up / NEO-212: coverage for `CareerTeamEntry` — the manual
 * career-team mini-form used by EntityReviewWizard for player rows.
 *
 * Locks in:
 *   1. Free-text add: a name that matches no existing team is still accepted
 *      (unlike EntityLinkSearch, which is pick-existing-only) — that name
 *      becomes a new team via get-or-create at commit time.
 *   2. Typeahead: STAGED names (this batch's pending teams) come first and are
 *      tagged, then `teams.search` results the staged list does not already
 *      cover. Picking one fills the name field without adding.
 *   3. The "Did you mean {existing}?" prompt for a name that is close to
 *      something already in play but not equal to it — the "NY Yankees" vs
 *      "New York Yankees" case no substring filter catches.
 *   4. Year bounds mirror the server validation — Add is disabled for an
 *      out-of-bounds / inverted year range.
 *   5. onAdd emits the trimmed {name, fromYear, toYear?} shape and the form
 *      clears afterward.
 *
 * NEO-212 replaced the `teams.list` + `limit: 500` client filter with the
 * debounced search index, for the same reason as EntityLinkSearch: 500 is a
 * cap, and past it the team you needed was simply invisible.
 *
 * Every accessible name asserted here that predates NEO-212 ("Career team
 * name", "From year", "To year (optional)", "Add career team", "Use existing
 * team {name}") is a Maestro matcher and is unchanged. The staged suggestion
 * and the "did you mean" prompt are new controls and carry new names.
 *
 * Mocking mirrors EntityLinkSearch.test.tsx / PlayerPicker.test.tsx:
 * convex/react's useQuery is module-mocked, routed by the string-mocked
 * teams.search reference.
 */

import { act, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Id } from "../../convex/_generated/dataModel";

// NEO-96: the sport-level selectorOptions ROW ID, not a display string.
const SPORT_ID = "selopt-sport-1" as unknown as Id<"selectorOptions">;

/** Matches SEARCH_DEBOUNCE_MS in the component. */
const DEBOUNCE_MS = 200;

vi.mock("../../convex/_generated/api", () => ({
  api: { teams: { search: "teams.search", list: "teams.list" } },
}));

let currentTeams: unknown;
let queryCalls: Array<{ ref: string; args: unknown }>;

vi.mock("convex/react", () => ({
  useQuery: (ref: string, args: unknown) => {
    queryCalls.push({ ref, args });
    if (args === "skip") return undefined;
    if (ref === "teams.search") return currentTeams;
    return undefined;
  },
}));

import CareerTeamEntry from "./CareerTeamEntry";

function makeTeam(name: string, id: string) {
  return { _id: id, name };
}

function renderEntry(
  props: Partial<Parameters<typeof CareerTeamEntry>[0]> = {},
) {
  const onAdd = vi.fn();
  const utils = render(
    <CareerTeamEntry sportId={SPORT_ID} stagedNames={[]} onAdd={onAdd} {...props} />,
  );
  return { ...utils, onAdd };
}

/** Type a team name and let the search debounce elapse. */
function typeName(value: string) {
  fireEvent.change(screen.getByLabelText("Career team name"), {
    target: { value },
  });
  act(() => {
    vi.advanceTimersByTime(DEBOUNCE_MS);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  currentTeams = [];
  queryCalls = [];
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Adding entries — unchanged behavior, unchanged labels
// ---------------------------------------------------------------------------

describe("CareerTeamEntry — adding", () => {
  it("accepts a free-text team name that matches nothing and emits it via onAdd", () => {
    const { onAdd } = renderEntry();

    typeName("Brand New Club");
    fireEvent.change(screen.getByLabelText("From year"), { target: { value: "2021" } });
    fireEvent.click(screen.getByRole("button", { name: "Add career team" }));

    expect(onAdd).toHaveBeenCalledWith({ name: "Brand New Club", fromYear: 2021 });
    // Form cleared for the next entry.
    expect((screen.getByLabelText("Career team name") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("From year") as HTMLInputElement).value).toBe("");
  });

  it("includes toYear when provided", () => {
    const { onAdd } = renderEntry();

    typeName("Arizona Diamondbacks");
    fireEvent.change(screen.getByLabelText("From year"), { target: { value: "2020" } });
    fireEvent.change(screen.getByLabelText("To year (optional)"), { target: { value: "2022" } });
    fireEvent.click(screen.getByRole("button", { name: "Add career team" }));

    expect(onAdd).toHaveBeenCalledWith({
      name: "Arizona Diamondbacks",
      fromYear: 2020,
      toYear: 2022,
    });
  });

  it("disables Add for an out-of-bounds fromYear", () => {
    const { onAdd } = renderEntry();

    typeName("Ancient Club");
    fireEvent.change(screen.getByLabelText("From year"), { target: { value: "1200" } });

    expect(
      (screen.getByRole("button", { name: "Add career team" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(onAdd).not.toHaveBeenCalled();
  });

  it("disables Add when toYear precedes fromYear", () => {
    renderEntry();

    typeName("Backwards Club");
    fireEvent.change(screen.getByLabelText("From year"), { target: { value: "2022" } });
    fireEvent.change(screen.getByLabelText("To year (optional)"), { target: { value: "2019" } });

    expect(
      (screen.getByRole("button", { name: "Add career team" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("disables Add when the name is blank even if the year is valid", () => {
    renderEntry();

    fireEvent.change(screen.getByLabelText("From year"), { target: { value: "2021" } });

    expect(
      (screen.getByRole("button", { name: "Add career team" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// NEO-212 — the search-index data path
// ---------------------------------------------------------------------------

describe("CareerTeamEntry — search source", () => {
  it("queries teams.search (never teams.list) with the typed name and sport", () => {
    renderEntry();
    typeName("Blue");

    const lastSearch = queryCalls.filter((c) => c.ref === "teams.search").pop();
    expect(lastSearch?.args).toEqual({ query: "Blue", sportId: SPORT_ID });
    expect(queryCalls.some((c) => c.ref === "teams.list")).toBe(false);
  });

  it("skips the query while the field is blank", () => {
    renderEntry();

    const lastSearch = queryCalls.filter((c) => c.ref === "teams.search").pop();
    expect(lastSearch?.args).toBe("skip");
  });
});

// ---------------------------------------------------------------------------
// NEO-212 — staged names come first
// ---------------------------------------------------------------------------

describe("CareerTeamEntry — staged suggestions", () => {
  it("lists staged names BEFORE search results, tagged 'this batch'", () => {
    // The ordering is the point: a saved team is discoverable by typing its
    // full name; one that exists only as a pending decision in this batch is
    // not, so it has to be the thing the operator sees first.
    currentTeams = [makeTeam("Toronto Maple Leafs", "t1")];
    renderEntry({ stagedNames: ["Toronto Blue Jays"] });

    typeName("Toronto");

    const options = screen.getAllByRole("option");
    expect(options[0].getAttribute("aria-label")).toBe(
      "Use Toronto Blue Jays from this batch",
    );
    expect(options[1].getAttribute("aria-label")).toBe(
      "Use existing team Toronto Maple Leafs",
    );
    expect(options[0].textContent).toContain("this batch");
    expect(options[1].textContent).not.toContain("this batch");
  });

  it("appends search results without duplicating a staged name", () => {
    // A team already staged AND already saved must appear once — the same name
    // twice, once tagged and once not, reads as two different teams.
    currentTeams = [makeTeam("Toronto Blue Jays", "t1"), makeTeam("Tampa Bay Rays", "t2")];
    renderEntry({ stagedNames: ["Toronto Blue Jays"] });

    typeName("T");

    const labels = screen
      .getAllByRole("option")
      .map((el) => el.getAttribute("aria-label"));
    expect(labels).toEqual([
      "Use Toronto Blue Jays from this batch",
      "Use existing team Tampa Bay Rays",
    ]);
  });

  it("dedupes a staged name against a saved one by the normalized key, not raw text", () => {
    currentTeams = [makeTeam("toronto blue jays", "t1")];
    renderEntry({ stagedNames: ["Toronto Blue Jays"] });

    typeName("Toronto");

    expect(screen.getAllByRole("option")).toHaveLength(1);
  });

  it("picking a staged suggestion fills the name field without adding", () => {
    const { onAdd } = renderEntry({ stagedNames: ["Toronto Blue Jays"] });

    typeName("Toronto");
    fireEvent.click(
      screen.getByRole("option", { name: "Use Toronto Blue Jays from this batch" }),
    );

    expect((screen.getByLabelText("Career team name") as HTMLInputElement).value).toBe(
      "Toronto Blue Jays",
    );
    expect(onAdd).not.toHaveBeenCalled();
  });

  it("picking a saved suggestion fills the name field without adding (label unchanged)", () => {
    currentTeams = [
      makeTeam("Toronto Blue Jays", "t1"),
      makeTeam("Tampa Bay Rays", "t2"),
      makeTeam("Boston Red Sox", "t3"),
    ];
    const { onAdd } = renderEntry();

    typeName("T");
    fireEvent.click(
      screen.getByRole("option", { name: "Use existing team Toronto Blue Jays" }),
    );

    expect((screen.getByLabelText("Career team name") as HTMLInputElement).value).toBe(
      "Toronto Blue Jays",
    );
    expect(onAdd).not.toHaveBeenCalled();
  });

  it("shows no suggestions while the field is blank", () => {
    currentTeams = [makeTeam("Toronto Blue Jays", "t1")];
    renderEntry({ stagedNames: ["Tampa Bay Rays"] });

    fireEvent.focus(screen.getByLabelText("Career team name"));

    expect(screen.queryAllByRole("option")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// NEO-212 — the "did you mean" prompt
// ---------------------------------------------------------------------------

describe("CareerTeamEntry — 'Did you mean' prompt", () => {
  it("offers a close staged match, and picking it fills the input", () => {
    // "NY Yankees" is not a substring of "New York Yankees" — they share
    // "yankees", which is exactly the rung rankTeamCandidates adds and the old
    // substring filter never had.
    const { onAdd } = renderEntry({ stagedNames: ["New York Yankees"] });

    typeName("NY Yankees");

    // The accessible name IS the visible text — the old `aria-label="Use
    // {name}"` shared not one word with what the operator could read, so a
    // voice-control user saying it matched nothing (WCAG 2.2 SC 2.5.3).
    const hint = screen.getByRole("button", {
      name: "Did you mean New York Yankees?",
    });
    expect(hint.textContent).toBe("Did you mean New York Yankees?");
    expect(hint.getAttribute("aria-label")).toBeNull();
    expect(screen.queryByLabelText("Use New York Yankees")).toBeNull();

    fireEvent.click(hint);
    expect((screen.getByLabelText("Career team name") as HTMLInputElement).value).toBe(
      "New York Yankees",
    );
    expect(onAdd).not.toHaveBeenCalled();
  });

  it("offers a close SEARCHED match too, not just a staged one", () => {
    currentTeams = [makeTeam("New York Yankees", "t1")];
    renderEntry();

    typeName("NY Yankees");

    expect(
      screen.getByRole("button", { name: "Did you mean New York Yankees?" }),
    ).toBeTruthy();
  });

  it("stays silent when the typed name EXACTLY matches something in play", () => {
    // Nothing to mean instead — the operator already typed the right name.
    renderEntry({ stagedNames: ["New York Yankees"] });

    typeName("new york yankees");

    expect(screen.queryByText(/Did you mean/)).toBeNull();
  });

  it("stays silent when nothing is close", () => {
    currentTeams = [];
    renderEntry({ stagedNames: ["New York Yankees"] });

    typeName("Brand New Club");

    expect(screen.queryByText(/Did you mean/)).toBeNull();
  });

  it("stays silent while the field is blank", () => {
    renderEntry({ stagedNames: ["New York Yankees"] });

    expect(screen.queryByText(/Did you mean/)).toBeNull();
  });
});
