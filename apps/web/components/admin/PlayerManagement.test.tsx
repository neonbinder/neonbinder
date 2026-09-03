/**
 * NEO-212 — `/admin/players`, the screen for finding, adding and correcting
 * globally-shared player rows.
 *
 * What is asserted here is the set of behaviours that are invisible when they
 * break, or that break something outside this file:
 *
 *  1. **The filter takes focus only once the list has loaded.** The teams
 *     screen shipped this focus as an unconditional mount effect, which ran
 *     against an input that did not exist yet and silently did nothing; the
 *     screen looked completely correct and ignored typing. That was caught by
 *     an E2E flow, not a unit test. It is caught here now.
 *  2. **Two characters switches from client-side filtering to the search
 *     index.** `listForManagement` caps at 500 rows, so filtering that page in
 *     the browser answers "no such player" for everyone past the cap — the
 *     exact wrong answer on the screen whose job is preventing duplicates.
 *  3. **The add form's primary action flips on an exact match.** The whole
 *     point of the near-match panel is that the safe move (open the row that
 *     already exists) is the easy one; a warning nobody has to act on is not
 *     that.
 *  4. **Two stints at one team survive.** A player traded away and re-signed
 *     later has two real stints at one franchise, and any dedupe by team would
 *     destroy exactly the history this editor exists to record. Only a literal
 *     `(team, fromYear)` repeat is refused, and it is refused before anything
 *     is sent.
 *  5. **`NAME_TAKEN` is offered as a destination, not just an error.** The
 *     mutation hands back the other row's id precisely so the operator is not
 *     left to go and search for it.
 *
 * --- Mocking strategy (mirrors EntityReviewWizard.test.tsx) ---
 * convex/react's useQuery/useMutation/useAction are module-mocked and routed by
 * the (string-mocked) function reference. `SetSelector/TeamPicker` is stubbed:
 * it has its own dedicated test file, so this one only needs to prove the
 * career-history row wires its callbacks and passes the player's sport, not to
 * re-exercise a typeahead.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks — declared before the component import
// ---------------------------------------------------------------------------

vi.mock("../../convex/_generated/api", () => ({
  api: {
    players: {
      listForManagement: "players.listForManagement",
      search: "players.search",
      get: "players.get",
      nearMatches: "players.nearMatches",
      createByAdmin: "players.createByAdmin",
      savePlayerFields: "players.savePlayerFields",
      enrichFromWikidata: "players.enrichFromWikidata",
    },
    teams: { getManyByIds: "teams.getManyByIds" },
    selectorOptions: {
      getSelectorOptions: "selectorOptions.getSelectorOptions",
    },
  },
}));

type Args = Record<string, unknown> | "skip";

const seenArgs: Record<string, Args[]> = {};
const lastArgs = (ref: string): Record<string, unknown> | undefined => {
  const calls = (seenArgs[ref] ?? []).filter((a) => a !== "skip");
  return calls[calls.length - 1] as Record<string, unknown> | undefined;
};

const mockCreateByAdmin = vi.fn();
const mockSavePlayerFields = vi.fn();
const mockEnrich = vi.fn();

vi.mock("convex/react", () => ({
  useQuery: (ref: string, args: Args) => {
    (seenArgs[ref] ??= []).push(args);
    if (args === "skip") return undefined;
    return routeQuery(ref, args as Record<string, unknown>);
  },
  useMutation: (ref: string) => {
    if (ref === "players.createByAdmin") return mockCreateByAdmin;
    if (ref === "players.savePlayerFields") return mockSavePlayerFields;
    return vi.fn();
  },
  useAction: (ref: string) => {
    if (ref === "players.enrichFromWikidata") return mockEnrich;
    return vi.fn();
  },
}));

let lastPickerSportId: string | null = null;
vi.mock("@/components/SetSelector/TeamPicker", () => ({
  default: ({
    onChange,
    sportId,
  }: {
    value: string[];
    onChange: (next: string[]) => void;
    sportId?: string;
  }) => {
    lastPickerSportId = sportId ?? null;
    return (
      <div>
        <button type="button" onClick={() => onChange(["t-mariners"])}>
          Pick Seattle Mariners
        </button>
        <button type="button" onClick={() => onChange(["t-reds"])}>
          Pick Cincinnati Reds
        </button>
      </div>
    );
  },
}));

// ---------------------------------------------------------------------------
// Component under test — imported after the mocks
// ---------------------------------------------------------------------------

import PlayerManagement from "./PlayerManagement";

// ---------------------------------------------------------------------------
// Fixtures. Stable object identities on purpose: `useQuery` returning a fresh
// object every render would churn every downstream memo for no reason.
// ---------------------------------------------------------------------------

const SPORTS = [
  { _id: "sport-baseball", _creationTime: 1, level: "sport", value: "Baseball" },
  { _id: "sport-football", _creationTime: 1, level: "sport", value: "Football" },
];

const GRIFFEY = {
  _id: "p-griffey",
  _creationTime: 1,
  name: "Ken Griffey Jr.",
  nameNormalized: "griffey jr ken",
  sportId: "sport-baseball",
  isHallOfFame: true,
  externalIds: { wikidataId: "Q313256" },
  // Deliberately stored out of order, so "renders in career order" cannot pass
  // by accident.
  teamYears: [
    { teamId: "t-mariners", fromYear: 2009 },
    { teamId: "t-mariners", fromYear: 1989, toYear: 1999 },
  ],
  lastUpdated: 1,
};

const TROUT = {
  _id: "p-trout",
  _creationTime: 2,
  name: "Mike Trout",
  nameNormalized: "mike trout",
  sportId: "sport-baseball",
  lastUpdated: 1,
};

const RICE = {
  _id: "p-rice",
  _creationTime: 3,
  name: "Jerry Rice",
  nameNormalized: "jerry rice",
  sportId: "sport-football",
  lastUpdated: 1,
};

const PLAYERS_BY_ID: Record<string, unknown> = {
  "p-griffey": GRIFFEY,
  "p-trout": TROUT,
  "p-rice": RICE,
};

const TEAMS = [
  {
    _id: "t-mariners",
    _creationTime: 1,
    name: "Seattle Mariners",
    sportId: "sport-baseball",
    lastUpdated: 1,
  },
  {
    _id: "t-reds",
    _creationTime: 1,
    name: "Cincinnati Reds",
    sportId: "sport-baseball",
    lastUpdated: 1,
  },
];

// Mutable per-test query answers.
let management: unknown;
let searchResults: unknown;
let nearMatches: unknown;

function routeQuery(ref: string, args: Record<string, unknown>): unknown {
  switch (ref) {
    case "selectorOptions.getSelectorOptions":
      return SPORTS;
    case "players.listForManagement":
      return management;
    case "players.search":
      return searchResults;
    case "players.nearMatches":
      return nearMatches;
    case "players.get":
      return PLAYERS_BY_ID[args.id as string] ?? null;
    case "teams.getManyByIds":
      return TEAMS.filter((t) =>
        (args.ids as string[]).includes(t._id),
      );
    default:
      return undefined;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(seenArgs)) delete seenArgs[key];
  lastPickerSportId = null;
  management = {
    players: [RICE, GRIFFEY, TROUT],
    totalCount: 3,
    truncated: false,
  };
  searchResults = [GRIFFEY, TROUT];
  nearMatches = undefined;
  mockCreateByAdmin.mockResolvedValue({ id: "p-trout", created: true });
  mockSavePlayerFields.mockResolvedValue(null);
  mockEnrich.mockResolvedValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Open the detail panel on Ken Griffey Jr. */
