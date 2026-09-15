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
 * A PLAN, computed once from the rows as read across the page walk (each
 * page is its own transaction, so the input is not one consistent snapshot —
 * safe here because the write is additive, empty-only and re-checked per
 * card) and applied only after an operator has seen its counts. It is never
 * silent: nothing here runs from a sync, a cron or a creation path. It writes
 * only `teamOnCardIds` on cards that are still empty at apply time, and never
 * `players.teamYears` — a card's printed team and a player's career are
 * different facts (see `suggestedTeamsForCard`), and a set is evidence for
 * its own cards only.
 *
 * ## Three rules, first answer wins
 *
 *  A. **Same player(s), same set.** Every card in the set subtree with
 *     exactly these players and a non-empty `teamOnCardIds` is evidence, read
 *     at two widths, nearest first:
 *       - `sameNode`  — evidence under the candidate's OWN node (the same
 *         insert, the same parallel). One distinct team set → fill with it.
 *       - `acrossSet` — otherwise, evidence anywhere in the subtree. One
 *         distinct team set → fill with it.
 *     Two or more distinct sets at a width → the set disagrees with itself
 *     there (a traded player's base card vs. his update card) and A stays
 *     silent at that width rather than pick one; ambiguous at both widths and
 *     B and C get a turn. The width is recorded on the decision because a
 *     team borrowed from another node is a longer reach, and the preview
 *     lists those first and names the nodes it would write to.
 *     Evidence is what was read: a fill made by this run is never evidence
 *     for another card in the same run, so the result does not depend on the
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
 * How far a decision reached for its evidence. `sameNode` and `acrossSet`
 * are rule A's two widths; `career` is rules B and C, whose evidence is the
 * player row rather than the set. It is on the decision (not derivable from
 * the rule) so the preview can rank a cross-node borrow as riskier than a
 * same-node one, and say which nodes it touches.
 */
export type TeamFillScope = "sameNode" | "acrossSet" | "career";

/** How many distinct target nodes a group names; `nodeCount` carries the rest. */
export const TEAM_FILL_GROUP_NODE_CAP = 4;

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
  /** Projected form of `pendingTeamNames.length > 0`. Wins over the strings when set. */
  hasPendingTeamNames?: boolean;
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
  scope: TeamFillScope;
};

export type TeamFillGroup = {
  /** `playerKey(playerIds)` — sorted, deduped, "|"-joined. */
  playerKey: string;
  /** `teamKey(teamIds)` — same shape, over the fill's teams. */
  teamKey: string;
  rule: TeamFillRule;
  scope: TeamFillScope;
  /** Distinct nodes the group's cards sit under, in first-seen order, at most `TEAM_FILL_GROUP_NODE_CAP`. */
  nodeIds: Array<Id<"selectorOptions">>;
  /** How many distinct nodes there were before the cap. */
  nodeCount: number;
  cardCount: number;
};

