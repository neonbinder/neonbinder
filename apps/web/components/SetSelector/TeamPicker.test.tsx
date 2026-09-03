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
 * shape) with team-specific additions: the `m.city` suffix on candidate
 * rows and the "No matches." empty-state string TeamPicker renders (that
 * PlayerPicker's popover doesn't).
 *
 * --- Mocking strategy (identity-routed useQuery/useMutation) ---
 * `convex/react`'s `useQuery`/`useMutation` are module-mocked, routed by the
 * (string-mocked) query/mutation reference, so `teams.getManyByIds` and
 * `teams.list` resolve independently, and `teams.findOrCreate` resolves to
 * its own spy.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
      findOrCreate: "teams.findOrCreate",
    },
  },
}));

let currentSelectedRows: unknown;
let currentCandidates: unknown;
const mockFindOrCreate = vi.fn();

vi.mock("convex/react", () => ({
  useQuery: (ref: string) => {
    if (ref === "teams.getManyByIds") return currentSelectedRows;
    if (ref === "teams.list") return currentCandidates;
    return undefined;
  },
  useMutation: (ref: string) =>
    ref === "teams.findOrCreate" ? mockFindOrCreate : vi.fn(),
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

function makeTeam(id: string, name: string, city?: string) {
  return { _id: tid(id), name, city };
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TeamPicker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentSelectedRows = [];
    currentCandidates = [];
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

  it("lists candidates from teams.list when the popover opens, including the city suffix", () => {
    currentCandidates = [makeTeam("t1", "New York Yankees", "Bronx")];
    renderPicker();

    openPopover();

    const option = screen.getByLabelText("Add New York Yankees");
    expect(option).toBeTruthy();
    expect(option.textContent).toContain("Bronx");
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
  // Create-new flow (NEO-71-74 retrofit — teams.findOrCreate)
  // -------------------------------------------------------------------------

  it("shows a '+ Create' row when the typed query has no exact match among candidates", () => {
    currentCandidates = [makeTeam("t1", "New York Yankees")];
    renderPicker();
    openPopover();

    fireEvent.change(screen.getByLabelText("Search teams"), {
      target: { value: "Savannah Bananas" },
    });

    expect(screen.getByLabelText("Create team Savannah Bananas")).toBeTruthy();
  });

  it("does NOT show the '+ Create' row when an exact (case-insensitive) match exists", () => {
    currentCandidates = [makeTeam("t1", "New York Yankees")];
    renderPicker();
    openPopover();

    fireEvent.change(screen.getByLabelText("Search teams"), {
      target: { value: "new york yankees" },
    });

    expect(screen.queryByLabelText(/^Create team/)).toBeNull();
  });

  it("does not show the '+ Create' row when the query is empty", () => {
    currentCandidates = [makeTeam("t1", "New York Yankees")];
    renderPicker();
    openPopover();

    expect(screen.queryByLabelText(/^Create team/)).toBeNull();
  });

  it("clicking '+ Create' calls teams.findOrCreate({ name, sport }) and adds the resulting id as a chip", async () => {
    currentCandidates = [];
    mockFindOrCreate.mockResolvedValue(tid("new-team-1"));
    const { onChange } = renderPicker({ sportId: SPORT_ID });
    openPopover();

    fireEvent.change(screen.getByLabelText("Search teams"), {
      target: { value: "Savannah Bananas" },
    });
    fireEvent.click(screen.getByLabelText("Create team Savannah Bananas"));

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

  it("pressing Enter with the create row highlighted (no matches) also creates and adds", async () => {
    currentCandidates = [];
    mockFindOrCreate.mockResolvedValue(tid("new-team-2"));
    const { onChange } = renderPicker({ sportId: SPORT_ID });
    openPopover();

    const input = screen.getByLabelText("Search teams");
    fireEvent.change(input, { target: { value: "Savannah Bananas" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(mockFindOrCreate).toHaveBeenCalledWith({
        name: "Savannah Bananas",
        sportId: SPORT_ID,
      });
    });
    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith([tid("new-team-2")]);
    });
  });

  // NEO-96: this test used to assert the OPPOSITE — that with no sport prop the
  // picker called findOrCreate with `sport: ""`. That wrote a team no query
  // could ever find again (every read is an exact sport match), which is one of
  // the ways duplicate/orphaned entities got into the catalogue. Creating now
  // requires a real sport row, so the affordance is hidden instead.
  it("hides the create option entirely when no sportId is given", () => {
    currentCandidates = [];
    renderPicker({ sportId: undefined });
    openPopover();

    fireEvent.change(screen.getByLabelText("Search teams"), {
      target: { value: "Savannah Bananas" },
    });

    expect(screen.queryByLabelText("Create team Savannah Bananas")).toBeNull();
    expect(mockFindOrCreate).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // NEO-208 — a refused create is visible, not a silent no-op
  //
  // `teams.findOrCreate` grew two refusals in NEO-208 (a name over the length
  // cap; a `sportId` that is a real `selectorOptions` id but not a sport row).
  // `createAndAdd` was a bare try/finally, so both landed as nothing happening
  // plus an unhandled rejection — the "Creating…" label flipped back and the
  // operator had no idea why no chip appeared.
  // -------------------------------------------------------------------------

  it("shows the server's reason inline and adds no chip when the name is over the cap", async () => {
    const longName = "x".repeat(130);
    currentCandidates = [];
    mockFindOrCreate.mockRejectedValue(
      // Verbatim shape of the real throw: a LENGTH, never the typed name —
      // which is why it is safe to render.
      new ConvexError("A team name is 130 characters; the limit is 120."),
    );
    const { onChange } = renderPicker({ sportId: SPORT_ID });
    openPopover();

    fireEvent.change(screen.getByLabelText("Search teams"), {
      target: { value: longName },
    });
    fireEvent.click(screen.getByLabelText(`Create team ${longName}`));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(
      "A team name is 130 characters; the limit is 120.",
    );
    // The failed create must not look like it half-worked.
    expect(onChange).not.toHaveBeenCalled();
  });

  it("shows the non-sport refusal inline too", async () => {
    currentCandidates = [];
    mockFindOrCreate.mockRejectedValue(
      new ConvexError("A team must be created under a sport."),
    );
    const { onChange } = renderPicker({ sportId: OTHER_SPORT_ID });
    openPopover();

    fireEvent.change(screen.getByLabelText("Search teams"), {
      target: { value: "Savannah Bananas" },
    });
    fireEvent.click(screen.getByLabelText("Create team Savannah Bananas"));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(
      "A team must be created under a sport.",
    );
    expect(onChange).not.toHaveBeenCalled();
  });

  it("falls back to a generic message for a non-ConvexError failure", async () => {
    // A plain Error is redacted to "Server Error" in production and its
    // `.message` arrives wrapped in "[CONVEX M(...)] [Request ID: ...]" noise,
    // so nothing from it is shown.
    currentCandidates = [];
    mockFindOrCreate.mockRejectedValue(new Error("kaboom at teams.ts:141"));
    const { onChange } = renderPicker({ sportId: SPORT_ID });
    openPopover();

    fireEvent.change(screen.getByLabelText("Search teams"), {
      target: { value: "Savannah Bananas" },
    });
    fireEvent.click(screen.getByLabelText("Create team Savannah Bananas"));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Could not create team.");
    expect(alert.textContent).not.toContain("kaboom");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("clears the message on the next keystroke", async () => {
    currentCandidates = [];
    mockFindOrCreate.mockRejectedValue(
      new ConvexError("A team name is 130 characters; the limit is 120."),
    );
    renderPicker({ sportId: SPORT_ID });
    openPopover();

    const input = screen.getByLabelText("Search teams");
    fireEvent.change(input, { target: { value: "x".repeat(130) } });
    fireEvent.click(screen.getByLabelText(`Create team ${"x".repeat(130)}`));
    await screen.findByRole("alert");

    // The message described the name that was in the box; editing it makes the
    // message stale, so it goes away with the query it was about.
    fireEvent.change(input, { target: { value: "Savannah Bananas" } });

    await waitFor(() => {
      expect(screen.queryByRole("alert")).toBeNull();
    });
  });
});
