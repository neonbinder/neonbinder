/**
 * NEO-279 — the pure "fill teams" planner, branch by branch. The database
 * tests in ../teamFill.test.ts prove the WIRING (subtree read, paging, apply
 * re-check); this file pins the DECISIONS so a rewording of one rule cannot
 * quietly change what a fill means for the others, the same split
 * lib/selectorTeams.test.ts makes for the NEO-277 cascade rules.
 */

import { describe, expect, test } from "vitest";
import type { Id } from "../_generated/dataModel";
import { MAX_CARD_TEAMS } from "../features/cardAttention";
import {
  isTeamFillCandidate,
  planTeamFill,
  playerKey,
  splitKey,
  teamKey,
  TEAM_FILL_GROUP_CAP,
  TEAM_FILL_GROUP_NODE_CAP,
  type TeamFillCard,
  type TeamFillNode,
  type TeamFillPlayer,
} from "./teamFill";

const NODE = "node_1" as Id<"selectorOptions">;
/** The set's base variantType in the tier-3 fixtures. */
const BASE = "node_base" as Id<"selectorOptions">;
/** An insert with `PARALLEL` beneath it. */
const INSERT = "node_insert" as Id<"selectorOptions">;
const PARALLEL = "node_parallel" as Id<"selectorOptions">;
/** A second insert — another node's evidence is never this one's. */
const OTHER_INSERT = "node_other_insert" as Id<"selectorOptions">;
const P1 = "player_1" as Id<"players">;
const P2 = "player_2" as Id<"players">;
const P3 = "player_3" as Id<"players">;
const T1 = "team_1" as Id<"teams">;
const T2 = "team_2" as Id<"teams">;
const T3 = "team_3" as Id<"teams">;

let cardCounter = 0;
function card(overrides: Partial<TeamFillCard> = {}): TeamFillCard {
  cardCounter += 1;
  return {
    _id: `card_${cardCounter}` as Id<"cardChecklist">,
    selectorOptionId: NODE,
    ...overrides,
  };
}

function player(overrides: Partial<TeamFillPlayer> & { _id: Id<"players"> }): TeamFillPlayer {
  return { ...overrides };
}

function byId(players: Array<TeamFillPlayer>): Map<string, TeamFillPlayer> {
  return new Map(players.map((p) => [p._id, p]));
}

const CURRENT_YEAR = 2026;

/** The tree the tier-2/3 fixtures sit in: base ← set; insert ← base; parallel ← insert. */
const TREE: ReadonlyMap<string, TeamFillNode> = new Map<string, TeamFillNode>([
  [NODE, { level: "setName" }],
  [BASE, { level: "variantType", parentId: NODE }],
  [INSERT, { level: "insert", parentId: BASE }],
  [PARALLEL, { level: "parallel", parentId: INSERT }],
  [OTHER_INSERT, { level: "insert", parentId: BASE }],
]);

type PlanInput = Parameters<typeof planTeamFill>[0];

/**
 * `planTeamFill` with the tree facts defaulted: no nodes known and no base
 * flagged, so a test that is about tiers 1, B or C reads exactly as it did
 * before tiers 2 and 3 existed. Tier-2/3 tests pass `nodesById: TREE` and
 * `baseNodeId: BASE` explicitly.
 */
function plan(input: Partial<PlanInput> & Pick<PlanInput, "cards">) {
  return planTeamFill({
    playersById: new Map(),
    yearByNodeId: new Map(),
    nodesById: new Map(),
    baseNodeId: null,
    currentYear: CURRENT_YEAR,
    ...input,
  });
}

// ===========================================================================
// isTeamFillCandidate
// ===========================================================================

describe("isTeamFillCandidate", () => {
  test("no players: not a candidate", () => {
    expect(isTeamFillCandidate(card({ playerIds: [] }))).toBe(false);
    expect(isTeamFillCandidate(card({}))).toBe(false);
  });

  test("already teamed: not a candidate", () => {
    expect(
      isTeamFillCandidate(card({ playerIds: [P1], teamOnCardIds: [T1] })),
    ).toBe(false);
  });

  test("a pending team name counts as having an answer: not a candidate", () => {
    expect(
      isTeamFillCandidate(card({ playerIds: [P1], pendingTeamNames: ["Bulls"] })),
    ).toBe(false);
  });

  test("the projected hasPendingTeamNames gates the same way, and wins over the strings", () => {
    expect(
      isTeamFillCandidate(card({ playerIds: [P1], hasPendingTeamNames: true })),
    ).toBe(false);
    expect(
      isTeamFillCandidate(card({ playerIds: [P1], hasPendingTeamNames: false })),
    ).toBe(true);
    // The projection is the source of truth once present — mirror of hasBscRef.
    expect(
      isTeamFillCandidate(
        card({ playerIds: [P1], hasPendingTeamNames: false, pendingTeamNames: ["Bulls"] }),
      ),
    ).toBe(true);
    expect(
      isTeamFillCandidate(
        card({ playerIds: [P1], hasPendingTeamNames: true, pendingTeamNames: [] }),
      ),
    ).toBe(false);
  });

  test("operator confirmed no team: not a candidate, regardless of other fields", () => {
    expect(
      isTeamFillCandidate(
        card({ playerIds: [P1], teamNoneConfirmedAt: 1_700_000_000_000 }),
      ),
    ).toBe(false);
  });

  test("a BSC ref whose lookup has not run yet is skipped — projected shape", () => {
    expect(
      isTeamFillCandidate(card({ playerIds: [P1], hasBscRef: true })),
    ).toBe(false);
  });

  test("a BSC ref whose lookup has run is a candidate — projected shape", () => {
    expect(
      isTeamFillCandidate(
        card({ playerIds: [P1], hasBscRef: true, teamCheckDoneAt: 1 }),
      ),
    ).toBe(true);
  });

  test("the same BSC-ref gate reads through the raw platformData shape", () => {
    expect(
      isTeamFillCandidate(
        card({ playerIds: [P1], platformData: { bsc: { ref: "abc" } } }),
      ),
    ).toBe(false);
    expect(
      isTeamFillCandidate(
        card({
          playerIds: [P1],
          platformData: { bsc: { ref: "abc" } },
          teamCheckDoneAt: 1,
        }),
      ),
    ).toBe(true);
  });

  test("hasBscRef wins over platformData when both are set", () => {
    // The projection is the source of truth once present; a stale
    // platformData.bsc.ref must not resurrect the gate.
    expect(
      isTeamFillCandidate(
        card({
          playerIds: [P1],
          hasBscRef: false,
          platformData: { bsc: { ref: "abc" } },
        }),
      ),
    ).toBe(true);
  });

  test("no marketplace ref at all: a candidate with no lookup gate", () => {
    expect(isTeamFillCandidate(card({ playerIds: [P1] }))).toBe(true);
  });
});

// ===========================================================================
// playerKey / teamKey / splitKey
// ===========================================================================

describe("playerKey / teamKey / splitKey", () => {
  test("order-insensitive and duplicate-insensitive", () => {
    expect(playerKey([P2, P1])).toBe(playerKey([P1, P2]));
    expect(playerKey([P1, P1, P2])).toBe(playerKey([P1, P2]));
  });

  test("empty is the empty string, and splits back to an empty array", () => {
    expect(playerKey([])).toBe("");
    expect(splitKey(playerKey([]))).toEqual([]);
  });

  test("splitKey inverts playerKey/teamKey", () => {
    const key = playerKey([P2, P1]);
    expect(new Set(splitKey<Id<"players">>(key))).toEqual(new Set([P1, P2]));
    const tKey = teamKey([T2, T1]);
    expect(new Set(splitKey<Id<"teams">>(tKey))).toEqual(new Set([T1, T2]));
  });
});

// ===========================================================================
// planTeamFill — the base cases and edge inputs
// ===========================================================================

