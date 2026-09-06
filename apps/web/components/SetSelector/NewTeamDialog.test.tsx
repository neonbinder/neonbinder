/**
 * NEO-236 — coverage for `NewTeamDialog`, the modal every picker opens to
 * create a team.
 *
 * Jason, 2026-09-05: "we should also remove the Location box from New Players
 * as we should only be selecting existing teams or entering it in the singular
 * field which would trigger that new team dialog." So `TeamPicker` is back to
 * one box, and the three questions a `teams` row needs are asked here.
 *
 * The fields themselves are `NewTeamForm`'s and have their own file
 * (NewTeamForm.test.tsx). What is pinned HERE is everything the dialog adds:
 *
 *  1. **The Create button's accessible name is `Create team {composed}`.** That
 *     is an E2E contract — it moved off the picker's create row onto this
 *     button when the dialog was introduced, and every `.maestro` selector of
 *     that shape now lands on it. It carries the COMPOSED name so a screen
 *     reader announces exactly the row about to be written.
 *  2. **The keyboard contract.** Escape and the scrim close, Tab is trapped,
 *     focus opens on the NAME field (nothing here is destructive — the safe
 *     thing and the thing the operator came to do are the same thing) and
 *     returns to whatever opened the dialog. Enter inside a field creates.
 *  3. **Escape and the scrim are REFUSED while a create is in flight**, so the
 *     result never lands on an unmounted host.
 *  4. **Escape does not reach the host.** In the card attention walker Escape
 *     means "defer this card"; closing a team form must never also defer the
 *     card the operator is fixing.
 *  5. **The mutation args.** `leagueId: null` travels VERBATIM — null is the
 *     operator's "no league", which the server tells apart from an omitted key
 *     ("not answered", where its own fallbacks still apply). A blank location
 *     is omitted rather than sent empty.
 *  6. **A refusal is shown in the operator's own words** — the ConvexError's
 *     `data`, never `.message`, which production redacts and the client wraps
 *     in request-id noise.
 *
 * --- Mocking strategy ---
 * `convex/react`'s `useQuery`/`useMutation` are module-mocked and routed by the
 * (string-mocked) reference, so `leagues.list` and `teams.findOrCreate` resolve
 * independently. `ConvexError` is NOT mocked: `userFacingMessage` narrows on
 * `instanceof ConvexError`, and that narrowing is what the refusal tests are
 * about.
 */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConvexError } from "convex/values";
import type { Id } from "../../convex/_generated/dataModel";

// ---------------------------------------------------------------------------
// Module mocks — declared before the component import
// ---------------------------------------------------------------------------

vi.mock("../../convex/_generated/api", () => ({
  api: {
    teams: { findOrCreate: "teams.findOrCreate" },
    leagues: { list: "leagues.list" },
  },
}));

let currentLeagues: unknown;
const mockFindOrCreate = vi.fn();

vi.mock("convex/react", () => ({
  useQuery: (ref: string) => (ref === "leagues.list" ? currentLeagues : undefined),
  useMutation: (ref: string) =>
    ref === "teams.findOrCreate"
      ? mockFindOrCreate
      : vi.fn(() => Promise.resolve(undefined)),
}));

// ---------------------------------------------------------------------------
// Component under test — imported after mocks
// ---------------------------------------------------------------------------

import NewTeamDialog from "./NewTeamDialog";

const SPORT_ID = "selopt-sport-1" as unknown as Id<"selectorOptions">;

function lid(id: string): Id<"leagues"> {
  return id as unknown as Id<"leagues">;
}
function tid(id: string): Id<"teams"> {
  return id as unknown as Id<"teams">;
}

type DialogProps = React.ComponentProps<typeof NewTeamDialog>;

/**
 * A host with its own opener button and its own Escape handler.
 *
 * Both are load-bearing: the opener is what focus has to come back to, and the
 * host handler is how "Escape never reaches the thing behind the dialog" is
 * observable — React propagates events through a portal along the REACT tree,
 * so without `stopPropagation` this handler would fire.
 */
