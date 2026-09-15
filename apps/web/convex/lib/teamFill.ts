/**
 * NEO-279 — filling a set's teamless cards from evidence the set already
 * holds, as a preview the operator confirms.
 *
 * ## The gap this closes
 *
 * BSC's per-card endpoint returns no team for some cards of a set while the
 * SAME player is teamed on its other cards, so a synced set arrives with a
 * scatter of "missing team" badges that each need a human to click the team
 * the neighbouring row already carries. And the per-card career suggestion
 * (`cardChecklist.suggestedTeamsForCard`) filtered stints to the set year, so
 * a retired player on a modern card offered nothing at all.
 *
 * ## What this is, and is not
 *
 * A PLAN, computed once from a snapshot of the subtree and applied only after
 * an operator has seen its counts. It is never silent: nothing here runs from
 * a sync, a cron or a creation path. It writes only `teamOnCardIds` on cards
 * that are still empty at apply time, and never `players.teamYears` — a
 * card's printed team and a player's career are different facts (see
 * `suggestedTeamsForCard`), and a set is evidence for its own cards only.
 *
 * ## Three rules, first answer wins
 *
 *  A. **Same player(s), same set.** Every card in the whole set subtree with
 *     exactly these players and a non-empty `teamOnCardIds` is evidence. One
 *     distinct team set among the evidence → fill with it. Two or more → the
 *     set disagrees with itself (a traded player's base card vs. his update
 *     card) and rule A stays silent rather than pick one; B and C get a turn.
 *     Evidence is the snapshot: a fill made by this run is never evidence for
 *     another card in the same run, so the result does not depend on the
 *     order cards were read.
 *  B. **One-team career.** Every player on the card has at least one stint
 *     and every stint names the same team, and all players name that one
 *     team. This is what answers the retired-player case: a 1960s Yankee on a
 *     2026 insert has no stint covering 2026, but he only ever had one team.
 *  C. **One stint covering the set year.** For each player, exactly one stint
 *     spans the card's year (`fromYear <= year <= (toYear ?? currentYear)`,
 *     an open stint being a current team), and all players land on the same
 *     team. A node's own `features.season` outranks the set's year — the same
 *     precedence `findSetYearForSelectorOption` applies — and a node with no
 *     resolvable year skips C.
 *
 * Multi-player cards require EVERY player to agree under B and C. A League
 * Leaders card whose three players span three teams gets no fill and stays
 * in the attention lane, which is the right place for it: there is no single
 * team a rule could honestly assert.
 *
 * ## Pure by contract
 *
 * Ids in, plan out. No ctx, no generated code beyond the `Id` type, so a lib
 * test can drive every rule from literal rows. The Convex module
 * (`convex/teamFill.ts`) reads the subtree, players and teams, and re-checks
 * each card at apply time; this module decides.
 */

import type { Id } from "../_generated/dataModel";
import { sameTeamSet } from "./selectorTeams";

export type TeamFillRule = "samePlayerInSet" | "oneTeamCareer" | "oneStintInYear";

/**
 * The card shape every function here reads. It is satisfied by a full
 * `Doc<"cardChecklist">` (the apply chunk re-checks a fresh row) AND by the
 * projection `readTeamFillCards` returns, which carries `hasBscRef` instead of
 * the whole `platformData` so a page of a thousand cards stays small.
 */
export type TeamFillCard = {
  _id: Id<"cardChecklist">;
  selectorOptionId: Id<"selectorOptions">;
  playerIds?: ReadonlyArray<Id<"players">>;
  teamOnCardIds?: ReadonlyArray<Id<"teams">>;
  pendingTeamNames?: ReadonlyArray<string>;
  teamNoneConfirmedAt?: number;
  teamCheckDoneAt?: number;
  /** Projected form of `!!platformData.bsc?.ref`. Wins over `platformData` when set. */
  hasBscRef?: boolean;
  platformData?: { bsc?: { ref?: string } | undefined };
};

export type TeamFillPlayer = {
  _id: Id<"players">;
  teamYears?: ReadonlyArray<{ teamId: Id<"teams">; fromYear: number; toYear?: number }>;
};

export type TeamFillDecision = {
  cardId: Id<"cardChecklist">;
  teamIds: Array<Id<"teams">>;
  rule: TeamFillRule;
};

