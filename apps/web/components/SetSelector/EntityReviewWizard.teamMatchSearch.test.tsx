/**
 * NEO-307 — the wizard's New Team step can link to a team the near-match
 * ranking did not surface.
 *
 * Jason, 2026-09-25, on "Brooklyn Dodgers" (Baseball): the Possible matches
 * panel listed Brooklyn Bridegrooms, Cyclones, Eagles and Gladiators — not the
 * Brooklyn Dodgers NB already holds (MLB, 1911–1957). The panel now carries a
 * "Search all teams" type-ahead; this file proves, at the wizard level, that:
 *
 *  - on a TEAM step it IS the Possible matches box — no list of Link buttons —
 *    pre-filled with the row's name; it is there on every team step, with or
 *    without near matches; players keep their panel;
 *  - typing and picking a team that is NOT among the near matches records
 *    exactly the decision a near-match click records — `action: "link"`,
 *    `linkedTeamId`, and the "Remember … as a name" answer (`saveAsAlias`),
 *    ticked or not;
 *  - "Link to Existing…" is gone from team steps and stays for players;
 *  - the lone exact match stays the footer primary, era included, and is not
 *    offered a second time in the type-ahead.
 *
 * Its own file, with its own mocks, rather than more blocks in
 * `EntityReviewWizard.test.tsx`: that file is being reworked for the New Team
 * form's League field in the same change, and the two sets of tests have no
 * fixtures in common. Mocking follows that file's pattern (string-routed
 * `useQuery`, `EntityLinkSearch` stubbed).
 */

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Id } from "../../convex/_generated/dataModel";

const DEBOUNCE_MS = 200;
const SPORT_ID = "selopt-sport-baseball";

vi.mock("../../convex/_generated/api", () => ({
  api: {
    entityReviewQueue: {
      getBatch: "entityReviewQueue.getBatch",
      recordDecision: "entityReviewQueue.recordDecision",
      clearDecision: "entityReviewQueue.clearDecision",
      cancelBatch: "entityReviewQueue.cancelBatch",
      recordAllRemainingAsCreate: "entityReviewQueue.recordAllRemainingAsCreate",
      recordAllRemainingAsSkip: "entityReviewQueue.recordAllRemainingAsSkip",
      stageCareerTeamRows: "entityReviewQueue.stageCareerTeamRows",
      clearCareerTeamStint: "entityReviewQueue.clearCareerTeamStint",
      stageLeagueRows: "entityReviewQueue.stageLeagueRows",
    },
    players: {
      nearMatches: "players.nearMatches",
      search: "players.search",
      getManyByIds: "players.getManyByIds",
    },
    teams: {
      nearMatches: "teams.nearMatches",
      search: "teams.search",
      getManyByIds: "teams.getManyByIds",
      resolveNames: "teams.resolveNames",
    },
    leagues: { list: "leagues.list" },
  },
}));

const MLB = { _id: "lg-mlb", name: "Major League Baseball", abbreviation: "MLB" };

type TeamRow = {
  _id: string;
  name: string;
  location?: string;
  leagueId?: string;
  yearsActive?: { from: number; to?: number };
};
const BROOKLYN_DODGERS: TeamRow = {
  _id: "t-bkn-dodgers",
  location: "Brooklyn",
  name: "Dodgers",
  leagueId: MLB._id,
  yearsActive: { from: 1911, to: 1957 },
};
const LA_DODGERS: TeamRow = {
  _id: "t-la-dodgers",
  location: "Los Angeles",
  name: "Dodgers",
  leagueId: MLB._id,
  yearsActive: { from: 1958 },
};
const BROOKLYN_OTHERS: TeamRow[] = [
  { _id: "t-bridegrooms", location: "Brooklyn", name: "Bridegrooms", leagueId: MLB._id },
  { _id: "t-cyclones", location: "Brooklyn", name: "Cyclones" },
  { _id: "t-eagles", location: "Brooklyn", name: "Eagles" },
  { _id: "t-gladiators", location: "Brooklyn", name: "Gladiators" },
];
const ALL_TEAMS = [BROOKLYN_DODGERS, LA_DODGERS, ...BROOKLYN_OTHERS];
/** Jason's panel: four other Brooklyn clubs, and not the Dodgers. */
const JASONS_NEAR_MATCHES = BROOKLYN_OTHERS.map((t) => ({
  _id: t._id,
  name: `${t.location} ${t.name}`,
  confidence: "close" as const,
}));

