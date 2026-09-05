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
// NEO-212 security review: `Q<digits>` is validated in exactly one place now.
// See lib/players/wikidata-id.ts for why the render sites needed a chokepoint
// they could share with the write path.
import { isWikidataQid } from "../lib/players/wikidata-id";

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
 * Bound on an operator-typed player name — same value and same reasoning as
 * `teams.MAX_TEAM_NAME_LENGTH`. Over-length is refused rather than trimmed:
 * silently storing something other than what was typed is how a mangled name
 * becomes canonical for every listing title and spine label downstream.
 */
const MAX_PLAYER_NAME_LENGTH = 120;

/**
 * Create-if-missing player by name + sport. Idempotent — calling twice
 * with the same inputs returns the same id.
 *
 * NEO-220 corrected a stale claim here: this is NOT what the checklist
 * commit path calls. `commitCardChecklistFinalize` inserts into `players`
 * directly (see the player loop in `selectorOptions.ts`), already enriched.
 * The ONLY caller of this mutation is `SetSelector/PlayerPicker`'s "+ Create"
 * row, reached from the card drawer, the attention walker's
 * `UnreviewedNameFixer`, and the checklist quick-add form — every one of them
 * under `/admin/set-builder`.
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
    /**
     * NEO-208 left this at signed-in while raising its `teams.findOrCreate`
     * twin to admin, on the reasoning that this one scheduled no enrichment
     * and so gained no cost vector. NEO-220 gives it that enrichment (below),
     * which retires the reasoning along with the asymmetry.
     *
     * `requireAdmin`, for the two reasons the teams twin already carries:
     * sign-up is open, so "signed in" is not a meaningful bound on who may
     * create globally-shared rows; and the insert branch now enqueues pooled
     * Wikidata work whose CONCURRENCY — not total volume — `wikidataPool`
     * bounds. Nothing legitimate loses access: every caller is
     * `SetSelector/PlayerPicker`, mounted only under `/admin/set-builder`,
     * whose sibling mutations (`addCustomCard`, `updateCard`) are already
     * `requireAdmin` — a non-admin who reached this could create a player but
     * could not attach it to anything.
     */
    const userId = await requireAdmin(ctx);

    const name = args.name.trim();
    if (name.length === 0) {
      throw new ConvexError("A player name is required.");
    }
    if (name.length > MAX_PLAYER_NAME_LENGTH) {
      // The LENGTH, never the name: this string reaches Sentry and the browser
      // console through Convex's error path. Same bound and same reasoning as
      // `createByAdmin` below and `teams.findOrCreate`; over-length is refused
      // rather than trimmed, because silently storing something other than
      // what was typed is how a mangled name becomes canonical.
      throw new ConvexError(
        `A player name is ${name.length} characters; the limit is ${MAX_PLAYER_NAME_LENGTH}.`,
      );
    }

    // `sportId` is a bare `v.id("selectorOptions")` — the validator proves it
    // is an id in that table, not that it points at a SPORT. A player hung off
    // a variantType row is unreachable by `list`, `search` and
    // `findByNameAndSport`, all of which key on the sport row id, so it would
    // be an orphan. Same check `createByAdmin` and `teams.findOrCreate` make.
    const sportRow = await ctx.db.get(args.sportId);
    if (!sportRow || sportRow.level !== "sport") {
      throw new ConvexError("A player must be created under a sport.");
    }

    const normalized = normalizePlayerName(name);
    const matches = await ctx.db
      .query("players")
      .withIndex("by_name_normalized", (q) => q.eq("nameNormalized", normalized))
      .collect();
    const existing = matches.find((p) => p.sportId === args.sportId);
    // NOT enqueued — see the creation-only note on the insert below.
    if (existing) return existing._id;

    const id = await ctx.db.insert("players", {
      name,
      nameNormalized: normalized,
      sportId: args.sportId,
      createdByUserId: userId,
      lastUpdated: Date.now(),
    });

    // An audit trail for a shared-row creation an operator triggers from a
    // typeahead. Structured JSON, not concatenation — the name is operator
    // input and must not be able to shape a log line.
    console.log(
      JSON.stringify({ msg: "player_created", playerId: id, sportId: args.sportId, userId }),
    );

    /**
     * NEO-220 — enrich the player we just INSERTED, and only that.
     *
     * This was the last player-creation path in the product with no enrichment
     * at all, and the quick-add form is what made that matter: a player born
     * from this picker stayed BARE forever — no career teams, no Hall of Fame
     * flag, no Wikidata id — because enrichment fires only at creation and an
     * explicit admin force is the sole re-enrich path. Every other route
     * already covers itself: the review wizard enriches before its insert
     * (`processEntityReviewQueue` → `lookupPlayerEnrichment`), the commit
     * prelude inserts already-enriched rows, and `createByAdmin` enqueues.
     * Reusing that same enqueue verbatim rather than inventing another.
     *
     * The early `return existing._id` above is what makes this honour
     * `enqueueEnrichment`'s CREATION-ONLY contract (see the contract note in
     * `wikidataPool.ts`): a player this mutation FOUND leaves without being
     * enqueued. Jason, 2026-09-02: "if the player is already known we should
     * not try to look up the data again."
     *
     * No `force` — that flag belongs to `enrichFromWikidata`, the human "this
     * answer is wrong, look again" remedy. Automatic callers never set it.
     * Scheduled rather than awaited inline because enrichment is a network
     * round-trip and this is a mutation.
     */
    await ctx.scheduler.runAfter(0, internal.wikidataPool.enqueueEnrichment, {
      playerIds: [id],
    });

    return id;
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

