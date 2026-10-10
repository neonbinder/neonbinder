/**
 * NEO-235 — the deep link into `/admin/teams`.
 *
 * The Players screen links every career stint at a team to that team's row
 * here, so this file covers the two halves of that contract and nothing else:
 * arriving with `?team=<id>` opens that team, and picking a different one
 * writes the URL back so the screen the operator is looking at is the screen
 * they can send someone.
 *
 * Both are silent when they break — a link that lands on an unselected list
 * still renders a perfectly correct screen, and a selection that never reaches
 * the URL only shows up when a shared link opens the wrong thing.
 *
 * The `?team` tests end on where those two halves MEET: a click writes the
 * param, so the screen has to be able to tell a param it wrote itself from a
 * link it was sent. Getting that wrong wipes the operator's filter mid-click.
 *
 * NEO-240 adds the second half of that contract — `?league=<id>`, the link
 * League Management sends here — plus the three things this screen now owes
 * leagues: a way through to where they are edited, an order that puts the
 * likely league first, and a way to create one without losing the team draft.
 *
 * That last one was inline fields under the dropdown, captioned "Created for
 * this team's sport when you save.", until the owner's review of PR #228 called
 * it confusing. It is a modal now, and the tests below moved with it: the point
 * of interest is no longer "what does Save send" (Save sends nothing about a
 * league any more) but "what does the SELECT do" — because a dropdown whose
 * value silently becomes a sentinel, or fails to come back from one, is the
 * failure nobody sees until a team is saved into the wrong league.
 *
 * NEO-236 splits a team's name in two — `name` is the nickname ("Yankees") and
 * `location` is the place ("New York") — so this file also covers what that
 * split owes each half of the screen: the master row prints the short name and
 * carries the full one as its accessible name, the detail panel composes and
 * previews it, and a name that collides with another team's is refused where
 * the operator can fix it.
 *
 * Mocking mirrors PlayerManagement.test.tsx: convex/react's hooks are module
 * mocked and routed by the (string-mocked) function reference.
 */

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ConvexError } from "convex/values";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks — declared before the component import
// ---------------------------------------------------------------------------

vi.mock("../../convex/_generated/api", () => ({
  api: {
    teams: {
      listForManagement: "teams.listForManagement",
      // NEO-330 — the typed filter's server answer, and the open team read by
      // id (a `?team=` link, a search result, or the NAME_TAKEN alert's row).
      searchForManagement: "teams.searchForManagement",
      getByIdParam: "teams.getByIdParam",
      saveTeamFields: "teams.saveTeamFields",
      enrichFromWikidata: "teams.enrichFromWikidata",
      // NEO-284 — "who else in this sport already answers to one of these
      // names", queried live off the draft alias box.
      aliasesInUse: "teams.aliasesInUse",
    },
    leagues: {
      list: "leagues.list",
      // The dialog's form uses the ADMIN create — the one that answers whether
      // it really created anything, and that `nearMatches` guards. The inline
      // fields used `leagues.create`, a bare find-or-create with no duplicate
      // guard at all, which is how two spellings of one league got here.
      createByAdmin: "leagues.createByAdmin",
      nearMatches: "leagues.nearMatches",
    },
    // NEO-254 — the Franchise field on the panel reads the list and creates
    // through find-or-create, the same two calls the Franchise screen makes.
    franchises: {
      list: "franchises.list",
      findOrCreate: "franchises.findOrCreate",
    },
    selectorOptions: { getSelectorOptions: "selectorOptions.getSelectorOptions" },
    teamColorSources: { chooseColorSource: "teamColorSources.chooseColorSource" },
  },
}));

/**
 * NEO-284 — who else in this sport already answers to one of the draft's
 * aliases. `undefined` unless a test sets it; the panel treats that (and an
 * empty array) the same, rendering nothing.
 */
let sharedAliases: unknown;

/**
 * NEO-330 — what `teams.searchForManagement` answers. `undefined` (still
 * loading) unless a test sets it, which is the state every pre-NEO-330 test
 * runs in: the screen filters the loaded window until the server answers.
 */
let searchAnswer: unknown;
/** Every argument set `teams.searchForManagement` was subscribed with. */
let searchCalls: unknown[];

const SPORTS = [
  { _id: "sport-baseball", _creationTime: 0, level: "sport", value: "Baseball" },
];

/**
 * NEO-254 — one franchise thread, so the panel's dropdown has something real to
 * offer and the "already on a thread" branch has a value to render.
 */
const FRANCHISES = [
  {
    _id: "f-giants",
    _creationTime: 0,
    name: "Giants",
    nameNormalized: "giants",
    sportId: "sport-baseball",
    lastUpdated: 0,
    teamCount: 2,
  },
];

/**
 * NEO-236 shapes: `name` is the nickname alone and `location` is the place.
 * `nameNormalized` still keys the WHOLE name — `normalizeTeamName` token-sorts,
 * so splitting a row cannot change its dedup key, and these fixtures say so.
 *
 * `t-aztecs` carries NO location, which is not an edge case: colleges, national
 * sides and corporate-named clubs legitimately have none, and for them full ==
 * short. Every branch of the row and the preview has a team here.
 */
/**
 * NEO-254 — the teams the mocked query answers with. Mutable so the two-eras
 * case can hand back a pair of same-name rows without every other test paying
 * for them.
 */
let currentTeams: Array<Record<string, unknown>>;
/**
 * NEO-330 — teams the deployment HAS but `listForManagement`'s capped window
 * does not return: reachable only by `getByIdParam` and the server search.
 */
let offWindowTeams: Array<Record<string, unknown>>;
/** NEO-330 — `listForManagement`'s `truncated` flag. */
let listTruncated: boolean;

const TEAMS = [
  {
    _id: "t-yankees",
    _creationTime: 0,
    name: "Yankees",
    location: "New York",
    nameNormalized: "new york yankees",
    sportId: "sport-baseball",
    leagueId: "l-mlb",
    colors: { primary: "#0c2340" },
  },
  {
    _id: "t-mariners",
    _creationTime: 0,
    name: "Mariners",
    location: "Seattle",
    nameNormalized: "mariners seattle",
    sportId: "sport-baseball",
    // NEO-254: a DATED row, so the era's effect on the row and on the row's
    // accessible name is exercised by the fixtures every other test uses.
    yearsActive: { from: 1977 },
    colors: { primary: "#0c2c56" },
  },
  {
    _id: "t-aztecs",
    _creationTime: 0,
    name: "San Diego State Aztecs",
    nameNormalized: "aztecs diego san state",
    sportId: "sport-baseball",
  },
  // The pair the whole split exists for: one nickname, two franchises. They are
  // told apart only by the location, and they have to sort next to each other.
  {
    _id: "t-sf-giants",
    _creationTime: 0,
    name: "Giants",
    location: "San Francisco",
    nameNormalized: "francisco giants san",
    sportId: "sport-baseball",
  },
  {
    _id: "t-ny-giants",
    _creationTime: 0,
    name: "Giants",
    location: "New York",
    nameNormalized: "giants new york",
    sportId: "sport-baseball",
  },
];

/**
 * Deliberately adversarial to an alphabetical sort: by name these read
 * Atlantic, International, Major, Nippon — the exact reverse of the answer in
 * two places — so a test that passes here cannot be passing on `localeCompare`
 * alone. `l-atlantic` carries no level at all, which is the pre-NEO-240 row.
 *
 * `leagues.list` already sorts by name server-side, so this is the order the
 * screen receives and has to re-order.
 */
const LEAGUES = [
  {
    _id: "l-atlantic",
    _creationTime: 0,
    name: "Atlantic League",
    abbreviation: "ATL",
    nameNormalized: "atlantic league",
    sportId: "sport-baseball",
    lastUpdated: 0,
  },
  {
    _id: "l-international",
    _creationTime: 0,
    name: "International League",
    abbreviation: "IL",
    nameNormalized: "international league",
    sportId: "sport-baseball",
    level: "minor",
    lastUpdated: 0,
  },
  {
    _id: "l-mlb",
    _creationTime: 0,
    name: "Major League Baseball",
    abbreviation: "MLB",
    nameNormalized: "major league baseball",
    sportId: "sport-baseball",
    level: "major",
    lastUpdated: 0,
  },
  {
    _id: "l-npb",
    _creationTime: 0,
    name: "Nippon Professional Baseball",
    abbreviation: "NPB",
    nameNormalized: "nippon professional baseball",
    sportId: "sport-baseball",
    level: "international",
    lastUpdated: 0,
  },
];

const mockCreateByAdmin = vi.fn();
const mockSaveTeamFields = vi.fn();
const mockFindOrCreateFranchise = vi.fn();

/** Near matches the dialog's form should offer. Set per test. */
let nearMatches: unknown;
/**
 * The franchise list the mocked query returns. Mutable so the cap/filter case
 * can hand back more than `FRANCHISE_PILL_CAP` rows without every other test
 * paying for a 30-pill render. Reset in `beforeEach`.
 */
let franchiseRows: Array<Record<string, unknown>> = FRANCHISES;

