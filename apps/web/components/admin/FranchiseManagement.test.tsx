/**
 * NEO-254 — Franchise Management.
 *
 * Six behaviours, and every one of them is something an operator would only
 * notice by the data being wrong later:
 *
 *  1. **The thread is in history order, and undated teams sit outside it.**
 *     The whole reason to open this screen is to check that a thread reads as
 *     one continuous club, and an alphabetical list hides exactly that. A team
 *     nobody has dated cannot be placed in the sequence, so it must not be
 *     GIVEN a position — it goes below the rail under its own heading.
 *  2. **Remove sends `null`, and touches nothing else.** Omitting the field
 *     leaves the link in place; sending the team's other fields would let this
 *     screen overwrite a name it never showed.
 *  3. **A rename never touches the teams.** That indirection is why the table
 *     exists rather than a string on `teams`.
 *  4. **The ?franchise deep link opens its row and clears the filters.** A
 *     link that lands on a screen filtered so the row is invisible looks
 *     broken.
 *  5. **Starting a franchise that already exists opens it** rather than
 *     failing on a duplicate the operator cannot see.
 *  6. **Refusals reach the operator.** Only a `ConvexError`'s string data
 *     survives production, so the fallback path is asserted too.
 *
 * Mocking follows `LeagueManagement.test.tsx`: `convex/_generated/api` is
 * stubbed so every function reference is a plain string, and `convex/react` is
 * module-mocked to route on that string. The component is imported after the
 * mocks.
 */

import {
  fireEvent,
  render as renderBare,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactElement } from "react";
import { ConvexError } from "convex/values";
import { MemoryRouter, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../convex/_generated/api", () => ({
  api: {
    franchises: {
      list: "franchises.list",
      get: "franchises.get",
      save: "franchises.save",
      findOrCreate: "franchises.findOrCreate",
    },
    teams: { saveTeamFields: "teams.saveTeamFields" },
    selectorOptions: { getSelectorOptions: "selectorOptions.getSelectorOptions" },
  },
}));

const SPORTS = [
  { _id: "sport-football", _creationTime: 0, level: "sport", value: "Football" },
  { _id: "sport-baseball", _creationTime: 0, level: "sport", value: "Baseball" },
];

const FRANCHISES = [
  {
    _id: "f-titans",
    _creationTime: 0,
    name: "Titans / Oilers",
    nameNormalized: "oilers titans",
    sportId: "sport-football",
    lastUpdated: 0,
    teamCount: 3,
  },
  {
    _id: "f-nats",
    _creationTime: 0,
    name: "Nationals / Expos",
    nameNormalized: "expos nationals",
    sportId: "sport-baseball",
    lastUpdated: 0,
    teamCount: 2,
  },
];

/**
 * The thread as the SERVER hands it over — already ordered by
 * `orderFranchiseTeams`, because that ordering is the query's contract and
 * re-sorting here would hide a server that stopped honouring it. The undated
 * row is last, which is what the query promises.
 */
const TITANS_VIEW = {
  franchise: FRANCHISES[0],
  teams: [
    {
      _id: "t-hou-oilers",
      name: "Oilers",
      location: "Houston",
      yearsActive: { from: 1960, to: 1996 },
    },
    {
      _id: "t-ten-titans",
      name: "Titans",
      location: "Tennessee",
      yearsActive: { from: 1999 },
    },
    { _id: "t-ten-oilers", name: "Oilers", location: "Tennessee" },
  ],
  truncated: false,
};

const mockSave = vi.fn();
const mockFindOrCreate = vi.fn();
const mockSaveTeamFields = vi.fn();

vi.mock("convex/react", () => ({
  useQuery: (ref: string, args: unknown) => {
    if (args === "skip") return undefined;
    if (ref === "franchises.list") {
      return { franchises: FRANCHISES, truncated: false };
    }
    if (ref === "franchises.get") {
      const id = (args as { id: string }).id;
      return id === "f-titans" ? TITANS_VIEW : null;
    }
    if (ref === "selectorOptions.getSelectorOptions") return SPORTS;
    return undefined;
  },
  useMutation: (ref: string) => {
    if (ref === "franchises.save") return mockSave;
    if (ref === "franchises.findOrCreate") return mockFindOrCreate;
    if (ref === "teams.saveTeamFields") return mockSaveTeamFields;
    return vi.fn();
  },
  useAction: () => vi.fn(),
}));

import FranchiseManagement from "./FranchiseManagement";

function LocationProbe() {
  return <span data-testid="search">{useLocation().search}</span>;
}

const render = (ui: ReactElement, entry = "/admin/franchises") =>
  renderBare(
    <MemoryRouter initialEntries={[entry]}>
      {ui}
      <LocationProbe />
    </MemoryRouter>,
  );

