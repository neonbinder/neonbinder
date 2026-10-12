/**
 * NEO-335 — the pure per-player team suggestion, tier by tier. The database
 * test (../cardChecklist.teamSuggestionsForPreview.test.ts) proves the WIRING
 * (which cards are read, the admin gate, the caps); this file pins the
 * DECISIONS so a rewording of one tier cannot quietly change what the others
 * mean.
 *
 * Replaces NEO-279's planner tests: the set-wide "Fill teams" plan was retired
 * with NEO-335 and only the tiers survive.
 */

import { describe, expect, test } from "vitest";
import type { Id } from "../_generated/dataModel";
import {
  careerTeamVerdict,
  idSetKey,
  stintCoversWindow,
  suggestTeamsForPlayer,
  teamPreferenceRank,
  type SuggestionCard,
  type SuggestionPlayer,
  type TeamPreferenceRank,
} from "./teamFill";

const NODE = "node_insert" as Id<"selectorOptions">;
const PARENT = "node_parent" as Id<"selectorOptions">;
const BASE = "node_base" as Id<"selectorOptions">;
const OTHER = "node_other_insert" as Id<"selectorOptions">;
const P1 = "player_1" as Id<"players">;
const P2 = "player_2" as Id<"players">;
const T1 = "team_1" as Id<"teams">;
const T2 = "team_2" as Id<"teams">;
const T3 = "team_3" as Id<"teams">;

const CURRENT_YEAR = 2026;

function card(
  selectorOptionId: Id<"selectorOptions">,
  playerIds: Array<Id<"players">>,
  teamOnCardIds?: Array<Id<"teams">>,
): SuggestionCard {
  return { selectorOptionId, playerIds, ...(teamOnCardIds ? { teamOnCardIds } : {}) };
}

type Input = Parameters<typeof suggestTeamsForPlayer>[0];

function suggest(overrides: Partial<Input> = {}) {
  return suggestTeamsForPlayer({
    playerId: P1,
    player: undefined,
    cards: [],
    nodeId: NODE,
    parallelOfNodeId: null,
    baseNodeId: null,
    year: undefined,
    currentYear: CURRENT_YEAR,
    maxCandidates: 6,
    ...overrides,
  });
}

const career = (...stints: Array<[Id<"teams">, number, number?]>): SuggestionPlayer => ({
  teamYears: stints.map(([teamId, fromYear, toYear]) => ({
    teamId,
    fromYear,
    ...(toYear !== undefined ? { toYear } : {}),
  })),
});

describe("idSetKey", () => {
  test("order- and duplicate-insensitive", () => {
    expect(idSetKey(["b", "a", "b"])).toBe(idSetKey(["a", "b"]));
    expect(idSetKey([])).toBe("");
  });
});

describe("suggestTeamsForPlayer — nothing to go on", () => {
  test("no cards, no player row → no answer, no candidates", () => {
    expect(suggest()).toEqual({ answer: null, candidates: [] });
  });

  test("a player with no stints and no year → no answer, no candidates", () => {
    expect(suggest({ player: { teamYears: [] } })).toEqual({ answer: null, candidates: [] });
  });
});

describe("suggestTeamsForPlayer — sameNode", () => {
  test("one team set on the player's solo cards under the node is the answer", () => {
    const result = suggest({
      cards: [card(NODE, [P1], [T1]), card(NODE, [P1], [T1])],
      // A career that would say something else is outranked by the set itself.
      player: career([T2, 2000]),
    });
    expect(result).toEqual({ answer: { tier: "sameNode", teamIds: [T1] }, candidates: [] });
  });

  test("a combo card is not a solo card's evidence", () => {
    const result = suggest({ cards: [card(NODE, [P1, P2], [T1])] });
    expect(result.answer).toBeNull();
  });

  test("a dual-auto of one player twice is still a solo card", () => {
    const result = suggest({ cards: [card(NODE, [P1, P1], [T1])] });
    expect(result.answer).toEqual({ tier: "sameNode", teamIds: [T1] });
  });

  test("a teamless card is no evidence", () => {
    const result = suggest({
      year: 1990,
      cards: [card(NODE, [P1], [])],
      player: career([T2, 1990]),
    });
    expect(result.answer).toEqual({ tier: "oneTeamInWindow", teamIds: [T2] });
  });

  test("two different team sets STOP the search: candidates, never a pick", () => {
    const result = suggest({
      cards: [card(NODE, [P1], [T1]), card(NODE, [P1], [T2])],
      // A one-team window would answer — it must not outvote two printed cards.
      year: 1990,
      player: career([T3, 1990]),
    });
    expect(result.answer).toBeNull();
    expect(new Set(result.candidates)).toEqual(new Set([T1, T2]));
  });

  test("another insert's cards are never evidence", () => {
    const result = suggest({ cards: [card(OTHER, [P1], [T1])] });
    expect(result).toEqual({ answer: null, candidates: [] });
  });
});