vi.mock("convex/react", () => ({
  useQuery: (ref: string, args: unknown) => {
    if (args === "skip") return undefined;
    if (ref === "teams.listForManagement") {
      return { teams: currentTeams, truncated: listTruncated };
    }
    if (ref === "teams.searchForManagement") {
      searchCalls.push(args);
      return searchAnswer;
    }
    if (ref === "teams.getByIdParam") {
      const id = (args as { id: string }).id;
      return (
        [...currentTeams, ...offWindowTeams].find((t) => t._id === id) ?? null
      );
    }
    if (ref === "leagues.list") return LEAGUES;
    if (ref === "franchises.list") {
      return { franchises: franchiseRows, truncated: false };
    }
    if (ref === "selectorOptions.getSelectorOptions") return SPORTS;
    if (ref === "leagues.nearMatches") return nearMatches;
    if (ref === "teams.aliasesInUse") return sharedAliases;
    return undefined;
  },
  useMutation: (ref: string) => {
    if (ref === "leagues.createByAdmin") return mockCreateByAdmin;
    if (ref === "teams.saveTeamFields") return mockSaveTeamFields;
    if (ref === "franchises.findOrCreate") return mockFindOrCreateFranchise;
    return vi.fn();
  },
  useAction: () => vi.fn(),
}));

import TeamManagement, {
  resolveSelectedTeam,
  teamCounterAnnouncement,
  teamCounterSentence,
} from "./TeamManagement";

// The URL is the thing under test in half of these, so it is rendered.
function LocationProbe() {
  return <span data-testid="search">{useLocation().search}</span>;
}

function renderAt(entry: string) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <TeamManagement />
      <LocationProbe />
    </MemoryRouter>,
  );
}

const row = (name: string) => screen.getByRole("button", { name: new RegExp(name) });

/**
 * NEO-330 — the VISIBLE counter. The sr-only status line can say the very same
 * sentence ("5 teams"), so the counter is the one counter-shaped line that is
 * not the status region.
 */
const counter = () => {
  const lines = screen
    .getAllByText(/^[\d,]+\+? (teams?|match(es)?)( · [\d,]+ need attention)?$/)
    .filter((el) => !el.classList.contains("sr-only"));
  expect(lines).toHaveLength(1);
  return lines[0];
};

/** A select by id — "League" labels two of them, so a label lookup is ambiguous. */
const select = (id: string) =>
  document.getElementById(id) as HTMLSelectElement | null;

const optionLabels = (id: string) =>
  Array.from(select(id)?.options ?? []).map((option) => option.textContent);

beforeEach(() => {
  nearMatches = undefined;
  mockCreateByAdmin
    .mockReset()
    .mockResolvedValue({ id: "l-new", created: true });
  mockSaveTeamFields.mockReset().mockResolvedValue(null);
  mockFindOrCreateFranchise
    .mockReset()
    .mockResolvedValue({ id: "f-new", created: true });
  franchiseRows = FRANCHISES;
  currentTeams = TEAMS;
  offWindowTeams = [];
  listTruncated = false;
  sharedAliases = undefined;
  searchAnswer = undefined;
  searchCalls = [];
});

/**
 * NEO-254 — the save confirmation, WHERE the operator can see it.
 *
 * This block exists because CI caught what the unit tests did not. Two flows
 * that had been green for months —
 * `admin/team-management-edit-a-team.yaml` and
 * `spine-label/player-team-colors-default-to-longest-tenure.yaml` — began
 * failing on `".*Saved <name>.*" is visible` the moment the Franchise field
 * landed. Nothing about saving had changed. What changed was the HEIGHT of the
 * panel above the Save button: both flows scroll Save into view, tap it, and
 * assert the confirmation, and the confirmation used to render at the very top
 * of the screen. With the page pinned at its new maximum scroll, the line was
 * rendered correctly and simply off-screen.
 *
 * `saveError` had already been moved into the panel for exactly this reason
 * (its comment says the top of the page "is off-screen at the moment Save is
 * pressed"); the success line had the same defect and nothing had tripped over
 * it yet. So these tests assert not just that the text appears, but WHERE —
 * inside the detail panel, after the Save button — because "it renders" was
 * always true and is not the property that broke.
 */
describe("TeamManagement — saving a team confirms in the panel", () => {
  const panel = () =>
    screen.getByRole("button", { name: "Save" }).closest("div.rounded-lg")!;

  it("mirrors the E2E flow: edit the name, Save, read the confirmation", async () => {
    renderAt("/admin/teams?team=t-mariners");
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Pilots" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    // The composed full name, which is what the flow's regex matches on.
    expect(await screen.findByText("Saved Seattle Pilots.")).toBeTruthy();
  });

  it("renders the confirmation in the Save button's own row, not at the top of the page", () => {
    // The regression itself, and the SAME ROW is the load-bearing half of it.
    // The two flows scroll Save to the bottom of a page already at maximum
    // scroll, so a line appended below the button would be under the fold for
    // exactly the reason the screen-level one was. Sharing the row the button
    // is in costs no height at all.
    renderAt("/admin/teams?team=t-mariners");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    return waitFor(() => {
      const line = screen.getByText("Saved Seattle Mariners.");
      expect(panel().contains(line)).toBe(true);
      expect(
        screen.getByRole("button", { name: "Save" }).parentElement,
      ).toBe(line.parentElement);
      // Announced, because it lands after a round trip a screen-reader user
      // has no other way to know finished.
      expect(line.getAttribute("role")).toBe("status");
    });
  });

  it("clears the confirmation when a different team is selected", async () => {
    renderAt("/admin/teams?team=t-mariners");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Saved Seattle Mariners.");

    fireEvent.click(row("New York Yankees"));
    expect(screen.queryByText("Saved Seattle Mariners.")).toBeNull();
  });

  it("shows a refusal in the panel instead, and no confirmation", async () => {
    mockSaveTeamFields.mockRejectedValue(
      new ConvexError("Another team in this sport is already called X."),
    );
    renderAt("/admin/teams?team=t-mariners");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    const error = await screen.findByText(
      "Another team in this sport is already called X.",
    );
    expect(panel().contains(error)).toBe(true);
    expect(screen.queryByText(/^Saved /)).toBeNull();
  });
});

describe("TeamManagement — team aliases (NEO-284)", () => {
  /** The "also known as" textarea. */
  const box = () =>
    screen.getByLabelText("Also known as") as HTMLTextAreaElement;
  const chips = () =>
    Array.from(
      screen.getByRole("list", { name: "Current aliases" }).children,
    ).map((li) => li.textContent);

  it("round-trips: a team seeded with aliases renders them, editing and saving sends the new list", async () => {
    currentTeams = [
      { ...TEAMS[0], aliases: ["Bronx Bombers"] }, // t-yankees
      ...TEAMS.slice(1),
    ];
    renderAt("/admin/teams?team=t-yankees");

    expect(box().value).toBe("Bronx Bombers");
    expect(chips()).toEqual(["Bronx Bombers"]);

    fireEvent.change(box(), {
      target: { value: "Bronx Bombers, Yanks" },
    });
    expect(chips()).toEqual(["Bronx Bombers", "Yanks"]);

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mockSaveTeamFields).toHaveBeenCalled());
    expect(mockSaveTeamFields.mock.calls[0][0]).toMatchObject({
      id: "t-yankees",
      aliases: ["Bronx Bombers", "Yanks"],
    });
  });

  it("renders one chip per alias", () => {
    currentTeams = [
      { ...TEAMS[0], aliases: ["Bronx Bombers", "Yanks", "NYY"] },
      ...TEAMS.slice(1),
    ];
    renderAt("/admin/teams?team=t-yankees");

    expect(chips()).toEqual(["Bronx Bombers", "Yanks", "NYY"]);
  });

  it("does NOT send `aliases` when the draft is unchanged from what is stored", async () => {
    // TeamManagement.tsx's `save()`: `...(aliasesChanged ? { aliases: draftAliases } : {})`
    // — the field is only added to the payload when the parsed draft differs
    // from `team.aliases ?? []`. Editing the Name field alone (no alias edit)
    // must not resend an unchanged alias list.
    currentTeams = [
      { ...TEAMS[0], aliases: ["Bronx Bombers"] },
      ...TEAMS.slice(1),
    ];
    renderAt("/admin/teams?team=t-yankees");

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Yankees" }, // same value, but exercises the field
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mockSaveTeamFields).toHaveBeenCalled());
    expect(mockSaveTeamFields.mock.calls[0][0]).not.toHaveProperty("aliases");
  });

  it("DOES send `aliases` once the draft differs from the stored list", async () => {
    currentTeams = [{ ...TEAMS[0], aliases: [] }, ...TEAMS.slice(1)];
    renderAt("/admin/teams?team=t-yankees");

    fireEvent.change(box(), { target: { value: "Bronx Bombers" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mockSaveTeamFields).toHaveBeenCalled());
    expect(mockSaveTeamFields.mock.calls[0][0]).toMatchObject({
      aliases: ["Bronx Bombers"],
    });
  });

  /**
   * The "also answers to" note. Two nodes, deliberately (a11y audit, mirroring
   * League Management's counter): the VISIBLE sentence follows the query
   * synchronously, and the ANNOUNCED copy is an always-mounted `role="status"`
   * region one debounce behind — so a screen reader hears one settled
   * sentence, never one per keystroke.
   */
  describe("the shared-alias note", () => {
    // Scoped to the detail panel: NEO-330 gave the screen's counter a status
    // region of its own, outside the panel.
    const panel = () =>
      screen.getByRole("button", { name: "Save" }).closest("div.rounded-lg")! as HTMLElement;
    const status = () =>
      within(panel()).getByRole("status", { name: "" }) as HTMLElement;
    const hit = (alias: string, name: string) => ({ alias, name });
    const sentence = (name: string, alias: string) =>
      `${name} also answers to “${alias}”. Cards will ask which one when the years don't decide.`;

    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("the live region is mounted from the first render, empty, and the visible note is not itself a live region", () => {
      renderAt("/admin/teams?team=t-yankees");
      // Exactly one status region in the panel, present before any note.
      const regions = within(panel()).getAllByRole("status");
      expect(regions).toHaveLength(1);
      expect(regions[0].textContent).toBe("");

      sharedAliases = [hit("Miami", "Miami RedHawks")];
      fireEvent.change(box(), { target: { value: "Miami" } });

      const visible = screen.getByText(sentence("Miami RedHawks", "Miami"));
      expect(visible.getAttribute("role")).toBeNull();
      expect(visible.getAttribute("aria-live")).toBeNull();
      // Synchronous for the eyes, silent for the ear until it settles.
      expect(within(panel()).getAllByRole("status")).toHaveLength(1);
      expect(status().textContent).toBe("");
    });

    it("announces ONCE, after the note holds still — not once per keystroke", () => {
      renderAt("/admin/teams?team=t-yankees");

      // Three keystrokes, each landing a different query answer, inside one
      // debounce window.
      sharedAliases = [hit("M", "Miami RedHawks")];
      fireEvent.change(box(), { target: { value: "M" } });
      act(() => vi.advanceTimersByTime(150));
      sharedAliases = [hit("Mi", "Miami RedHawks")];
      fireEvent.change(box(), { target: { value: "Mi" } });
      act(() => vi.advanceTimersByTime(150));
      sharedAliases = [hit("Miami", "Miami RedHawks")];
      fireEvent.change(box(), { target: { value: "Miami" } });
      act(() => vi.advanceTimersByTime(150));

      // 450ms of typing, none of it announced.
      expect(status().textContent).toBe("");

      act(() => vi.advanceTimersByTime(400));
      expect(status().textContent).toBe(sentence("Miami RedHawks", "Miami"));
      // The intermediate sentences never reached the region.
      expect(status().textContent).not.toContain("“M”");
      expect(status().textContent).not.toContain("“Mi”");
    });
  });
});