describe("planTeamFill — empty and degenerate input", () => {
  test("no cards at all: an empty plan", () => {
    const result = plan({
      cards: [],
      playersById: new Map(),
      yearByNodeId: new Map(),
      currentYear: CURRENT_YEAR,
    });
    expect(result).toEqual({
      fills: [],
      byRule: { samePlayerInSet: 0, oneTeamCareer: 0, oneStintInYear: 0 },
      remaining: 0,
      groups: [],
      groupsTotal: 0,
      candidates: 0,
    });
  });

  test("a player with an empty teamYears contributes nothing to B or C", () => {
    const target = card({ playerIds: [P1] });
    const result = plan({
      cards: [target],
      playersById: byId([player({ _id: P1, teamYears: [] })]),
      yearByNodeId: new Map([[NODE, 2026]]),
      currentYear: CURRENT_YEAR,
    });
    expect(result.fills).toEqual([]);
    expect(result.remaining).toBe(1);
  });

  test("toYear < fromYear never matches C — an inverted stint answers nothing", () => {
    // Two teams so rule B cannot answer either, isolating the inverted-stint
    // behaviour in C.
    const target = card({ playerIds: [P1] });
    const result = plan({
      cards: [target],
      playersById: byId([
        player({
          _id: P1,
          teamYears: [
            { teamId: T2, fromYear: 1980, toYear: 1985 },
            { teamId: T1, fromYear: 2020, toYear: 2010 },
          ],
        }),
      ]),
      yearByNodeId: new Map([[NODE, 2015]]),
      currentYear: CURRENT_YEAR,
    });
    expect(result.fills).toEqual([]);
    expect(result.remaining).toBe(1);
  });

  test("a card under a node absent from yearByNodeId: C is skipped, not crashed", () => {
    const target = card({ playerIds: [P1], selectorOptionId: "ghost_node" as Id<"selectorOptions"> });
    const result = plan({
      cards: [target],
      playersById: byId([
        player({
          _id: P1,
          teamYears: [
            { teamId: T2, fromYear: 1980, toYear: 1985 },
            { teamId: T1, fromYear: 2020, toYear: 2030 },
          ],
        }),
      ]),
      yearByNodeId: new Map([[NODE, 2026]]), // ghost_node has no entry
      currentYear: CURRENT_YEAR,
    });
    expect(result.fills).toEqual([]);
    expect(result.remaining).toBe(1);
  });

  test("duplicate playerIds on one card dedupe in the key and in agreement checks", () => {
    // A dual-auto of the same player twice: B should not require "two players"
    // to independently agree, since they are the same person.
    const target = card({ playerIds: [P1, P1] });
    const result = plan({
      cards: [target],
      playersById: byId([
        player({ _id: P1, teamYears: [{ teamId: T1, fromYear: 2000 }] }),
      ]),
      yearByNodeId: new Map(),
      currentYear: CURRENT_YEAR,
    });
    expect(result.fills).toEqual([
      { cardId: target._id, teamIds: [T1], rule: "oneTeamCareer", scope: "career", mixed: false },
    ]);
    expect(playerKey(target.playerIds!)).toBe(playerKey([P1]));
  });
});

// ===========================================================================
// Tier 1 — sameNode: the same player(s), teamed, under the same node
// ===========================================================================

describe("planTeamFill — tier 1 (sameNode)", () => {
  test("fills from a teamed sibling card with the same players", () => {
    const evidence = card({ playerIds: [P1], teamOnCardIds: [T1] });
    const target = card({ playerIds: [P1] });
    const result = plan({
      cards: [evidence, target],
      playersById: new Map(),
      yearByNodeId: new Map(),
      currentYear: CURRENT_YEAR,
    });
    expect(result.fills).toEqual([
      { cardId: target._id, teamIds: [T1], rule: "samePlayerInSet", scope: "sameNode", mixed: false },
    ]);
    expect(result.byRule).toEqual({ samePlayerInSet: 1, oneTeamCareer: 0, oneStintInYear: 0 });
    expect(result.candidates).toBe(1); // the evidence card is already teamed, not a candidate
  });

  test("a teamed card under ANOTHER node that is not the base is never evidence", () => {
    // Favre is a Jet on one insert; the same player's teamless card on a
    // second insert must not borrow it — there is no whole-set tier.
    const evidence = card({ playerIds: [P1], teamOnCardIds: [T1], selectorOptionId: OTHER_INSERT });
    const target = card({ playerIds: [P1], selectorOptionId: INSERT });
    const result = plan({
      cards: [evidence, target],
      nodesById: TREE,
      baseNodeId: BASE,
    });
    expect(result.fills).toEqual([]);
    expect(result.remaining).toBe(1);
    // Nor when the tree is unknown and no base is flagged.
    expect(plan({ cards: [evidence, target] }).fills).toEqual([]);
  });

  test("same-node evidence wins regardless of what another node says", () => {
    // The player's cards under the candidate's own node all say T1; another
    // node of the set says T2 (an update card after a trade). Only the own
    // node is read, and the reach is recorded as sameNode.
    const otherNode = "node_2" as Id<"selectorOptions">;
    const nearby = card({ playerIds: [P1], teamOnCardIds: [T1] });
    const farAway = card({ playerIds: [P1], teamOnCardIds: [T2], selectorOptionId: otherNode });
    const target = card({ playerIds: [P1] });
    const result = plan({
      cards: [farAway, nearby, target],
      playersById: byId([player({ _id: P1, teamYears: [{ teamId: T3, fromYear: 2000 }] })]),
      yearByNodeId: new Map(),
      currentYear: CURRENT_YEAR,
    });
    expect(result.fills).toEqual([
      { cardId: target._id, teamIds: [T1], rule: "samePlayerInSet", scope: "sameNode", mixed: false },
    ]);
  });

  test("same-node evidence that disagrees with itself: tier 1 declines, B gets the turn", () => {
    // Two team sets under the candidate's own node is the node disagreeing
    // with itself; tier 1 stays silent rather than pick one.
    const evidenceA = card({ playerIds: [P1], teamOnCardIds: [T1] });
    const evidenceB = card({ playerIds: [P1], teamOnCardIds: [T2] });
    const target = card({ playerIds: [P1] });
    const result = plan({
      cards: [evidenceA, evidenceB, target],
      playersById: byId([player({ _id: P1, teamYears: [{ teamId: T3, fromYear: 2000 }] })]),
      yearByNodeId: new Map(),
      currentYear: CURRENT_YEAR,
    });
    expect(result.fills).toEqual([
      { cardId: target._id, teamIds: [T3], rule: "oneTeamCareer", scope: "career", mixed: false },
    ]);
  });

  test("other nodes' evidence, agreeing or not, is ignored while the own node is silent: B/C get the turn", () => {
    const nodeA = "node_a" as Id<"selectorOptions">;
    const nodeB = "node_b" as Id<"selectorOptions">;
    const evidenceA = card({ playerIds: [P1], teamOnCardIds: [T1], selectorOptionId: nodeA });
    const evidenceB = card({ playerIds: [P1], teamOnCardIds: [T1], selectorOptionId: nodeB });
    const target = card({ playerIds: [P1] }); // under NODE, which has no evidence
    const result = plan({
      cards: [evidenceA, evidenceB, target],
      playersById: byId([player({ _id: P1, teamYears: [{ teamId: T3, fromYear: 2000 }] })]),
      yearByNodeId: new Map(),
      currentYear: CURRENT_YEAR,
    });
    expect(result.fills).toEqual([
      { cardId: target._id, teamIds: [T3], rule: "oneTeamCareer", scope: "career", mixed: false },
    ]);
  });

  test("two distinct team sets for the same players: tier 1 declines, B/C get a turn", () => {
    const evidenceA = card({ playerIds: [P1], teamOnCardIds: [T1] });
    const evidenceB = card({ playerIds: [P1], teamOnCardIds: [T2] });
    const target = card({ playerIds: [P1] });
    const result = plan({
      cards: [evidenceA, evidenceB, target],
      playersById: byId([
        player({ _id: P1, teamYears: [{ teamId: T3, fromYear: 2000 }] }),
      ]),
      yearByNodeId: new Map(),
      currentYear: CURRENT_YEAR,
    });
    // Tier 1 stays silent (two disagreeing sets); B fills from the one-team career.
    expect(result.fills).toEqual([
      { cardId: target._id, teamIds: [T3], rule: "oneTeamCareer", scope: "career", mixed: false },
    ]);
  });

  test("a fill made in this run is never evidence for another card in the same run", () => {
    // Two teamless cards share the same player; neither is teamed at read
    // time, so evidence is empty and tier 1 cannot answer either — even though a
    // sequential, order-dependent implementation might fill the first and
    // then treat it as evidence for the second.
    const first = card({ playerIds: [P1] });
    const second = card({ playerIds: [P1] });
    const result = plan({
      cards: [first, second],
      playersById: new Map(),
      yearByNodeId: new Map(),
      currentYear: CURRENT_YEAR,
    });
    expect(result.fills).toEqual([]);
    expect(result.remaining).toBe(2);
  });

  test("distinct evidence order does not change the result (order independence)", () => {
    const evidence = card({ playerIds: [P1], teamOnCardIds: [T1] });
    const target = card({ playerIds: [P1] });
    const forward = plan({
      cards: [evidence, target],
      playersById: new Map(),
      yearByNodeId: new Map(),
      currentYear: CURRENT_YEAR,
    });
    const backward = plan({
      cards: [target, evidence],
      playersById: new Map(),
      yearByNodeId: new Map(),
      currentYear: CURRENT_YEAR,
    });
    expect(forward.fills).toEqual(backward.fills);
  });

  test("multi-player evidence: exact player-set match required, a subset does not count", () => {
    const evidence = card({ playerIds: [P1, P2], teamOnCardIds: [T1] });
    const target = card({ playerIds: [P1] }); // only one of the two players
    const result = plan({
      cards: [evidence, target],
      playersById: new Map(),
      yearByNodeId: new Map(),
      currentYear: CURRENT_YEAR,
    });
    expect(result.fills).toEqual([]);
    expect(result.remaining).toBe(1);
  });
});