const renderAt = (entry: string) => render(<FranchiseManagement />, entry);

const row = (name: string) =>
  screen.getByRole("button", { name: new RegExp(name) });

beforeEach(() => {
  mockSave.mockReset().mockResolvedValue(null);
  mockSaveTeamFields.mockReset().mockResolvedValue(null);
  mockFindOrCreate
    .mockReset()
    .mockResolvedValue({ id: "f-new", created: true });
});

describe("the thread", () => {
  it("renders dated teams as an ordered rail and undated ones outside it", () => {
    renderAt("/admin/franchises?franchise=f-titans");

    // The dated rail is an <ol> — the markup itself says "sequence", which is
    // what a screen reader gets instead of the decorative rail.
    const ordered = document.querySelector("ol")!;
    expect(
      within(ordered as HTMLElement)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual([
      expect.stringContaining("Houston Oilers"),
      expect.stringContaining("Tennessee Titans"),
    ]);
    expect(ordered.textContent).toContain("1960–1996");
    expect(ordered.textContent).toContain("1999–present");

    // The undated team is NOT in the rail; it is under its own heading.
    expect(ordered.textContent).not.toContain("Tennessee Oilers");
    expect(screen.getByText("No years yet")).toBeTruthy();
  });

  it("takes a team off the thread with null, and sends nothing else", async () => {
    renderAt("/admin/franchises?franchise=f-titans");

    fireEvent.click(screen.getByRole("button", { name: "Remove Houston Oilers" }));

    await waitFor(() => expect(mockSaveTeamFields).toHaveBeenCalled());
    // Exactly two keys: the row and the cleared link. Anything else would let
    // this screen overwrite a field it never showed the operator.
    expect(mockSaveTeamFields.mock.calls[0][0]).toEqual({
      id: "t-hou-oilers",
      franchiseId: null,
    });
    expect(
      await screen.findByText("Took Houston Oilers off this franchise."),
    ).toBeTruthy();
  });

  it("says what to do when the row the list offered no longer resolves", () => {
    // `franchises.get` is a live query and the list is a separate one, so a
    // franchise deleted under the operator shows as a selectable row whose
    // panel has nothing behind it. The panel says so and points at the list
    // rather than rendering an empty shell.
    renderAt("/admin/franchises?franchise=f-nats");
    expect(screen.getByText(/That franchise is gone/)).toBeTruthy();
  });
});

describe("renaming", () => {
  it("saves the new name and leaves every team alone", async () => {
    renderAt("/admin/franchises?franchise=f-titans");

    fireEvent.change(screen.getByLabelText("Franchise name"), {
      target: { value: "Tennessee Titans" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));

    await waitFor(() =>
      expect(mockSave).toHaveBeenCalledWith({
        id: "f-titans",
        name: "Tennessee Titans",
      }),
    );
    expect(mockSaveTeamFields).not.toHaveBeenCalled();
    expect(await screen.findByText("Renamed to Tennessee Titans.")).toBeTruthy();
  });

  it("cannot save a name that has not changed", () => {
    renderAt("/admin/franchises?franchise=f-titans");
    expect(
      screen.getByRole("button", { name: "Save name" }),
    ).toHaveProperty("disabled", true);
  });

  it("shows the server's own refusal", async () => {
    mockSave.mockRejectedValue(
      new ConvexError("Another franchise in this sport is already called Ravens."),
    );
    renderAt("/admin/franchises?franchise=f-titans");

    fireEvent.change(screen.getByLabelText("Franchise name"), {
      target: { value: "Ravens" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));

    expect(
      await screen.findByText(
        "Another franchise in this sport is already called Ravens.",
      ),
    ).toBeTruthy();
  });

  it("falls back to plain words for a failure that carried no message", async () => {
    // A plain Error reaches the client as "Server Error" in production, so the
    // fallback is what the operator actually reads.
    mockSave.mockRejectedValue(new Error("boom"));
    renderAt("/admin/franchises?franchise=f-titans");

    fireEvent.change(screen.getByLabelText("Franchise name"), {
      target: { value: "Ravens" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));

    expect(
      await screen.findByText("Could not rename that franchise."),
    ).toBeTruthy();
  });
});

describe("the ?franchise deep link", () => {
  it("opens the row it names and scrolls it into view", () => {
    const scrollIntoView = vi
      .spyOn(Element.prototype, "scrollIntoView")
      .mockImplementation(() => {});

    renderAt("/admin/franchises?franchise=f-titans");

    expect(row("Titans / Oilers").getAttribute("aria-current")).toBe("true");
    expect(scrollIntoView).toHaveBeenCalled();
    scrollIntoView.mockRestore();
  });

  it("writes the selection to the URL when a row is clicked", async () => {
    renderAt("/admin/franchises");
    fireEvent.click(row("Nationals / Expos"));
    await waitFor(() =>
      expect(screen.getByTestId("search").textContent).toBe("?franchise=f-nats"),
    );
  });

  it("leaves the screen alone for an id this deployment does not have", () => {
    renderAt("/admin/franchises?franchise=f-gone");
    expect(row("Titans / Oilers").getAttribute("aria-current")).toBeNull();
  });
});

describe("starting a franchise", () => {
  it("creates one and opens it", async () => {
    renderAt("/admin/franchises");
    fireEvent.click(screen.getByRole("button", { name: "Start a franchise" }));
    fireEvent.change(screen.getByLabelText("Franchise name"), {
      target: { value: "Ravens" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start franchise" }));

    await waitFor(() =>
      expect(mockFindOrCreate).toHaveBeenCalledWith({
        name: "Ravens",
        sportId: "sport-football",
      }),
    );
    expect(
      await screen.findByText("Started Ravens. Now go put some teams on it."),
    ).toBeTruthy();
  });

  it("opens the existing one instead of failing on a duplicate", async () => {
    mockFindOrCreate.mockResolvedValue({ id: "f-titans", created: false });
    renderAt("/admin/franchises");
    fireEvent.click(screen.getByRole("button", { name: "Start a franchise" }));
    fireEvent.change(screen.getByLabelText("Franchise name"), {
      target: { value: "Oilers Titans" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start franchise" }));

    expect(
      await screen.findByText("Oilers Titans was already here — opened it for you."),
    ).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByTestId("search").textContent).toBe("?franchise=f-titans"),
    );
  });
});

/**
 * NEO-254 accessibility audit — two findings, pinned.
 *
 * Both are focus bugs, which are exactly the kind that pass every visual check
 * and make the screen unusable from a keyboard.
 */
describe("keyboard and focus", () => {
  it("puts focus back on the trigger when the add form is dismissed", () => {
    renderAt("/admin/franchises");
    const trigger = screen.getByRole("button", { name: "Start a franchise" });
    fireEvent.click(trigger);

    fireEvent.keyDown(screen.getByLabelText("Franchise name"), {
      key: "Escape",
    });

    // Not `<body>`: dismissing unmounts the focused input, and an operator who
    // pressed Escape would otherwise be dropped to the top of the document.
    expect(document.activeElement).toBe(trigger);
  });

  it("puts focus back on the trigger when Cancel is pressed", () => {
    renderAt("/admin/franchises");
    const trigger = screen.getByRole("button", { name: "Start a franchise" });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(document.activeElement).toBe(trigger);
  });

  it("keeps every Remove button focusable while one removal is in flight", async () => {
    // `aria-disabled`, not `disabled`. A native disabled button cannot hold
    // focus, so the browser would blur the just-pressed button to `<body>` and
    // drop every sibling row out of the tab order with nothing saying why.
    let resolve: (() => void) | undefined;
    mockSaveTeamFields.mockImplementation(
      () => new Promise<null>((r) => (resolve = () => r(null))),
    );
    renderAt("/admin/franchises?franchise=f-titans");

    const first = screen.getByRole("button", { name: "Remove Houston Oilers" });
    const second = screen.getByRole("button", {
      name: "Remove Tennessee Titans",
    });
    fireEvent.click(first);

    await waitFor(() => expect(first.textContent).toBe("Removing…"));
    expect(first.hasAttribute("disabled")).toBe(false);
    expect(second.getAttribute("aria-disabled")).toBe("true");
    expect(second.hasAttribute("disabled")).toBe(false);

    // …and the guard, which is what `aria-disabled` does NOT do on its own.
    fireEvent.click(second);
    expect(mockSaveTeamFields).toHaveBeenCalledTimes(1);

    resolve?.();
  });
});

describe("the list", () => {
  it("filters by sport and counts the teams on each thread", () => {
    renderAt("/admin/franchises");
    expect(screen.getByText("2 of 2 franchises")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Sport"), {
      target: { value: "sport-baseball" },
    });
    expect(screen.getByText("1 of 2 franchises")).toBeTruthy();
    expect(row("Nationals / Expos").textContent).toContain("2 teams");
  });

  it("invites the operator to act when there is nothing to show", () => {
    renderAt("/admin/franchises");
    fireEvent.change(screen.getByLabelText("Filter franchises"), {
      target: { value: "zzz" },
    });
    expect(screen.getByText("No franchises match that filter.")).toBeTruthy();
  });
});