describe("TeamManagement — the Franchise field", () => {
  /** The combobox, found by the accessible name flows use. */
  const field = () =>
    screen.getByRole("combobox", { name: "Franchise" }) as HTMLInputElement;
  const open = () => fireEvent.focus(field());
  const type = (text: string) => {
    open();
    fireEvent.change(field(), { target: { value: text } });
  };
  /** The Franchise field's own list — scoped, because the panel's two league
   *  <select>s carry `option`s of their own. */
  const franchiseOptions = () => {
    const list = screen.queryByRole("listbox", { name: "Franchise suggestions" });
    return list ? within(list).queryAllByRole("option") : [];
  };
  /** Option text as a Maestro `text:` selector matches it: direct text only. */
  const optionLabels = () =>
    franchiseOptions()
      .map((o) =>
        Array.from(o.childNodes)
          .filter((n) => n.nodeType === Node.TEXT_NODE)
          .map((n) => n.textContent)
          .join(""),
      );
  const pick = (label: string) => {
    open();
    fireEvent.mouseDown(
      within(screen.getByRole("listbox", { name: "Franchise suggestions" })).getByRole(
        "option",
        { name: label },
      ),
    );
  };
  const currentOption = () =>
    franchiseOptions()
      .find((o) => o.querySelector('[aria-hidden="true"]')?.textContent === "✓");

  it("is a combobox named 'Franchise' — no radiogroup, no select, no start box", () => {
    renderAt("/admin/teams?team=t-sf-giants");
    expect(field().tagName).toBe("INPUT");
    const wrapper = document.getElementById("team-franchise")!;
    expect(wrapper.contains(field())).toBe(true);
    // The id is on the wrapper, never the input, so "Franchise" stays the
    // input's Maestro resource-id.
    expect(field().id).toBe("");
    expect(wrapper.querySelector('[role="radiogroup"], [role="radio"], select')).toBeNull();
    expect(
      screen.queryByRole("button", { name: "+ Start a new franchise…" }),
    ).toBeNull();
    expect(screen.queryByLabelText("New franchise name")).toBeNull();
    expect(screen.queryByLabelText("Filter franchises")).toBeNull();
    // The visible caption matches the accessible name (SC 2.5.3).
    expect(wrapper.textContent).toContain("Franchise");
  });

  it("shows 'No franchise' at rest for a team on no thread, and opens on every franchise plus none", () => {
    renderAt("/admin/teams?team=t-sf-giants");
    expect(field().value).toBe("No franchise");
    expect(screen.queryByRole("listbox")).toBeNull();

    open();
    expect(optionLabels()).toEqual(["Giants", "No franchise"]);
    // The current answer is marked and highlighted, so Enter re-confirms it.
    expect(currentOption()?.textContent).toContain("No franchise");
    expect(
      franchiseOptions()
        .find((o) => o.textContent?.endsWith("No franchise"))
        ?.getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("shows the team's own thread at rest", () => {
    currentTeams = TEAMS.map((t) =>
      t._id === "t-sf-giants" ? { ...t, franchiseId: "f-giants" } : t,
    );
    renderAt("/admin/teams?team=t-sf-giants");
    expect(field().value).toBe("Giants");
  });

  it("sends the picked franchise on save", async () => {
    renderAt("/admin/teams?team=t-sf-giants");
    pick("Giants");
    expect(field().value).toBe("Giants");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mockSaveTeamFields).toHaveBeenCalled());
    expect(mockSaveTeamFields.mock.calls[0][0]).toMatchObject({
      id: "t-sf-giants",
      franchiseId: "f-giants",
    });
  });

  it("sends null when the team is taken off its thread", async () => {
    // `null` is the clear, and it is the same value the franchise view's
    // "Remove" sends. Omitting the field would leave the link in place.
    renderAt("/admin/teams?team=t-sf-giants");
    pick("Giants");
    pick("No franchise");
    expect(field().value).toBe("No franchise");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mockSaveTeamFields).toHaveBeenCalled());
    expect(mockSaveTeamFields.mock.calls[0][0]).toMatchObject({
      franchiseId: null,
    });
  });

  it("narrows on the name as it is typed, raw or normalized, and never changes the answer by typing", () => {
    franchiseRows = [
      ...FRANCHISES,
      {
        _id: "f-titans",
        _creationTime: 0,
        name: "Titans / Oilers",
        nameNormalized: "titans oilers",
        sportId: "sport-baseball",
        lastUpdated: 0,
        teamCount: 0,
      },
    ];
    renderAt("/admin/teams?team=t-sf-giants");
    type("GIA");
    expect(optionLabels()).toEqual(["Giants", "No franchise"]);
    type("titans oilers");
    expect(optionLabels()).toEqual(["Titans / Oilers", "No franchise"]);

    // Walking away puts the answer's label back; nothing was picked.
    fireEvent.blur(field());
    expect(field().value).toBe("No franchise");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    return waitFor(() =>
      expect(mockSaveTeamFields.mock.calls[0][0]).toMatchObject({ franchiseId: null }),
    );
  });

  it("keeps a franchise listed on the keystroke after a run of initials (NEO-322)", () => {
    // "N. C. S" joins to "ncs", the substring of nothing in "nc state"; without
    // the typeahead reading "nc s" the list empties and offers to start a
    // duplicate thread.
    franchiseRows = [
      ...FRANCHISES,
      {
        _id: "f-nc-state",
        _creationTime: 0,
        name: "NC State",
        nameNormalized: "nc state",
        sportId: "sport-baseball",
        lastUpdated: 0,
        teamCount: 0,
      },
    ];
    renderAt("/admin/teams?team=t-sf-giants");
    type("N. C.");
    expect(optionLabels()).toEqual(["NC State", "No franchise"]);
    type("N. C. S");
    expect(optionLabels()).toEqual(["NC State", "No franchise"]);
    type("N. C. State");
    expect(optionLabels()).toEqual(["NC State", "No franchise"]);
  });

  it("puts the answer back on Escape", () => {
    renderAt("/admin/teams?team=t-sf-giants");
    pick("Giants");
    type("zz");
    fireEvent.keyDown(field(), { key: "Escape" });
    expect(field().value).toBe("Giants");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("walks and picks with the keyboard", () => {
    renderAt("/admin/teams?team=t-sf-giants");
    open();
    // Opens on the current answer ("No franchise", last); Up reaches Giants.
    fireEvent.keyDown(field(), { key: "ArrowUp" });
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(field().value).toBe("Giants");
  });

  it("offers Start “<typed>” only when the text matches no franchise", () => {
    renderAt("/admin/teams?team=t-sf-giants");
    // A partial match: the thread is probably already here.
    type("gi");
    expect(optionLabels()).toEqual(["Giants", "No franchise"]);
    // An exact match.
    type("giants");
    expect(optionLabels()).toEqual(["Giants", "No franchise"]);
    // "No franchise" is an answer, not a thread to start.
    type("no franchise");
    expect(optionLabels()).toEqual(["No franchise"]);
    // Nothing matches: first, so Enter starts it.
    type("  Titans ");
    expect(optionLabels()).toEqual(["Start “Titans”", "No franchise"]);
  });

  it("starts a franchise from the field and selects it without saving the team", async () => {
    renderAt("/admin/teams?team=t-sf-giants");
    type("Titans");
    fireEvent.mouseDown(screen.getByRole("option", { name: "Start “Titans”" }));

    await waitFor(() =>
      expect(mockFindOrCreateFranchise).toHaveBeenCalledWith({
        name: "Titans",
        sportId: "sport-baseball",
      }),
    );
    // Creating a thread and putting this team on it are two decisions.
    expect(mockSaveTeamFields).not.toHaveBeenCalled();
    // The new row is the answer immediately, rather than the field reading
    // blank until `franchises.list` catches up.
    await waitFor(() => expect(field().value).toBe("Titans"));

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(mockSaveTeamFields.mock.calls[0][0]).toMatchObject({ franchiseId: "f-new" }),
    );
  });

  it("starts one with Enter when the text matches nothing", async () => {
    renderAt("/admin/teams?team=t-sf-giants");
    type("Titans");
    fireEvent.keyDown(field(), { key: "Enter" });
    await waitFor(() =>
      expect(mockFindOrCreateFranchise).toHaveBeenCalledWith({
        name: "Titans",
        sportId: "sport-baseball",
      }),
    );
  });

  /**
   * NEO-260 — the franchise message reports into the Save row, not the top of
   * the page: it is an instruction to press Save.
   */
  it("says a new franchise was started in the Save button's own row", async () => {
    renderAt("/admin/teams?team=t-sf-giants");
    type("Titans");
    fireEvent.mouseDown(screen.getByRole("option", { name: "Start “Titans”" }));

    const line = await screen.findByText(
      "Started the Titans franchise. Save the team to put it on there.",
    );
    expect(screen.getByRole("button", { name: "Save" }).parentElement).toBe(
      line.parentElement,
    );
    expect(line.getAttribute("role")).toBe("status");
  });

  it("says so when the typed thread already existed under another spelling", async () => {
    mockFindOrCreateFranchise.mockResolvedValue({ id: "f-giants", created: false });
    renderAt("/admin/teams?team=t-sf-giants");
    type("SF Giants");
    fireEvent.mouseDown(screen.getByRole("option", { name: "Start “SF Giants”" }));
    expect(
      await screen.findByText(
        "SF Giants was already a franchise. Save the team to put it on there.",
      ),
    ).toBeTruthy();
    expect(field().value).toBe("Giants");
  });

  it("re-seeds the field when a different team is selected", () => {
    renderAt("/admin/teams?team=t-sf-giants");
    pick("Giants");
    expect(field().value).toBe("Giants");

    fireEvent.click(row("Seattle Mariners"));
    expect(field().value).toBe("No franchise");
  });
});

