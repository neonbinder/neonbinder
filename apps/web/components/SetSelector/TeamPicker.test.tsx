/**
 * NEO-71-74 — coverage for `TeamPicker`. No test file existed for this
 * component before this session even though it predates `PlayerPicker`;
 * this file covers both its pre-existing chip/popover/keyboard behavior AND
 * the new "+ Create" retrofit (added this session via `teams.findOrCreate`,
 * for the same reason `PlayerPicker` has one — neither BSC's nor
 * SportLots' checklist-sync adapter actually populates the `teams` table,
 * so the candidate pool was routinely empty and operators had no way to add
 * a team at all).
 *
 * Structure mirrors `PlayerPicker.test.tsx` (same session, same component
 * shape) with team-specific additions: the "No matches." empty-state string
 * TeamPicker renders (that PlayerPicker's popover doesn't) and, since NEO-236,
 * the New Team dialog the create row opens.
 *
 * NEO-236 — `teams.location` is no longer a fact printed BESIDE the name; it
 * is the first half OF the name ("San Diego" + "Padres"). So every assertion
 * about what this picker shows, announces or matches on is an assertion about
 * the COMPOSED full name.
 *
 * NEO-236 (Jason, 2026-09-05) — and this picker has ONE box again. "We should
 * only be selecting existing teams or entering it in the singular field which
 * would trigger that new team dialog." An earlier pass put a Location + Name
 * pair inline in this popover; it had no room for the League, so every team
 * created here was silently filed under the sport's default. So the create
 * affordance is now a single row that OPENS `NewTeamDialog`, and the tests
 * below split accordingly:
 *
 *   - what belongs to the PICKER — when the row is offered, what it is called,
 *     that pointer and keyboard both open the dialog with the typed name, and
 *     that neither dismissal path closes the popover out from under the
 *     portalled modal;
 *   - what belongs to the DIALOG — the fields, the league, the refusals — is
 *     `NewTeamDialog.test.tsx` / `NewTeamForm.test.tsx`. The few dialog
 *     assertions kept here are about the WIRING: the picker's typed name
 *     reaching it, and the created id coming back as a chip.
 *
 * --- Mocking strategy (identity-routed useQuery/useMutation) ---
 * `convex/react`'s `useQuery`/`useMutation` are module-mocked, routed by the
 * (string-mocked) query/mutation reference, so `teams.getManyByIds`,
 * `teams.list` and (for the dialog's League pills) `leagues.list` resolve
 * independently, and `teams.findOrCreate` resolves to its own spy.
 */

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Not mocked: the real class, because `userFacingMessage` narrows on
// `instanceof ConvexError` and that is the whole point of the tests below.
import { ConvexError } from "convex/values";

// ---------------------------------------------------------------------------
// Module mocks — declared before the component import
// ---------------------------------------------------------------------------

vi.mock("../../convex/_generated/api", () => ({
  api: {
    teams: {
      getManyByIds: "teams.getManyByIds",
      list: "teams.list",
      // NEO-254: once anything is typed the picker asks the SERVER to find the
      // rows, because a client-side filter over a 500-row window cannot reach
      // soccer's 8,305 teams in one sport. The fixture answers both refs with
      // the same rows: finding is the server's job, ranking is the client's,
      // and these tests are about the ranking.
      search: "teams.search",
      findOrCreate: "teams.findOrCreate",
    },
    // NEO-236: the New Team dialog this picker opens renders `NewTeamForm`,
    // whose League pills read the sport's leagues.
    leagues: { list: "leagues.list" },
  },
}));

let queryCalls: Array<{ ref: string; args: unknown }> = [];
let currentSelectedRows: unknown;
let currentCandidates: unknown;
let currentLeagues: unknown;
const mockFindOrCreate = vi.fn();

vi.mock("convex/react", () => ({
  useQuery: (ref: string, args: unknown) => {
    // NEO-254: recorded so a test can assert WHICH query the picker asked and
    // with what — the difference between finding a team server-side and
    // filtering a stale window is invisible in the rendered output.
    queryCalls.push({ ref, args });
    if (ref === "teams.getManyByIds") return currentSelectedRows;
    if (ref === "teams.list" || ref === "teams.search") return currentCandidates;
    if (ref === "leagues.list") return currentLeagues;
    return undefined;
  },
  useMutation: (ref: string) =>
    ref === "teams.findOrCreate"
      ? mockFindOrCreate
      : vi.fn(() => Promise.resolve(undefined)),
}));

// ---------------------------------------------------------------------------
// Component under test — imported after mocks
// ---------------------------------------------------------------------------

import TeamPicker from "./TeamPicker";
import type { Id } from "../../convex/_generated/dataModel";

// NEO-96: pickers take the sport-level selectorOptions ROW ID now, not a
// display string. These stand in for a seeded sport row.
const SPORT_ID = "selopt-sport-1" as unknown as Id<"selectorOptions">;
const OTHER_SPORT_ID = "selopt-sport-2" as unknown as Id<"selectorOptions">;

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

function tid(n: string): Id<"teams"> {
  return n as unknown as Id<"teams">;
}

function makeTeam(
  id: string,
  name: string,
  location?: string,
  // NEO-254: a team's era, which for two same-name rows is the only thing that
  // tells them apart.
  yearsActive?: { from: number; to?: number },
) {
  return { _id: tid(id), name, location, yearsActive };
}

function renderPicker(props: Partial<Parameters<typeof TeamPicker>[0]> = {}) {
  const onChange = vi.fn();
  const utils = render(
    <TeamPicker value={[]} onChange={onChange} sportId={SPORT_ID} {...props} />,
  );
  return { ...utils, onChange };
}

