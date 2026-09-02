import { query, mutation, internalMutation, internalQuery, action } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { getCurrentUserId, requireAdmin, requireSignedIn } from "./auth";
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
  // NEO-96: reference to the sport-level selectorOptions row.
  sportId: v.id("selectorOptions"),
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
  // NEO-96: reference to the sport-level selectorOptions row.
  sportId: v.id("selectorOptions"),
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
    sportId: v.id("selectorOptions"),
  },
  returns: v.union(playerDocPublicValidator, v.null()),
  handler: async (ctx, args) => {
    await requireSignedIn(ctx);
    const normalized = normalizePlayerName(args.name);
    const matches = await ctx.db
      .query("players")
      .withIndex("by_name_normalized", (q) => q.eq("nameNormalized", normalized))
      .collect();
    const found = matches.find((p) => p.sportId === args.sportId);
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
    sportId: v.id("selectorOptions"),
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
    const existing = matches.find((p) => p.sportId === args.sportId);
    if (existing) return existing._id;

    return await ctx.db.insert("players", {
      name: args.name.trim(),
      nameNormalized: normalized,
      sportId: args.sportId,
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
    sportId: v.optional(v.id("selectorOptions")),
    limit: v.optional(v.number()),
  },
  returns: v.array(playerDocPublicValidator),
  handler: async (ctx, args) => {
    await requireSignedIn(ctx);
    const limit = args.limit ?? 100;
    const docs = args.sportId
      ? await ctx.db
          .query("players")
          .withIndex("by_sport_id", (q) => q.eq("sportId", args.sportId!))
          .take(limit)
      : await ctx.db.query("players").take(limit);
    return docs.map(toPublicPlayer);
  },
});

/**
 * Default and maximum result counts for `search`.
 *
 * A typeahead list is read, not scrolled — past roughly ten rows the user is
 * better served by typing another character than by scanning further. The cap
 * matters more than the default: it is what stops a caller quietly turning
 * this back into the 500-row fetch it replaces.
 */
const SEARCH_DEFAULT_LIMIT = 10;
const SEARCH_MAX_LIMIT = 25;

/**
 * NEO-147: server-side player typeahead, backing the `PlayerAutocomplete`
 * primitive.
 *
 * The four typeaheads that predate this (SetSelector's PlayerPicker,
 * TeamPicker, EntityLinkSearch, CareerTeamEntry) each fetch up to 500 rows and
 * filter in the browser with `.includes()`. That holds for an admin working
 * inside a single sport; it does not hold for a collector searching every
 * player we know from the spine-label designer. This queries the `search_name`
 * index instead — see the schema for why that indexes `name` and deliberately
 * not `nameNormalized`.
 *
 * `sportId` is an optional filter rather than a requirement: the spine-label
 * designer has no sport context (a collector simply types a name), while an
 * admin surface that does have one should pass it to keep results relevant.
 *
 * An empty query returns nothing rather than "the first N players" — a
 * typeahead that suggests before you type is noise, and it would also be an
 * unbounded browse of the table.
 *
 * Public, like `list` and `get` above: player rows are globally-shared
 * reference data and `toPublicPlayer` strips `createdByUserId`.
 *
 * Unlike `list`/`get`/`getManyByIds` above, this one DOES require a signed-in
 * caller. Not for confidentiality — the data is the same public reference data
 * — but for cost. A Convex deployment URL ships in the client bundle, so an
 * ungated public query is internet-reachable by anyone, and search is the most
 * expensive query class Convex offers; this is the codebase's first search
 * index. Every real caller (`/print/spine-label`, `/design/primitives`) already
 * sits behind `ProtectedLayout`, so the check costs nothing functionally.
 * Returns empty rather than throwing, so a signed-out render is a quiet no-op.
 */
export const search = query({
  args: {
    query: v.string(),
    sportId: v.optional(v.id("selectorOptions")),
    limit: v.optional(v.number()),
  },
  returns: v.array(playerDocPublicValidator),
  handler: async (ctx, args) => {
    if (!(await getCurrentUserId(ctx))) return [];

    const term = args.query.trim();
    if (!term) return [];

    const limit = Math.min(args.limit ?? SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT);

    const docs = await ctx.db
      .query("players")
      .withSearchIndex("search_name", (q) => {
        const search = q.search("name", term);
        return args.sportId ? search.eq("sportId", args.sportId) : search;
      })
      .take(limit);

    return docs.map(toPublicPlayer);
  },
});

export const get = query({
  args: { id: v.id("players") },
  returns: v.union(playerDocPublicValidator, v.null()),
  handler: async (ctx, args) => {
    await requireSignedIn(ctx);
    const doc = await ctx.db.get(args.id);
    return doc ? toPublicPlayer(doc) : null;
  },
});

