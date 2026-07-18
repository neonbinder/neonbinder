import { query, mutation, internalMutation, internalQuery, action } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { requireAdmin } from "./auth";

/**
 * Lowercase + strip punctuation + token-sort. Same shape as the player
 * normalizer — keeps "Yankees, New York" and "New York Yankees" deduped
 * to one row. Used as the dedup key on `teams.nameNormalized`.
 */
export function normalizeTeamName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[.,'"`’]/g, "")
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(" ");
}

/**
 * Teams are intentionally globally-shared rows: a single (name, sport)
 * key resolves to the same `teams._id` regardless of which user
 * triggered the row's creation. Yankees are Yankees. Do NOT add
 * per-user fields to this table — push user-specific data onto
 * separate per-user join tables instead. See the analogous note in
 * `convex/players.ts`.
 */
const teamDocValidator = v.object({
  _id: v.id("teams"),
  _creationTime: v.number(),
  name: v.string(),
  nameNormalized: v.string(),
  sport: v.string(),
  league: v.optional(v.string()),
  city: v.optional(v.string()),
  yearsActive: v.optional(v.object({
    from: v.number(),
    to: v.optional(v.number()),
  })),
  colors: v.optional(v.object({
    primary: v.optional(v.string()),
    secondary: v.optional(v.string()),
  })),
  externalIds: v.optional(v.object({
    wikidataId: v.optional(v.string()),
    espnId: v.optional(v.string()),
  })),
  lastUpdated: v.number(),
});

export const findByNameAndSport = query({
  args: {
    name: v.string(),
    sport: v.string(),
  },
  returns: v.union(teamDocValidator, v.null()),
  handler: async (ctx, args) => {
    const normalized = normalizeTeamName(args.name);
    const matches = await ctx.db
      .query("teams")
      .withIndex("by_name_normalized", (q) => q.eq("nameNormalized", normalized))
      .collect();
    return matches.find((t) => t.sport === args.sport) ?? null;
  },
});

export const findOrCreate = mutation({
  args: {
    name: v.string(),
    sport: v.string(),
  },
  returns: v.id("teams"),
  handler: async (ctx, args): Promise<Id<"teams">> => {
    const normalized = normalizeTeamName(args.name);
    const matches = await ctx.db
      .query("teams")
      .withIndex("by_name_normalized", (q) => q.eq("nameNormalized", normalized))
      .collect();
    const existing = matches.find((t) => t.sport === args.sport);
    if (existing) return existing._id;

    return await ctx.db.insert("teams", {
      name: args.name.trim(),
      nameNormalized: normalized,
      sport: args.sport,
      lastUpdated: Date.now(),
    });
  },
});

/**
 * Idempotent: ensures a fixed set of teams exists for Maestro E2E
 * flows that need a deterministic typeahead match (TeamPicker tests
 * assert "Add New York Yankees" / "Add New York Mets" by aria-label).
 * The cascade `cards-base` flow normally populates the teams table
 * via the "Confirm New Players & Teams" dialog, but its output
 * depends on marketplace data and skip-some flows can leave specific
 * teams absent. Calling this from cascade/setup.yaml guarantees the
 * test teams exist regardless of cascade output.
 *
 * Admin-only + ALLOW_RESET_SET_BUILDER_DATA gate mirrors the reset
 * mutation: same blast radius (test deployments only).
 */
export const seedTestTeams = mutation({
  args: {},
  returns: v.object({ created: v.number(), existing: v.number() }),
  handler: async (ctx) => {
    await requireAdmin(ctx);
    if (process.env.ALLOW_RESET_SET_BUILDER_DATA !== "true") {
      throw new Error(
        "Seed Test Teams is not enabled in this environment. " +
          "Set ALLOW_RESET_SET_BUILDER_DATA=true on the Convex deployment to enable.",
      );
    }
    const seeds: Array<{ name: string; sport: string }> = [
      { name: "New York Yankees", sport: "Baseball" },
      { name: "New York Mets", sport: "Baseball" },
    ];
    let created = 0;
    let existing = 0;
    for (const seed of seeds) {
      const normalized = normalizeTeamName(seed.name);
      const matches = await ctx.db
        .query("teams")
        .withIndex("by_name_normalized", (q) =>
          q.eq("nameNormalized", normalized),
        )
        .collect();
      if (matches.find((t) => t.sport === seed.sport)) {
        existing += 1;
        continue;
      }
      await ctx.db.insert("teams", {
        name: seed.name,
        nameNormalized: normalized,
        sport: seed.sport,
        lastUpdated: Date.now(),
      });
      created += 1;
    }
    return { created, existing };
  },
});

