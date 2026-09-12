/**
 * NEO-71-74 — coverage for `PlayerPicker`, a brand-new component with zero
 * prior test coverage. Mirrors `TeamPicker`'s chip/popover typeahead (see
 * `TeamPicker.test.tsx`, written alongside this file with the same
 * structure), plus the one behavior PlayerPicker adds on top: when the
 * typed query has no exact (case-insensitive) name match among the fetched
 * candidates, a "+ Create '<name>'" row appears; selecting it calls the
 * already-public `players.findOrCreate` mutation and adds the resulting id
 * as a chip. This is what lets a custom (non-marketplace-synced) card
 * attach players at all.
 *
 * --- Mocking strategy (identity-routed useQuery/useMutation, per
 * CardFeaturesEditor.test.tsx / BaseMappingForm.test.tsx conventions) ---
 * `convex/react`'s `useQuery`/`useMutation` are module-mocked, routed by the
 * (string-mocked) query/mutation reference, so `players.getManyByIds` and
 * `players.list` resolve independently, and `players.findOrCreate` resolves
 * to its own spy.
 */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// NEO-254: the ambiguity refusal is a ConvexError, and only a ConvexError's
// message survives production redaction — see `userFacingMessage`.
import { ConvexError } from "convex/values";

// ---------------------------------------------------------------------------
// Module mocks — declared before the component import
// ---------------------------------------------------------------------------

vi.mock("../../convex/_generated/api", () => ({
  api: {
    players: {
      getManyByIds: "players.getManyByIds",
      list: "players.list",
      findOrCreate: "players.findOrCreate",
    },
  },
}));

let currentSelectedRows: unknown;
let currentCandidates: unknown;
const mockFindOrCreate = vi.fn();

vi.mock("convex/react", () => ({
  useQuery: (ref: string) => {
    if (ref === "players.getManyByIds") return currentSelectedRows;
    if (ref === "players.list") return currentCandidates;
    return undefined;
  },
  useMutation: (ref: string) =>
    ref === "players.findOrCreate" ? mockFindOrCreate : vi.fn(),
}));

// ---------------------------------------------------------------------------
// Component under test — imported after mocks
// ---------------------------------------------------------------------------

import PlayerPicker from "./PlayerPicker";
import type { Id } from "../../convex/_generated/dataModel";

// NEO-96: pickers take the sport-level selectorOptions ROW ID now, not a
// display string. These stand in for a seeded sport row.
const SPORT_ID = "selopt-sport-1" as unknown as Id<"selectorOptions">;
const OTHER_SPORT_ID = "selopt-sport-2" as unknown as Id<"selectorOptions">;

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

function pid(n: string): Id<"players"> {
  return n as unknown as Id<"players">;
}

function makePlayer(id: string, name: string) {
  return { _id: pid(id), name };
}

function renderPicker(
  props: Partial<Parameters<typeof PlayerPicker>[0]> = {},
) {
  const onChange = vi.fn();
  const utils = render(
    <PlayerPicker value={[]} onChange={onChange} sportId={SPORT_ID} {...props} />,
  );
  return { ...utils, onChange };
}