let currentRows: unknown;
let currentNearMatches: unknown;
let queryCalls: Array<{ ref: string; args: unknown }>;
const mockRecordDecision = vi.fn();

vi.mock("convex/react", () => ({
  useQuery: (ref: string, args: unknown) => {
    queryCalls.push({ ref, args });
    if (args === "skip") return undefined;
    if (ref === "entityReviewQueue.getBatch") return currentRows;
    if (ref === "players.nearMatches" || ref === "teams.nearMatches")
      return currentNearMatches;
    if (ref === "leagues.list") return [MLB];
    if (ref === "teams.getManyByIds") {
      const ids = (args as { ids: string[] }).ids;
      return ALL_TEAMS.filter((t) => ids.includes(t._id));
    }
    if (ref === "teams.search") {
      const q = (args as { query: string }).query.toLowerCase();
      return ALL_TEAMS.filter((t) =>
        `${t.location ?? ""} ${t.name}`.toLowerCase().includes(q),
      );
    }
    return undefined;
  },
  useMutation: (ref: string) => {
    if (ref === "entityReviewQueue.recordDecision") return mockRecordDecision;
    return vi.fn(() => Promise.resolve(undefined));
  },
  useAction: () => vi.fn(() => Promise.resolve({ decided: 0, hasMore: false, cursor: null })),
}));

vi.mock("./EntityLinkSearch", () => ({
  default: () => <div aria-label="Entity link search (stub)" />,
}));

import EntityReviewWizard from "./EntityReviewWizard";

let nextRowId = 0;
function makeRow(overrides: Record<string, unknown> = {}) {
  nextRowId += 1;
  return {
    _id: `row-${nextRowId}` as unknown as Id<"entityReviewQueue">,
    _creationTime: nextRowId,
    selectorOptionId: "selopt-1",
    batchId: "batch-1",
    kind: "team",
    name: "Brooklyn Dodgers",
    sportId: SPORT_ID,
    sportValue: "Baseball",
    status: "ready",
    ...overrides,
  };
}

function renderWizard() {
  return render(
    <EntityReviewWizard
      isOpen
      selectorOptionId={"selopt-1" as unknown as Id<"selectorOptions">}
      batchId="batch-1"
      summary={{ cardCount: 3, deleteCount: 0, reviewDecisionCount: 0 }}
      onConfirm={vi.fn()}
      onCancel={vi.fn()}
    />,
  );
}

const teamSearch = () =>
  screen.getByRole("combobox", { name: "Search all teams" }) as HTMLInputElement;

/** Type into the team search and let the debounce fire. */
function typeTeamSearch(value: string) {
  fireEvent.focus(teamSearch());
  fireEvent.change(teamSearch(), { target: { value } });
  act(() => {
    vi.advanceTimersByTime(DEBOUNCE_MS);
  });
}