describe("suggestTeamsForPlayer — parallelOf and baseSet", () => {
  test("a parallel reads the node it copies", () => {
    const result = suggest({
      parallelOfNodeId: PARENT,
      cards: [card(PARENT, [P1], [T2])],
    });
    expect(result.answer).toEqual({ tier: "parallelOf", teamIds: [T2] });
  });

  test("sameNode outranks parallelOf", () => {
    const result = suggest({
      parallelOfNodeId: PARENT,
      cards: [card(NODE, [P1], [T1]), card(PARENT, [P1], [T2])],
    });
    expect(result.answer?.tier).toBe("sameNode");
  });

  test("the base set answers when the node has nothing", () => {
    const result = suggest({ baseNodeId: BASE, cards: [card(BASE, [P1], [T3])] });
    expect(result.answer).toEqual({ tier: "baseSet", teamIds: [T3] });
  });

  test("the base set is skipped when the node IS the base", () => {
    const result = suggest({
      nodeId: BASE,
      baseNodeId: BASE,
      cards: [card(BASE, [P1], [T1]), card(BASE, [P1], [T2])],
    });
    // sameNode saw the disagreement; baseSet is not consulted a second time.
    expect(result.answer).toBeNull();
    expect(new Set(result.candidates)).toEqual(new Set([T1, T2]));
  });

  test("an ambiguous base stops before the career tiers", () => {
    const result = suggest({
      baseNodeId: BASE,
      cards: [card(BASE, [P1], [T1]), card(BASE, [P1], [T2])],
      player: career([T1, 1990]),
    });
    expect(result.answer).toBeNull();
  });

  test("a multi-team set on one card is one answer, kept whole", () => {
    const result = suggest({ cards: [card(NODE, [P1], [T1, T2]), card(NODE, [P1], [T2, T1])] });
    expect(result.answer?.tier).toBe("sameNode");
    expect(new Set(result.answer?.teamIds)).toEqual(new Set([T1, T2]));
  });
});