export type TeamFillGroup = {
  /** `playerKey(playerIds)` — sorted, deduped, "|"-joined. */
  playerKey: string;
  /** `teamKey(teamIds)` — same shape, over the fill's teams. */
  teamKey: string;
  rule: TeamFillRule;
  cardCount: number;
};

export type TeamFillPlan = {
  fills: Array<TeamFillDecision>;
  byRule: Record<TeamFillRule, number>;
  /** Candidates no rule could answer, plus fills dropped by `teamIdsThatExist`. */
  remaining: number;
  /** Distinct (players, teams, rule) triples, most cards first, capped. */
  groups: Array<TeamFillGroup>;
  /** How many groups there were before the cap, so the UI can say "and N more". */
  groupsTotal: number;
  /** Cards that were eligible for a fill at all. */
  candidates: number;
};

/**
 * How many groups a preview carries. A set rarely has more than a few dozen
 * distinct (players, team) pairs; the cap exists so a pathological subtree
 * cannot hand the client an unbounded list, not because 200 means anything.
 */
export const TEAM_FILL_GROUP_CAP = 200;

/**
 * The SAME clauses `features/cardAttention.ts` uses to badge a card "missing
 * team", plus "has at least one player" — a card with nobody on it has no
 * evidence to reason from. Kept clause-for-clause so a card this fills is a
 * card that was badged, and a card this skips is one the badge also leaves
 * alone:
 *
 *  - a real team, or a pending team NAME awaiting review, counts as having a
 *    team (the name is the card's answer; filling underneath it would have
 *    the row claim two things);
 *  - an operator's "no team" confirmation outranks every rule;
 *  - a card whose BSC lookup has not run yet is skipped, because the
 *    marketplace may still answer and the badge is not shown for it either.
 */
export function isTeamFillCandidate(card: TeamFillCard): boolean {
  if ((card.playerIds?.length ?? 0) === 0) return false;
  if ((card.teamOnCardIds?.length ?? 0) > 0) return false;
  if ((card.pendingTeamNames?.length ?? 0) > 0) return false;
  if (card.teamNoneConfirmedAt !== undefined) return false;
  const hasBscRef = card.hasBscRef ?? !!card.platformData?.bsc?.ref;
  if (hasBscRef && card.teamCheckDoneAt === undefined) return false;
  return true;
}

/**
 * Order-insensitive, duplicate-insensitive identity for a card's players — a
 * dual-auto of one player twice and a card listing him once are the same
 * evidence. The same key is what a preview group is named by.
 */
export function playerKey(playerIds: ReadonlyArray<Id<"players">>): string {
  return [...new Set<string>(playerIds)].sort().join("|");
}

/** `playerKey`, over teams. */
export function teamKey(teamIds: ReadonlyArray<Id<"teams">>): string {
  return [...new Set<string>(teamIds)].sort().join("|");
}

/** Inverse of `playerKey` / `teamKey`, for turning a group back into ids. */
export function splitKey<T extends string>(key: string): Array<T> {
  return key === "" ? [] : (key.split("|") as Array<T>);
}

function distinctTeamIds(player: TeamFillPlayer): Array<Id<"teams">> {
  return [...new Set<Id<"teams">>((player.teamYears ?? []).map((entry) => entry.teamId))];
}

/**
 * Rule A's evidence, built once. Keyed by `playerKey`; the value is the list
 * of DISTINCT team sets seen among teamed cards with those players. Two
 * entries means the set disagrees with itself and A declines.
 */
function buildSamePlayerEvidence(
  cards: ReadonlyArray<TeamFillCard>,
): Map<string, Array<Array<Id<"teams">>>> {
  const evidence = new Map<string, Array<Array<Id<"teams">>>>();
  for (const card of cards) {
    const players = card.playerIds ?? [];
    const teams = card.teamOnCardIds ?? [];
    if (players.length === 0 || teams.length === 0) continue;
    const key = playerKey(players);
    const sets = evidence.get(key) ?? [];
    if (!sets.some((seen) => sameTeamSet(seen, teams))) {
      sets.push([...new Set<Id<"teams">>(teams)]);
      evidence.set(key, sets);
    }
  }
  return evidence;
}

/**
 * The one team every player on the card agrees on under `pick`, or undefined
 * when any player is unknown, gives no answer, gives more than one, or
 * disagrees with another. Shared by B and C, which differ only in `pick`.
 */