/**
 * Batch lookup for resolving a list of playerIds back to display rows.
 * NEO-25: the card detail panel renders player-name chips from
 * `cardChecklist.playerIds[]` without N round-trips. Mirrors
 * `teams.getManyByIds`. Missing IDs are silently dropped (an orphaned
 * link is a soft data error, not fatal). `createdByUserId` is stripped
 * via `toPublicPlayer`.
 *
 * NEO-202: this was the only function in this file with no identity check,
 * and the mirror it names — `teams.getManyByIds` — calls `requireSignedIn`.
 * That asymmetry is the exact shape NEO-154 called out (`teams.findOrCreate`
 * had no guard while its `players.findOrCreate` twin did), recurring with the
 * sides swapped. `requireSignedIn`, not `requireAdmin`: `players` is
 * signed-in-readable reference data — `get`, `search` and `findByNameAndSport`
 * all settle for signed-in — and the only callers (PlayerPicker, the card
 * detail chips) sit behind `ProtectedLayout` anyway.
 */
export const getManyByIds = query({
  args: { ids: v.array(v.id("players")) },
  returns: v.array(playerDocPublicValidator),
  handler: async (ctx, args) => {
    await requireSignedIn(ctx);
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
 *
 * NEO-203 — deliberately a full write, unlike its `teams` twin, which fills
 * gaps only. The asymmetry is not an oversight:
 *
 *  - `teams.applyEnrichmentInternal` guards because `teams.saveTeamFields`
 *    lets an operator hand-edit city / yearsActive / colors, so a blind write
 *    there destroys human input. `players` has NO such editor — there is no
 *    mutation in this file that writes `teamYears` or `isHallOfFame` from a
 *    person — so there is nothing here for a gap-fill rule to protect.
 *  - The only two callers left are a player being CREATED (nothing to
 *    clobber) and the operator's own force path, whose entire purpose is to
 *    replace an answer that turned out to be wrong. A gap-fill rule would
 *    defeat that second one.
 *
 * If a player editor is ever added, this needs the `teams` treatment — and
 * `convex/teams.applyEnrichmentInternal.test.ts` is the shape to copy.
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
 * Wikidata enrichment kickoff — non-blocking. `enrichPlayer` runs the SPARQL
 * query and writes results back via applyEnrichmentInternal. Failures are
 * logged but never thrown; an unenriched player is still usable.
 *
 * NEO-99: enqueues onto the shared Wikidata pool (convex/wikidataPool.ts)
 * rather than running the enrichment inline, so this entry point spends the
 * SAME deployment-wide 5-parallel SPARQL budget as the review-wizard drain
 * instead of adding an uncoordinated request that could push Wikidata past its
 * per-IP ceiling. Still fire-and-forget — the pool runs the work in the
 * background and enrichPlayer persists its own result.
 *
 * ## THE ONLY SANCTIONED PATH TO RE-LOOK-UP AN EXISTING PLAYER (NEO-203)
 *
 * Jason, 2026-09-02: "if the player is already known we should not try to look
 * up the data again." Automatic enrichment is creation-only; `enrichPlayer`
 * enforces that structurally by skipping any player that already carries
 * career teams, a Hall-of-Fame answer, or a Wikidata id.
 *
 * This action is the deliberate exception, exactly as its `teams` twin is: it
 * is admin-gated, human-initiated on a specific row, and its purpose is the one
 * case where the stored answer is wrong. It therefore passes `force`. No
 * automatic caller may — see `wikidataPool.enqueueEnrichment`.
 *
 * Note what is NOT an exception: the entity-review wizard's preview lookup.
 * That runs on unresolved NAMES before any row exists (`runEntityReviewLookup`
 * writes only to `entityReviewQueue`), and `resolveUnknownsAndStartBatch`
 * queues a name only after `players.findByNameAndSport` returned nothing. A
 * "link" decision — the operator pointing an unknown name at an existing
 * player — likewise triggers no lookup for that player: the commit prelude
 * reads the linked row once for its spelling and enqueues nothing.
 */
export const enrichFromWikidata = action({
  args: { id: v.id("players") },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    // NEO-147: gated for the same reason as the `teams` twin, and it had the
    // same shape — a public action with no authorization and no callers, which
    // let any client spend an outbound Wikidata round-trip per call, for any
    // player id, at any rate. Enrichment writes to globally-shared player rows.
    await requireAdmin(ctx);
    try {
      await ctx.runMutation(internal.wikidataPool.enqueueEnrichment, {
        playerIds: [args.id],
        // NEO-203: the operator exception — see the note above. Automatic
        // callers must never set this.
        force: true,
      });
    } catch (error) {
      console.error("[players.enrichFromWikidata] failed:", error);
    }
    return null;
  },
});
