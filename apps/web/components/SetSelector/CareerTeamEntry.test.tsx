/**
 * NEO-92 follow-up / NEO-212: coverage for `CareerTeamEntry` — the manual
 * career-team mini-form used by EntityReviewWizard for player rows.
 *
 * Locks in:
 *   1. Free-text add: a name that matches no existing team is still accepted
 *      (unlike EntityLinkSearch, which is pick-existing-only) — that name
 *      becomes a new team via get-or-create at commit time.
 *   2. Typeahead: STAGED names (teams this review will create) come first and are
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
  it("lists staged names BEFORE search results, with no tag of their own", () => {
    // The ordering is the point: a saved team is discoverable by typing its
    // full name; one that exists only as a pending decision in this batch is
    // not, so it has to be the thing the operator sees first.
    currentTeams = [makeTeam("Toronto Maple Leafs", "t1")];
    renderEntry({ stagedNames: ["Toronto Blue Jays"] });

    typeName("Toronto");

    const options = screen.getAllByRole("option");
    expect(options[0].getAttribute("aria-label")).toBe(
      "Use Toronto Blue Jays",
    );
    expect(options[1].getAttribute("aria-label")).toBe(
      "Use Toronto Maple Leafs",
    );
    // NEO-236: neither row says anything about WHERE it came from. A staged
    // name still sorts first — it is the one the operator cannot find any other
    // way — but "not saved yet" told them nothing they could act on, so both
    // rows now read as the plain team name.
    expect(options[0].textContent).toBe("Toronto Blue Jays");
    expect(options[1].textContent).toBe("Toronto Maple Leafs");
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
      "Use Toronto Blue Jays",
      "Use Tampa Bay Rays",
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
      screen.getByRole("option", { name: "Use Toronto Blue Jays" }),
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
      screen.getByRole("option", { name: "Use Toronto Blue Jays" }),
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
// ---------------------------------------------------------------------------
// NEO-236 — ONE box, and the split happens on the team's own step
//
// Jason, 2026-09-05: "we should also remove the Location box from New Players
// as we should only be selecting existing teams or entering it in the singular
// field which would trigger that new team dialog."
//
// An earlier pass put a Location field beside the name here. It asked the
// operator to split a team while they were dating a stint, in a form with no
// room for the League, and it asked it in a different place from every other
// team creation in the product. What this component reports upward is a STINT;
// the team it names is either one we already hold or one the batch is about to
// ask about on a New Team step of its own.
// ---------------------------------------------------------------------------

describe("CareerTeamEntry — one box", () => {
  it("has no Location field at all", () => {
    renderEntry();

    expect(
      screen.queryByLabelText("Career team location (optional)"),
    ).toBeNull();
    // ...and no composed preview either: there is nothing here to compose, and
    // the "Shows as" line belongs to the New Team step that does the splitting.
    expect(screen.queryByText(/Shows as:/)).toBeNull();
    expect(screen.getByLabelText("Career team name")).toBeTruthy();
  });

  it("emits the WHOLE typed name, trimmed, and never a location key", () => {
    const { onAdd } = renderEntry();

    typeName("  San Diego Padres  ");
    fireEvent.change(screen.getByLabelText("From year"), { target: { value: "2004" } });
    fireEvent.click(screen.getByRole("button", { name: "Add career team" }));

    // Exactly this shape: a `location` key here would be a second place the
    // split could be decided, and two places recording the same answer is how
    // they end up disagreeing.
    expect(onAdd).toHaveBeenCalledWith({ name: "San Diego Padres", fromYear: 2004 });
  });

  it("still refuses to add without a name, however valid the years are", () => {
    const { onAdd } = renderEntry();

    fireEvent.change(screen.getByLabelText("From year"), { target: { value: "2004" } });

    const addButton = screen.getByRole("button", {
      name: "Add career team",
    }) as HTMLButtonElement;
    expect(addButton.disabled).toBe(true);
    fireEvent.click(addButton);
    expect(onAdd).not.toHaveBeenCalled();
  });

  it("clears the single box after adding", () => {
    renderEntry();

    typeName("San Diego Padres");
    fireEvent.change(screen.getByLabelText("From year"), { target: { value: "2004" } });
    fireEvent.click(screen.getByRole("button", { name: "Add career team" }));

    expect(
      (screen.getByLabelText("Career team name") as HTMLInputElement).value,
    ).toBe("");
  });

  it("suggests a split saved team by its FULL name, and picks the whole thing", () => {
    // A suggestion is something the operator can pick to LINK to, and "Padres"
    // does not identify the row it belongs to. What lands in the box is
    // byte-for-byte the existing row's composed name, which is what makes the
    // commit link rather than create.
    currentTeams = [{ _id: "t1", name: "Padres", location: "San Diego" }];
    renderEntry();

    typeName("Padres");
    fireEvent.click(
      screen.getByRole("option", { name: "Use San Diego Padres" }),
    );

    expect(
      (screen.getByLabelText("Career team name") as HTMLInputElement).value,
    ).toBe("San Diego Padres");
  });

  it("compares the duplicate warning against the saved row's COMPOSED name", () => {
    currentTeams = [{ _id: "t1", name: "Padres", location: "San Diego" }];
    renderEntry();

    // The nickname alone is a near match against "San Diego Padres"...
    typeName("Padres");
    expect(screen.getByText("Did you mean San Diego Padres?")).toBeTruthy();

    // ...and typing the whole name is an EXACT one, so there is nothing to
    // mean instead. Ranking against the stored `name` ("Padres") would report a
    // near match where there is an exact one.
    typeName("San Diego Padres");
    expect(screen.queryByText(/Did you mean/)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// NEO-220 — Escape is the field's, and never the dialog's
//
// The old handler swallowed Escape only while the dropdown had suggestions in
// it. Type a team neither Wikidata nor `teams` has heard of — the exact case
// this field exists for — and Escape bubbled to the wizard root and cancelled
// the whole review batch. The operator pressed a key that means "clear this"
// and lost every decision they had made.
// ---------------------------------------------------------------------------

describe("CareerTeamEntry — Escape", () => {
  /** Renders the field inside a spy container, standing in for the dialog root. */
  function renderInDialog(props: Partial<Parameters<typeof CareerTeamEntry>[0]> = {}) {
    const onRootKeyDown = vi.fn();
    const onAdd = vi.fn();
    render(
      <div onKeyDown={onRootKeyDown}>
        <CareerTeamEntry sportId={SPORT_ID} stagedNames={[]} onAdd={onAdd} {...props} />
      </div>,
    );
    return { onRootKeyDown, onAdd };
  }

  it("closes an open dropdown and stops there", () => {
    const { onRootKeyDown } = renderInDialog({ stagedNames: ["Toronto Blue Jays"] });

    typeName("Toronto");
    expect(screen.getAllByRole("option").length).toBeGreaterThan(0);

    const input = screen.getByLabelText("Career team name") as HTMLInputElement;
    fireEvent.keyDown(input, { key: "Escape" });

    expect(screen.queryAllByRole("option")).toHaveLength(0);
    // The typed name survives — closing a dropdown is not discarding the entry.
    expect(input.value).toBe("Toronto");
    expect(onRootKeyDown).not.toHaveBeenCalled();
  });

  it("clears the name once the dropdown is closed", () => {
    const { onRootKeyDown } = renderInDialog({ stagedNames: ["Toronto Blue Jays"] });

    typeName("Toronto");
    const input = screen.getByLabelText("Career team name") as HTMLInputElement;
    fireEvent.keyDown(input, { key: "Escape" }); // closes the dropdown
    fireEvent.keyDown(input, { key: "Escape" }); // clears the field

    expect(input.value).toBe("");
    expect(onRootKeyDown).not.toHaveBeenCalled();
  });

  it("clears a name that matched nothing — the case that used to cancel the batch", () => {
    // No suggestions at all, so the old guard (`suggestionsOpen &&
    // suggestions.length > 0`) was false and Escape bubbled straight out.
    currentTeams = [];
    const { onRootKeyDown } = renderInDialog();

    typeName("Brand New Club");
    expect(screen.queryAllByRole("option")).toHaveLength(0);

    const input = screen.getByLabelText("Career team name") as HTMLInputElement;
    fireEvent.keyDown(input, { key: "Escape" });

    expect(input.value).toBe("");
    expect(onRootKeyDown).not.toHaveBeenCalled();
  });

  it("never reaches the dialog even with nothing to clear", () => {
    // `stopPropagation` is unconditional on purpose: the guarantee must not
    // depend on which branch of the handler ran.
    const { onRootKeyDown } = renderInDialog();

    fireEvent.keyDown(screen.getByLabelText("Career team name"), { key: "Escape" });

    expect(onRootKeyDown).not.toHaveBeenCalled();
  });

  it("leaves the year fields alone — they are not this handler's business", () => {
    const { onRootKeyDown } = renderInDialog();

    typeName("Toronto Blue Jays");
    fireEvent.change(screen.getByLabelText("From year"), { target: { value: "2023" } });
    fireEvent.keyDown(screen.getByLabelText("Career team name"), { key: "Escape" });

    expect((screen.getByLabelText("From year") as HTMLInputElement).value).toBe("2023");
    expect(onRootKeyDown).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// NEO-236 — the suggestion list has to go away
//
// Jason, 2026-09-06, on player "Rob Blake" after typing "Buffalo Sabres":
// "I can't find any way to dismiss the green list. it should go away once I've
// selected a team or the box has lost focus."
//
// Root cause: `pickSuggestion` closed the list and then called
// `nameInputRef.current.focus()`, while the input carried
// `onFocus={() => setSuggestionsOpen(true)}` — so the refocus reopened what the
// line above had just closed. The list then covered the From/To year fields,
// which are the very next thing to fill in, and blur was unhandled entirely.
// ===========================================================================

describe("CareerTeamEntry — dismissing the suggestion list", () => {
  const listbox = () => screen.queryByRole("listbox", { name: "Existing team suggestions" });

  it("closes on picking a suggestion, and puts focus in From year", () => {
    currentTeams = [{ _id: "t1", name: "Buffalo Sabres" }];
    renderEntry();
    typeName("Buffalo");

    expect(listbox()).toBeTruthy();
    fireEvent.click(screen.getByRole("option", { name: "Use Buffalo Sabres" }));

    expect(listbox()).toBeNull();
    // The team is chosen; the stint is not finished until it has a year.
    expect(document.activeElement).toBe(screen.getByLabelText("From year"));
    expect((screen.getByLabelText("Career team name") as HTMLInputElement).value).toBe(
      "Buffalo Sabres",
    );
  });

  it("stays closed after picking — focusing the box again must not reopen it", () => {
    // The regression itself: the list is opened by TYPING, never by focus.
    currentTeams = [{ _id: "t1", name: "Buffalo Sabres" }];
    renderEntry();
    typeName("Buffalo");
    fireEvent.click(screen.getByRole("option", { name: "Use Buffalo Sabres" }));

    fireEvent.focus(screen.getByLabelText("Career team name"));
    expect(listbox()).toBeNull();
  });

  it("closes when focus leaves the combobox for the year field", () => {
    currentTeams = [{ _id: "t1", name: "Buffalo Sabres" }];
    renderEntry();
    typeName("Buffalo");
    expect(listbox()).toBeTruthy();

    // jsdom does not move focus on `fireEvent.blur`, so drive the real move.
    screen.getByLabelText("From year").focus();
    fireEvent.blur(screen.getByLabelText("Career team name"));
    act(() => {
      vi.advanceTimersByTime(0);
    });

    expect(listbox()).toBeNull();
  });

  it("does NOT close while focus moves within the combobox", () => {
    currentTeams = [{ _id: "t1", name: "Buffalo Sabres" }];
    renderEntry();
    typeName("Buffalo");

    screen.getByRole("option", { name: "Use Buffalo Sabres" }).focus();
    fireEvent.blur(screen.getByLabelText("Career team name"));
    act(() => {
      vi.advanceTimersByTime(0);
    });

    expect(listbox()).toBeTruthy();
  });

  it("closes on Escape without letting it reach the wizard", () => {
    // NEO-220: Escape at the dialog root discards the whole review session, so
    // this field's Escape must never get there.
    currentTeams = [{ _id: "t1", name: "Buffalo Sabres" }];
    const onEscape = vi.fn();
    render(
      <div onKeyDown={onEscape}>
        <CareerTeamEntry sportId={SPORT_ID} stagedNames={[]} onAdd={vi.fn()} />
      </div>,
    );
    fireEvent.change(screen.getByLabelText("Career team name"), {
      target: { value: "Buffalo" },
    });
    act(() => {
      vi.advanceTimersByTime(DEBOUNCE_MS);
    });
    expect(listbox()).toBeTruthy();

    fireEvent.keyDown(screen.getByLabelText("Career team name"), { key: "Escape" });

    expect(listbox()).toBeNull();
    expect(onEscape).not.toHaveBeenCalled();
  });

  it("reopens on ArrowDown, for a keyboard operator who wants it back", () => {
    currentTeams = [{ _id: "t1", name: "Buffalo Sabres" }];
    renderEntry();
    typeName("Buffalo");
    fireEvent.click(screen.getByRole("option", { name: "Use Buffalo Sabres" }));
    expect(listbox()).toBeNull();

    fireEvent.keyDown(screen.getByLabelText("Career team name"), { key: "ArrowDown" });
    expect(listbox()).toBeTruthy();
  });
});