function openPopover() {
  fireEvent.click(screen.getByLabelText("Add player"));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PlayerPicker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentSelectedRows = [];
    currentCandidates = [];
    mockFindOrCreate.mockResolvedValue(pid("new-player-1"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Chip rendering (players.getManyByIds)
  // -------------------------------------------------------------------------

  it("renders a chip per selected id, labeled from players.getManyByIds", () => {
    currentSelectedRows = [makePlayer("p1", "Mike Trout")];
    renderPicker({ value: [pid("p1")] });

    expect(screen.getByLabelText("Player: Mike Trout")).toBeTruthy();
    expect(screen.getByLabelText("Remove player Mike Trout")).toBeTruthy();
  });

  it("shows a 'Loading…' placeholder label for a chip not yet resolved by getManyByIds", () => {
    currentSelectedRows = undefined;
    renderPicker({ value: [pid("p1")] });

    expect(screen.getByLabelText("Player: Loading…")).toBeTruthy();
  });

  it("clicking a chip's × button removes it via onChange", () => {
    currentSelectedRows = [makePlayer("p1", "Mike Trout"), makePlayer("p2", "Aaron Judge")];
    const { onChange } = renderPicker({ value: [pid("p1"), pid("p2")] });

    fireEvent.click(screen.getByLabelText("Remove player Mike Trout"));

    expect(onChange).toHaveBeenCalledWith([pid("p2")]);
  });

  // -------------------------------------------------------------------------
  // Candidate list (players.list), filtered/ranked by typed query
  // -------------------------------------------------------------------------

  it("lists candidates from players.list when the popover opens", () => {
    currentCandidates = [makePlayer("p1", "Mike Trout"), makePlayer("p2", "Aaron Judge")];
    renderPicker();

    openPopover();

    expect(screen.getByLabelText("Add Mike Trout")).toBeTruthy();
    expect(screen.getByLabelText("Add Aaron Judge")).toBeTruthy();
  });

  it("excludes already-selected ids from the candidate list", () => {
    currentSelectedRows = [makePlayer("p1", "Mike Trout")];
    currentCandidates = [makePlayer("p1", "Mike Trout"), makePlayer("p2", "Aaron Judge")];
    renderPicker({ value: [pid("p1")] });

    openPopover();

    expect(screen.queryByLabelText("Add Mike Trout")).toBeNull();
    expect(screen.getByLabelText("Add Aaron Judge")).toBeTruthy();
  });

  it("ranks prefix matches above substring matches when a query is typed", () => {
    currentCandidates = [
      makePlayer("p1", "Brand Newington"), // "new" is a substring, not a prefix
      makePlayer("p2", "Newt Adamson"), // prefix match
      makePlayer("p3", "New York Slugger"), // prefix match, alphabetically first
    ];
    renderPicker();

    openPopover();
    fireEvent.change(screen.getByLabelText("Search players"), {
      target: { value: "New" },
    });

    // Filter out the trailing "+ Create" row (also role="option") — a
    // non-exact-match query always shows it alongside real matches.
    const options = screen
      .getAllByRole("option")
      .filter((el) => el.getAttribute("aria-label")?.startsWith("Add "))
      .map((el) => el.textContent);
    expect(options).toEqual(["New York Slugger", "Newt Adamson", "Brand Newington"]);
  });

  it("filters out non-matching candidates once a query is typed", () => {
    currentCandidates = [makePlayer("p1", "Mike Trout"), makePlayer("p2", "Aaron Judge")];
    renderPicker();

    openPopover();
    fireEvent.change(screen.getByLabelText("Search players"), {
      target: { value: "Trout" },
    });

    expect(screen.getByLabelText("Add Mike Trout")).toBeTruthy();
    expect(screen.queryByLabelText("Add Aaron Judge")).toBeNull();
  });

  it("clicking a candidate adds its id via onChange and clears the query", () => {
    currentCandidates = [makePlayer("p1", "Mike Trout")];
    const { onChange } = renderPicker({ value: [] });

    openPopover();
    fireEvent.click(screen.getByLabelText("Add Mike Trout"));

    expect(onChange).toHaveBeenCalledWith([pid("p1")]);
  });

  // -------------------------------------------------------------------------
  // Keyboard contract (docstring: Enter/arrows/Escape/Backspace)
  // -------------------------------------------------------------------------

  it("ArrowDown/ArrowUp move the highlighted option", () => {
    currentCandidates = [makePlayer("p1", "Aaron Judge"), makePlayer("p2", "Mike Trout")];
    renderPicker();
    openPopover();

    const input = screen.getByLabelText("Search players");
    // Default highlight is index 0.
    expect(screen.getByLabelText("Add Aaron Judge").getAttribute("aria-selected")).toBe(
      "true",
    );

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(screen.getByLabelText("Add Mike Trout").getAttribute("aria-selected")).toBe(
      "true",
    );

    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(screen.getByLabelText("Add Aaron Judge").getAttribute("aria-selected")).toBe(
      "true",
    );
  });

  it("Enter selects the highlighted match", () => {
    currentCandidates = [makePlayer("p1", "Aaron Judge"), makePlayer("p2", "Mike Trout")];
    const { onChange } = renderPicker();
    openPopover();

    const input = screen.getByLabelText("Search players");
    fireEvent.keyDown(input, { key: "ArrowDown" }); // highlight Mike Trout
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onChange).toHaveBeenCalledWith([pid("p2")]);
  });

  it("Escape closes the popover without selecting anything", () => {
    currentCandidates = [makePlayer("p1", "Aaron Judge")];
    const { onChange } = renderPicker();
    openPopover();

    fireEvent.keyDown(screen.getByLabelText("Search players"), { key: "Escape" });

    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("Backspace on an empty query removes the last chip", () => {
    currentSelectedRows = [makePlayer("p1", "Aaron Judge"), makePlayer("p2", "Mike Trout")];
    const { onChange } = renderPicker({ value: [pid("p1"), pid("p2")] });
    openPopover();

    fireEvent.keyDown(screen.getByLabelText("Search players"), { key: "Backspace" });

    expect(onChange).toHaveBeenCalledWith([pid("p1")]);
  });

  it("Backspace does nothing when the query is non-empty (caret editing, not chip removal)", () => {
    currentSelectedRows = [makePlayer("p1", "Aaron Judge")];
    const { onChange } = renderPicker({ value: [pid("p1")] });
    openPopover();

    fireEvent.change(screen.getByLabelText("Search players"), {
      target: { value: "M" },
    });
    fireEvent.keyDown(screen.getByLabelText("Search players"), { key: "Backspace" });

    expect(onChange).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Create-new flow (PlayerPicker's one addition beyond TeamPicker's baseline)
  // -------------------------------------------------------------------------

  it("shows a '+ Create' row when the typed query has no exact match among candidates", () => {
    currentCandidates = [makePlayer("p1", "Mike Trout")];
    renderPicker();
    openPopover();

    fireEvent.change(screen.getByLabelText("Search players"), {
      target: { value: "Bobby Witt Jr" },
    });

    expect(screen.getByLabelText('Create player Bobby Witt Jr')).toBeTruthy();
  });

  it("does NOT show the '+ Create' row when an exact (case-insensitive) match exists", () => {
    currentCandidates = [makePlayer("p1", "Mike Trout")];
    renderPicker();
    openPopover();

    fireEvent.change(screen.getByLabelText("Search players"), {
      target: { value: "mike trout" },
    });

    expect(screen.queryByLabelText(/^Create player/)).toBeNull();
  });

  it("does not show the '+ Create' row when the query is empty", () => {
    currentCandidates = [makePlayer("p1", "Mike Trout")];
    renderPicker();
    openPopover();

    expect(screen.queryByLabelText(/^Create player/)).toBeNull();
  });

  it("clicking '+ Create' calls players.findOrCreate({ name, sport }) and adds the resulting id as a chip", async () => {
    currentCandidates = [];
    mockFindOrCreate.mockResolvedValue(pid("new-player-1"));
    const { onChange } = renderPicker({ sportId: SPORT_ID });
    openPopover();

    fireEvent.change(screen.getByLabelText("Search players"), {
      target: { value: "Bobby Witt Jr" },
    });
    fireEvent.click(screen.getByLabelText('Create player Bobby Witt Jr'));

    await waitFor(() => {
      expect(mockFindOrCreate).toHaveBeenCalledWith({
        name: "Bobby Witt Jr",
        sportId: SPORT_ID,
      });
    });
    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith([pid("new-player-1")]);
    });
  });

  it("pressing Enter with the create row highlighted (no matches) also creates and adds", async () => {
    currentCandidates = [];
    mockFindOrCreate.mockResolvedValue(pid("new-player-2"));
    const { onChange } = renderPicker({ sportId: SPORT_ID });
    openPopover();

    const input = screen.getByLabelText("Search players");
    fireEvent.change(input, { target: { value: "Bobby Witt Jr" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(mockFindOrCreate).toHaveBeenCalledWith({
        name: "Bobby Witt Jr",
        sportId: SPORT_ID,
      });
    });
    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith([pid("new-player-2")]);
    });
  });

  // NEO-96: see the matching TeamPicker test — this used to assert that a
  // missing sport prop produced `sport: ""` on the created player.
  it("hides the create option entirely when no sportId is given", () => {
    currentCandidates = [];
    renderPicker({ sportId: undefined });
    openPopover();

    fireEvent.change(screen.getByLabelText("Search players"), {
      target: { value: "Bobby Witt Jr" },
    });

    expect(screen.queryByLabelText("Create player Bobby Witt Jr")).toBeNull();
    expect(mockFindOrCreate).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // NEO-220 — dismissal and create-failure feedback, ported from TeamPicker
  //
  // This picker moved into `CardChecklist`'s quick-add form, where its
  // `absolute top-full z-10` popover is drawn over the Team row and the
  // Add/Cancel buttons. Its three prior gaps all became real defects there:
  // no outside-click close, no keyboard-out close (WCAG 2.4.11 Focus Not
  // Obscured), and a refused create that vanished silently.
  // -------------------------------------------------------------------------

  it("closes the popover on a pointerdown outside the picker", () => {
    currentCandidates = [makePlayer("p1", "Aaron Judge")];
    renderPicker();
    openPopover();
    expect(screen.getByLabelText("Search players")).toBeTruthy();

    fireEvent.pointerDown(document.body);

    expect(screen.queryByLabelText("Search players")).toBeNull();
  });

  it("leaves the popover open for a pointerdown INSIDE the picker", () => {
    currentCandidates = [makePlayer("p1", "Aaron Judge")];
    renderPicker();
    openPopover();

    fireEvent.pointerDown(screen.getByLabelText("Search players"));

    expect(screen.getByLabelText("Search players")).toBeTruthy();
  });

  it("closes the popover once focus actually leaves the picker (2.4.11)", async () => {
    // The keyboard counterpart to the pointerdown handler: Tab out of the
    // popover, which has no focus trap, lands on whatever the caller rendered
    // next — in the quick-add form, controls this popover covers.
    currentCandidates = [makePlayer("p1", "Aaron Judge")];
    render(
      <div>
        <PlayerPicker value={[]} onChange={vi.fn()} sportId={SPORT_ID} />
        <button aria-label="Outside">Outside</button>
      </div>,
    );
    openPopover();
    const search = screen.getByLabelText("Search players");
    await waitFor(() => expect(document.activeElement).toBe(search));

    fireEvent.blur(search);
    screen.getByLabelText("Outside").focus();
    await waitFor(() =>
      expect(screen.queryByLabelText("Search players")).toBeNull(),
    );
  });

  it("stays open when focus moves between controls inside the picker", async () => {
    currentCandidates = [makePlayer("p1", "Aaron Judge")];
    renderPicker();
    openPopover();
    const search = screen.getByLabelText("Search players");
    await waitFor(() => expect(document.activeElement).toBe(search));

    fireEvent.blur(search);
    screen.getByLabelText("Add Aaron Judge").focus();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(screen.getByLabelText("Search players")).toBeTruthy();
  });

  it("renders the reason a create was refused, in the SAME open popover", async () => {
    mockFindOrCreate.mockRejectedValue(new Error("boom"));
    currentCandidates = [];
    renderPicker();
    openPopover();
    fireEvent.change(screen.getByLabelText("Search players"), {
      target: { value: "Bobby Witt Jr" },
    });

    fireEvent.click(screen.getByLabelText("Create player Bobby Witt Jr"));
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());

    // A plain Error is redacted in production, so only the generic fallback is
    // ever shown for one — never the raw message.
    expect(screen.getByRole("alert").textContent).toBe(
      "Could not create player.",
    );
    // Still the same open popover, query preserved, so the operator can edit
    // and retry rather than reopening and retyping.
    expect(
      (screen.getByLabelText("Search players") as HTMLInputElement).value,
    ).toBe("Bobby Witt Jr");
  });

  it("shows NEO-254's ambiguity refusal verbatim", async () => {
    /*
     * `findOrCreate` now refuses rather than returning the first of several
     * same-name rows, and after the bulk preload that refusal is a thing a
     * picker really hits — two Bob Allens pitched in the majors. The message
     * IS the instruction ("pick the right one"), so it has to survive: this
     * path is the only place the operator finds out, and the generic fallback
     * would tell them nothing they can act on.
     *
     * Safe to render verbatim by the rule this component already documents:
     * the message names a COUNT and the name the operator just typed, never
     * anything about the other rows.
     */
    mockFindOrCreate.mockRejectedValue(
      new ConvexError(
        "2 players are already filed under Bob Allen. Pick the right one instead of adding another.",
      ),
    );
    currentCandidates = [];
    const { onChange } = renderPicker();
    openPopover();
    fireEvent.change(screen.getByLabelText("Search players"), {
      target: { value: "Bob Allen" },
    });

    fireEvent.click(screen.getByLabelText("Create player Bob Allen"));
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());

    expect(screen.getByRole("alert").textContent).toBe(
      "2 players are already filed under Bob Allen. Pick the right one instead of adding another.",
    );
    // No chip was added — the refusal is a refusal, not a silent no-op that
    // leaves the operator thinking it worked.
    expect(onChange).not.toHaveBeenCalled();
  });

  it("clears the refusal on the next keystroke", async () => {
    mockFindOrCreate.mockRejectedValue(new Error("boom"));
    currentCandidates = [];
    renderPicker();
    openPopover();
    const search = screen.getByLabelText("Search players");
    fireEvent.change(search, { target: { value: "Bobby Witt Jr" } });
    fireEvent.click(screen.getByLabelText("Create player Bobby Witt Jr"));
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());

    // The message described the name that was in the box; the next keystroke
    // makes it stale, so it goes with the query it was about.
    fireEvent.change(search, { target: { value: "Bobby Witt Jr." } });

    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps the Create row MOUNTED while creating, so the refusal survives", async () => {
    // The regression this guards: gating `showCreateOption` on `!creating`
    // unmounted the focused button the instant the request started, parking
    // focus on <body> — which `handleRootBlur` reads as "focus left the
    // picker" and closes the popover on, clearing the error state before the
    // awaited mutation had even rejected. The refusal then landed invisibly.
    let settle: (id: Id<"players">) => void = () => {};
    mockFindOrCreate.mockImplementation(
      () => new Promise<Id<"players">>((resolve) => { settle = resolve; }),
    );
    currentCandidates = [];
    renderPicker();
    openPopover();
    fireEvent.change(screen.getByLabelText("Search players"), {
      target: { value: "Bobby Witt Jr" },
    });
    fireEvent.click(screen.getByLabelText("Create player Bobby Witt Jr"));

    // Mid-flight: the row is still there, announcing itself rather than
    // vanishing — `aria-disabled`, never native `disabled`, which would
    // force-blur it and reproduce the same focus park.
    const createRow = screen.getByLabelText("Create player Bobby Witt Jr");
    expect(createRow.textContent).toBe("Creating…");
    expect(createRow.getAttribute("aria-disabled")).toBe("true");
    expect(createRow.hasAttribute("disabled")).toBe(false);
    expect(screen.getByLabelText("Search players")).toBeTruthy();

    await act(async () => {
      settle(pid("p-new"));
    });
  });

  it("refuses a second create while one is in flight", async () => {
    let settle: (id: Id<"players">) => void = () => {};
    mockFindOrCreate.mockImplementation(
      () => new Promise<Id<"players">>((resolve) => { settle = resolve; }),
    );
    currentCandidates = [];
    renderPicker();
    openPopover();
    fireEvent.change(screen.getByLabelText("Search players"), {
      target: { value: "Bobby Witt Jr" },
    });

    fireEvent.click(screen.getByLabelText("Create player Bobby Witt Jr"));
    fireEvent.click(screen.getByLabelText("Create player Bobby Witt Jr"));

    // The `creating` guard inside `createAndAdd` is what blocks re-entry now
    // that the button stays clickable — `aria-disabled` only announces.
    expect(mockFindOrCreate).toHaveBeenCalledTimes(1);

    await act(async () => {
      settle(pid("p-new"));
    });
  });
});