// ===========================================================================
// Rule B — one-team career
// ===========================================================================

describe("planTeamFill — rule B (oneTeamCareer)", () => {
  test("a single-team career fills, even off-year", () => {
    const target = card({ playerIds: [P1] });
    const result = plan({
      cards: [target],
      playersById: byId([
        player({ _id: P1, teamYears: [{ teamId: T1, fromYear: 1960, toYear: 1970 }] }),
      ]),
      yearByNodeId: new Map([[NODE, 2026]]),
      currentYear: CURRENT_YEAR,
    });
    expect(result.fills).toEqual([
      { cardId: target._id, teamIds: [T1], rule: "oneTeamCareer", scope: "career", mixed: false },
    ]);
  });

  test("multi-player agree: fills once, all players' one team is the same", () => {
    const target = card({ playerIds: [P1, P2] });
    const result = plan({
      cards: [target],
      playersById: byId([
        player({ _id: P1, teamYears: [{ teamId: T1, fromYear: 2000 }] }),
        player({ _id: P2, teamYears: [{ teamId: T1, fromYear: 2005 }] }),
      ]),
      yearByNodeId: new Map(),
      currentYear: CURRENT_YEAR,
    });
    expect(result.fills).toEqual([
      { cardId: target._id, teamIds: [T1], rule: "oneTeamCareer", scope: "career", mixed: false },
    ]);
  });

  test("multi-player, two one-team careers: each player's own team, unioned", () => {
    // A League Leaders card is frequently one team per player; the honest
    // fill is both. (Before the per-player union this was "no fill".)
    const target = card({ playerIds: [P1, P2] });
    const result = plan({
      cards: [target],
      playersById: byId([
        player({ _id: P1, teamYears: [{ teamId: T1, fromYear: 2000 }] }),
        player({ _id: P2, teamYears: [{ teamId: T2, fromYear: 2000 }] }),
      ]),
      yearByNodeId: new Map(),
      currentYear: CURRENT_YEAR,
    });
    expect(result.fills).toEqual([
      { cardId: target._id, teamIds: [T1, T2], rule: "oneTeamCareer", scope: "career", mixed: false },
    ]);
    expect(result.remaining).toBe(0);
  });

  test("a player with two distinct teams across their career is not a one-team career", () => {
    const target = card({ playerIds: [P1] });
    const result = plan({
      cards: [target],
      playersById: byId([
        player({
          _id: P1,
          teamYears: [
            { teamId: T1, fromYear: 2000, toYear: 2005 },
            { teamId: T2, fromYear: 2006 },
          ],
        }),
      ]),
      yearByNodeId: new Map(),
      currentYear: CURRENT_YEAR,
    });
    // Falls through to C, which also cannot answer with no year, so remains.
    expect(result.fills).toEqual([]);
    expect(result.remaining).toBe(1);
  });

  test("an unknown player (dangling id) gives no answer, even with a co-player", () => {
    const target = card({ playerIds: [P1, P2] });
    const result = plan({
      cards: [target],
      playersById: byId([player({ _id: P1, teamYears: [{ teamId: T1, fromYear: 2000 }] })]),
      // P2 missing from playersById entirely.
      yearByNodeId: new Map(),
      currentYear: CURRENT_YEAR,
    });
    expect(result.fills).toEqual([]);
    expect(result.remaining).toBe(1);
  });
});

// ===========================================================================
// Rule C — one stint covering the set year
// ===========================================================================

describe("planTeamFill — rule C (oneStintInYear)", () => {
  test("fills when exactly one stint spans the year", () => {
    const target = card({ playerIds: [P1] });
    const result = plan({
      cards: [target],
      playersById: byId([
        player({
          _id: P1,
          teamYears: [
            { teamId: T1, fromYear: 1990, toYear: 1995 },
            { teamId: T2, fromYear: 1996, toYear: 2000 },
          ],
        }),
      ]),
      yearByNodeId: new Map([[NODE, 1993]]),
      currentYear: CURRENT_YEAR,
    });
    expect(result.fills).toEqual([
      { cardId: target._id, teamIds: [T1], rule: "oneStintInYear", scope: "career", mixed: false },
    ]);
  });

  test("an open stint (no toYear) is treated as covering the current year", () => {
    // Two teams on the career so rule B (one-team career) cannot answer —
    // isolates the open-stint math in C.
    const target = card({ playerIds: [P1] });
    const teamYears = [
      { teamId: T2, fromYear: 2000, toYear: 2010 },
      { teamId: T1, fromYear: 2020 }, // open — covers the current year only
    ];
    const withYear = plan({
      cards: [target],
      playersById: byId([player({ _id: P1, teamYears })]),
      yearByNodeId: new Map([[NODE, CURRENT_YEAR]]),
      currentYear: CURRENT_YEAR,
    });
    expect(withYear.fills).toEqual([
      { cardId: target._id, teamIds: [T1], rule: "oneStintInYear", scope: "career", mixed: false },
    ]);
    // The same card at a year the open stint does NOT cover: no C answer,
    // and the two-team career means B cannot answer either.
    const beforeStint = plan({
      cards: [target],
      playersById: byId([player({ _id: P1, teamYears })]),
      yearByNodeId: new Map([[NODE, 2015]]),
      currentYear: CURRENT_YEAR,
    });
    expect(beforeStint.fills).toEqual([]);
  });

  test("two stints covering the same year: ambiguous, no fill", () => {
    const target = card({ playerIds: [P1] });
    const result = plan({
      cards: [target],
      playersById: byId([
        player({
          _id: P1,
          teamYears: [
            { teamId: T1, fromYear: 1990, toYear: 2000 },
            { teamId: T2, fromYear: 1995, toYear: 2005 },
          ],
        }),
      ]),
      yearByNodeId: new Map([[NODE, 1997]]),
      currentYear: CURRENT_YEAR,
    });
    expect(result.fills).toEqual([]);
    expect(result.remaining).toBe(1);
  });

  test("multi-player agree under C", () => {
    // Each player carries a second, non-overlapping stint so a one-team
    // career (rule B) cannot answer for either — isolates C.
    const target = card({ playerIds: [P1, P2] });
    const result = plan({
      cards: [target],
      playersById: byId([
        player({
          _id: P1,
          teamYears: [
            { teamId: T2, fromYear: 1980, toYear: 1985 },
            { teamId: T1, fromYear: 1990, toYear: 2000 },
          ],
        }),
        player({
          _id: P2,
          teamYears: [
            { teamId: T3, fromYear: 1980, toYear: 1985 },
            { teamId: T1, fromYear: 1992, toYear: 1999 },
          ],
        }),
      ]),
      yearByNodeId: new Map([[NODE, 1995]]),
      currentYear: CURRENT_YEAR,
    });
    expect(result.fills).toEqual([
      { cardId: target._id, teamIds: [T1], rule: "oneStintInYear", scope: "career", mixed: false },
    ]);
  });

  test("multi-player, one stint each in the year on different teams: each player's own team, unioned", () => {
    // Each player has a second stint so B cannot answer; C resolves each to
    // a different team and the card takes both.
    const target = card({ playerIds: [P1, P2] });
    const result = plan({
      cards: [target],
      playersById: byId([
        player({
          _id: P1,
          teamYears: [
            { teamId: T3, fromYear: 1980, toYear: 1985 },
            { teamId: T1, fromYear: 1990, toYear: 2000 },
          ],
        }),
        player({
          _id: P2,
          teamYears: [
            { teamId: T3, fromYear: 1980, toYear: 1985 },
            { teamId: T2, fromYear: 1990, toYear: 2000 },
          ],
        }),
      ]),
      yearByNodeId: new Map([[NODE, 1995]]),
      currentYear: CURRENT_YEAR,
    });
    expect(result.fills).toEqual([
      { cardId: target._id, teamIds: [T1, T2], rule: "oneStintInYear", scope: "career", mixed: false },
    ]);
  });

  test("no year resolvable for the node: C is skipped entirely, card remains", () => {
    // A two-team career so rule B cannot answer either — a bare "fills.toEqual([])"
    // here would be true even if C ran and simply found nothing, which is not
    // what this test means to pin.
    const target = card({ playerIds: [P1] });
    const result = plan({
      cards: [target],
      playersById: byId([
        player({
          _id: P1,
          teamYears: [
            { teamId: T1, fromYear: 1990, toYear: 1995 },
            { teamId: T2, fromYear: 1996, toYear: 2000 },
          ],
        }),
      ]),
      yearByNodeId: new Map([[NODE, undefined]]),
      currentYear: CURRENT_YEAR,
    });
    expect(result.fills).toEqual([]);
    expect(result.remaining).toBe(1);
    // Same career, a resolvable year: C now answers, proving the prior case
    // was genuinely "skipped" and not "ran and found nothing".
    const withYear = plan({
      cards: [target],
      playersById: byId([
        player({
          _id: P1,
          teamYears: [
            { teamId: T1, fromYear: 1990, toYear: 1995 },
            { teamId: T2, fromYear: 1996, toYear: 2000 },
          ],
        }),
      ]),
      yearByNodeId: new Map([[NODE, 1993]]),
      currentYear: CURRENT_YEAR,
    });
    expect(withYear.fills).toEqual([
      { cardId: target._id, teamIds: [T1], rule: "oneStintInYear", scope: "career", mixed: false },
    ]);
  });

  test("the node's own year outranks the set year for C", () => {
    // yearByNodeId is populated by the caller with the node's own season when
    // it has one, else the set's year — this pins that C reads whatever the
    // map says for THIS node, not a separately-passed set year.
    const nodeA = "node_a" as Id<"selectorOptions">;
    const nodeB = "node_b" as Id<"selectorOptions">;
    const cardOnA = card({ playerIds: [P1], selectorOptionId: nodeA });
    const cardOnB = card({ playerIds: [P1], selectorOptionId: nodeB });
    const playersById = byId([
      player({
        _id: P1,
        teamYears: [
          { teamId: T1, fromYear: 1990, toYear: 1995 }, // covers nodeA's year only
          { teamId: T2, fromYear: 2000, toYear: 2005 }, // covers nodeB's year only
        ],
      }),
    ]);
    const result = plan({
      cards: [cardOnA, cardOnB],
      playersById,
      yearByNodeId: new Map([
        [nodeA, 1992],
        [nodeB, 2002],
      ]),
      currentYear: CURRENT_YEAR,
    });
    expect(result.fills).toEqual(
      expect.arrayContaining([
        { cardId: cardOnA._id, teamIds: [T1], rule: "oneStintInYear", scope: "career", mixed: false },
        { cardId: cardOnB._id, teamIds: [T2], rule: "oneStintInYear", scope: "career", mixed: false },
      ]),
    );
  });
});

