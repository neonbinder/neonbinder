/**
 * NEO-424 — what a set has ALREADY decided about a name, for the review gate.
 *
 * Jason's rule A: a name already linked on a committed card anywhere in the
 * set (base, inserts, parallels; not the variant being fetched) to exactly one
 * player IS that player, in any sport, with no wizard step. A name the set has
 * linked to two or more players is a pick step between exactly those players.
 * Set history outranks today's in-sport lookup, because it is the operator's
 * own earlier answer for this very product: Bo Jackson linked once on the
 * base card of a baseball set is Bo Jackson on its inserts too, whatever the
 * baseball roster says.
 *
 * Rule F applies the same to teams, keyed only on the team name the fetched
 * card itself prints. A team is never derived from a player's history.
 *
 * Rule E1 reuses the same scan on the same product one year earlier
 * (`findPriorYearSameProduct`), not as an answer but as a PRESELECT the
 * operator confirms; rule E2 (`findOnlyNamesakes`) preselects the one player
 * in any sport who answers to a name nobody in the set's sport does.
 *
 * ## Facts, not decisions
 *
 * Everything here reads; nothing writes. The gate
 * (`selectorOptions.resolveUnknownsAndStartBatch`) turns the answers into
 * `startBatch` arguments, and `startBatch` writes them as review rows with a
 * `link` decision (`autoLinked`), which the operator sees in the wizard's
 * Decided list and can Change. They are never written to
 * `checklistNameResolutions`: that fast path runs before decisions in the
 * commit prelude, so a Change would not stick (plan decision D1).
 *
 * ## Only committed cards count
 *
 * `cardChecklist` rows are committed cards; a fetch's candidates live in
 * `checklistCandidates` until the operator confirms them, and are never read
 * here. Each linked player is keyed under three kinds of name, all through
 * the `normalizePlayerName` the gate keys on:
 *
 *  - the PRINTED name, `playerLinks[].nameOnCard` (NEO-254), the string the
 *    card actually carried;
 *  - the player's PRIMARY name;
 *  - every one of his ALIASES.
 *
 * The last two are what make a cross-sport player printed one way on the
 * base card and another way on an insert ("Vincent Jackson" / "Bo Jackson")
 * the same history. They are safe because the player IS linked in this set:
 * the keys only say which names he answers to, and two different players
 * under one key still make a pick step, never a link. A legacy card with
 * `playerIds` and no `playerLinks` contributes the same primary and alias
 * keys, which is what the NEO-254 backfill wrote for such rows anyway.
 *
 * ## Budgets (plan decision D12)
 *
 * The scan runs inside an ACTION, so every read is its own bounded
 * `internalQuery`:
 *
 *  - `historyNodes` walks the set's subtree through `by_parent` (one index
 *    range per non-parallel node, a few dozen for a big set; capped at
 *    `SET_HISTORY_MAX_NODES`).
 *  - `historyCardBatch` reads at most `SET_HISTORY_CARDS_PER_CALL` committed
 *    cards per call through `cardChecklist.by_selector_option`: one node's
 *    page via `paginate` (≤ 500 per node), then as many further WHOLE small
 *    nodes as fit. Small nodes share a call, so a set of two hundred thin
 *    parallels costs a few calls rather than two hundred. Parallel-level
 *    nodes come LAST, because they almost always repeat the names of the
 *    cards they parallel; if the call cap is ever reached it is spent on the
 *    nodes that carry new evidence first.
 *  - `historyPlayersByIds` / `historyTeamsByIds` resolve ids at most
 *    `SET_HISTORY_IDS_PER_CALL` per call.
 *
 * Reaching `SET_HISTORY_MAX_CALLS` or `SET_HISTORY_MAX_NODES` makes the
 * history INCOMPLETE, and an incomplete history is not used at all. A partial
 * scan could see one of two players a name was linked to and auto-link the
 * name to him: "exactly one" decided on half the evidence is the guess this
 * product never makes. Falling back costs only the convenience.
 */

