/**
 * NEO-254 — franchises: the thread through a team's renames and moves.
 *
 * ## What this is for
 *
 * `teams` holds one row per historical NAME — "Houston Oilers", "Tennessee
 * Oilers" and "Tennessee Titans" are three rows — because that is what a card
 * says and what a stint has to read as. A franchise is the operator's
 * statement that those three rows are one continuous thing.
 *
 * Jason, 2026-09-06: "building a collection of all Tennessee Titans and letting
 * the user determine if that should also include Houston Oilers and Tennessee
 * Oilers players." This module is the ADMIN side of that linkage only. It
 * records which team rows an operator has strung together; what a collector's
 * binder then does with the thread is a later ticket.
 *
 * ## Never inferred
 *
 * There is no rule anywhere that reads a team name and guesses its franchise.
 * From the outside, the Oilers → Titans rename and the Browns → Ravens
 * relocation look identical, and only a human knows that the first is one
 * franchise and the second is two. So every link in this table was made by an
 * operator clicking something, and a franchise with no teams on it is a
 * perfectly normal row rather than a broken one.
 *
 * ## Marketplace-free by construction
 *
 * Nothing here is derived from a marketplace and nothing here is sent to one.
 * A franchise carries a name, a sport and nothing else; every fact about a
 * season still lives on the team row that played it. See the product invariant
 * in the workspace CLAUDE.md.
 */

import { query, mutation } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { getCurrentUserId, requireAdmin } from "./auth";
// The SAME normaliser `teams.normalizeTeamName` is — token-sorted, punctuation
// stripped. Imported from `entityNearMatch` rather than from `./teams` for the
// reason `players.ts` gives: `teams.ts` already imports from `players.ts`, and
// a cycle between two Convex modules is not worth a shorter import path.
import { normalizeEntityName } from "./lib/entityNearMatch";
import { teamFullName } from "../lib/teams/team-name";

/**
 * Bound on an operator-typed franchise name. Same value and same reasoning as
 * `teams.MAX_TEAM_NAME_LENGTH`: this is a globally-shared string an operator
 * types once and every later screen renders. Over-length is refused rather
 * than truncated — storing something other than what was typed is how a
 * mangled name becomes canonical.
 */
export const MAX_FRANCHISE_NAME_LENGTH = 120;

/**
 * Hard ceilings on what one query returns.
 *
 * `FRANCHISE_LIST_CAP` bounds the franchise list itself; `FRANCHISE_TEAM_SCAN`
 * bounds the single by-sport team scan the list tallies its counts from. Both
 * are reported as `truncated` rather than silently applied, for the reason
 * `teams.listForManagement` gives: a list that quietly stops reads as "that is
 * all of them", which is the kind of wrong an operator cannot see.
 */
const FRANCHISE_LIST_CAP = 500;
const FRANCHISE_TEAM_SCAN = 2000;

/**
 * How many teams one franchise view renders. A franchise is a handful of
 * rows — the longest real thread in any of the five sports is well under ten —
 * so this is a guard-rail, not a paging boundary.
 */
const FRANCHISE_TEAM_CAP = 200;

/**
 * STRICT, like `leagueDocValidator`: Convex checks a returns validator against
 * the real document, so a field added to `franchises` without being added here
 * makes these queries throw for the admin page rather than for a test.
 */
const franchiseDocValidator = v.object({
  _id: v.id("franchises"),
  _creationTime: v.number(),
  name: v.string(),
  nameNormalized: v.string(),
  sportId: v.id("selectorOptions"),
  lastUpdated: v.number(),
});

/** One team as the franchise view renders it: "Tennessee Titans, 1999–". */
const franchiseTeamValidator = v.object({
  _id: v.id("teams"),
  name: v.string(),
  location: v.optional(v.string()),
  yearsActive: v.optional(
    v.object({ from: v.number(), to: v.optional(v.number()) }),
  ),
});

/**
 * The one place a franchise name becomes storable fields. Mirrors
 * `teamRowFields` — the dedup key is derived here and nowhere else, so a
 * writer cannot store a name whose key disagrees with it.
 */