/** The option whose label (its direct text, what a flow matches) is `label`. */
function optionLabelled(label: string): HTMLElement {
  const listbox = screen.getByRole("listbox", { name: "Search all teams suggestions" });
  const match = within(listbox)
    .getAllByRole("option")
    .find((o) =>
      Array.from(o.childNodes).some(
        (n) => n.nodeType === Node.TEXT_NODE && n.textContent === label,
      ),
    );
  if (!match) throw new Error(`no option labelled ${label}`);
  return match;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRecordDecision.mockResolvedValue(null);
  currentRows = [];
  currentNearMatches = [];
  queryCalls = [];
  nextRowId = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("EntityReviewWizard — NEO-307 team search in Possible matches", () => {
  it("IS the Possible matches box on a team step: the type-ahead, holding the row's name, and no Link buttons", () => {
    currentRows = [makeRow()];
    currentNearMatches = JASONS_NEAR_MATCHES;
    renderWizard();

    const panelHeading = screen.getByText("Possible matches");
    expect(panelHeading.parentElement?.contains(teamSearch())).toBe(true);
    expect(teamSearch().value).toBe("Brooklyn Dodgers");
    // No button list for teams any more — the near matches are options.
    expect(screen.queryByLabelText("Link to Brooklyn Gladiators")).toBeNull();
    expect(screen.queryByRole("list", { name: "Possible team matches" })).toBeNull();
    fireEvent.focus(teamSearch());
    expect(optionLabelled("Brooklyn Gladiators")).toBeTruthy();
  });

  it("is on a team step with NO near matches too: caption only, and nothing listed until the operator types", () => {
    vi.useFakeTimers();
    currentRows = [makeRow({ name: "Brooklyn Robins" })];
    currentNearMatches = [];
    renderWizard();

    expect(screen.queryByText("Possible matches")).toBeNull();
    expect(teamSearch().value).toBe("Brooklyn Robins");
    fireEvent.focus(teamSearch());
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(teamSearch().getAttribute("aria-expanded")).toBe("false");
    // The "Remember …" box is shown on every team step (Jason, 2026-09-25).
    const remember = screen.getByLabelText(
      "Remember “Brooklyn Robins” as a name for this team",
    );
    expect(remember.closest("[hidden]")).toBeNull();

    typeTeamSearch("Dodgers");
    expect(optionLabelled("Brooklyn Dodgers")).toBeTruthy();
  });

  it("is not offered on a player step", () => {
    currentRows = [makeRow({ kind: "player", name: "Mike Trout" })];
    currentNearMatches = [{ _id: "p1", name: "Michael Trout", confidence: "close" }];
    renderWizard();
    expect(screen.getByText("Possible matches")).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "Search all teams" })).toBeNull();
  });

  it("typing 'Dodgers' and picking the existing Brooklyn Dodgers records the same link a near-match click does", async () => {
    vi.useFakeTimers();
    const row = makeRow();
    currentRows = [row];
    currentNearMatches = JASONS_NEAR_MATCHES;
    renderWizard();

    typeTeamSearch("Dodgers");
    // Searched on the server, in this row's sport.
    expect(
      queryCalls.some(
        (c) =>
          c.ref === "teams.search" &&
          c.args !== "skip" &&
          (c.args as { query: string; sportId: string }).query === "Dodgers" &&
          (c.args as { sportId: string }).sportId === SPORT_ID,
      ),
    ).toBe(true);

    const option = optionLabelled("Brooklyn Dodgers");
    // League and years on the second line tell it from the Los Angeles club.
    expect(option.textContent).toContain("MLB · 1911–1957");
    expect(optionLabelled("Los Angeles Dodgers").textContent).toContain(
      "MLB · 1958–present",
    );

    fireEvent.mouseDown(option);
    vi.useRealTimers();

    await waitFor(() => {
      expect(mockRecordDecision).toHaveBeenCalledTimes(1);
    });
    expect(mockRecordDecision).toHaveBeenCalledWith({
      reviewRowId: row._id,
      action: "link",
      linkedPlayerId: undefined,
      linkedTeamId: BROOKLYN_DODGERS._id,
      linkedLeagueId: undefined,
      // NEO-284 — ticked by default, exactly as for a near-match row.
      saveAsAlias: true,
    });
  });

  it("carries an unticked 'Remember …' through, as every team link path does", async () => {
    vi.useFakeTimers();
    const row = makeRow();
    currentRows = [row];
    currentNearMatches = JASONS_NEAR_MATCHES;
    renderWizard();

    fireEvent.click(
      screen.getByLabelText("Remember “Brooklyn Dodgers” as a name for this team"),
    );
    typeTeamSearch("Dodgers");
    fireEvent.keyDown(teamSearch(), { key: "Enter" });
    vi.useRealTimers();

    await waitFor(() => {
      expect(mockRecordDecision).toHaveBeenCalledWith(
        expect.objectContaining({
          reviewRowId: row._id,
          action: "link",
          linkedTeamId: BROOKLYN_DODGERS._id,
          saveAsAlias: false,
        }),
      );
    });
  });

  it("drops 'Link to Existing…' from team steps and keeps it for players", () => {
    currentRows = [makeRow()];
    currentNearMatches = JASONS_NEAR_MATCHES;
    const { unmount } = renderWizard();
    expect(screen.queryByRole("button", { name: "Link to existing instead" })).toBeNull();
    unmount();

    currentRows = [makeRow({ kind: "player", name: "Mike Trout" })];
    currentNearMatches = [];
    renderWizard();
    fireEvent.click(screen.getByRole("button", { name: "Link to existing instead" }));
    expect(screen.getByLabelText("Entity link search (stub)")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// NEO-307 — the exact-match primary names the ERA it links to
// ---------------------------------------------------------------------------

describe("EntityReviewWizard — NEO-307 exact-match primary carries the era", () => {
  const exactDodgers = (yearsActive?: { from: number; to?: number }) => ({
    _id: BROOKLYN_DODGERS._id,
    name: "Brooklyn Dodgers",
    confidence: "exact" as const,
    ...(yearsActive ? { yearsActive } : {}),
  });

  it("a closed era: 'Link to Brooklyn Dodgers · 1911–1957', visible and announced alike", async () => {
    const row = makeRow();
    currentRows = [row];
    currentNearMatches = [exactDodgers({ from: 1911, to: 1957 })];
    renderWizard();

    const primary = screen.getByRole("button", {
      name: "Link to Brooklyn Dodgers · 1911–1957",
    });
    // Label in name (SC 2.5.3): the words on the button are the whole name.
    expect(primary.textContent).toBe("Link to Brooklyn Dodgers · 1911–1957");
    // Creating survives as the demoted link.
    expect(screen.getByText("Add as New Team anyway")).toBeTruthy();

    fireEvent.click(primary);
    await waitFor(() => {
      expect(mockRecordDecision).toHaveBeenCalledWith(
        expect.objectContaining({
          reviewRowId: row._id,
          action: "link",
          linkedTeamId: BROOKLYN_DODGERS._id,
          saveAsAlias: true,
        }),
      );
    });
  });

  it("the promoted exact row is not offered again in the type-ahead", () => {
    currentRows = [makeRow()];
    currentNearMatches = [exactDodgers({ from: 1911, to: 1957 }), ...JASONS_NEAR_MATCHES];
    renderWizard();

    expect(
      screen.getByRole("button", { name: "Link to Brooklyn Dodgers · 1911–1957" }),
    ).toBeTruthy();
    fireEvent.focus(teamSearch());
    const listbox = screen.getByRole("listbox", { name: "Search all teams suggestions" });
    const labels = within(listbox)
      .getAllByRole("option")
      .map((o) =>
        Array.from(o.childNodes)
          .filter((n) => n.nodeType === Node.TEXT_NODE)
          .map((n) => n.textContent)
          .join(""),
      );
    expect(labels).toEqual(JASONS_NEAR_MATCHES.map((m) => m.name));
  });

  it("an open era reads '–present'", () => {
    currentRows = [makeRow({ name: "Los Angeles Dodgers" })];
    currentNearMatches = [
      {
        _id: LA_DODGERS._id,
        name: "Los Angeles Dodgers",
        confidence: "exact",
        yearsActive: { from: 1958 },
      },
    ];
    renderWizard();
    expect(
      screen.getByRole("button", { name: "Link to Los Angeles Dodgers · 1958–present" }),
    ).toBeTruthy();
  });

  it("an undated team keeps the bare 'Link to {name}'", () => {
    currentRows = [makeRow()];
    currentNearMatches = [exactDodgers()];
    renderWizard();
    const primary = screen.getByRole("button", { name: "Link to Brooklyn Dodgers" });
    expect(primary.textContent).toBe("Link to Brooklyn Dodgers");
  });

  it("a player's exact match is unchanged — no era, and a birth year does not leak in", () => {
    currentRows = [makeRow({ kind: "player", name: "Mike Trout" })];
    currentNearMatches = [
      { _id: "p-trout", name: "Mike Trout", confidence: "exact", birthYear: 1991 },
    ];
    renderWizard();
    expect(screen.getByRole("button", { name: "Link to Mike Trout" })).toBeTruthy();
  });
});