import { v } from "convex/values";
import { internalQuery } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  collectSubtreeNodes,
  findPriorYearSameProduct,
  findSetForSelectorOption,
} from "./lib/selectorAncestry";
import { namesakesAcrossSports, normalizePlayerName } from "./players";
import { normalizeTeamName } from "./teams";
import { teamFullName } from "../lib/teams/team-name";

/** Committed cards one `historyCardBatch` call reads (plus at most one probe row). */
export const SET_HISTORY_CARDS_PER_CALL = 500;
/** Nodes one `historyCardBatch` call is handed. Bounds the argument, not the reads. */
export const SET_HISTORY_NODES_PER_CALL = 100;
/** Subtree nodes `historyNodes` walks before declaring the history incomplete. */
export const SET_HISTORY_MAX_NODES = 2000;
/**
 * `historyCardBatch` calls one scan may make before declaring the history
 * incomplete: 200 × 500 = 100,000 committed cards, far past any real set.
 */
export const SET_HISTORY_MAX_CALLS = 200;
/** Ids one `historyPlayersByIds` / `historyTeamsByIds` call resolves. */
export const SET_HISTORY_IDS_PER_CALL = 300;
/**
 * Names one `findOnlyNamesakes` call answers. Each name is two index reads
 * plus at most two point reads (and one memoised sport read), so 150 names is
 * ≤ ~750 operations at the very worst and ~300 for the ordinary name that
 * matches nobody anywhere.
 */
export const NAMESAKE_NAMES_PER_CALL = 150;

// ─── Queries ────────────────────────────────────────────────────────────────

/**
 * The nodes whose committed cards make up a set's history, parallel-level
 * nodes last.
 *
 * The root is the `setName` row `selectorOptionId` sits under (itself, when it
 * is one). With `excludeSelf`, `selectorOptionId` itself is left out: that is
 * the variant being fetched, whose own cards are what the fetch is about to
 * re-commit and so are not "the set's earlier answer". Its sub-variants stay
 * in, because they are other cards.
 *
 * No `setName` ancestor (an orphaned subtree, a fixture without one) is an
 * empty, COMPLETE history: there is no set to have decided anything.
 */
