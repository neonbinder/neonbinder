/**
 * NEO-279 — "Fill teams": the set-level preview + apply that gives a set's
 * teamless cards the team the set (or the player's career) already shows.
 *
 * The RULES live in `./lib/teamFill.ts`, pure; this module is the plumbing
 * around them: read the subtree, read the players and teams the rules need,
 * hand the operator the counts, and — only when they say so — write.
 *
 * ## Why an action, computing the plan twice
 *
 * A set can hold thousands of cards, more than one query wants to read in a
 * single execution alongside every player and team it names. So `preview`
 * and `apply` are actions that page the subtree through `readTeamFillCards`
 * (the same `_creationTime` cursor `cascadeSelectorOptionTeams` uses, for the
 * same reason — one `.paginate()` per execution, several nodes per page),
 * then call the planner in memory.
 *
 * `applyTeamFill` RECOMPUTES the plan server-side rather than accepting the
 * preview's fills from the client. A client-supplied `(cardId, teamIds)` list
 * would let any admin session write any team onto any card under the guise of
 * a fill; recomputing means the writes are exactly what the rules derive from
 * the rows as they stand. The apply chunk then re-checks EACH card with a
 * fresh read before patching, so a card teamed between preview and apply (an
 * operator in another tab, a NEO-277 cascade landing) is skipped, never
 * overwritten. Both writers only ever fill an EMPTY `teamOnCardIds`, which is
 * why no lock is needed between them: whichever reaches a card first wins and
 * the other finds it no longer a candidate.
 *
 * The page walk is several transactions, not one snapshot: a card can be
 * teamed, or a row added, between pages. That is safe for the same reason —
 * every write is additive, empty-only and re-checked — but it means the
 * recomputed plan can also GROW past what the operator confirmed (a checklist
 * re-sync added teamless cards, an operator teamed an evidence card and made
 * a previously ambiguous player fillable). `applyTeamFill` therefore takes
 * the preview's `fillable` as `expectedFillable` and refuses, writing
 * nothing, when the recomputed plan would fill MORE cards than that: the
 * operator said yes to a number, and a bigger number is a different question.
 * Fewer is fine — those cards were teamed meanwhile, and the toast reports
 * the actual counts.
 *
 * ## What a fill writes, and does not
 *
 * `teamOnCardIds` and `lastUpdated`, and it clears the `bscTeamName` hint the
 * way `applyBscTeamResolution` does when a real team lands. It leaves
 * `teamCheckDoneAt` (the BSC lookup still ran) and `teamNoneConfirmedAt`
 * (never set on a candidate) alone, and it never touches `players.teamYears`.
 */

import {
  action,
  internalMutation,
  internalQuery,
  type ActionCtx,
} from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { requireAdmin } from "./auth";
import {
  collectDescendantIds,
  findSetYearForSelectorOption,
  parseYear,
} from "./lib/selectorAncestry";
import { findSportForSelectorOption } from "./cardChecklist";
import { MAX_CARD_TEAMS } from "./features/cardAttention";
import { teamFullName } from "../lib/teams/team-name";
import {
  isTeamFillCandidate,
  planTeamFill,
  splitKey,
  type TeamFillCard,
  type TeamFillPlan,
  type TeamFillRule,
  type TeamFillScope,
} from "./lib/teamFill";

/** Refusal when the recomputed plan would fill more cards than the operator confirmed. */
export const TEAM_FILL_DRIFT_MESSAGE = "The set changed since the preview — check again.";

/**
 * Cards examined per `readTeamFillCards` call. A projected card is a few
 * hundred bytes, so a thousand is well inside a query's result size, and the
 * node reads on top of it are one per node visited. Exported so a test can
 * drive the multi-page path with a small number instead of a big fixture.
 */
export const TEAM_FILL_CARD_PAGE = 1000;

/** `readTeamFillPlayers` / `readTeamFillTeams` refuse more than this per call. */
export const TEAM_FILL_ID_CHUNK = 500;

/** How many cards one `applyTeamFillChunk` writes: one read + one patch each. */
export const TEAM_FILL_APPLY_CHUNK = 100;

const ruleValidator = v.union(
  v.literal("samePlayerInSet"),
  v.literal("oneTeamCareer"),
  v.literal("oneStintInYear"),
);

