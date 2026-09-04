/**
 * NEO-240 (review follow-up) — the add-league form as a SHARED component.
 *
 * `LeagueManagement.test.tsx` already drives this form end to end through the
 * screen that has always rendered it: near matches, the demoted primary,
 * "Create anyway", the busy naming, Cancel. None of that is repeated here — a
 * second copy of those assertions would only ever fail in pairs.
 *
 * What IS here is everything the extraction added, which is the whole of what
 * the second surface depends on:
 *
 *  1. **`lockSport`.** Team Management fixes the sport to the team's own. A
 *     league is keyed on (name, sport), so a form that let the sport be changed
 *     there could create a league the team it was opened from cannot point at.
 *  2. **`initialFocus`.** Replacing a column and opening a modal want different
 *     first stops, and getting this wrong is silent: the form renders perfectly
 *     and the operator's cursor is nowhere.
 *  3. **The `onCreated` payload.** The modal reports "Added X." and puts X in a
 *     dropdown that does not have a row for it yet, so it needs the name and
 *     the honest `created` flag — not just an id.
 *  4. **`onBusyChange`.** The only way a host that can be dismissed from
 *     outside the form knows not to.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../convex/_generated/api", () => ({
  api: {
    leagues: {
      createByAdmin: "leagues.createByAdmin",
      nearMatches: "leagues.nearMatches",
    },
  },
}));

const mockCreateByAdmin = vi.fn();
let nearMatches: unknown;

vi.mock("convex/react", () => ({
  useQuery: (ref: string, args: unknown) => {
    if (args === "skip") return undefined;
    if (ref === "leagues.nearMatches") return nearMatches;
    return undefined;
  },
  useMutation: (ref: string) =>
    ref === "leagues.createByAdmin" ? mockCreateByAdmin : vi.fn(),
  useAction: () => vi.fn(),
}));

import { AddLeagueForm, type CreatedLeague } from "./AddLeagueForm";

const SPORTS = [
  { _id: "sport-baseball", _creationTime: 1, level: "sport", value: "Baseball" },
  { _id: "sport-hockey", _creationTime: 1, level: "sport", value: "Hockey" },
];

type Overrides = Partial<React.ComponentProps<typeof AddLeagueForm>>;

const onCreated = vi.fn<(league: CreatedLeague) => void>();
const onStatus = vi.fn();
const onCancel = vi.fn();
const onBusyChange = vi.fn();

function renderForm(overrides: Overrides = {}) {
  return render(
    <AddLeagueForm
      sports={SPORTS as never}
      sportId={"sport-baseball" as never}
      onStatus={onStatus}
      onCreated={onCreated}
      onCancel={onCancel}
      {...overrides}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  nearMatches = undefined;
  mockCreateByAdmin.mockResolvedValue({ id: "lg-npb", created: true });
});

describe("AddLeagueForm — a sport the surface has already decided", () => {
  it("shows the sport as read-only text with no way to change it", () => {
    renderForm({ lockSport: true, sportLabel: "Baseball" });

    expect(screen.getByText("Sport: Baseball")).toBeTruthy();
    // Not merely hidden — absent. A select that exists but is unreachable is
    // still in the tab order and still announced.
    expect(document.getElementById("new-league-sport")).toBeNull();
  });

  it("is NOT disabled, because the sport is a fact rather than a refusal", () => {
    // `disabled` would dim the text below SC 1.4.3's 4.5:1 floor, and the
    // operator would have no way to read which sport they are creating under —
    // which is the single thing this element exists to tell them.
    renderForm({ lockSport: true, sportLabel: "Baseball" });

    const sport = screen.getByText("Sport: Baseball");
    expect(sport.tagName).toBe("P");
    expect(sport.hasAttribute("disabled")).toBe(false);
  });

  it("creates under that sport without the operator picking one", async () => {
    renderForm({ lockSport: true, sportLabel: "Baseball" });

    fireEvent.change(screen.getByLabelText("New league name"), {
      target: { value: "Nippon Professional Baseball" },
    });
    fireEvent.click(
      screen.getByLabelText("Create league Nippon Professional Baseball"),
    );

    await waitFor(() =>
      expect(mockCreateByAdmin).toHaveBeenCalledWith({
        name: "Nippon Professional Baseball",
        sportId: "sport-baseball",
      }),
    );
  });

  it("still offers the sport picker when the surface has not decided", () => {
    renderForm();
    expect(document.getElementById("new-league-sport")).toBeTruthy();
    expect(screen.queryByText(/^Sport: /)).toBeNull();
  });
});

describe("AddLeagueForm — where focus opens", () => {
  it("takes the heading by default, for the column-replacing surface", () => {
    renderForm();
    expect(document.activeElement).toBe(
      screen.getByRole("heading", { level: 3, name: "Add a league" }),
    );
  });

  it("takes the first field when the host names the form itself", () => {
    // In a dialog the heading is already the accessible name of the dialog, so
    // landing on it says the same words twice and costs a Tab before typing.
    renderForm({ initialFocus: "name" });
    expect(document.activeElement).toBe(screen.getByLabelText("New league name"));
  });

  it("puts the caller's id on the heading so a dialog can point at it", () => {
    renderForm({ headingId: "add-league-title" });
    expect(
      screen.getByRole("heading", { level: 3, name: "Add a league" }).id,
    ).toBe("add-league-title");
  });
});

describe("AddLeagueForm — what it reports back", () => {
  it("reports the id, the name and that it really was created", async () => {
    renderForm({ lockSport: true, sportLabel: "Baseball" });
    fireEvent.change(screen.getByLabelText("New league name"), {
      target: { value: "  Nippon Professional Baseball  " },
    });
    fireEvent.click(
      screen.getByLabelText("Create league Nippon Professional Baseball"),
    );

    await waitFor(() =>
      expect(onCreated).toHaveBeenCalledWith({
        id: "lg-npb",
        created: true,
        // Trimmed, and the same string that was sent to the mutation — a host
        // printing "Added   NPB  ." would be quoting something nothing stored.
        name: "Nippon Professional Baseball",
      }),
    );
  });

  it("says created:false when the league was already there", async () => {
    // `createByAdmin` answers `false` on a name OR alias hit. A host that
    // claimed a creation either way would be lying about what it did.
    mockCreateByAdmin.mockResolvedValue({ id: "lg-npb", created: false });
    renderForm({ lockSport: true, sportLabel: "Baseball" });
    fireEvent.change(screen.getByLabelText("New league name"), {
      target: { value: "Nippon Professional Baseball" },
    });
    fireEvent.click(
      screen.getByLabelText("Create league Nippon Professional Baseball"),
    );

    await waitFor(() =>
      expect(onCreated).toHaveBeenCalledWith(
        expect.objectContaining({ created: false }),
      ),
    );
  });

  it("reports a near-match pick as the row it already is", async () => {
    nearMatches = [
      { _id: "lg-npb", name: "Nippon Professional Baseball", confidence: "close" },
    ];
    renderForm({ lockSport: true, sportLabel: "Baseball" });
    fireEvent.change(screen.getByLabelText("New league name"), {
      target: { value: "Nippon Pro Baseball" },
    });

    fireEvent.click(
      await screen.findByLabelText("Open Nippon Professional Baseball"),
    );

    // The CANONICAL name, not what was typed: the host is about to print this
    // in a dropdown, and it must read as the row that exists.
    expect(onCreated).toHaveBeenCalledWith({
      id: "lg-npb",
      created: false,
      name: "Nippon Professional Baseball",
    });
    expect(mockCreateByAdmin).not.toHaveBeenCalled();
  });

  it("opens on the level the host asked for, and sends it", async () => {
    renderForm({ lockSport: true, sportLabel: "Baseball", defaultLevel: "minor" });

    const group = screen.getByRole("group", { name: "Level" });
    expect(
      group.querySelector('[aria-pressed="true"]')?.textContent,
    ).toBe("Minor");

    fireEvent.change(screen.getByLabelText("New league name"), {
      target: { value: "International League" },
    });
    fireEvent.click(screen.getByLabelText("Create league International League"));

    await waitFor(() =>
      expect(mockCreateByAdmin).toHaveBeenCalledWith({
        name: "International League",
        level: "minor",
        sportId: "sport-baseball",
      }),
    );
  });
});

describe("AddLeagueForm — telling the host it is busy", () => {
  it("reports busy for exactly the length of the round trip", async () => {
    // The modal refuses Escape and a scrim click while this is true. Without
    // it, dismissing mid-create leaves the result landing on an unmounted host
    // — and a league in the table the operator was never shown.
    let release: (() => void) | undefined;
    mockCreateByAdmin.mockReturnValue(
      new Promise((resolve) => {
        release = () => resolve({ id: "lg-npb", created: true });
      }),
    );

    renderForm({ lockSport: true, sportLabel: "Baseball", onBusyChange });
    onBusyChange.mockClear();

    fireEvent.change(screen.getByLabelText("New league name"), {
      target: { value: "Nippon Professional Baseball" },
    });
    fireEvent.click(
      screen.getByLabelText("Create league Nippon Professional Baseball"),
    );

    await waitFor(() => expect(onBusyChange).toHaveBeenCalledWith(true));

    release?.();
    await waitFor(() => expect(onBusyChange).toHaveBeenLastCalledWith(false));
  });
});