/**
 * NEO-254 capped the pills at 24 behind a filter; NEO-307's type-ahead has no
 * cap to hit. What stays pinned is that a sport with many threads is still one
 * field, every thread is offered, and typing finds one.
 */
describe("TeamManagement — the Franchise field with many threads", () => {
  const field = () =>
    screen.getByRole("combobox", { name: "Franchise" }) as HTMLInputElement;
  const many = Array.from({ length: 30 }, (_, i) => ({
    _id: `f-${i}`,
    _creationTime: 0,
    name: `Franchise ${String(i).padStart(2, "0")}`,
    nameNormalized: `franchise ${i}`,
    sportId: "sport-baseball",
    lastUpdated: 0,
    teamCount: 0,
  }));

  it("offers all of them in one capped, scrolling list", () => {
    franchiseRows = many;
    renderAt("/admin/teams?team=t-sf-giants");
    fireEvent.focus(field());
    const list = screen.getByRole("listbox", { name: "Franchise suggestions" });
    expect(within(list).getAllByRole("option")).toHaveLength(31);
    expect(list.className).toContain("max-h-60");
    expect(list.className).toContain("overflow-y-auto");
  });

  it("narrows to what was typed", () => {
    franchiseRows = many;
    renderAt("/admin/teams?team=t-sf-giants");
    fireEvent.focus(field());
    fireEvent.change(field(), { target: { value: "Franchise 07" } });
    const list = screen.getByRole("listbox", { name: "Franchise suggestions" });
    // `✓` is the current answer's mark ("No franchise" here), in its own
    // aria-hidden span beside the label.
    expect(within(list).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Franchise 07",
      "✓No franchise",
    ]);
  });
});

describe("TeamManagement — the ?team deep link", () => {
  it("opens the team named in the URL and scrolls its row into view", () => {
    // The scroll matters as much as the selection: the list is a 32rem
    // scroller over every team, so a selected row can easily land off-screen
    // and the link would look like it did nothing.
    const scrollIntoView = vi
      .spyOn(Element.prototype, "scrollIntoView")
      .mockImplementation(() => {});

    renderAt("/admin/teams?team=t-mariners");

    expect(row("Seattle Mariners").getAttribute("aria-current")).toBe("true");
    expect(row("New York Yankees").getAttribute("aria-current")).toBeNull();
    // The detail panel, not just the row highlight. "Mariners", because Name
    // holds the nickname on its own now — the place is in Location beside it.
    expect(screen.getByLabelText("Name")).toHaveProperty("value", "Mariners");
    expect(screen.getByLabelText("Location")).toHaveProperty(
      "value",
      "Seattle",
    );
    expect(scrollIntoView).toHaveBeenCalled();

    scrollIntoView.mockRestore();
  });

  it("leaves the screen alone for an id this deployment does not have", () => {
    // A stale link is not an error state — there is nothing an operator could
    // do about it here, so the screen opens as it always does.
    renderAt("/admin/teams?team=t-gone");
    expect(row("Seattle Mariners").getAttribute("aria-current")).toBeNull();
    expect(row("New York Yankees").getAttribute("aria-current")).toBeNull();
  });

  it("writes the param back when another team is picked", () => {
    renderAt("/admin/teams?team=t-mariners");
    fireEvent.click(row("New York Yankees"));

    expect(row("New York Yankees").getAttribute("aria-current")).toBe("true");
    expect(screen.getByTestId("search").textContent).toBe("?team=t-yankees");
  });

  it("leaves the operator's filter alone when they click a different row", () => {
    // The one-slot regression, and the reason the marker holds TWO ids.
    //
    // React Router applies location updates inside `startTransition`, so the
    // render that commits this click is a render in which `searchParams` still
    // says `t-mariners` — the id the operator ARRIVED on. A marker that
    // remembers only the last id it followed cannot tell that stale value apart
    // from a fresh link back to the Mariners, so it follows it: it re-selects
    // them, and because following a link clears the filters (a linked row has
    // to be reachable), the word the operator typed a second ago empties itself
    // under their own click.
    //
    // The three assertions above all pass with that bug — the URL and the
    // final selection both catch up once the transition lands. The filter is
    // what does not come back, so it is what this test watches.
    renderAt("/admin/teams?team=t-mariners");

    fireEvent.change(screen.getByLabelText("Filter teams"), {
      target: { value: "New" },
    });

    fireEvent.click(row("New York Yankees"));

    expect(screen.getByLabelText("Filter teams")).toHaveProperty("value", "New");
    expect(row("New York Yankees").getAttribute("aria-current")).toBe("true");
    expect(screen.getByTestId("search").textContent).toBe("?team=t-yankees");
  });
});

describe("TeamManagement — the ?league deep link", () => {
  it("opens filtered to the league named in the URL", () => {
    renderAt("/admin/teams?league=l-mlb");

    expect(select("league-filter")).toHaveProperty("value", "l-mlb");
    expect(row("New York Yankees")).toBeTruthy();
    // The Mariners carry no league, so the filter has to have been applied for
    // them to be gone — not merely parsed.
    expect(
      screen.queryByRole("button", { name: /Seattle Mariners/ }),
    ).toBeNull();
  });

  it("ignores a league id this deployment does not carry", () => {
    // A filter matching nothing reads as "there are no teams" with no visible
    // cause, and a stale link is not something the operator can fix here. So a
    // dead id opens the screen exactly as an empty URL would.
    renderAt("/admin/teams?league=l-gone");

    expect(select("league-filter")).toHaveProperty("value", "all");
    expect(row("New York Yankees")).toBeTruthy();
    expect(row("Seattle Mariners")).toBeTruthy();
  });

  it("writes the filter back to the URL, keeping the team param", () => {
    renderAt("/admin/teams?team=t-mariners");

    fireEvent.change(select("league-filter")!, { target: { value: "l-mlb" } });

    expect(screen.getByTestId("search").textContent).toBe(
      "?team=t-mariners&league=l-mlb",
    );
    // And the write does not read back as a fresh link on the next render: the
    // param it just wrote is already marked followed, so nothing re-applies it
    // and — the visible symptom if it did — nothing resets the filter.
    expect(select("league-filter")).toHaveProperty("value", "l-mlb");
  });

  it("drops the param again when the filter goes back to all leagues", () => {
    // "?league=all" would be a link that says something the screen does not
    // mean: `all` is the absence of a filter, not a league.
    renderAt("/admin/teams?league=l-mlb");

    fireEvent.change(select("league-filter")!, { target: { value: "all" } });

    expect(screen.getByTestId("search").textContent).toBe("");
  });

  it("keeps the league filter in the URL when a row is picked", () => {
    // The two params are one screen. A click that dropped the filter would
    // hand the operator a link that opens a different list than the one they
    // are looking at.
    renderAt("/admin/teams?league=l-mlb");

    fireEvent.click(row("New York Yankees"));

    expect(screen.getByTestId("search").textContent).toBe(
      "?team=t-yankees&league=l-mlb",
    );
  });
});