const scopeValidator = v.union(
  v.literal("sameNode"),
  v.literal("acrossSet"),
  v.literal("career"),
);

const byRuleValidator = v.object({
  samePlayerInSet: v.number(),
  oneTeamCareer: v.number(),
  oneStintInYear: v.number(),
});

const projectedCardValidator = v.object({
  _id: v.id("cardChecklist"),
  selectorOptionId: v.id("selectorOptions"),
  playerIds: v.array(v.id("players")),
  teamOnCardIds: v.array(v.id("teams")),
  hasPendingTeamNames: v.boolean(),
  teamNoneConfirmedAt: v.optional(v.number()),
  teamCheckDoneAt: v.optional(v.number()),
  hasBscRef: v.boolean(),
});

type ProjectedCard = {
  _id: Id<"cardChecklist">;
  selectorOptionId: Id<"selectorOptions">;
  playerIds: Array<Id<"players">>;
  teamOnCardIds: Array<Id<"teams">>;
  hasPendingTeamNames: boolean;
  teamNoneConfirmedAt?: number;
  teamCheckDoneAt?: number;
  hasBscRef: boolean;
};

type SubtreeResult = {
  nodeIds: Array<Id<"selectorOptions">>;
  setYear: number | null;
  sportId: Id<"selectorOptions"> | null;
};

type CardsPage = {
  cards: Array<ProjectedCard>;
  /** node id → its own `features.season` year, for every node this page visited. */
  yearByNodeId: Array<{ nodeId: Id<"selectorOptions">; year: number | null }>;
  /** node id → its display `value`, for the same nodes — what a preview group names. */
  nameByNodeId: Array<{ nodeId: Id<"selectorOptions">; name: string }>;
  nodeIndex: number;
  cursor: number | null;
  done: boolean;
};

type PlayerRow = {
  _id: Id<"players">;
  name: string;
  teamYears?: Array<{ teamId: Id<"teams">; fromYear: number; toYear?: number }>;
};
type TeamRow = { _id: Id<"teams">; name: string; sportId: Id<"selectorOptions"> };

/**
 * The set's subtree: the `setName` row and everything beneath it, plus the two
 * set-level facts the rules compare against.
 *
 * Refuses any other level. A variantType or parallel row is a slice of a set,
 * and rule A's evidence is "the same player elsewhere in THIS SET" — asked
 * from a parallel it would see only that parallel's cards and miss the base
 * card carrying the answer. Asked from above the set (a year, a brand) it
 * would treat one set's teams as evidence for another's, which they are not.
 */
export const listTeamFillSubtree = internalQuery({
  args: { selectorOptionId: v.id("selectorOptions") },
  returns: v.object({
    nodeIds: v.array(v.id("selectorOptions")),
    setYear: v.union(v.number(), v.null()),
    sportId: v.union(v.id("selectorOptions"), v.null()),
  }),
  handler: async (ctx, args): Promise<SubtreeResult> => {
    const root = await ctx.db.get(args.selectorOptionId);
    if (!root) throw new ConvexError("That set no longer exists.");
    if (root.level !== "setName") {
      throw new ConvexError("Fill teams from the set row, not a variant or parallel.");
    }
    const descendantIds = await collectDescendantIds(ctx, root._id);
    const setYear = await findSetYearForSelectorOption(ctx, root._id);
    const sportId = await findSportForSelectorOption(ctx, root._id);
    return {
      nodeIds: [root._id, ...descendantIds],
      setYear: setYear ?? null,
      sportId: sportId ?? null,
    };
  },
});

/**
 * One page of the subtree's cards, projected to the fields the planner reads.
 *
 * Pages node by node through `by_selector_option` with a `_creationTime`
 * cursor rather than `.paginate()`: Convex allows ONE paginated query per
 * execution and a page here spans several small nodes. `_creationTime` is the
 * index's implicit last column and unique within a table, so "strictly after
 * it" is an exact resume point — the same walk `cascadeSelectorOptionTeams`
 * does, for the same reason. Each node the page visits is read once, for its
 * own `features.season` (rule C's year for the cards under it) and its
 * `value` (the name a preview group shows for it).
 *
 * `budget` is an argument (not a constant read here) so a test can force the
 * multi-page path without seeding a thousand rows. A non-finite or sub-one
 * budget is clamped to one card so the walk always advances.
 */