// NEO-335 Phase 2 (C2) — REWRITTEN. Phase 1 had two career tiers: a year-blind
// "one-team career" (oneTeamCareer) and "one stint in the set year"
// (oneStintInYear). Jason replaced both with ONE window rule: exactly one team
// covering [setYear - 1, setYear]. The year-blind shortcut pre-filled a pro
// team on a college-uniform draft card, and a retired legend's one team on a
// modern insert; both now come back unselected.
describe("suggestTeamsForPlayer — career window", () => {
  test("exactly one team in the window answers", () => {
    const result = suggest({ year: 1985, player: career([T1, 1975, 1982], [T2, 1983, 1990]) });
    expect(result).toEqual({ answer: { tier: "oneTeamInWindow", teamIds: [T2] }, candidates: [] });
  });

  test("zero teams in the window (a retired legend) → no pre-fill, whole career, longest stint first", () => {
    const result = suggest({
      year: 2026,
      player: career([T1, 1914, 1919], [T2, 1920, 1934], [T3, 1935, 1935]),
    });
    expect(result.answer).toBeNull();
    expect(result.candidates).toEqual([T2, T1, T3]);
  });

  test("a legend with ONE career team still gets no pre-fill (the year-blind shortcut is gone)", () => {
    const result = suggest({ year: 2026, player: career([T1, 1962, 1975], [T1, 1977, 1980]) });
    expect(result).toEqual({ answer: null, candidates: [T1] });
  });

  test("no set year → no window, no pre-fill, the career as candidates", () => {
    const result = suggest({ player: career([T1, 1962, 1975]) });
    expect(result).toEqual({ answer: null, candidates: [T1] });
  });

  test("two teams in the window (a trade) → no pre-fill, both as candidates", () => {
    const result = suggest({
      year: 1990,
      player: career([T1, 1985, 1990], [T2, 1990, 1993], [T3, 1994, 1996]),
    });
    expect(result.answer).toBeNull();
    expect(result.candidates).toEqual([T1, T2]);
  });

  test("setYear-1 edge: a stint that ENDED the year before the set still covers it (offseason trade is a tie)", () => {
    // 2026 Series 1 shows the 2025 team; the new team signed for 2026.
    const result = suggest({ year: 2026, player: career([T1, 2019, 2025], [T2, 2026]) });
    expect(result.answer).toBeNull();
    expect(new Set(result.candidates)).toEqual(new Set([T1, T2]));
  });

  test("setYear-1 edge: a stint that ended two years before is outside the window", () => {
    const result = suggest({ year: 2026, player: career([T1, 2019, 2024], [T2, 2025]) });
    expect(result.answer).toEqual({ tier: "oneTeamInWindow", teamIds: [T2] });
  });

  test("a stint starting AFTER the set year never covers it (a card shows the past, never the future)", () => {
    const result = suggest({ year: 2020, player: career([T1, 2015, 2020], [T2, 2021]) });
    expect(result.answer).toEqual({ tier: "oneTeamInWindow", teamIds: [T1] });
  });

  test("an open stint is a current team, even for a set dated past this year", () => {
    const result = suggest({ year: CURRENT_YEAR + 1, player: career([T1, 2010, 2019], [T2, 2020]) });
    expect(result.answer).toEqual({ tier: "oneTeamInWindow", teamIds: [T2] });
  });

  test("candidates are capped", () => {
    const result = suggest({
      year: 2026,
      maxCandidates: 2,
      player: career([T1, 1960, 1961], [T2, 1962, 1963], [T3, 1964, 1965]),
    });
    expect(result.candidates).toHaveLength(2);
  });

  test("a one-team-window answer carries no candidates", () => {
    const result = suggest({ year: 1990, player: career([T1, 1990]) });
    expect(result.candidates).toEqual([]);
  });
});

/** Ranks by team, for `rankOf`. */
const ranked =
  (ranks: Partial<Record<string, TeamPreferenceRank>>) =>
  (teamId: string): TeamPreferenceRank =>
    ranks[teamId] ?? 2;

describe("suggestTeamsForPlayer — league preference (C2b) only breaks a window tie", () => {
  const T4 = "team_4" as Id<"teams">;

  test("same league beats same level beats other, as the ORDER of a tie that stays a tie", () => {
    // Two at rank 0 → still a tie: never a pick. Order: rank, then years.
    const result = suggest({
      year: 2000,
      player: career([T1, 1999, 2000], [T2, 1995, 2000], [T3, 1998, 2001], [T4, 2000, 2000]),
      rankOf: ranked({ [T1]: 1, [T2]: 0, [T3]: 0, [T4]: 2 }),
    });
    expect(result.answer).toBeNull();
    expect(result.candidates).toEqual([T2, T3, T1, T4]);
  });

  test("exactly one same-league team in a tie is the pre-fill; the rest stay offered", () => {
    const result = suggest({
      year: 2000,
      player: career([T1, 1999, 2000], [T2, 2000]),
      rankOf: ranked({ [T1]: 1, [T2]: 0 }),
    });
    expect(result).toEqual({
      answer: { tier: "preferredInWindow", teamIds: [T2] },
      candidates: [T1],
    });
  });

  test("same level breaks a tie when no team is in the set's own league", () => {
    const result = suggest({
      year: 2000,
      player: career([T1, 1999, 2000], [T2, 2000]),
      rankOf: ranked({ [T1]: 2, [T2]: 1 }),
    });
    expect(result.answer).toEqual({ tier: "preferredInWindow", teamIds: [T2] });
  });

  test("all 'other' is no preference: the tie stays unselected", () => {
    const result = suggest({
      year: 2000,
      player: career([T1, 1999, 2000], [T2, 2000]),
      rankOf: ranked({}),
    });
    expect(result.answer).toBeNull();
  });

  test("a college card in a pro set: a one-team window pre-fills the college team — preference never outvotes it", () => {
    const COLLEGE = T1;
    const PRO = T2;
    const result = suggest({
      year: 2021,
      player: career([COLLEGE, 2019, 2021], [PRO, 2023]),
      rankOf: ranked({ [PRO]: 0, [COLLEGE]: 2 }),
    });
    expect(result).toEqual({ answer: { tier: "oneTeamInWindow", teamIds: [COLLEGE] }, candidates: [] });
  });

  test("a college card in a pro set the draft year: the pro team is preferred, the college team stays offered", () => {
    const COLLEGE = T1;
    const PRO = T2;
    const result = suggest({
      year: 2023,
      player: career([COLLEGE, 2019, 2022], [PRO, 2023]),
      rankOf: ranked({ [PRO]: 0, [COLLEGE]: 2 }),
    });
    expect(result.answer).toEqual({ tier: "preferredInWindow", teamIds: [PRO] });
    expect(result.candidates).toEqual([COLLEGE]);
  });

  test("C8 prospect: the major-league org ranks above the affiliates he played for that year", () => {
    const ORG = T1;
    const AAA = T2;
    const AA = T3;
    const result = suggest({
      year: 2026,
      player: career([AA, 2024, 2025], [ORG, 2024], [AAA, 2025, 2026]),
      rankOf: ranked({ [ORG]: 0 }),
    });
    expect(result.answer).toEqual({ tier: "preferredInWindow", teamIds: [ORG] });
    // The affiliates are not hidden: longest stint first.
    expect(result.candidates).toEqual([AA, AAA]);
  });

  test("C8 legend: career unselected, preference first, then longest stint first", () => {
    const result = suggest({
      year: 2026,
      player: career([T1, 1950, 1951], [T2, 1952, 1965], [T3, 1966, 1970]),
      rankOf: ranked({ [T1]: 0, [T2]: 0 }),
    });
    expect(result.answer).toBeNull();
    expect(result.candidates).toEqual([T2, T1, T3]);
  });

  test("a stored tier is never re-ranked into a pick", () => {
    const result = suggest({
      year: 2000,
      cards: [card(NODE, [P1], [T1]), card(NODE, [P1], [T2])],
      player: career([T1, 2000], [T2, 2000]),
      rankOf: ranked({ [T1]: 0 }),
    });
    expect(result.answer).toBeNull();
  });
});

