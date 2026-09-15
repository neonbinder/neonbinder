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
 * different facts (see `suggestedTeamsForCard`).
 *
 * ## The tiers, first answer wins
 *
 * Evidence is the rows AS READ: a fill made by this run is never evidence for
 * another card in the same run, so the result does not depend on the order
 * cards were read.
 *
 * Two WHOLE-CARD tiers first — they answer for the card as printed:
 *
 *  1. **sameNode.** Cards under the candidate's OWN node (the same insert,
 *     the same parallel) with the identical player set and a non-empty
 *     `teamOnCardIds`. Exactly one distinct team set → fill with it. Two or
 *     more → the node disagrees with itself (a traded player's base card vs.
 *     the update card) and the tier stays silent rather than pick one.
 *  2. **parallelOf.** Only when the candidate's node is a `parallel`: a
 *     parallel is, by definition, the same card printed again, so the card it
 *     parallels — the one under the parent node with the SAME card number AND
 *     the identical player set — carries its team. Exactly one such card, and
 *     it has a team → fill with that team set. Card numbers are never unique
 *     at any scope (product invariant 7), so the player set is part of the
 *     match and two matches means no answer; and a number match with
 *     different players is a different card, never evidence.
 *
 * Then PER PLAYER, each player on the card independently, in this order:
 *
 *  3. **baseSet.** The base checklist is the cards under the variantType
 *     node flagged `metadata.isBase` (an NB role, never the literal "Base");
 *     a set with no flagged node skips this tier. A player's SINGLE-player
 *     base cards with a team are that player's evidence; exactly one distinct
 *     team set → that is their team here. A candidate that is itself in the
 *     base checklist skips this tier — tier 1 already was its base.
 *  B. **One-team career.** Every stint the player has names the same team.
 *     This is what answers the retired-player case: a 1960s Yankee on a 2026
 *     insert has no stint covering 2026, but that career has one team.
 *  C. **One stint covering the node's year.** Exactly one stint spans the
 *     card's year (`fromYear <= year <= (toYear ?? currentYear)`, an open
 *     stint being a current team). A node's own `features.season` outranks
 *     the set's year — the same precedence `findSetYearForSelectorOption`
 *     applies — and a node with no resolvable year skips C.
 *
 * The card's team set is the UNION of every player's answer, deduped: a
 * League Leaders card is frequently one team per player, and the honest fill
 * is all of them. ANY player unresolved or ambiguous → the card stays in the
 * attention lane, no partial fill; a union past `MAX_CARD_TEAMS` likewise.
 * A single-player card is the degenerate case and resolves exactly as one
 * answer would.
 *
 * ## What is deliberately NOT evidence
 *
 * Another insert's cards. "Brett Favre could be a Jet in one insert and a
 * Packer in another" — a team borrowed across inserts is a guess dressed as a
 * fact, so there is no whole-set tier. The base set is the one cross-node
 * source, because it is the set's statement of who a player is here, and it
 * is read per player and single-player-card only so a combo card's team list
 * never leaks onto a solo card.
 *
 * ## Attribution
 *
 * A decision carries a `rule` (what the preview counts by — tiers 1–3 are
 * all `samePlayerInSet`, B is `oneTeamCareer`, C is `oneStintInYear`) and a
 * `scope` (how far it reached). When a card's players resolved through
 * different tiers the card is attributed to the RISKIEST one and flagged
 * `mixed`, so the ledger can say "each player's own team" and sort it where a
 * second look pays.
 *
 * ## Pure by contract
 *
 * Ids in, plan out. No ctx, no generated code beyond the `Id` type, so a lib
 * test can drive every rule from literal rows. The Convex module
 * (`convex/teamFill.ts`) reads the subtree, players and teams, and re-checks
 * each card at apply time; this module decides.
 */

import type { Id } from "../_generated/dataModel";
import { MAX_CARD_TEAMS } from "../features/cardAttention";
import { sameTeamSet } from "./selectorTeams";

