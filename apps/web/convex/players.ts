import { query, mutation, internalMutation, internalQuery, action } from "./_generated/server";
import { internal } from "./_generated/api";
import { ConvexError, v } from "convex/values";
import { getCurrentUserId, requireAdmin, requireSignedIn } from "./auth";
import type { Id } from "./_generated/dataModel";
import {
  longestToken,
  nameTokens,
  rankPlayerCandidates,
} from "./lib/entityNearMatch";
import { sortTeamYears } from "../lib/players/team-tenure";

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
 * One career stint: a player on a team from `fromYear` until `toYear`
 * (open-ended while they are still there). Mirrors the `players.teamYears`
 * element shape in the schema.
 */
export type PlayerTeamYear = {
  teamId: Id<"teams">;
  fromYear: number;
  toYear?: number;
};

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
    // NEO-208 deliberately left this at signed-in while raising its
    // `teams.findOrCreate` twin to admin: that one now schedules a pooled
    // Wikidata enrichment on its insert branch, so it gained a cost vector an
    // open caller could drive. This one adds no enqueue and no new cost, so
    // widening the gate here would be scope the ticket did not earn.
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

/** How many search-index rows feed the ranker, and how many rank out by default. */
const NEAR_MATCH_SEARCH_CANDIDATES = 10;
const NEAR_MATCH_DEFAULT_LIMIT = 5;
const NEAR_MATCH_MAX_LIMIT = 25;

/**
 * NEO-212: the "did you mean?" prompt in front of creating a player. The twin
 * of `teams.nearMatches` — see the section header above that function for what
 * Convex's search index actually does (OR-ish over terms, prefix matching on
 * the final term only, no typo tolerance) and why the fallback query below is
 * a second search rather than a bigger `.take()`.
 *
 * Three steps, widening:
 *
 *   1. The exact dedup key, via `by_name_normalized_and_sport_id`. This is the
 *      hit that must never be missed — a row `findOrCreate` would reuse.
 *   2. `search_name` on the whole name; if that returns nothing, a second
 *      search on the LAST token. Last, not longest: the ladder in
 *      `lib/pairing/names.ts` treats the final token as the surname and
 *      refuses to match anything whose surname disagrees, so the surname is
 *      the only term whose absence guarantees a miss. "Shohei" would happily
 *      out-rank the row we want; "Ohtani" cannot. `longestToken` is the
 *      fallback's fallback, for the degenerate name with no tokens left after
 *      normalisation.
 *   3. `rankPlayerCandidates` over the union, dropping everything it ranks
 *      neither exact nor close.
 *
 * Advisory only — `close` fires on a shared surname plus an initial, and two
 * brothers share both. The operator decides; this query only offers.
 *
 * Admin-gated, unlike `search` above: this one exists to guard a write to
 * globally-shared reference data, and its only caller is the review wizard.
 * Returns the public shape (never `createdByUserId` — see `toPublicPlayer`).
 */