// ===========================================================================
// Tier 2 — parallelOf: the card a parallel is a copy of
// ===========================================================================

describe("planTeamFill — tier 2 (parallelOf)", () => {
  /** A teamed #7 under the insert, and its teamless Gold parallel. */
  function parallelPair(opts: { original?: Partial<TeamFillCard> } = {}) {
    const original = card({
      selectorOptionId: INSERT,
      cardNumber: "7",
      playerIds: [P1],
      teamOnCardIds: [T1],
      ...opts.original,
    });
    const target = card({ selectorOptionId: PARALLEL, cardNumber: "7", playerIds: [P1] });
    return { original, target };
  }

  test("a parallel takes the team of the parent-node card with the same number and players", () => {
    const { original, target } = parallelPair();
    const result = plan({ cards: [original, target], nodesById: TREE, baseNodeId: null });
    expect(result.fills).toEqual([
      { cardId: target._id, teamIds: [T1], rule: "samePlayerInSet", scope: "parallelOf", mixed: false },
    ]);
    expect(result.byRule).toEqual({ samePlayerInSet: 1, oneTeamCareer: 0, oneStintInYear: 0 });
    expect(result.groups[0]).toMatchObject({ scope: "parallelOf", nodeIds: [PARALLEL], nodeCount: 1 });
  });

  test("a multi-team original carries its whole team set onto the parallel", () => {
    const { original, target } = parallelPair({ original: { teamOnCardIds: [T1, T2] } });
    const result = plan({ cards: [original, target], nodesById: TREE, baseNodeId: null });
    expect(result.fills[0]).toMatchObject({ teamIds: [T1, T2], scope: "parallelOf" });
  });

  test("only a node whose level is parallel reaches for its parent", () => {
    // Same shape, but the candidate's node is an insert under the base: a
    // same-numbered base card is a DIFFERENT card, not this one printed again.
    const original = card({ selectorOptionId: BASE, cardNumber: "7", playerIds: [P1], teamOnCardIds: [T1] });
    const target = card({ selectorOptionId: INSERT, cardNumber: "7", playerIds: [P1] });
    const result = plan({ cards: [original, target], nodesById: TREE, baseNodeId: null });
    expect(result.fills).toEqual([]);
    expect(result.remaining).toBe(1);
  });

  test("a parallel whose node is unknown to the tree cannot reach for a parent", () => {
    const { original, target } = parallelPair();
    const result = plan({ cards: [original, target], nodesById: new Map(), baseNodeId: null });
    expect(result.fills).toEqual([]);
    expect(result.remaining).toBe(1);
  });

  test("the same number with different players is a different card: falls through", () => {
    const { original, target } = parallelPair({ original: { playerIds: [P2] } });
    const result = plan({ cards: [original, target], nodesById: TREE, baseNodeId: null });
    expect(result.fills).toEqual([]);
    expect(result.remaining).toBe(1);
  });

  test("the same players with a different number is not the same card: falls through", () => {
    const { original, target } = parallelPair({ original: { cardNumber: "8" } });
    const result = plan({ cards: [original, target], nodesById: TREE, baseNodeId: null });
    expect(result.fills).toEqual([]);
  });

  test("two parent-node matches (card numbers are never unique): falls through, even when they agree", () => {
    const { original, target } = parallelPair();
    const twin = card({ selectorOptionId: INSERT, cardNumber: "7", playerIds: [P1], teamOnCardIds: [T1] });
    const result = plan({ cards: [original, twin, target], nodesById: TREE, baseNodeId: null });
    expect(result.fills).toEqual([]);
    expect(result.remaining).toBe(1);
  });

  test("a teamless twin under the parent still makes two matches: falls through", () => {
    // "Exactly one match" is about the card, not the teamed cards — a second
    // #7 with these players, teamed or not, means the parallel cannot say
    // which it copies.
    const { original, target } = parallelPair();
    const teamlessTwin = card({ selectorOptionId: INSERT, cardNumber: "7", playerIds: [P1] });
    const result = plan({ cards: [original, teamlessTwin, target], nodesById: TREE, baseNodeId: null });
    // The twin itself fills by tier 1 (same player, same node as the
    // original); the parallel does not.
    expect(result.fills.map((f) => [f.cardId, f.scope])).toEqual([[teamlessTwin._id, "sameNode"]]);
    expect(result.remaining).toBe(1);
  });

  test("exactly one match that is itself teamless: falls through to tier 3 / B / C", () => {
    const { original, target } = parallelPair({ original: { teamOnCardIds: [] } });
    const result = plan({
      cards: [original, target],
      playersById: byId([player({ _id: P1, teamYears: [{ teamId: T3, fromYear: 2000 }] })]),
      nodesById: TREE,
      baseNodeId: null,
    });
    // Both the teamless original and its parallel end up at B; neither
    // borrowed from the other (a fill this run is never evidence).
    expect(result.fills).toEqual(
      expect.arrayContaining([
        { cardId: target._id, teamIds: [T3], rule: "oneTeamCareer", scope: "career", mixed: false },
        { cardId: original._id, teamIds: [T3], rule: "oneTeamCareer", scope: "career", mixed: false },
      ]),
    );
    expect(result.fills).toHaveLength(2);
  });

  test("a candidate with no card number is never a parallel match", () => {
    const original = card({ selectorOptionId: INSERT, cardNumber: "7", playerIds: [P1], teamOnCardIds: [T1] });
    const target = card({ selectorOptionId: PARALLEL, playerIds: [P1] }); // cardNumber undefined
    const result = plan({ cards: [original, target], nodesById: TREE, baseNodeId: null });
    expect(result.fills).toEqual([]);
  });

  test("the original's OWN evidence is the rows as read: a parallel of a parallel reaches one level only", () => {
    // Gold is a parallel of the insert; a "Gold Refractor" beneath Gold would
    // parallel Gold. Gold's #7 is teamless at read time, so the Refractor's
    // #7 gets nothing from it even though the insert's #7 is teamed — a fill
    // made this run never feeds another card.
    const refractor = "node_refractor" as Id<"selectorOptions">;
    const tree = new Map<string, TeamFillNode>([...TREE, [refractor, { level: "parallel", parentId: PARALLEL }]]);
    const insertCard7 = card({ selectorOptionId: INSERT, cardNumber: "7", playerIds: [P1], teamOnCardIds: [T1] });
    const goldCard7 = card({ selectorOptionId: PARALLEL, cardNumber: "7", playerIds: [P1] });
    const refractorCard7 = card({ selectorOptionId: refractor, cardNumber: "7", playerIds: [P1] });
    const result = plan({ cards: [insertCard7, goldCard7, refractorCard7], nodesById: tree, baseNodeId: null });
    expect(result.fills).toEqual([
      { cardId: goldCard7._id, teamIds: [T1], rule: "samePlayerInSet", scope: "parallelOf", mixed: false },
    ]);
    expect(result.remaining).toBe(1);
  });
});