function selectGriffey() {
  fireEvent.click(screen.getByRole("button", { name: /Ken Griffey Jr\./ }));
}

/** Open the add form and choose a sport, which the create button requires. */
function openAddForm(container: HTMLElement) {
  fireEvent.click(screen.getByRole("button", { name: "Add player" }));
  fireEvent.change(container.querySelector("#new-player-sport")!, {
    target: { value: "sport-baseball" },
  });
}

// ---------------------------------------------------------------------------

describe("PlayerManagement — the list", () => {
  it("focuses the filter once the list resolves, and not before", () => {
    management = undefined;
    const { rerender } = render(<PlayerManagement />);

    const filter = screen.getByLabelText("Filter players");
    expect(document.activeElement).not.toBe(filter);

    management = { players: [GRIFFEY], totalCount: 1, truncated: false };
    rerender(<PlayerManagement />);
    expect(document.activeElement).toBe(screen.getByLabelText("Filter players"));
  });

  it("counts the loaded page while the filter is short", () => {
    render(<PlayerManagement />);
    expect(screen.getByText("3 of 3 players")).toBeTruthy();

    // One character still filters the loaded page — no search subscription.
    fireEvent.change(screen.getByLabelText("Filter players"), {
      target: { value: "r" },
    });
    expect(screen.getByText("3 of 3 players")).toBeTruthy();
    expect((seenArgs["players.search"] ?? []).every((a) => a === "skip")).toBe(
      true,
    );
  });

  it("switches to the search index past two characters", async () => {
    render(<PlayerManagement />);
    fireEvent.change(screen.getByLabelText("Filter players"), {
      target: { value: "gr" },
    });

    await waitFor(() =>
      expect(lastArgs("players.search")).toEqual({ query: "gr" }),
    );
    expect(screen.getByText("2 matches")).toBeTruthy();
  });

  it("passes the sport filter to both the list and the search", async () => {
    const { container } = render(<PlayerManagement />);
    fireEvent.change(container.querySelector("#sport-filter")!, {
      target: { value: "sport-football" },
    });
    expect(lastArgs("players.listForManagement")).toEqual({
      sportId: "sport-football",
    });

    fireEvent.change(screen.getByLabelText("Filter players"), {
      target: { value: "ric" },
    });
    await waitFor(() =>
      expect(lastArgs("players.search")).toEqual({
        query: "ric",
        sportId: "sport-football",
      }),
    );
  });

  it("says the list is truncated rather than implying it is complete", () => {
    management = { players: [GRIFFEY], totalCount: 1, truncated: true };
    render(<PlayerManagement />);
    expect(
      screen.getByText("1 of 1 players · list truncated, type to search"),
    ).toBeTruthy();
  });

  it("badges Hall of Fame, stint count and a known Wikidata id", () => {
    render(<PlayerManagement />);
    const row = screen.getByRole("button", { name: /Ken Griffey Jr\./ });
    expect(row.textContent).toContain("Baseball");
    expect(row.textContent).toContain("HoF");
    expect(row.textContent).toContain("2 stints");
    expect(row.textContent).toContain("Q…");

    // Mike Trout has none of them — the badges mean something.
    const plain = screen.getByRole("button", { name: /Mike Trout/ });
    expect(plain.textContent).not.toContain("HoF");
    expect(plain.textContent).not.toContain("stint");
    expect(plain.textContent).not.toContain("Q…");
  });

  it("marks the open row as current", () => {
    render(<PlayerManagement />);
    selectGriffey();
    expect(
      screen
        .getByRole("button", { name: /Ken Griffey Jr\./ })
        .getAttribute("aria-current"),
    ).toBe("true");
  });

  it("says so when nothing matches", () => {
    management = { players: [], totalCount: 0, truncated: false };
    render(<PlayerManagement />);
    expect(screen.getByText("No players match that filter.")).toBeTruthy();
  });
});