describe("careerTeamVerdict — keyed by anything (the browser keys by chip)", () => {
  test("string keys, years summed across stints with the same team", () => {
    const verdict = careerTeamVerdict({
      stints: [
        { key: "name:a", fromYear: 1990, toYear: 1991 },
        { key: "name:b", fromYear: 1992, toYear: 1996 },
        { key: "name:a", fromYear: 1997, toYear: 2001 },
      ],
      year: 2020,
      currentYear: CURRENT_YEAR,
    });
    // a: 2 + 5 = 7 years; b: 5.
    expect(verdict).toEqual({ answer: null, candidates: ["name:a", "name:b"] });
  });

  test("stintCoversWindow", () => {
    expect(stintCoversWindow({ fromYear: 2020, toYear: 2024 }, 2025)).toBe(true);
    expect(stintCoversWindow({ fromYear: 2020, toYear: 2023 }, 2025)).toBe(false);
    expect(stintCoversWindow({ fromYear: 2026 }, 2025)).toBe(false);
    expect(stintCoversWindow({ fromYear: 2000 }, 2025)).toBe(true);
  });
});

describe("teamPreferenceRank", () => {
  const set = { leagueId: "league_mlb", level: "major" };

  test("same league 0, same level 1, anything else 2", () => {
    expect(teamPreferenceRank({ leagueId: "league_mlb", leagueLevel: "major" }, set)).toBe(0);
    expect(teamPreferenceRank({ leagueId: "league_npb", leagueLevel: "major" }, set)).toBe(1);
    expect(teamPreferenceRank({ leagueId: "league_il", leagueLevel: "minor" }, set)).toBe(2);
    expect(teamPreferenceRank({ leagueId: "league_ncaa", leagueLevel: "college" }, set)).toBe(2);
  });

  test("no league on the team, no set league, or an unclassified set league → only an id can match", () => {
    expect(teamPreferenceRank({}, set)).toBe(2);
    expect(teamPreferenceRank({ leagueId: "league_mlb" }, null)).toBe(2);
    expect(
      teamPreferenceRank({ leagueId: "x", leagueLevel: "major" }, { leagueId: "y", level: null }),
    ).toBe(2);
    expect(teamPreferenceRank({ leagueId: "y" }, { leagueId: "y", level: null })).toBe(0);
  });
});