export type TeamFillRule = "samePlayerInSet" | "oneTeamCareer" | "oneStintInYear";

/**
 * How far a decision reached for its evidence, riskiest last:
 *
 *   - `parallelOf` — the card it parallels: the same card by definition.
 *   - `sameNode`   — the same player under the same node.
 *   - `baseSet`    — the player's base card, read across nodes.
 *   - `career`     — rules B and C, whose evidence is the player row, not
 *                    the set.
 *
 * It is on the decision (not derivable from the rule) so the preview can rank
 * a reach and say which nodes it touches.
 */
export type TeamFillScope = "sameNode" | "parallelOf" | "baseSet" | "career";

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
  /** Tier 2 matches on it; a card without one is never a parallel match. */
  cardNumber?: string;
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

/** What the planner needs to know about a node of the subtree. */
export type TeamFillNode = {
  level: string;
  parentId?: Id<"selectorOptions">;
};

export type TeamFillDecision = {
  cardId: Id<"cardChecklist">;
  teamIds: Array<Id<"teams">>;
  rule: TeamFillRule;
  scope: TeamFillScope;
  /** The card's players resolved through different tiers; `rule`/`scope` name the riskiest. */
  mixed: boolean;
};

export type TeamFillGroup = {
  /** `playerKey(playerIds)` — sorted, deduped, "|"-joined. */
  playerKey: string;
  /** `teamKey(teamIds)` — same shape, over the fill's teams. */
  teamKey: string;
  rule: TeamFillRule;
  scope: TeamFillScope;
  mixed: boolean;
  /** Distinct nodes the group's cards sit under, in first-seen order, at most `TEAM_FILL_GROUP_NODE_CAP`. */
  nodeIds: Array<Id<"selectorOptions">>;
  /** How many distinct nodes there were before the cap. */
  nodeCount: number;
  cardCount: number;
};

export type TeamFillPlan = {
  fills: Array<TeamFillDecision>;
  byRule: Record<TeamFillRule, number>;
  /** Candidates no tier could answer, plus fills dropped by `teamIdsThatExist`. */
  remaining: number;
  /**
   * Distinct (rule, scope, mixed, players, teams) groups, riskiest first:
   * career (B, C), then the base set, then the same node, then the card a
   * parallel copies; most cards first inside a tier. Capped.
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
 * dual-auto of one player twice and a card listing them once are the same
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

type TeamSets = Array<Array<Id<"teams">>>;

type Evidence = {
  /** `nodeId + "\n" + playerKey` → distinct team sets seen under that node (tier 1). */
  sameNode: Map<string, TeamSets>;
  /** `nodeId + "\n" + cardNumber + "\n" + playerKey` → EVERY card there, teamed or not (tier 2). */
  byNumber: Map<string, Array<TeamFillCard>>;
  /** `playerId` → distinct team sets on that player's SINGLE-player base cards (tier 3). */
  base: Map<string, TeamSets>;
};

function sameNodeKey(nodeId: Id<"selectorOptions">, pKey: string): string {
  return `${nodeId}\n${pKey}`;
}

function byNumberKey(nodeId: Id<"selectorOptions">, cardNumber: string, pKey: string): string {
  return `${nodeId}\n${cardNumber}\n${pKey}`;
}

function addTeamSet(map: Map<string, TeamSets>, key: string, teams: ReadonlyArray<Id<"teams">>): void {
  const sets = map.get(key) ?? [];
  if (!sets.some((seen) => sameTeamSet(seen, teams))) {
    sets.push([...new Set<Id<"teams">>(teams)]);
    map.set(key, sets);
  }
}

/**
 * Every tier's evidence, built once from the rows as read. Each team-set
 * value is the list of DISTINCT sets seen; two entries means the source
 * disagrees with itself there and the tier declines.
 */