describe("PlayerManagement — the add form", () => {
  it("offers near matches for the name being typed", async () => {
    nearMatches = [{ _id: "p-griffey", name: "Ken Griffey", confidence: "close" }];
    const { container } = render(<PlayerManagement />);
    openAddForm(container);

    fireEvent.change(screen.getByLabelText("New player name"), {
      target: { value: "Ken Griffy" },
    });

    await waitFor(() =>
      expect(lastArgs("players.nearMatches")).toEqual({
        name: "Ken Griffy",
        sportId: "sport-baseball",
      }),
    );
    expect(screen.getByText("Possible matches")).toBeTruthy();
    // The page's own wording — "Link to" would describe an action this screen
    // does not perform.
    expect(screen.getByLabelText("Open Ken Griffey")).toBeTruthy();
  });

  it("demotes create to 'Create anyway' when the name already exists", async () => {
    nearMatches = [
      { _id: "p-griffey", name: "Ken Griffey Jr.", confidence: "exact" },
    ];
    const { container } = render(<PlayerManagement />);
    openAddForm(container);
    fireEvent.change(screen.getByLabelText("New player name"), {
      target: { value: "Ken Griffey Jr." },
    });

    // Two `Open Ken Griffey Jr.` buttons deliberately: the panel row and the
    // promoted primary action. They perform the same thing, so whichever an
    // operator (or a Maestro tap) reaches first is correct — [0] is the panel
    // row, [1] the green button.
    await waitFor(() =>
      expect(
        screen.getAllByRole("button", { name: "Open Ken Griffey Jr." }),
      ).toHaveLength(2),
    );
    expect(
      screen.getByLabelText("Create player Ken Griffey Jr. anyway"),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Create player Ken Griffey Jr." }),
    ).toBeNull();

    // The green button opens the row rather than creating a second one.
    fireEvent.click(
      screen.getAllByRole("button", { name: "Open Ken Griffey Jr." })[1],
    );
    expect(mockCreateByAdmin).not.toHaveBeenCalled();
    expect(
      screen.getByRole("heading", { level: 4, name: "Ken Griffey Jr." }),
    ).toBeTruthy();
  });

  it("still allows a genuine duplicate name through 'Create anyway'", async () => {
    nearMatches = [
      { _id: "p-griffey", name: "Ken Griffey Jr.", confidence: "exact" },
    ];
    const { container } = render(<PlayerManagement />);
    openAddForm(container);
    fireEvent.change(screen.getByLabelText("New player name"), {
      target: { value: "Ken Griffey Jr." },
    });
    await waitFor(() =>
      expect(
        screen.getByLabelText("Create player Ken Griffey Jr. anyway"),
      ).toBeTruthy(),
    );

    fireEvent.click(
      screen.getByLabelText("Create player Ken Griffey Jr. anyway"),
    );
    await waitFor(() =>
      expect(mockCreateByAdmin).toHaveBeenCalledWith({
        name: "Ken Griffey Jr.",
        sportId: "sport-baseball",
      }),
    );
  });

  it("creates a player and opens it", async () => {
    const { container } = render(<PlayerManagement />);
    openAddForm(container);
    fireEvent.change(screen.getByLabelText("New player name"), {
      target: { value: "Mike Trout" },
    });

    fireEvent.click(screen.getByLabelText("Create player Mike Trout"));

    await waitFor(() =>
      expect(mockCreateByAdmin).toHaveBeenCalledWith({
        name: "Mike Trout",
        sportId: "sport-baseball",
      }),
    );
    expect(await screen.findByText("Added Mike Trout.")).toBeTruthy();
    // The form closed onto the new row rather than leaving the operator to
    // find it.
    expect(
      screen.getByRole("heading", { level: 4, name: "Mike Trout" }),
    ).toBeTruthy();
  });

  it("says when the player already existed instead of claiming a creation", async () => {
    mockCreateByAdmin.mockResolvedValue({ id: "p-trout", created: false });
    const { container } = render(<PlayerManagement />);
    openAddForm(container);
    fireEvent.change(screen.getByLabelText("New player name"), {
      target: { value: "Mike Trout" },
    });
    fireEvent.click(screen.getByLabelText("Create player Mike Trout"));

    expect(
      await screen.findByText("That player already exists — opened it."),
    ).toBeTruthy();
  });

  it("closes on Cancel without creating anything", () => {
    const { container } = render(<PlayerManagement />);
    openAddForm(container);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(mockCreateByAdmin).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("New player name")).toBeNull();
  });
});

