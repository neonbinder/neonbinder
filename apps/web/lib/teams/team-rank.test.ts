/**
 * NEO-331 — the team picker's ranking, as a pure function.
 *
 * The tiers (Jason, 2026-10-10), with L the set's league and Y the set's year:
 *   1. in L and active in Y
 *   2. in a "minor" league and active in Y
 *   3. in L but not active in Y — a closed era, or an UNDATED team
 *   4. everything else
 * then, inside a tier: exact-alias hit, prefix on the full name, A–Z.
 *
 * The one rule a "simplification" would quietly break is the strict
 * `teamActiveIn`: an undated team is never ACTIVE here, the opposite of
 * `eraCoversYear` in team-era.ts (which this file deliberately does not reuse).
 */

import { describe, expect, test } from "vitest";
import {
  rankTeamsForContext,
  teamActiveIn,
  teamRankTier,
  type RankableTeam,
  type TeamRankContext,
} from "./team-rank";

const MLB = "league-mlb";
const AAA = "league-aaa";
const NHL = "league-nhl";

const LEVELS = new Map<string, string>([
  [MLB, "major"],
  [AAA, "minor"],
  [NHL, "major"],
]);

function team(
  id: string,
  name: string,
  extra: Partial<RankableTeam> = {},
): RankableTeam {
  return { _id: id, name, ...extra };
}

const CTX_2024: TeamRankContext = {
  leagueId: MLB,
  year: 2024,
  levelById: LEVELS,
};

describe("teamActiveIn", () => {
  test("an undated team is never active", () => {
    expect(teamActiveIn(undefined, 2024)).toBe(false);
  });

  test("an open-ended era is active from its first year on", () => {
    expect(teamActiveIn({ from: 1958 }, 1958)).toBe(true);
    expect(teamActiveIn({ from: 1958 }, 2024)).toBe(true);
  });

  test("an era that has not started yet is not active", () => {
    expect(teamActiveIn({ from: 2025 }, 2024)).toBe(false);
  });

  test("the last season of a closed era is still active, the next is not", () => {
    expect(teamActiveIn({ from: 1900, to: 2024 }, 2024)).toBe(true);
    expect(teamActiveIn({ from: 1900, to: 2023 }, 2024)).toBe(false);
  });
});

