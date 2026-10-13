/**
 * NEO-335 Phase 2 — adversarial pass over the career window rule, the league
 * preference tie-break and the stored tiers (lib/teamFill.ts). Sits beside
 * teamFill.test.ts, which pins the decisions; this file leans on the edges:
 * boundary years, empty careers, open stints, one team with several stints,
 * the preference rank as a tie-break only.
 */

import { describe, expect, test } from "vitest";
import type { Id } from "../_generated/dataModel";
import {
  careerTeamVerdict,
  stintCoversWindow,
  suggestTeamsForPlayer,
  type SuggestionCard,
  type SuggestionPlayer,
  type TeamPreferenceRank,
} from "./teamFill";

const NODE = "node_insert" as Id<"selectorOptions">;
const PARENT = "node_parent" as Id<"selectorOptions">;
const BASE = "node_base" as Id<"selectorOptions">;
const P1 = "player_1" as Id<"players">;
const T1 = "team_1" as Id<"teams">;
const T2 = "team_2" as Id<"teams">;
const T3 = "team_3" as Id<"teams">;
const CURRENT_YEAR = 2026;

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

const solo = (nodeId: Id<"selectorOptions">, teams: Array<Id<"teams">>): SuggestionCard => ({
  selectorOptionId: nodeId,
  playerIds: [P1],
  teamOnCardIds: teams,
});

const ranked =
  (ranks: Partial<Record<string, TeamPreferenceRank>>) =>
  (teamId: string): TeamPreferenceRank =>
    ranks[teamId] ?? 2;

describe("the window [setYear-1, setYear] — boundary years", () => {
  test("a stint that STARTS in the set year covers it; one that starts the year after does not", () => {
    expect(stintCoversWindow({ fromYear: 2020, toYear: 2022 }, 2020)).toBe(true);
    expect(stintCoversWindow({ fromYear: 2021, toYear: 2022 }, 2020)).toBe(false);
  });

  test("a stint that ENDS in setYear-1 covers it; one that ended in setYear-2 does not", () => {
    expect(stintCoversWindow({ fromYear: 2010, toYear: 2019 }, 2020)).toBe(true);
    expect(stintCoversWindow({ fromYear: 2010, toYear: 2018 }, 2020)).toBe(false);
  });

  test("a one-year stint inside the window, and a one-year stint on either edge", () => {
    expect(stintCoversWindow({ fromYear: 2019, toYear: 2019 }, 2020)).toBe(true);
    expect(stintCoversWindow({ fromYear: 2020, toYear: 2020 }, 2020)).toBe(true);
    expect(stintCoversWindow({ fromYear: 2018, toYear: 2018 }, 2020)).toBe(false);
    expect(stintCoversWindow({ fromYear: 2021, toYear: 2021 }, 2020)).toBe(false);
  });

  test("an inverted stint (toYear before fromYear) covers nothing, whatever the set year", () => {
    for (const year of [2009, 2010, 2015, 2020, 2021]) {
      expect(stintCoversWindow({ fromYear: 2020, toYear: 2010 }, year)).toBe(false);
    }
  });

  test("an open stint covers every year from its start, and none before it", () => {
    expect(stintCoversWindow({ fromYear: 2015 }, 2014)).toBe(false);
    expect(stintCoversWindow({ fromYear: 2015 }, 2015)).toBe(true);
    expect(stintCoversWindow({ fromYear: 2015 }, 2999)).toBe(true);
  });

  test("year 0 is a year, not 'no year' (only undefined skips the window)", () => {
    const result = suggest({ year: 0, player: career([T1, 0, 5]) });
    expect(result.answer).toEqual({ tier: "oneTeamInWindow", teamIds: [T1] });
  });
});

