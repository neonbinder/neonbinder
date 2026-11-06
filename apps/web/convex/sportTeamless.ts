/**
 * NEO-426 — the operator's "No teams in this sport" switch, and the server's
 * one read of it.
 *
 * The flag lives on the sport row (`selectorOptions.hasNoTeams`, level
 * "sport" only). It is a DEFAULT, never a block: a card whose every player's
 * home sport carries it saves as "No team" when nothing names a team, and
 * nothing here or downstream refuses, strips or hides a team because of it.
 * See `convex/lib/teamlessSport.ts` for the predicate.
 */

import { ConvexError, v } from "convex/values";
import {
  internalQuery,
  mutation,
  query,
  type QueryCtx,
} from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { requireAdmin } from "./auth";
import { isTeamlessSport } from "./lib/teamlessSport";

/**
 * Every flagged sport's id, read once per call. Sports are a handful of rows
 * (`by_level` "sport"), so this stays tiny however large the catalogue grows.
 */
export async function teamlessSportIdSet(
  ctx: Pick<QueryCtx, "db">,
): Promise<Set<Id<"selectorOptions">>> {
  const sports = await ctx.db
    .query("selectorOptions")
    .withIndex("by_level", (q) => q.eq("level", "sport"))
    .collect();
  return new Set(sports.filter(isTeamlessSport).map((row) => row._id));
}

/**
 * Turn the flag on or off for one sport. `true` stores it; `false` removes
 * the field (a stored `false` would only be a second way to say "has
 * teams"). Refused on any row that is not a sport.
 *
 * Touches no card: the flag only changes what a LATER checklist save
 * defaults to. Cards already saved keep whatever team (or "No team") they
 * carry.
 */
export const setHasNoTeams = mutation({
  args: {
    sportId: v.id("selectorOptions"),
    hasNoTeams: v.boolean(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const row = await ctx.db.get(args.sportId);
    if (!row) {
      throw new ConvexError("That sport is gone. Refresh and try again.");
    }
    if (row.level !== "sport") {
      throw new ConvexError("Only a sport can be marked as having no teams.");
    }
    if (isTeamlessSport(row) === args.hasNoTeams) return null;
    await ctx.db.patch(args.sportId, {
      hasNoTeams: args.hasNoTeams ? true : undefined,
      lastUpdated: Date.now(),
    });
    return null;
  },
});

/**
 * The most player ids `playersWithTeamlessHomeSport` reads in one call. One
 * point read per id, so this sits well inside a query's comfortable budget
 * (see `SKIPPED_NAME_LOOKUP_PAGE` in selectorOptions.ts for the calibration);
 * the caller, an action, walks a longer list in slices of this size.
 */
export const TEAMLESS_PLAYER_LOOKUP_PAGE = 300;

/**
 * The flagged sport ids, for an ACTION that must read them once and then
 * test many players against them.
 */
export const teamlessSportIdList = internalQuery({
  args: {},
  returns: v.array(v.id("selectorOptions")),
  handler: async (ctx) => [...(await teamlessSportIdSet(ctx))],
});

/**
 * Which of these players' HOME sport (`players.sportId`) is one of the given
 * flagged sports. Extra sports (`playerSports`) never count (Jason,
 * NEO-426). A missing player is not teamless.
 *
 * Takes the flagged ids rather than reading them, so one fetch tests every
 * slice against the same answer.
 */
export const playersWithTeamlessHomeSport = internalQuery({
  args: {
    candidatePlayerIds: v.array(v.id("players")),
    teamlessSportIds: v.array(v.id("selectorOptions")),
  },
  returns: v.array(v.id("players")),
  handler: async (ctx, args) => {
    if (args.candidatePlayerIds.length > TEAMLESS_PLAYER_LOOKUP_PAGE) {
      throw new Error(
        `playersWithTeamlessHomeSport: ${args.candidatePlayerIds.length} ids exceeds the ` +
          `${TEAMLESS_PLAYER_LOOKUP_PAGE} per call — slice them`,
      );
    }
    const flagged = new Set<string>(args.teamlessSportIds);
    if (flagged.size === 0) return [];
    const out: Array<Id<"players">> = [];
    for (const playerId of new Set(args.candidatePlayerIds)) {
      const player = await ctx.db.get(playerId);
      if (player && flagged.has(player.sportId)) out.push(playerId);
    }
    return out;
  },
});

/**
 * The ids of every sport flagged "no teams", for the checklist wizard's
 * Teams step. Admin-only, like every set-builder read.
 */
export const listTeamlessSportIds = query({
  args: {},
  returns: v.array(v.id("selectorOptions")),
  handler: async (ctx) => {
    await requireAdmin(ctx);
    return [...(await teamlessSportIdSet(ctx))];
  },
});
