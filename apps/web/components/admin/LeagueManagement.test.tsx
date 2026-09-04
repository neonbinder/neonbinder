/**
 * NEO-240 — `/admin/leagues`, the screen for finding, adding and correcting
 * globally-shared league rows.
 *
 * What is asserted here is the set of behaviours that are invisible when they
 * break, or that break something outside this file:
 *
 *  1. **The filter takes focus only once the list has loaded.** The teams
 *     screen shipped this focus as an unconditional mount effect, which ran
 *     against an input that did not exist yet and silently did nothing; the
 *     screen looked completely correct and ignored typing. That was caught by
 *     an E2E flow, not a unit test. It is caught here now.
 *  2. **The row says what is MISSING, out loud.** A league with no
 *     abbreviation and a league with no level are the two things this screen
 *     exists to fix, and the markers that say so are glyphs — so the words are
 *     carried in the accessible name rather than in a `title` no screen reader
 *     announces.
 *  3. **The add form's primary action flips on an exact match.** The whole
 *     point of the near-match panel is that the safe move (open the row that
 *     already exists) is the easy one; a warning nobody has to act on is not
 *     that. `findOrCreateLeague` has been writing rows unattended since
 *     NEO-156, so near-duplicate spellings are the expected state of the table.
 *  4. **Save sends only what changed.** `saveLeagueFields` reads an omitted arg
 *     as "leave it alone", so a panel that posts its whole draft rewrites
 *     fields nobody touched — including the alias list, which is the one field
 *     here that another operator is plausibly editing at the same time.
 *  5. **Aliases are split and trimmed on the way out.** They are typed as a
 *     comma string and stored as an array; a stray space becomes a second row
 *     that never matches anything.
 *  6. **`NAME_TAKEN` is offered as a destination, not just an error.**
 *  7. **The selected league is in the URL, both ways.** The panel links out to
 *     `/admin/teams`, so Back has to come home to the league the operator left.
 *
 * --- Mocking strategy (mirrors PlayerManagement.test.tsx) ---
 * convex/react's useQuery/useMutation/useAction are module-mocked and routed by
 * the (string-mocked) function reference, so this file does not depend on the
 * generated api types being in place.
 */

import {
  fireEvent,
  render as renderBare,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter, useLocation } from "react-router";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The teams list links into Team Management, so the panel needs a router
// around it. Every render in this file goes through the same wrapper rather
// than each call site growing one.
const render = (ui: ReactElement) => renderBare(ui, { wrapper: MemoryRouter });

// ---------------------------------------------------------------------------
// Module mocks — declared before the component import
// ---------------------------------------------------------------------------