export const nearMatches = query({
  args: {
    name: v.string(),
    sportId: v.id("selectorOptions"),
    limit: v.optional(v.number()),
  },
  returns: v.array(
    v.object({
      _id: v.id("players"),
      name: v.string(),
      confidence: v.union(v.literal("exact"), v.literal("close")),
    }),
  ),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);

    const name = args.name.trim();
    if (!name) return [];

    const limit = Math.min(
      args.limit ?? NEAR_MATCH_DEFAULT_LIMIT,
      NEAR_MATCH_MAX_LIMIT,
    );

    // Keyed by id so the exact hit and a search hit for the same row collapse.
    const candidates = new Map<
      Id<"players">,
      { _id: Id<"players">; name: string }
    >();

    const normalized = normalizePlayerName(name);
    if (normalized) {
      const exact = await ctx.db
        .query("players")
        .withIndex("by_name_normalized_and_sport_id", (q) =>
          q.eq("nameNormalized", normalized).eq("sportId", args.sportId),
        )
        .first();
      if (exact) candidates.set(exact._id, { _id: exact._id, name: exact.name });
    }

    const searchPlayers = async (term: string) =>
      await ctx.db
        .query("players")
        .withSearchIndex("search_name", (q) =>
          q.search("name", term).eq("sportId", args.sportId),
        )
        .take(NEAR_MATCH_SEARCH_CANDIDATES);

    let hits = await searchPlayers(name);
    if (hits.length === 0) {
      const tokens = nameTokens(name);
      const fallbackTerm = tokens.length > 0 ? tokens[tokens.length - 1] : longestToken(name);
      if (fallbackTerm) hits = await searchPlayers(fallbackTerm);
    }
    for (const hit of hits) {
      candidates.set(hit._id, { _id: hit._id, name: hit.name });
    }

    const rows = [...candidates.values()];
    return rankPlayerCandidates(name, rows)
      .slice(0, limit)
      .map(({ index, confidence }) => ({
        _id: rows[index]._id,
        name: rows[index].name,
        confidence,
      }));
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

// ===========================================================================
// NEO-212 — Player Management (/admin/players)
//
// The three functions below back the admin Players page, a mirror of
// /admin/teams. They are the only human-driven writers of `players` rows, and
// they are the reason `applyEnrichmentInternal`'s docstring above now has a
// live answer to its own "if a player editor is ever added" caveat — see the
// note on `savePlayerFields`.
//
// User-facing failures throw `ConvexError`, not bare `Error`. Convex replaces a
// plain `Error`'s message with "Server Error" in a deployed backend, and the
// NAME_TAKEN message below is *load-bearing UI data* (the page turns it into a
// link to the colliding player), so it has to survive the trip. Same choice
// `teams.findOrCreate` made in NEO-208.
// ===========================================================================

/**
 * Hard ceiling on rows returned by `listForManagement`.
 *
 * Lower than `teams`' 2000 on purpose: there are one or two orders of
 * magnitude more players than teams, and unlike the team screen this page has
 * a real server-side search (`players.search`) to fall back on, so the full
 * list only ever has to be a starting point rather than the whole dataset.
 */
const PLAYER_MANAGEMENT_CAP = 500;

/**
 * Bound on an operator-typed player name — same value and same reasoning as
 * `teams.MAX_TEAM_NAME_LENGTH`. Over-length is refused rather than trimmed:
 * silently storing something other than what was typed is how a mangled name
 * becomes canonical for every listing title and spine label downstream.
 */
const MAX_PLAYER_NAME_LENGTH = 120;

/** A Wikidata entity id. The only form `externalIds.wikidataId` may hold. */
const WIKIDATA_QID = /^Q\d+$/;

/**
 * Earliest plausible career year. Baseball's first professional league (the
 * National Association) formed in 1871; 1850 leaves room for the pre-league
 * amateur era without admitting an obvious typo like `195` or `19999`.
 */
const MIN_CAREER_YEAR = 1850;

/**
 * NEO-212: the whole player list, for the Player Management page.
 *
 * This is the "nothing typed yet" view, and only that. The page switches to
 * `players.search` — the `search_name` index — the moment the admin types a
 * character, so this query never has to be the thing that finds a specific
 * player among tens of thousands. That is what lets it stay a capped `.take()`
 * rather than becoming a paginated browse.
 *
 * `truncated` is reported rather than silently dropped, for the same reason
 * `teams.listForManagement` reports it: a list that quietly stops at the cap
 * reads as "that is all the players", which is the kind of wrong the operator
 * cannot see. Here it is not a distant scale worry — 500 is a number a real
 * deployment passes early — so the flag is load-bearing from day one, and the
 * page uses it to say "keep typing" instead of implying completeness.
 *
 * `createdByUserId` is stripped by `toPublicPlayer`, exactly as in every other
 * public query in this file. Admin-gated, but that is not a licence to leak the
 * audit field: the validator is what enforces it and the validator is public.
 */
export const listForManagement = query({
  args: {
    sportId: v.optional(v.id("selectorOptions")),
    limit: v.optional(v.number()),
  },
  returns: v.object({
    players: v.array(playerDocPublicValidator),
    totalCount: v.number(),
    truncated: v.boolean(),
  }),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);

    // The cap is a ceiling, not a suggestion: a caller passing 10_000 gets 500.
    const limit = Math.max(
      1,
      Math.min(args.limit ?? PLAYER_MANAGEMENT_CAP, PLAYER_MANAGEMENT_CAP),
    );

    // limit + 1 is the truncation probe — one row past the cap is how we learn
    // there is more without paying for a count of the whole table.
    const rows = args.sportId
      ? await ctx.db
          .query("players")
          .withIndex("by_sport_id", (q) => q.eq("sportId", args.sportId!))
          .take(limit + 1)
      : await ctx.db.query("players").take(limit + 1);

    const truncated = rows.length > limit;
    const players = rows.slice(0, limit).map(toPublicPlayer);
    players.sort((a, b) => a.name.localeCompare(b.name));

    return { players, totalCount: players.length, truncated };
  },
});

