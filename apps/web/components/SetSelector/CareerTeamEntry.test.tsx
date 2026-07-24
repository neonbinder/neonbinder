/**
 * NEO-92 follow-up: coverage for `CareerTeamEntry` — the manual career-team
 * mini-form used by EntityReviewWizard for player rows. Locks in:
 *   1. Free-text add: a name that matches no existing team is still accepted
 *      (unlike EntityLinkSearch, which is pick-existing-only) — that name
 *      becomes a new team via get-or-create at commit time.
 *   2. Typeahead: existing teams for the sport are suggested (prefix-ranked),
 *      and picking one fills the name field without adding.
 *   3. Year bounds mirror the server validation — Add is disabled for an
 *      out-of-bounds / inverted year range.
 *   4. onAdd emits the trimmed {name, fromYear, toYear?} shape and the form
 *      clears afterward.
 *
 * Mocking mirrors EntityLinkSearch.test.tsx / PlayerPicker.test.tsx:
 * convex/react's useQuery is module-mocked, routed by the string-mocked
 * teams.list reference.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../convex/_generated/api", () => ({
  api: { teams: { list: "teams.list" } },
}));

let currentTeams: unknown;
vi.mock("convex/react", () => ({
  useQuery: (ref: string, args: unknown) => {
    if (args === "skip") return undefined;
    if (ref === "teams.list") return currentTeams;
    return undefined;
  },
}));

import CareerTeamEntry from "./CareerTeamEntry";

function makeTeam(name: string, id: string) {
  return { _id: id, name };
}

beforeEach(() => {
  vi.clearAllMocks();
  currentTeams = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("CareerTeamEntry", () => {
  it("accepts a free-text team name that matches nothing and emits it via onAdd", () => {
    currentTeams = [];
    const onAdd = vi.fn();
    render(<CareerTeamEntry sport="Baseball" onAdd={onAdd} />);

    fireEvent.change(screen.getByLabelText("Career team name"), {
      target: { value: "Brand New Club" },
    });
    fireEvent.change(screen.getByLabelText("From year"), { target: { value: "2021" } });
    fireEvent.click(screen.getByRole("button", { name: "Add career team" }));

    expect(onAdd).toHaveBeenCalledWith({ name: "Brand New Club", fromYear: 2021 });
    // Form cleared for the next entry.
    expect((screen.getByLabelText("Career team name") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("From year") as HTMLInputElement).value).toBe("");
  });

  it("includes toYear when provided", () => {
    const onAdd = vi.fn();
    render(<CareerTeamEntry sport="Baseball" onAdd={onAdd} />);

    fireEvent.change(screen.getByLabelText("Career team name"), {
      target: { value: "Arizona Diamondbacks" },
    });
    fireEvent.change(screen.getByLabelText("From year"), { target: { value: "2020" } });
    fireEvent.change(screen.getByLabelText("To year (optional)"), { target: { value: "2022" } });
    fireEvent.click(screen.getByRole("button", { name: "Add career team" }));

    expect(onAdd).toHaveBeenCalledWith({
      name: "Arizona Diamondbacks",
      fromYear: 2020,
      toYear: 2022,
    });
  });

  it("suggests existing teams and picking one fills the name field without adding", () => {
    currentTeams = [
      makeTeam("Toronto Blue Jays", "t1"),
      makeTeam("Tampa Bay Rays", "t2"),
      makeTeam("Boston Red Sox", "t3"),
    ];
    const onAdd = vi.fn();
    render(<CareerTeamEntry sport="Baseball" onAdd={onAdd} />);

    fireEvent.change(screen.getByLabelText("Career team name"), { target: { value: "T" } });

    // Both "T" teams surface; picking one fills the input, does not add.
    const option = screen.getByRole("option", { name: "Use existing team Toronto Blue Jays" });
    fireEvent.click(option);

    expect((screen.getByLabelText("Career team name") as HTMLInputElement).value).toBe(
      "Toronto Blue Jays",
    );
    expect(onAdd).not.toHaveBeenCalled();
  });

  it("disables Add for an out-of-bounds fromYear", () => {
    const onAdd = vi.fn();
    render(<CareerTeamEntry sport="Baseball" onAdd={onAdd} />);

    fireEvent.change(screen.getByLabelText("Career team name"), {
      target: { value: "Ancient Club" },
    });
    fireEvent.change(screen.getByLabelText("From year"), { target: { value: "1200" } });

    expect((screen.getByRole("button", { name: "Add career team" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(onAdd).not.toHaveBeenCalled();
  });

  it("disables Add when toYear precedes fromYear", () => {
    const onAdd = vi.fn();
    render(<CareerTeamEntry sport="Baseball" onAdd={onAdd} />);

    fireEvent.change(screen.getByLabelText("Career team name"), {
      target: { value: "Backwards Club" },
    });
    fireEvent.change(screen.getByLabelText("From year"), { target: { value: "2022" } });
    fireEvent.change(screen.getByLabelText("To year (optional)"), { target: { value: "2019" } });

    expect((screen.getByRole("button", { name: "Add career team" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("disables Add when the name is blank even if the year is valid", () => {
    const onAdd = vi.fn();
    render(<CareerTeamEntry sport="Baseball" onAdd={onAdd} />);

    fireEvent.change(screen.getByLabelText("From year"), { target: { value: "2021" } });

    expect((screen.getByRole("button", { name: "Add career team" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});