export const readTeamFillCards = internalQuery({
  args: {
    nodeIds: v.array(v.id("selectorOptions")),
    nodeIndex: v.number(),
    cursor: v.optional(v.number()),
    budget: v.number(),
  },
  returns: v.object({
    cards: v.array(projectedCardValidator),
    yearByNodeId: v.array(
      v.object({ nodeId: v.id("selectorOptions"), year: v.union(v.number(), v.null()) }),
    ),
    nameByNodeId: v.array(v.object({ nodeId: v.id("selectorOptions"), name: v.string() })),
    nodeIndex: v.number(),
    cursor: v.union(v.number(), v.null()),
    done: v.boolean(),
  }),
  handler: async (ctx, args): Promise<CardsPage> => {
    const cards: Array<ProjectedCard> = [];
    const yearByNodeId: CardsPage["yearByNodeId"] = [];
    const nameByNodeId: CardsPage["nameByNodeId"] = [];
    let nodeIndex = args.nodeIndex;
    let cursor: number | undefined = args.cursor;
    let budget = Number.isFinite(args.budget) ? Math.max(1, Math.floor(args.budget)) : 1;

    while (nodeIndex < args.nodeIds.length && budget > 0) {
      const nodeId = args.nodeIds[nodeIndex];
      if (cursor === undefined) {
        // First visit to this node in the whole walk: record its season and
        // name once.
        const node = await ctx.db.get(nodeId);
        yearByNodeId.push({ nodeId, year: parseYear(node?.features?.season) ?? null });
        nameByNodeId.push({ nodeId, name: node?.value ?? "" });
      }
      const after = cursor;
      const requested = budget;
      const rows = await ctx.db
        .query("cardChecklist")
        .withIndex("by_selector_option", (q) =>
          after === undefined
            ? q.eq("selectorOptionId", nodeId)
            : q.eq("selectorOptionId", nodeId).gt("_creationTime", after),
        )
        .take(requested);
      for (const card of rows) {
        budget -= 1;
        cards.push(projectCard(card));
      }
      if (rows.length < requested) {
        nodeIndex += 1;
        cursor = undefined;
      } else {
        cursor = rows[rows.length - 1]._creationTime;
      }
    }

    return {
      cards,
      yearByNodeId,
      nameByNodeId,
      nodeIndex,
      cursor: cursor ?? null,
      done: nodeIndex >= args.nodeIds.length,
    };
  },
});

function projectCard(card: Doc<"cardChecklist">): ProjectedCard {
  return {
    _id: card._id,
    selectorOptionId: card.selectorOptionId,
    playerIds: card.playerIds ?? [],
    teamOnCardIds: card.teamOnCardIds ?? [],
    hasPendingTeamNames: (card.pendingTeamNames?.length ?? 0) > 0,
    ...(card.teamNoneConfirmedAt !== undefined
      ? { teamNoneConfirmedAt: card.teamNoneConfirmedAt }
      : {}),
    ...(card.teamCheckDoneAt !== undefined ? { teamCheckDoneAt: card.teamCheckDoneAt } : {}),
    hasBscRef: !!card.platformData?.bsc?.ref,
  };
}

/**
 * The players the candidates name: id, display name (for the preview's
 * groups) and career stints (for rules B and C). A dangling id is omitted, and
 * the planner reads a missing player as "cannot answer" for that card.
 */
export const readTeamFillPlayers = internalQuery({
  args: { playerIds: v.array(v.id("players")) },
  returns: v.array(
    v.object({
      _id: v.id("players"),
      name: v.string(),
      teamYears: v.optional(
        v.array(
          v.object({
            teamId: v.id("teams"),
            fromYear: v.number(),
            toYear: v.optional(v.number()),
          }),
        ),
      ),
    }),
  ),
  handler: async (ctx, args): Promise<Array<PlayerRow>> => {
    if (args.playerIds.length > TEAM_FILL_ID_CHUNK) {
      throw new Error(`Read players in chunks of ${TEAM_FILL_ID_CHUNK} or fewer.`);
    }
    const out: Array<PlayerRow> = [];
    for (const id of new Set(args.playerIds)) {
      const player = await ctx.db.get(id);
      if (!player) continue;
      out.push({
        _id: player._id,
        name: player.name,
        ...(player.teamYears !== undefined ? { teamYears: player.teamYears } : {}),
      });
    }
    return out;
  },
});

