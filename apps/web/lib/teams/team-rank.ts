/**
 * NEO-331 — rank team picker candidates by the set they are being picked for.
 *
 * ## The problem
 *
 * A team picker on a 2024 Topps baseball card used to list candidates in the
 * search index's order (or, browsing, the table's): "Rangers" surfaced the
 * 1972 Texas Rangers, a minor-league Rangers and a hockey-adjacent namesake in
 * whatever order BM25 scored them, and the MLB club the card almost certainly
 * means could sit fifth. The set already knows its league (`features.league`)
 * and its year, so the picker can put the likely answer first.
 *
 * ## The tiers (Jason, 2026-10-10)
 *
 * With L the set's league row and Y the set's year:
 *
 *   1. in L, and active in Y;
 *   2. in a league whose level is "minor", and active in Y — a minor-league
 *      set, or a prospect card in a major-league set;
 *   3. in L, but NOT active in Y — a closed era, or a team nobody has dated;
 *   4. everything else.
 *
 * Within a tier: an exact alias hit first (the operator typed exactly a name
 * the team answers to), then a prefix match on the composed full name, then
 * A–Z on the full name. No year: tier 1 is all of L, and tiers 2 and 3 are
 * empty. No league resolved: tiers 1 and 3 are empty. No context at all (the
 * admin Players screen): every team is tier 4, so the order is today's.
 *
 * The league's OWN `yearsActive` is never consulted: a team's era is the fact
 * about that team, and a league span would only blur it.
 *
 * ## Pure by contract
 *
 * No Convex imports, no I/O — the rule `team-name.ts` and `team-era.ts` keep,
 * for the same reason: Convex functions, React components and tests in three
 * environments import this. Ids are typed as plain strings, which Convex's
 * branded `Id<…>` strings satisfy.
 */

import { nameHasQueryPrefix } from "../entities/name-search";
import { teamFullName, type TeamNameParts } from "./team-name";
import type { TeamEra } from "./team-era";

export type TeamRankTier = 1 | 2 | 3 | 4;

/** The minimum a row must expose to be ranked. */
export type RankableTeam = TeamNameParts & {
  _id: string;
  leagueId?: string;
  yearsActive?: TeamEra;
};

export type TeamRankContext = {
  /** The set's league row, when `features.league` resolved to one. */
  leagueId?: string;
  /** The set's year, when an ancestor carries one. */
  year?: number;
  /**
   * Level of every league the candidates may point at — the caller collects
   * the sport's leagues once, so ranking never reads a league per candidate.
   */
  levelById: ReadonlyMap<string, string>;
};

/**
 * Was this team ACTIVE in `year`? STRICT: an undated team is not.
 *
 * Deliberately NOT `eraCoversYear` from `team-era.ts`. That helper treats an
 * undated row as covering every year, which is right for what it does —
 * narrowing which row a CARD means, where ruling out an undated row would let
 * another era win by default. Here the question is the opposite one: which
 * teams can we put FIRST with confidence? A team nobody has dated has not
 * earned a place above one we know was playing that season, so it falls to
 * tier 3 (Jason, 2026-10-10: "undated = previous, never active").
 */
export function teamActiveIn(years: TeamEra | undefined, year: number): boolean {
  if (!years) return false;
  if (years.from > year) return false;
  return years.to === undefined || years.to >= year;
}

/** The tier one team lands in for this context. */
export function teamRankTier(
  team: RankableTeam,
  context: TeamRankContext,
): TeamRankTier {
  const { leagueId, year, levelById } = context;
  const inLeague = leagueId !== undefined && team.leagueId === leagueId;

  if (year === undefined) {
    // No year: every team in L is tier 1; nothing can be "active" or
    // "previous", so tiers 2 and 3 are empty.
    return inLeague ? 1 : 4;
  }

  const active = teamActiveIn(team.yearsActive, year);
  if (inLeague && active) return 1;
  if (
    active &&
    team.leagueId !== undefined &&
    levelById.get(team.leagueId) === "minor"
  ) {
    return 2;
  }
  if (inLeague) return 3;
  return 4;
}

/**
 * Rank `rows` for the picker: tier, then exact-alias hit, then prefix match on
 * the full name, then A–Z. Returns a new array; `rows` is not mutated.
 *
 * `aliasHitIds` are the teams the query named EXACTLY through an alias (the
 * server's exact-alias leg) — they lead their tier.
 */
export function rankTeamsForContext<T extends RankableTeam>(
  rows: readonly T[],
  context: TeamRankContext,
  query: string,
  aliasHitIds?: ReadonlySet<string>,
): Array<{ team: T; tier: TeamRankTier }> {
  const keyed = rows.map((team) => {
    const fullName = teamFullName(team);
    return {
      team,
      tier: teamRankTier(team, context),
      aliasHit: aliasHitIds?.has(team._id) ?? false,
      prefix: nameHasQueryPrefix(fullName, query),
      fullName,
    };
  });

  keyed.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    if (a.aliasHit !== b.aliasHit) return a.aliasHit ? -1 : 1;
    if (a.prefix !== b.prefix) return a.prefix ? -1 : 1;
    return a.fullName.localeCompare(b.fullName);
  });

  return keyed.map(({ team, tier }) => ({ team, tier }));
}