describe("TeamManagement — the way through to League Management", () => {
  it("links to the league in hand when the team has one", () => {
    renderAt("/admin/teams?team=t-yankees");

    expect(
      screen.getByRole("link", { name: "Manage leagues" }).getAttribute("href"),
    ).toBe("/admin/leagues?league=l-mlb");
  });

  it("links to the whole screen when the team has no league", () => {
    renderAt("/admin/teams?team=t-mariners");

    expect(
      screen.getByRole("link", { name: "Manage leagues" }).getAttribute("href"),
    ).toBe("/admin/leagues");
  });

  it("gives the link a 24px pointer target without touching its text", () => {
    // text-xs is a 16px line box, 8px short of WCAG 2.2 SC 2.5.8's 24px floor.
    // `py-1` on an inline-block adds 4px above and below — 16 + 2x4 = 24 — and
    // grows the hit area without moving the words.
    renderAt("/admin/teams?team=t-yankees");

    const link = screen.getByRole("link", { name: "Manage leagues" });
    expect(link.className).toContain("inline-block");
    expect(link.className).toContain("py-1");
    expect(link.textContent).toBe("Manage leagues");
  });

  it("keeps pointing at the team's league while the add dialog is open", () => {
    // The sentinel never reaches `leagueId` any more, so there is no longer an
    // impossible id for this link to guard against — and the league the team
    // actually has is still the right destination while a dialog is up.
    renderAt("/admin/teams?team=t-yankees");
    fireEvent.change(select("team-league")!, { target: { value: "__add__" } });

    expect(
      screen.getByRole("link", { name: "Manage leagues" }).getAttribute("href"),
    ).toBe("/admin/leagues?league=l-mlb");
  });
});

describe("TeamManagement — leagues in level order", () => {
  // Alphabetically these are Atlantic, International, Major, Nippon. Level
  // order is Major (major), International (minor), Nippon (international),
  // Atlantic (no level) — so neither list below can be satisfied by the
  // server's name sort arriving unchanged.
  it("orders the detail panel's dropdown by level, then name", () => {
    renderAt("/admin/teams?team=t-yankees");

    expect(optionLabels("team-league")).toEqual([
      "— none —",
      "Major League Baseball (MLB)",
      "International League (IL)",
      "Nippon Professional Baseball (NPB)",
      "Atlantic League (ATL)",
      "+ Add a new league…",
    ]);
  });

  it("orders the filter's dropdown the same way", () => {
    renderAt("/admin/teams");

    expect(optionLabels("league-filter")).toEqual([
      "All leagues",
      "No league",
      "MLB",
      "IL",
      "NPB",
      "ATL",
    ]);
  });
});

describe("TeamManagement — adding a league from the League select", () => {
  /** Choose `+ Add a new league…`, which is a command rather than a value. */
  const openDialog = () => {
    renderAt("/admin/teams?team=t-yankees");
    fireEvent.change(select("team-league")!, { target: { value: "__add__" } });
  };

  const dialog = () => screen.getByRole("dialog");

  it("opens a modal instead of revealing fields under the dropdown", () => {
    openDialog();

    expect(dialog().getAttribute("aria-modal")).toBe("true");
    const heading = screen.getByRole("heading", {
      level: 3,
      name: "Add a league",
    });
    expect(dialog().getAttribute("aria-labelledby")).toBe(heading.id);
    // The label a Maestro flow would target lives inside the dialog now, not
    // under the select.
    expect(dialog().contains(screen.getByLabelText("New league name"))).toBe(
      true,
    );
    // And the sentence that made the old arrangement confusing is gone: the
    // league is created by the dialog, not by this screen's Save button.
    expect(
      screen.queryByText("Created for this team's sport when you save."),
    ).toBeNull();
  });

  it("leaves the select showing the league the draft already had", () => {
    // The sentinel is a command. If it stuck as the select's value, an operator
    // who then pressed Save with the dialog cancelled would be saving a team
    // whose league is a string this screen invented.
    openDialog();
    expect(select("team-league")).toHaveProperty("value", "l-mlb");
  });

  it("creates under the team's own sport, which cannot be changed", () => {
    // A league is keyed on (name, sport). Created under any other sport, it is
    // a league this team cannot point at.
    openDialog();
    expect(screen.getByText("Sport: Baseball")).toBeTruthy();
    expect(document.getElementById("new-league-sport")).toBeNull();
  });

  it("opens with focus in the name field", () => {
    openDialog();
    expect(document.activeElement).toBe(screen.getByLabelText("New league name"));
  });

  it.each([
    ["Escape", () => fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" })],
    [
      "Cancel",
      () => fireEvent.click(screen.getByRole("button", { name: "Cancel" })),
    ],
    ["the scrim", () => fireEvent.click(screen.getByRole("dialog"))],
  ])("closes on %s with the draft untouched, focus back on the select", (
    _label,
    dismiss,
  ) => {
    openDialog();
    fireEvent.change(screen.getByLabelText("New league name"), {
      target: { value: "Nippon Professional Baseball" },
    });

    dismiss();

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(select("team-league")).toHaveProperty("value", "l-mlb");
    expect(mockCreateByAdmin).not.toHaveBeenCalled();
    // Focus goes back where the operator left it. React does not do this on
    // unmount — it drops focus on <body>, and the next Tab restarts at the top
    // of the page.
    expect(document.activeElement).toBe(select("team-league"));
  });

  it("selects the new league in the dropdown, and closes", async () => {
    openDialog();
    fireEvent.change(screen.getByLabelText("New league name"), {
      target: { value: "  Nippon Professional Baseball  " },
    });
    fireEvent.change(screen.getByLabelText("Abbreviation"), {
      target: { value: " NPB " },
    });
    fireEvent.click(
      screen.getByLabelText("Create league Nippon Professional Baseball"),
    );

    await waitFor(() =>
      expect(mockCreateByAdmin).toHaveBeenCalledWith({
        name: "Nippon Professional Baseball",
        abbreviation: "NPB",
        sportId: "sport-baseball",
      }),
    );

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // The dropdown carries the row BEFORE `leagues.list` re-runs — the mocked
    // query never does. A controlled select whose value names an option it does
    // not have renders blank, so without the local copy the operator would
    // watch their new league vanish out of the field they just added it to.
    expect(select("team-league")).toHaveProperty("value", "l-new");
    expect(optionLabels("team-league")).toContain(
      "Nippon Professional Baseball",
    );
  });

  it("does not save the team as a side effect of creating a league", async () => {
    // The two decisions are separate now: the league exists, and whether THIS
    // team plays in it is still committed by Save.
    openDialog();
    fireEvent.change(screen.getByLabelText("New league name"), {
      target: { value: "Nippon Professional Baseball" },
    });
    fireEvent.click(
      screen.getByLabelText("Create league Nippon Professional Baseball"),
    );

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(mockSaveTeamFields).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mockSaveTeamFields).toHaveBeenCalled());
    expect(mockSaveTeamFields.mock.calls[0][0]).toMatchObject({
      id: "t-yankees",
      leagueId: "l-new",
    });
  });

  it("picks the existing league a near match offers, creating nothing", async () => {
    // The guard the inline fields never had. `leagues.create` was a bare
    // find-or-create, so "Nippon Pro Baseball" typed here became a second row
    // that `/admin/leagues` then has to fold back together by hand.
    nearMatches = [
      {
        _id: "l-npb",
        name: "Nippon Professional Baseball",
        confidence: "close",
      },
    ];
    openDialog();
    fireEvent.change(screen.getByLabelText("New league name"), {
      target: { value: "Nippon Pro Baseball" },
    });

    fireEvent.click(
      await screen.findByLabelText("Open Nippon Professional Baseball"),
    );

    expect(mockCreateByAdmin).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(select("team-league")).toHaveProperty("value", "l-npb");
  });

  it("saves a team with no league at all without going near the dialog", async () => {
    // The path the sentinel used to sit in the way of: `canSave` no longer has
    // an "unless a league is half-typed" clause, so `— none —` is just a value.
    renderAt("/admin/teams?team=t-mariners");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mockSaveTeamFields).toHaveBeenCalled());
    expect(mockSaveTeamFields.mock.calls[0][0]).toMatchObject({
      leagueId: null,
    });
  });
});

// ---------------------------------------------------------------------------
// NEO-236 — Location + Name
// ---------------------------------------------------------------------------

