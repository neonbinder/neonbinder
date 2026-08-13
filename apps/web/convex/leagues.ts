/**
 * NEO-156 — leagues as a first-class entity.
 *
 * `teams.league` used to be a free-text string that nothing populated
 * reliably: 0 of 35 dev teams and 2 of 58 prod teams carried one. Every team
 * belongs to a league, so the relationship is modelled instead of typed.
 *
 * The important piece here is {@link resolveDefaultLeagueId}. There are seven
 * `insert("teams", …)` sites across three files, and "attach a league when a
 * team is created" is only true if every one of them does it. Rather than trust
 * seven copies to stay in step, they all call this one resolver — a new
 * creation path that forgets it is a visible omission at the call site, not a
 * silently league-less row.
 */

import { v } from "convex/values";
import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
} from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { requireAdmin } from "./auth";
import { sportConfigDefaultsFor } from "./sportConfig";

export const leagueDocValidator = v.object({
  _id: v.id("leagues"),
  _creationTime: v.number(),
  name: v.string(),
  abbreviation: v.optional(v.string()),
  nameNormalized: v.string(),
  sportId: v.id("selectorOptions"),
  lastUpdated: v.number(),
});

/**
 * Lowercase + strip punctuation, WITHOUT the token sort that
 * `teams.normalizeTeamName` applies.
 *
 * Sorting is a dedup trick for names that arrive in either order ("Yankees,
 * New York"). League names never do, and sorting would collapse "National
 * League" and "League National" into one row.
 */
export function normalizeLeagueName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[.,'"`’]/g, "")
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}

/**
 * Find-or-create a league for (sport, name). Shared by every writer so the
 * `(nameNormalized, sportId)` key is applied identically everywhere.
 *
 * Not a Convex function — a plain helper taking a mutation ctx, because its
 * callers are already inside mutations and a mutation cannot call another
 * mutation.
 */
export async function findOrCreateLeague(
  ctx: MutationCtx,
  args: { name: string; abbreviation?: string; sportId: Id<"selectorOptions"> },
): Promise<Id<"leagues">> {
  const name = args.name.trim();
  const nameNormalized = normalizeLeagueName(name);

  const existing = await ctx.db
    .query("leagues")
    .withIndex("by_name_normalized_and_sport_id", (q) =>
      q.eq("nameNormalized", nameNormalized).eq("sportId", args.sportId),
    )
    .first();

  if (existing) {
    // Fill in an abbreviation a later caller knows and the first did not,
    // rather than creating a second row for the same league.
    if (args.abbreviation && !existing.abbreviation) {
      await ctx.db.patch(existing._id, {
        abbreviation: args.abbreviation,
        lastUpdated: Date.now(),
      });
    }
    return existing._id;
  }

  return await ctx.db.insert("leagues", {
    name,
    abbreviation: args.abbreviation,
    nameNormalized,
    sportId: args.sportId,
    lastUpdated: Date.now(),
  });
}

/**
 * The league a newly-created team in this sport belongs to, creating the row
 * on first use.
 *
 * Sourced from the sport's own `sportConfig` — `league` is the abbreviation
 * ("MLB") and `espn.leagueName` the full name ("Major League Baseball") — so
 * no taxonomy is invented here. `sportConfig` is read from the sport ROW
 * first, falling back to the bootstrap defaults, because a row's config is
 * editable and the defaults are only a seed (NEO-96).
 *
 * Returns undefined when the sport has no configured league — a custom sport,
 * for instance. That is a legitimate outcome, not an error: the team is created
 * without one and an operator can assign it in Team Management. Callers must
 * therefore treat this as optional rather than asserting on it.
 */
export async function resolveDefaultLeagueId(
  ctx: MutationCtx,
  sportId: Id<"selectorOptions">,
): Promise<Id<"leagues"> | undefined> {
  const sport = await ctx.db.get(sportId);
  if (!sport) return undefined;

  const config =
    sport.sportConfig ?? sportConfigDefaultsFor(sport.value ?? "") ?? undefined;
  const abbreviation = config?.league;
  const fullName = config?.espn?.leagueName;

  const name = fullName ?? abbreviation;
  if (!name) return undefined;

  return await findOrCreateLeague(ctx, { name, abbreviation, sportId });
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * Leagues for a sport, or all of them. Drives the Team Management league
 * filter and the edit panel's dropdown.
 *
 * Admin-gated: leagues are only surfaced in admin tooling today, and gating
 * now is cheaper than discovering later that an ungated query grew a caller.
 */
export const list = query({
  args: { sportId: v.optional(v.id("selectorOptions")) },
  returns: v.array(leagueDocValidator),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const rows = args.sportId
      ? await ctx.db
          .query("leagues")
          .withIndex("by_sport_id", (q) => q.eq("sportId", args.sportId!))
          .collect()
      : await ctx.db.query("leagues").collect();
    return rows.sort((a, b) => a.name.localeCompare(b.name));
  },
});

/**
 * Add a league by hand, from the Team Management dropdown.
 *
 * Idempotent by (name, sport) — re-adding an existing league returns it rather
 * than creating a duplicate, which is what makes the inline "add new league"
 * path safe to use without first checking the list.
 */
export const create = mutation({
  args: {
    name: v.string(),
    abbreviation: v.optional(v.string()),
    sportId: v.id("selectorOptions"),
  },
  returns: v.id("leagues"),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const name = args.name.trim();
    if (!name) throw new Error("League name cannot be empty");
    return await findOrCreateLeague(ctx, {
      name,
      abbreviation: args.abbreviation?.trim() || undefined,
      sportId: args.sportId,
    });
  },
});

/** How many teams one backfill pass converts. Bounded for the same reason as the color backfill. */
const BACKFILL_BATCH = 200;

/**
 * NEO-156: resolve legacy `teams.league` strings into real league rows.
 *
 * Only touches rows that have the string and no `leagueId`, so it is safe to
 * re-run and never overwrites a league an operator has since assigned. Teams
 * with neither are left alone — they are the job of
 * `resolveDefaultLeagueId` at creation time, not of this backfill.
 *
 * Returns what it did rather than nothing, so the operator can tell "converted
 * nothing because there was nothing to convert" from "did not run".
 */
export const backfillLeagueIds = mutation({
  args: { limit: v.optional(v.number()) },
  returns: v.object({ converted: v.number(), remaining: v.number() }),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const limit = Math.min(args.limit ?? BACKFILL_BATCH, BACKFILL_BATCH);

    const stale = (await ctx.db.query("teams").collect()).filter(
      (t) => t.league && !t.leagueId,
    );

    for (const team of stale.slice(0, limit)) {
      const leagueId = await findOrCreateLeague(ctx, {
        name: team.league!,
        sportId: team.sportId,
      });
      await ctx.db.patch(team._id, {
        leagueId,
        // Clear the legacy string as it is converted, so a row is never
        // carrying two sources of truth for the same fact.
        league: undefined,
        lastUpdated: Date.now(),
      });
    }

    const converted = Math.min(stale.length, limit);
    return { converted, remaining: stale.length - converted };
  },
});