// ===========================================================================
// Tier 3 — baseSet: the player's single-player base card
// ===========================================================================

describe("planTeamFill — tier 3 (baseSet)", () => {
  test("a teamless insert card takes the team from the player's base card", () => {
    const baseCard = card({ selectorOptionId: BASE, cardNumber: "1", playerIds: [P1], teamOnCardIds: [T1] });
    const target = card({ selectorOptionId: INSERT, cardNumber: "S-1", playerIds: [P1] });
    const result = plan({ cards: [baseCard, target], nodesById: TREE, baseNodeId: BASE });
    expect(result.fills).toEqual([
      { cardId: target._id, teamIds: [T1], rule: "samePlayerInSet", scope: "baseSet", mixed: false },
    ]);
    expect(result.byRule).toEqual({ samePlayerInSet: 1, oneTeamCareer: 0, oneStintInYear: 0 });
    expect(result.groups[0]).toMatchObject({ scope: "baseSet", nodeIds: [INSERT], nodeCount: 1 });
  });

  test("Favre: a Jet on one insert, teamless on another, a Packer on base — the base decides", () => {
    const asJet = card({ selectorOptionId: OTHER_INSERT, cardNumber: "F-1", playerIds: [P1], teamOnCardIds: [T2] });
    const asPacker = card({ selectorOptionId: BASE, cardNumber: "4", playerIds: [P1], teamOnCardIds: [T1] });
    const target = card({ selectorOptionId: INSERT, cardNumber: "L-4", playerIds: [P1] });
    const result = plan({ cards: [asJet, asPacker, target], nodesById: TREE, baseNodeId: BASE });
    expect(result.fills).toEqual([
      { cardId: target._id, teamIds: [T1], rule: "samePlayerInSet", scope: "baseSet", mixed: false },
    ]);
  });

  test("Favre with no base flagged: the other insert is still not evidence; B/C answer or the card remains", () => {
    const asJet = card({ selectorOptionId: OTHER_INSERT, cardNumber: "F-1", playerIds: [P1], teamOnCardIds: [T2] });
    const asPacker = card({ selectorOptionId: BASE, cardNumber: "4", playerIds: [P1], teamOnCardIds: [T1] });
    const target = card({ selectorOptionId: INSERT, cardNumber: "L-4", playerIds: [P1] });
    const noCareer = plan({ cards: [asJet, asPacker, target], nodesById: TREE, baseNodeId: null });
    expect(noCareer.fills).toEqual([]);
    expect(noCareer.remaining).toBe(1);
    const oneTeam = plan({
      cards: [asJet, asPacker, target],
      playersById: byId([player({ _id: P1, teamYears: [{ teamId: T3, fromYear: 1991 }] })]),
      nodesById: TREE,
      baseNodeId: null,
    });
    expect(oneTeam.fills).toEqual([
      { cardId: target._id, teamIds: [T3], rule: "oneTeamCareer", scope: "career", mixed: false },
    ]);
  });

  test("the base is found by the flag the caller passes, never by a node's name or level alone", () => {
    // Identical rows; the only thing that changes is which node the caller
    // says is the base. Pointing it at the other insert makes THAT the
    // evidence, and the real base's card is ignored.
    const inBase = card({ selectorOptionId: BASE, cardNumber: "4", playerIds: [P1], teamOnCardIds: [T1] });
    const inOther = card({ selectorOptionId: OTHER_INSERT, cardNumber: "F-1", playerIds: [P1], teamOnCardIds: [T2] });
    const target = card({ selectorOptionId: INSERT, cardNumber: "L-4", playerIds: [P1] });
    const result = plan({ cards: [inBase, inOther, target], nodesById: TREE, baseNodeId: OTHER_INSERT });
    expect(result.fills[0]).toMatchObject({ teamIds: [T2], scope: "baseSet" });
  });

  test("a multi-player base card is never evidence for a player, even as the only card that player has there", () => {
    const comboBase = card({ selectorOptionId: BASE, cardNumber: "LL", playerIds: [P1, P2], teamOnCardIds: [T1] });
    const target = card({ selectorOptionId: INSERT, cardNumber: "S-1", playerIds: [P1] });
    const result = plan({ cards: [comboBase, target], nodesById: TREE, baseNodeId: BASE });
    expect(result.fills).toEqual([]);
    expect(result.remaining).toBe(1);
  });

  test("a multi-player base card does not muddy a player's single-card evidence either", () => {
    const solo = card({ selectorOptionId: BASE, cardNumber: "4", playerIds: [P1], teamOnCardIds: [T1] });
    const combo = card({ selectorOptionId: BASE, cardNumber: "LL", playerIds: [P1, P2], teamOnCardIds: [T2] });
    const target = card({ selectorOptionId: INSERT, cardNumber: "S-1", playerIds: [P1] });
    const result = plan({ cards: [solo, combo, target], nodesById: TREE, baseNodeId: BASE });
    expect(result.fills[0]).toMatchObject({ teamIds: [T1], scope: "baseSet" });
  });

  test("two distinct team sets on the player's base cards: tier 3 declines, B/C get the turn", () => {
    const early = card({ selectorOptionId: BASE, cardNumber: "4", playerIds: [P1], teamOnCardIds: [T1] });
    const traded = card({ selectorOptionId: BASE, cardNumber: "T-4", playerIds: [P1], teamOnCardIds: [T2] });
    const target = card({ selectorOptionId: INSERT, cardNumber: "S-1", playerIds: [P1] });
    const result = plan({
      cards: [early, traded, target],
      playersById: byId([player({ _id: P1, teamYears: [{ teamId: T3, fromYear: 2000 }] })]),
      nodesById: TREE,
      baseNodeId: BASE,
    });
    expect(result.fills).toEqual([
      { cardId: target._id, teamIds: [T3], rule: "oneTeamCareer", scope: "career", mixed: false },
    ]);
  });

  test("two base cards that agree are one team set: tier 3 fills", () => {
    const one = card({ selectorOptionId: BASE, cardNumber: "4", playerIds: [P1], teamOnCardIds: [T1] });
    const two = card({ selectorOptionId: BASE, cardNumber: "AS-4", playerIds: [P1], teamOnCardIds: [T1] });
    const target = card({ selectorOptionId: INSERT, cardNumber: "S-1", playerIds: [P1] });
    const result = plan({ cards: [one, two, target], nodesById: TREE, baseNodeId: BASE });
    expect(result.fills[0]).toMatchObject({ teamIds: [T1], scope: "baseSet" });
  });

  test("a candidate INSIDE the base checklist skips tier 3 — tier 1 was its base", () => {
    // A two-player base card: tier 1 wants the identical player set, which
    // no card has, and tier 3 would find each player's solo base card — but
    // the candidate IS a base card, so tier 3 is skipped and, with no career
    // data, it remains. The same card on an insert fills from those very rows.
    const soloP1 = card({ selectorOptionId: BASE, cardNumber: "1", playerIds: [P1], teamOnCardIds: [T1] });
    const soloP2 = card({ selectorOptionId: BASE, cardNumber: "2", playerIds: [P2], teamOnCardIds: [T2] });
    const comboInBase = card({ selectorOptionId: BASE, cardNumber: "LL-1", playerIds: [P1, P2] });
    const inBase = plan({ cards: [soloP1, soloP2, comboInBase], nodesById: TREE, baseNodeId: BASE });
    expect(inBase.fills).toEqual([]);
    expect(inBase.remaining).toBe(1);

    const comboOnInsert = card({ selectorOptionId: INSERT, cardNumber: "LL-1", playerIds: [P1, P2] });
    const onInsert = plan({ cards: [soloP1, soloP2, comboOnInsert], nodesById: TREE, baseNodeId: BASE });
    expect(onInsert.fills).toEqual([
      { cardId: comboOnInsert._id, teamIds: [T1, T2], rule: "samePlayerInSet", scope: "baseSet", mixed: false },
    ]);
  });

  test("a base parallel whose original is teamless falls through tier 2 to the base checklist", () => {
    // Gold parallel OF THE BASE: its #4 is teamless in the base, so tier 2
    // finds one match with no team; tier 3 then reads the player's OTHER
    // base card (#AS-4, teamed) and answers.
    const baseGold = "node_base_gold" as Id<"selectorOptions">;
    const tree = new Map<string, TeamFillNode>([...TREE, [baseGold, { level: "parallel", parentId: BASE }]]);
    const base4 = card({ selectorOptionId: BASE, cardNumber: "4", playerIds: [P1] });
    const baseAllStar = card({ selectorOptionId: BASE, cardNumber: "AS-4", playerIds: [P1], teamOnCardIds: [T1] });
    const gold4 = card({ selectorOptionId: baseGold, cardNumber: "4", playerIds: [P1] });
    const result = plan({ cards: [base4, baseAllStar, gold4], nodesById: tree, baseNodeId: BASE });
    expect(result.fills).toEqual(
      expect.arrayContaining([
        { cardId: gold4._id, teamIds: [T1], rule: "samePlayerInSet", scope: "baseSet", mixed: false },
        // The teamless base #4 itself fills by tier 1 from #AS-4 (same
        // player, same node) — and that fill is NOT what Gold #4 read: its
        // evidence is the rows as read, where #4 was still teamless.
        { cardId: base4._id, teamIds: [T1], rule: "samePlayerInSet", scope: "sameNode", mixed: false },
      ]),
    );
    expect(result.fills).toHaveLength(2);
  });
});