describe("TeamManagement — the master row", () => {
  it("prints the nickname, with the location and league beneath it", () => {
    renderAt("/admin/teams");

    const yankees = row("New York Yankees");
    // The nickname is the row's first line and starts at the left edge, so an
    // alphabetical list can be run down with the eye. The location is the
    // second line, not an inline prefix, for exactly that reason.
    expect(yankees.textContent).toContain("Yankees");
    expect(yankees.textContent).toContain("New York");
    expect(yankees.textContent).not.toContain("New York Yankees");
    // The league tag moved onto the metadata line with the location; it is
    // still on the row.
    expect(yankees.textContent).toContain("MLB");
  });

  it("carries the FULL name — and the era — as its accessible name, exactly", () => {
    // The handle every `.maestro` flow taps this row by: maestro-web builds
    // `resource-id = node.id || node.ariaLabel`. Appending STATE here — "needs
    // colors", a league — would break every one of those selectors silently, so
    // this asserts the whole attribute rather than a substring.
    //
    // NEO-254 added the era, and the distinction is exactly that: an era is not
    // state, it is half of which row this is. Two "Winnipeg Jets" with one
    // accessible name are two identical handles for two different franchises.
    // An undated row is unchanged, which is what makes the change safe.
    renderAt("/admin/teams");

    expect(row("New York Yankees").getAttribute("aria-label")).toBe(
      "New York Yankees",
    );
    expect(row("Seattle Mariners").getAttribute("aria-label")).toBe(
      "Seattle Mariners · 1977–present",
    );
  });

  it("says the league and the attention state that the aria-label hides", () => {
    // An `aria-label` REPLACES the accessible name, so the league tag and the
    // "?"/"—" glyph stop being announced the moment the full name is set on the
    // row. Both are real state on a list whose whole job is surfacing rows that
    // need a human, so they are described instead — the label itself has to
    // stay exactly the full name.
    renderAt("/admin/teams");

    const described = (name: string) => {
      const id = row(name).getAttribute("aria-describedby");
      return id ? document.getElementById(id)?.textContent : undefined;
    };

    expect(described("New York Yankees")).toBe("MLB. ");
    // No colors on the Aztecs, and no league — so the description is the
    // attention state alone.
    expect(described("San Diego State Aztecs")).toBe("No colors yet.");
    // The Mariners have colors and no league: nothing to describe, and no
    // empty description left dangling.
    expect(row("Seattle Mariners").getAttribute("aria-describedby")).toBeNull();

    // The glyph itself is a glyph, not a word — it is not read twice.
    const glyph = row("San Diego State Aztecs").querySelector(
      "[aria-hidden='true']",
    );
    expect(glyph?.textContent).toBe("—");
  });

  it("leaves a team with no location on one line", () => {
    // Colleges, national sides and corporate-named clubs carry no location and
    // are not a broken state: full == short, and there is nothing to print
    // underneath.
    renderAt("/admin/teams");

    const aztecs = row("San Diego State Aztecs");
    expect(aztecs.getAttribute("aria-label")).toBe("San Diego State Aztecs");
    expect(aztecs.textContent).toContain("San Diego State Aztecs");
  });

  it("filters on the composed name, not the nickname alone", () => {
    // Typing what is in the operator's head. `name` holds only "Yankees" now,
    // so a filter over the stored field would answer "no teams match" to the
    // most obvious thing anyone could type.
    renderAt("/admin/teams");

    fireEvent.change(screen.getByLabelText("Filter teams"), {
      target: { value: "new york" },
    });

    expect(row("New York Yankees")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Seattle Mariners/ })).toBeNull();
  });
});

describe("TeamManagement — the order of the master list", () => {
  const rowNames = () =>
    Array.from(
      document.querySelectorAll("li > button[aria-label]"),
    ).map((el) => el.getAttribute("aria-label"));

  it("orders by the name it PRINTS, then by location", () => {
    // `listForManagement` returns them ordered by the composed full name,
    // because that is what every other consumer wants — the mock hands them
    // over in a deliberately different order again. This list is the one place
    // showing the SHORT name on its first line, and a column of first lines
    // running Yankees, Mets, Knicks with nothing saying they are all filed
    // under "New" reads as no order at all.
    renderAt("/admin/teams");

    expect(rowNames()).toEqual([
      // Two Giants, adjacent and in a stable order — which is the disambiguation
      // the location is there to do.
      "New York Giants",
      "San Francisco Giants",
      // NEO-254: the era rides in the accessible name now — see the block
      // below. The ORDER, which is what this test is about, is unchanged.
      "Seattle Mariners · 1977–present",
      "San Diego State Aztecs",
      "New York Yankees",
    ]);
  });
});

describe("TeamManagement — the detail panel's composed name", () => {
  it("heads the panel with the full name", () => {
    renderAt("/admin/teams?team=t-yankees");

    expect(
      screen.getByRole("heading", { level: 4, name: "New York Yankees" }),
    ).toBeTruthy();
  });

  it("NEO-326: shows no 'Shows as' preview, as loaded or as typed", () => {
    // It only repeated `${location} ${name}`, which the two boxes already read
    // left to right (Jason, 2026-10-04). Typed into as well as loaded: the
    // preview used to appear only once Name had text, so a test that never
    // typed could pass with the line still wired to the edit.
    renderAt("/admin/teams?team=t-mariners");
    expect(screen.queryByText(/Shows as/)).toBeNull();

    fireEvent.change(screen.getByLabelText("Location"), {
      target: { value: "San Diego" },
    });
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Padres" },
    });

    expect(screen.queryByText(/Shows as/)).toBeNull();
    // And not reworded into some other line either: no fixture team is called
    // this and the panel heading is the SAVED name, so the draft composition
    // is printed nowhere.
    expect(screen.queryByText(/San Diego Padres/)).toBeNull();
  });

  it("NEO-326: neither field has a description while there is no refusal", () => {
    renderAt("/admin/teams?team=t-mariners");

    expect(screen.queryByText(/where they.re from/)).toBeNull();
    expect(screen.queryByText(/city, state, region or\s+school/)).toBeNull();
    // Absent, not empty and not pointing at an id that is no longer in the
    // document: a describedby naming a removed node is read as nothing by some
    // screen readers and as a stale string by others.
    for (const label of ["Location", "Name"]) {
      expect(
        screen.getByLabelText(label).getAttribute("aria-describedby"),
      ).toBeNull();
    }
  });

  it("sends both halves, and clears the location with null", async () => {
    renderAt("/admin/teams?team=t-mariners");

    fireEvent.change(screen.getByLabelText("Location"), {
      target: { value: "  San Diego  " },
    });
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Padres" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mockSaveTeamFields).toHaveBeenCalled());
    expect(mockSaveTeamFields.mock.calls[0][0]).toMatchObject({
      id: "t-mariners",
      name: "Padres",
      location: "San Diego",
    });
  });

  it("clears the location with null rather than an empty string", async () => {
    // `undefined` would mean "leave it alone" to an optional arg, and "" would
    // store a location that is not one. `null` is the only value that says
    // remove it.
    renderAt("/admin/teams?team=t-mariners");

    fireEvent.change(screen.getByLabelText("Location"), {
      target: { value: "   " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mockSaveTeamFields).toHaveBeenCalled());
    expect(mockSaveTeamFields.mock.calls[0][0].location).toBeNull();
  });

  it("confirms the save by the composed name, not the nickname", async () => {
    renderAt("/admin/teams?team=t-mariners");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Saved Seattle Mariners.")).toBeTruthy();
  });
});

/**
 * NEO-253 — the refusal is an ID, and the screen turns it into a way out.
 *
 * `saveTeamFields` rejects a colliding rename with `NAME_TAKEN:<id>` and
 * nothing else: the string reaches Sentry and the browser console, so it
 * carries no name and no audit fields. The sentence an operator reads is
 * written HERE, from the draft they typed, and the id becomes a button that
 * opens the row they collided with — which is the actual next thing they want,
 * and otherwise a search they have to run by hand.
 */
describe("TeamManagement — a name that is already taken", () => {
  // What the server really sends. The id is `t-yankees`, the row the fixtures
  // already hold, so the escape hatch has somewhere real to land.
  const TAKEN = "NAME_TAKEN:t-yankees";
  const REFUSAL = "Another team in this sport is already called New York Yankees.";

  it("shows the refusal next to the fields instead of crashing", async () => {
    // A ConvexError, not a plain Error: production redacts a plain Error's
    // message to "Server Error", so what the backend sent only crosses on
    // `data` (see `userFacingMessage`).
    mockSaveTeamFields.mockRejectedValue(new ConvexError(TAKEN));
    renderAt("/admin/teams?team=t-mariners");

    fireEvent.change(screen.getByLabelText("Location"), {
      target: { value: "New York" },
    });
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Yankees" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    const alert = await screen.findByRole("alert");
    // The sentence names the COMPOSED draft, which is the thing that collided
    // — not the nickname on its own, which would read as a refusal of a name
    // the operator never typed. And never the raw `NAME_TAKEN:` string.
    expect(alert.textContent).toContain(REFUSAL);
    expect(alert.textContent).not.toContain("NAME_TAKEN");
    // The draft survives: the operator's typing is what they are about to fix,
    // and re-typing it would be the screen punishing them for the refusal.
    expect(screen.getByLabelText("Name")).toHaveProperty("value", "Yankees");
    // And the panel is still there — the panel is where the fix happens.
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
  });

  it("offers the team it collided with, and opens it", async () => {
    mockSaveTeamFields.mockRejectedValue(new ConvexError(TAKEN));
    renderAt("/admin/teams?team=t-mariners");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    const open = await screen.findByRole("button", {
      name: "Open the existing team",
    });
    fireEvent.click(open);

    // Selected for real — the row, the panel and the shareable URL all move,
    // exactly as if the operator had found it in the list themselves.
    expect(row("New York Yankees").getAttribute("aria-current")).toBe("true");
    expect(screen.getByLabelText("Name")).toHaveProperty("value", "Yankees");
    expect(screen.getByTestId("search").textContent).toBe("?team=t-yankees");
  });

  it("offers no escape hatch for a refusal that is not a collision", async () => {
    // The button is gated on the parsed id, never on how the message reads.
    // A backend sentence that happens to mention another team must not grow a
    // button that navigates nowhere.
    mockSaveTeamFields.mockRejectedValue(
      new ConvexError("A team name is 130 characters; the limit is 120."),
    );
    renderAt("/admin/teams?team=t-mariners");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await screen.findByRole("alert");
    expect(
      screen.queryByRole("button", { name: "Open the existing team" }),
    ).toBeNull();
  });

  it("marks both fields invalid and points them at the message", async () => {
    mockSaveTeamFields.mockRejectedValue(new ConvexError(TAKEN));
    renderAt("/admin/teams?team=t-mariners");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    const alertId = (await screen.findByRole("alert")).id;
    for (const label of ["Location", "Name"]) {
      const field = screen.getByLabelText(label);
      expect(field.getAttribute("aria-invalid")).toBe("true");
      // NEO-326: EXACTLY the message. With the "Shows as" preview gone the
      // refusal is the only description either field has, so nothing else may
      // ride along in the list.
      expect(field.getAttribute("aria-describedby")).toBe(alertId);
    }
  });

  it("takes the message away as soon as either field is edited", async () => {
    mockSaveTeamFields.mockRejectedValue(new ConvexError(TAKEN));
    renderAt("/admin/teams?team=t-mariners");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByRole("alert");

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Mariner" },
    });

    expect(screen.queryByRole("alert")).toBeNull();
    // The way out goes with it. Leaving it behind would offer to navigate away
    // on the strength of a refusal the operator has already answered.
    expect(
      screen.queryByRole("button", { name: "Open the existing team" }),
    ).toBeNull();
    expect(screen.getByLabelText("Name").getAttribute("aria-invalid")).toBeNull();
    // And the description goes with the message rather than pointing at an id
    // that has left the document.
    for (const label of ["Location", "Name"]) {
      expect(
        screen.getByLabelText(label).getAttribute("aria-describedby"),
      ).toBeNull();
    }
  });

  it("falls back to plain words for a failure that carried no message", async () => {
    // A plain Error reaches production as "[CONVEX M(teams:saveTeamFields)]
    // [Request ID: …] Server Error", which is not a sentence to show anyone.
    mockSaveTeamFields.mockRejectedValue(new Error("kaboom"));
    renderAt("/admin/teams?team=t-mariners");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Could not save this team. Try again.");
    expect(alert.textContent).not.toContain("kaboom");
  });
});