describe("the window — careers that are not tidy", () => {
  test("an empty career, with a year, answers nothing and offers nothing", () => {
    expect(suggest({ year: 2020, player: { teamYears: [] } })).toEqual({
      answer: null,
      candidates: [],
    });
  });

  test("a player row with no teamYears field at all answers nothing", () => {
    expect(suggest({ year: 2020, player: {} })).toEqual({ answer: null, candidates: [] });
  });

  test("one team with TWO stints in the window is one team, not a tie", () => {
    const result = suggest({ year: 2020, player: career([T1, 2018, 2019], [T1, 2020, 2022]) });
    expect(result).toEqual({ answer: { tier: "oneTeamInWindow", teamIds: [T1] }, candidates: [] });
  });

  test("one team with a stint in the window and another outside it still answers", () => {
    const result = suggest({ year: 2020, player: career([T1, 2005, 2008], [T1, 2019, 2021]) });
    expect(result.answer).toEqual({ tier: "oneTeamInWindow", teamIds: [T1] });
  });

  test("two overlapping open stints are a tie, not a pick of the later one", () => {
    const result = suggest({ year: 2026, player: career([T1, 2015], [T2, 2020]) });
    expect(result.answer).toBeNull();
    expect(new Set(result.candidates)).toEqual(new Set([T1, T2]));
  });

  test("a stint that starts after the set year is not even a candidate when the window has an answer", () => {
    const result = suggest({ year: 2000, player: career([T1, 1998, 2001], [T2, 2005, 2010]) });
    expect(result).toEqual({ answer: { tier: "oneTeamInWindow", teamIds: [T1] }, candidates: [] });
  });

  test("no team in the window: the whole career comes back, in stint order of years with the team", () => {
    const result = suggest({
      year: 2000,
      player: career([T1, 2010, 2011], [T2, 2012, 2020], [T3, 2005, 2009]),
    });
    expect(result.answer).toBeNull();
    // T2: 9 years, T3: 5, T1: 2.
    expect(result.candidates).toEqual([T2, T3, T1]);
  });

  test("equal years with the team keep the order the stints were first seen in", () => {
    const result = suggest({
      year: 1990,
      player: career([T3, 2000, 2001], [T1, 2002, 2003], [T2, 2004, 2005]),
    });
    expect(result.candidates).toEqual([T3, T1, T2]);
  });

  test("an open stint from a year in the future counts one year, and does not crash the sum", () => {
    const verdict = careerTeamVerdict({
      stints: [
        { key: "a", fromYear: CURRENT_YEAR + 3 },
        { key: "b", fromYear: 1990, toYear: 1991 },
      ],
      year: 1980,
      currentYear: CURRENT_YEAR,
    });
    // a: 1 year (max(1, ...)), b: 2 years.
    expect(verdict).toEqual({ answer: null, candidates: ["b", "a"] });
  });

  test("a NaN year never pre-fills (no stint covers it)", () => {
    const result = suggest({ year: Number.NaN, player: career([T1, 2000]) });
    expect(result.answer).toBeNull();
  });
});

describe("league preference — a tie-break and an ordering, nothing more", () => {
  test("two teams tied at rank 1 (no rank 0) is still a tie", () => {
    const result = suggest({
      year: 2000,
      player: career([T1, 1999, 2000], [T2, 2000]),
      rankOf: ranked({ [T1]: 1, [T2]: 1 }),
    });
    expect(result.answer).toBeNull();
    expect(new Set(result.candidates)).toEqual(new Set([T1, T2]));
  });

  test("a rank-0 team OUTSIDE the window never wins the tie inside it", () => {
    const result = suggest({
      year: 2000,
      player: career([T1, 1999, 2000], [T2, 2000], [T3, 1960, 1970]),
      rankOf: ranked({ [T3]: 0, [T1]: 2, [T2]: 2 }),
    });
    expect(result.answer).toBeNull();
    expect(result.candidates).not.toContain(T3);
  });

  test("a rank-0 team that ENDED before the window does not stop a one-team window answering", () => {
    const result = suggest({
      year: 2000,
      player: career([T1, 1999, 2000], [T3, 1960, 1970]),
      rankOf: ranked({ [T3]: 0 }),
    });
    expect(result).toEqual({ answer: { tier: "oneTeamInWindow", teamIds: [T1] }, candidates: [] });
  });

  test("the preferred team's pick is the key, and the rest are offered best rank first", () => {
    const result = suggest({
      year: 2000,
      player: career([T1, 1999, 2000], [T2, 2000], [T3, 1999, 2000]),
      rankOf: ranked({ [T1]: 2, [T2]: 0, [T3]: 1 }),
    });
    expect(result).toEqual({
      answer: { tier: "preferredInWindow", teamIds: [T2] },
      candidates: [T3, T1],
    });
  });

  test("a rank outside 0..2 from the caller is read as-is: 3 never beats 2 (lower is better)", () => {
    const result = suggest({
      year: 2000,
      player: career([T1, 1999, 2000], [T2, 2000]),
      rankOf: (teamId) => (teamId === T1 ? 2 : (3 as unknown as TeamPreferenceRank)),
    });
    // Best rank is 2 (UNRANKED): "best is better than other" needs best < 2.
    expect(result.answer).toBeNull();
  });

  test("a prefix cap of 0 hides the candidates but never the answer", () => {
    const result = suggest({
      year: 2000,
      maxCandidates: 0,
      player: career([T1, 1999, 2000], [T2, 2000]),
      rankOf: ranked({ [T2]: 0 }),
    });
    expect(result.answer).toEqual({ tier: "preferredInWindow", teamIds: [T2] });
    expect(result.candidates).toEqual([]);
  });

  test("a negative candidate cap is the same as zero", () => {
    const result = suggest({
      year: 2026,
      maxCandidates: -3,
      player: career([T1, 1960, 1961]),
    });
    expect(result.candidates).toEqual([]);
  });
});