function buildEvidence(
  cards: ReadonlyArray<TeamFillCard>,
  baseNodeId: Id<"selectorOptions"> | null,
): Evidence {
  const evidence: Evidence = { sameNode: new Map(), byNumber: new Map(), base: new Map() };
  for (const card of cards) {
    const players = card.playerIds ?? [];
    if (players.length === 0) continue;
    const key = playerKey(players);
    if (card.cardNumber !== undefined) {
      const numberKey = byNumberKey(card.selectorOptionId, card.cardNumber, key);
      const matches = evidence.byNumber.get(numberKey) ?? [];
      matches.push(card);
      evidence.byNumber.set(numberKey, matches);
    }
    const teams = card.teamOnCardIds ?? [];
    if (teams.length === 0) continue;
    addTeamSet(evidence.sameNode, sameNodeKey(card.selectorOptionId, key), teams);
    if (baseNodeId !== null && card.selectorOptionId === baseNodeId) {
      const distinct = splitKey<Id<"players">>(key);
      if (distinct.length === 1) addTeamSet(evidence.base, distinct[0], teams);
    }
  }
  return evidence;
}

/** The single team set, or undefined when none or several. */
function soleTeamSet(sets: TeamSets | undefined): Array<Id<"teams">> | undefined {
  return sets && sets.length === 1 ? [...sets[0]] : undefined;
}

/**
 * Sort tier for the preview: the further a decision reached, the earlier it
 * is listed, so an operator scanning the top of the ledger sees the fills
 * most worth a second look. The card a parallel copies is the same card by
 * definition, so it lists last.
 */
function riskTier(scope: TeamFillScope): number {
  switch (scope) {
    case "career":
      return 0;
    case "baseSet":
      return 1;
    case "sameNode":
      return 2;
    case "parallelOf":
      return 3;
  }
}

/**
 * How risky each per-player tier is, for attributing a mixed card: a stint
 * inferred from a year is the longest reach, a one-team career next, the
 * base card the shortest. Higher is riskier.
 */
function playerTierRisk(tier: PlayerTier): number {
  switch (tier) {
    case "baseSet":
      return 0;
    case "oneTeamCareer":
      return 1;
    case "oneStintInYear":
      return 2;
  }
}

type PlayerTier = "baseSet" | "oneTeamCareer" | "oneStintInYear";

type PlayerAnswer = { teamIds: Array<Id<"teams">>; tier: PlayerTier };

/**
 * One player's answer through tiers 3 → B → C, or undefined when none can
 * honestly give one. `inBase` is true when the candidate itself sits in the
 * base checklist, which makes tier 3 a repeat of tier 1 and so skipped.
 */
function resolvePlayer(input: {
  playerId: Id<"players">;
  player: TeamFillPlayer | undefined;
  evidence: Evidence;
  inBase: boolean;
  year: number | undefined;
  currentYear: number;
}): PlayerAnswer | undefined {
  const { playerId, player, evidence, inBase, year, currentYear } = input;

  if (!inBase) {
    const fromBase = soleTeamSet(evidence.base.get(playerId));
    if (fromBase) return { teamIds: fromBase, tier: "baseSet" };
  }

  if (!player) return undefined;

  const career = distinctTeamIds(player);
  if (career.length === 1) return { teamIds: career, tier: "oneTeamCareer" };

  if (year !== undefined) {
    const inYear = new Set<Id<"teams">>();
    for (const entry of player.teamYears ?? []) {
      if (entry.fromYear <= year && year <= (entry.toYear ?? currentYear)) inYear.add(entry.teamId);
    }
    if (inYear.size === 1) return { teamIds: [...inYear], tier: "oneStintInYear" };
  }

  return undefined;
}

type Decision = Omit<TeamFillDecision, "cardId">;

/** Tier 1: the same players teamed under the same node, one way. */
function decideSameNode(card: TeamFillCard, pKey: string, evidence: Evidence): Decision | undefined {
  const nearby = soleTeamSet(evidence.sameNode.get(sameNodeKey(card.selectorOptionId, pKey)));
  if (!nearby) return undefined;
  return { teamIds: nearby, rule: "samePlayerInSet", scope: "sameNode", mixed: false };
}