/**
 * NEO-212: admin quick-add for a player, the counterpart of `teams.findOrCreate`.
 *
 * Separate from `findOrCreate` above rather than a widening of it, because the
 * two have genuinely different contracts and NEO-208 already drew that line:
 * `findOrCreate` is the signed-in reconciler the checklist commit path calls
 * per confirmed BSC name, and it deliberately schedules no enrichment, so it
 * adds no cost vector an open caller could drive. This one is admin-only and
 * DOES enqueue a pooled Wikidata lookup, which is precisely why it could not
 * simply be the same function with a flag.
 *
 * Idempotent, and that is a correctness requirement rather than a convenience:
 * players are globally-shared rows keyed on (normalized name, sport), so a
 * double-submitted form must resolve to the existing row instead of creating a
 * second Mike Trout. `created` tells the page which happened, so it can say
 * "already here" and jump to the row rather than claiming a creation.
 */
export const createByAdmin = mutation({
  args: {
    name: v.string(),
    sportId: v.id("selectorOptions"),
  },
  returns: v.object({
    id: v.id("players"),
    created: v.boolean(),
  }),
  handler: async (ctx, args): Promise<{ id: Id<"players">; created: boolean }> => {
    const userId = await requireAdmin(ctx);

    const name = args.name.trim();
    if (name.length === 0) {
      throw new ConvexError("A player name is required.");
    }
    if (name.length > MAX_PLAYER_NAME_LENGTH) {
      // The LENGTH, never the name: this string reaches Sentry and the browser
      // console through Convex's error path.
      throw new ConvexError(
        `A player name is ${name.length} characters; the limit is ${MAX_PLAYER_NAME_LENGTH}.`,
      );
    }

    // `sportId` is a bare `v.id("selectorOptions")` — the validator proves it
    // is an id in that table, not that it points at a SPORT. A player hung off,
    // say, a variantType row is unreachable by every query that matters
    // (`list`, `search` and `findByNameAndSport` all key on the sport row id),
    // so it would be an orphan. Same check `teams.findOrCreate` makes.
    const sportRow = await ctx.db.get(args.sportId);
    if (!sportRow || sportRow.level !== "sport") {
      throw new ConvexError("A player must be created under a sport.");
    }

    const nameNormalized = normalizePlayerName(name);
    // The compound index, not `by_name_normalized` + a client-side sport
    // filter: a common surname matches across every sport we track, and the
    // narrow read is the difference on a table this size.
    const existing = await ctx.db
      .query("players")
      .withIndex("by_name_normalized_and_sport_id", (q) =>
        q.eq("nameNormalized", nameNormalized).eq("sportId", args.sportId),
      )
      .first();
    // NOT enqueued — see the creation-only note on the insert below.
    if (existing) return { id: existing._id, created: false };

    const id = await ctx.db.insert("players", {
      name,
      nameNormalized,
      sportId: args.sportId,
      createdByUserId: userId,
      lastUpdated: Date.now(),
    });

    // An audit trail for a shared-row creation an operator triggers from a
    // form. Structured JSON, not concatenation — the name is operator input and
    // must not be able to shape a log line.
    console.log(
      JSON.stringify({ msg: "player_created", playerId: id, sportId: args.sportId, userId }),
    );

    /**
     * Enrich the player we just INSERTED, and only that.
     *
     * The early `return { id: existing._id, created: false }` above is what
     * makes this honour `enqueueEnrichment`'s CREATION-ONLY contract (see the
     * contract note in `wikidataPool.ts`): a player this mutation FOUND leaves
     * without being enqueued. Jason, 2026-09-02: "if the player is already
     * known we should not try to look up the data again."
     *
     * No `force` — that flag belongs to `enrichFromWikidata`, the human "this
     * answer is wrong, look again" remedy. This is an automatic caller and
     * automatic callers never set it.
     *
     * Scheduled rather than awaited inline because enrichment is a network
     * round-trip and this is a mutation — the same reason `teams.findOrCreate`
     * schedules its own.
     */
    await ctx.scheduler.runAfter(0, internal.wikidataPool.enqueueEnrichment, {
      playerIds: [id],
    });

    return { id, created: true };
  },
});