function Host({
  open,
  onHostKeyDown,
  ...props
}: { open: boolean; onHostKeyDown?: () => void } & Omit<DialogProps, "sportId">) {
  return (
    <div onKeyDown={() => onHostKeyDown?.()}>
      <button type="button" aria-label="Opener">
        Open
      </button>
      {open && <NewTeamDialog sportId={SPORT_ID} {...props} />}
    </div>
  );
}

function renderDialog(
  props: Partial<Omit<DialogProps, "sportId">> & { onHostKeyDown?: () => void } = {},
) {
  const onCreated = vi.fn();
  const onClose = vi.fn();
  const merged = {
    initialName: "Savannah Bananas",
    onCreated,
    onClose,
    ...props,
  } as Omit<DialogProps, "sportId"> & { onHostKeyDown?: () => void };
  const utils = render(<Host open {...merged} />);
  return { ...utils, onCreated, onClose, props: merged };
}

const nameField = () => screen.getByLabelText("New team name") as HTMLInputElement;
const locationField = () =>
  screen.getByLabelText("New team location (optional)") as HTMLInputElement;
const dialog = () => screen.getByRole("dialog");
const scrim = () => dialog();

beforeEach(() => {
  vi.clearAllMocks();
  currentLeagues = [];
  mockFindOrCreate.mockResolvedValue(tid("team-new-1"));
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

describe("NewTeamDialog — what it shows", () => {
  it("is a modal dialog, portalled out of the host's subtree", () => {
    const { container } = renderDialog();

    const node = dialog();
    expect(node.getAttribute("aria-modal")).toBe("true");
    // Portalled to document.body: the walker and the card drawer both scroll,
    // and an absolutely-positioned child of either is clipped by them.
    expect(container.contains(node)).toBe(false);
    expect(document.body.contains(node)).toBe(true);
  });

  it("titles itself with the name the operator typed", () => {
    renderDialog({ initialName: "Savannah Bananas" });
    expect(screen.getByText("New team: Savannah Bananas")).toBeTruthy();
  });

  it("falls back to a bare title when it was opened with nothing typed", () => {
    renderDialog({ initialName: "   " });
    expect(screen.getByText("New team")).toBeTruthy();
  });

  it("seeds Name with the typed query verbatim, never a guessed split", () => {
    renderDialog({ initialName: "San Diego Padres" });

    expect(nameField().value).toBe("San Diego Padres");
    expect(locationField().value).toBe("");
  });

  it("splits the seed only on a location the host already had, as a whole-word prefix", () => {
    renderDialog({ initialName: "San Diego Padres", espnLocation: "San Diego" });

    expect(locationField().value).toBe("San Diego");
    expect(nameField().value).toBe("Padres");
  });

  it("leaves the seed alone when the host's location is not a prefix of the name", () => {
    renderDialog({ initialName: "Los Angeles Angels", espnLocation: "Anaheim" });

    expect(locationField().value).toBe("");
    expect(nameField().value).toBe("Los Angeles Angels");
  });

  it("passes the league suggestion through to the pills", () => {
    currentLeagues = [];
    renderDialog({ leagueSuggestion: "Australian Baseball League" });

    expect(
      screen.getByRole("radio", { name: "Create Australian Baseball League" }),
    ).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// The Create button's accessible name — an E2E contract
// ---------------------------------------------------------------------------

describe("NewTeamDialog — the Create button's accessible name", () => {
  it("carries the COMPOSED name, and follows the fields as they are edited", () => {
    renderDialog({ initialName: "San Diego Padres" });

    expect(screen.getByRole("button", { name: "Create team San Diego Padres" })).toBeTruthy();

    fireEvent.change(nameField(), { target: { value: "Padres" } });
    fireEvent.change(locationField(), { target: { value: "San Diego" } });

    // Split into two fields, it composes back to the same string — which is
    // what makes the split safe to roll out row by row.
    expect(screen.getByRole("button", { name: "Create team San Diego Padres" })).toBeTruthy();
  });

  it("reads 'Create team' with nothing to compose, rather than a trailing space", () => {
    renderDialog({ initialName: "   " });
    expect(screen.getByRole("button", { name: "Create team" })).toBeTruthy();
  });

  it("says it is working while the create is in flight", async () => {
    mockFindOrCreate.mockImplementation(() => new Promise(() => {}));
    renderDialog({ initialName: "Padres" });

    fireEvent.click(screen.getByRole("button", { name: "Create team Padres" }));

    const button = await screen.findByRole("button", { name: "Creating team Padres" });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.textContent).toBe("Creating…");
  });
});

// ---------------------------------------------------------------------------
// Creating
// ---------------------------------------------------------------------------

describe("NewTeamDialog — creating", () => {
  it("sends the trimmed name and sport, hands the id back, and closes", async () => {
    mockFindOrCreate.mockResolvedValue(tid("team-bananas"));
    const { onCreated, onClose } = renderDialog({ initialName: "Savannah Bananas" });

    fireEvent.click(screen.getByRole("button", { name: "Create team Savannah Bananas" }));

    await waitFor(() => {
      expect(mockFindOrCreate).toHaveBeenCalledWith({
        name: "Savannah Bananas",
        sportId: SPORT_ID,
      });
    });
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(tid("team-bananas")));
    expect(onClose).toHaveBeenCalled();
  });

  it("sends Location and Name as separate arguments", async () => {
    renderDialog({ initialName: "San Diego Padres" });

    fireEvent.change(nameField(), { target: { value: "Padres" } });
    fireEvent.change(locationField(), { target: { value: "  San Diego  " } });
    fireEvent.click(screen.getByRole("button", { name: "Create team San Diego Padres" }));

    await waitFor(() => {
      expect(mockFindOrCreate).toHaveBeenCalledWith({
        name: "Padres",
        location: "San Diego",
        sportId: SPORT_ID,
      });
    });
  });

  it("omits `location` entirely when the box is blank", async () => {
    // "No location" is an absent optional on the server (colleges, national
    // sides, Orix Buffaloes). An empty string would be a third state meaning
    // the same thing.
    renderDialog({ initialName: "Orix Buffaloes" });

    fireEvent.change(locationField(), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Create team Orix Buffaloes" }));

    await waitFor(() => expect(mockFindOrCreate).toHaveBeenCalledTimes(1));
    expect(Object.keys(mockFindOrCreate.mock.calls[0][0])).not.toContain("location");
  });

  it("sends a picked league as leagueId", async () => {
    currentLeagues = [{ _id: lid("l1"), name: "MLB" }];
    renderDialog({ initialName: "Padres" });

    fireEvent.click(screen.getByRole("radio", { name: "MLB" }));
    fireEvent.click(screen.getByRole("button", { name: "Create team Padres" }));

    await waitFor(() => {
      expect(mockFindOrCreate).toHaveBeenCalledWith({
        name: "Padres",
        sportId: SPORT_ID,
        leagueId: lid("l1"),
      });
    });
  });

  it("sends `leagueId: null` VERBATIM for a deliberate 'No league'", async () => {
    // null is the operator saying "no league"; an omitted key is "not
    // answered", which still lets the server's own fallbacks apply. Collapsing
    // the two would file every league-less team under the sport default.
    renderDialog({ initialName: "Orix Buffaloes" });

    fireEvent.click(screen.getByRole("radio", { name: "No league" }));
    fireEvent.click(screen.getByRole("button", { name: "Create team Orix Buffaloes" }));

    await waitFor(() => {
      expect(mockFindOrCreate).toHaveBeenCalledWith({
        name: "Orix Buffaloes",
        sportId: SPORT_ID,
        leagueId: null,
      });
    });
    expect("leagueId" in mockFindOrCreate.mock.calls[0][0]).toBe(true);
  });

  it("omits the league keys entirely while the question is unanswered", async () => {
    renderDialog({ initialName: "Padres" });

    fireEvent.click(screen.getByRole("button", { name: "Create team Padres" }));

    await waitFor(() => expect(mockFindOrCreate).toHaveBeenCalledTimes(1));
    const args = mockFindOrCreate.mock.calls[0][0];
    expect("leagueId" in args).toBe(false);
    expect("leagueName" in args).toBe(false);
  });

  it("sends a league the sport does not hold yet as leagueName", async () => {
    currentLeagues = [{ _id: lid("l1"), name: "MLB" }];
    renderDialog({
      initialName: "Sydney Blue Sox",
      leagueSuggestion: "Australian Baseball League",
    });

    fireEvent.click(
      screen.getByRole("radio", { name: "Create Australian Baseball League" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Create team Sydney Blue Sox" }));

    await waitFor(() => {
      expect(mockFindOrCreate).toHaveBeenCalledWith({
        name: "Sydney Blue Sox",
        sportId: SPORT_ID,
        leagueName: "Australian Baseball League",
      });
    });
  });

  it("never sends both league answers at once", async () => {
    currentLeagues = [{ _id: lid("l1"), name: "MLB" }];
    renderDialog({ initialName: "Padres", leagueSuggestion: "Nippon Professional Baseball" });

    fireEvent.click(
      screen.getByRole("radio", { name: "Create Nippon Professional Baseball" }),
    );
    fireEvent.click(screen.getByRole("radio", { name: "MLB" }));
    fireEvent.click(screen.getByRole("button", { name: "Create team Padres" }));

    await waitFor(() => expect(mockFindOrCreate).toHaveBeenCalledTimes(1));
    const args = mockFindOrCreate.mock.calls[0][0];
    expect(args.leagueId).toBe(lid("l1"));
    expect("leagueName" in args).toBe(false);
  });

  it("creates on Enter inside either field", async () => {
    renderDialog({ initialName: "Padres" });

    fireEvent.keyDown(nameField(), { key: "Enter" });
    await waitFor(() => expect(mockFindOrCreate).toHaveBeenCalledTimes(1));

    fireEvent.keyDown(locationField(), { key: "Enter" });
    await waitFor(() => expect(mockFindOrCreate).toHaveBeenCalledTimes(2));
  });

  it("does not fire a second create while one is in flight", async () => {
    mockFindOrCreate.mockImplementation(() => new Promise(() => {}));
    renderDialog({ initialName: "Padres" });

    fireEvent.click(screen.getByRole("button", { name: "Create team Padres" }));
    await screen.findByRole("button", { name: "Creating team Padres" });
    fireEvent.click(screen.getByRole("button", { name: "Creating team Padres" }));

    expect(mockFindOrCreate).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

describe("NewTeamDialog — refusals", () => {
  it("blocks a blank name and SAYS why, because the button stays clickable", () => {
    // `aria-disabled`, not `disabled`: a keyboard operator must not be ejected
    // from the dialog, which means a press in that state has to say something
    // rather than no-op in silence.
    const { onCreated } = renderDialog({ initialName: "Padres" });

    fireEvent.change(nameField(), { target: { value: "   " } });
    const button = screen.getByRole("button", { name: "Create team" });
    expect(button.getAttribute("aria-disabled")).toBe("true");

    fireEvent.click(button);

    expect(screen.getByRole("alert").textContent).toBe("Enter a team name.");
    expect(mockFindOrCreate).not.toHaveBeenCalled();
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("shows the server's own words for a rejected create, and adds nothing", async () => {
    mockFindOrCreate.mockRejectedValue(
      new ConvexError("A team name is 130 characters; the limit is 120."),
    );
    const { onCreated, onClose } = renderDialog({ initialName: "Padres" });

    fireEvent.click(screen.getByRole("button", { name: "Create team Padres" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("A team name is 130 characters; the limit is 120.");
    expect(onCreated).not.toHaveBeenCalled();
    // The dialog stays up on the values that were refused, so the operator can
    // fix them where they are standing.
    expect(onClose).not.toHaveBeenCalled();
    expect(nameField().value).toBe("Padres");
  });

  it("falls back to a generic sentence for a non-ConvexError failure", async () => {
    // A plain Error is redacted to "Server Error" in production and its
    // `.message` arrives wrapped in request-id noise, so nothing from it shows.
    mockFindOrCreate.mockRejectedValue(new Error("kaboom at teams.ts:141"));
    renderDialog({ initialName: "Padres" });

    fireEvent.click(screen.getByRole("button", { name: "Create team Padres" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Could not create team.");
    expect(alert.textContent).not.toContain("kaboom");
  });

  it("points the fields at the refusal while it stands", async () => {
    mockFindOrCreate.mockRejectedValue(new ConvexError("Nope."));
    renderDialog({ initialName: "Padres" });

    fireEvent.click(screen.getByRole("button", { name: "Create team Padres" }));
    const alert = await screen.findByRole("alert");

    // `aria-describedby` is a LIST: the shared form also points each field at
    // the "Shows as" preview (and Location at the help line), so the refusal
    // joins those rather than replacing them.
    expect(nameField().getAttribute("aria-describedby")).toContain(alert.id);
    expect(locationField().getAttribute("aria-describedby")).toContain(alert.id);
  });

  it("clears the refusal on the next keystroke, since it described what was in the boxes", async () => {
    mockFindOrCreate.mockRejectedValue(new ConvexError("Nope."));
    renderDialog({ initialName: "Padres" });

    fireEvent.click(screen.getByRole("button", { name: "Create team Padres" }));
    await screen.findByRole("alert");

    const alertId = (await screen.findByRole("alert")).id;
    fireEvent.change(nameField(), { target: { value: "Padres II" } });

    expect(screen.queryByRole("alert")).toBeNull();
    // The help and preview ids stay — only the stale refusal goes.
    expect(nameField().getAttribute("aria-describedby")).not.toContain(alertId);
    expect(nameField().getAttribute("aria-describedby")).toBeTruthy();
  });

  it("re-announces the same refusal on a second press", () => {
    renderDialog({ initialName: "Padres" });
    fireEvent.change(nameField(), { target: { value: "" } });

    const button = screen.getByRole("button", { name: "Create team" });
    fireEvent.click(button);
    const first = screen.getByRole("alert");
    fireEvent.click(button);
    const second = screen.getByRole("alert");

    expect(second.textContent).toBe(first.textContent);
  });
});

// ---------------------------------------------------------------------------
// The keyboard and pointer contract
// ---------------------------------------------------------------------------

describe("NewTeamDialog — dismissal", () => {
  it("closes on Escape", () => {
    const { onClose } = renderDialog();

    fireEvent.keyDown(dialog(), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("never lets Escape reach the host behind it", () => {
    // In `CardAttentionWalker` Escape means "defer this card". Closing a team
    // form must not also defer the card the operator is fixing.
    const onHostKeyDown = vi.fn();
    renderDialog({ onHostKeyDown });

    fireEvent.keyDown(dialog(), { key: "Escape" });
    expect(onHostKeyDown).not.toHaveBeenCalled();
  });

  it("closes on a press outside the panel", () => {
    const { onClose } = renderDialog();

    fireEvent.click(scrim());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("stays open on a press inside the panel", () => {
    const { onClose } = renderDialog();

    fireEvent.click(nameField());
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes from the Cancel button", () => {
    const { onClose } = renderDialog();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("refuses Escape, the scrim and Cancel while a create is in flight", async () => {
    // The result must never land on an unmounted host.
    mockFindOrCreate.mockImplementation(() => new Promise(() => {}));
    const { onClose } = renderDialog({ initialName: "Padres" });

    fireEvent.click(screen.getByRole("button", { name: "Create team Padres" }));
    await screen.findByRole("button", { name: "Creating team Padres" });

    fireEvent.keyDown(dialog(), { key: "Escape" });
    fireEvent.click(scrim());
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onClose).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});

describe("NewTeamDialog — focus", () => {
  it("opens focus on the NAME field, not on Cancel", () => {
    // Nothing here is destructive: creating a team is additive, so the safe
    // thing and the thing the operator came to do are the same thing.
    renderDialog();
    expect(document.activeElement).toBe(nameField());
  });

  it("returns focus to whatever opened it", () => {
    const onCreated = vi.fn();
    const onClose = vi.fn();
    const { rerender } = render(
      <Host open={false} initialName="Padres" onCreated={onCreated} onClose={onClose} />,
    );

    const opener = screen.getByLabelText("Opener");
    opener.focus();
    rerender(
      <Host open initialName="Padres" onCreated={onCreated} onClose={onClose} />,
    );
    expect(document.activeElement).toBe(nameField());

    rerender(
      <Host open={false} initialName="Padres" onCreated={onCreated} onClose={onClose} />,
    );
    expect(document.activeElement).toBe(opener);
  });

  it("traps Tab at the end of the dialog", () => {
    currentLeagues = [];
    renderDialog();

    const cancel = screen.getByRole("button", { name: "Cancel" });
    cancel.focus();
    fireEvent.keyDown(cancel, { key: "Tab" });

    expect(document.activeElement).toBe(locationField());
  });

  it("traps Shift+Tab at the start of the dialog", () => {
    currentLeagues = [];
    renderDialog();

    const first = locationField();
    first.focus();
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });

    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
  });

  it("moves focus to Create when the create starts, so the dialog keeps trapping", async () => {
    // Enter-in-a-field is the submit path, and `disabled={creating}` reaches
    // every input and every pill. Without this the browser blurs the focused
    // element to `<body>` — OUTSIDE the portal — and the dialog stops trapping
    // Tab and stops handling Escape for the whole round trip.
    mockFindOrCreate.mockImplementation(() => new Promise(() => {}));
    renderDialog({ initialName: "Padres" });

    nameField().focus();
    fireEvent.keyDown(nameField(), { key: "Enter" });

    const button = await screen.findByRole("button", { name: "Creating team Padres" });
    expect(document.activeElement).toBe(button);
    expect(dialog().contains(document.activeElement)).toBe(true);
  });

  it("still traps Tab while the create is in flight", async () => {
    // Every other control is natively `disabled` at that point, so the Create
    // button is both the first and the last focusable thing — and Tab has to
    // stay on it rather than walking out of the modal.
    mockFindOrCreate.mockImplementation(() => new Promise(() => {}));
    renderDialog({ initialName: "Padres" });

    fireEvent.click(screen.getByRole("button", { name: "Create team Padres" }));
    const button = await screen.findByRole("button", { name: "Creating team Padres" });

    fireEvent.keyDown(button, { key: "Tab" });
    expect(document.activeElement).toBe(button);
    fireEvent.keyDown(button, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(button);
  });

  it("does not count the untabbable League pills as Tab stops", () => {
    // The pills are a roving-tabindex radiogroup: all but one carry
    // `tabindex="-1"`, so counting them would make the trap wrap at the wrong
    // element.
    currentLeagues = [
      { _id: lid("l1"), name: "MLB" },
      { _id: lid("l2"), name: "NPB" },
    ];
    renderDialog();

    const cancel = screen.getByRole("button", { name: "Cancel" });
    cancel.focus();
    fireEvent.keyDown(cancel, { key: "Tab" });
    expect(document.activeElement).toBe(locationField());

    const first = locationField();
    first.focus();
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(cancel);
  });

  it("leaves Tab alone in the middle of the dialog, so the browser's own order runs", () => {
    renderDialog();

    nameField().focus();
    // Not first and not last, so nothing is wrapped and focus is untouched by
    // the handler — the browser moves it.
    const notPrevented = fireEvent.keyDown(nameField(), { key: "Tab" });
    expect(notPrevented).toBe(true);
    expect(document.activeElement).toBe(nameField());
  });
});

// ---------------------------------------------------------------------------
// The whole trip, once, in one test
// ---------------------------------------------------------------------------

describe("NewTeamDialog — end to end", () => {
  it("splits a name, answers the league and hands back the created id", async () => {
    currentLeagues = [{ _id: lid("l1"), name: "MLB" }];
    mockFindOrCreate.mockResolvedValue(tid("team-padres"));
    const { onCreated, onClose } = renderDialog({ initialName: "San Diego Padres" });

    fireEvent.change(nameField(), { target: { value: "Padres" } });
    fireEvent.change(locationField(), { target: { value: "San Diego" } });
    fireEvent.click(screen.getByRole("radio", { name: "MLB" }));

    await act(async () => {
      fireEvent.keyDown(nameField(), { key: "Enter" });
    });

    expect(mockFindOrCreate).toHaveBeenCalledWith({
      name: "Padres",
      location: "San Diego",
      sportId: SPORT_ID,
      leagueId: lid("l1"),
    });
    expect(onCreated).toHaveBeenCalledWith(tid("team-padres"));
    expect(onClose).toHaveBeenCalled();
  });
});