/**
 * How many search-index rows feed the ranker, and how many rank out by default.
 *
 * NEO-212 security review: the `limit` argument is FLOORED as well as capped —
 * `Math.max(1, Math.min(...))`. `Math.min` alone left `limit: 0` (an empty
 * result that reads as "no near matches", i.e. "safe to create") and
 * `limit: -1` (`.slice(0, -1)` drops the LAST candidate, silently hiding one)
 * both reachable from the client. Neither is a data leak; both turn this
 * query's only job — warning before a duplicate write — into a warning that
 * quietly does not fire.
 */
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
    // NEO-212 security review: the same bound `createByAdmin` and
    // `savePlayerFields` put on a stored name, applied to the SEARCH TERM too.
    // An unbounded term is fed straight to a search index and to
    // `rankPlayerCandidates`'s per-token work; nothing that could ever match a
    // stored row is longer than a storable name, so refusing costs nothing
    // real. Refused rather than truncated, matching the write paths.
    if (name.length > MAX_PLAYER_NAME_LENGTH) {
      throw new ConvexError(
        `A player name is ${name.length} characters; the limit is ${MAX_PLAYER_NAME_LENGTH}.`,
      );
    }

    // Floored as well as capped — see NEAR_MATCH_DEFAULT_LIMIT above for what
    // `limit: 0` and `limit: -1` did without the `Math.max`.
    const limit = Math.max(
      1,
      Math.min(args.limit ?? NEAR_MATCH_DEFAULT_LIMIT, NEAR_MATCH_MAX_LIMIT),
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
 * NEO-235 — `get`, for an id that came out of a URL rather than out of a query.
 *
 * `/admin/players?player=<id>` puts a player id in a place anybody can retype,
 * and `get` above takes `v.id("players")`. An id argument that does not parse
 * is an ARGUMENT VALIDATION failure, which Convex raises before the handler
 * runs and the client surfaces as a thrown query — on a `useQuery` that means
 * the render throws and the screen is replaced by the app-level error boundary.
 * A hand-mangled query string is not a broken application, so it must not look
 * like one.
 *
 * Fixed on the SERVER rather than by validating the string in the browser,
 * because the browser cannot actually tell: a Convex id's shape is not a
 * documented format to regex against, and `normalizeId` is the only honest
 * check — it is also the one that knows the id names THIS table. A client-side
 * guess would have to be either loose (and still throw) or tight (and reject
 * ids that are fine).
 *
 * Same gate and same public shape as `get`, so the two cannot drift: the only
 * difference is that an unparseable or wrong-table id is answered `null`, the
 * same answer a well-formed id for a deleted row already got. The screen has
 * one "no such player" branch and this keeps it that way.
 *
 * `get` stays rather than being replaced by this. The two are not
 * interchangeable and the difference is the type check: a caller that already
 * holds a real `Id<"players">` — one that came out of another query, in this
 * backend's other clients as much as this one — should be made to prove it at
 * the boundary, and be told loudly if it cannot. This looser door is for the
 * one caller that genuinely holds a string a human could have typed.
 */
export const getByIdParam = query({
  args: { id: v.string() },
  returns: v.union(playerDocPublicValidator, v.null()),
  handler: async (ctx, args) => {
    await requireSignedIn(ctx);
    const id = ctx.db.normalizeId("players", args.id);
    if (id === null) return null;
    const doc = await ctx.db.get(id);
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
 *    lets an operator hand-edit location / yearsActive / colors, so a blind write
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
    // NEO-212 security review: an id that is not `Q<digits>` is DROPPED, not
    // stored. The value here originates at query.wikidata.org, so it is
    // external input arriving on a path with no operator in it, and a stored
    // id is later interpolated into an outbound link. Dropping is the right
    // failure: `enrichPlayer` treats any stored `wikidataId` as "already
    // enriched" and skips the row forever, so persisting a malformed one would
    // permanently opt the player out of enrichment — worse than having none.
    if (args.wikidataId !== undefined && isWikidataQid(args.wikidataId)) {
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
 * Earliest plausible career year. Baseball's first professional league (the
 * National Association) formed in 1871; 1850 leaves room for the pre-league
 * amateur era without admitting an obvious typo like `195` or `19999`.
 */
const MIN_CAREER_YEAR = 1850;

/**
 * NEO-212 security review: upper bound on how many career stints one
 * `savePlayerFields` call may write to a single player row.
 *
 * The same guard rail, for the same reason, as
 * `MAX_MANUAL_CAREER_TEAMS` / `MAX_EXCLUDED_CAREER_TEAM_NAMES` in
 * `convex/entityReviewQueue.ts` — and it was the gap those two left. That path
 * capped the wizard's route into `players.teamYears`; this editor is the OTHER
 * route into the same field and had no bound at all, so an unbounded array
 * reached the row through a per-stint validation loop that does a `ctx.db.get`
 * PER ENTRY. Ten thousand stints is ten thousand reads inside one mutation.
 *
 * Not a confidentiality boundary — this path is admin-gated — but admin-gated
 * is not the same as "cannot be driven by a compromised session or a UI bug",
 * and an unbounded write into a globally-shared reference row is worth
 * refusing on its own. A real career spans a handful of stints; 64 is generous
 * headroom and matches the wizard's number so the two routes agree.
 *
 * The refusal carries the COUNT, never the names: the message reaches Sentry
 * and the browser console through Convex's error path, and the names are
 * operator input. Same rule as `teams.resolveNames`'s over-length refusal.
 */
const MAX_PLAYER_TEAM_YEARS = 64;

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
 * NEO-220 REDREW the line this used to sit on. The old reasoning was that
 * `findOrCreate` was the SIGNED-IN reconciler and scheduled no enrichment,
 * while this one was admin-only and did — so they could not be one function
 * with a flag. Both halves are gone: `findOrCreate` is `requireAdmin` now and
 * enqueues on its own insert branch, and it was never what the commit path
 * calls (that inserts directly, already enriched).
 *
 * They stay separate for what is left, which is the RETURN CONTRACT. This one
 * answers `{ id, created }`, because the Player Management form has to say
 * "already here" and jump to the existing row rather than claim a creation;
 * `findOrCreate` answers a bare id, because a typeahead chip does not care
 * which branch produced it. Merging them would make every picker call site
 * destructure an answer it has no use for.
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
        if (!isWikidataQid(qid)) {
          // The raw argument rather than `qid`: `isWikidataQid` is a type
          // guard, so inside this branch `qid` has narrowed to `never` and
          // cannot be interpolated. The operator recognises what they typed
          // more readily than its trimmed form in any case.
          throw new ConvexError(`Not a Wikidata entity id: ${args.wikidataId}`);
        }
        rest.wikidataId = qid;
      }
      // Drop the container entirely once it holds nothing, so a cleared row is
      // indistinguishable from one that never had an id.
      patch.externalIds = Object.keys(rest).length > 0 ? rest : undefined;
    }

    if (args.teamYears !== undefined) {
      // Bounded BEFORE the loop below, which does one `ctx.db.get` per entry.
      // Checking inside it would still have performed the reads.
      if (args.teamYears.length > MAX_PLAYER_TEAM_YEARS) {
        throw new ConvexError(
          `A player has ${args.teamYears.length} career stints; the limit is ${MAX_PLAYER_TEAM_YEARS}.`,
        );
      }

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