function agreedTeam(
  playerIds: ReadonlyArray<Id<"players">>,
  playersById: ReadonlyMap<string, TeamFillPlayer>,
  pick: (player: TeamFillPlayer) => Array<Id<"teams">>,
): Id<"teams"> | undefined {
  let agreed: Id<"teams"> | undefined;
  for (const playerId of new Set<Id<"players">>(playerIds)) {
    const player = playersById.get(playerId);
    if (!player) return undefined;
    const picked = pick(player);
    if (picked.length !== 1) return undefined;
    if (agreed === undefined) agreed = picked[0];
    else if (agreed !== picked[0]) return undefined;
  }
  return agreed;
}

/**
 * Decide every candidate in one pass over a snapshot.
 *
 * `teamIdsThatExist`, when given, drops any fill naming a team outside it
 * into `remaining` — the caller has read the team rows and knows which are
 * missing or belong to another sport. It is optional so the caller can run
 * the planner once to LEARN which teams to read, then once more to filter;
 * the planner is in-memory and the second pass keeps `byRule`, `groups` and
 * `remaining` consistent with the fills that survive, in one place.
 */
export function planTeamFill(input: {
  /** Every card under the set subtree — evidence and candidates alike. */
  cards: ReadonlyArray<TeamFillCard>;
  playersById: ReadonlyMap<string, TeamFillPlayer>;
  teamIdsThatExist?: ReadonlySet<string>;
  /** Per node: its own season year, else the set's year, else undefined. */
  yearByNodeId: ReadonlyMap<string, number | undefined>;
  currentYear: number;
}): TeamFillPlan {
  const { cards, playersById, teamIdsThatExist, yearByNodeId, currentYear } = input;
  const evidence = buildSamePlayerEvidence(cards);

  const fills: Array<TeamFillDecision> = [];
  const byRule: Record<TeamFillRule, number> = {
    samePlayerInSet: 0,
    oneTeamCareer: 0,
    oneStintInYear: 0,
  };
  const groupCounts = new Map<string, TeamFillGroup>();
  let candidates = 0;
  let remaining = 0;

  for (const card of cards) {
    if (!isTeamFillCandidate(card)) continue;
    candidates += 1;
    const players = card.playerIds ?? [];

    let decision: { teamIds: Array<Id<"teams">>; rule: TeamFillRule } | undefined;

    const seenSets = evidence.get(playerKey(players));
    if (seenSets && seenSets.length === 1) {
      decision = { teamIds: [...seenSets[0]], rule: "samePlayerInSet" };
    }

    if (!decision) {
      const team = agreedTeam(players, playersById, (player) => {
        const teams = distinctTeamIds(player);
        return teams.length === 1 ? teams : [];
      });
      if (team) decision = { teamIds: [team], rule: "oneTeamCareer" };
    }

    if (!decision) {
      const year = yearByNodeId.get(card.selectorOptionId);
      if (year !== undefined) {
        const team = agreedTeam(players, playersById, (player) => {
          const inYear = (player.teamYears ?? []).filter(
            (entry) => entry.fromYear <= year && year <= (entry.toYear ?? currentYear),
          );
          return [...new Set<Id<"teams">>(inYear.map((entry) => entry.teamId))];
        });
        if (team) decision = { teamIds: [team], rule: "oneStintInYear" };
      }
    }

    if (!decision) {
      remaining += 1;
      continue;
    }
    if (teamIdsThatExist && !decision.teamIds.every((id) => teamIdsThatExist.has(id))) {
      remaining += 1;
      continue;
    }

    fills.push({ cardId: card._id, ...decision });
    byRule[decision.rule] += 1;
    const pKey = playerKey(players);
    const tKey = teamKey(decision.teamIds);
    const groupId = `${decision.rule}\n${pKey}\n${tKey}`;
    const group = groupCounts.get(groupId);
    if (group) group.cardCount += 1;
    else groupCounts.set(groupId, { playerKey: pKey, teamKey: tKey, rule: decision.rule, cardCount: 1 });
  }

  const allGroups = [...groupCounts.values()].sort(
    (a, b) =>
      b.cardCount - a.cardCount ||
      a.playerKey.localeCompare(b.playerKey) ||
      a.teamKey.localeCompare(b.teamKey),
  );

  return {
    fills,
    byRule,
    remaining,
    groups: allGroups.slice(0, TEAM_FILL_GROUP_CAP),
    groupsTotal: allGroups.length,
    candidates,
  };
}
