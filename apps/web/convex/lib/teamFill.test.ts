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
  idSetKey,
  suggestTeamsForPlayer,
  type SuggestionCard,
  type SuggestionPlayer,
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
    const result = suggest({ cards: [card(NODE, [P1], [])], player: career([T2, 1990]) });
    expect(result.answer).toEqual({ tier: "oneTeamCareer", teamIds: [T2] });
  });

  test("two different team sets STOP the search: candidates, never a pick", () => {
    const result = suggest({
      cards: [card(NODE, [P1], [T1]), card(NODE, [P1], [T2])],
      // One-team career would answer — it must not outvote two printed cards.
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

describe("suggestTeamsForPlayer — career", () => {
  test("B: a one-team career answers with no year at all", () => {
    const result = suggest({ player: career([T1, 1962, 1975], [T1, 1977, 1980]) });
    expect(result.answer).toEqual({ tier: "oneTeamCareer", teamIds: [T1] });
  });

  test("C: exactly one stint covering the year", () => {
    const result = suggest({ year: 1985, player: career([T1, 1980, 1984], [T2, 1985, 1990]) });
    expect(result.answer).toEqual({ tier: "oneStintInYear", teamIds: [T2] });
  });

  test("C: an open stint is a current team", () => {
    const result = suggest({ year: 2025, player: career([T1, 2010, 2019], [T2, 2020]) });
    expect(result.answer).toEqual({ tier: "oneStintInYear", teamIds: [T2] });
  });

  test("C: two stints in the year (a trade) → those two as candidates", () => {
    const result = suggest({
      year: 1990,
      player: career([T1, 1985, 1990], [T2, 1990, 1993], [T3, 1994, 1996]),
    });
    expect(result.answer).toBeNull();
    expect(result.candidates).toEqual([T1, T2]);
  });

  test("no stint in the year (retired player) → the whole career as candidates", () => {
    const result = suggest({ year: 2026, player: career([T1, 1960, 1965], [T2, 1966, 1970]) });
    expect(result.answer).toBeNull();
    expect(result.candidates).toEqual([T1, T2]);
  });

  test("candidates are capped", () => {
    const result = suggest({
      year: 2026,
      maxCandidates: 2,
      player: career([T1, 1960, 1961], [T2, 1962, 1963], [T3, 1964, 1965]),
    });
    expect(result.candidates).toEqual([T1, T2]);
  });

  test("an answer carries no candidates", () => {
    const result = suggest({ player: career([T1, 1990]) });
    expect(result.candidates).toEqual([]);
  });
});