describe("PlayerManagement — the detail panel", () => {
  it("lists two stints at one team in career order", () => {
    render(<PlayerManagement />);
    selectGriffey();

    const rows = screen
      .getByRole("list", { name: "Career history" })
      .querySelectorAll("li");
    expect(Array.from(rows).map((li) => li.textContent)).toEqual([
      "Seattle Mariners · 1989–1999Remove stint",
      "Seattle Mariners · 2009–presentRemove stint",
    ]);
    // Each stint is removable on its own, so the labels must distinguish them.
    expect(
      screen.getByLabelText("Remove Seattle Mariners 1989 stint"),
    ).toBeTruthy();
    expect(
      screen.getByLabelText("Remove Seattle Mariners 2009 stint"),
    ).toBeTruthy();
  });

  it("scopes the team picker to the player's sport", () => {
    render(<PlayerManagement />);
    selectGriffey();
    expect(lastPickerSportId).toBe("sport-baseball");
  });

  it("refuses a repeat (team, start year) inline and sends nothing", () => {
    render(<PlayerManagement />);
    selectGriffey();

    fireEvent.click(screen.getByRole("button", { name: "Pick Seattle Mariners" }));
    fireEvent.change(screen.getByLabelText("Stint from year"), {
      target: { value: "1989" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add stint" }));

    expect(screen.getByRole("alert").textContent).toBe(
      "Seattle Mariners already has a stint starting in 1989.",
    );
    expect(mockSavePlayerFields).not.toHaveBeenCalled();
    expect(
      screen
        .getByRole("list", { name: "Career history" })
        .querySelectorAll("li"),
    ).toHaveLength(2);
  });

  it("sends the whole career history — both existing stints included", async () => {
    render(<PlayerManagement />);
    selectGriffey();

    fireEvent.click(screen.getByRole("button", { name: "Pick Seattle Mariners" }));
    fireEvent.change(screen.getByLabelText("Stint from year"), {
      target: { value: "2010" },
    });
    fireEvent.change(screen.getByLabelText("Stint to year (optional)"), {
      target: { value: "2010" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add stint" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mockSavePlayerFields).toHaveBeenCalledTimes(1));
    expect(mockSavePlayerFields).toHaveBeenCalledWith({
      id: "p-griffey",
      teamYears: [
        { teamId: "t-mariners", fromYear: 1989, toYear: 1999 },
        { teamId: "t-mariners", fromYear: 2009 },
        { teamId: "t-mariners", fromYear: 2010, toYear: 2010 },
      ],
    });
  });

  it("sends only the fields that changed", async () => {
    render(<PlayerManagement />);
    selectGriffey();

    fireEvent.click(screen.getByLabelText("Hall of Fame"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(mockSavePlayerFields).toHaveBeenCalledWith({
        id: "p-griffey",
        isHallOfFame: false,
      }),
    );
  });

  it("keeps Save inert until something actually changed", () => {
    render(<PlayerManagement />);
    selectGriffey();
    expect(
      screen.getByRole("button", { name: "Save" }).hasAttribute("disabled"),
    ).toBe(true);
  });

  it("offers to open the existing player when the name is taken", async () => {
    mockSavePlayerFields.mockRejectedValue(
      new ConvexError("NAME_TAKEN:p-trout"),
    );
    render(<PlayerManagement />);
    selectGriffey();

    fireEvent.change(screen.getByLabelText("Player name"), {
      target: { value: "Mike Trout" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("That name already exists")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Open the existing player" }),
    );
    expect(
      screen.getByRole("heading", { level: 4, name: "Mike Trout" }),
    ).toBeTruthy();
  });

  it("links to Wikidata safely, and says the link leaves the page", () => {
    render(<PlayerManagement />);
    selectGriffey();

    const link = screen.getByRole("link", {
      name: "Wikidata Q313256 (opens in new tab)",
    });
    expect(link.getAttribute("href")).toBe(
      "https://www.wikidata.org/wiki/Q313256",
    );
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("queues a re-enrichment and says it is coming", async () => {
    render(<PlayerManagement />);
    selectGriffey();

    fireEvent.click(
      screen.getByRole("button", { name: "Re-enrich from Wikidata" }),
    );
    await waitFor(() =>
      expect(mockEnrich).toHaveBeenCalledWith({ id: "p-griffey" }),
    );
    expect(
      await screen.findByText("Enrichment queued — it lands in a moment."),
    ).toBeTruthy();
  });

  it("re-seeds the draft when a different player is opened", () => {
    render(<PlayerManagement />);
    selectGriffey();
    fireEvent.change(screen.getByLabelText("Player name"), {
      target: { value: "edited but never saved" },
    });

    fireEvent.click(screen.getByRole("button", { name: /Mike Trout/ }));
    expect(
      (screen.getByLabelText("Player name") as HTMLInputElement).value,
    ).toBe("Mike Trout");
  });
});
