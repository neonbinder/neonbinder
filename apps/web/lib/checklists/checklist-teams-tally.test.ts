/**
 * NEO-496 — "Teams from your checklist: N of M cards", one definition for the
 * fetch's line and the save's line.
 */

import { describe, expect, test } from "vitest";
import {
  tallyChecklistTeams,
  tallyFetchChecklistTeams,
  teamFromChecklist,
  type ChecklistTeamsCountable,
} from "./checklist-teams-tally";

/** A marketplace card the server paired with a row that named its team. */
const paired = (n: string) => ({ cardNumber: n, teams: ["Blazers"], teamLookup: "checklist" as const });
/** A checklist-only row that named a team. */
const rowWithTeam = (n: string) => ({ cardNumber: n, teams: ["Invented"], teamLookup: "checklist" as const });
/** A checklist-only row that named no team: no claim, so no `teamLookup`. */
const rowWithoutTeam = (n: string) => ({ cardNumber: n });

describe("teamFromChecklist", () => {
  test("only a checklist answer counts", () => {
    expect(teamFromChecklist({ teamLookup: "checklist" })).toBe(true);
    expect(teamFromChecklist({ teamLookup: "answered" })).toBe(false);
    expect(teamFromChecklist({ teamLookup: "failed" })).toBe(false);
    expect(teamFromChecklist({})).toBe(false);
  });
});

describe("tallyChecklistTeams (the saved line)", () => {
  test("a card whose number is on two rows paired with neither (D2): saved teamless, it counts in M and not in N", () => {
    const cards: ChecklistTeamsCountable[] = [
      paired("5"),
      // Asked of the marketplace, then every team skipped in the wizard: no
      // team, and the answer was never the checklist's.
      { teamLookup: "answered" },
      paired("7"),
    ];
    expect(tallyChecklistTeams(cards)).toEqual({ matched: 2, total: 3 });
  });

  test("a lookup that failed is not the checklist's either", () => {
    expect(tallyChecklistTeams([paired("1"), { teamLookup: "failed" }, {}])).toEqual({
      matched: 1,
      total: 3,
    });
  });

  test("a paired card counts in both", () => {
    expect(tallyChecklistTeams([paired("1")])).toEqual({ matched: 1, total: 1 });
  });

  test("a No Team claim is the checklist's answer (NEO-489)", () => {
    expect(tallyChecklistTeams([{ teams: [], teamLookup: "checklist" }])).toEqual({
      matched: 1,
      total: 1,
    });
  });

  test("a kept checklist-only row that named a team counts in both; one that named none counts in M only", () => {
    expect(tallyChecklistTeams([paired("1"), rowWithTeam("90"), rowWithoutTeam("91")])).toEqual({
      matched: 2,
      total: 3,
    });
  });

  test("no cards: 0 of 0", () => {
    expect(tallyChecklistTeams([])).toEqual({ matched: 0, total: 0 });
  });
});

describe("tallyFetchChecklistTeams (the fetch's line)", () => {
  test("with marketplace cards, only they count: the leftover rows are not cards yet (D2)", () => {
    const marketplace: ChecklistTeamsCountable[] = [paired("5"), { teamLookup: "answered" }, paired("7")];
    expect(tallyFetchChecklistTeams(marketplace, [rowWithTeam("6"), rowWithTeam("6")])).toEqual({
      matched: 2,
      total: 3,
    });
  });

  test("a checklist-only fetch: the rows are the cards, as before", () => {
    expect(tallyFetchChecklistTeams([], [rowWithTeam("1"), rowWithoutTeam("2")])).toEqual({
      matched: 1,
      total: 2,
    });
  });

  test("nothing at all: 0 of 0", () => {
    expect(tallyFetchChecklistTeams([], [])).toEqual({ matched: 0, total: 0 });
  });
});

describe("the two lines agree", () => {
  test("NEO-478's shape: 17 paired, #6 on two rows and looked up; the operator keeps #6 and drops both rows, so the saved line repeats the fetch's 17 of 18", () => {
    const marketplace: ChecklistTeamsCountable[] = [
      ...Array.from({ length: 17 }, (_, i) => paired(String(i + 1))),
      { teamLookup: "answered" },
    ];
    const rows = [rowWithTeam("6"), rowWithTeam("6")];
    const atFetch = tallyFetchChecklistTeams(marketplace, rows);
    expect(atFetch).toEqual({ matched: 17, total: 18 });
    // Match Cards: every marketplace card kept, neither row kept.
    expect(tallyChecklistTeams(marketplace)).toEqual(atFetch);
  });

  test("a checklist-only fetch keeps every row, so the saved line is the fetch's", () => {
    const rows = [rowWithTeam("1"), rowWithTeam("2"), rowWithoutTeam("3")];
    expect(tallyChecklistTeams(rows)).toEqual(tallyFetchChecklistTeams([], rows));
  });
});