// ===========================================================================
// Per-player union — tiers 3, B and C resolve each player on their own
// ===========================================================================

describe("planTeamFill — per-player union", () => {
  test("three players, three one-team careers: the card gets all three teams", () => {
    const target = card({ playerIds: [P1, P2, P3] });
    const result = plan({
      cards: [target],
      playersById: byId([
        player({ _id: P1, teamYears: [{ teamId: T1, fromYear: 2000 }] }),
        player({ _id: P2, teamYears: [{ teamId: T2, fromYear: 2000 }] }),
        player({ _id: P3, teamYears: [{ teamId: T3, fromYear: 2000 }] }),
      ]),
    });
    expect(result.fills).toEqual([
      { cardId: target._id, teamIds: [T1, T2, T3], rule: "oneTeamCareer", scope: "career", mixed: false },
    ]);
    expect(result.byRule.oneTeamCareer).toBe(1);
  });

  test("two players on the same team: the union is one team", () => {
    const target = card({ playerIds: [P1, P2] });
    const result = plan({
      cards: [target],
      playersById: byId([
        player({ _id: P1, teamYears: [{ teamId: T1, fromYear: 2000 }] }),
        player({ _id: P2, teamYears: [{ teamId: T1, fromYear: 2005 }] }),
      ]),
    });
    expect(result.fills).toEqual([
      { cardId: target._id, teamIds: [T1], rule: "oneTeamCareer", scope: "career", mixed: false },
    ]);
  });

  test("one player unresolved: the card remains — no partial fill", () => {
    const target = card({ playerIds: [P1, P2] });
    const result = plan({
      cards: [target],
      playersById: byId([
        player({ _id: P1, teamYears: [{ teamId: T1, fromYear: 2000 }] }),
        player({ _id: P2, teamYears: [] }),
      ]),
    });
    expect(result.fills).toEqual([]);
    expect(result.remaining).toBe(1);
  });

  test("one player ambiguous (two stints in the year): the card remains", () => {
    const target = card({ playerIds: [P1, P2] });
    const result = plan({
      cards: [target],
      playersById: byId([
        player({ _id: P1, teamYears: [{ teamId: T1, fromYear: 2000 }] }),
        player({
          _id: P2,
          teamYears: [
            { teamId: T2, fromYear: 1990, toYear: 2000 },
            { teamId: T3, fromYear: 1995, toYear: 2005 },
          ],
        }),
      ]),
      yearByNodeId: new Map([[NODE, 1997]]),
    });
    expect(result.fills).toEqual([]);
    expect(result.remaining).toBe(1);
  });

  test("a union past MAX_CARD_TEAMS remains rather than writing a list the card cannot hold", () => {
    const playerIds = Array.from({ length: MAX_CARD_TEAMS + 1 }, (_, i) => `union_p${i}` as Id<"players">);
    const players = playerIds.map((id, i) =>
      player({ _id: id, teamYears: [{ teamId: `union_t${i}` as Id<"teams">, fromYear: 2000 }] }),
    );
    const overCap = card({ playerIds });
    const atCap = card({ playerIds: playerIds.slice(0, MAX_CARD_TEAMS) });
    const result = plan({ cards: [overCap, atCap], playersById: byId(players) });
    expect(result.fills.map((f) => f.cardId)).toEqual([atCap._id]);
    expect(result.fills[0].teamIds).toHaveLength(MAX_CARD_TEAMS);
    expect(result.remaining).toBe(1);
  });

  test("each player walks 3 → B → C on their own: base for one, career for the other", () => {
    const baseP1 = card({ selectorOptionId: BASE, cardNumber: "1", playerIds: [P1], teamOnCardIds: [T1] });
    const target = card({ selectorOptionId: INSERT, cardNumber: "D-1", playerIds: [P1, P2] });
    const result = plan({
      cards: [baseP1, target],
      playersById: byId([player({ _id: P2, teamYears: [{ teamId: T2, fromYear: 2000 }] })]),
      nodesById: TREE,
      baseNodeId: BASE,
    });
    expect(result.fills).toEqual([
      { cardId: target._id, teamIds: [T1, T2], rule: "oneTeamCareer", scope: "career", mixed: true },
    ]);
  });

  test("the single-player card is the degenerate case: B and C behave exactly as one answer", () => {
    const viaB = card({ playerIds: [P1] });
    const viaC = card({ playerIds: [P2] });
    const result = plan({
      cards: [viaB, viaC],
      playersById: byId([
        player({ _id: P1, teamYears: [{ teamId: T1, fromYear: 1960, toYear: 1970 }] }),
        player({
          _id: P2,
          teamYears: [
            { teamId: T2, fromYear: 1990, toYear: 1995 },
            { teamId: T3, fromYear: 1996, toYear: 2000 },
          ],
        }),
      ]),
      yearByNodeId: new Map([[NODE, 1993]]),
    });
    expect(result.fills).toEqual([
      { cardId: viaB._id, teamIds: [T1], rule: "oneTeamCareer", scope: "career", mixed: false },
      { cardId: viaC._id, teamIds: [T2], rule: "oneStintInYear", scope: "career", mixed: false },
    ]);
  });
});

// ===========================================================================
// mixed — players resolved through different tiers
// ===========================================================================