/**
 * The teams a plan would write: full display name (a chip reading "Padres"
 * does not say which Padres) and `sportId`, so a fill whose team belongs to
 * another sport can be dropped before it is ever shown. A dangling id is
 * omitted, and the planner drops fills naming it.
 */
export const readTeamFillTeams = internalQuery({
  args: { teamIds: v.array(v.id("teams")) },
  returns: v.array(
    v.object({
      _id: v.id("teams"),
      name: v.string(),
      sportId: v.id("selectorOptions"),
    }),
  ),
  handler: async (ctx, args): Promise<Array<TeamRow>> => {
    if (args.teamIds.length > TEAM_FILL_ID_CHUNK) {
      throw new Error(`Read teams in chunks of ${TEAM_FILL_ID_CHUNK} or fewer.`);
    }
    const out: Array<TeamRow> = [];
    for (const id of new Set(args.teamIds)) {
      const team = await ctx.db.get(id);
      if (!team) continue;
      out.push({ _id: team._id, name: teamFullName(team), sportId: team.sportId });
    }
    return out;
  },
});

type ComputedPlan = {
  plan: TeamFillPlan;
  setYear: number | null;
  sportId: Id<"selectorOptions"> | null;
  playersById: Map<string, PlayerRow>;
  teamsById: Map<string, TeamRow>;
  nameByNodeId: Map<string, string>;
};

