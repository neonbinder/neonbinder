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

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ConvexError } from "convex/values";
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
      return { teams: TEAMS, truncated: false };
    }
    if (ref === "leagues.list") return LEAGUES;
    if (ref === "franchises.list") {
      return { franchises: franchiseRows, truncated: false };
    }
    if (ref === "selectorOptions.getSelectorOptions") return SPORTS;
    if (ref === "leagues.nearMatches") return nearMatches;
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
  nearMatches = undefined;
  mockCreateByAdmin
    .mockReset()
    .mockResolvedValue({ id: "l-new", created: true });
  mockSaveTeamFields.mockReset().mockResolvedValue(null);
  mockFindOrCreateFranchise
    .mockReset()
    .mockResolvedValue({ id: "f-new", created: true });
  franchiseRows = FRANCHISES;
});

/**
 * NEO-254 — the Franchise field, a `role="radiogroup"` of pills.
 *
 * ## Why it is not a `<select>`, and why that is asserted here
 *
 * It was one, and that made it undrivable in E2E. Maestro's web driver gives
 * every `<option>` synthetic tap bounds from its index inside its own parent,
 * then resolves a tap by scanning `document.querySelectorAll('option')` and
 * taking the first bounds match — so only the FIRST select on a page is ever
 * reachable and a tap meant for a later one silently mutates the earlier. This
 * panel already had two selects above Franchise. `SetSelector/NewTeamForm.tsx`
 * documents the identical trap and uses the identical remedy.
 *
 * The first test below is the regression pin for that: it asserts the control
 * is not a select at all, because "it works" and "a flow can drive it" are
 * different facts and only the second one is at stake.
 *
 * ## The behavioural failure this whole block guards
 *
 * The one every re-seeded panel field has: forget to reset it on selection
 * change and the operator saves the PREVIOUS team's franchise onto this one,
 * silently, with the right-looking value on screen.
 */