/**
 * NEO-272 — the popover is portalled, so nothing can clip it.
 *
 * `overflow: auto` establishes a clip box whether or not a scrollbar is
 * showing, and two of this picker's hosts are exactly that: the attention
 * walker's body (`UnreviewedNameFixer`) and the card drawer's. An `absolute`
 * popover inside one was cut off at its edge.
 *
 * These tests say what happy-dom can say. It computes no layout, so "not
 * clipped" is not assertable and is not asserted — the structural property
 * that makes clipping impossible is, along with the coordinates the popover is
 * given, which are ordinary DOM state. `TeamPicker.test.tsx` carries the same
 * block for its twin.
 */
describe("PlayerPicker — the popover escapes its clip box (NEO-272)", () => {
  /** A host that clips: the shape of the walker's `overflow-y-auto` body. */
  function renderInScrollBox(
    props: Partial<Parameters<typeof PlayerPicker>[0]> = {},
  ) {
    const onChange = vi.fn();
    const utils = render(
      <div data-testid="scroll-box" style={{ overflowY: "auto", height: "120px" }}>
        <PlayerPicker value={[]} onChange={onChange} sportId={SPORT_ID} {...props} />
      </div>,
    );
    return { ...utils, onChange };
  }

  /** This picker's popover IS its listbox — the role sits on the container. */
  const popover = () => screen.getByRole("listbox");

  function anchorAt(bottom: number, left: number) {
    return vi
      .spyOn(screen.getByLabelText("Add player"), "getBoundingClientRect")
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
    currentCandidates = [makePlayer("p1", "Aaron Judge")];
  });

  it("renders outside the scrolling ancestor, while the trigger stays inside it", () => {
    renderInScrollBox();
    openPopover();

    const box = screen.getByTestId("scroll-box");
    // The fixture really does clip, so the escape below is the portal rather
    // than a broken setup.
    expect(box.contains(screen.getByLabelText("Add player"))).toBe(true);

    expect(box.contains(popover())).toBe(false);
    expect(document.body.contains(popover())).toBe(true);
    expect(popover().parentElement?.parentElement).toBe(document.body);
  });

  it("keeps its listbox role and accessible name on the popover itself", () => {
    // The portal moved the element, not its semantics: the container is still
    // the listbox, still named by `labels.results`, which is what both a
    // screen reader and a Maestro `id:` selector read it by.
    renderInScrollBox({
      labels: {
        root: "Player picker",
        trigger: "Add player",
        search: "Search players",
        results: "Player typeahead results",
      },
    });
    openPopover();

    expect(popover().getAttribute("aria-label")).toBe("Player typeahead results");
    expect(popover().className).toContain("w-64");
    expect(popover().className).toContain("dark:bg-gray-800");
    expect(popover().className).toContain("z-[55]");
    expect(popover().className).not.toContain("absolute");
  });

  it("anchors under the trigger and follows it on ancestor scroll and on resize", () => {
    renderInScrollBox();
    const rect = anchorAt(120, 40);
    openPopover();

    expect(popover().style.top).toBe("120px");
    expect(popover().style.left).toBe("40px");

    // Scroll events do not bubble; this only arrives because the listener is
    // registered in the capture phase.
    rect.mockReturnValue({ bottom: 60, left: 40, top: 40 } as DOMRect);
    fireEvent.scroll(screen.getByTestId("scroll-box"));
    expect(popover().style.top).toBe("60px");

    rect.mockReturnValue({ bottom: 300, left: 12, top: 280 } as DOMRect);
    fireEvent.resize(window);
    expect(popover().style.top).toBe("300px");
    expect(popover().style.left).toBe("12px");
  });

  it("Tab from the trigger moves into the popover", () => {
    renderInScrollBox();
    openPopover();
    const trigger = screen.getByLabelText("Add player");
    trigger.focus();

    fireEvent.keyDown(trigger, { key: "Tab" });

    expect(document.activeElement).toBe(screen.getByLabelText("Search players"));
  });

  it("Shift+Tab off the search box returns to the trigger, popover still open", () => {
    renderInScrollBox();
    openPopover();
    const search = screen.getByLabelText("Search players");
    search.focus();

    fireEvent.keyDown(search, { key: "Tab", shiftKey: true });

    expect(document.activeElement).toBe(screen.getByLabelText("Add player"));
    expect(screen.getByRole("listbox")).toBeTruthy();
  });

  it("Tab off the last row closes the popover and hands focus back to the trigger", async () => {
    // WCAG 2.4.11 — in the quick-add form this popover covers the Team row and
    // Add/Cancel. Returning focus to the trigger also keeps Tab inside a host
    // dialog whose focus trap cannot see into the portal.
    renderInScrollBox();
    openPopover();
    const lastRow = screen.getByLabelText("Add Aaron Judge");
    lastRow.focus();

    fireEvent.keyDown(lastRow, { key: "Tab" });

    expect(screen.queryByRole("listbox")).toBeNull();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(document.activeElement).toBe(screen.getByLabelText("Add player"));
  });
});