function franchiseRowFields(raw: string): {
  name: string;
  nameNormalized: string;
} {
  const name = raw.trim().replace(/\s+/g, " ");
  if (name.length === 0) {
    throw new ConvexError("A franchise name is required.");
  }
  if (name.length > MAX_FRANCHISE_NAME_LENGTH) {
    // The LENGTH, never the name: this string reaches Sentry and the browser
    // console through Convex's error path.
    throw new ConvexError(
      `A franchise name is ${name.length} characters; the limit is ${MAX_FRANCHISE_NAME_LENGTH}.`,
    );
  }
  const nameNormalized = normalizeEntityName(name);
  if (nameNormalized.length === 0) {
    // Punctuation only. It would store a key nothing can ever match, so the
    // row would be invisible to every lookup including its own.
    throw new ConvexError("A franchise name needs at least one letter or digit.");
  }
  return { name, nameNormalized };
}

/** The row this sport already holds under that name, or null. Never inserts. */
async function findFranchiseByName(
  ctx: QueryCtx | MutationCtx,
  sportId: Id<"selectorOptions">,
  name: string,
): Promise<Doc<"franchises"> | null> {
  const nameNormalized = normalizeEntityName(name);
  if (nameNormalized.length === 0) return null;
  return await ctx.db
    .query("franchises")
    .withIndex("by_name_normalized_and_sport_id", (q) =>
      q.eq("nameNormalized", nameNormalized).eq("sportId", sportId),
    )
    .first();
}

/**
 * A team row hung off a `selectorOptions` id proves only that the id is in
 * that table, not that it points at a SPORT. Same check `teams.findOrCreate`
 * runs, and for the same reason: a franchise under a variantType row is an
 * orphan no per-sport query can ever surface.
 */
async function requireSportRow(
  ctx: QueryCtx | MutationCtx,
  sportId: Id<"selectorOptions">,
): Promise<void> {
  const sportRow = await ctx.db.get(sportId);
  if (!sportRow || sportRow.level !== "sport") {
    throw new ConvexError("A franchise must be created under a sport.");
  }
}

/**
 * Find-or-create a franchise for (sport, name) — the shared helper every
 * writer goes through, so the dedup key is applied identically everywhere.
 *
 * Not a Convex function, for the same reason `findOrCreateLeague` is not: its
 * callers are already inside mutations, and a mutation cannot call another
 * mutation. `convex/bulkLoad.ts` (`upsertFranchises`) is the second caller.
 *
 * Reports whether it inserted, because both callers need to tell "we made this
 * one" from "it was already there" — the bulk loader returns it as `created`,
 * and the admin path uses it to say so in the status line.
 */
export async function findOrCreateFranchise(
  ctx: MutationCtx,
  args: { name: string; sportId: Id<"selectorOptions"> },
): Promise<{ id: Id<"franchises">; created: boolean }> {
  const fields = franchiseRowFields(args.name);
  const existing = await findFranchiseByName(ctx, args.sportId, fields.name);
  // Found rows are returned UNTOUCHED — not re-cased, not re-punctuated. The
  // stored spelling is the one an operator chose; a later caller passing
  // "titans / oilers" must not silently rewrite it.
  if (existing) return { id: existing._id, created: false };

  const id = await ctx.db.insert("franchises", {
    ...fields,
    sportId: args.sportId,
    lastUpdated: Date.now(),
  });
  return { id, created: true };
}

/**
 * Order a franchise's teams the way its history reads: earliest first, and the
 * rows nobody has dated last.
 *
 * Undated LAST rather than first is the same call `leagues.listForManagement`
 * makes about an unset level — an undated row is the one with work outstanding,
 * and floating it to the top would bury the dated majority that answers the
 * question the operator opened the page with.
 */
export function orderFranchiseTeams<
  T extends { name: string; location?: string; yearsActive?: { from: number } },
