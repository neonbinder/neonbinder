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
 * likely league first, and an abbreviation on the league it can create inline.
 *
 * Mocking mirrors PlayerManagement.test.tsx: convex/react's hooks are module
 * mocked and routed by the (string-mocked) function reference.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks — declared before the component import
// ---------------------------------------------------------------------------

vi.mock("../../convex/_generated/api", () => ({
  api: {
    teams: {
      listForManagement: "teams.listForManagement",
      saveTeamFields: "teams.saveTeamFields",
      enrichFromWikidata: "teams.enrichFromWikidata",
    },
    leagues: { list: "leagues.list", create: "leagues.create" },
    teamColorSources: { chooseColorSource: "teamColorSources.chooseColorSource" },
  },
}));

const TEAMS = [
  {
    _id: "t-yankees",
    _creationTime: 0,
    name: "New York Yankees",
    nameNormalized: "new york yankees",
    sportId: "sport-baseball",
    leagueId: "l-mlb",
    colors: { primary: "#0c2340" },
  },
  {
    _id: "t-mariners",
    _creationTime: 0,
    name: "Seattle Mariners",
    nameNormalized: "seattle mariners",
    sportId: "sport-baseball",
    colors: { primary: "#0c2c56" },
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

const mockCreateLeague = vi.fn();
const mockSaveTeamFields = vi.fn();

vi.mock("convex/react", () => ({
  useQuery: (ref: string) => {
    if (ref === "teams.listForManagement") {
      return { teams: TEAMS, truncated: false };
    }
    if (ref === "leagues.list") return LEAGUES;
    return undefined;
  },
  useMutation: (ref: string) => {
    if (ref === "leagues.create") return mockCreateLeague;
    if (ref === "teams.saveTeamFields") return mockSaveTeamFields;
    return vi.fn();
  },
  useAction: () => vi.fn(),
}));

import TeamManagement from "./TeamManagement";

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

/** A select by id — "League" labels two of them, so a label lookup is ambiguous. */
const select = (id: string) =>
  document.getElementById(id) as HTMLSelectElement | null;

const optionLabels = (id: string) =>
  Array.from(select(id)?.options ?? []).map((option) => option.textContent);

beforeEach(() => {
  mockCreateLeague.mockReset().mockResolvedValue("l-new");
  mockSaveTeamFields.mockReset().mockResolvedValue(null);
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
    // The detail panel, not just the row highlight.
    expect(screen.getByLabelText("Name")).toHaveProperty(
      "value",
      "Seattle Mariners",
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

  it("links to the whole screen while a new league is being typed", () => {
    // Mid-add there is no league to deep link to, and `__add__` is a sentinel
    // this screen invented — sending it as an id would 404 on the other side.
    renderAt("/admin/teams?team=t-yankees");
    fireEvent.change(select("team-league")!, { target: { value: "__add__" } });

    expect(
      screen.getByRole("link", { name: "Manage leagues" }).getAttribute("href"),
    ).toBe("/admin/leagues");
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

describe("TeamManagement — adding a league inline", () => {
  const startAdding = () => {
    renderAt("/admin/teams?team=t-yankees");
    fireEvent.change(select("team-league")!, { target: { value: "__add__" } });
    fireEvent.change(screen.getByLabelText("New league name"), {
      target: { value: "  Nippon Professional Baseball  " },
    });
  };

  it("sends the abbreviation the operator typed", async () => {
    startAdding();
    fireEvent.change(screen.getByLabelText("New league abbreviation"), {
      target: { value: " NPB " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mockCreateLeague).toHaveBeenCalled());
    expect(mockCreateLeague).toHaveBeenCalledWith({
      name: "Nippon Professional Baseball",
      abbreviation: "NPB",
      sportId: "sport-baseball",
    });
  });

  it("sends no abbreviation when the field is left empty", async () => {
    // Optional on the mutation too: an operator adding a league by hand may
    // only know one of its forms, and "" is not an abbreviation.
    startAdding();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mockCreateLeague).toHaveBeenCalled());
    expect(mockCreateLeague).toHaveBeenCalledWith({
      name: "Nippon Professional Baseball",
      abbreviation: undefined,
      sportId: "sport-baseball",
    });
  });

  it("caps the abbreviation at what a dense list can show", () => {
    startAdding();
    expect(
      screen.getByLabelText("New league abbreviation").getAttribute("maxlength"),
    ).toBe("16");
  });
});