describe("teamRankTier", () => {
  test("tier 1: in the set's league and active that year", () => {
    expect(
      teamRankTier(team("a", "A", { leagueId: MLB, yearsActive: { from: 1958 } }), CTX_2024),
    ).toBe(1);
  });

  test("tier 2: in a minor league and active that year", () => {
    expect(
      teamRankTier(team("a", "A", { leagueId: AAA, yearsActive: { from: 2000 } }), CTX_2024),
    ).toBe(2);
  });

  test("tier 3: in the set's league but its era closed before the year", () => {
    expect(
      teamRankTier(
        team("a", "A", { leagueId: MLB, yearsActive: { from: 1900, to: 1957 } }),
        CTX_2024,
      ),
    ).toBe(3);
  });

  test("tier 3: in the set's league but its era starts after the year", () => {
    expect(
      teamRankTier(team("a", "A", { leagueId: MLB, yearsActive: { from: 2030 } }), CTX_2024),
    ).toBe(3);
  });

  test("tier 3: an UNDATED team in the set's league (undated = previous, never active)", () => {
    expect(teamRankTier(team("a", "A", { leagueId: MLB }), CTX_2024)).toBe(3);
  });

  test("tier 4: an undated team in another league", () => {
    expect(teamRankTier(team("a", "A", { leagueId: NHL }), CTX_2024)).toBe(4);
  });

  test("tier 4: an undated team in a minor league (not active, not in L)", () => {
    expect(teamRankTier(team("a", "A", { leagueId: AAA }), CTX_2024)).toBe(4);
  });

  test("tier 4: an active team in another MAJOR league", () => {
    expect(
      teamRankTier(team("a", "A", { leagueId: NHL, yearsActive: { from: 1990 } }), CTX_2024),
    ).toBe(4);
  });

  test("tier 4: an active team with no league at all", () => {
    expect(teamRankTier(team("a", "A", { yearsActive: { from: 1990 } }), CTX_2024)).toBe(4);
  });

  test("tier 4: a minor-league team whose era closed before the year", () => {
    expect(
      teamRankTier(
        team("a", "A", { leagueId: AAA, yearsActive: { from: 1900, to: 1950 } }),
        CTX_2024,
      ),
    ).toBe(4);
  });

  test("a league the level map does not know is never treated as minor", () => {
    expect(
      teamRankTier(
        team("a", "A", { leagueId: "league-deleted", yearsActive: { from: 1990 } }),
        CTX_2024,
      ),
    ).toBe(4);
  });

  test("a set whose league is itself minor: its active teams are tier 1, not 2", () => {
    const ctx: TeamRankContext = { leagueId: AAA, year: 2024, levelById: LEVELS };
    expect(
      teamRankTier(team("a", "A", { leagueId: AAA, yearsActive: { from: 2000 } }), ctx),
    ).toBe(1);
  });

  describe("no year on the set", () => {
    const ctx: TeamRankContext = { leagueId: MLB, levelById: LEVELS };

    test("every team in the league is tier 1, dated or not", () => {
      expect(teamRankTier(team("a", "A", { leagueId: MLB }), ctx)).toBe(1);
      expect(
        teamRankTier(
          team("b", "B", { leagueId: MLB, yearsActive: { from: 1900, to: 1910 } }),
          ctx,
        ),
      ).toBe(1);
    });

    test("tiers 2 and 3 are empty: an active minor-league team falls to 4", () => {
      expect(
        teamRankTier(team("a", "A", { leagueId: AAA, yearsActive: { from: 2000 } }), ctx),
      ).toBe(4);
    });
  });

  describe("no league resolved", () => {
    const ctx: TeamRankContext = { year: 2024, levelById: LEVELS };

    test("tiers 1 and 3 are empty, even for a team with no league either", () => {
      expect(
        teamRankTier(team("a", "A", { yearsActive: { from: 1990 } }), ctx),
      ).toBe(4);
      expect(teamRankTier(team("b", "B"), ctx)).toBe(4);
    });

    test("an active minor-league team is still tier 2", () => {
      expect(
        teamRankTier(team("a", "A", { leagueId: AAA, yearsActive: { from: 2000 } }), ctx),
      ).toBe(2);
    });
  });

  test("no context at all: everything is tier 4", () => {
    const ctx: TeamRankContext = { levelById: new Map() };
    expect(
      teamRankTier(team("a", "A", { leagueId: MLB, yearsActive: { from: 1900 } }), ctx),
    ).toBe(4);
  });
});