/** Tier 2: the one card under the parent node this parallel is a copy of. */
function decideParallelOf(
  card: TeamFillCard,
  pKey: string,
  evidence: Evidence,
  nodesById: ReadonlyMap<string, TeamFillNode>,
): Decision | undefined {
  const node = nodesById.get(card.selectorOptionId);
  if (!node || node.level !== "parallel" || node.parentId === undefined) return undefined;
  if (card.cardNumber === undefined) return undefined;
  const matches = evidence.byNumber.get(byNumberKey(node.parentId, card.cardNumber, pKey));
  if (!matches || matches.length !== 1) return undefined;
  const teams = matches[0].teamOnCardIds ?? [];
  if (teams.length === 0) return undefined;
  return {
    teamIds: [...new Set<Id<"teams">>(teams)],
    rule: "samePlayerInSet",
    scope: "parallelOf",
    mixed: false,
  };
}

/** Tiers 3 → B → C, per player, unioned; undefined when any player has no answer. */
function decidePerPlayer(input: {
  card: TeamFillCard;
  players: ReadonlyArray<Id<"players">>;
  playersById: ReadonlyMap<string, TeamFillPlayer>;
  evidence: Evidence;
  baseNodeId: Id<"selectorOptions"> | null;
  year: number | undefined;
  currentYear: number;
}): Decision | undefined {
  const { card, players, playersById, evidence, baseNodeId, year, currentYear } = input;
  const inBase = baseNodeId !== null && card.selectorOptionId === baseNodeId;
  const union = new Set<Id<"teams">>();
  const tiers = new Set<PlayerTier>();
  let riskiest: PlayerTier | undefined;
  for (const playerId of new Set<Id<"players">>(players)) {
    const answer = resolvePlayer({
      playerId,
      player: playersById.get(playerId),
      evidence,
      inBase,
      year,
      currentYear,
    });
    if (!answer) return undefined;
    for (const teamId of answer.teamIds) union.add(teamId);
    tiers.add(answer.tier);
    if (riskiest === undefined || playerTierRisk(answer.tier) > playerTierRisk(riskiest)) {
      riskiest = answer.tier;
    }
  }
  if (riskiest === undefined || union.size === 0 || union.size > MAX_CARD_TEAMS) return undefined;
  return {
    teamIds: [...union],
    rule: riskiest === "baseSet" ? "samePlayerInSet" : riskiest,
    scope: riskiest === "baseSet" ? "baseSet" : "career",
    mixed: tiers.size > 1,
  };
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
  /** Per node: level and parent, so tier 2 knows which node a parallel copies. */
  nodesById: ReadonlyMap<string, TeamFillNode>;
  /** The variantType node flagged `metadata.isBase`, or null when the set has none. */
  baseNodeId: Id<"selectorOptions"> | null;
  currentYear: number;
}): TeamFillPlan {
  const { cards, playersById, teamIdsThatExist, yearByNodeId, nodesById, baseNodeId, currentYear } =
    input;
  const evidence = buildEvidence(cards, baseNodeId);

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

    const decision =
      decideSameNode(card, pKey, evidence) ??
      decideParallelOf(card, pKey, evidence, nodesById) ??
      decidePerPlayer({
        card,
        players,
        playersById,
        evidence,
        baseNodeId,
        year: yearByNodeId.get(card.selectorOptionId),
        currentYear,
      });

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
    const groupId = `${decision.rule}\n${decision.scope}\n${decision.mixed}\n${pKey}\n${tKey}`;
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
        mixed: decision.mixed,
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
        riskTier(a.scope) - riskTier(b.scope) ||
        b.cardCount - a.cardCount ||
        a.playerKey.localeCompare(b.playerKey) ||
        a.teamKey.localeCompare(b.teamKey) ||
        a.rule.localeCompare(b.rule) ||
        Number(a.mixed) - Number(b.mixed),
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