>(teams: readonly T[]): T[] {
  return [...teams].sort((a, b) => {
    const aFrom = a.yearsActive?.from;
    const bFrom = b.yearsActive?.from;
    if (aFrom !== undefined && bFrom !== undefined && aFrom !== bFrom) {
      return aFrom - bFrom;
    }
    if (aFrom === undefined && bFrom !== undefined) return 1;
    if (aFrom !== undefined && bFrom === undefined) return -1;
    return teamFullName(a).localeCompare(teamFullName(b));
  });
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * Every franchise in a sport (or in all of them), with how many team rows sit
 * on each.
 *
 * Signed-in rather than admin, matching `teams.listForPicker` and
 * `leagues.list`: a franchise is a name and a sport, reference data with no
 * user content on it, so the only thing worth gating is cost. Returns empty
 * rather than throwing so a signed-out render is a quiet no-op.
 *
 * ## The counts are OPT-IN, and that is not a micro-optimisation
 *
 * `withTeamCounts` costs a scan of every team in scope — up to
 * `FRANCHISE_TEAM_SCAN` rows — because a count per franchise is otherwise a
 * `by_franchise_id` query per franchise, which is five hundred reads to render
 * a sidebar. One tallied scan beats that, but it is still a scan, and the
 * NEO-254 preload is about to make `teams` large.
 *
 * Team Management reads this list only to fill a dropdown with NAMES, and it
 * is a screen an operator sits on while every keystroke re-renders. Making it
 * pay for counts it never shows would put a two-thousand-row read behind that.
 * So the counts are asked for by the one screen that renders them.
 */
export const list = query({
  args: {
    sportId: v.optional(v.id("selectorOptions")),
    withTeamCounts: v.optional(v.boolean()),
  },
  returns: v.object({
    franchises: v.array(
      v.object({
        _id: v.id("franchises"),
        _creationTime: v.number(),
        name: v.string(),
        nameNormalized: v.string(),
        sportId: v.id("selectorOptions"),
        lastUpdated: v.number(),
        // 0 for every row unless `withTeamCounts` was asked for — see above.
        // A number rather than an optional so the caller's rendering does not
        // have to branch; the screen that shows it is the screen that asks.
        teamCount: v.number(),
      }),
    ),
    truncated: v.boolean(),
  }),
  handler: async (ctx, args) => {
    // Returns empty rather than throwing when signed out, exactly as
    // `leagues.list` does: a signed-out render should be a quiet no-op, not an
    // error boundary.
    if (!(await getCurrentUserId(ctx))) {
      return { franchises: [], truncated: false };
    }

    const sportId = args.sportId;
    const rows = sportId
      ? await ctx.db
          .query("franchises")
          .withIndex("by_sport_id", (q) => q.eq("sportId", sportId))
          .take(FRANCHISE_LIST_CAP + 1)
      : await ctx.db.query("franchises").take(FRANCHISE_LIST_CAP + 1);

    const truncatedList = rows.length > FRANCHISE_LIST_CAP;
    const franchiseRows = rows.slice(0, FRANCHISE_LIST_CAP);

    const teamRows = !args.withTeamCounts
      ? []
      : sportId
        ? await ctx.db
            .query("teams")
            .withIndex("by_sport_id", (q) => q.eq("sportId", sportId))
            .take(FRANCHISE_TEAM_SCAN + 1)
        : await ctx.db.query("teams").take(FRANCHISE_TEAM_SCAN + 1);

    const truncatedTeams = teamRows.length > FRANCHISE_TEAM_SCAN;
    const counts = new Map<string, number>();
    for (const team of teamRows.slice(0, FRANCHISE_TEAM_SCAN)) {
      if (!team.franchiseId) continue;
      counts.set(team.franchiseId, (counts.get(team.franchiseId) ?? 0) + 1);
    }

    return {
      franchises: franchiseRows
        .map((row) => ({ ...row, teamCount: counts.get(row._id) ?? 0 }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      // Either cap being hit means the page is showing an incomplete answer —
      // a missing franchise, or a count that is short. One flag, because the
      // operator's remedy for both is the same: narrow by sport.
      truncated: truncatedList || truncatedTeams,
    };
  },
});

/**
 * One franchise and the team rows strung onto it, in history order.
 *
 * The teams come back as the four fields the view renders and nothing else.
 * Shipping whole team documents here would make this query's contract the
 * `teams` schema, which is how `leagueDocValidator`'s strictness note came to
 * be written; the franchise view needs a name, a place and a span.
 */
export const get = query({
  // `v.string()`, not `v.id("franchises")`, for the reason `leagues.getByIdParam`
  // is: the id arrives from `?franchise=` in the URL, and a bare `v.id` throws
  // on a hand-mangled param — which unmounts the whole screen into the error
  // boundary rather than showing "no franchise". `normalizeId` turns "not an
  // id" into the same `null` "no such row" already returns.
  args: { id: v.string() },
  returns: v.union(
    v.object({
      franchise: franchiseDocValidator,
      teams: v.array(franchiseTeamValidator),
      truncated: v.boolean(),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    // Admin, matching `leagues.getByIdParam`: the only screen that opens a
    // franchise is `/admin/franchises`, and the panel it feeds is an editor.
    await requireAdmin(ctx);
    const id = ctx.db.normalizeId("franchises", args.id);
    if (id === null) return null;
    const franchise = await ctx.db.get(id);
    if (!franchise) return null;

    const rows = await ctx.db
      .query("teams")
      .withIndex("by_franchise_id", (q) => q.eq("franchiseId", id))
      .take(FRANCHISE_TEAM_CAP + 1);

    const teams = orderFranchiseTeams(rows.slice(0, FRANCHISE_TEAM_CAP)).map(
      (team) => ({
        _id: team._id,
        name: team.name,
        ...(team.location !== undefined ? { location: team.location } : {}),
        ...(team.yearsActive !== undefined
          ? { yearsActive: team.yearsActive }
          : {}),
      }),
    );

    return { franchise, teams, truncated: rows.length > FRANCHISE_TEAM_CAP };
  },
});

/**
 * Create a franchise, or hand back the one this sport already holds under that
 * name.
 *
 * `requireAdmin` for the reason `teams.findOrCreate` carries it: sign-up is
 * open, so "signed in" is not a meaningful bound on who may mint a
 * globally-shared row. Its only caller is the Franchise field on the Team
 * detail panel and the add form on `/admin/franchises`, both admin-only
 * screens.
 *
 * Find-or-create rather than create-only so the field's "type a new name"
 * affordance is safe to press twice: the second press returns the first
 * press's row instead of failing on a duplicate the operator cannot see.
 */
export const findOrCreate = mutation({
  args: {
    name: v.string(),
    sportId: v.id("selectorOptions"),
  },
  returns: v.object({ id: v.id("franchises"), created: v.boolean() }),
  handler: async (
    ctx,
    args,
  ): Promise<{ id: Id<"franchises">; created: boolean }> => {
    await requireAdmin(ctx);
    await requireSportRow(ctx, args.sportId);
    return await findOrCreateFranchise(ctx, {
      name: args.name,
      sportId: args.sportId,
    });
  },
});

/**
 * Rename a franchise.
 *
 * A rename rewrites `nameNormalized` too, or the row goes invisible to every
 * by-name lookup that resolves onto it — the same trap `teams.saveTeamFields`
 * documents. And it takes the same collision check: two franchises in one
 * sport sharing a key means `findOrCreateFranchise` resolves to whichever
 * `.first()` returns, and the teams on the other one silently stop being
 * reachable by name.
 *
 * Renaming NEVER touches the teams on the thread. That is the whole point of
 * the indirection: an operator can call the thread "Titans / Oilers" today and
 * "Tennessee Titans" tomorrow without a single team row changing.
 */
export const save = mutation({
  args: {
    id: v.id("franchises"),
    name: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const existing = await ctx.db.get(args.id);
    if (!existing) throw new ConvexError("That franchise no longer exists.");

    const fields = franchiseRowFields(args.name);
    if (fields.nameNormalized !== existing.nameNormalized) {
      const clash = await findFranchiseByName(
        ctx,
        existing.sportId,
        fields.name,
      );
      if (clash && clash._id !== args.id) {
        // Safe to name: it is a franchise in this sport the operator can go and
        // look at, not typed content echoed back.
        throw new ConvexError(
          `Another franchise in this sport is already called ${clash.name}.`,
        );
      }
    }

    await ctx.db.patch(args.id, { ...fields, lastUpdated: Date.now() });
    return null;
  },
});