describe("stored tiers — duplicates and the stop rule", () => {
  test("a card listing the same team twice answers that team once", () => {
    const result = suggest({ cards: [solo(NODE, [T1, T1])] });
    expect(result).toEqual({ answer: { tier: "sameNode", teamIds: [T1] }, candidates: [] });
  });

  test("a card printing [T1, T2] and one printing [T2, T1] are the same evidence", () => {
    const result = suggest({ cards: [solo(NODE, [T1, T2]), solo(NODE, [T2, T1])] });
    expect(result.answer?.teamIds).toHaveLength(2);
    expect(new Set(result.answer?.teamIds)).toEqual(new Set([T1, T2]));
  });

  test("[T1] and [T1, T2] are two different team sets: the search stops with both as candidates", () => {
    const result = suggest({
      cards: [solo(NODE, [T1]), solo(NODE, [T1, T2])],
      player: career([T3, 2000]),
      year: 2000,
    });
    expect(result.answer).toBeNull();
    expect(result.candidates).toEqual([T1, T2]);
  });

  test("a disagreeing base set stops the search even when the career has a one-team window", () => {
    const result = suggest({
      baseNodeId: BASE,
      cards: [solo(BASE, [T1]), solo(BASE, [T2])],
      year: 2000,
      player: career([T3, 1999, 2001]),
    });
    expect(result.answer).toBeNull();
    expect(result.candidates).toEqual([T1, T2]);
  });

  test("stored candidates are capped too", () => {
    const result = suggest({
      maxCandidates: 1,
      cards: [solo(NODE, [T1]), solo(NODE, [T2]), solo(NODE, [T3])],
    });
    expect(result).toEqual({ answer: null, candidates: [T1] });
  });

  test("a node that is its own parallelOf adds nothing a sameNode tier did not already say", () => {
    const result = suggest({ parallelOfNodeId: NODE, cards: [solo(NODE, [T1])] });
    expect(result.answer).toEqual({ tier: "sameNode", teamIds: [T1] });
  });

  test("when the base IS the parallel's parent and the parallel has nothing, the parent's cards answer as parallelOf (not baseSet)", () => {
    const result = suggest({
      parallelOfNodeId: PARENT,
      baseNodeId: PARENT,
      cards: [solo(PARENT, [T1])],
    });
    expect(result.answer).toEqual({ tier: "parallelOf", teamIds: [T1] });
  });

  test("a combo card's team set under the node does not make a solo player's set 'disagree'", () => {
    const combo: SuggestionCard = { selectorOptionId: NODE, playerIds: [P1, P1, "player_2" as Id<"players">], teamOnCardIds: [T2] };
    const result = suggest({ cards: [solo(NODE, [T1]), combo] });
    expect(result).toEqual({ answer: { tier: "sameNode", teamIds: [T1] }, candidates: [] });
  });

  test("a card naming the player but with an empty playerIds list is nobody's evidence", () => {
    const result = suggest({
      cards: [{ selectorOptionId: NODE, playerIds: [], teamOnCardIds: [T1] }],
    });
    expect(result.answer).toBeNull();
  });
});