describe("planTeamFill — mixed attribution", () => {
  test("base + one-team career: attributed to the career (riskier), flagged mixed", () => {
    const baseP1 = card({ selectorOptionId: BASE, cardNumber: "1", playerIds: [P1], teamOnCardIds: [T1] });
    const target = card({ selectorOptionId: INSERT, cardNumber: "D-1", playerIds: [P1, P2] });
    const result = plan({
      cards: [baseP1, target],
      playersById: byId([player({ _id: P2, teamYears: [{ teamId: T2, fromYear: 2000 }] })]),
      nodesById: TREE,
      baseNodeId: BASE,
    });
    expect(result.fills[0]).toMatchObject({ rule: "oneTeamCareer", scope: "career", mixed: true });
    expect(result.byRule).toEqual({ samePlayerInSet: 0, oneTeamCareer: 1, oneStintInYear: 0 });
    expect(result.groups[0]).toMatchObject({ rule: "oneTeamCareer", scope: "career", mixed: true });
  });

  test("one-team career + one stint in year: attributed to the stint (riskiest), flagged mixed", () => {
    const target = card({ playerIds: [P1, P2] });
    const result = plan({
      cards: [target],
      playersById: byId([
        player({ _id: P1, teamYears: [{ teamId: T1, fromYear: 2000 }] }),
        player({
          _id: P2,
          teamYears: [
            { teamId: T2, fromYear: 1990, toYear: 1995 },
            { teamId: T3, fromYear: 1996, toYear: 2000 },
          ],
        }),
      ]),
      yearByNodeId: new Map([[NODE, 1993]]),
    });
    expect(result.fills).toEqual([
      { cardId: target._id, teamIds: [T1, T2], rule: "oneStintInYear", scope: "career", mixed: true },
    ]);
  });

  test("both players through the base: not mixed, scope baseSet", () => {
    const baseP1 = card({ selectorOptionId: BASE, cardNumber: "1", playerIds: [P1], teamOnCardIds: [T1] });
    const baseP2 = card({ selectorOptionId: BASE, cardNumber: "2", playerIds: [P2], teamOnCardIds: [T2] });
    const target = card({ selectorOptionId: INSERT, cardNumber: "D-1", playerIds: [P1, P2] });
    const result = plan({ cards: [baseP1, baseP2, target], nodesById: TREE, baseNodeId: BASE });
    expect(result.fills[0]).toMatchObject({ rule: "samePlayerInSet", scope: "baseSet", mixed: false });
  });

  test("whole-card tiers are never mixed", () => {
    const evidence = card({ playerIds: [P1, P2], teamOnCardIds: [T1, T2] });
    const target = card({ playerIds: [P1, P2] });
    const result = plan({ cards: [evidence, target] });
    expect(result.fills[0]).toMatchObject({ scope: "sameNode", mixed: false });
  });

  test("mixed and unmixed fills with the same rule, scope, players and teams are two groups", () => {
    // The same pair lands on the insert (P1 via a base card, P2 via B →
    // mixed) and inside the base (tier 3 skipped there, both via B → not
    // mixed). Same rule, scope, players and teams; a single group would have
    // to lie about one of them.
    const baseP1 = card({ selectorOptionId: BASE, cardNumber: "1", playerIds: [P1], teamOnCardIds: [T1] });
    const onInsert = card({ selectorOptionId: INSERT, cardNumber: "D-1", playerIds: [P1, P2] });
    const inBase = card({ selectorOptionId: BASE, cardNumber: "D-1", playerIds: [P1, P2] });
    const result = plan({
      cards: [baseP1, onInsert, inBase],
      playersById: byId([
        player({ _id: P1, teamYears: [{ teamId: T1, fromYear: 2000 }] }),
        player({ _id: P2, teamYears: [{ teamId: T2, fromYear: 2000 }] }),
      ]),
      nodesById: TREE,
      baseNodeId: BASE,
    });
    // onInsert: P1 via base, P2 via B → mixed. inBase: tier 3 skipped, both via B → not mixed.
    expect(result.fills).toEqual(
      expect.arrayContaining([
        { cardId: onInsert._id, teamIds: [T1, T2], rule: "oneTeamCareer", scope: "career", mixed: true },
        { cardId: inBase._id, teamIds: [T1, T2], rule: "oneTeamCareer", scope: "career", mixed: false },
      ]),
    );
    expect(result.groups).toHaveLength(2);
    expect(result.groups.map((g) => g.mixed).sort()).toEqual([false, true]);
  });
});

// ===========================================================================
// Precedence — 1 → 2 → 3 → B → C
// ===========================================================================

describe("planTeamFill — tier precedence", () => {
  test("tier 1 wins over B and C when all could answer", () => {
    const evidence = card({ playerIds: [P1], teamOnCardIds: [T1] });
    const target = card({ playerIds: [P1] });
    const result = plan({
      cards: [evidence, target],
      playersById: byId([
        // Career is a one-team career at T2, and the year also resolves to T2
        // alone — both disagree with the set's own evidence (T1). Tier 1 must win.
        player({ _id: P1, teamYears: [{ teamId: T2, fromYear: 1990 }] }),
      ]),
      yearByNodeId: new Map([[NODE, 2000]]),
      currentYear: CURRENT_YEAR,
    });
    expect(result.fills).toEqual([
      { cardId: target._id, teamIds: [T1], rule: "samePlayerInSet", scope: "sameNode", mixed: false },
    ]);
  });

  test("tier 1 (same node) wins over tier 2 (the parallel's original)", () => {
    const original = card({ selectorOptionId: INSERT, cardNumber: "7", playerIds: [P1], teamOnCardIds: [T2] });
    const sibling = card({ selectorOptionId: PARALLEL, cardNumber: "8", playerIds: [P1], teamOnCardIds: [T1] });
    const target = card({ selectorOptionId: PARALLEL, cardNumber: "7", playerIds: [P1] });
    const result = plan({ cards: [original, sibling, target], nodesById: TREE, baseNodeId: null });
    expect(result.fills).toEqual([
      { cardId: target._id, teamIds: [T1], rule: "samePlayerInSet", scope: "sameNode", mixed: false },
    ]);
  });

  test("tier 2 (the parallel's original) wins over tier 3 (the base card) and the career", () => {
    const original = card({ selectorOptionId: INSERT, cardNumber: "7", playerIds: [P1], teamOnCardIds: [T2] });
    const baseCard = card({ selectorOptionId: BASE, cardNumber: "7", playerIds: [P1], teamOnCardIds: [T3] });
    const target = card({ selectorOptionId: PARALLEL, cardNumber: "7", playerIds: [P1] });
    const result = plan({
      cards: [original, baseCard, target],
      playersById: byId([player({ _id: P1, teamYears: [{ teamId: T1, fromYear: 2000 }] })]),
      nodesById: TREE,
      baseNodeId: BASE,
    });
    expect(result.fills).toEqual([
      { cardId: target._id, teamIds: [T2], rule: "samePlayerInSet", scope: "parallelOf", mixed: false },
    ]);
  });

  test("tier 3 (the base card) wins over B and C", () => {
    const baseCard = card({ selectorOptionId: BASE, cardNumber: "7", playerIds: [P1], teamOnCardIds: [T3] });
    const target = card({ selectorOptionId: INSERT, cardNumber: "S-7", playerIds: [P1] });
    const result = plan({
      cards: [baseCard, target],
      // One-team career at T1, and the year resolves to T1 alone — both
      // disagree with the base card. The base must win.
      playersById: byId([player({ _id: P1, teamYears: [{ teamId: T1, fromYear: 2000 }] })]),
      yearByNodeId: new Map([[INSERT, 2005]]),
      nodesById: TREE,
      baseNodeId: BASE,
    });
    expect(result.fills).toEqual([
      { cardId: target._id, teamIds: [T3], rule: "samePlayerInSet", scope: "baseSet", mixed: false },
    ]);
  });

  test("B wins over C when no set evidence answers", () => {
    const target = card({ playerIds: [P1] });
    const result = plan({
      cards: [target],
      playersById: byId([
        // One-team career at T1; C would also resolve (a stint at T2 covering
        // the year) if it ran, but B must win first.
        player({
          _id: P1,
          teamYears: [{ teamId: T1, fromYear: 1990, toYear: 2030 }],
        }),
      ]),
      yearByNodeId: new Map([[NODE, 2000]]),
      currentYear: CURRENT_YEAR,
    });
    expect(result.fills).toEqual([
      { cardId: target._id, teamIds: [T1], rule: "oneTeamCareer", scope: "career", mixed: false },
    ]);
  });
});

// ===========================================================================
// teamIdsThatExist — dropping fills into remaining
// ===========================================================================

describe("planTeamFill — teamIdsThatExist", () => {
  test("a fill naming a team outside the set drops into remaining, no fallthrough to another rule", () => {
    // The player's only team (T1) would satisfy rule B, but T1 is not in
    // teamIdsThatExist (dangling / wrong sport). The plan must NOT then try
    // rule C with some other team — the decision is dropped outright.
    const target = card({ playerIds: [P1] });
    const result = plan({
      cards: [target],
      playersById: byId([
        player({ _id: P1, teamYears: [{ teamId: T1, fromYear: 1990, toYear: 2030 }] }),
      ]),
      teamIdsThatExist: new Set([T2]), // T1 is missing
      yearByNodeId: new Map([[NODE, 2000]]),
      currentYear: CURRENT_YEAR,
    });
    expect(result.fills).toEqual([]);
    expect(result.remaining).toBe(1);
    expect(result.candidates).toBe(1);
    expect(result.byRule).toEqual({ samePlayerInSet: 0, oneTeamCareer: 0, oneStintInYear: 0 });
  });

  test("a fill whose team survives the filter still applies", () => {
    const target = card({ playerIds: [P1] });
    const result = plan({
      cards: [target],
      playersById: byId([
        player({ _id: P1, teamYears: [{ teamId: T1, fromYear: 1990, toYear: 2030 }] }),
      ]),
      teamIdsThatExist: new Set([T1]),
      yearByNodeId: new Map([[NODE, 2000]]),
      currentYear: CURRENT_YEAR,
    });
    expect(result.fills).toEqual([
      { cardId: target._id, teamIds: [T1], rule: "oneTeamCareer", scope: "career", mixed: false },
    ]);
  });

  test("undefined teamIdsThatExist filters nothing", () => {
    const target = card({ playerIds: [P1] });
    const result = plan({
      cards: [target],
      playersById: byId([
        player({ _id: P1, teamYears: [{ teamId: T1, fromYear: 1990, toYear: 2030 }] }),
      ]),
      yearByNodeId: new Map([[NODE, 2000]]),
      currentYear: CURRENT_YEAR,
    });
    expect(result.fills).toHaveLength(1);
  });
});

