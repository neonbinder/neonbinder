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
  // NEO-96: reference to the sport-level selectorOptions row.
  sportId: v.id("selectorOptions"),
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
    sportId: v.id("selectorOptions"),
  },
  returns: v.union(teamDocValidator, v.null()),
  handler: async (ctx, args) => {
    const normalized = normalizeTeamName(args.name);
    const matches = await ctx.db
      .query("teams")
      .withIndex("by_name_normalized", (q) => q.eq("nameNormalized", normalized))
      .collect();
    return matches.find((t) => t.sportId === args.sportId) ?? null;
  },
});

export const findOrCreate = mutation({
  args: {
    name: v.string(),
    sportId: v.id("selectorOptions"),
  },
  returns: v.id("teams"),
  handler: async (ctx, args): Promise<Id<"teams">> => {
    const normalized = normalizeTeamName(args.name);
    const matches = await ctx.db
      .query("teams")
      .withIndex("by_name_normalized", (q) => q.eq("nameNormalized", normalized))
      .collect();
    const existing = matches.find((t) => t.sportId === args.sportId);
    if (existing) return existing._id;

    return await ctx.db.insert("teams", {
      name: args.name.trim(),
      nameNormalized: normalized,
      sportId: args.sportId,
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
    // NEO-96: teams now reference the sport row, so the Baseball row must
    // already exist — i.e. the sport sync has to have run before this. That is
    // an ORDERING REQUIREMENT for setup.yaml, not an incidental detail: seeding
    // before the sync would silently produce zero teams and the TeamPicker
    // flows would fail far downstream with no clue why. Fail loudly instead.
    const baseball = await ctx.db
      .query("selectorOptions")
      .withIndex("by_level", (q) => q.eq("level", "sport"))
      .collect();
    const baseballRow = baseball.find(
      (o) => o.value.toLowerCase().trim() === "baseball",
    );
    if (!baseballRow) {
      throw new Error(
        "Seed Test Teams requires the Baseball sport row to exist — run the " +
          "sport sync first (setup.yaml must sync sports before seeding teams).",
      );
    }

    const seeds = [{ name: "New York Yankees" }, { name: "New York Mets" }];
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
      if (matches.find((t) => t.sportId === baseballRow._id)) {
        existing += 1;
        continue;
      }
      await ctx.db.insert("teams", {
        name: seed.name,
        nameNormalized: normalized,
        sportId: baseballRow._id,
        lastUpdated: Date.now(),
      });
      created += 1;
    }
    return { created, existing };
  },
});

export const list = query({
  args: {
    sportId: v.optional(v.id("selectorOptions")),
    limit: v.optional(v.number()),
  },
  returns: v.array(teamDocValidator),
  handler: async (ctx, args) => {
    const limit = args.limit ?? 100;
    if (args.sportId) {
      return await ctx.db
        .query("teams")
        .withIndex("by_sport_id", (q) => q.eq("sportId", args.sportId!))
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
    sportId: v.id("selectorOptions"),
  },
  returns: v.id("teams"),
  handler: async (ctx, args): Promise<Id<"teams">> => {
    const normalized = normalizeTeamName(args.name);
    const matches = await ctx.db
      .query("teams")
      .withIndex("by_name_normalized", (q) => q.eq("nameNormalized", normalized))
      .collect();
    const existing = matches.find((t) => t.sportId === args.sportId);
    if (existing) return existing._id;

    return await ctx.db.insert("teams", {
      name: args.name.trim(),
      nameNormalized: normalized,
      sportId: args.sportId,
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

/**
 * Wikidata enrichment kickoff — non-blocking. NEO-99: enqueues onto the shared
 * Wikidata pool (convex/wikidataPool.ts) rather than running the enrichment
 * inline, so this entry point spends the SAME deployment-wide 5-parallel SPARQL
 * budget as the review-wizard drain instead of adding an uncoordinated request.
 * Still fire-and-forget — the pool runs enrichTeam in the background and it
 * persists its own result; an unenriched team is a valid end state.
 */
export const enrichFromWikidata = action({
  args: { id: v.id("teams") },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    try {
      await ctx.runMutation(internal.wikidataPool.enqueueEnrichment, {
        teamIds: [args.id],
      });
    } catch (error) {
      console.error("[teams.enrichFromWikidata] failed:", error);
    }
    return null;
  },
});