function openPopover() {
  fireEvent.click(screen.getByLabelText("Add team"));
}

/** The popover's create affordance, or null when it is not being offered. */
function createRow(): HTMLElement | null {
  return screen.queryByRole("button", { name: /^New team / });
}

/** Type into the search box and open the New Team dialog on what was typed. */
function openNewTeamDialog(query: string) {
  fireEvent.change(screen.getByLabelText("Search teams"), {
    target: { value: query },
  });
  fireEvent.click(screen.getByLabelText(`New team ${query}`));
}

const dialogNameField = () =>
  screen.getByLabelText("New team name") as HTMLInputElement;
const dialogLocationField = () =>
  screen.getByLabelText("New team location (optional)") as HTMLInputElement;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TeamPicker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentSelectedRows = [];
    currentCandidates = [];
    currentLeagues = [];
    queryCalls = [];
    mockFindOrCreate.mockResolvedValue(tid("new-team-1"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Chip rendering (teams.getManyByIds)
  // -------------------------------------------------------------------------

  it("renders a chip per selected id, labeled from teams.getManyByIds", () => {
    currentSelectedRows = [makeTeam("t1", "New York Yankees")];
    renderPicker({ value: [tid("t1")] });

    expect(screen.getByLabelText("Team: New York Yankees")).toBeTruthy();
    expect(screen.getByLabelText("Remove team New York Yankees")).toBeTruthy();
  });

  it("shows a 'Loading…' placeholder label for a chip not yet resolved by getManyByIds", () => {
    currentSelectedRows = undefined;
    renderPicker({ value: [tid("t1")] });

    expect(screen.getByLabelText("Team: Loading…")).toBeTruthy();
  });

  it("clicking a chip's × button removes it via onChange", () => {
    currentSelectedRows = [
      makeTeam("t1", "New York Yankees"),
      makeTeam("t2", "Boston Red Sox"),
    ];
    const { onChange } = renderPicker({ value: [tid("t1"), tid("t2")] });

    fireEvent.click(screen.getByLabelText("Remove team New York Yankees"));

    expect(onChange).toHaveBeenCalledWith([tid("t2")]);
  });

  // -------------------------------------------------------------------------
  // Candidate list (teams.list), filtered/ranked by typed query
  // -------------------------------------------------------------------------

  // NEO-236: this used to assert a "Bronx" SUFFIX printed after the name.
  // A split row's location is the front of its name now, so the option reads
  // as one composed string and the suffix slot carries the league alone —
  // printing the location twice read as a stutter.
  it("lists candidates from teams.list as their composed full name, with the league as the only suffix", () => {
    currentCandidates = [
      { ...makeTeam("t1", "Yankees", "New York"), league: "MLB" },
    ];
    renderPicker();

    openPopover();

    const option = screen.getByLabelText("Add New York Yankees");
    expect(option).toBeTruthy();
    expect(option.textContent).toContain("New York Yankees");
    expect(option.textContent).toContain("MLB");
  });

  it("renders a chip for a split row as its full name, not its nickname", () => {
    currentSelectedRows = [makeTeam("t1", "Padres", "San Diego")];
    renderPicker({ value: [tid("t1")] });

    expect(screen.getByLabelText("Team: San Diego Padres")).toBeTruthy();
    expect(screen.getByLabelText("Remove team San Diego Padres")).toBeTruthy();
  });

  // The duplicate-team risk the split creates, at its source: an operator who
  // types the full name of an ALREADY-SPLIT row has to be shown that row. If
  // the filter compared against `name` alone, "San Diego" would match nothing
  // and the operator would be offered a create — a second Padres.
  it("matches a split row on its location as well as its nickname", () => {
    currentCandidates = [makeTeam("t1", "Padres", "San Diego")];
    renderPicker();
    openPopover();

    fireEvent.change(screen.getByLabelText("Search teams"), {
      target: { value: "San Diego" },
    });

    expect(screen.getByLabelText("Add San Diego Padres")).toBeTruthy();
  });

  it("shows 'No matches.' when a typed query matches no candidate and no create row would help clarify state", () => {
    currentCandidates = [makeTeam("t1", "New York Yankees")];
    renderPicker();
    openPopover();

    fireEvent.change(screen.getByLabelText("Search teams"), {
      target: { value: "Zzzz Nonexistent" },
    });

    expect(screen.getByText("No matches.")).toBeTruthy();
  });

  it("excludes already-selected ids from the candidate list", () => {
    currentSelectedRows = [makeTeam("t1", "New York Yankees")];
    currentCandidates = [
      makeTeam("t1", "New York Yankees"),
      makeTeam("t2", "Boston Red Sox"),
    ];
    renderPicker({ value: [tid("t1")] });

    openPopover();

    expect(screen.queryByLabelText("Add New York Yankees")).toBeNull();
    expect(screen.getByLabelText("Add Boston Red Sox")).toBeTruthy();
  });

  it("ranks prefix matches above substring matches when a query is typed", () => {
    currentCandidates = [
      makeTeam("t1", "Brand Newington Athletics"), // "new" is a substring, not a prefix
      makeTeam("t2", "Newt City Miners"), // prefix match
      makeTeam("t3", "New York Yankees"), // prefix match, alphabetically first
    ];
    renderPicker();

    openPopover();
    fireEvent.change(screen.getByLabelText("Search teams"), {
      target: { value: "New" },
    });

    const options = screen
      .getAllByRole("option")
      .filter((el) => el.getAttribute("aria-label")?.startsWith("Add "))
      .map((el) => el.getAttribute("aria-label"));
    expect(options).toEqual([
      "Add New York Yankees",
      "Add Newt City Miners",
      "Add Brand Newington Athletics",
    ]);
  });

  it("clicking a candidate adds its id via onChange and clears the query", () => {
    currentCandidates = [makeTeam("t1", "New York Yankees")];
    const { onChange } = renderPicker({ value: [] });

    openPopover();
    fireEvent.click(screen.getByLabelText("Add New York Yankees"));

    expect(onChange).toHaveBeenCalledWith([tid("t1")]);
  });

  it("adding a match keeps the popover open (so a second team can be picked without re-opening)", () => {
    currentCandidates = [makeTeam("t1", "New York Yankees")];
    renderPicker({ value: [] });

    openPopover();
    fireEvent.click(screen.getByLabelText("Add New York Yankees"));

    expect(screen.getByRole("listbox")).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // Keyboard contract
  // -------------------------------------------------------------------------

  it("ArrowDown/ArrowUp move the highlighted option", () => {
    currentCandidates = [
      makeTeam("t1", "Boston Red Sox"),
      makeTeam("t2", "New York Yankees"),
    ];
    renderPicker();
    openPopover();

    const input = screen.getByLabelText("Search teams");
    expect(
      screen.getByLabelText("Add Boston Red Sox").getAttribute("aria-selected"),
    ).toBe("true");

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(
      screen.getByLabelText("Add New York Yankees").getAttribute("aria-selected"),
    ).toBe("true");

    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(
      screen.getByLabelText("Add Boston Red Sox").getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("Enter selects the highlighted match", () => {
    currentCandidates = [
      makeTeam("t1", "Boston Red Sox"),
      makeTeam("t2", "New York Yankees"),
    ];
    const { onChange } = renderPicker();
    openPopover();

    const input = screen.getByLabelText("Search teams");
    fireEvent.keyDown(input, { key: "ArrowDown" }); // highlight Yankees
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onChange).toHaveBeenCalledWith([tid("t2")]);
  });

  it("Escape closes the popover without selecting anything", () => {
    currentCandidates = [makeTeam("t1", "Boston Red Sox")];
    const { onChange } = renderPicker();
    openPopover();

    fireEvent.keyDown(screen.getByLabelText("Search teams"), { key: "Escape" });

    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  // NEO-102: Escape was the only close, and the popover is `absolute top-full
  // w-64 z-10` — inside MissingTeamFixer that puts it over "Save & Next
  // (Enter)" and "No team on this card", and Escape there means "defer this
  // card" (CardAttentionWalker owns it). So an operator who opened the picker
  // could not uncover the buttons they needed next.
  it("a pointerdown outside the picker closes the popover without selecting anything", () => {
    currentCandidates = [makeTeam("t1", "Boston Red Sox")];
    const { onChange } = renderPicker();
    openPopover();
    expect(screen.getByRole("listbox")).toBeTruthy();

    fireEvent.pointerDown(document.body);

    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("a pointerdown INSIDE the picker leaves the popover open", () => {
    // The multi-team path: picking a match keeps the popover open on purpose
    // (see addChip), so the close must not fire for pointers landing on the
    // picker's own options, input or chips.
    currentCandidates = [makeTeam("t1", "Boston Red Sox")];
    renderPicker();
    openPopover();

    fireEvent.pointerDown(screen.getByLabelText("Add Boston Red Sox"));

    expect(screen.getByRole("listbox")).toBeTruthy();
  });

  it("Backspace on an empty query removes the last chip", () => {
    currentSelectedRows = [
      makeTeam("t1", "Boston Red Sox"),
      makeTeam("t2", "New York Yankees"),
    ];
    const { onChange } = renderPicker({ value: [tid("t1"), tid("t2")] });
    openPopover();

    fireEvent.keyDown(screen.getByLabelText("Search teams"), { key: "Backspace" });

    expect(onChange).toHaveBeenCalledWith([tid("t1")]);
  });

  it("Backspace does nothing when the query is non-empty", () => {
    currentSelectedRows = [makeTeam("t1", "Boston Red Sox")];
    const { onChange } = renderPicker({ value: [tid("t1")] });
    openPopover();

    fireEvent.change(screen.getByLabelText("Search teams"), {
      target: { value: "N" },
    });
    fireEvent.keyDown(screen.getByLabelText("Search teams"), { key: "Backspace" });

    expect(onChange).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // The create affordance — one row, and it OPENS a dialog
  //
  // NEO-71-74 added a "+ Create" row that wrote straight through
  // `teams.findOrCreate`; NEO-236 turned it into a door. The team still needs
  // a League answered and there is nowhere in this popover to answer it.
  // -------------------------------------------------------------------------

  it("offers a '+ New team' row when the typed query matches no candidate exactly", () => {
    currentCandidates = [makeTeam("t1", "New York Yankees")];
    renderPicker();
    openPopover();

    fireEvent.change(screen.getByLabelText("Search teams"), {
      target: { value: "Savannah Bananas" },
    });

    const row = screen.getByLabelText("New team Savannah Bananas");
    // The visible text says what pressing it does; the accessible name is what
    // a Maestro `tapOn` matches. `Create team {name}` deliberately does NOT
    // live here any more — it moved to the dialog's own Create button, which
    // is where a team is actually made.
    expect(row.textContent).toBe("+ New team “Savannah Bananas”…");
    expect(screen.queryByRole("button", { name: /^Create team/ })).toBeNull();
  });

  it("keeps the create row OUT of the listbox, since it is not an option", () => {
    // `aria-current`, not `aria-selected`: the row sits outside the listbox and
    // `aria-selected` would be invalid on it.
    currentCandidates = [];
    renderPicker();
    openPopover();

    fireEvent.change(screen.getByLabelText("Search teams"), {
      target: { value: "Savannah Bananas" },
    });

    const row = screen.getByLabelText("New team Savannah Bananas");
    expect(row.getAttribute("aria-current")).toBe("true");
    expect(row.getAttribute("aria-selected")).toBeNull();
    expect(within(screen.getByRole("listbox")).queryAllByRole("option")).toHaveLength(0);
  });

  /**
   * NEO-254 — the create row STAYS when the name is already taken, and says so.
   *
   * It used to be suppressed on an exact match, which was right while a sport
   * could hold only one team per name. It cannot any more: the 1972-1996
   * Winnipeg Jets and the 2011- Winnipeg Jets are two rows, and hiding Create
   * whenever the name existed made the second franchise unreachable from this
   * picker — an operator would see one Jets row, not recognise it as the wrong
   * era, and attach the card to it.
   *
   * The duplicate is still guarded, just not here: the row names the eras
   * already on file, and `teams.findOrCreate` refuses a second one until the
   * operator confirms it in the dialog. The picker offers; the server insists.
   */
  it("still offers the create row on an exact match, and names what is already there", () => {
    currentCandidates = [
      makeTeam("t1", "Yankees", "New York", { from: 1913 }),
    ];
    renderPicker();
    openPopover();

    fireEvent.change(screen.getByLabelText("Search teams"), {
      target: { value: "new york yankees" },
    });

    expect(createRow()).not.toBeNull();
    expect(createRow()!.textContent).toContain("Already here:");
    expect(createRow()!.textContent).toContain("1913–present");
    // …and the exact row is still matched, which is the half that has not
    // changed: the operator's first option is the row we hold.
    expect(
      screen.getByRole("option", { name: "Add New York Yankees · 1913–present" }),
    ).toBeTruthy();
  });

  it("does not offer the create row when the query is empty", () => {
    // Still suppressed here, and for a reason NEO-254 did not change: there is
    // no name to create.
    currentCandidates = [makeTeam("t1", "New York Yankees")];
    renderPicker();
    openPopover();

    expect(createRow()).toBeNull();
  });

  // The exact-match lookup has to see through the split, or the picker
  // offers to create a team it is already listing one row above.
  it("matches a split row from its full name (and still offers a new era)", () => {
    currentCandidates = [makeTeam("t1", "Padres", "San Diego")];
    renderPicker({ sportId: SPORT_ID });
    openPopover();

    fireEvent.change(screen.getByLabelText("Search teams"), {
      target: { value: "san diego padres" },
    });

    // NEO-254: the create row is no longer suppressed on an exact match — a
    // sport can hold two teams under one name. What these cases were really
    // protecting is that the row is FOUND rather than missed, which is where a
    // duplicate would have come from, so that is what they assert now.
    expect(screen.getByLabelText("Add San Diego Padres")).toBeTruthy();
    expect(createRow()!.textContent).toContain("Already here:");
  });

  it("finds an accented split row from an ASCII query (NEO-253)", () => {
    // The two halves of this box have to agree, and before the fold they did
    // not. The list filtered on a bare `toLowerCase().includes`, so typing
    // "Montreal Expos" HID the accented row; the create offer was decided the
    // same way, so it appeared — and pressing it reached a server whose key
    // DOES fold, which resolved it straight back onto the row the list had
    // just hidden. The operator was shown a create affordance for a team NB
    // already held.
    //
    // With the location carrying the accent, this is also the NEO-236 half:
    // nothing here matches on `name` ("Expos") at all.
    currentCandidates = [makeTeam("t1", "Expos", "Montréal")];
    renderPicker({ sportId: SPORT_ID });
    openPopover();

    fireEvent.change(screen.getByLabelText("Search teams"), {
      target: { value: "Montreal Expos" },
    });

    expect(screen.getByLabelText("Add Montréal Expos")).toBeTruthy();
    // NEO-254: the create row is no longer suppressed on an exact match — a
    // sport can hold two teams under one name. What these cases were really
    // protecting is that the row is FOUND rather than missed, which is where a
    // duplicate would have come from, so that is what they assert now.
    expect(createRow()!.textContent).toContain("Already here:");
  });

  it("finds an ASCII split row from an accented query, matched not created (NEO-253)", () => {
    // The reverse crossing: NB holds the plain spelling and the operator
    // types the real one. Symmetry matters because which side carries the
    // accent depends only on which source happened to create the row first.
    currentCandidates = [makeTeam("t1", "Expos", "Montreal")];
    renderPicker({ sportId: SPORT_ID });
    openPopover();

    fireEvent.change(screen.getByLabelText("Search teams"), {
      target: { value: "Montréal Expos" },
    });

    expect(screen.getByLabelText("Add Montreal Expos")).toBeTruthy();
    // NEO-254: found, not suppressed — see the sibling case above.
    expect(createRow()!.textContent).toContain("Already here:");
  });

  // NEO-96: this test used to assert the OPPOSITE — that with no sport prop the
  // picker called findOrCreate with `sport: ""`. That wrote a team no query
  // could ever find again (every read is an exact sport match), which is one of
  // the ways duplicate/orphaned entities got into the catalogue. Creating now
  // requires a real sport row, so the affordance is hidden instead.
  it("hides the create affordance entirely when no sportId is given", () => {
    currentCandidates = [];
    renderPicker({ sportId: undefined });
    openPopover();

    fireEvent.change(screen.getByLabelText("Search teams"), {
      target: { value: "Savannah Bananas" },
    });

    expect(createRow()).toBeNull();
    expect(mockFindOrCreate).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Opening the dialog
  // -------------------------------------------------------------------------

  it("clicking the create row opens the New Team dialog on the typed name", () => {
    currentCandidates = [];
    renderPicker({ sportId: SPORT_ID });
    openPopover();

    expect(screen.queryByRole("dialog")).toBeNull();
    openNewTeamDialog("Savannah Bananas");

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText("New team: Savannah Bananas")).toBeTruthy();
    // Nothing is written by opening it — the dialog owns the write, and the
    // refusals, because it owns the fields they are about.
    expect(mockFindOrCreate).not.toHaveBeenCalled();
  });

  it("seeds the dialog's Name with the query verbatim, never a guessed split", () => {
    // Splitting here would be the picker deciding that "San Diego" is a
    // location, which is exactly the guess `splitTeamName` refuses to make on
    // its own.
    currentCandidates = [];
    renderPicker({ sportId: SPORT_ID });
    openPopover();

    openNewTeamDialog("San Diego Padres");

    expect(dialogNameField().value).toBe("San Diego Padres");
    expect(dialogLocationField().value).toBe("");
  });

  it("pressing Enter with the create row highlighted opens the dialog rather than creating", () => {
    // Two presses for a team that needs no editing, which is one more than
    // before and buys the League question.
    currentCandidates = [];
    renderPicker({ sportId: SPORT_ID });
    openPopover();

    const input = screen.getByLabelText("Search teams");
    fireEvent.change(input, { target: { value: "Savannah Bananas" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(mockFindOrCreate).not.toHaveBeenCalled();
  });

  it("Enter still selects a highlighted MATCH rather than opening the dialog", () => {
    currentCandidates = [makeTeam("t1", "Savannah Bananas Reserve")];
    const { onChange } = renderPicker({ sportId: SPORT_ID });
    openPopover();

    const input = screen.getByLabelText("Search teams");
    fireEvent.change(input, { target: { value: "Savannah" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onChange).toHaveBeenCalledWith([tid("t1")]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("ArrowDown past the last match reaches the create row, and Enter there opens the dialog", () => {
    currentCandidates = [makeTeam("t1", "Savannah Bananas Reserve")];
    renderPicker({ sportId: SPORT_ID });
    openPopover();

    const input = screen.getByLabelText("Search teams");
    fireEvent.change(input, { target: { value: "Savannah" } });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(
      screen.getByLabelText("New team Savannah").getAttribute("aria-current"),
    ).toBe("true");

    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // The wiring: dialog → findOrCreate → chip
  // -------------------------------------------------------------------------

  it("the dialog's Create button calls teams.findOrCreate and the id lands as a chip", async () => {
    currentCandidates = [];
    mockFindOrCreate.mockResolvedValue(tid("new-team-1"));
    const { onChange } = renderPicker({ sportId: SPORT_ID });
    openPopover();

    openNewTeamDialog("Savannah Bananas");
    fireEvent.click(
      screen.getByRole("button", { name: "Create team Savannah Bananas" }),
    );

    await waitFor(() => {
      expect(mockFindOrCreate).toHaveBeenCalledWith({
        name: "Savannah Bananas",
        sportId: SPORT_ID,
      });
    });
    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith([tid("new-team-1")]);
    });
  });

  it("passes the operator's split through as separate location and name", async () => {
    currentCandidates = [];
    mockFindOrCreate.mockResolvedValue(tid("new-team-3"));
    const { onChange } = renderPicker({ sportId: SPORT_ID });
    openPopover();

    openNewTeamDialog("San Diego Padres");
    fireEvent.change(dialogNameField(), { target: { value: "Padres" } });
    fireEvent.change(dialogLocationField(), { target: { value: "San Diego" } });
    fireEvent.click(
      screen.getByRole("button", { name: "Create team San Diego Padres" }),
    );

    await waitFor(() => {
      expect(mockFindOrCreate).toHaveBeenCalledWith({
        name: "Padres",
        location: "San Diego",
        sportId: SPORT_ID,
      });
    });
    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith([tid("new-team-3")]);
    });
  });

  it("answers the League the popover had no room for", async () => {
    // The whole reason the inline form was replaced: two fields in a popover
    // could not ask this, so every team created here was silently filed under
    // the sport's default.
    currentCandidates = [];
    currentLeagues = [
      { _id: "league-1" as unknown as Id<"leagues">, name: "Savannah Banana Ball" },
    ];
    mockFindOrCreate.mockResolvedValue(tid("new-team-8"));
    renderPicker({ sportId: SPORT_ID });
    openPopover();

    openNewTeamDialog("Savannah Bananas");
    fireEvent.click(screen.getByRole("radio", { name: "Savannah Banana Ball" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Create team Savannah Bananas" }),
    );

    await waitFor(() => {
      expect(mockFindOrCreate).toHaveBeenCalledWith({
        name: "Savannah Bananas",
        sportId: SPORT_ID,
        leagueId: "league-1",
      });
    });
  });

  it("closes the dialog and clears the query once the team is attached", async () => {
    currentCandidates = [];
    mockFindOrCreate.mockResolvedValue(tid("new-team-7"));
    renderPicker({ sportId: SPORT_ID });
    openPopover();

    openNewTeamDialog("Savannah Bananas");
    fireEvent.click(
      screen.getByRole("button", { name: "Create team Savannah Bananas" }),
    );

    await waitFor(() => expect(mockFindOrCreate).toHaveBeenCalledTimes(1));
    // Leaving the query populated would keep offering to create the same team.
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(
      (screen.getByLabelText("Search teams") as HTMLInputElement).value,
    ).toBe("");
    expect(createRow()).toBeNull();
  });

  it("cancelling the dialog attaches nothing and leaves the query where it was", () => {
    currentCandidates = [];
    renderPicker({ sportId: SPORT_ID });
    openPopover();

    openNewTeamDialog("Savannah Bananas");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mockFindOrCreate).not.toHaveBeenCalled();
    expect(
      (screen.getByLabelText("Search teams") as HTMLInputElement).value,
    ).toBe("Savannah Bananas");
    expect(screen.getByLabelText("New team Savannah Bananas")).toBeTruthy();
  });

  it("keeps a refused create visible on the dialog, and adds no chip", async () => {
    // The refusal wording is `NewTeamDialog`'s and is tested there; what this
    // pins is that the picker does not half-apply a create that failed.
    currentCandidates = [];
    mockFindOrCreate.mockRejectedValue(
      new ConvexError("A team name is 130 characters; the limit is 120."),
    );
    const { onChange } = renderPicker({ sportId: SPORT_ID });
    openPopover();

    openNewTeamDialog("Savannah Bananas");
    fireEvent.click(
      screen.getByRole("button", { name: "Create team Savannah Bananas" }),
    );

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(
      "A team name is 130 characters; the limit is 120.",
    );
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(onChange).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // NEO-236 — the popover survives its own modal
  //
  // `NewTeamDialog` portals to `document.body`, so from this picker's point of
  // view opening it looks exactly like focus and pointer LEAVING the picker —
  // which is the signal both dismissal paths were built to close on. Without
  // the `newTeamOpen` guard, opening the dialog immediately unmounted the
  // popover behind it, taking the typed query (and therefore the name the
  // dialog was opened with) with it.
  // -------------------------------------------------------------------------

  describe("the popover stays open behind the New Team dialog", () => {
    it("survives focus moving into the portalled dialog", async () => {
      currentCandidates = [];
      const { container } = renderPicker({ sportId: SPORT_ID });
      openPopover();

      // Let the popover's own open-time autofocus land first, so it cannot win
      // a later timer race and mask what is under test.
      await waitFor(() =>
        expect(document.activeElement).toBe(screen.getByLabelText("Search teams")),
      );

      openNewTeamDialog("Savannah Bananas");

      // Stand-in for the browser dispatching focusout as focus leaves the
      // picker's subtree for the portal.
      const root = container.querySelector(
        '[aria-label="Team picker"]',
      ) as HTMLElement;
      fireEvent.focusOut(root);
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(screen.getByRole("dialog")).toBeTruthy();
      expect(screen.getByRole("listbox")).toBeTruthy();
      expect(
        (screen.getByLabelText("Search teams") as HTMLInputElement).value,
      ).toBe("Savannah Bananas");
    });

    it("survives the blur that the opening CLICK itself produces", async () => {
      /*
       * The ordering this pins is the whole defect, and it is why the test
       * above passed while the bug was live.
       *
       * A real browser moves focus on POINTERDOWN — so the search box blurs
       * BEFORE the click handler that opens the dialog ever runs. The test
       * above fires `focusOut` after `click`, by which point React has already
       * committed `newTeamOpen: true`, so the guard reads the new value and the
       * bug is invisible. Fired in the real order, `handleRootBlur` runs from a
       * closure that captured `newTeamOpen: false`, sails past its own guard,
       * and its `setTimeout(0)` then clears the query — which is what
       * `initialName` is read from, so the dialog's `<h2>` re-rendered from
       * "New team: Savannah Bananas" to a bare "New team" and its
       * `aria-labelledby` target lost the name.
       *
       * The fix is the synchronous `newTeamOpenRef`, re-read INSIDE the
       * timeout rather than only at blur time. Found in a real browser by the
       * E2E probe, not by this suite.
       */
      currentCandidates = [];
      const { container } = renderPicker({ sportId: SPORT_ID });
      openPopover();
      const search = screen.getByLabelText("Search teams") as HTMLInputElement;
      await waitFor(() => expect(document.activeElement).toBe(search));
      fireEvent.change(search, { target: { value: "Savannah Bananas" } });

      const root = container.querySelector(
        '[aria-label="Team picker"]',
      ) as HTMLElement;
      // Blur FIRST — pointerdown moves focus before click fires.
      fireEvent.focusOut(root);
      fireEvent.click(screen.getByLabelText("New team Savannah Bananas"));
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      // The accessible name of the dialog, which is the thing that broke.
      expect(
        screen.getByRole("dialog").getAttribute("aria-label") ??
          document.getElementById(
            screen.getByRole("dialog").getAttribute("aria-labelledby") ?? "",
          )?.textContent,
      ).toBe("New team: Savannah Bananas");
      expect(
        (screen.getByLabelText("Search teams") as HTMLInputElement).value,
      ).toBe("Savannah Bananas");
    });

    it("survives a pointerdown inside the portalled dialog", () => {
      currentCandidates = [];
      renderPicker({ sportId: SPORT_ID });
      openPopover();
      openNewTeamDialog("Savannah Bananas");

      // The dialog is not inside `rootRef`, so this is an outside press as far
      // as the listener can tell.
      fireEvent.pointerDown(dialogNameField());

      expect(screen.getByRole("dialog")).toBeTruthy();
      expect(screen.getByRole("listbox")).toBeTruthy();
      expect(
        (screen.getByLabelText("Search teams") as HTMLInputElement).value,
      ).toBe("Savannah Bananas");
    });

    it("still closes on an outside press once the dialog is gone", () => {
      // The guard must be scoped to "a dialog is open", not permanent: this is
      // the behaviour `MissingTeamFixer` depends on to uncover the buttons the
      // popover covers.
      currentCandidates = [];
      renderPicker({ sportId: SPORT_ID });
      openPopover();
      openNewTeamDialog("Savannah Bananas");
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

      fireEvent.pointerDown(document.body);

      expect(screen.queryByRole("listbox")).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // NEO-236 — nothing scrolls any more
  //
  // The inline create form pushed its submit past the clip edge of a short
  // `overflow-y-auto` ancestor (`CardAttentionWalker`'s 320px body), and the
  // picker worked around that by calling `scrollIntoView` on the submit. A
  // portalled dialog is not clipped by anything, so the workaround is GONE
  // rather than tuned — and it has to stay gone: scrolling a container out
  // from under an operator who scrolled it themselves is what it cost.
  // -------------------------------------------------------------------------

  describe("no scroll workaround", () => {
    let scrollSpy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      scrollSpy = vi.fn();
      // Assigned rather than spied: happy-dom does not implement
      // scrollIntoView, so there is nothing for `vi.spyOn` to wrap.
      Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
        value: scrollSpy,
        writable: true,
        configurable: true,
      });
    });

    it("never scrolls when the create row appears", () => {
      currentCandidates = [];
      renderPicker({ sportId: SPORT_ID });
      openPopover();

      fireEvent.change(screen.getByLabelText("Search teams"), {
        target: { value: "Padres" },
      });

      expect(createRow()).toBeTruthy();
      expect(scrollSpy).not.toHaveBeenCalled();
    });

    it("never scrolls when the dialog opens over it", () => {
      currentCandidates = [];
      renderPicker({ sportId: SPORT_ID });
      openPopover();

      openNewTeamDialog("Padres");

      expect(screen.getByRole("dialog")).toBeTruthy();
      expect(scrollSpy).not.toHaveBeenCalled();
    });
  });
});

/**
 * NEO-254 — the server finds the team; the client only ranks what it is given.
 *
 * This box used to filter a 500-row `teams.list` window client-side. That is
 * fine at a few dozen teams per sport and wrong at the volumes the preload
 * produces: soccer loads 8,305 teams into ONE sport, so 7,805 were unreachable
 * from here — and an unreachable team made `sameNameTeams` empty, so the create
 * row offered to make a team NB already held. A picker that cannot find a row
 * is a picker that mints duplicates.
 */
describe("TeamPicker — finding past the list window", () => {
  // Its own reset: this block sits outside the main suite's `beforeEach`, and
  // `queryCalls` is what these two assert on — inheriting another test's calls
  // is how the second one first passed for the wrong reason.
  beforeEach(() => {
    vi.clearAllMocks();
    currentSelectedRows = [];
    currentCandidates = [];
    currentLeagues = [];
    queryCalls = [];
  });

  it("asks the server once anything is typed, scoped to the sport", () => {
    renderPicker();
    openPopover();
    fireEvent.change(screen.getByLabelText("Search teams"), {
      target: { value: "yank" },
    });

    const search = queryCalls.filter((c) => c.ref === "teams.search");
    expect(search.length).toBeGreaterThan(0);
    expect(search[search.length - 1].args).toMatchObject({
      query: "yank",
      sportId: SPORT_ID,
    });
  });

  it("does NOT search before anything is typed", () => {
    // A typeahead that queries before you type is noise, and the browse pool
    // already covers the empty state.
    renderPicker();
    openPopover();
    expect(
      queryCalls.filter((c) => c.ref === "teams.search" && c.args !== "skip"),
    ).toHaveLength(0);
  });
});

/**
 * NEO-272 — the popover is portalled, so nothing can clip it.
 *
 * `overflow: auto` establishes a clip box whether or not a scrollbar is
 * showing, and three of this picker's five hosts are exactly that — the
 * attention walker's body (`MissingTeamFixer`, `UnreviewedNameFixer`) and the
 * card drawer's. An `absolute` popover inside one was cut off at its edge;
 * `checklist-attention-walker-missing-team.yaml` carries a documented
 * workaround for it.
 *
 * WHAT THESE TESTS CAN AND CANNOT SAY. happy-dom computes no layout, so
 * "the list is not clipped" is not assertable here and is not asserted. What
 * IS assertable is the structural property that makes clipping impossible —
 * the popover is not a descendant of the scrolling element — plus the
 * coordinates it is given, which are ordinary DOM state.
 */
describe("TeamPicker — the popover escapes its clip box (NEO-272)", () => {
  /** A host that clips: the shape of the walker's `overflow-y-auto` body. */
  function renderInScrollBox(props: Partial<Parameters<typeof TeamPicker>[0]> = {}) {
    const onChange = vi.fn();
    const utils = render(
      <div data-testid="scroll-box" style={{ overflowY: "auto", height: "120px" }}>
        <TeamPicker value={[]} onChange={onChange} sportId={SPORT_ID} {...props} />
      </div>,
    );
    return { ...utils, onChange };
  }

  /** The popover: the listbox's parent, since the search box shares it. */
  const popover = () => screen.getByRole("listbox").parentElement as HTMLElement;

  /** A trigger that claims to be somewhere, so the measured position is readable. */
  function anchorAt(bottom: number, left: number) {
    return vi
      .spyOn(screen.getByLabelText("Add team"), "getBoundingClientRect")
      .mockReturnValue({
        top: bottom - 20,
        bottom,
        left,
        right: left + 96,
        width: 96,
        height: 20,
        x: left,
        y: bottom - 20,
        toJSON: () => ({}),
      } as DOMRect);
  }

  beforeEach(() => {
    currentSelectedRows = [];
    currentCandidates = [makeTeam("t1", "Boston Red Sox")];
  });

  it("renders outside the scrolling ancestor, while the trigger stays inside it", () => {
    renderInScrollBox();
    openPopover();

    const box = screen.getByTestId("scroll-box");
    // The fixture is the right shape: the picker itself really is inside the
    // clip box, so the escape below is the portal and not a broken setup.
    expect(box.contains(screen.getByLabelText("Add team"))).toBe(true);

    expect(box.contains(popover())).toBe(false);
    expect(document.body.contains(popover())).toBe(true);
    // Straight to `document.body`, one nested <Theme> wrapper in between —
    // the same shape every dialog in this directory portals into.
    expect(popover().parentElement?.parentElement).toBe(document.body);
  });

  it("keeps the surface it always had, and sits above the dialogs that host it", () => {
    renderInScrollBox();
    openPopover();

    // A positioning fix, not a restyle: every colour, border and size class is
    // the one this popover has always carried.
    for (const cls of [
      "w-64",
      "bg-white",
      "dark:bg-gray-800",
      "border-gray-300",
      "dark:border-gray-600",
      "rounded-md",
      "shadow-lg",
    ]) {
      expect(popover().className).toContain(cls);
    }
    // z-[55] clears the z-50 dialogs that host this picker and stays under
    // NewTeamDialog's z-[60], which the popover itself opens.
    expect(popover().className).toContain("fixed");
    expect(popover().className).toContain("z-[55]");
    expect(popover().className).not.toContain("absolute");
  });

  it("anchors under the trigger and follows it on ancestor scroll and on resize", () => {
    renderInScrollBox();
    const rect = anchorAt(120, 40);
    openPopover();

    // `top: rect.bottom / left: rect.left` is what `top-full left-0` used to
    // resolve to; the 4px gap is still the element's own `mt-1`.
    expect(popover().style.top).toBe("120px");
    expect(popover().style.left).toBe("40px");

    // The walker's body scrolls under the picker. Scroll events do not bubble,
    // so this only arrives at all because the listener is in the capture phase.
    rect.mockReturnValue({ bottom: 60, left: 40, top: 40 } as DOMRect);
    fireEvent.scroll(screen.getByTestId("scroll-box"));
    expect(popover().style.top).toBe("60px");

    rect.mockReturnValue({ bottom: 300, left: 12, top: 280 } as DOMRect);
    fireEvent.resize(window);
    expect(popover().style.top).toBe("300px");
    expect(popover().style.left).toBe("12px");
  });

  it("re-measures when a new chip reflows the row the trigger sits in", () => {
    // The case neither listener hears: no scroll, no resize, the trigger moved
    // because the picker's own chip row grew.
    const { rerender } = renderInScrollBox();
    const rect = anchorAt(120, 40);
    openPopover();
    expect(popover().style.top).toBe("120px");

    currentSelectedRows = [makeTeam("t1", "Boston Red Sox")];
    rect.mockReturnValue({ bottom: 148, left: 40, top: 128 } as DOMRect);
    rerender(
      <div data-testid="scroll-box" style={{ overflowY: "auto", height: "120px" }}>
        <TeamPicker value={[tid("t1")]} onChange={vi.fn()} sportId={SPORT_ID} />
      </div>,
    );

    expect(popover().style.top).toBe("148px");
  });

  // -------------------------------------------------------------------------
  // Tab, which DOM order no longer carries
  // -------------------------------------------------------------------------

  it("Tab from the trigger moves into the popover", () => {
    // Previously free: the popover was the next element in the DOM. Portalled,
    // it sits at the end of <body>, so the picker hands focus over itself.
    renderInScrollBox();
    openPopover();
    const trigger = screen.getByLabelText("Add team");
    trigger.focus();

    fireEvent.keyDown(trigger, { key: "Tab" });

    expect(document.activeElement).toBe(screen.getByLabelText("Search teams"));
  });

  it("Shift+Tab off the search box returns to the trigger, popover still open", () => {
    renderInScrollBox();
    openPopover();
    const search = screen.getByLabelText("Search teams");
    search.focus();

    fireEvent.keyDown(search, { key: "Tab", shiftKey: true });

    expect(document.activeElement).toBe(screen.getByLabelText("Add team"));
    // The trigger is inside the picker's root, so no dismissal path fires —
    // exactly what walking back out of the popover did before.
    expect(screen.getByRole("listbox")).toBeTruthy();
  });

  it("Tab off the last row closes the popover and hands focus back to the trigger", async () => {
    // WCAG 2.4.11: the popover is drawn over whatever the host put after the
    // picker, so leaving it forwards has to uncover that. Returning focus to
    // the trigger also means Tab can never walk out of a host dialog whose
    // focus trap cannot see into the portal.
    renderInScrollBox();
    openPopover();
    const lastRow = screen.getByLabelText("Add Boston Red Sox");
    lastRow.focus();

    fireEvent.keyDown(lastRow, { key: "Tab" });

    expect(screen.queryByRole("listbox")).toBeNull();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(document.activeElement).toBe(screen.getByLabelText("Add team"));
  });
});
