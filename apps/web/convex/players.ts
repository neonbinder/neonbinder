import { query, mutation, internalMutation, internalQuery, action } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { getCurrentUserId } from "./auth";
import type { Id } from "./_generated/dataModel";

/**
 * Lowercase + collapse whitespace + strip punctuation + token-sort. Used
 * as the dedup key on `players.nameNormalized`. Token-sorting "Smith,
 * John" and "John Smith" to the same key prevents marketplace formatting
 * differences from creating duplicate player rows.
 */
export function normalizePlayerName(raw: string): string {
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
 * Players are intentionally globally-shared rows: a single (name, sport)
 * key resolves to the same `players._id` regardless of which user added
 * it first. Mike Trout is Mike Trout. Do NOT add per-user fields to this
 * table — push user-specific data (notes, watchlist, etc.) onto separate
 * per-user join tables instead.
 *
 * `createdByUserId` is kept for audit only and MUST NOT appear in
 * client-facing query responses. Using `playerDocValidator` (with the
 * field) is reserved for `internalQuery`/`internalMutation`; the public
 * `query`s use `playerDocPublicValidator`. Leaking `createdByUserId`
 * into the client response would let any user enumerate which Clerk
 * subject first registered any given player — a small but real
 * cross-user identity correlation leak.
 */
const playerDocPublicValidator = v.object({
  _id: v.id("players"),
  _creationTime: v.number(),
  name: v.string(),
  nameNormalized: v.string(),
  primarySport: v.string(),
  teamYears: v.optional(v.array(v.object({
    teamId: v.id("teams"),
    fromYear: v.number(),
    toYear: v.optional(v.number()),
  }))),
  isHallOfFame: v.optional(v.boolean()),
  externalIds: v.optional(v.object({
    wikidataId: v.optional(v.string()),
  })),
  lastUpdated: v.number(),
});

const playerDocValidator = v.object({
  _id: v.id("players"),
  _creationTime: v.number(),
  name: v.string(),
  nameNormalized: v.string(),
  primarySport: v.string(),
  teamYears: v.optional(v.array(v.object({
    teamId: v.id("teams"),
    fromYear: v.number(),
    toYear: v.optional(v.number()),
  }))),
  isHallOfFame: v.optional(v.boolean()),
  externalIds: v.optional(v.object({
    wikidataId: v.optional(v.string()),
  })),
  createdByUserId: v.optional(v.string()),
  lastUpdated: v.number(),
});

/**
 * Strip the audit-only `createdByUserId` field from a player document
 * before returning it to a public query handler. See the comment on
 * `playerDocPublicValidator` for rationale.
 */
function toPublicPlayer<T extends { createdByUserId?: string }>(doc: T): Omit<T, "createdByUserId"> {
  // Destructure to peel off createdByUserId — `_` is the discarded slot,
  // explicitly marked unused for the linter.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { createdByUserId: _omit, ...rest } = doc;
  return rest;
}

/**
 * Look up a player by sport + normalized name. Returns null if not found.
 * Public query — `createdByUserId` is omitted from the response.
 */
export const findByNameAndSport = query({
  args: {
    name: v.string(),
    sport: v.string(),
  },
  returns: v.union(playerDocPublicValidator, v.null()),
  handler: async (ctx, args) => {
    const normalized = normalizePlayerName(args.name);
    const matches = await ctx.db
      .query("players")
      .withIndex("by_name_normalized", (q) => q.eq("nameNormalized", normalized))
      .collect();
    const found = matches.find((p) => p.primarySport === args.sport);
    return found ? toPublicPlayer(found) : null;
  },
});

/**
 * Create-if-missing player by name + sport. Idempotent — calling twice
 * with the same inputs returns the same id. The reconciler in
 * fetchCardChecklist calls this once per BSC `players[]` entry the user
 * confirmed in UnknownEntitiesDialog.
 *
 * Cross-user note: the row this returns may have been created by a
 * different user. That's intentional — see playerDocPublicValidator's
 * docstring. Do NOT add per-user state to the returned row.
 */
export const findOrCreate = mutation({
  args: {
    name: v.string(),
    sport: v.string(),
  },
  returns: v.id("players"),
  handler: async (ctx, args): Promise<Id<"players">> => {
    const userId = await getCurrentUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const normalized = normalizePlayerName(args.name);
    const matches = await ctx.db
      .query("players")
      .withIndex("by_name_normalized", (q) => q.eq("nameNormalized", normalized))
      .collect();
    const existing = matches.find((p) => p.primarySport === args.sport);
    if (existing) return existing._id;

    return await ctx.db.insert("players", {
      name: args.name.trim(),
      nameNormalized: normalized,
      primarySport: args.sport,
      createdByUserId: userId,
      lastUpdated: Date.now(),
    });
  },
});

/**
 * List players for the picker UI. Filterable by sport for binder shells
 * that scope to a single league. Returns name + key flags only — full
 * documents are fetched on demand.
 */
export const list = query({
  args: {
    sport: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  returns: v.array(playerDocPublicValidator),
  handler: async (ctx, args) => {
    const limit = args.limit ?? 100;
    const docs = args.sport
      ? await ctx.db
          .query("players")
          .withIndex("by_sport", (q) => q.eq("primarySport", args.sport!))
          .take(limit)
      : await ctx.db.query("players").take(limit);
    return docs.map(toPublicPlayer);
  },
});

export const get = query({
  args: { id: v.id("players") },
  returns: v.union(playerDocPublicValidator, v.null()),
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.id);
    return doc ? toPublicPlayer(doc) : null;
  },
});

