/**
 * NEO-279 — the pure "fill teams" planner, branch by branch. The database
 * tests in ../teamFill.test.ts prove the WIRING (subtree read, paging, apply
 * re-check); this file pins the DECISIONS so a rewording of one rule cannot
 * quietly change what a fill means for the others, the same split
 * lib/selectorTeams.test.ts makes for the NEO-277 cascade rules.
 */

import { describe, expect, test } from "vitest";
import type { Id } from "../_generated/dataModel";
import {
  isTeamFillCandidate,
  planTeamFill,
  playerKey,
  splitKey,
  teamKey,
  TEAM_FILL_GROUP_CAP,
  type TeamFillCard,
  type TeamFillPlayer,
} from "./teamFill";

const NODE = "node_1" as Id<"selectorOptions">;
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
    const plan = planTeamFill({
      cards: [],
      playersById: new Map(),
      yearByNodeId: new Map(),
      currentYear: CURRENT_YEAR,
    });
    expect(plan).toEqual({
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
    const plan = planTeamFill({
      cards: [target],
      playersById: byId([player({ _id: P1, teamYears: [] })]),
      yearByNodeId: new Map([[NODE, 2026]]),
      currentYear: CURRENT_YEAR,
    });
    expect(plan.fills).toEqual([]);
    expect(plan.remaining).toBe(1);
  });

  test("toYear < fromYear never matches C — an inverted stint answers nothing", () => {
    // Two teams so rule B cannot answer either, isolating the inverted-stint
    // behaviour in C.
    const target = card({ playerIds: [P1] });
    const plan = planTeamFill({
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
    expect(plan.fills).toEqual([]);
    expect(plan.remaining).toBe(1);
  });

  test("a card under a node absent from yearByNodeId: C is skipped, not crashed", () => {
    const target = card({ playerIds: [P1], selectorOptionId: "ghost_node" as Id<"selectorOptions"> });
    const plan = planTeamFill({
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
    expect(plan.fills).toEqual([]);
    expect(plan.remaining).toBe(1);
  });

  test("duplicate playerIds on one card dedupe in the key and in agreement checks", () => {
    // A dual-auto of the same player twice: B should not require "two players"
    // to independently agree, since they are the same person.
    const target = card({ playerIds: [P1, P1] });
    const plan = planTeamFill({
      cards: [target],
      playersById: byId([
        player({ _id: P1, teamYears: [{ teamId: T1, fromYear: 2000 }] }),
      ]),
      yearByNodeId: new Map(),
      currentYear: CURRENT_YEAR,
    });
    expect(plan.fills).toEqual([
      { cardId: target._id, teamIds: [T1], rule: "oneTeamCareer" },
    ]);
    expect(playerKey(target.playerIds!)).toBe(playerKey([P1]));
  });
});

// ===========================================================================
// Rule A — same player(s), same set
// ===========================================================================

describe("planTeamFill — rule A (samePlayerInSet)", () => {
  test("fills from a teamed sibling card with the same players", () => {
    const evidence = card({ playerIds: [P1], teamOnCardIds: [T1] });
    const target = card({ playerIds: [P1] });
    const plan = planTeamFill({
      cards: [evidence, target],
      playersById: new Map(),
      yearByNodeId: new Map(),
      currentYear: CURRENT_YEAR,
    });
    expect(plan.fills).toEqual([
      { cardId: target._id, teamIds: [T1], rule: "samePlayerInSet" },
    ]);
    expect(plan.byRule).toEqual({ samePlayerInSet: 1, oneTeamCareer: 0, oneStintInYear: 0 });
    expect(plan.candidates).toBe(1); // the evidence card is already teamed, not a candidate
  });

  test("two distinct team sets for the same players: A declines, B/C get a turn", () => {
    const evidenceA = card({ playerIds: [P1], teamOnCardIds: [T1] });
    const evidenceB = card({ playerIds: [P1], teamOnCardIds: [T2] });
    const target = card({ playerIds: [P1] });
    const plan = planTeamFill({
      cards: [evidenceA, evidenceB, target],
      playersById: byId([
        player({ _id: P1, teamYears: [{ teamId: T3, fromYear: 2000 }] }),
      ]),
      yearByNodeId: new Map(),
      currentYear: CURRENT_YEAR,
    });
    // A stays silent (two disagreeing sets); B fills from the one-team career.
    expect(plan.fills).toEqual([
      { cardId: target._id, teamIds: [T3], rule: "oneTeamCareer" },
    ]);
  });

  test("a fill made in this run is never evidence for another card in the same run", () => {
    // Two teamless cards share the same player; neither is teamed at read
    // time, so evidence is empty and A cannot answer either — even though a
    // sequential, order-dependent implementation might fill the first and
    // then treat it as evidence for the second.
    const first = card({ playerIds: [P1] });
    const second = card({ playerIds: [P1] });
    const plan = planTeamFill({
      cards: [first, second],
      playersById: new Map(),
      yearByNodeId: new Map(),
      currentYear: CURRENT_YEAR,
    });
    expect(plan.fills).toEqual([]);
    expect(plan.remaining).toBe(2);
  });

  test("distinct evidence order does not change the result (order independence)", () => {
    const evidence = card({ playerIds: [P1], teamOnCardIds: [T1] });
    const target = card({ playerIds: [P1] });
    const forward = planTeamFill({
      cards: [evidence, target],
      playersById: new Map(),
      yearByNodeId: new Map(),
      currentYear: CURRENT_YEAR,
    });
    const backward = planTeamFill({
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
    const plan = planTeamFill({
      cards: [evidence, target],
      playersById: new Map(),
      yearByNodeId: new Map(),
      currentYear: CURRENT_YEAR,
    });
    expect(plan.fills).toEqual([]);
    expect(plan.remaining).toBe(1);
  });
});

// ===========================================================================
// Rule B — one-team career
// ===========================================================================

describe("planTeamFill — rule B (oneTeamCareer)", () => {
  test("a single-team career fills, even off-year", () => {
    const target = card({ playerIds: [P1] });
    const plan = planTeamFill({
      cards: [target],
      playersById: byId([
        player({ _id: P1, teamYears: [{ teamId: T1, fromYear: 1960, toYear: 1970 }] }),
      ]),
      yearByNodeId: new Map([[NODE, 2026]]),
      currentYear: CURRENT_YEAR,
    });
    expect(plan.fills).toEqual([
      { cardId: target._id, teamIds: [T1], rule: "oneTeamCareer" },
    ]);
  });

  test("multi-player agree: fills once, all players' one team is the same", () => {
    const target = card({ playerIds: [P1, P2] });
    const plan = planTeamFill({
      cards: [target],
      playersById: byId([
        player({ _id: P1, teamYears: [{ teamId: T1, fromYear: 2000 }] }),
        player({ _id: P2, teamYears: [{ teamId: T1, fromYear: 2005 }] }),
      ]),
      yearByNodeId: new Map(),
      currentYear: CURRENT_YEAR,
    });
    expect(plan.fills).toEqual([
      { cardId: target._id, teamIds: [T1], rule: "oneTeamCareer" },
    ]);
  });

  test("multi-player disagree: no fill, card remains", () => {
    const target = card({ playerIds: [P1, P2] });
    const plan = planTeamFill({
      cards: [target],
      playersById: byId([
        player({ _id: P1, teamYears: [{ teamId: T1, fromYear: 2000 }] }),
        player({ _id: P2, teamYears: [{ teamId: T2, fromYear: 2000 }] }),
      ]),
      yearByNodeId: new Map(),
      currentYear: CURRENT_YEAR,
    });
    expect(plan.fills).toEqual([]);
    expect(plan.remaining).toBe(1);
  });

  test("a player with two distinct teams across their career is not a one-team career", () => {
    const target = card({ playerIds: [P1] });
    const plan = planTeamFill({
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
    expect(plan.fills).toEqual([]);
    expect(plan.remaining).toBe(1);
  });

  test("an unknown player (dangling id) gives no answer, even with a co-player", () => {
    const target = card({ playerIds: [P1, P2] });
    const plan = planTeamFill({
      cards: [target],
      playersById: byId([player({ _id: P1, teamYears: [{ teamId: T1, fromYear: 2000 }] })]),
      // P2 missing from playersById entirely.
      yearByNodeId: new Map(),
      currentYear: CURRENT_YEAR,
    });
    expect(plan.fills).toEqual([]);
    expect(plan.remaining).toBe(1);
  });
});

// ===========================================================================
// Rule C — one stint covering the set year
// ===========================================================================

describe("planTeamFill — rule C (oneStintInYear)", () => {
  test("fills when exactly one stint spans the year", () => {
    const target = card({ playerIds: [P1] });
    const plan = planTeamFill({
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
    expect(plan.fills).toEqual([
      { cardId: target._id, teamIds: [T1], rule: "oneStintInYear" },
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
    const withYear = planTeamFill({
      cards: [target],
      playersById: byId([player({ _id: P1, teamYears })]),
      yearByNodeId: new Map([[NODE, CURRENT_YEAR]]),
      currentYear: CURRENT_YEAR,
    });
    expect(withYear.fills).toEqual([
      { cardId: target._id, teamIds: [T1], rule: "oneStintInYear" },
    ]);
    // The same card at a year the open stint does NOT cover: no C answer,
    // and the two-team career means B cannot answer either.
    const beforeStint = planTeamFill({
      cards: [target],
      playersById: byId([player({ _id: P1, teamYears })]),
      yearByNodeId: new Map([[NODE, 2015]]),
      currentYear: CURRENT_YEAR,
    });
    expect(beforeStint.fills).toEqual([]);
  });

  test("two stints covering the same year: ambiguous, no fill", () => {
    const target = card({ playerIds: [P1] });
    const plan = planTeamFill({
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
    expect(plan.fills).toEqual([]);
    expect(plan.remaining).toBe(1);
  });

  test("multi-player agree under C", () => {
    // Each player carries a second, non-overlapping stint so a one-team
    // career (rule B) cannot answer for either — isolates C.
    const target = card({ playerIds: [P1, P2] });
    const plan = planTeamFill({
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
    expect(plan.fills).toEqual([
      { cardId: target._id, teamIds: [T1], rule: "oneStintInYear" },
    ]);
  });

  test("multi-player disagree under C: no fill", () => {
    const target = card({ playerIds: [P1, P2] });
    const plan = planTeamFill({
      cards: [target],
      playersById: byId([
        player({ _id: P1, teamYears: [{ teamId: T1, fromYear: 1990, toYear: 2000 }] }),
        player({ _id: P2, teamYears: [{ teamId: T2, fromYear: 1990, toYear: 2000 }] }),
      ]),
      yearByNodeId: new Map([[NODE, 1995]]),
      currentYear: CURRENT_YEAR,
    });
    expect(plan.fills).toEqual([]);
    expect(plan.remaining).toBe(1);
  });

  test("no year resolvable for the node: C is skipped entirely, card remains", () => {
    // A two-team career so rule B cannot answer either — a bare "fills.toEqual([])"
    // here would be true even if C ran and simply found nothing, which is not
    // what this test means to pin.
    const target = card({ playerIds: [P1] });
    const plan = planTeamFill({
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
    expect(plan.fills).toEqual([]);
    expect(plan.remaining).toBe(1);
    // Same career, a resolvable year: C now answers, proving the prior case
    // was genuinely "skipped" and not "ran and found nothing".
    const withYear = planTeamFill({
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
      { cardId: target._id, teamIds: [T1], rule: "oneStintInYear" },
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
    const plan = planTeamFill({
      cards: [cardOnA, cardOnB],
      playersById,
      yearByNodeId: new Map([
        [nodeA, 1992],
        [nodeB, 2002],
      ]),
      currentYear: CURRENT_YEAR,
    });
    expect(plan.fills).toEqual(
      expect.arrayContaining([
        { cardId: cardOnA._id, teamIds: [T1], rule: "oneStintInYear" },
        { cardId: cardOnB._id, teamIds: [T2], rule: "oneStintInYear" },
      ]),
    );
  });
});

// ===========================================================================
// Precedence — A > B > C
// ===========================================================================

describe("planTeamFill — rule precedence", () => {
  test("A wins over B and C when all three could answer", () => {
    const evidence = card({ playerIds: [P1], teamOnCardIds: [T1] });
    const target = card({ playerIds: [P1] });
    const plan = planTeamFill({
      cards: [evidence, target],
      playersById: byId([
        // Career is a one-team career at T2, and the year also resolves to T2
        // alone — both disagree with the set's own evidence (T1). A must win.
        player({ _id: P1, teamYears: [{ teamId: T2, fromYear: 1990 }] }),
      ]),
      yearByNodeId: new Map([[NODE, 2000]]),
      currentYear: CURRENT_YEAR,
    });
    expect(plan.fills).toEqual([
      { cardId: target._id, teamIds: [T1], rule: "samePlayerInSet" },
    ]);
  });

  test("B wins over C when A cannot answer", () => {
    const target = card({ playerIds: [P1] });
    const plan = planTeamFill({
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
    expect(plan.fills).toEqual([
      { cardId: target._id, teamIds: [T1], rule: "oneTeamCareer" },
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
    const plan = planTeamFill({
      cards: [target],
      playersById: byId([
        player({ _id: P1, teamYears: [{ teamId: T1, fromYear: 1990, toYear: 2030 }] }),
      ]),
      teamIdsThatExist: new Set([T2]), // T1 is missing
      yearByNodeId: new Map([[NODE, 2000]]),
      currentYear: CURRENT_YEAR,
    });
    expect(plan.fills).toEqual([]);
    expect(plan.remaining).toBe(1);
    expect(plan.candidates).toBe(1);
    expect(plan.byRule).toEqual({ samePlayerInSet: 0, oneTeamCareer: 0, oneStintInYear: 0 });
  });

  test("a fill whose team survives the filter still applies", () => {
    const target = card({ playerIds: [P1] });
    const plan = planTeamFill({
      cards: [target],
      playersById: byId([
        player({ _id: P1, teamYears: [{ teamId: T1, fromYear: 1990, toYear: 2030 }] }),
      ]),
      teamIdsThatExist: new Set([T1]),
      yearByNodeId: new Map([[NODE, 2000]]),
      currentYear: CURRENT_YEAR,
    });
    expect(plan.fills).toEqual([
      { cardId: target._id, teamIds: [T1], rule: "oneTeamCareer" },
    ]);
  });

  test("undefined teamIdsThatExist filters nothing", () => {
    const target = card({ playerIds: [P1] });
    const plan = planTeamFill({
      cards: [target],
      playersById: byId([
        player({ _id: P1, teamYears: [{ teamId: T1, fromYear: 1990, toYear: 2030 }] }),
      ]),
      yearByNodeId: new Map([[NODE, 2000]]),
      currentYear: CURRENT_YEAR,
    });
    expect(plan.fills).toHaveLength(1);
  });
});

// ===========================================================================
// Groups and the cap
// ===========================================================================

describe("planTeamFill — groups", () => {
  test("cards with the same (rule, players, teams) collapse into one group with the right count", () => {
    const evidence = card({ playerIds: [P1], teamOnCardIds: [T1] });
    const targets = [card({ playerIds: [P1] }), card({ playerIds: [P1] }), card({ playerIds: [P1] })];
    const plan = planTeamFill({
      cards: [evidence, ...targets],
      playersById: new Map(),
      yearByNodeId: new Map(),
      currentYear: CURRENT_YEAR,
    });
    expect(plan.groups).toEqual([
      { playerKey: playerKey([P1]), teamKey: teamKey([T1]), rule: "samePlayerInSet", cardCount: 3 },
    ]);
    expect(plan.groupsTotal).toBe(1);
  });

  test("groups sort by cardCount descending", () => {
    const evidence1 = card({ playerIds: [P1], teamOnCardIds: [T1] });
    const evidence2 = card({ playerIds: [P2], teamOnCardIds: [T2] });
    const bigGroup = [card({ playerIds: [P1] }), card({ playerIds: [P1] })];
    const smallGroup = [card({ playerIds: [P2] })];
    const plan = planTeamFill({
      cards: [evidence1, evidence2, ...smallGroup, ...bigGroup],
      playersById: new Map(),
      yearByNodeId: new Map(),
      currentYear: CURRENT_YEAR,
    });
    expect(plan.groups.map((g) => g.cardCount)).toEqual([2, 1]);
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
    const plan = planTeamFill({
      cards,
      playersById: players,
      yearByNodeId: new Map(),
      currentYear: CURRENT_YEAR,
    });
    expect(plan.fills).toHaveLength(distinctGroups);
    expect(plan.groups).toHaveLength(TEAM_FILL_GROUP_CAP);
    expect(plan.groupsTotal).toBe(distinctGroups);
  });
});