/**
 * NEO-212: manual field entry for the player editor — the counterpart of
 * `teams.saveTeamFields`.
 *
 * ## This is the editor `applyEnrichmentInternal` warned about
 *
 * That function's docstring justifies its blind full write by observing that
 * `players` has no hand-editor, so there is no human input for a gap-fill rule
 * to protect. This function is that editor, and the caveat it names ("if a
 * player editor is ever added, this needs the `teams` treatment") now applies.
 *
 * It is NOT resolved here, deliberately: `enrichPlayer`'s creation-only guard
 * (NEO-203, pinned by convex/enrichmentCreationOnly.test.ts) means an
 * automatic lookup never fires for a player carrying career teams, a
 * Hall-of-Fame answer, or a Wikidata id — which is every player this function
 * has touched. The only path that still reaches `applyEnrichmentInternal` for
 * an edited row is `enrichFromWikidata`, the admin's own explicit "look this
 * up again", whose entire purpose is to replace the stored answer. Overwriting
 * on that path is the request, not a bug.
 *
 * ## Field semantics
 *
 * Omitting a field leaves it alone. `wikidataId: null` clears it — the same
 * optional-and-clearable shape `saveTeamFields` uses, and for the same reason:
 * "" and "unset" are different states, and only one of them is a valid QID.
 *
 * `name` changes rewrite `nameNormalized` too, or the row becomes invisible to
 * every `by_name_normalized` lookup that resolves checklist names back onto it
 * — silently, and only discovered later as a duplicate player.
 *
 * `createdByUserId` is never touched. It is an audit field; an edit is not a
 * re-creation and rewriting it would erase who actually introduced the row.
 */