describe("rankTeamsForContext", () => {
  const names = (rows: Array<{ team: RankableTeam }>) => rows.map((r) => r.team.name);

  test("orders by tier even when the alphabet says the opposite", () => {
    const rows = [
      team("w", "RKW", {}), // 4
      team("x", "RKX", { leagueId: MLB, yearsActive: { from: 1900, to: 1957 } }), // 3
      team("y", "RKY", { leagueId: AAA, yearsActive: { from: 2000 } }), // 2
      team("z", "RKZ", { leagueId: MLB, yearsActive: { from: 1958 } }), // 1
    ];
    const ranked = rankTeamsForContext(rows, CTX_2024, "rk");
    expect(names(ranked)).toEqual(["RKZ", "RKY", "RKX", "RKW"]);
    expect(ranked.map((r) => r.tier)).toEqual([1, 2, 3, 4]);
  });

  test("a tier-1 team that sorts last still comes first among thirty same-token teams", () => {
    const others = Array.from({ length: 30 }, (_, i) =>
      team(`o${i}`, `Rangers ${String(i).padStart(2, "0")}`),
    );
    const mlb = team("mlb", "Rangers Zulu", {
      leagueId: MLB,
      yearsActive: { from: 1972 },
    });
    const ranked = rankTeamsForContext([...others, mlb], CTX_2024, "Rangers");
    expect(ranked[0].team._id).toBe("mlb");
    expect(ranked[0].tier).toBe(1);
  });

  test("an exact alias hit leads its tier, ahead of a prefix match", () => {
    const rows = [
      team("a", "Rangers Prefix", { leagueId: MLB, yearsActive: { from: 1900 } }),
      team("b", "Zzz Texas", { leagueId: MLB, yearsActive: { from: 1900 } }),
    ];
    const ranked = rankTeamsForContext(rows, CTX_2024, "Rangers", new Set(["b"]));
    expect(names(ranked)).toEqual(["Zzz Texas", "Rangers Prefix"]);
  });

  test("an alias hit does not jump a better tier", () => {
    const rows = [
      team("t1", "Zzz Current", { leagueId: MLB, yearsActive: { from: 1900 } }),
      team("t4", "Aaa Alias", { leagueId: NHL }),
    ];
    const ranked = rankTeamsForContext(rows, CTX_2024, "x", new Set(["t4"]));
    expect(names(ranked)).toEqual(["Zzz Current", "Aaa Alias"]);
  });

  test("an alias hit that is also tier 1 keeps tier 1", () => {
    const rows = [
      team("a", "Aaa Other", { leagueId: MLB, yearsActive: { from: 1900 } }),
      team("b", "Bbb Alias", { leagueId: MLB, yearsActive: { from: 1900 } }),
    ];
    const ranked = rankTeamsForContext(rows, CTX_2024, "q", new Set(["b"]));
    expect(ranked[0]).toMatchObject({ tier: 1 });
    expect(ranked[0].team._id).toBe("b");
  });

  test("a prefix matches (on the composed full name, A–Z among themselves) precede a substring match", () => {
    const rows = [
      team("a", "Newington Athletics"),
      team("b", "Mid New Club"),
      team("c", "Yankees", { location: "New York" }),
    ];
    const ranked = rankTeamsForContext(rows, { levelById: new Map() }, "New");
    expect(names(ranked)).toEqual(["Yankees", "Newington Athletics", "Mid New Club"]);
  });

  test("falls back to A–Z on the full name inside a tier", () => {
    const rows = [
      team("a", "Padres", { location: "San Diego" }),
      team("b", "Yankees", { location: "New York" }),
      team("c", "Athletics"),
    ];
    const ranked = rankTeamsForContext(rows, { levelById: new Map() }, "");
    expect(names(ranked)).toEqual(["Athletics", "Yankees", "Padres"]);
  });

  test("browse (empty query) ranks by tier then A–Z, with no prefix bonus", () => {
    const rows = [
      team("a", "Aaa", {}),
      team("b", "Zzz", { leagueId: MLB, yearsActive: { from: 1900 } }),
    ];
    expect(names(rankTeamsForContext(rows, CTX_2024, ""))).toEqual(["Zzz", "Aaa"]);
  });

  test("no context: every row is tier 4 and the order is prefix then A–Z", () => {
    const rows = [team("a", "Zebra Fan"), team("b", "Fan Zone"), team("c", "Fan Alpha")];
    const ranked = rankTeamsForContext(rows, { levelById: new Map() }, "fan");
    expect(ranked.every((r) => r.tier === 4)).toBe(true);
    expect(names(ranked)).toEqual(["Fan Alpha", "Fan Zone", "Zebra Fan"]);
  });

  test("is stable: identical full names keep the order they arrived in", () => {
    const rows = [
      team("first", "Jets", { yearsActive: { from: 1972, to: 1996 } }),
      team("second", "Jets", { yearsActive: { from: 2011 } }),
      team("third", "Jets"),
    ];
    const ranked = rankTeamsForContext(rows, { levelById: new Map() }, "jets");
    expect(ranked.map((r) => r.team._id)).toEqual(["first", "second", "third"]);
  });

  test("does not mutate its input", () => {
    const rows = [team("b", "B"), team("a", "A")];
    const copy = [...rows];
    rankTeamsForContext(rows, { levelById: new Map() }, "");
    expect(rows).toEqual(copy);
  });
});