/**
 * NEO-254 — the era is part of a row's IDENTITY, so it is part of the row's
 * accessible name.
 *
 * A sport can hold two "Winnipeg Jets". Two rows with one accessible name are
 * two identical handles for two different franchises: Maestro builds
 * `resource-id = node.id || node.ariaLabel` and taps whichever comes first, and
 * a screen-reader operator cannot tell them apart at all.
 *
 * It has to be the LABEL and not the description: `aria-describedby` is not
 * part of what Maestro resolves, so no amount of description could make the
 * handle unique. The compensating promise is that an UNDATED row's name is
 * unchanged, which is what keeps the existing flows working.
 */
describe("TeamManagement — a row's era", () => {
  it("appends the era to a dated row's accessible name", () => {
    renderAt("/admin/teams");
    expect(
      screen.getByRole("button", { name: "Seattle Mariners · 1977–present" }),
    ).toBeTruthy();
  });

  it("leaves an UNDATED row's accessible name byte-identical", () => {
    // The reason the change is safe to make at all — every `.maestro` flow taps
    // undated rows, and none of them moves.
    renderAt("/admin/teams");
    expect(
      screen.getByRole("button", { name: "New York Yankees" }),
    ).toBeTruthy();
  });

  it("shows the era on the row, in tabular figures", () => {
    renderAt("/admin/teams");
    const era = screen.getByText("1977–present");
    expect(era.className).toContain("tabular-nums");
  });

  it("orders two same-name rows oldest era first", () => {
    // Two rows can now share a nickname AND a location — the two Winnipeg Jets
    // do — and without the era as a sort key they land adjacent in whatever
    // order the query returned, which is arbitrary and unstable between
    // renders. A lineage reads forwards.
    currentTeams = [
      {
        _id: "t-jets-new",
        _creationTime: 0,
        name: "Jets",
        location: "Winnipeg",
        nameNormalized: "jets winnipeg",
        sportId: "sport-baseball",
        yearsActive: { from: 2011 },
      },
      {
        _id: "t-jets-old",
        _creationTime: 0,
        name: "Jets",
        location: "Winnipeg",
        nameNormalized: "jets winnipeg",
        sportId: "sport-baseball",
        yearsActive: { from: 1972, to: 1996 },
      },
    ];
    renderAt("/admin/teams");
    const labels = screen
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label"))
      .filter((l): l is string => !!l && l.startsWith("Winnipeg Jets"));
    expect(labels).toEqual([
      "Winnipeg Jets · 1972–1996",
      "Winnipeg Jets · 2011–present",
    ]);
  });
});

/**
 * NEO-330 — every team reachable, not just the ones in the window.
 *
 * `listForManagement` returns a capped window (2000 rows, newest first) of a
 * table several times that size. The screen used to filter that window in the
 * browser and look `?team=` ids up in it, so a team outside it could never be
 * found or opened. These pin the three ways out of the window: a typed filter
 * answered by the server, a link read by id, and a search result opened by
 * click — plus the counter that says which of the two lists it is counting.
 */