export const savePlayerFields = mutation({
  args: {
    id: v.id("players"),
    name: v.optional(v.string()),
    isHallOfFame: v.optional(v.boolean()),
    /** `null` clears `externalIds.wikidataId`; a string must be a `Q<digits>` id. */
    wikidataId: v.optional(v.union(v.string(), v.null())),
    /**
     * The player's whole career history, replaced wholesale. An empty array is
     * a legitimate value and clears it — "this player has no recorded stints"
     * is a real answer, distinct from "nobody has said".
     */
    teamYears: v.optional(
      v.array(
        v.object({
          teamId: v.id("teams"),
          fromYear: v.number(),
          toYear: v.optional(v.number()),
        }),
      ),
    ),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);

    const existing = await ctx.db.get(args.id);
    if (!existing) throw new ConvexError("Player not found");

    const patch: {
      name?: string;
      nameNormalized?: string;
      isHallOfFame?: boolean;
      externalIds?: { wikidataId?: string };
      teamYears?: PlayerTeamYear[];
      lastUpdated: number;
    } = { lastUpdated: Date.now() };

    if (args.name !== undefined) {
      const trimmed = args.name.trim();
      if (trimmed.length === 0) {
        throw new ConvexError("A player name is required.");
      }
      if (trimmed.length > MAX_PLAYER_NAME_LENGTH) {
        throw new ConvexError(
          `A player name is ${trimmed.length} characters; the limit is ${MAX_PLAYER_NAME_LENGTH}.`,
        );
      }
      const nameNormalized = normalizePlayerName(trimmed);

      // A rename onto an existing (normalized name, sport) key would create the
      // exact duplicate the whole normalization scheme exists to prevent, and
      // the two rows could then never be told apart by any lookup. Refuse, and
      // hand the page the OTHER row's id so it can offer "go to that player"
      // instead of leaving the operator to search for it.
      //
      // The message carries an id and the name the operator just typed —
      // nothing else. No PII beyond what they supplied, and specifically not
      // the other row's `createdByUserId`.
      const collision = await ctx.db
        .query("players")
        .withIndex("by_name_normalized_and_sport_id", (q) =>
          q.eq("nameNormalized", nameNormalized).eq("sportId", existing.sportId),
        )
        .first();
      if (collision && collision._id !== args.id) {
        throw new ConvexError(`NAME_TAKEN:${collision._id}`);
      }

      patch.name = trimmed;
      patch.nameNormalized = nameNormalized;
    }

    if (args.isHallOfFame !== undefined) {
      patch.isHallOfFame = args.isHallOfFame;
    }

    if (args.wikidataId !== undefined) {
      const rest: { wikidataId?: string } = { ...(existing.externalIds ?? {}) };
      if (args.wikidataId === null) {
        delete rest.wikidataId;
      } else {
        const qid = args.wikidataId.trim();
        // Validated at the write, not just in the UI. A malformed id is worse
        // than a missing one: `enrichPlayer` treats ANY stored `wikidataId` as
        // "already enriched" and skips the row forever, so a typo here silently
        // opts a player out of enrichment.
        if (!WIKIDATA_QID.test(qid)) {
          throw new ConvexError(`Not a Wikidata entity id: ${qid}`);
        }
        rest.wikidataId = qid;
      }
      // Drop the container entirely once it holds nothing, so a cleared row is
      // indistinguishable from one that never had an id.
      patch.externalIds = Object.keys(rest).length > 0 ? rest : undefined;
    }

    if (args.teamYears !== undefined) {
      // The upper bound is next year, not this one: a card printed in the
      // autumn routinely carries the following season, and refusing that would
      // make the editor wrong every winter.
      const maxYear = new Date().getFullYear() + 1;
      const seen = new Set<string>();

      for (const stint of args.teamYears) {
        const team = await ctx.db.get(stint.teamId);
        if (!team) {
          throw new ConvexError("A career stint points at a team that no longer exists.");
        }
        // A cross-sport stint is not a harmless oddity: `teams.list` and every
        // picker scope by sport, so the stint would render as a dangling id the
        // operator cannot see, let alone fix.
        if (team.sportId !== existing.sportId) {
          throw new ConvexError(
            `A career stint names a team from another sport: ${team.name}.`,
          );
        }

        if (!Number.isInteger(stint.fromYear) || stint.fromYear < MIN_CAREER_YEAR || stint.fromYear > maxYear) {
          throw new ConvexError(
            `A career start year must be a whole year between ${MIN_CAREER_YEAR} and ${maxYear}.`,
          );
        }
        if (stint.toYear !== undefined) {
          if (!Number.isInteger(stint.toYear) || stint.toYear < MIN_CAREER_YEAR || stint.toYear > maxYear) {
            throw new ConvexError(
              `A career end year must be a whole year between ${MIN_CAREER_YEAR} and ${maxYear}.`,
            );
          }
          if (stint.toYear < stint.fromYear) {
            throw new ConvexError("A career stint cannot end before it starts.");
          }
        }

        // Duplicate detection is on (teamId, fromYear), NOT on teamId: two
        // stints at one franchise are real history — traded away, re-signed
        // later — and collapsing them is data loss. Only a literal repeat of
        // the same stint is refused. See `sortTeamYears`.
        const key = `${stint.teamId}:${stint.fromYear}`;
        if (seen.has(key)) {
          throw new ConvexError(
            `${team.name} is listed twice starting in ${stint.fromYear}.`,
          );
        }
        seen.add(key);
      }

      patch.teamYears = sortTeamYears(args.teamYears);
    }

    await ctx.db.patch(args.id, patch);
    return null;
  },
});