export type TeamFillPlan = {
  fills: Array<TeamFillDecision>;
  byRule: Record<TeamFillRule, number>;
  /** Candidates no rule could answer, plus fills dropped by `teamIdsThatExist`. */
  remaining: number;
  /**
   * Distinct (players, teams, rule, scope) groups, riskiest first: career
   * rules (B, C), then A across the set, then A within a node; most cards
   * first inside a tier. Capped.
   */
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
  const hasPendingTeamNames =
    card.hasPendingTeamNames ?? (card.pendingTeamNames?.length ?? 0) > 0;
  if (hasPendingTeamNames) return false;
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

type Evidence = {
  /** `playerKey` → distinct team sets seen anywhere in the subtree. */
  acrossSet: Map<string, Array<Array<Id<"teams">>>>;
  /** `nodeId + "\n" + playerKey` → distinct team sets seen under that node. */
  sameNode: Map<string, Array<Array<Id<"teams">>>>;
};

function sameNodeKey(nodeId: Id<"selectorOptions">, pKey: string): string {
  return `${nodeId}\n${pKey}`;
}

function addEvidence(
  map: Map<string, Array<Array<Id<"teams">>>>,
  key: string,
  teams: ReadonlyArray<Id<"teams">>,
): void {
  const sets = map.get(key) ?? [];
  if (!sets.some((seen) => sameTeamSet(seen, teams))) {
    sets.push([...new Set<Id<"teams">>(teams)]);
    map.set(key, sets);
  }
}

/**
 * Rule A's evidence, built once at both widths. Each value is the list of
 * DISTINCT team sets seen among teamed cards with those players; two entries
 * means the set disagrees with itself at that width and A declines there.
 */
function buildSamePlayerEvidence(cards: ReadonlyArray<TeamFillCard>): Evidence {
  const evidence: Evidence = { acrossSet: new Map(), sameNode: new Map() };
  for (const card of cards) {
    const players = card.playerIds ?? [];
    const teams = card.teamOnCardIds ?? [];
    if (players.length === 0 || teams.length === 0) continue;
    const key = playerKey(players);
    addEvidence(evidence.acrossSet, key, teams);
    addEvidence(evidence.sameNode, sameNodeKey(card.selectorOptionId, key), teams);
  }
  return evidence;
}

/** The single team set at a width, or undefined when none or several. */
function soleTeamSet(
  sets: Array<Array<Id<"teams">>> | undefined,
): Array<Id<"teams">> | undefined {
  return sets && sets.length === 1 ? [...sets[0]] : undefined;
}

/**
 * Sort tier for the preview: the further a decision reached, the earlier it
 * is listed, so an operator scanning the top of the ledger sees the borrows
 * most worth a second look.
 */
function riskTier(rule: TeamFillRule, scope: TeamFillScope): number {
  if (rule !== "samePlayerInSet") return 0;
  return scope === "acrossSet" ? 1 : 2;
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
 * Decide every candidate in one pass over the rows as read.
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
  type GroupAccumulator = Omit<TeamFillGroup, "nodeIds" | "nodeCount"> & {
    nodes: Set<Id<"selectorOptions">>;
  };
  const groupCounts = new Map<string, GroupAccumulator>();
  let candidates = 0;
  let remaining = 0;

  for (const card of cards) {
    if (!isTeamFillCandidate(card)) continue;
    candidates += 1;
    const players = card.playerIds ?? [];
    const pKey = playerKey(players);

    let decision:
      | { teamIds: Array<Id<"teams">>; rule: TeamFillRule; scope: TeamFillScope }
      | undefined;

    const nearby = soleTeamSet(evidence.sameNode.get(sameNodeKey(card.selectorOptionId, pKey)));
    if (nearby) {
      decision = { teamIds: nearby, rule: "samePlayerInSet", scope: "sameNode" };
    } else {
      const anywhere = soleTeamSet(evidence.acrossSet.get(pKey));
      if (anywhere) {
        decision = { teamIds: anywhere, rule: "samePlayerInSet", scope: "acrossSet" };
      }
    }

    if (!decision) {
      const team = agreedTeam(players, playersById, (player) => {
        const teams = distinctTeamIds(player);
        return teams.length === 1 ? teams : [];
      });
      if (team) decision = { teamIds: [team], rule: "oneTeamCareer", scope: "career" };
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
        if (team) decision = { teamIds: [team], rule: "oneStintInYear", scope: "career" };
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
    const tKey = teamKey(decision.teamIds);
    const groupId = `${decision.rule}\n${decision.scope}\n${pKey}\n${tKey}`;
    const group = groupCounts.get(groupId);
    if (group) {
      group.cardCount += 1;
      group.nodes.add(card.selectorOptionId);
    } else {
      groupCounts.set(groupId, {
        playerKey: pKey,
        teamKey: tKey,
        rule: decision.rule,
        scope: decision.scope,
        nodes: new Set([card.selectorOptionId]),
        cardCount: 1,
      });
    }
  }

  const allGroups: Array<TeamFillGroup> = [...groupCounts.values()]
    .map(({ nodes, ...group }) => ({
      ...group,
      nodeIds: [...nodes].slice(0, TEAM_FILL_GROUP_NODE_CAP),
      nodeCount: nodes.size,
    }))
    .sort(
      (a, b) =>
        riskTier(a.rule, a.scope) - riskTier(b.rule, b.scope) ||
        b.cardCount - a.cardCount ||
        a.playerKey.localeCompare(b.playerKey) ||
        a.teamKey.localeCompare(b.teamKey) ||
        a.rule.localeCompare(b.rule),
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