describe("TeamManagement — teams outside the list's window (NEO-330)", () => {
  /** A team the deployment has and the capped window does not return. */
  const EXPOS = {
    _id: "t-expos",
    _creationTime: 0,
    name: "Expos",
    location: "Montreal",
    nameNormalized: "expos montreal",
    sportId: "sport-baseball",
    colors: { primary: "#003087" },
  };


  it("asks the server once two characters are typed, and lists its answer", async () => {
    offWindowTeams = [EXPOS];
    searchAnswer = { teams: [EXPOS], truncated: false };
    renderAt("/admin/teams");

    fireEvent.change(screen.getByLabelText("Filter teams"), {
      target: { value: "Expos" },
    });

    // The window has no Expos; only the server's answer can put the row here.
    expect(await screen.findByRole("button", { name: "Montreal Expos" })).toBeTruthy();
    expect(searchCalls).toContainEqual({ query: "Expos" });
    expect(counter().textContent).toBe("1 match");
  });

  it("keeps filtering the loaded list until the server has answered the text in the box", () => {
    // `searchAnswer` stays undefined: the debounce has not fired, or the round
    // trip is in flight. The list must not blank to "No teams match".
    renderAt("/admin/teams");
    fireEvent.change(screen.getByLabelText("Filter teams"), {
      target: { value: "seattle" },
    });

    expect(row("Seattle Mariners")).toBeTruthy();
    expect(screen.queryByText("No teams match that filter.")).toBeNull();
    // Attention is counted over the matches the number names, and the
    // Mariners have their colours — so no suffix.
    expect(counter().textContent).toBe("1 match");
  });

  it("does not ask the server for a single character", async () => {
    renderAt("/admin/teams");
    fireEvent.change(screen.getByLabelText("Filter teams"), {
      target: { value: "s" },
    });
    // Past the debounce, and still nothing subscribed.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(searchCalls).toEqual([]);
  });

  it("sends the league filter with the search, so the limit is not spent on other leagues", async () => {
    searchAnswer = { teams: [], truncated: false };
    renderAt("/admin/teams?league=l-mlb");
    fireEvent.change(screen.getByLabelText("Filter teams"), {
      target: { value: "new" },
    });
    await waitFor(() =>
      expect(searchCalls).toContainEqual({ query: "new", leagueId: "l-mlb" }),
    );
  });

  it("opens a search result that is outside the window", async () => {
    offWindowTeams = [EXPOS];
    searchAnswer = { teams: [EXPOS], truncated: false };
    renderAt("/admin/teams");
    fireEvent.change(screen.getByLabelText("Filter teams"), {
      target: { value: "Expos" },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Montreal Expos" }));

    expect(screen.getByLabelText("Name")).toHaveProperty("value", "Expos");
    expect(screen.getByLabelText("Location")).toHaveProperty("value", "Montreal");
    expect(screen.getByTestId("search").textContent).toBe("?team=t-expos");
  });

  it("follows a ?team link to a team outside the window and opens its panel", () => {
    offWindowTeams = [EXPOS];
    renderAt("/admin/teams?team=t-expos");

    // No row to highlight — the window does not hold it — but the panel opens.
    expect(screen.getByLabelText("Name")).toHaveProperty("value", "Expos");
    expect(screen.getByLabelText("Location")).toHaveProperty("value", "Montreal");
  });

  it("gives a bare count on a truncated window — no 'of N', no truncation note", () => {
    listTruncated = true;
    renderAt("/admin/teams");
    // Three fixtures have no colours.
    expect(counter().textContent).toBe("5 teams · 3 need attention");
    // The "type to search" hint lives in the filter's placeholder.
    expect(
      screen.getByLabelText("Filter teams").getAttribute("placeholder"),
    ).toBe("Start typing a team name…");
  });

  it("counts attention over the rows the number names, not the whole window", () => {
    renderAt("/admin/teams");
    fireEvent.change(screen.getByLabelText("Filter teams"), {
      target: { value: "new york" },
    });
    // The Yankees have colours, the New York Giants do not: one of the two
    // matches, not the three uncoloured teams in the window.
    expect(counter().textContent).toBe("2 matches · 1 need attention");
  });

  it("says when the server's matches ran past its limit", async () => {
    searchAnswer = { teams: [EXPOS], truncated: true };
    renderAt("/admin/teams");
    fireEvent.change(screen.getByLabelText("Filter teams"), {
      target: { value: "ex" },
    });
    await waitFor(() =>
      expect(counter().textContent).toBe("1+ matches"),
    );
  });

  it("counts attention over the matches, not the window, once the server answers", async () => {
    const UNCOLOURED = { ...EXPOS, _id: "t-expos-2", colors: undefined, yearsActive: { from: 1969 } };
    searchAnswer = { teams: [EXPOS, UNCOLOURED], truncated: false };
    renderAt("/admin/teams");
    fireEvent.change(screen.getByLabelText("Filter teams"), {
      target: { value: "expos" },
    });
    await waitFor(() =>
      expect(counter().textContent).toBe("2 matches · 1 need attention"),
    );
  });
});

/**
 * NEO-330 audit — what the counter says to a screen reader, what the list says
 * while a search is in flight, the counter's own line, and the panel not
 * blinking on a followed link.
 */
describe("TeamManagement — the counter, announced and held still (NEO-330)", () => {
  const EXPOS = {
    _id: "t-expos",
    _creationTime: 0,
    name: "Expos",
    location: "Montreal",
    nameNormalized: "expos montreal",
    sportId: "sport-baseball",
    colors: { primary: "#003087" },
  };

  const status = () => {
    const regions = screen
      .getAllByRole("status")
      .filter((el) => el.classList.contains("sr-only"));
    expect(regions).toHaveLength(1);
    return regions[0];
  };

  it("is a status region from the first render, and the visible counter is not live", () => {
    renderAt("/admin/teams");
    // Mounted with the screen, holding a settled sentence — no need-attention.
    expect(status().textContent).toBe("5 teams");
    expect(counter().getAttribute("role")).toBeNull();
    expect(counter().getAttribute("aria-live")).toBeNull();
  });

  it("holds the last settled sentence while the server works, then says its answer", async () => {
    searchAnswer = { teams: [EXPOS], truncated: false };
    renderAt("/admin/teams");
    fireEvent.change(screen.getByLabelText("Filter teams"), {
      target: { value: "expos" },
    });
    // Before the debounce: the interim browser-side count is NOT announced.
    expect(status().textContent).toBe("5 teams");
    await waitFor(() => expect(status().textContent).toBe("1 match"));
  });

  it("announces a truncated answer as 'N+ matches'", async () => {
    searchAnswer = { teams: [EXPOS], truncated: true };
    renderAt("/admin/teams");
    fireEvent.change(screen.getByLabelText("Filter teams"), {
      target: { value: "ex" },
    });
    await waitFor(() =>
      expect(status().textContent).toBe("1+ matches"),
    );
  });

  it("says Searching… — not 'No teams match' — until the server answers an empty window", async () => {
    searchAnswer = { teams: [], truncated: false };
    renderAt("/admin/teams");
    fireEvent.change(screen.getByLabelText("Filter teams"), {
      target: { value: "zzzznotateam" },
    });
    // Nothing in the window matches and the server has not been asked yet.
    expect(screen.getByText("Searching…")).toBeTruthy();
    expect(screen.queryByText("No teams match that filter.")).toBeNull();

    // The server's answer is the one that may say "none".
    expect(await screen.findByText("No teams match that filter.")).toBeTruthy();
    expect(screen.queryByText("Searching…")).toBeNull();
    expect(status().textContent).toBe("0 matches");
    expect(counter().textContent).toBe("0 matches");
  });

  it("does not say Searching… below two characters", () => {
    renderAt("/admin/teams");
    fireEvent.change(screen.getByLabelText("Filter teams"), {
      target: { value: "z" },
    });
    expect(screen.getByText("No teams match that filter.")).toBeTruthy();
    expect(screen.queryByText("Searching…")).toBeNull();
  });

  it("gives the counter a line of its own, so its length cannot re-wrap the fields", () => {
    // `basis-full` in the wrapping filter row is the whole fix; pinned because
    // happy-dom has no layout to measure the shift with.
    renderAt("/admin/teams");
    expect(counter().classList.contains("basis-full")).toBe(true);
    expect(counter().className).not.toMatch(/min-w-/);
  });
});

describe("teamCounterSentence (NEO-330)", () => {
  it("is a bare count of teams with nothing typed", () => {
    expect(teamCounterSentence({ typed: "", matched: 2000, serverTruncated: false })).toBe(
      "2,000 teams",
    );
    expect(teamCounterSentence({ typed: "", matched: 1, serverTruncated: false })).toBe(
      "1 team",
    );
    expect(teamCounterSentence({ typed: "", matched: 0, serverTruncated: false })).toBe(
      "0 teams",
    );
  });

  it("counts matches once anything is typed, local or server", () => {
    expect(teamCounterSentence({ typed: "s", matched: 12, serverTruncated: false })).toBe(
      "12 matches",
    );
    expect(teamCounterSentence({ typed: "ex", matched: 1, serverTruncated: false })).toBe(
      "1 match",
    );
    expect(teamCounterSentence({ typed: "ex", matched: 0, serverTruncated: false })).toBe(
      "0 matches",
    );
    expect(
      teamCounterSentence({ typed: "new", matched: 1234, serverTruncated: false }),
    ).toBe("1,234 matches");
  });

  it("says N+ when the server's answer hit its limit", () => {
    expect(teamCounterSentence({ typed: "new", matched: 50, serverTruncated: true })).toBe(
      "50+ matches",
    );
  });
});

describe("teamCounterAnnouncement (NEO-330)", () => {
  const base = {
    typed: "",
    matched: 5,
    answered: false,
    serverTruncated: false,
  };

  it("says nothing new while a typed filter waits on the server", () => {
    expect(teamCounterAnnouncement({ ...base, typed: "ex" })).toBeNull();
  });

  it("speaks the list below two characters", () => {
    expect(teamCounterAnnouncement(base)).toBe("5 teams");
    expect(teamCounterAnnouncement({ ...base, matched: 2000 })).toBe("2,000 teams");
    expect(teamCounterAnnouncement({ ...base, typed: "s", matched: 1 })).toBe("1 match");
    expect(teamCounterAnnouncement({ ...base, typed: "s", matched: 0 })).toBe("0 matches");
  });

  it("speaks the server's answer from two characters", () => {
    const answered = { ...base, typed: "ex", answered: true };
    expect(teamCounterAnnouncement({ ...answered, matched: 12 })).toBe("12 matches");
    expect(teamCounterAnnouncement({ ...answered, matched: 0 })).toBe("0 matches");
    expect(
      teamCounterAnnouncement({ ...answered, matched: 50, serverTruncated: true }),
    ).toBe("50+ matches");
  });

  it("never carries an 'of N', a truncation note or the attention count", () => {
    const samples = [
      teamCounterAnnouncement(base),
      teamCounterAnnouncement({ ...base, matched: 2000 }),
      teamCounterAnnouncement({ ...base, typed: "s", matched: 3 }),
      teamCounterAnnouncement({ ...base, typed: "ex", answered: true, matched: 3 }),
      teamCounterAnnouncement({ ...base, typed: "ex", answered: true, matched: 0 }),
      teamCounterAnnouncement({
        ...base,
        typed: "ex",
        answered: true,
        matched: 50,
        serverTruncated: true,
      }),
    ];
    for (const sample of samples) {
      expect(sample).not.toBeNull();
      expect(sample).not.toMatch(/of /);
      expect(sample).not.toMatch(/truncated|type to search|keep typing/);
      expect(sample).not.toMatch(/need attention/);
      expect(sample).not.toBe("No teams match that filter.");
    }
  });
});

describe("resolveSelectedTeam (NEO-330)", () => {
  const team = (id: string) => ({ _id: id }) as unknown as Parameters<
    typeof resolveSelectedTeam
  >[0]["selectedOnScreen"] & object;

  it("is nothing when nothing is selected", () => {
    expect(
      resolveSelectedTeam({
        selectedId: null,
        selectedById: undefined,
        selectedOnScreen: null,
        linkedTeam: team("t-1"),
      }),
    ).toBeNull();
  });

  it("trusts the by-id read once it answers, including a team that is gone", () => {
    const fresh = team("t-1");
    expect(
      resolveSelectedTeam({
        selectedId: "t-1" as never,
        selectedById: fresh,
        selectedOnScreen: team("t-1"),
        linkedTeam: undefined,
      }),
    ).toBe(fresh);
    expect(
      resolveSelectedTeam({
        selectedId: "t-1" as never,
        selectedById: null,
        selectedOnScreen: team("t-1"),
        linkedTeam: undefined,
      }),
    ).toBeNull();
  });

  it("stands in the linked team while the by-id read is cold, so a link does not flash", () => {
    const linked = team("t-expos");
    expect(
      resolveSelectedTeam({
        selectedId: "t-expos" as never,
        selectedById: undefined,
        selectedOnScreen: null,
        linkedTeam: linked,
      }),
    ).toBe(linked);
    // …but only when it IS the selected team.
    expect(
      resolveSelectedTeam({
        selectedId: "t-other" as never,
        selectedById: undefined,
        selectedOnScreen: null,
        linkedTeam: linked,
      }),
    ).toBeNull();
  });

  it("prefers the row on screen to the linked one while both stand in", () => {
    const onScreen = team("t-1");
    expect(
      resolveSelectedTeam({
        selectedId: "t-1" as never,
        selectedById: undefined,
        selectedOnScreen: onScreen,
        linkedTeam: team("t-1"),
      }),
    ).toBe(onScreen);
  });
});