describe("TeamManagement — the Franchise field", () => {
  const group = () => document.getElementById("team-franchise")!;
  const pills = () =>
    Array.from(group().querySelectorAll<HTMLButtonElement>('[role="radio"]'));
  const pillLabels = () => pills().map((b) => b.textContent);
  const pill = (label: string) =>
    pills().find((b) => b.textContent === label)!;
  const checkedPill = () =>
    pills().find((b) => b.getAttribute("aria-checked") === "true");
  const startFranchise = () =>
    screen.getByRole("button", { name: "+ Start a new franchise…" });

  it("is a radio group, not a select — a select here is undrivable in E2E", () => {
    renderAt("/admin/teams?team=t-sf-giants");
    expect(group().getAttribute("role")).toBe("radiogroup");
    expect(group().tagName).not.toBe("SELECT");
    expect(group().querySelector("select")).toBeNull();
    // Named by the visible "Franchise" label rather than an aria-label, so the
    // two cannot drift apart.
    expect(
      document.getElementById(group().getAttribute("aria-labelledby")!)
        ?.textContent,
    ).toBe("Franchise");
  });

  it("offers every franchise in the sport, plus none", () => {
    renderAt("/admin/teams?team=t-sf-giants");
    // "Start a new franchise" is NOT one of these — it is a command, and a
    // command inside a radiogroup made two radios report checked at once.
    expect(pillLabels()).toEqual(["No franchise", "Giants"]);
    // Nothing picked yet, so "No franchise" is the answer AND the Tab stop.
    expect(checkedPill()?.textContent).toBe("No franchise");
    expect(pill("No franchise").tabIndex).toBe(0);
    expect(pill("Giants").tabIndex).toBe(-1);
  });

  it("sends the picked franchise on save", async () => {
    renderAt("/admin/teams?team=t-sf-giants");
    fireEvent.click(pill("Giants"));
    expect(checkedPill()?.textContent).toBe("Giants");
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
    fireEvent.click(pill("Giants"));
    fireEvent.click(pill("No franchise"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mockSaveTeamFields).toHaveBeenCalled());
    expect(mockSaveTeamFields.mock.calls[0][0]).toMatchObject({
      franchiseId: null,
    });
  });

  it("moves between pills with the arrow keys, as one Tab stop", () => {
    // The promise `role="radiogroup"` makes. Before the pills were radios,
    // every option was its own Tab stop and the arrows did nothing.
    renderAt("/admin/teams?team=t-sf-giants");
    fireEvent.keyDown(group(), { key: "ArrowRight" });
    expect(checkedPill()?.textContent).toBe("Giants");
    expect(pill("Giants").tabIndex).toBe(0);
    expect(pill("No franchise").tabIndex).toBe(-1);

    // Wraps, like a native radio group.
    fireEvent.keyDown(group(), { key: "ArrowLeft" });
    expect(checkedPill()?.textContent).toBe("No franchise");
  });

  it("never reports two checked radios at once", () => {
    // The defect that put the command pill outside the group: with it inside,
    // picking a franchise and then opening the name box left BOTH checked, and
    // a radiogroup that reports two selections is a broken contract for anyone
    // reading it through assistive tech — and invisible to everyone else.
    renderAt("/admin/teams?team=t-sf-giants");
    const checkedCount = () =>
      pills().filter((b) => b.getAttribute("aria-checked") === "true").length;

    expect(checkedCount()).toBe(1);
    fireEvent.click(pill("Giants"));
    expect(checkedCount()).toBe(1);
    fireEvent.click(startFranchise());
    expect(checkedCount()).toBe(1);
    expect(checkedPill()?.textContent).toBe("Giants");
  });

  it("the start-a-franchise control is a disclosure beside the group, not a radio", () => {
    renderAt("/admin/teams?team=t-sf-giants");
    const trigger = startFranchise();
    expect(trigger.getAttribute("role")).toBeNull();
    expect(group().contains(trigger)).toBe(false);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    // …and it names the region it opened.
    expect(document.getElementById(trigger.getAttribute("aria-controls")!)).toBeTruthy();
  });

  it("starts a franchise from the panel and selects it without saving the team", async () => {
    renderAt("/admin/teams?team=t-sf-giants");
    fireEvent.click(startFranchise());
    fireEvent.change(screen.getByLabelText("New franchise name"), {
      target: { value: "Giants" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start" }));

    await waitFor(() =>
      expect(mockFindOrCreateFranchise).toHaveBeenCalledWith({
        name: "Giants",
        sportId: "sport-baseball",
      }),
    );
    // Creating a thread and putting this team on it are two decisions.
    expect(mockSaveTeamFields).not.toHaveBeenCalled();
    // The new row is offered immediately, rather than the group losing its
    // answer until `franchises.list` catches up.
    await waitFor(() => expect(checkedPill()?.textContent).toBe("Giants"));
  });

  it("backs out of the name box on Escape without changing the answer", () => {
    renderAt("/admin/teams?team=t-sf-giants");
    fireEvent.click(pill("Giants"));
    fireEvent.click(startFranchise());
    fireEvent.keyDown(screen.getByLabelText("New franchise name"), {
      key: "Escape",
    });

    expect(screen.queryByLabelText("New franchise name")).toBeNull();
    // The draft's franchise never moved — the control is a command, not a value.
    expect(checkedPill()?.textContent).toBe("Giants");
    // Focus goes back to the trigger, not to `<body>`: closing unmounts the
    // input that had it.
    expect(document.activeElement).toBe(startFranchise());
  });

  it("re-seeds the field when a different team is selected", () => {
    renderAt("/admin/teams?team=t-sf-giants");
    fireEvent.click(pill("Giants"));
    expect(checkedPill()?.textContent).toBe("Giants");

    fireEvent.click(row("Seattle Mariners"));
    expect(checkedPill()?.textContent).toBe("No franchise");
  });

  it("shows no filter box while the list is short", () => {
    renderAt("/admin/teams?team=t-sf-giants");
    expect(screen.queryByLabelText("Filter franchises")).toBeNull();
  });
});

/**
 * NEO-254 — the bound on the pill group.
 *
 * The League group next door bounds itself with a scroll box, which works
 * because a sport holds tens of leagues. The preload is about to mint one
 * franchise per thread across five sports, and a hundred-pill scroll box with
 * no way to aim at one is not a control. Past the cap the group grows a filter
 * and says how many it is hiding.
 */
describe("TeamManagement — the Franchise group past its cap", () => {
  const group = () => document.getElementById("team-franchise")!;
  const pillLabels = () =>
    Array.from(group().querySelectorAll('[role="radio"]')).map(
      (b) => b.textContent,
    );

  const many = Array.from({ length: 30 }, (_, i) => ({
    _id: `f-${i}`,
    _creationTime: 0,
    name: `Franchise ${String(i).padStart(2, "0")}`,
    nameNormalized: `franchise ${i}`,
    sportId: "sport-baseball",
    lastUpdated: 0,
    teamCount: 0,
  }));

  it("caps the pills, offers a filter, and says how many are hidden", () => {
    franchiseRows = many;
    renderAt("/admin/teams?team=t-sf-giants");

    // 24 franchises + "No franchise". The disclosure is not a radio.
    expect(pillLabels()).toHaveLength(25);
    expect(screen.getByLabelText("Filter franchises")).toBeTruthy();
    expect(screen.getByText("6 more — keep typing to narrow it down.")).toBeTruthy();
  });

  it("narrows to what was typed", () => {
    franchiseRows = many;
    renderAt("/admin/teams?team=t-sf-giants");

    fireEvent.change(screen.getByLabelText("Filter franchises"), {
      target: { value: "Franchise 07" },
    });
    expect(pillLabels()).toEqual(["No franchise", "Franchise 07"]);
  });

  it("keeps the picked franchise visible even when the filter excludes it", () => {
    // A radio group whose checked option is not in the DOM announces "nothing
    // selected" and leaves the roving Tab stop with nowhere to sit.
    franchiseRows = many;
    renderAt("/admin/teams?team=t-sf-giants");

    const target = Array.from(
      group().querySelectorAll<HTMLButtonElement>('[role="radio"]'),
    ).find((b) => b.textContent === "Franchise 03")!;
    fireEvent.click(target);

    fireEvent.change(screen.getByLabelText("Filter franchises"), {
      target: { value: "Franchise 21" },
    });
    expect(pillLabels()).toContain("Franchise 03");
    expect(
      Array.from(group().querySelectorAll('[role="radio"]')).find(
        (b) => b.getAttribute("aria-checked") === "true",
      )?.textContent,
    ).toBe("Franchise 03");
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

  it("carries the FULL name as its accessible name, exactly", () => {
    // The handle every `.maestro` flow taps this row by: maestro-web builds
    // `resource-id = node.id || node.ariaLabel`. Appending a state word here —
    // "needs colors", a league — would break every one of those selectors
    // silently, so this asserts the whole attribute rather than a substring.
    renderAt("/admin/teams");

    expect(row("New York Yankees").getAttribute("aria-label")).toBe(
      "New York Yankees",
    );
    expect(row("Seattle Mariners").getAttribute("aria-label")).toBe(
      "Seattle Mariners",
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
      "Seattle Mariners",
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

  it("previews what the two fields compose to, live", () => {
    renderAt("/admin/teams?team=t-mariners");

    const preview = () => screen.getByText(/^Shows as:/);
    expect(preview().textContent).toBe("Shows as: Seattle Mariners");

    fireEvent.change(screen.getByLabelText("Location"), {
      target: { value: "San Diego" },
    });
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Padres" },
    });

    expect(preview().textContent).toBe("Shows as: San Diego Padres");

    // Emptying Location is a legitimate answer, not a half-typed state, and the
    // preview has to show what that actually produces.
    fireEvent.change(screen.getByLabelText("Location"), {
      target: { value: "" },
    });
    expect(preview().textContent).toBe("Shows as: Padres");
  });

  it("associates the preview with BOTH fields", () => {
    // A `<p>` under two inputs is a visual convention; nothing in the
    // accessibility tree connects them, so a screen-reader user tabbing into
    // Location would never learn what the pair composes to.
    renderAt("/admin/teams?team=t-mariners");

    const previewId = screen.getByText(/^Shows as:/).id;
    expect(previewId).toBeTruthy();
    expect(
      screen.getByLabelText("Location").getAttribute("aria-describedby"),
    ).toContain(previewId);
    expect(
      screen.getByLabelText("Name").getAttribute("aria-describedby"),
    ).toContain(previewId);
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

describe("TeamManagement — a name that is already taken", () => {
  const REFUSAL = "Another team in this sport is already called New York Yankees.";

  it("shows the refusal next to the fields instead of crashing", async () => {
    // A ConvexError, not a plain Error: production redacts a plain Error's
    // message to "Server Error", so the sentence the backend wrote for a person
    // only crosses on `data` (see `userFacingMessage`).
    mockSaveTeamFields.mockRejectedValue(new ConvexError(REFUSAL));
    renderAt("/admin/teams?team=t-mariners");

    fireEvent.change(screen.getByLabelText("Location"), {
      target: { value: "New York" },
    });
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Yankees" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(REFUSAL);
    // The draft survives: the operator's typing is what they are about to fix,
    // and re-typing it would be the screen punishing them for the refusal.
    expect(screen.getByLabelText("Name")).toHaveProperty("value", "Yankees");
    // And the panel is still there — the panel is where the fix happens.
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
  });

  it("marks both fields invalid and points them at the message", async () => {
    mockSaveTeamFields.mockRejectedValue(new ConvexError(REFUSAL));
    renderAt("/admin/teams?team=t-mariners");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    const alertId = (await screen.findByRole("alert")).id;
    for (const label of ["Location", "Name"]) {
      const field = screen.getByLabelText(label);
      expect(field.getAttribute("aria-invalid")).toBe("true");
      expect(field.getAttribute("aria-describedby")).toContain(alertId);
    }
  });

  it("takes the message away as soon as either field is edited", async () => {
    mockSaveTeamFields.mockRejectedValue(new ConvexError(REFUSAL));
    renderAt("/admin/teams?team=t-mariners");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByRole("alert");

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Mariner" },
    });

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByLabelText("Name").getAttribute("aria-invalid")).toBeNull();
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
