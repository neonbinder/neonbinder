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
 *  6. **The selected player is in the URL, both ways.** A career stint links
 *     out to `/admin/teams`, so Back has to come home to the player the
 *     operator left. Both halves are silent when they break: a deep link that
 *     lands on an unselected list still renders a perfectly correct screen, and
 *     a selection that never reaches the URL only shows up one navigation
 *     later.
 *
 * --- Mocking strategy (mirrors EntityReviewWizard.test.tsx) ---
 * convex/react's useQuery/useMutation/useAction are module-mocked and routed by
 * the (string-mocked) function reference. `SetSelector/TeamPicker` is stubbed:
 * it has its own dedicated test file, so this one only needs to prove the
 * career-history row wires its callbacks and passes the player's sport, not to
 * re-exercise a typeahead.
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

// NEO-235: the career-history rows link into Team Management, so the panel now
// needs a router around it. Every render in this file goes through the same
// wrapper rather than each call site growing one.
const render = (ui: ReactElement) =>
  renderBare(ui, { wrapper: MemoryRouter });

// ---------------------------------------------------------------------------
// Module mocks — declared before the component import
// ---------------------------------------------------------------------------

vi.mock("../../convex/_generated/api", () => ({
  api: {
    players: {
      listForManagement: "players.listForManagement",
      search: "players.search",
      get: "players.get",
      // NEO-235: the deep-link path answers out of `getByIdParam`, which takes
      // a raw string. `get` stays mocked because it stays exported.
      getByIdParam: "players.getByIdParam",
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

/**
 * A row whose stored `wikidataId` is not a `Q<digits>` id at all — a legacy
 * row, or one written before the field was validated. NEO-212 security review:
 * the detail panel must show it and must not link it.
 */
const BAD_QID_PLAYER = {
  _id: "p-badqid",
  _creationTime: 4,
  name: "Dodgy Row",
  nameNormalized: "dodgy row",
  sportId: "sport-baseball",
  externalIds: { wikidataId: "javascript:alert(1)" },
  lastUpdated: 1,
};

/**
 * NEO-235 — `TROUT` a few seconds later, once the enrichment `createByAdmin`
 * scheduled has written back. Exactly the three fields the detail panel seeds a
 * draft from that enrichment fills in: career stints, the Wikidata id and the
 * Hall of Fame flag.
 */
const ENRICHED_TROUT = {
  ...TROUT,
  isHallOfFame: true,
  externalIds: { wikidataId: "Q194298" },
  teamYears: [{ teamId: "t-reds", fromYear: 2011 }],
  lastUpdated: 2,
};

const PLAYERS_BY_ID: Record<string, unknown> = {
  "p-griffey": GRIFFEY,
  "p-trout": TROUT,
  "p-rice": RICE,
  "p-badqid": BAD_QID_PLAYER,
};

/**
 * NEO-235: `city` on one row and not the other is the whole point of the pair.
 * The master row prints the nickname a fan says out loud, which it can only do
 * for a team whose city was enriched — "Seattle Mariners" becomes "Mariners",
 * while the un-enriched Reds keep their full name. Both branches are real:
 * `teams.city` is optional and plenty of prod rows have never been enriched.
 */
/**
 * The colour pairs are chosen for what they SCORE against the master row's two
 * backgrounds (slate-900 #0f172a idle, #02192e selected), not for realism — the
 * exact ratios are in the comment on each team. Every one of the four branches
 * of `teamTextColor` has a team here, so none of them can rot unnoticed.
 */
const TEAMS = [
  {
    _id: "t-mariners",
    _creationTime: 1,
    name: "Seattle Mariners",
    city: "Seattle",
    sportId: "sport-baseball",
    // Primary clears the floor comfortably (9.8:1) — the plain case.
    colors: { primary: "#5fd3bc", secondary: "#0c2c56" },
    lastUpdated: 1,
  },
  {
    _id: "t-reds",
    _creationTime: 1,
    name: "Cincinnati Reds",
    sportId: "sport-baseball",
    // The franchise red is 2.9:1 on this row — under the floor, and exactly the
    // shape of the problem: a team's signature colour is very often the one
    // that cannot carry small text on a near-black surface. Secondary (17.9:1)
    // is what it gets printed on, and is what the row uses instead.
    colors: { primary: "#c6011f", secondary: "#ffffff" },
    lastUpdated: 1,
  },
  {
    _id: "t-drab",
    _creationTime: 1,
    name: "Midnight Navys",
    sportId: "sport-baseball",
    // 1.2:1 and 2.3:1 — a franchise built entirely out of near-blacks. Nothing
    // here is readable, so the row keeps its muted default.
    colors: { primary: "#132448", secondary: "#005c5c" },
    lastUpdated: 1,
  },
  {
    _id: "t-borderline",
    _creationTime: 1,
    name: "Borderline Blues",
    sportId: "sport-baseball",
    // Deliberately knife-edge: 4.513:1 on an IDLE row and 4.494:1 on a SELECTED
    // one, i.e. astride the 4.5 floor and on opposite sides of it. The two
    // backgrounds differ by well under a percent in luminance, so this is the
    // only way to prove the check is handed the background the row is actually
    // painted on rather than a single hardcoded one. Contrived, and says so.
    colors: { primary: "#3c84c6", secondary: "#ffffff" },
    lastUpdated: 1,
  },
];

/**
 * NEO-235 — the two fixtures the master row's team nod is decided by.
 *
 * `TRADED_TWICE` separates SUMMED tenure from longest-single-stint: four years
 * in Seattle plus another four beats one six-year run in Cincinnati, so the row
 * must say Mariners. `pickDefaultTeamYear` (the spine designer's per-stint
 * rule) would say Reds here — which is the reason the row does not use it.
 *
 * `STILL_PLAYING` pins the open-ended stint: no `toYear` means "still there",
 * counted through the current year, so nine seasons in Cincinnati beat six in
 * Seattle. Years are derived from the real current year rather than hardcoded
 * because "still there" is a fact about now; a frozen literal would quietly
 * stop testing anything as the fixture aged.
 */
const CURRENT_YEAR = new Date().getFullYear();

const TRADED_TWICE = {
  _id: "p-traded",
  _creationTime: 5,
  name: "Traded Twice",
  nameNormalized: "traded twice",
  sportId: "sport-baseball",
  teamYears: [
    { teamId: "t-mariners", fromYear: 2005, toYear: 2009 },
    { teamId: "t-reds", fromYear: 2010, toYear: 2016 },
    { teamId: "t-mariners", fromYear: 2017, toYear: 2021 },
  ],
  lastUpdated: 1,
};

const STILL_PLAYING = {
  _id: "p-current",
  _creationTime: 6,
  name: "Still Playing",
  nameNormalized: "playing still",
  sportId: "sport-baseball",
  teamYears: [
    { teamId: "t-mariners", fromYear: 1990, toYear: 1996 },
    { teamId: "t-reds", fromYear: CURRENT_YEAR - 9 },
  ],
  lastUpdated: 1,
};

/** One-team players, each pointing at one colour branch of the row label. */
const DRAB_PLAYER = {
  _id: "p-drab",
  _creationTime: 7,
  name: "Drab Fixture",
  nameNormalized: "drab fixture",
  sportId: "sport-baseball",
  teamYears: [{ teamId: "t-drab", fromYear: 2000, toYear: 2010 }],
  lastUpdated: 1,
};

const BORDERLINE_PLAYER = {
  _id: "p-borderline",
  _creationTime: 8,
  name: "Borderline Fixture",
  nameNormalized: "borderline fixture",
  sportId: "sport-baseball",
  teamYears: [{ teamId: "t-borderline", fromYear: 2000, toYear: 2010 }],
  lastUpdated: 1,
};

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
    // NEO-235: same map, and the same `?? null` for anything not in it. That
    // last part is the whole behaviour under test — the real query normalizes
    // the string first and answers `null` for one that is not an id of this
    // table at all, where `players.get` would have REJECTED the argument and
    // thrown the query into the app-level error boundary.
    case "players.getByIdParam":
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
  // the id queries answer out of this map and two NEO-235 tests move a row
  // under an open panel, so it is restored rather than left mutated.
  PLAYERS_BY_ID["p-trout"] = TROUT;
  PLAYERS_BY_ID["p-griffey"] = GRIFFEY;
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

/**
 * The team nod on a given row. Found by its `title` (the full label, which is
 * also what a truncated row recovers on hover) rather than by class or
 * position, so the assertions below survive any restyling of the row.
 */
function teamNod(playerName: RegExp): HTMLElement {
  const row = screen.getByRole("button", { name: playerName });
  const label = row.textContent?.match(/Baseball(.*)$/)?.[1]?.trim() ?? "";
  return within(row).getByTitle(label);
}

/** Open the detail panel on Ken Griffey Jr. */
function selectGriffey() {
  fireEvent.click(screen.getByRole("button", { name: /Ken Griffey Jr\./ }));
}

/**
 * The detail panel's status line must render BELOW the Save / Re-enrich row,
 * not in the page-level line at the top of the screen.
 *
 * Asserted as document order rather than "is inside the panel" because
 * position is the whole point of the fix: on a 1024x629 viewport the top line
 * sits ~600px above the button, so a message routed there is off-screen at the
 * moment it is produced. A sighted mouse user pressing Save got no visible
 * confirmation, and a failed save reported WHY somewhere they never looked;
 * `role="status"` meant AT had been told all along, which is what hid it.
 */
function expectBelowTheActionRow(el: Element) {
  const save = screen.getByRole("button", { name: /^Sav/ });
  expect(
    save.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
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

  /**
   * NEO-235 — the row says who, and which one. Sport and home franchise are the
   * two things that tell two similarly-named players apart; the Hall of Fame
   * tag, the stint count and the "Q…" Wikidata glyph tell them apart from
   * nothing, and four competing sizes and colours per row made the names — the
   * only thing anyone scans this list for — the hardest thing on it to read.
   * They are asserted as ABSENT here because they are still rendered a few
   * hundred lines away in the detail panel, so a regression that put them back
   * on the row would otherwise show up nowhere.
   */
  it("shows the sport, and none of the detail-panel badges", () => {
    render(<PlayerManagement />);
    const row = screen.getByRole("button", { name: /Ken Griffey Jr\./ });
    expect(row.textContent).toContain("Baseball");
    expect(row.textContent).not.toContain("HoF");
    expect(row.textContent).not.toContain("stint");
    expect(row.textContent).not.toContain("Q…");
  });

  it("names the team a player spent longest with, as a fan says it", () => {
    management = { players: [GRIFFEY], totalCount: 1, truncated: false };
    render(<PlayerManagement />);

    // Both of Griffey's stints are Seattle's, and Seattle has a `city`, so the
    // row drops it: "Seattle Mariners" is how the table stores the team and
    // "Mariners" is how anyone holding the card refers to it.
    const row = screen.getByRole("button", { name: /Ken Griffey Jr\./ });
    expect(row.textContent).toContain("Mariners");
    expect(row.textContent).not.toContain("Seattle");
  });

  it("keeps the full name for a team with no city recorded", () => {
    management = { players: [STILL_PLAYING], totalCount: 1, truncated: false };
    render(<PlayerManagement />);

    // A longer label is the safe failure; a wrong one is not.
    expect(
      screen.getByRole("button", { name: /Still Playing/ }).textContent,
    ).toContain("Cincinnati Reds");
  });

  it("totals a player's stints per team rather than ranking single stints", () => {
    management = { players: [TRADED_TWICE], totalCount: 1, truncated: false };
    render(<PlayerManagement />);

    // 4 + 4 in Seattle against a single 6 in Cincinnati. Ranking by longest
    // SINGLE stint — what the spine designer's `pickDefaultTeamYear` does —
    // would file him under the Reds, and the hobby would not.
    const row = screen.getByRole("button", { name: /Traded Twice/ });
    expect(row.textContent).toContain("Mariners");
    expect(row.textContent).not.toContain("Reds");
  });

  it("counts an open-ended stint through the current year", () => {
    management = { players: [STILL_PLAYING], totalCount: 1, truncated: false };
    render(<PlayerManagement />);

    // Nine seasons and counting in Cincinnati against six long-finished ones in
    // Seattle. Treating the absent `toYear` as a zero-length stint — the easy
    // bug — flips this to Mariners.
    const row = screen.getByRole("button", { name: /Still Playing/ });
    expect(row.textContent).toContain("Cincinnati Reds");
    expect(row.textContent).not.toContain("Mariners");
  });

  it("shows the sport alone for a player with no career history", () => {
    render(<PlayerManagement />);
    const row = screen.getByRole("button", { name: /Mike Trout/ });
    expect(row.textContent).toContain("Baseball");
    expect(row.textContent).not.toContain("Mariners");
    expect(row.textContent).not.toContain("Reds");
  });

  /**
   * NEO-235 — the team nod is painted in the TEAM's colours, not NeonBinder's.
   *
   * A collector recognises a franchise by its livery before they have finished
   * reading the word, which is the whole reason the owner asked for this. The
   * gate is WCAG 1.4.3 (4.5:1 for text this size) and it is a real gate, not
   * the informational readout the spine designer shows — this is UI, not ink on
   * paper. Colour never carries meaning on its own here: the label reads the
   * same word down every branch, so a muted row has lost decoration and no
   * information.
   */
  it("paints the team nod in the team's primary colour when it is readable", () => {
    management = { players: [GRIFFEY], totalCount: 1, truncated: false };
    render(<PlayerManagement />);
    expect(teamNod(/Ken Griffey Jr\./).style.color).toBe("#5fd3bc");
  });

  it("falls back to the secondary colour when the primary cannot be read", () => {
    management = { players: [STILL_PLAYING], totalCount: 1, truncated: false };
    render(<PlayerManagement />);

    // The franchise red scores 2.9:1 on this row. Its secondary is the colour
    // the team prints that red ON, so the fallback is usually the right colour
    // for the team as well as the readable one.
    expect(teamNod(/Still Playing/).style.color).toBe("#ffffff");
  });

  it("stays muted when neither team colour clears the contrast floor", () => {
    management = { players: [DRAB_PLAYER], totalCount: 1, truncated: false };
    render(<PlayerManagement />);

    // No inline colour at all — the class-level slate-300 is what shows, and
    // the label still names the team, so nothing is lost but the livery.
    const nod = teamNod(/Drab Fixture/);
    expect(nod.style.color).toBe("");
    expect(nod.textContent).toBe("Midnight Navys");
  });

  it("measures the colour against the background the row is actually painted on", () => {
    management = {
      players: [BORDERLINE_PLAYER],
      totalCount: 1,
      truncated: false,
    };
    render(<PlayerManagement />);

    // 4.513:1 on the idle row — over the floor, so the primary is used.
    expect(teamNod(/Borderline Fixture/).style.color).toBe("#3c84c6");

    // Selecting the row swaps in `bg-neon-blue/10`, and the same colour now
    // scores 4.494:1 — under it. A check hardcoded to one background would
    // leave the primary in place here.
    fireEvent.click(screen.getByRole("button", { name: /Borderline Fixture/ }));
    expect(teamNod(/Borderline Fixture/).style.color).toBe("#ffffff");
  });

  it("asks for every visible row's team in one batched lookup", () => {
    management = {
      players: [GRIFFEY, TRADED_TWICE, STILL_PLAYING],
      totalCount: 3,
      truncated: false,
    };
    render(<PlayerManagement />);

    // Three players, four teams named between them, two distinct ids — one
    // query, deduped. A per-row lookup would open a subscription per row, and
    // this list holds up to 500.
    const ids = lastArgs("teams.getManyByIds")?.ids as string[];
    expect([...ids].sort()).toEqual(["t-mariners", "t-reds"]);
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

    // EXACTLY ONE `Open Ken Griffey Jr.` control. The promoted primary IS the
    // exact panel row, so that row is filtered out of the panel — two controls
    // sharing one accessible name is ambiguous to a screen reader reading the
    // list and to a Maestro `tapOn` matching by it. Same rule the wizard
    // already applies to `Link to {name}`.
    await waitFor(() =>
      expect(
        screen.getAllByRole("button", { name: "Open Ken Griffey Jr." }),
      ).toHaveLength(1),
    );
    expect(
      screen.getByLabelText("Create player Ken Griffey Jr. anyway"),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Create player Ken Griffey Jr." }),
    ).toBeNull();

    // The green button opens the row rather than creating a second one.
    fireEvent.click(
      screen.getByRole("button", { name: "Open Ken Griffey Jr." }),
    );
    expect(mockCreateByAdmin).not.toHaveBeenCalled();
    expect(
      screen.getByRole("heading", { level: 3, name: "Ken Griffey Jr." }),
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
      screen.getByRole("heading", { level: 3, name: "Mike Trout" }),
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

  it("links each stint to its team in Team Management", () => {
    // NEO-235. Two assertions, and the second is the load-bearing one: the
    // link wraps the WHOLE "{team} · {years}" string. A link around the team
    // name alone would leave the row reading as two separate pieces of text,
    // which is what both the Maestro flow (it matches that string and anchors
    // a `below:` assertion on it) and the row-order test above depend on.
    render(<PlayerManagement />);
    selectGriffey();

    const rows = screen
      .getByRole("list", { name: "Career history" })
      .querySelectorAll("li");

    const links = Array.from(rows).map((li) => li.querySelector("a"));
    expect(links.map((a) => a?.getAttribute("href"))).toEqual([
      "/admin/teams?team=t-mariners",
      "/admin/teams?team=t-mariners",
    ]);
    // The visible text is the accessible name — no aria-label overriding it.
    expect(links.map((a) => a?.textContent)).toEqual([
      "Seattle Mariners · 1989–1999",
      "Seattle Mariners · 2009–present",
    ]);
    expect(links[0]?.getAttribute("title")).toBe(
      "Open Seattle Mariners in Team Management",
    );

    // The row's own text is unchanged by the link — see above.
    expect(Array.from(rows).map((li) => li.textContent)).toEqual([
      "Seattle Mariners · 1989–1999Remove stint",
      "Seattle Mariners · 2009–presentRemove stint",
    ]);
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

    // By role: the list's "HoF" badge now carries aria-label="Hall of Fame"
    // too (NEO-212 a11y), so a bare label lookup is ambiguous.
    fireEvent.click(screen.getByRole("checkbox", { name: "Hall of Fame" }));
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
      screen.getByRole("heading", { level: 3, name: "Mike Trout" }),
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

  it("shows a malformed stored Wikidata id as text, never as a link", () => {
    // NEO-212 security review. A stored `externalIds.wikidataId` is not
    // necessarily operator-typed at the moment it renders: it can come from
    // the SPARQL adapter, or from a row written before `savePlayerFields`
    // validated the field. Interpolating it into an `href` is how a
    // `javascript:` URL reaches an anchor, and React warns and renders it
    // anyway. `wikidataUrl` returning null is the guard.
    //
    // The value is still shown — this is the admin page whose whole job is to
    // let the operator SEE and fix a bad id — just never as a destination.
    management = { players: [BAD_QID_PLAYER], totalCount: 1, truncated: false };
    render(<PlayerManagement />);
    fireEvent.click(screen.getByRole("button", { name: /Dodgy Row/ }));

    expect(screen.queryByRole("link", { name: /Wikidata/ })).toBeNull();
    expect(screen.getByText("Wikidata javascript:alert(1)")).toBeTruthy();
    for (const a of Array.from(document.querySelectorAll("a"))) {
      expect(a.getAttribute("href") ?? "").not.toContain("javascript:");
    }
  });

  it("prints Re-enrich's label in black on its blue fill", () => {
    // NeonButton's `secondary` paints white on #00C2FF — 2.07:1, under SC
    // 1.4.3's 4.5:1 floor. Black on the same blue is 10.1:1, and is already
    // what "Add stint" above it does.
    render(<PlayerManagement />);
    selectGriffey();

    const button = screen.getByRole("button", {
      name: "Re-enrich from Wikidata",
    }) as HTMLElement;
    expect(button.style.color).toBe("#000000");
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
    const said = await screen.findByText(
      "Enrichment queued — it lands in a moment.",
    );
    expect(said.getAttribute("role")).toBe("status");
    expectBelowTheActionRow(said);
  });

  it("confirms a save under the button that was pressed", async () => {
    render(<PlayerManagement />);
    selectGriffey();

    fireEvent.click(screen.getByRole("checkbox", { name: "Hall of Fame" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    // Byte-identical text — including the doubled stop, because the fixture's
    // name already ends in one. The E2E flow waits on /.*Saved PM-….*/.
    const said = await screen.findByText("Saved Ken Griffey Jr..");
    expect(said.getAttribute("role")).toBe("status");
    expectBelowTheActionRow(said);
    // Exactly one live region says it — routing it to the panel must not also
    // leave a copy in the page-level line.
    expect(screen.getAllByText("Saved Ken Griffey Jr..")).toHaveLength(1);
  });

  it("reports a failed save where the operator can see the reason", async () => {
    // A plain Error, not a ConvexError: production redacts those, so the
    // fallback string is what a real operator would be reading.
    mockSavePlayerFields.mockRejectedValue(new Error("boom"));
    render(<PlayerManagement />);
    selectGriffey();

    fireEvent.click(screen.getByRole("checkbox", { name: "Hall of Fame" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    const said = await screen.findByText("Could not save that player.");
    expect(said.getAttribute("role")).toBe("alert");
    expectBelowTheActionRow(said);
  });

  it("clears the panel's status when a different player is opened", async () => {
    render(<PlayerManagement />);
    selectGriffey();

    fireEvent.click(screen.getByRole("checkbox", { name: "Hall of Fame" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Saved Ken Griffey Jr..")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Mike Trout/ }));
    expect(screen.queryByText("Saved Ken Griffey Jr..")).toBeNull();
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

// ---------------------------------------------------------------------------
// NEO-235 — the panel follows the live row, and says so when it cannot
// ---------------------------------------------------------------------------

describe("PlayerManagement — an enrichment landing under an open panel", () => {
  /** Open Mike Trout, then let the scheduled enrichment write back. */
  function enrichUnderTheOpenPanel(
    rerender: ReturnType<typeof render>["rerender"],
  ) {
    PLAYERS_BY_ID["p-trout"] = ENRICHED_TROUT;
    rerender(<PlayerManagement />);
  }

  it("adopts the enriched row while the draft is untouched", () => {
    // The bug NEO-235 was filed for: `createByAdmin` schedules enrichment, the
    // row grows stints/QID/HoF seconds later, and every part of the screen
    // reading the row directly moved while the draft did not — so the header
    // link showed the QID over a Wikidata box that was still empty.
    const { rerender } = render(<PlayerManagement />);
    fireEvent.click(screen.getByRole("button", { name: /Mike Trout/ }));
    expect(screen.getByText("No stints recorded yet.")).toBeTruthy();

    enrichUnderTheOpenPanel(rerender);

    expect(
      (screen.getByLabelText("Wikidata id") as HTMLInputElement).value,
    ).toBe("Q194298");
    expect(
      (screen.getByRole("checkbox", { name: "Hall of Fame" }) as HTMLInputElement)
        .checked,
    ).toBe(true);
    expect(screen.getByText("Cincinnati Reds · 2011–present")).toBeTruthy();
    // Adopted silently: nothing was at risk, so there is nothing to report...
    expect(screen.queryByText(/updated elsewhere/)).toBeNull();
    // ...and the draft now equals the row, so there is nothing to save either.
    expect(
      screen.getByRole("button", { name: "Save" }).hasAttribute("disabled"),
    ).toBe(true);
  });

  it("keeps a dirty draft, and reloads it only when asked", () => {
    const { rerender } = render(<PlayerManagement />);
    fireEvent.click(screen.getByRole("button", { name: /Mike Trout/ }));
    fireEvent.change(screen.getByLabelText("Player name"), {
      target: { value: "Michael Trout" },
    });

    enrichUnderTheOpenPanel(rerender);

    // Not one keystroke of the operator's is overwritten.
    expect(
      (screen.getByLabelText("Player name") as HTMLInputElement).value,
    ).toBe("Michael Trout");
    expect(
      (screen.getByLabelText("Wikidata id") as HTMLInputElement).value,
    ).toBe("");
    const notice = screen.getByText(
      "This player was updated elsewhere — Reload to see the latest.",
    );
    expect(notice.closest("[role='status']")).toBeTruthy();

    // Reload is the only thing that discards it, and it takes the whole row.
    fireEvent.click(screen.getByLabelText("Reload player Mike Trout"));
    expect(
      (screen.getByLabelText("Player name") as HTMLInputElement).value,
    ).toBe("Mike Trout");
    expect(
      (screen.getByLabelText("Wikidata id") as HTMLInputElement).value,
    ).toBe("Q194298");
    expect(screen.getByText("Cincinnati Reds · 2011–present")).toBeTruthy();
    expect(screen.queryByText(/updated elsewhere/)).toBeNull();
  });

  it("still saves the fields the operator changed afterwards", async () => {
    const { rerender } = render(<PlayerManagement />);
    fireEvent.click(screen.getByRole("button", { name: /Mike Trout/ }));
    enrichUnderTheOpenPanel(rerender);

    // Edit the value the enrichment just wrote — the case that proves the
    // re-seed rebased what "changed" means rather than merely repainting.
    fireEvent.click(screen.getByRole("checkbox", { name: "Hall of Fame" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(mockSavePlayerFields).toHaveBeenCalledWith({
        id: "p-trout",
        isHallOfFame: false,
      }),
    );
    expect(await screen.findByText("Saved Mike Trout.")).toBeTruthy();
  });

  it("never reports the panel's own save as a change from elsewhere", async () => {
    // The reactive write a save produces looks exactly like anyone else's. It
    // is told apart by the draft already matching it — not by a timer, and not
    // by assuming the mutation resolves before its own query update lands.
    const { rerender } = render(<PlayerManagement />);
    selectGriffey();
    fireEvent.click(screen.getByRole("checkbox", { name: "Hall of Fame" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Saved Ken Griffey Jr..")).toBeTruthy();

    PLAYERS_BY_ID["p-griffey"] = { ...GRIFFEY, isHallOfFame: false };
    rerender(<PlayerManagement />);

    expect(screen.queryByText(/updated elsewhere/)).toBeNull();
    expect(
      screen.getByRole("button", { name: "Save" }).hasAttribute("disabled"),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// NEO-212 — accessibility fixes from the WCAG 2.2 AA audit
// ---------------------------------------------------------------------------

describe("PlayerManagement — accessibility", () => {
  it("filters the promoted exact row out of the panel but keeps the others", async () => {
    nearMatches = [
      { _id: "p-griffey", name: "Ken Griffey Jr.", confidence: "exact" },
      { _id: "p-griffey-sr", name: "Ken Griffey", confidence: "close" },
    ];
    const { container } = render(<PlayerManagement />);
    openAddForm(container);
    fireEvent.change(screen.getByLabelText("New player name"), {
      target: { value: "Ken Griffey Jr." },
    });

    // The promoted row appears exactly once, as the primary button...
    await waitFor(() =>
      expect(
        screen.getAllByRole("button", { name: "Open Ken Griffey Jr." }),
      ).toHaveLength(1),
    );
    // ...and a genuinely different player is still listed for the operator.
    expect(screen.getByText("Possible matches")).toBeTruthy();
    expect(screen.getByLabelText("Open Ken Griffey")).toBeTruthy();
  });

  it("keeps focus on the primary action when an exact match arrives", async () => {
    // `nearMatches` lands ~300ms after typing stops, so the primary can swap
    // roles while it already has focus. One element, props toggled — React
    // patches it instead of remounting, and focus does not fall to <body>.
    nearMatches = undefined;
    const { container } = render(<PlayerManagement />);
    openAddForm(container);
    fireEvent.change(screen.getByLabelText("New player name"), {
      target: { value: "Ken Griffey Jr." },
    });

    const primary = screen.getByRole("button", {
      name: "Create player Ken Griffey Jr.",
    });
    primary.focus();
    expect(document.activeElement).toBe(primary);

    nearMatches = [
      { _id: "p-griffey", name: "Ken Griffey Jr.", confidence: "exact" },
    ];
    // Any state change re-runs the mocked useQuery and re-renders the form.
    fireEvent.change(screen.getByLabelText("New player name"), {
      target: { value: "Ken Griffey Jr. " },
    });

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Open Ken Griffey Jr." }),
      ).toBe(primary),
    );
    expect(document.activeElement).toBe(primary);
    expect(document.activeElement?.tagName).toBe("BUTTON");
    expect(document.activeElement).not.toBe(document.body);
  });

  it("announces the result counter as it changes", () => {
    // The counter is the only feedback a filter did anything. Silent for a
    // screen-reader user until it was a live region; the E2E flow waits on the
    // text, so the FORMAT must not move.
    render(<PlayerManagement />);
    const counter = screen.getByText("3 of 3 players");
    expect(counter.getAttribute("role")).toBe("status");
    expect(counter.getAttribute("aria-live")).toBe("polite");
  });

  it("reads the row out as a name, a sport and a team", () => {
    // NEO-235: the row used to end in two unexplained glyphs ("HoF", "Q…")
    // carrying their expansion as aria-labels. Both are gone, and what replaced
    // them needs no expansion — the separator between the sport and the team is
    // a CSS border, so it contributes nothing to the accessible name and the
    // button announces the three plain words a person would say out loud.
    management = { players: [GRIFFEY], totalCount: 1, truncated: false };
    render(<PlayerManagement />);
    expect(
      screen.getByRole("button", { name: "Ken Griffey Jr. Baseball Mariners" }),
    ).toBeTruthy();
  });

  it("renders the row's sport tag at a contrast-passing slate", () => {
    // happy-dom performs no layout and resolves no Tailwind, so the class that
    // produces the colour is the only observable — same idiom the wizard's
    // readability block uses. slate-500 on the row is 4.0:1, under SC 1.4.3.
    render(<PlayerManagement />);
    // Scoped to the row: "Baseball" is also an <option> in the sport filter.
    const row = screen.getByRole("button", { name: /Ken Griffey Jr\./ });
    const tag = Array.from(row.querySelectorAll("span")).find(
      (el) => el.textContent === "Baseball",
    );
    expect(tag?.className).toContain("text-slate-400");
    expect(tag?.className).not.toContain("text-slate-500");
  });
});

// ---------------------------------------------------------------------------

/**
 * NEO-235 — `?player=<id>`, the other end of the career-history link.
 *
 * The detail panel links every stint to `/admin/teams?team=<id>`. Back from
 * there is only useful if this screen's own history entry names the player who
 * was open, which is why selecting writes the param with `replace` rather than
 * pushing: the entry the operator leaves is the entry they come back to, and
 * they do not have to walk back through every row they looked at first.
 *
 * The deep link is deliberately NOT resolved against the master list. That
 * list is a 500-row page of a server-side query, so the player behind a shared
 * link is frequently not in it; the id goes to `players.getByIdParam` instead,
 * and the panel opens either way. That query takes the param as a raw STRING
 * and normalizes it server-side, so a hand-mangled `?player=` is an empty
 * panel rather than a rejected argument that throws the render away.
 */

// The URL is half of what is under test here, so it is rendered.
function LocationProbe() {
  return <span data-testid="search">{useLocation().search}</span>;
}

function renderAt(entry: string) {
  // A FRESH element each time, deliberately: handing `rerender` the identical
  // element object lets React bail out of the subtree entirely, and a rerender
  // that renders nothing proves nothing. The router itself stays mounted, so
  // the history it has accumulated survives — `initialEntries` only ever seeds
  // the first mount.
  const tree = () => (
    <MemoryRouter initialEntries={[entry]}>
      <PlayerManagement />
      <LocationProbe />
    </MemoryRouter>
  );
  // `renderBare`, not the file-level `render`: that one supplies its own
  // MemoryRouter at "/" and this needs the entry to carry a query string.
  const result = renderBare(tree());
  return { ...result, rerenderTree: () => result.rerender(tree()) };
}

const url = () => screen.getByTestId("search").textContent;
const listRow = (name: RegExp) => screen.getByRole("button", { name });

describe("PlayerManagement — the ?player deep link", () => {
  it("opens a player the master list has no row for", () => {
    // The case the id query exists for: a truncated page that does not contain
    // the linked player. Resolving the param against `visible` would answer
    // "no such player" for everyone past the cap — on the screen whose whole
    // job is to be reachable by id.
    management = { players: [RICE], totalCount: 500, truncated: true };
    renderAt("/admin/players?player=p-griffey");

    expect(screen.getByLabelText("Player name")).toHaveProperty(
      "value",
      "Ken Griffey Jr.",
    );
    // No row was highlighted because there is no row — the panel came from
    // the id query alone.
    expect(document.querySelector('[aria-current="true"]')).toBeNull();
    expect(lastArgs("players.getByIdParam")).toEqual({ id: "p-griffey" });
  });

  it("selects and scrolls to the row when the list does have one", () => {
    // The scroll matters as much as the selection: the master list is a 32rem
    // scroller, so a selected row can land off-screen and the link would look
    // like it did nothing.
    const scrollIntoView = vi
      .spyOn(Element.prototype, "scrollIntoView")
      .mockImplementation(() => {});

    renderAt("/admin/players?player=p-trout");

    expect(listRow(/Mike Trout/).getAttribute("aria-current")).toBe("true");
    expect(listRow(/Ken Griffey Jr\./).getAttribute("aria-current")).toBeNull();
    expect(screen.getByLabelText("Player name")).toHaveProperty(
      "value",
      "Mike Trout",
    );
    expect(scrollIntoView).toHaveBeenCalled();

    scrollIntoView.mockRestore();
  });

  it("leaves the screen alone for an id this deployment does not have", () => {
    // A stale link, or one copied from another deployment. Not an error state:
    // there is nothing an operator could do about it here, so the screen opens
    // exactly as it always does.
    renderAt("/admin/players?player=p-gone");

    expect(document.querySelector('[aria-current="true"]')).toBeNull();
    expect(
      screen.getByText(
        "Select a player to see and edit everything we know about them.",
      ),
    ).toBeTruthy();
  });

  it("renders normally for a param that is not an id at all", () => {
    // Not the same case as the stale id above, and it used to have a very
    // different outcome. `?player=p-gone` is a WELL-FORMED id for a row this
    // deployment does not have; `?player=not-an-id` does not parse as an id of
    // any table. The screen used to hand the raw string to `players.get`, whose
    // argument is `v.id("players")`, so Convex refused it before the handler
    // ran and `useQuery` threw — replacing the whole admin screen with the
    // app-level error boundary because somebody mangled a query string.
    //
    // `players.getByIdParam` takes a string and normalizes it server-side, so
    // an unparseable id is answered `null` and lands in the SAME placeholder
    // branch as a deleted one. Asserted as "the page is still here", because
    // the defect's signature was the page not being here.
    renderAt("/admin/players?player=not-an-id");

    expect(lastArgs("players.getByIdParam")).toEqual({ id: "not-an-id" });
    expect(document.querySelector('[aria-current="true"]')).toBeNull();
    expect(
      screen.getByText(
        "Select a player to see and edit everything we know about them.",
      ),
    ).toBeTruthy();
    // The master list is untouched: this is a normal render, not a recovery.
    expect(listRow(/Mike Trout/)).toBeTruthy();
  });

  it("writes the param when a row is picked", () => {
    renderAt("/admin/players");
    expect(url()).toBe("");

    fireEvent.click(listRow(/Ken Griffey Jr\./));

    expect(listRow(/Ken Griffey Jr\./).getAttribute("aria-current")).toBe("true");
    expect(url()).toBe("?player=p-griffey");
  });

  it("writes the param for a player it has just created", async () => {
    // The new row is selected by `onCreated`, so the URL has to follow it
    // there too — an operator who adds a player and then clicks into their
    // first team must be able to come back to them.
    const { container } = renderAt("/admin/players");
    openAddForm(container);
    fireEvent.change(screen.getByLabelText("New player name"), {
      target: { value: "Mike Trout" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Create player Mike Trout" }),
    );

    await waitFor(() => expect(screen.getByText("Added Mike Trout.")).toBeTruthy());
    // `waitFor` on the URL too, not a bare assertion after the toast — this
    // one flaked in CI (PR #226) roughly one run in three under load, always
    // as `expected '' to be '?player=p-trout'`.
    //
    // The two values settle at DIFFERENT React priorities. The toast is
    // ordinary state set when the create mutation resolves; the URL comes from
    // `setSearchParams`, which React Router applies inside `startTransition`
    // (see the long note above `useSearchParams` in PlayerManagement.tsx —
    // this screen relies on that lag, it is not an accident). `waitFor` returns
    // the instant its own condition holds, so it can return on the commit that
    // painted the toast while the lower-priority location update is still
    // queued, and the next line reads the URL one render too early.
    //
    // The file's three OTHER `expect(url())` assertions follow a synchronous
    // `fireEvent`, whose `act()` drains pending work including the transition,
    // which is why only this one — the only one behind an `await` — ever
    // flaked. Nothing is lost here, only late: `setSearchParams` is called
    // unconditionally in `selectPlayer` with nothing to interrupt or unmount
    // it, so the write always lands. Same assertion, same final state, minus
    // the assumption that a transition commits in lockstep with unrelated
    // ordinary state.
    await waitFor(() => expect(url()).toBe("?player=p-trout"));
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
    // player — indistinguishable, to a screen that remembers only the last id
    // it followed, from a fresh link back to them. It follows the stale param,
    // clears the filters as any link does, and the operator watches the word
    // they just typed vanish under their own click.
    management = undefined;
    const { rerenderTree } = renderAt("/admin/players?player=p-griffey");

    fireEvent.change(screen.getByLabelText("Filter players"), {
      target: { value: "Dodgy" },
    });
    expect(screen.getByLabelText("Filter players")).toHaveProperty(
      "value",
      "Dodgy",
    );

    // The list arrives; the link is followed now, and takes the box with it.
    management = { players: [RICE, GRIFFEY, TROUT], totalCount: 3, truncated: false };
    rerenderTree();

    expect(screen.getByLabelText("Filter players")).toHaveProperty("value", "");
    expect(listRow(/Ken Griffey Jr\./).getAttribute("aria-current")).toBe("true");

    // One character stays client-side, so the row list here is the loaded page
    // filtered in the browser — no debounce to wait on.
    fireEvent.change(screen.getByLabelText("Filter players"), {
      target: { value: "r" },
    });
    fireEvent.click(listRow(/Mike Trout/));

    expect(url()).toBe("?player=p-trout");
    expect(screen.getByLabelText("Filter players")).toHaveProperty("value", "r");
    expect(listRow(/Mike Trout/).getAttribute("aria-current")).toBe("true");
  });
});