export const historyNodes = internalQuery({
  args: {
    selectorOptionId: v.id("selectorOptions"),
    excludeSelf: v.boolean(),
  },
  returns: v.object({
    nodeIds: v.array(v.id("selectorOptions")),
    truncated: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const rootId = await findSetForSelectorOption(ctx, args.selectorOptionId);
    if (!rootId) return { nodeIds: [], truncated: false };
    const { nodes, truncated } = await collectSubtreeNodes(
      ctx,
      rootId,
      SET_HISTORY_MAX_NODES,
    );
    const kept = nodes.filter(
      (node) => !(args.excludeSelf && node._id === args.selectorOptionId),
    );
    const nodeIds = [
      ...kept.filter((node) => node.level !== "parallel"),
      ...kept.filter((node) => node.level === "parallel"),
    ].map((node) => node._id);
    return { nodeIds, truncated };
  },
});

/** What one batch of committed cards says about names and teams. */
const cardBatchValidator = v.object({
  links: v.array(
    v.object({ nameNormalized: v.string(), playerId: v.id("players") }),
  ),
  legacyPlayerIds: v.array(v.id("players")),
  teamIds: v.array(v.id("teams")),
  /** How many of `nodeIds` this call read to the end. */
  nodesDone: v.number(),
  /** Where `nodeIds[nodesDone]` resumes, when this call stopped inside it. */
  cursor: v.union(v.string(), v.null()),
});

/**
 * One bounded slice of the history's committed cards. See the module note
 * for the shape of the budget.
 *
 * `nodeIds[0]` is read with `paginate` from `cursor` (the one paginated read
 * a query may make); if it does not finish, the call ends there and hands
 * back its cursor. Otherwise each following node is read with
 * `.take(remaining + 1)`: a node that fits is consumed whole, and the first
 * one that does not is left for the next call, which paginates it as its own
 * `nodeIds[0]`. The probe row is the only read ever repeated.
 */
export const historyCardBatch = internalQuery({
  args: {
    nodeIds: v.array(v.id("selectorOptions")),
    cursor: v.union(v.string(), v.null()),
  },
  returns: cardBatchValidator,
  handler: async (ctx, args) => {
    if (args.nodeIds.length > SET_HISTORY_NODES_PER_CALL) {
      throw new Error(
        `historyCardBatch: ${args.nodeIds.length} nodes exceeds the ` +
          `${SET_HISTORY_NODES_PER_CALL} per call — slice them`,
      );
    }
    const links = new Map<string, { nameNormalized: string; playerId: Id<"players"> }>();
    const legacy = new Set<Id<"players">>();
    const teams = new Set<Id<"teams">>();
    const absorb = (cards: ReadonlyArray<Doc<"cardChecklist">>) => {
      for (const card of cards) {
        const printed = card.playerLinks ?? [];
        if (printed.length > 0) {
          for (const link of printed) {
            const nameNormalized = normalizePlayerName(link.nameOnCard);
            if (!nameNormalized) continue;
            links.set(`${nameNormalized}|${link.playerId as string}`, {
              nameNormalized,
              playerId: link.playerId,
            });
          }
        } else {
          for (const playerId of card.playerIds ?? []) legacy.add(playerId);
        }
        for (const teamId of card.teamOnCardIds ?? []) teams.add(teamId);
      }
    };
    const result = (nodesDone: number, cursor: string | null) => ({
      links: Array.from(links.values()),
      legacyPlayerIds: Array.from(legacy),
      teamIds: Array.from(teams),
      nodesDone,
      cursor,
    });

    if (args.nodeIds.length === 0) return result(0, null);
    const first = await ctx.db
      .query("cardChecklist")
      .withIndex("by_selector_option", (q) =>
        q.eq("selectorOptionId", args.nodeIds[0]),
      )
      .paginate({ cursor: args.cursor, numItems: SET_HISTORY_CARDS_PER_CALL });
    absorb(first.page);
    if (!first.isDone) return result(0, first.continueCursor);
    let cards = first.page.length;
    let nodesDone = 1;
    for (let i = 1; i < args.nodeIds.length; i++) {
      const remaining = SET_HISTORY_CARDS_PER_CALL - cards;
      if (remaining <= 0) break;
      const rows = await ctx.db
        .query("cardChecklist")
        .withIndex("by_selector_option", (q) =>
          q.eq("selectorOptionId", args.nodeIds[i]),
        )
        .take(remaining + 1);
      if (rows.length > remaining) break;
      absorb(rows);
      cards += rows.length;
      nodesDone++;
    }
    return result(nodesDone, null);
  },
});

/**
 * The players behind a list of ids: their name keys (primary name and every
 * alias, for the history index), home sport and its label (for an auto-link
 * row's sport and a preselect's "(Football)"). Dangling ids are left out. Refused above
 * `SET_HISTORY_IDS_PER_CALL`, like `findSkippedEntityNames`, so a caller that
 * forgets to slice is told rather than quietly served a short answer.
 */
export const historyPlayersByIds = internalQuery({
  args: { playerIds: v.array(v.id("players")) },
  returns: v.array(
    v.object({
      playerId: v.id("players"),
      nameNormalized: v.string(),
      /** NEO-424 — every alias, normalised, deduped, own name left out. */
      aliasesNormalized: v.array(v.string()),
      sportId: v.id("selectorOptions"),
      sportValue: v.union(v.string(), v.null()),
    }),
  ),
  handler: async (ctx, args) => {
    if (args.playerIds.length > SET_HISTORY_IDS_PER_CALL) {
      throw new Error(
        `historyPlayersByIds: ${args.playerIds.length} ids exceeds the ` +
          `${SET_HISTORY_IDS_PER_CALL} per call — slice them`,
      );
    }
    const sportValueById = new Map<string, string | null>();
    const out: Array<{
      playerId: Id<"players">;
      nameNormalized: string;
      aliasesNormalized: string[];
      sportId: Id<"selectorOptions">;
      sportValue: string | null;
    }> = [];
    for (const playerId of new Set(args.playerIds)) {
      const player = await ctx.db.get(playerId);
      if (!player) continue;
      const sportKey = player.sportId as string;
      if (!sportValueById.has(sportKey)) {
        const sport = await ctx.db.get(player.sportId);
        sportValueById.set(sportKey, sport?.value ?? null);
      }
      out.push({
        playerId,
        nameNormalized: player.nameNormalized,
        aliasesNormalized: Array.from(
          new Set(
            (player.aliases ?? [])
              .map((alias) => normalizePlayerName(alias))
              .filter((key) => key.length > 0 && key !== player.nameNormalized),
          ),
        ),
        sportId: player.sportId,
        sportValue: sportValueById.get(sportKey) ?? null,
      });
    }
    return out;
  },
});

/**
 * The teams behind a list of ids, each with the name keys a card might print
 * it under: the composed full name, the bare nickname and every alias, all
 * through `normalizeTeamName`, the key the gate's own team names use.
 * Dangling ids are left out; refused above `SET_HISTORY_IDS_PER_CALL`.
 */
export const historyTeamsByIds = internalQuery({
  args: { teamIds: v.array(v.id("teams")) },
  returns: v.array(
    v.object({
      teamId: v.id("teams"),
      sportId: v.id("selectorOptions"),
      fullName: v.string(),
      keys: v.array(v.string()),
    }),
  ),
  handler: async (ctx, args) => {
    if (args.teamIds.length > SET_HISTORY_IDS_PER_CALL) {
      throw new Error(
        `historyTeamsByIds: ${args.teamIds.length} ids exceeds the ` +
          `${SET_HISTORY_IDS_PER_CALL} per call — slice them`,
      );
    }
    const out: Array<{
      teamId: Id<"teams">;
      sportId: Id<"selectorOptions">;
      fullName: string;
      keys: string[];
    }> = [];
    for (const teamId of new Set(args.teamIds)) {
      const team = await ctx.db.get(teamId);
      if (!team) continue;
      const fullName = teamFullName(team);
      const keys = new Set(
        [fullName, team.name, ...(team.aliases ?? [])]
          .map((raw) => normalizeTeamName(raw))
          .filter((key) => key.length > 0),
      );
      out.push({ teamId, sportId: team.sportId, fullName, keys: Array.from(keys) });
    }
    return out;
  },
});

/**
 * Rule E1 — the same product one year earlier, as a `setName` id, or null.
 * A thin wrapper so the action can ask; the walk and its exactly-one rules
 * live in `lib/selectorAncestry.ts`.
 */
export const findPriorYearProduct = internalQuery({
  args: { selectorOptionId: v.id("selectorOptions") },
  returns: v.union(v.id("selectorOptions"), v.null()),
  handler: async (ctx, args) =>
    (await findPriorYearSameProduct(ctx, args.selectorOptionId)) ?? null,
});

/**
 * Rule E2 — for each name key, the ONE player who answers to it in any sport,
 * when there is exactly one. Names with none or several are left out. At most
 * `NAMESAKE_NAMES_PER_CALL` keys per call, refused above that.
 *
 * `namesakesAcrossSports(…, 2)` reads just far enough to see a second
 * distinct player, which is all "exactly one" needs.
 */
export const findOnlyNamesakes = internalQuery({
  args: { names: v.array(v.string()) },
  returns: v.array(
    v.object({
      nameNormalized: v.string(),
      playerId: v.id("players"),
      sportId: v.id("selectorOptions"),
      sportValue: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    if (args.names.length > NAMESAKE_NAMES_PER_CALL) {
      throw new Error(
        `findOnlyNamesakes: ${args.names.length} names exceeds the ` +
          `${NAMESAKE_NAMES_PER_CALL} per call — slice them`,
      );
    }
    const sportValueById = new Map<string, string | null>();
    const out: Array<{
      nameNormalized: string;
      playerId: Id<"players">;
      sportId: Id<"selectorOptions">;
      sportValue: string;
    }> = [];
    for (const nameNormalized of new Set(args.names)) {
      const { players: found, complete } = await namesakesAcrossSports(
        ctx,
        nameNormalized,
        2,
      );
      // An answer cut short by the alias cap is not "exactly one".
      if (!complete || found.length !== 1) continue;
      const [player] = found;
      const sportKey = player.sportId as string;
      if (!sportValueById.has(sportKey)) {
        const sport = await ctx.db.get(player.sportId);
        sportValueById.set(sportKey, sport?.value ?? null);
      }
      const sportValue = sportValueById.get(sportKey);
      // A sport row with no label cannot be named on the button; no preselect
      // is better than "Link to Bo Jackson ()".
      if (!sportValue) continue;
      out.push({ nameNormalized, playerId: player._id, sportId: player.sportId, sportValue });
    }
    return out;
  },
});

// ─── The scan, for an action ────────────────────────────────────────────────

/** What a set's committed cards say. Ids are kept as strings for set math. */
export type SetHistory = {
  /** Normalised printed name → the distinct players linked under it. */
  playersByName: Map<string, Set<string>>;
  /** Every team id printed on a committed card of the set. */
  teamIds: Set<string>;
  /**
   * False when a cap was reached. An incomplete history is never used: see
   * the module note. `playersByName` and `teamIds` are then empty.
   */
  complete: boolean;
  stats: { nodes: number; calls: number };
};

const emptyHistory = (
  complete: boolean,
  stats: SetHistory["stats"],
): SetHistory => ({
  playersByName: new Map(),
  teamIds: new Set(),
  complete,
  stats,
});

/**
 * Scan a set's committed cards. `excludeSelf` leaves `selectorOptionId` (the
 * variant being fetched) out; pass false to scan a whole other set by its
 * `setName` id (rule E1's prior-year product).
 */
export async function scanSetHistory(
  ctx: ActionCtx,
  args: { selectorOptionId: Id<"selectorOptions">; excludeSelf: boolean },
): Promise<SetHistory> {
  const { nodeIds, truncated } = await ctx.runQuery(
    internal.setHistory.historyNodes,
    args,
  );
  const stats = { nodes: nodeIds.length, calls: 0 };
  if (truncated) return emptyHistory(false, stats);

  const playersByName = new Map<string, Set<string>>();
  const teamIds = new Set<string>();
  /** Every player linked on a committed card, printed name or legacy. */
  const linked = new Set<Id<"players">>();
  const add = (nameNormalized: string, playerId: string) => {
    const held = playersByName.get(nameNormalized);
    if (held) held.add(playerId);
    else playersByName.set(nameNormalized, new Set([playerId]));
  };

  let index = 0;
  let cursor: string | null = null;
  while (index < nodeIds.length) {
    if (stats.calls >= SET_HISTORY_MAX_CALLS) return emptyHistory(false, stats);
    stats.calls++;
    const batch: {
      links: Array<{ nameNormalized: string; playerId: Id<"players"> }>;
      legacyPlayerIds: Array<Id<"players">>;
      teamIds: Array<Id<"teams">>;
      nodesDone: number;
      cursor: string | null;
    } = await ctx.runQuery(internal.setHistory.historyCardBatch, {
      nodeIds: nodeIds.slice(index, index + SET_HISTORY_NODES_PER_CALL),
      cursor,
    });
    for (const link of batch.links) {
      add(link.nameNormalized, link.playerId as string);
      linked.add(link.playerId);
    }
    for (const id of batch.legacyPlayerIds) linked.add(id);
    for (const id of batch.teamIds) teamIds.add(id as string);
    index += batch.nodesDone;
    cursor = batch.cursor;
  }

  /*
   * NEO-424 — every linked player's primary name and aliases (see the module
   * note), which is also how a legacy card without `playerLinks` is keyed at
   * all. One point read per DISTINCT linked player, `SET_HISTORY_IDS_PER_CALL`
   * per call: a set links a few hundred players, so this is a handful of
   * calls, and the player rows carry the aliases inline (no extra index
   * read). A player deleted since his card was committed adds no keys; his
   * printed name still does, and the gate's home-sport pass sends such a
   * link to review.
   */
  const linkedIds = Array.from(linked);
  for (let start = 0; start < linkedIds.length; start += SET_HISTORY_IDS_PER_CALL) {
    for (const row of await ctx.runQuery(internal.setHistory.historyPlayersByIds, {
      playerIds: linkedIds.slice(start, start + SET_HISTORY_IDS_PER_CALL),
    })) {
      add(row.nameNormalized, row.playerId as string);
      for (const alias of row.aliasesNormalized) add(alias, row.playerId as string);
    }
  }

  return { playersByName, teamIds, complete: true, stats };
}

/**
 * Team name key → the distinct history teams answering to it, plus each
 * team's sport and full name, for rule F. Only called when some printed team
 * name did not resolve, so an ordinary fetch never pays for it.
 */
export async function setHistoryTeamKeys(
  ctx: ActionCtx,
  teamIds: ReadonlySet<string>,
): Promise<{
  teamsByKey: Map<string, Set<string>>;
  teamById: Map<string, { sportId: Id<"selectorOptions">; fullName: string }>;
}> {
  const ids = Array.from(teamIds) as Array<Id<"teams">>;
  const teamsByKey = new Map<string, Set<string>>();
  const teamById = new Map<string, { sportId: Id<"selectorOptions">; fullName: string }>();
  for (let start = 0; start < ids.length; start += SET_HISTORY_IDS_PER_CALL) {
    for (const row of await ctx.runQuery(internal.setHistory.historyTeamsByIds, {
      teamIds: ids.slice(start, start + SET_HISTORY_IDS_PER_CALL),
    })) {
      const id = row.teamId as string;
      teamById.set(id, { sportId: row.sportId, fullName: row.fullName });
      for (const key of row.keys) {
        const held = teamsByKey.get(key);
        if (held) held.add(id);
        else teamsByKey.set(key, new Set([id]));
      }
    }
  }
  return { teamsByKey, teamById };
}

// ─── The rule, as a pure function ───────────────────────────────────────────

/** Today's in-sport answer for a name (`players.resolveNameForReview`). */
export type InSportAnswer = {
  playerId?: Id<"players">;
  matchCount: number;
  candidatePlayerIds?: Array<Id<"players">>;
};

/**
 * What set history says to do with one player name.
 *
 *  - `none`: the set has never linked this name. Today's path, unchanged.
 *  - `agrees`: the set linked it to exactly one player and today's in-sport
 *    lookup resolved to that same player. Today's path, silently (D3): the
 *    lookup already gets it right, and a row would only add a step.
 *  - `autoLink`: the set linked it to exactly one player and today's lookup
 *    did NOT resolve to him (no match, several, or a different single
 *    player). History wins, as a visible decided row. `candidatePlayerIds`
 *    is the history player first, then the in-sport rivals, for Change.
 *  - `pick`: the set linked it to two or more players. A pick step between
 *    exactly those; the in-sport lookup does not add to them (rule A).
 */
export type SetHistoryVerdict =
  | { kind: "none" }
  | { kind: "agrees" }
  | {
      kind: "autoLink";
      playerId: Id<"players">;
      candidatePlayerIds: Array<Id<"players">>;
    }
  | { kind: "pick"; playerIds: Array<Id<"players">> };

export function setHistoryVerdict(
  answer: InSportAnswer,
  historyIds: ReadonlySet<string> | undefined,
): SetHistoryVerdict {
  if (!historyIds || historyIds.size === 0) return { kind: "none" };
  const ids = Array.from(historyIds) as Array<Id<"players">>;
  if (ids.length >= 2) return { kind: "pick", playerIds: ids };
  const [linked] = ids;
  if (answer.playerId === linked) return { kind: "agrees" };
  const inSport =
    answer.candidatePlayerIds ?? (answer.playerId ? [answer.playerId] : []);
  return {
    kind: "autoLink",
    playerId: linked,
    candidatePlayerIds: [linked, ...inSport.filter((id) => id !== linked)],
  };
}

/** Exactly one id, or undefined. The rule-A / rule-F / rule-E1 guard. */
export function onlyId(ids: ReadonlySet<string> | undefined): string | undefined {
  if (!ids || ids.size !== 1) return undefined;
  return ids.values().next().value;
}