/**
 * Batch lookup for resolving a list of playerIds back to display rows.
 * NEO-25: the card detail panel renders player-name chips from
 * `cardChecklist.playerIds[]` without N round-trips. Mirrors
 * `teams.getManyByIds`. Missing IDs are silently dropped (an orphaned
 * link is a soft data error, not fatal). Public — `createdByUserId`
 * is stripped via `toPublicPlayer`.
 */
export const getManyByIds = query({
  args: { ids: v.array(v.id("players")) },
  returns: v.array(playerDocPublicValidator),
  handler: async (ctx, args) => {
    const rows = await Promise.all(args.ids.map((id) => ctx.db.get(id)));
    return rows
      .filter((r): r is NonNullable<typeof r> => r !== null)
      .map(toPublicPlayer);
  },
});

/**
 * Internal counterpart of `get` — used by Wikidata enrichment actions that
 * run outside the user's auth context. Internal queries never enforce
 * Clerk identity so background enrichment can read freely.
 */
export const getInternal = internalQuery({
  args: { id: v.id("players") },
  returns: v.union(playerDocValidator, v.null()),
  handler: async (ctx, args) => await ctx.db.get(args.id),
});

/**
 * Apply Wikidata enrichment to an existing player row. Called from the
 * Wikidata adapter action so this runs in a mutation context with no
 * external IO. Updates teamYears, isHallOfFame, externalIds.
 */
export const applyEnrichmentInternal = internalMutation({
  args: {
    id: v.id("players"),
    teamYears: v.optional(v.array(v.object({
      teamId: v.id("teams"),
      fromYear: v.number(),
      toYear: v.optional(v.number()),
    }))),
    isHallOfFame: v.optional(v.boolean()),
    wikidataId: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.id);
    if (!existing) return null;

    const patch: {
      teamYears?: Array<{ teamId: Id<"teams">; fromYear: number; toYear?: number }>;
      isHallOfFame?: boolean;
      externalIds?: { wikidataId?: string };
      lastUpdated: number;
    } = { lastUpdated: Date.now() };

    if (args.teamYears !== undefined) patch.teamYears = args.teamYears;
    if (args.isHallOfFame !== undefined) patch.isHallOfFame = args.isHallOfFame;
    if (args.wikidataId !== undefined) {
      patch.externalIds = { ...(existing.externalIds ?? {}), wikidataId: args.wikidataId };
    }
    await ctx.db.patch(args.id, patch);
    return null;
  },
});

/**
 * Wikidata enrichment kickoff — non-blocking. The action runs the SPARQL
 * query, then writes results back via applyEnrichmentInternal. Failures
 * are logged but never thrown; an unenriched player is still usable.
 */
export const enrichFromWikidata = action({
  args: { id: v.id("players") },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    try {
      await ctx.runAction(internal.adapters.wikidata.enrichPlayer, { playerId: args.id });
    } catch (error) {
      console.error("[players.enrichFromWikidata] failed:", error);
    }
    return null;
  },
});