export const list = query({
  args: {
    sport: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  returns: v.array(teamDocValidator),
  handler: async (ctx, args) => {
    const limit = args.limit ?? 100;
    if (args.sport) {
      return await ctx.db
        .query("teams")
        .withIndex("by_sport", (q) => q.eq("sport", args.sport!))
        .take(limit);
    }
    return await ctx.db.query("teams").take(limit);
  },
});

export const get = query({
  args: { id: v.id("teams") },
  returns: v.union(teamDocValidator, v.null()),
  handler: async (ctx, args) => await ctx.db.get(args.id),
});

/**
 * Batch lookup for resolving a list of teamIds back to display rows.
 * Used by the CardChecklistItem display row + TeamPicker chip view to
 * render the names without N round-trips. Missing IDs are silently
 * dropped (an orphaned link is a soft data error, not a fatal one).
 */
export const getManyByIds = query({
  args: { ids: v.array(v.id("teams")) },
  returns: v.array(teamDocValidator),
  handler: async (ctx, args) => {
    const rows = await Promise.all(args.ids.map((id) => ctx.db.get(id)));
    return rows.filter((r): r is NonNullable<typeof r> => r !== null);
  },
});

/**
 * Internal `get` and `findOrCreate` for actions that run outside user
 * auth (e.g. Wikidata enrichment). The Wikidata player adapter resolves
 * each P54 team membership through findOrCreateInternal, which is why
 * enriching one player can spawn many team rows in a single pass.
 */
export const getInternal = internalQuery({
  args: { id: v.id("teams") },
  returns: v.union(teamDocValidator, v.null()),
  handler: async (ctx, args) => await ctx.db.get(args.id),
});

export const findOrCreateInternal = internalMutation({
  args: {
    name: v.string(),
    sport: v.string(),
  },
  returns: v.id("teams"),
  handler: async (ctx, args): Promise<Id<"teams">> => {
    const normalized = normalizeTeamName(args.name);
    const matches = await ctx.db
      .query("teams")
      .withIndex("by_name_normalized", (q) => q.eq("nameNormalized", normalized))
      .collect();
    const existing = matches.find((t) => t.sport === args.sport);
    if (existing) return existing._id;

    return await ctx.db.insert("teams", {
      name: args.name.trim(),
      nameNormalized: normalized,
      sport: args.sport,
      lastUpdated: Date.now(),
    });
  },
});

export const applyEnrichmentInternal = internalMutation({
  args: {
    id: v.id("teams"),
    league: v.optional(v.string()),
    city: v.optional(v.string()),
    yearsActive: v.optional(v.object({
      from: v.number(),
      to: v.optional(v.number()),
    })),
    // NEO-91: from ESPN (adapters/espn.ts) — see schema.ts's doc comment on
    // `teams.colors` for why this doesn't come from Wikidata.
    colors: v.optional(v.object({
      primary: v.optional(v.string()),
      secondary: v.optional(v.string()),
    })),
    wikidataId: v.optional(v.string()),
    espnId: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.id);
    if (!existing) return null;

    const patch: {
      league?: string;
      city?: string;
      yearsActive?: { from: number; to?: number };
      colors?: { primary?: string; secondary?: string };
      externalIds?: { wikidataId?: string; espnId?: string };
      lastUpdated: number;
    } = { lastUpdated: Date.now() };

    if (args.league !== undefined) patch.league = args.league;
    if (args.city !== undefined) patch.city = args.city;
    if (args.yearsActive !== undefined) patch.yearsActive = args.yearsActive;
    if (args.colors !== undefined) patch.colors = args.colors;
    if (args.wikidataId !== undefined || args.espnId !== undefined) {
      patch.externalIds = {
        ...(existing.externalIds ?? {}),
        ...(args.wikidataId !== undefined ? { wikidataId: args.wikidataId } : {}),
        ...(args.espnId !== undefined ? { espnId: args.espnId } : {}),
      };
    }
    await ctx.db.patch(args.id, patch);
    return null;
  },
});

export const enrichFromWikidata = action({
  args: { id: v.id("teams") },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    try {
      await ctx.runAction(internal.adapters.wikidata.enrichTeam, { teamId: args.id });
    } catch (error) {
      console.error("[teams.enrichFromWikidata] failed:", error);
    }
    return null;
  },
});