vi.mock("../../convex/_generated/api", () => ({
  api: {
    leagues: {
      listForManagement: "leagues.listForManagement",
      getByIdParam: "leagues.getByIdParam",
      nearMatches: "leagues.nearMatches",
      createByAdmin: "leagues.createByAdmin",
      saveLeagueFields: "leagues.saveLeagueFields",
      teamsIn: "leagues.teamsIn",
      enrichFromWikidata: "leagues.enrichFromWikidata",
    },
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
const mockSaveLeagueFields = vi.fn();
const mockEnrich = vi.fn();

vi.mock("convex/react", () => ({
  useQuery: (ref: string, args: Args) => {
    (seenArgs[ref] ??= []).push(args);
    if (args === "skip") return undefined;
    return routeQuery(ref, args as Record<string, unknown>);
  },
  useMutation: (ref: string) => {
    if (ref === "leagues.createByAdmin") return mockCreateByAdmin;
    if (ref === "leagues.saveLeagueFields") return mockSaveLeagueFields;
    return vi.fn();
  },
  useAction: (ref: string) => {
    if (ref === "leagues.enrichFromWikidata") return mockEnrich;
    return vi.fn();
  },
}));

// ---------------------------------------------------------------------------
// Component under test — imported after the mocks
// ---------------------------------------------------------------------------

import LeagueManagement from "./LeagueManagement";

// ---------------------------------------------------------------------------
// Fixtures. Stable object identities on purpose: `useQuery` returning a fresh
// object every render would churn every downstream memo for no reason.
// ---------------------------------------------------------------------------

const SPORTS = [
  { _id: "sport-baseball", _creationTime: 1, level: "sport", value: "Baseball" },
  { _id: "sport-hockey", _creationTime: 1, level: "sport", value: "Hockey" },
];

/** Complete: an abbreviation, a level, an era, a QID and one folded spelling. */
const AL = {
  _id: "lg-al",
  _creationTime: 1,
  name: "American League",
  abbreviation: "AL",
  nameNormalized: "american league",
  sportId: "sport-baseball",
  level: "major",
  yearsActive: { from: 1901 },
  externalIds: { wikidataId: "Q1194951" },
  aliases: ["Amer. League"],
  lastUpdated: 1,
};

/** No abbreviation — the state `findOrCreateLeague` leaves a row in when the
 *  caller only knew a long name. */
const PCL = {
  _id: "lg-pcl",
  _creationTime: 2,
  name: "Pacific Coast League",
  nameNormalized: "pacific coast league",
  sportId: "sport-baseball",
  level: "minor",
  lastUpdated: 1,
};

/** No level — the other half of the same omission, on another sport so the
 *  sport filter has something to filter to. */
const NHL = {
  _id: "lg-nhl",
  _creationTime: 3,
  name: "National Hockey League",
  abbreviation: "NHL",
  nameNormalized: "national hockey league",
  sportId: "sport-hockey",
  lastUpdated: 1,
};

/**
 * A row whose stored `wikidataId` is not a `Q<digits>` id at all — a legacy
 * row, or one written before the field was validated. The panel must show it
 * and must never link it.
 */
const BAD_QID_LEAGUE = {
  _id: "lg-badqid",
  _creationTime: 4,
  name: "Dodgy League",
  abbreviation: "DL",
  nameNormalized: "dodgy league",
  sportId: "sport-baseball",
  level: "other",
  externalIds: { wikidataId: "javascript:alert(1)" },
  lastUpdated: 1,
};

const LEAGUES_BY_ID: Record<string, unknown> = {
  "lg-al": AL,
  "lg-pcl": PCL,
  "lg-nhl": NHL,
  "lg-badqid": BAD_QID_LEAGUE,
};

/**
 * The colour pairs are chosen for what they SCORE against the team chip's
 * slate-900 surface, not for realism. The Yankees' navy is 1.1:1 there — the
 * shape of the problem the fallback exists for, since a franchise's signature
 * colour is very often the one that cannot carry small text on a near-black
 * surface — and its white secondary is what the team prints that navy on.
 */
const AL_TEAMS = [
  {
    _id: "t-yankees",
    name: "New York Yankees",
    city: "New York",
    colors: { primary: "#132448", secondary: "#ffffff" },
  },
  {
    _id: "t-mariners",
    name: "Seattle Mariners",
    city: "Seattle",
    colors: { primary: "#5fd3bc" },
  },
];

// Mutable per-test query answers.
let management: unknown;
let nearMatches: unknown;
let teamsIn: unknown;

function routeQuery(ref: string, args: Record<string, unknown>): unknown {
  switch (ref) {
    case "selectorOptions.getSelectorOptions":
      return SPORTS;
    case "leagues.listForManagement":
      return management;
    case "leagues.nearMatches":
      return nearMatches;
    // The real query normalizes the string first and answers `null` for one
    // that is not an id of this table at all, where a `v.id("leagues")` arg
    // would have REJECTED it and thrown the query into the app-level error
    // boundary. The `?? null` is that behaviour.
    case "leagues.getByIdParam":
      return LEAGUES_BY_ID[args.id as string] ?? null;
    case "leagues.teamsIn":
      return args.leagueId === "lg-al" ? teamsIn : [];
    default:
      return undefined;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(seenArgs)) delete seenArgs[key];
  LEAGUES_BY_ID["lg-al"] = AL;
  management = {
    leagues: [AL, PCL, NHL],
    totalCount: 3,
    truncated: false,
  };
  nearMatches = undefined;
  teamsIn = AL_TEAMS;
  mockCreateByAdmin.mockResolvedValue({ id: "lg-al", created: true });
  mockSaveLeagueFields.mockResolvedValue(null);
  mockEnrich.mockResolvedValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Open the detail panel on the American League. */
function selectAL() {
  fireEvent.click(screen.getByRole("button", { name: /American League/ }));
}

/** Open the add form and choose a sport, which the create button requires. */
function openAddForm(container: HTMLElement) {
  fireEvent.click(screen.getByRole("button", { name: "Add league" }));
  fireEvent.change(container.querySelector("#new-league-sport")!, {
    target: { value: "sport-baseball" },
  });
}

/**
 * The detail panel's status line must render BELOW the Save / Re-enrich row,
 * not in the page-level line at the top of the screen. Asserted as document
 * order because position is the whole point: on a 1024x629 viewport the top
 * line is off-screen at the moment Save is pressed.
 */
function expectBelowTheActionRow(el: Element) {
  const save = screen.getByRole("button", { name: /^Sav/ });
  expect(
    save.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
}

// ---------------------------------------------------------------------------

describe("LeagueManagement — the list", () => {
  it("focuses the filter once the list resolves, and not before", () => {
    management = undefined;
    const { rerender } = render(<LeagueManagement />);

    const filter = screen.getByLabelText("Filter leagues");
    expect(document.activeElement).not.toBe(filter);

    management = { leagues: [AL], totalCount: 1, truncated: false };
    rerender(<LeagueManagement />);
    expect(document.activeElement).toBe(screen.getByLabelText("Filter leagues"));
  });

  it("counts the list and how much of it needs a human", () => {
    render(<LeagueManagement />);
    // PCL has no abbreviation, NHL has no level. AL is complete.
    const counter = screen.getByText("3 of 3 leagues · 2 need attention");
    expect(counter.getAttribute("role")).toBe("status");
    expect(counter.getAttribute("aria-live")).toBe("polite");
  });

  it("drops the attention clause when every league is complete", () => {
    management = { leagues: [AL], totalCount: 1, truncated: false };
    render(<LeagueManagement />);
    expect(screen.getByText("1 of 1 leagues")).toBeTruthy();
  });

  it("filters the loaded page in the browser, names and aliases alike", () => {
    // Complete rather than a capped page (there are dozens of leagues, not
    // thousands), so there is no search index and nothing past the end to miss.
    render(<LeagueManagement />);
    fireEvent.change(screen.getByLabelText("Filter leagues"), {
      target: { value: "amer. lea" },
    });

    // Matched on the ALIAS — the spelling the operator is trying to get rid of
    // is the one they are most likely to type.
    expect(screen.getByRole("button", { name: /American League/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Pacific Coast/ })).toBeNull();
    expect(screen.getByText("1 of 3 leagues · 2 need attention")).toBeTruthy();
  });

  it("passes the sport filter to the list query", () => {
    const { container } = render(<LeagueManagement />);
    fireEvent.change(container.querySelector("#sport-filter")!, {
      target: { value: "sport-hockey" },
    });
    expect(lastArgs("leagues.listForManagement")).toEqual({
      sportId: "sport-hockey",
    });
  });

  it("reads a complete row out as its name, sport, abbreviation and level", () => {
    management = { leagues: [AL], totalCount: 1, truncated: false };
    render(<LeagueManagement />);
    // The separators between the segments are CSS borders, so they contribute
    // nothing to the accessible name and the row announces four plain words.
    expect(
      screen.getByRole("button", {
        name: "American League Baseball AL Major",
      }),
    ).toBeTruthy();
  });

  it("says what is missing in words, not only in a glyph", () => {
    management = { leagues: [PCL, NHL], totalCount: 2, truncated: false };
    render(<LeagueManagement />);

    // The glyph is the sighted operator's marker and is hidden from AT; the
    // sentence beside it is what reaches everyone else. A `title` alone would
    // not — it is not announced, and a warning only sighted operators receive
    // is not a warning.
    const pcl = screen.getByRole("button", { name: /Pacific Coast League/ });
    expect(pcl.getAttribute("aria-label")).toBeNull();
    expect(
      within(pcl).getByText("No abbreviation yet").className,
    ).toContain("sr-only");
    expect(within(pcl).getByTitle("No abbreviation yet")).toBeTruthy();
    expect(within(pcl).getByText("—").getAttribute("aria-hidden")).toBe("true");
    // The level it DOES have is printed as a word, not as the stored value.
    expect(pcl.textContent).toContain("Minor");

    const nhl = screen.getByRole("button", { name: /National Hockey League/ });
    expect(within(nhl).getByText("Level not set").className).toContain(
      "sr-only",
    );
    expect(within(nhl).getByTitle("Level not set")).toBeTruthy();
    expect(within(nhl).getByText("?").getAttribute("aria-hidden")).toBe("true");
    expect(nhl.textContent).toContain("NHL");
  });

  it("marks the open row as current", () => {
    render(<LeagueManagement />);
    selectAL();
    expect(
      screen
        .getByRole("button", { name: /American League/ })
        .getAttribute("aria-current"),
    ).toBe("true");
  });

  it("says so when nothing matches", () => {
    management = { leagues: [], totalCount: 0, truncated: false };
    render(<LeagueManagement />);
    expect(screen.getByText("No leagues match that filter.")).toBeTruthy();
  });

  it("invites a pick rather than showing an empty panel", () => {
    render(<LeagueManagement />);
    // Deliberately NOT the Teams screen's sentence: the two placeholders sit
    // one nav tab apart, and an E2E `assertVisible` cannot tell identical text
    // on two screens apart.
    expect(
      screen.getByText(
        "Select a league to see its teams and edit what we know about it.",
      ),
    ).toBeTruthy();
  });
});

describe("LeagueManagement — the add form", () => {
  it("offers near matches for the name being typed", async () => {
    nearMatches = [
      { _id: "lg-al", name: "American League", confidence: "close" },
    ];
    const { container } = render(<LeagueManagement />);
    openAddForm(container);

    fireEvent.change(screen.getByLabelText("New league name"), {
      target: { value: "Amercan League" },
    });

    await waitFor(() =>
      expect(lastArgs("leagues.nearMatches")).toEqual({
        name: "Amercan League",
        sportId: "sport-baseball",
      }),
    );
    expect(screen.getByText("Possible matches")).toBeTruthy();
    // The page's own wording — "Link to" would describe an action this screen
    // does not perform.
    expect(screen.getByLabelText("Open American League")).toBeTruthy();
  });

  it("demotes create to 'Create anyway' when the name already exists", async () => {
    nearMatches = [
      { _id: "lg-al", name: "American League", confidence: "exact" },
    ];
    const { container } = render(<LeagueManagement />);
    openAddForm(container);
    fireEvent.change(screen.getByLabelText("New league name"), {
      target: { value: "American League" },
    });

    // EXACTLY ONE `Open American League` control. The promoted primary IS the
    // exact panel row, so that row is filtered out of the panel — two controls
    // sharing one accessible name is ambiguous to a screen reader reading the
    // list and to a Maestro `tapOn` matching by it.
    await waitFor(() =>
      expect(
        screen.getAllByRole("button", { name: "Open American League" }),
      ).toHaveLength(1),
    );
    expect(
      screen.getByLabelText("Create league American League anyway"),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Create league American League" }),
    ).toBeNull();

    // The green button opens the row rather than creating a second one.
    fireEvent.click(screen.getByRole("button", { name: "Open American League" }));
    expect(mockCreateByAdmin).not.toHaveBeenCalled();
    expect(
      screen.getByRole("heading", { level: 3, name: "American League" }),
    ).toBeTruthy();
  });

  it("still allows a genuine duplicate name through 'Create anyway'", async () => {
    nearMatches = [
      { _id: "lg-al", name: "American League", confidence: "exact" },
    ];
    const { container } = render(<LeagueManagement />);
    openAddForm(container);
    fireEvent.change(screen.getByLabelText("New league name"), {
      target: { value: "American League" },
    });
    await waitFor(() =>
      expect(
        screen.getByLabelText("Create league American League anyway"),
      ).toBeTruthy(),
    );

    fireEvent.click(
      screen.getByLabelText("Create league American League anyway"),
    );
    await waitFor(() =>
      expect(mockCreateByAdmin).toHaveBeenCalledWith({
        name: "American League",
        sportId: "sport-baseball",
      }),
    );
  });

  it("creates a league with everything the operator filled in, and opens it", async () => {
    const { container } = render(<LeagueManagement />);
    openAddForm(container);
    fireEvent.change(screen.getByLabelText("New league name"), {
      target: { value: "American League" },
    });
    fireEvent.change(screen.getByLabelText("Abbreviation"), {
      target: { value: " AL " },
    });
    fireEvent.click(
      within(screen.getByRole("group", { name: "Level" })).getByRole("button", {
        name: "Major",
      }),
    );

    fireEvent.click(screen.getByLabelText("Create league American League"));

    await waitFor(() =>
      expect(mockCreateByAdmin).toHaveBeenCalledWith({
        name: "American League",
        abbreviation: "AL",
        level: "major",
        sportId: "sport-baseball",
      }),
    );
    expect(await screen.findByText("Added American League.")).toBeTruthy();
    // The form closed onto the new row rather than leaving the operator to
    // find it.
    expect(
      screen.getByRole("heading", { level: 3, name: "American League" }),
    ).toBeTruthy();
  });

  it("omits the optional fields it was not given", async () => {
    const { container } = render(<LeagueManagement />);
    openAddForm(container);
    fireEvent.change(screen.getByLabelText("New league name"), {
      target: { value: "American League" },
    });
    fireEvent.click(screen.getByLabelText("Create league American League"));

    // Not `abbreviation: ""` and not `level: null` — an omitted optional arg is
    // the only honest way to say "the operator did not tell us".
    await waitFor(() =>
      expect(mockCreateByAdmin).toHaveBeenCalledWith({
        name: "American League",
        sportId: "sport-baseball",
      }),
    );
  });

  it("says when the league already existed instead of claiming a creation", async () => {
    mockCreateByAdmin.mockResolvedValue({ id: "lg-al", created: false });
    const { container } = render(<LeagueManagement />);
    openAddForm(container);
    fireEvent.change(screen.getByLabelText("New league name"), {
      target: { value: "American League" },
    });
    fireEvent.click(screen.getByLabelText("Create league American League"));

    expect(
      await screen.findByText("That league already exists — opened it."),
    ).toBeTruthy();
  });

  it("closes on Cancel without creating anything", () => {
    const { container } = render(<LeagueManagement />);
    openAddForm(container);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(mockCreateByAdmin).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("New league name")).toBeNull();
  });
});

describe("LeagueManagement — the level group", () => {
  it("presses exactly the level the row carries", () => {
    render(<LeagueManagement />);
    selectAL();

    const group = screen.getByRole("group", { name: "Level" });
    const pressed = within(group)
      .getAllByRole("button")
      .filter((b) => b.getAttribute("aria-pressed") === "true")
      .map((b) => b.textContent);
    expect(pressed).toEqual(["Major"]);
  });

  it("presses nothing at all when the level is not set", () => {
    management = { leagues: [NHL], totalCount: 1, truncated: false };
    render(<LeagueManagement />);
    fireEvent.click(screen.getByRole("button", { name: /National Hockey/ }));

    const group = screen.getByRole("group", { name: "Level" });
    expect(
      within(group)
        .getAllByRole("button")
        .every((b) => b.getAttribute("aria-pressed") === "false"),
    ).toBe(true);
  });

  it("clears the level when the pressed button is pressed again", async () => {
    // Level is OPTIONAL, and "not set" is a state this screen exists to fix —
    // so it has to stay reachable. A radio group could not get back to it.
    render(<LeagueManagement />);
    selectAL();

    const group = screen.getByRole("group", { name: "Level" });
    fireEvent.click(within(group).getByRole("button", { name: "Major" }));
    expect(
      within(group).getByRole("button", { name: "Major" }).getAttribute(
        "aria-pressed",
      ),
    ).toBe("false");

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(mockSaveLeagueFields).toHaveBeenCalledWith({
        id: "lg-al",
        level: null,
      }),
    );
  });
});

describe("LeagueManagement — the detail panel", () => {
  it("keeps Save inert until something actually changed", () => {
    render(<LeagueManagement />);
    selectAL();
    expect(
      screen.getByRole("button", { name: "Save" }).hasAttribute("disabled"),
    ).toBe(true);
  });

  it("sends only the fields that changed", async () => {
    render(<LeagueManagement />);
    selectAL();

    fireEvent.change(screen.getByLabelText("Abbreviation"), {
      target: { value: "A.L." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(mockSaveLeagueFields).toHaveBeenCalledWith({
        id: "lg-al",
        abbreviation: "A.L.",
      }),
    );
  });

  it("clears a field by sending null rather than an empty string", async () => {
    render(<LeagueManagement />);
    selectAL();

    fireEvent.change(screen.getByLabelText("Abbreviation"), {
      target: { value: "  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(mockSaveLeagueFields).toHaveBeenCalledWith({
        id: "lg-al",
        abbreviation: null,
      }),
    );
  });

  it("splits and trims the alias list, and shows it back as chips", async () => {
    render(<LeagueManagement />);
    selectAL();

    fireEvent.change(screen.getByLabelText("Aliases"), {
      target: { value: " Amer. League ,A.L., " },
    });

    // The chips are the check: a comma string is how a list is TYPED, and this
    // is how it is read back before it is committed. The trailing comma every
    // half-typed list ends in must not become an empty alias.
    const chips = within(screen.getByRole("list", { name: "Current aliases" }))
      .getAllByRole("listitem")
      .map((li) => li.textContent);
    expect(chips).toEqual(["Amer. League", "A.L."]);

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(mockSaveLeagueFields).toHaveBeenCalledWith({
        id: "lg-al",
        aliases: ["Amer. League", "A.L."],
      }),
    );
  });

  it("sends the era as one object, and clears it as null", async () => {
    render(<LeagueManagement />);
    selectAL();

    fireEvent.change(screen.getByLabelText("Active to"), {
      target: { value: "1960" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(mockSaveLeagueFields).toHaveBeenCalledWith({
        id: "lg-al",
        yearsActive: { from: 1901, to: 1960 },
      }),
    );

    fireEvent.change(screen.getByLabelText("Active from"), {
      target: { value: "" },
    });
    fireEvent.change(screen.getByLabelText("Active to"), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(mockSaveLeagueFields).toHaveBeenLastCalledWith({
        id: "lg-al",
        yearsActive: null,
      }),
    );
  });

  it("refuses an era that ends before it starts, and says why", () => {
    render(<LeagueManagement />);
    selectAL();

    fireEvent.change(screen.getByLabelText("Active to"), {
      target: { value: "1800" },
    });

    expect(
      screen.getByText("An end year cannot come before the start year."),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Save" }).hasAttribute("disabled"),
    ).toBe(true);
  });

  it("refuses a Wikidata id that is not one, and says what one looks like", () => {
    render(<LeagueManagement />);
    selectAL();

    fireEvent.change(screen.getByLabelText("Wikidata id"), {
      target: { value: "not-a-qid" },
    });
    expect(screen.getByText("A Wikidata id looks like Q12345.")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Save" }).hasAttribute("disabled"),
    ).toBe(true);
  });

  it("offers to open the existing league when the name is taken", async () => {
    mockSaveLeagueFields.mockRejectedValue(new ConvexError("NAME_TAKEN:lg-pcl"));
    render(<LeagueManagement />);
    selectAL();

    fireEvent.change(screen.getByLabelText("League name"), {
      target: { value: "Pacific Coast League" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("That name already exists")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Open the existing league" }),
    );
    expect(
      screen.getByRole("heading", { level: 3, name: "Pacific Coast League" }),
    ).toBeTruthy();
  });

  it("links every team in the league into Team Management", () => {
    render(<LeagueManagement />);
    selectAL();

    const links = within(
      screen.getByRole("list", { name: "Teams in this league" }),
    ).getAllByRole("link");
    expect(links.map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["New York Yankees", "/admin/teams?team=t-yankees"],
      ["Seattle Mariners", "/admin/teams?team=t-mariners"],
    ]);
    expect(links[0].getAttribute("title")).toBe(
      "Open New York Yankees in Team Management",
    );

    // The Yankees' navy is 1.1:1 on the chip surface, so the chip takes the
    // white it prints that navy on; the Mariners' teal clears the floor and is
    // used as-is. The team name reads the same either way — colour carries no
    // meaning on its own.
    expect((links[0] as HTMLElement).style.color).toBe("#ffffff");
    expect((links[1] as HTMLElement).style.color).toBe("#5fd3bc");

    // And the way out of a roster this panel cannot edit.
    expect(
      screen
        .getByRole("link", { name: "Manage in Team Management" })
        .getAttribute("href"),
    ).toBe("/admin/teams?league=lg-al");
  });

  it("says a league has no teams rather than showing an empty list", () => {
    teamsIn = [];
    render(<LeagueManagement />);
    selectAL();
    expect(screen.getByText("No teams yet.")).toBeTruthy();
    expect(
      screen.queryByRole("list", { name: "Teams in this league" }),
    ).toBeNull();
  });

  it("links to Wikidata safely, and says the link leaves the page", () => {
    render(<LeagueManagement />);
    selectAL();

    const link = screen.getByRole("link", {
      name: "Wikidata Q1194951 (opens in new tab)",
    });
    expect(link.getAttribute("href")).toBe(
      "https://www.wikidata.org/wiki/Q1194951",
    );
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("shows a malformed stored Wikidata id as text, never as a link", () => {
    // A stored `externalIds.wikidataId` is not necessarily operator-typed at
    // the moment it renders: it can come from the SPARQL adapter, or from a row
    // written before the field was validated. Interpolating it into an `href`
    // is how a `javascript:` URL reaches an anchor, and React warns and renders
    // it anyway. `wikidataUrl` returning null is the guard.
    management = { leagues: [BAD_QID_LEAGUE], totalCount: 1, truncated: false };
    render(<LeagueManagement />);
    fireEvent.click(screen.getByRole("button", { name: /Dodgy League/ }));

    expect(screen.queryByRole("link", { name: /Wikidata/ })).toBeNull();
    expect(screen.getByText("Wikidata javascript:alert(1)")).toBeTruthy();
    for (const a of Array.from(document.querySelectorAll("a"))) {
      expect(a.getAttribute("href") ?? "").not.toContain("javascript:");
    }
  });

  it("queues a re-enrichment and says it is coming", async () => {
    render(<LeagueManagement />);
    selectAL();

    fireEvent.click(
      screen.getByRole("button", { name: "Re-enrich from Wikidata" }),
    );
    await waitFor(() => expect(mockEnrich).toHaveBeenCalledWith({ id: "lg-al" }));
    const said = await screen.findByText(
      "Enrichment queued — it lands in a moment.",
    );
    expect(said.getAttribute("role")).toBe("status");
    expectBelowTheActionRow(said);
  });

  it("confirms a save under the button that was pressed", async () => {
    render(<LeagueManagement />);
    selectAL();

    fireEvent.change(screen.getByLabelText("Abbreviation"), {
      target: { value: "A.L." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    const said = await screen.findByText("Saved American League.");
    expect(said.getAttribute("role")).toBe("status");
    expectBelowTheActionRow(said);
    // Exactly one live region says it — routing it to the panel must not also
    // leave a copy in the page-level line.
    expect(screen.getAllByText("Saved American League.")).toHaveLength(1);
  });

  it("reports a failed save where the operator can see the reason", async () => {
    // A plain Error, not a ConvexError: production redacts those, so the
    // fallback string is what a real operator would be reading.
    mockSaveLeagueFields.mockRejectedValue(new Error("boom"));
    render(<LeagueManagement />);
    selectAL();

    fireEvent.change(screen.getByLabelText("Abbreviation"), {
      target: { value: "A.L." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    const said = await screen.findByText("Could not save that league.");
    expect(said.getAttribute("role")).toBe("alert");
    expectBelowTheActionRow(said);
  });

  it("re-seeds the draft when a different league is opened", () => {
    render(<LeagueManagement />);
    selectAL();
    fireEvent.change(screen.getByLabelText("League name"), {
      target: { value: "edited but never saved" },
    });

    fireEvent.click(screen.getByRole("button", { name: /Pacific Coast/ }));
    expect(
      (screen.getByLabelText("League name") as HTMLInputElement).value,
    ).toBe("Pacific Coast League");
  });

  it("keeps a dirty draft when the row moves underneath it, and reloads on request", () => {
    // `createByAdmin` schedules enrichment, so the row can grow an
    // abbreviation and a level seconds after it is added. Nothing the operator
    // typed may be overwritten by that.
    const { rerender } = render(<LeagueManagement />);
    fireEvent.click(screen.getByRole("button", { name: /National Hockey/ }));
    fireEvent.change(screen.getByLabelText("League name"), {
      target: { value: "NHL (edited)" },
    });

    LEAGUES_BY_ID["lg-nhl"] = { ...NHL, level: "major", lastUpdated: 2 };
    rerender(<LeagueManagement />);

    expect(
      (screen.getByLabelText("League name") as HTMLInputElement).value,
    ).toBe("NHL (edited)");
    const notice = screen.getByText(
      "This league was updated elsewhere — Reload to see the latest.",
    );
    expect(notice.closest("[role='status']")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Reload league National Hockey League"));
    expect(
      (screen.getByLabelText("League name") as HTMLInputElement).value,
    ).toBe("National Hockey League");
    expect(
      within(screen.getByRole("group", { name: "Level" }))
        .getByRole("button", { name: "Major" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(screen.queryByText(/updated elsewhere/)).toBeNull();

    LEAGUES_BY_ID["lg-nhl"] = NHL;
  });
});

// ---------------------------------------------------------------------------

/**
 * `?league=<id>`, the other end of the team links.
 *
 * The panel links every team to `/admin/teams?team=<id>`. Back from there is
 * only useful if this screen's own history entry names the league that was
 * open, which is why selecting writes the param with `replace` rather than
 * pushing: the entry the operator leaves is the entry they come back to.
 *
 * The deep link is deliberately NOT resolved against the master list — the id
 * goes to `leagues.getByIdParam` instead, which takes the param as a raw STRING
 * and normalizes it server-side, so a hand-mangled `?league=` is an empty panel
 * rather than a rejected argument that throws the render away.
 */

// The URL is half of what is under test here, so it is rendered.
function LocationProbe() {
  return <span data-testid="search">{useLocation().search}</span>;
}

function renderAt(entry: string) {
  // A FRESH element each time, deliberately: handing `rerender` the identical
  // element object lets React bail out of the subtree entirely.
  const tree = () => (
    <MemoryRouter initialEntries={[entry]}>
      <LeagueManagement />
      <LocationProbe />
    </MemoryRouter>
  );
  const result = renderBare(tree());
  return { ...result, rerenderTree: () => result.rerender(tree()) };
}

const url = () => screen.getByTestId("search").textContent;
const listRow = (name: RegExp) => screen.getByRole("button", { name });

describe("LeagueManagement — the ?league deep link", () => {
  it("opens a league the master list has no row for", () => {
    // The case the id query exists for: the sport filter, or a filter left in
    // the box, can hide the linked row entirely. Resolving the param against
    // the visible rows would answer "no such league".
    management = { leagues: [PCL], totalCount: 1, truncated: false };
    renderAt("/admin/leagues?league=lg-al");

    expect(screen.getByLabelText("League name")).toHaveProperty(
      "value",
      "American League",
    );
    expect(document.querySelector('[aria-current="true"]')).toBeNull();
    expect(lastArgs("leagues.getByIdParam")).toEqual({ id: "lg-al" });
  });

  it("selects and scrolls to the row when the list does have one", () => {
    // The scroll matters as much as the selection: the master list is a 32rem
    // scroller, so a selected row can land off-screen and the link would look
    // like it did nothing.
    const scrollIntoView = vi
      .spyOn(Element.prototype, "scrollIntoView")
      .mockImplementation(() => {});

    renderAt("/admin/leagues?league=lg-pcl");

    expect(listRow(/Pacific Coast League/).getAttribute("aria-current")).toBe(
      "true",
    );
    expect(listRow(/American League/).getAttribute("aria-current")).toBeNull();
    expect(scrollIntoView).toHaveBeenCalled();

    scrollIntoView.mockRestore();
  });

  it("renders normally for a param that is not an id at all", () => {
    // Handed to `getByIdParam` as a raw string. A `v.id("leagues")` argument
    // would have made this a THROWN query, replacing the whole admin screen
    // with the app-level error boundary because somebody mangled a query
    // string. Asserted as "the page is still here", because the defect's
    // signature was the page not being here.
    renderAt("/admin/leagues?league=not-an-id");

    expect(lastArgs("leagues.getByIdParam")).toEqual({ id: "not-an-id" });
    expect(document.querySelector('[aria-current="true"]')).toBeNull();
    expect(
      screen.getByText(
        "Select a league to see its teams and edit what we know about it.",
      ),
    ).toBeTruthy();
    // The master list is untouched: this is a normal render, not a recovery.
    expect(listRow(/American League/)).toBeTruthy();
  });

  it("writes the param when a row is picked", () => {
    renderAt("/admin/leagues");
    expect(url()).toBe("");

    fireEvent.click(listRow(/American League/));

    expect(listRow(/American League/).getAttribute("aria-current")).toBe("true");
    expect(url()).toBe("?league=lg-al");
  });

  it("clears the filter once for the link, and never again", async () => {
    // Two halves of one rule. The link CLEARS what is in the box, because a
    // filter left over from the last visit can hide the row it just selected.
    // A click does NOT, because the param a click writes is the operator's own
    // selection.
    //
    // The second half is the one that actually bites. React Router commits
    // location updates in a transition, so the render in which a click's new
    // selection lands is a render where the URL still names the PREVIOUS
    // league — indistinguishable, to a screen that remembers only the last id
    // it followed, from a fresh link back to it.
    management = undefined;
    const { rerenderTree } = renderAt("/admin/leagues?league=lg-al");

    fireEvent.change(screen.getByLabelText("Filter leagues"), {
      target: { value: "Dodgy" },
    });
    expect(screen.getByLabelText("Filter leagues")).toHaveProperty(
      "value",
      "Dodgy",
    );

    // The list arrives; the link is followed now, and takes the box with it.
    management = { leagues: [AL, PCL, NHL], totalCount: 3, truncated: false };
    rerenderTree();

    expect(screen.getByLabelText("Filter leagues")).toHaveProperty("value", "");
    expect(listRow(/American League/).getAttribute("aria-current")).toBe("true");

    fireEvent.change(screen.getByLabelText("Filter leagues"), {
      target: { value: "l" },
    });
    fireEvent.click(listRow(/Pacific Coast League/));

    expect(url()).toBe("?league=lg-pcl");
    expect(screen.getByLabelText("Filter leagues")).toHaveProperty("value", "l");
    expect(listRow(/Pacific Coast League/).getAttribute("aria-current")).toBe(
      "true",
    );
  });

  it("writes the param for a league it has just created", async () => {
    const { container } = renderAt("/admin/leagues");
    openAddForm(container);
    fireEvent.change(screen.getByLabelText("New league name"), {
      target: { value: "American League" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Create league American League" }),
    );

    // TWO COMMITS, not one, and only the second carries the URL.
    //
    // `Added {name}.` is a plain setState in the mutation's continuation, so it
    // lands in an urgent render. `selectLeague`'s `setSearchParams` is applied
    // inside React Router's `startTransition` and commits separately — and both
    // continuations run after `await createByAdmin(...)`, i.e. outside `act`, so
    // nothing forces them into one commit. `waitFor` on the text therefore
    // returns as soon as the urgent commit lands, and sampling `useLocation` on
    // the next line reads the location as it was BEFORE the transition flushed.
    //
    // The ORDER of the two commits is not what is under test — that the param
    // is written at all is — so the wait moves onto the URL itself. This only
    // failed in the full `--project components` run: a cold module cache made
    // the urgent commit slow enough that the transition had already flushed by
    // the first `waitFor` poll, and a warmed one does not.
    await screen.findByText("Added American League.");
    await waitFor(() => expect(url()).toBe("?league=lg-al"));
  });
});