function chunk<T>(items: ReadonlyArray<T>, size: number): Array<Array<T>> {
  const out: Array<Array<T>> = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * The whole read side, shared by preview and apply so the two can never
 * disagree about what a fill is: subtree → every card → the players the
 * candidates name → the plan → the teams it would write → the plan again,
 * filtered to teams that exist and belong to the set's sport.
 *
 * The second planner pass is deliberate (see `planTeamFill`): the team rows
 * are only known once a first pass has said which ids matter, and filtering
 * inside the planner keeps every count it reports consistent with the fills
 * that survive.
 */
async function computeTeamFillPlan(
  ctx: ActionCtx,
  selectorOptionId: Id<"selectorOptions">,
): Promise<ComputedPlan> {
  // Every `runQuery` result below is annotated: an action calling functions
  // from its own module is the one place TypeScript can chase the module's
  // type back into itself, and the annotation is what breaks that cycle.
  const subtree: SubtreeResult = await ctx.runQuery(internal.teamFill.listTeamFillSubtree, {
    selectorOptionId,
  });

  const cards: Array<TeamFillCard> = [];
  const seasonByNodeId = new Map<string, number | null>();
  const nameByNodeId = new Map<string, string>();
  let nodeIndex = 0;
  let cursor: number | undefined;
  for (;;) {
    const page: CardsPage = await ctx.runQuery(internal.teamFill.readTeamFillCards, {
      nodeIds: subtree.nodeIds,
      nodeIndex,
      ...(cursor !== undefined ? { cursor } : {}),
      budget: TEAM_FILL_CARD_PAGE,
    });
    for (const card of page.cards) cards.push(card);
    for (const entry of page.yearByNodeId) seasonByNodeId.set(entry.nodeId, entry.year);
    for (const entry of page.nameByNodeId) nameByNodeId.set(entry.nodeId, entry.name);
    if (page.done) break;
    nodeIndex = page.nodeIndex;
    cursor = page.cursor ?? undefined;
  }

  // Rule C's year per node: the node's own season, else the set's year.
  const yearByNodeId = new Map<string, number | undefined>();
  for (const nodeId of subtree.nodeIds) {
    const season = seasonByNodeId.get(nodeId);
    yearByNodeId.set(nodeId, season ?? subtree.setYear ?? undefined);
  }

  const candidatePlayerIds = new Set<Id<"players">>();
  for (const card of cards) {
    if (!isTeamFillCandidate(card)) continue;
    for (const id of card.playerIds ?? []) candidatePlayerIds.add(id);
  }
  const playersById = new Map<string, PlayerRow>();
  for (const ids of chunk([...candidatePlayerIds], 200)) {
    const rows: Array<PlayerRow> = await ctx.runQuery(internal.teamFill.readTeamFillPlayers, {
      playerIds: ids,
    });
    for (const row of rows) playersById.set(row._id, row);
  }

  const currentYear = new Date().getFullYear();
  const firstPass = planTeamFill({ cards, playersById, yearByNodeId, currentYear });

  const teamIds = new Set<Id<"teams">>();
  for (const fill of firstPass.fills) for (const id of fill.teamIds) teamIds.add(id);
  const teamsById = new Map<string, TeamRow>();
  for (const ids of chunk([...teamIds], 200)) {
    const rows: Array<TeamRow> = await ctx.runQuery(internal.teamFill.readTeamFillTeams, {
      teamIds: ids,
    });
    for (const row of rows) teamsById.set(row._id, row);
  }
  const teamIdsThatExist = new Set<string>();
  for (const team of teamsById.values()) {
    if (subtree.sportId !== null && team.sportId !== subtree.sportId) continue;
    teamIdsThatExist.add(team._id);
  }

  const plan = planTeamFill({ cards, playersById, teamIdsThatExist, yearByNodeId, currentYear });
  return {
    plan,
    setYear: subtree.setYear,
    sportId: subtree.sportId,
    playersById,
    teamsById,
    nameByNodeId,
  };
}

const previewGroupValidator = v.object({
  playerNames: v.array(v.string()),
  teamNames: v.array(v.string()),
  rule: ruleValidator,
  scope: scopeValidator,
  /** Display names of the nodes the group writes to — at most `TEAM_FILL_GROUP_NODE_CAP`. */
  nodeNames: v.array(v.string()),
  /** How many distinct nodes the group writes to in total. */
  nodeCount: v.number(),
  cardCount: v.number(),
});

type PreviewResult = {
  candidates: number;
  fillable: number;
  byRule: Record<TeamFillRule, number>;
  remaining: number;
  setYear: number | null;
  groups: Array<{
    playerNames: Array<string>;
    teamNames: Array<string>;
    rule: TeamFillRule;
    scope: TeamFillScope;
    nodeNames: Array<string>;
    nodeCount: number;
    cardCount: number;
  }>;
  groupsTotal: number;
};

/**
 * What "Fill teams" would do to this set, as counts and named groups, so the
 * operator confirms a specific promise ("42 cards, Tony Gwynn → San Diego
 * Padres ×12, …") rather than a button. Groups arrive riskiest first (see
 * `planTeamFill`), and a group that borrows a team from another node names
 * the nodes it would write to. Writes nothing.
 */
export const previewTeamFill = action({
  args: { selectorOptionId: v.id("selectorOptions") },
  returns: v.object({
    candidates: v.number(),
    fillable: v.number(),
    byRule: byRuleValidator,
    remaining: v.number(),
    setYear: v.union(v.number(), v.null()),
    groups: v.array(previewGroupValidator),
    groupsTotal: v.number(),
  }),
  handler: async (ctx, args): Promise<PreviewResult> => {
    await requireAdmin(ctx);
    const { plan, setYear, playersById, teamsById, nameByNodeId } =
      await computeTeamFillPlan(ctx, args.selectorOptionId);
    return {
      candidates: plan.candidates,
      fillable: plan.fills.length,
      byRule: plan.byRule,
      remaining: plan.remaining,
      setYear,
      groups: plan.groups.map((group) => ({
        // A name the read did not return is a dangling link; the planner
        // already refused to fill from one, so this only ever drops a name
        // from a group's label, never a group.
        playerNames: splitKey<Id<"players">>(group.playerKey)
          .map((id) => playersById.get(id)?.name)
          .filter((name): name is string => name !== undefined),
        teamNames: splitKey<Id<"teams">>(group.teamKey)
          .map((id) => teamsById.get(id)?.name)
          .filter((name): name is string => name !== undefined),
        rule: group.rule,
        scope: group.scope,
        // A node the walk did not name is one that vanished mid-walk; its
        // cards will be re-checked at apply, so only the label loses a name.
        nodeNames: group.nodeIds
          .map((id) => nameByNodeId.get(id))
          .filter((name): name is string => name !== undefined && name !== ""),
        nodeCount: group.nodeCount,
        cardCount: group.cardCount,
      })),
      groupsTotal: plan.groupsTotal,
    };
  },
});

/**
 * Writes up to `TEAM_FILL_APPLY_CHUNK` fills, each against a FRESH read of
 * the card. A card that is no longer a candidate — teamed by an operator or a
 * cascade since the plan was computed, confirmed teamless, given a pending
 * name — is skipped, never overwritten. So is a fill whose team has gone
 * missing or belongs to another sport, or that would exceed the per-card cap.
 *
 * Direct `ctx.db.patch`, never `updateCard`: that mutation clears
 * `teamNoneConfirmedAt` on a non-empty write, and a confirmed card must not
 * be reached at all. `teamCheckDoneAt` is left as-is for the reason it is
 * everywhere else — it records that the BSC lookup ran, which is still true.
 */
export const applyTeamFillChunk = internalMutation({
  args: {
    fills: v.array(
      v.object({
        cardId: v.id("cardChecklist"),
        teamIds: v.array(v.id("teams")),
      }),
    ),
    sportId: v.optional(v.union(v.id("selectorOptions"), v.null())),
  },
  returns: v.object({ applied: v.number(), skipped: v.number() }),
  handler: async (ctx, args) => {
    if (args.fills.length > TEAM_FILL_APPLY_CHUNK) {
      throw new Error(`Apply fills in chunks of ${TEAM_FILL_APPLY_CHUNK} or fewer.`);
    }
    const sportId = args.sportId ?? null;
    const teamOk = new Map<string, boolean>();
    let applied = 0;
    let skipped = 0;

    for (const fill of args.fills) {
      const teamIds = [...new Set<Id<"teams">>(fill.teamIds)];
      if (teamIds.length === 0 || teamIds.length > MAX_CARD_TEAMS) {
        skipped += 1;
        continue;
      }
      const card = await ctx.db.get(fill.cardId);
      if (!card || !isTeamFillCandidate(card)) {
        skipped += 1;
        continue;
      }
      let everyTeamOk = true;
      for (const teamId of teamIds) {
        let ok = teamOk.get(teamId);
        if (ok === undefined) {
          const team = await ctx.db.get(teamId);
          ok = !!team && (sportId === null || team.sportId === sportId);
          teamOk.set(teamId, ok);
        }
        if (!ok) {
          everyTeamOk = false;
          break;
        }
      }
      if (!everyTeamOk) {
        skipped += 1;
        continue;
      }
      await ctx.db.patch(card._id, {
        teamOnCardIds: teamIds,
        lastUpdated: Date.now(),
        // A real team has landed, so the "Marketplace says: …" hint has
        // nothing left to say — same treatment `applyBscTeamResolution` gives.
        bscTeamName: undefined,
      });
      applied += 1;
    }

    return { applied, skipped };
  },
});

type ApplyResult = {
  applied: number;
  skipped: number;
  byRule: Record<TeamFillRule, number>;
};

/**
 * Recompute the plan from the rows as they stand now and write it in chunks.
 * `byRule` is the PLAN's attribution (what the rules decided), `applied` and
 * `skipped` are what the chunks found when they re-read each card; the two
 * differ exactly by the cards something else teamed in between.
 *
 * `expectedFillable` is the preview's `fillable`, the number the operator
 * said yes to. A recomputed plan that would fill MORE than that is refused
 * with `TEAM_FILL_DRIFT_MESSAGE` before any chunk runs (see the header); the
 * client shows it in the dialog and the operator re-checks.
 */
export const applyTeamFill = action({
  args: {
    selectorOptionId: v.id("selectorOptions"),
    expectedFillable: v.number(),
  },
  returns: v.object({
    applied: v.number(),
    skipped: v.number(),
    byRule: byRuleValidator,
  }),
  handler: async (ctx, args): Promise<ApplyResult> => {
    await requireAdmin(ctx);
    const { plan, sportId } = await computeTeamFillPlan(ctx, args.selectorOptionId);
    if (plan.fills.length > args.expectedFillable) {
      throw new ConvexError(TEAM_FILL_DRIFT_MESSAGE);
    }
    let applied = 0;
    let skipped = 0;
    for (const fills of chunk(plan.fills, TEAM_FILL_APPLY_CHUNK)) {
      const result: { applied: number; skipped: number } = await ctx.runMutation(
        internal.teamFill.applyTeamFillChunk,
        {
          fills: fills.map((fill) => ({ cardId: fill.cardId, teamIds: fill.teamIds })),
          sportId,
        },
      );
      applied += result.applied;
      skipped += result.skipped;
    }
    return { applied, skipped, byRule: plan.byRule };
  },
});