// ===========================================================================
// Groups and the cap
// ===========================================================================

describe("planTeamFill — groups", () => {
  test("cards with the same (rule, players, teams) collapse into one group with the right count", () => {
    const evidence = card({ playerIds: [P1], teamOnCardIds: [T1] });
    const targets = [card({ playerIds: [P1] }), card({ playerIds: [P1] }), card({ playerIds: [P1] })];
    const result = plan({
      cards: [evidence, ...targets],
      playersById: new Map(),
      yearByNodeId: new Map(),
      currentYear: CURRENT_YEAR,
    });
    expect(result.groups).toEqual([
      {
        playerKey: playerKey([P1]),
        teamKey: teamKey([T1]),
        rule: "samePlayerInSet",
        scope: "sameNode",
        mixed: false,
        nodeIds: [NODE],
        nodeCount: 1,
        cardCount: 3,
      },
    ]);
    expect(result.groupsTotal).toBe(1);
  });

  test("the same (players, teams, rule) at two scopes are two groups", () => {
    const evidence = card({ playerIds: [P1], teamOnCardIds: [T1], selectorOptionId: BASE });
    const nearTarget = card({ playerIds: [P1], selectorOptionId: BASE }); // → sameNode
    const farTarget = card({ playerIds: [P1], selectorOptionId: INSERT }); // → baseSet
    const result = plan({
      cards: [evidence, nearTarget, farTarget],
      nodesById: TREE,
      baseNodeId: BASE,
    });
    expect(result.groups.map((g) => [g.scope, g.cardCount, g.nodeIds])).toEqual([
      ["baseSet", 1, [INSERT]],
      ["sameNode", 1, [BASE]],
    ]);
    expect(result.groupsTotal).toBe(2);
  });

  test("a group names its distinct target nodes, capped, with the full count beside", () => {
    const evidence = card({ playerIds: [P1], teamOnCardIds: [T1], selectorOptionId: BASE });
    const targetNodes = Array.from(
      { length: TEAM_FILL_GROUP_NODE_CAP + 2 },
      (_, i) => `node_t${i}` as Id<"selectorOptions">,
    );
    const targets = targetNodes.flatMap((nodeId) => [
      card({ playerIds: [P1], selectorOptionId: nodeId }),
      card({ playerIds: [P1], selectorOptionId: nodeId }), // a second card on each node
    ]);
    const result = plan({ cards: [evidence, ...targets], baseNodeId: BASE });
    expect(result.groups).toHaveLength(1);
    const [group] = result.groups;
    expect(group.scope).toBe("baseSet");
    expect(group.cardCount).toBe(targets.length);
    expect(group.nodeIds).toEqual(targetNodes.slice(0, TEAM_FILL_GROUP_NODE_CAP));
    expect(group.nodeCount).toBe(targetNodes.length);
  });

  test("groups sort riskiest first: career, then the base card, then the same node, then the parallel's original", () => {
    // parallelOf, the biggest group by far: four Gold parallels of teamed insert cards.
    const originals = ["1", "2", "3", "4"].map((n) =>
      card({ selectorOptionId: INSERT, cardNumber: n, playerIds: [P1], teamOnCardIds: [T1] }),
    );
    const parallelTargets = ["1", "2", "3", "4"].map((n) =>
      card({ selectorOptionId: PARALLEL, cardNumber: n, playerIds: [P1] }),
    );
    // sameNode, three cards under the other insert.
    const evidence1 = card({ selectorOptionId: OTHER_INSERT, playerIds: [P2], teamOnCardIds: [T2] });
    const sameNodeTargets = [1, 2, 3].map(() => card({ selectorOptionId: OTHER_INSERT, playerIds: [P2] }));
    // baseSet, two cards on the insert from P3's base card.
    const baseP3 = card({ selectorOptionId: BASE, cardNumber: "9", playerIds: [P3], teamOnCardIds: [T3] });
    const baseTargets = [1, 2].map(() => card({ selectorOptionId: INSERT, playerIds: [P3] }));
    // career (B), one card — a single card, yet it lists first.
    const P4 = "player_4" as Id<"players">;
    const careerTarget = card({ selectorOptionId: INSERT, playerIds: [P4] });
    const result = plan({
      cards: [
        ...originals,
        ...parallelTargets,
        evidence1,
        ...sameNodeTargets,
        baseP3,
        ...baseTargets,
        careerTarget,
      ],
      playersById: byId([player({ _id: P4, teamYears: [{ teamId: T3, fromYear: 2000 }] })]),
      nodesById: TREE,
      baseNodeId: BASE,
    });
    expect(result.groups.map((g) => [g.rule, g.scope, g.cardCount])).toEqual([
      ["oneTeamCareer", "career", 1],
      ["samePlayerInSet", "baseSet", 2],
      ["samePlayerInSet", "sameNode", 3],
      ["samePlayerInSet", "parallelOf", 4],
    ]);
  });

  test("a mixed career fill sorts in the career tier alongside unmixed ones", () => {
    const baseP1 = card({ selectorOptionId: BASE, cardNumber: "1", playerIds: [P1], teamOnCardIds: [T1] });
    const mixedTarget = card({ selectorOptionId: INSERT, cardNumber: "D-1", playerIds: [P1, P2] });
    const baseTarget = card({ selectorOptionId: INSERT, cardNumber: "S-1", playerIds: [P1] });
    const result = plan({
      cards: [baseP1, mixedTarget, baseTarget],
      playersById: byId([player({ _id: P2, teamYears: [{ teamId: T2, fromYear: 2000 }] })]),
      nodesById: TREE,
      baseNodeId: BASE,
    });
    expect(result.groups.map((g) => [g.scope, g.mixed])).toEqual([
      ["career", true],
      ["baseSet", false],
    ]);
  });

  test("rules B and C share the top tier and sort by cardCount within it", () => {
    const bTargets = [card({ playerIds: [P1] })];
    const cTargets = [card({ playerIds: [P2] }), card({ playerIds: [P2] })];
    const result = plan({
      cards: [...bTargets, ...cTargets],
      playersById: byId([
        player({ _id: P1, teamYears: [{ teamId: T1, fromYear: 2000 }] }),
        player({
          _id: P2,
          teamYears: [
            { teamId: T2, fromYear: 1990, toYear: 1995 },
            { teamId: T3, fromYear: 1996, toYear: 2000 },
          ],
        }),
      ]),
      yearByNodeId: new Map([[NODE, 1998]]),
      currentYear: CURRENT_YEAR,
    });
    expect(result.groups.map((g) => [g.rule, g.cardCount])).toEqual([
      ["oneStintInYear", 2],
      ["oneTeamCareer", 1],
    ]);
  });

  test("within a tier, groups sort by cardCount descending", () => {
    const evidence1 = card({ playerIds: [P1], teamOnCardIds: [T1] });
    const evidence2 = card({ playerIds: [P2], teamOnCardIds: [T2] });
    const bigGroup = [card({ playerIds: [P1] }), card({ playerIds: [P1] })];
    const smallGroup = [card({ playerIds: [P2] })];
    const result = plan({
      cards: [evidence1, evidence2, ...smallGroup, ...bigGroup],
      playersById: new Map(),
      yearByNodeId: new Map(),
      currentYear: CURRENT_YEAR,
    });
    expect(result.groups.map((g) => g.cardCount)).toEqual([2, 1]);
  });

  test("the group list is capped at TEAM_FILL_GROUP_CAP, but groupsTotal is not", () => {
    const cards: Array<TeamFillCard> = [];
    const players = new Map<string, TeamFillPlayer>();
    const distinctGroups = TEAM_FILL_GROUP_CAP + 5;
    for (let i = 0; i < distinctGroups; i += 1) {
      const pid = `player_${i}` as Id<"players">;
      const tid = `team_${i}` as Id<"teams">;
      players.set(pid, player({ _id: pid, teamYears: [{ teamId: tid, fromYear: 2000 }] }));
      cards.push(card({ playerIds: [pid] }));
    }
    const result = plan({
      cards,
      playersById: players,
      yearByNodeId: new Map(),
      currentYear: CURRENT_YEAR,
    });
    expect(result.fills).toHaveLength(distinctGroups);
    expect(result.groups).toHaveLength(TEAM_FILL_GROUP_CAP);
    expect(result.groupsTotal).toBe(distinctGroups);
  });
});
