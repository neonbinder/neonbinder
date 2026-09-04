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

import { ConvexError, v } from "convex/values";
import {
  action,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { getCurrentUserId, requireAdmin } from "./auth";
import { sportConfigDefaultsFor } from "./sportConfig";
import { rankTeamCandidates } from "./lib/entityNearMatch";
// NEO-240: the shared `Q<digits>` chokepoint — see lib/players/wikidata-id.ts.
// Leagues store a QID for the same reason players and teams do, so they
// validate it in the same one place rather than growing a fourth regex.
import { isWikidataQid } from "../lib/players/wikidata-id";

/**
 * NEO-240 — where a league sits in the professional pyramid.
 *
 * Exported as a value, not just a type, because three things have to agree on
 * the same list and its order: the schema's `v.union`, this module's sort, and
 * the admin page's dropdown. See `schema.ts` for why the field exists at all.
 */
export const LEAGUE_LEVELS = [
  "major",
  "minor",
  "college",
  "international",
  "independent",
  "other",
] as const;

export type LeagueLevel = (typeof LEAGUE_LEVELS)[number];

const leagueLevelValidator = v.union(
  v.literal("major"),
  v.literal("minor"),
  v.literal("college"),
  v.literal("international"),
  v.literal("independent"),
  v.literal("other"),
);

const leagueYearsActiveValidator = v.object({
  from: v.number(),
  to: v.optional(v.number()),
});

/**
 * The public shape of a league row.
 *
 * STRICT: Convex validates a returns validator against the actual document, so
 * a field added to the `leagues` table without being added here makes
 * `leagues.list` throw — for Team Management and the spine-label designer,
 * not just for the admin page. That is why NEO-240's schema change and this
 * validator are the same edit.
 */
export const leagueDocValidator = v.object({
  _id: v.id("leagues"),
  _creationTime: v.number(),
  name: v.string(),
  abbreviation: v.optional(v.string()),
  nameNormalized: v.string(),
  sportId: v.id("selectorOptions"),
  level: v.optional(leagueLevelValidator),
  yearsActive: v.optional(leagueYearsActiveValidator),
  externalIds: v.optional(v.object({ wikidataId: v.optional(v.string()) })),
  aliases: v.optional(v.array(v.string())),
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
 * NEO-240 — does this row answer to `nameNormalized`?
 *
 * Two legs, and the alias leg is the whole point: "MLB", "American League" and
 * "Major League Baseball" are one league in this hobby's usage, so a writer
 * that only compared `nameNormalized` minted a second row the first time
 * anybody typed a short form. Aliases are normalised at COMPARISON time rather
 * than stored pre-normalised, so the stored list stays the operator's own
 * spelling (it is what the admin page shows back to them).
 */
function leagueAnswersTo(row: Doc<"leagues">, nameNormalized: string): boolean {
  if (!nameNormalized) return false;
  if (row.nameNormalized === nameNormalized) return true;
  return (row.aliases ?? []).some(
    (alias) => normalizeLeagueName(alias) === nameNormalized,
  );
}

/**
 * NEO-240 — the league in this sport that answers to `name`, or null.
 *
 * The alias leg cannot be an index read: an alias lives inside an array on the
 * row, and Convex indexes fields, not array members. So the sport's rows are
 * scanned in memory. That is affordable because leagues are a SMALL per-sport
 * set — tens of rows even once MiLB arrives through Wikidata career teams —
 * and the scan is bounded by `by_sport_id` rather than being a table scan.
 *
 * The exact-key index read runs FIRST as a fast path: the overwhelmingly
 * common case is a writer re-resolving the canonical name, and that costs one
 * indexed read instead of a collect.
 */
export async function findLeagueByName(
  ctx: QueryCtx,
  args: { name: string; sportId: Id<"selectorOptions"> },
): Promise<Doc<"leagues"> | null> {
  const nameNormalized = normalizeLeagueName(args.name.trim());
  if (!nameNormalized) return null;

  const exact = await ctx.db
    .query("leagues")
    .withIndex("by_name_normalized_and_sport_id", (q) =>
      q.eq("nameNormalized", nameNormalized).eq("sportId", args.sportId),
    )
    .first();
  if (exact) return exact;

  const rows = await ctx.db
    .query("leagues")
    .withIndex("by_sport_id", (q) => q.eq("sportId", args.sportId))
    .collect();
  return rows.find((row) => leagueAnswersTo(row, nameNormalized)) ?? null;
}

/**
 * NEO-240 — creation-only enrichment hook for a league row.
 *
 * A NO-OP STUB TODAY, deliberately. It exists so the ONE insert site in this
 * module already has the call in the right place, on the right branch: the
 * insert branch of `findOrCreateLeague` and nowhere else, which is what makes
 * enrichment creation-only by construction rather than by every caller
 * remembering (Jason, 2026-09-02: "if the player is already known we should
 * not try to look up the data again" — the same rule, for leagues).
 *
 * NEO-240 WP1 replaces the body with:
 *
 *   await ctx.scheduler.runAfter(0, internal.wikidataPool.enqueueEnrichment, {
 *     leagueIds: [id],
 *   });
 *
 * No `force`: that flag belongs to `enrichFromWikidata`, the human "this answer
 * is wrong, look again" remedy. Automatic callers never set it — see the
 * contract on `wikidataPool.enqueueEnrichment`.
 */
async function scheduleLeagueEnrichment(
  ctx: MutationCtx,
  id: Id<"leagues">,
): Promise<void> {
  // Referenced so the signature cannot drift out of shape while the body is
  // empty; WP1 replaces this body only.
  void ctx;
  void id;
}

/**
 * Find-or-create a league for (sport, name). Shared by every writer so the
 * dedup key is applied identically everywhere.
 *
 * NEO-240: the key is now name-OR-ALIAS within the sport, not `nameNormalized`
 * alone — see `leagueAnswersTo`. A caller passing "MLB" gets the Major League
 * Baseball row back rather than creating a second one.
 *
 * Not a Convex function — a plain helper taking a mutation ctx, because its
 * callers are already inside mutations and a mutation cannot call another
 * mutation.
 */
export async function findOrCreateLeague(
  ctx: MutationCtx,
  args: {
    name: string;
    abbreviation?: string;
    sportId: Id<"selectorOptions">;
    level?: LeagueLevel;
    aliases?: string[];
  },
): Promise<Id<"leagues">> {
  const name = args.name.trim();
  const nameNormalized = normalizeLeagueName(name);

  const existing = await findLeagueByName(ctx, {
    name,
    sportId: args.sportId,
  });

  if (existing) {
    // Fill in facts a later caller knows and the first did not, rather than
    // creating a second row for the same league. GAP-FILL ONLY: a value
    // already on the row outranks whatever this caller guessed, exactly as in
    // `teams.applyEnrichmentInternal` (NEO-203). Aliases are deliberately NOT
    // merged here — silently widening what an existing row answers to is an
    // operator decision, and `saveLeagueFields` is where it is made.
    const patch: { abbreviation?: string; level?: LeagueLevel; lastUpdated: number } = {
      lastUpdated: Date.now(),
    };
    let changed = false;
    if (args.abbreviation && !existing.abbreviation) {
      patch.abbreviation = args.abbreviation;
      changed = true;
    }
    if (args.level && !existing.level) {
      patch.level = args.level;
      changed = true;
    }
    if (changed) await ctx.db.patch(existing._id, patch);
    return existing._id;
  }

  const id = await ctx.db.insert("leagues", {
    name,
    abbreviation: args.abbreviation,
    nameNormalized,
    sportId: args.sportId,
    ...(args.level ? { level: args.level } : {}),
    ...(args.aliases && args.aliases.length > 0 ? { aliases: args.aliases } : {}),
    lastUpdated: Date.now(),
  });

  // CREATION ONLY. The `return existing._id` above is what makes that true:
  // a league this helper FOUND leaves without being enqueued.
  await scheduleLeagueEnrichment(ctx, id);

  return id;
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

  return await findOrCreateLeague(ctx, {
    name,
    abbreviation,
    sportId,
    // NEO-240: the sport's CONFIGURED league is by definition its top flight —
    // `sportConfig.league` is "MLB"/"NFL"/"NBA", never a farm system — so this
    // is the one place a level can be asserted without an operator saying so.
    level: "major",
    // …and the one place an alias can be. Seeding the abbreviation as an alias
    // is what makes "MLB" typed ANYWHERE — the admin quick-add, a legacy
    // `teams.league` string, a Wikidata P118 label — resolve onto Major League
    // Baseball instead of minting a second row spelled the short way. Only
    // when there IS an abbreviation, and only when it is not already the name
    // (a sport whose config has no `espn.leagueName` names the row after its
    // abbreviation, and an alias equal to the name is redundant).
    ...(abbreviation && normalizeLeagueName(abbreviation) !== normalizeLeagueName(name)
      ? { aliases: [abbreviation] }
      : {}),
  });
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * Leagues for a sport, or all of them. Drives Team Management's league filter
 * and edit dropdown, and the spine-label designer's team picker.
 *
 * Signed-in rather than admin: NEO-156 gave the designer a league filter, and
 * that is a collector-facing screen. Leagues are globally-shared reference
 * data — a name and an abbreviation, no user content — so the only thing worth
 * gating is cost, and a signed-in check covers that. Returns empty rather than
 * throwing so a signed-out render is a quiet no-op.
 */
export const list = query({
  args: { sportId: v.optional(v.id("selectorOptions")) },
  returns: v.array(leagueDocValidator),
  handler: async (ctx, args) => {
    if (!(await getCurrentUserId(ctx))) return [];
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


// ===========================================================================
// NEO-240 — League Management (/admin/leagues)
//
// The surface below backs the admin Leagues page, a mirror of /admin/players
// and /admin/teams, and it follows their conventions rather than inventing new
// ones: `requireAdmin` on every function, `ConvexError` for anything the
// operator has to read (Convex replaces a bare `Error`'s message with "Server
// Error" in a deployed backend, and `NAME_TAKEN:<id>` below is load-bearing UI
// data — the page turns it into a link to the colliding league), lengths
// REFUSED rather than truncated, and optional-and-clearable field semantics.
//
// `list` and `create` above are deliberately left alone. Team Management and
// the spine-label designer call them, `list` is signed-in rather than admin on
// purpose, and widening either one to serve this page would have dragged that
// decision along with it.
// ===========================================================================

/**
 * Bound on an operator-typed league name — the same value and the same
 * reasoning as `players.MAX_PLAYER_NAME_LENGTH` / `teams.MAX_TEAM_NAME_LENGTH`.
 * Over-length is refused rather than trimmed: silently storing something other
 * than what was typed is how a mangled name becomes canonical everywhere
 * downstream.
 */
const MAX_LEAGUE_NAME_LENGTH = 120;

/**
 * Bound on an abbreviation. Short on purpose: the field exists for dense UI
 * ("MLB" beside a team name), and anything approaching a sentence is a name
 * that was pasted into the wrong box.
 */
const MAX_LEAGUE_ABBREVIATION_LENGTH = 16;

/**
 * Bounds on the alias list.
 *
 * Same guard-rail reasoning as `players.MAX_PLAYER_TEAM_YEARS`: admin-gated is
 * not the same as "cannot be driven by a compromised session or a UI bug", and
 * this array is read on EVERY `findOrCreateLeague` — which a checklist commit
 * calls once per team it touches. An unbounded list would turn each of those
 * into an unbounded string comparison loop. A real league answers to a handful
 * of names; 32 is generous headroom.
 */
const MAX_LEAGUE_ALIASES = 32;
const MAX_LEAGUE_ALIAS_LENGTH = 64;

/**
 * Earliest plausible league year — the same floor as
 * `players.MIN_CAREER_YEAR`, for the same reason. The National Association
 * formed in 1871; 1850 leaves room for the amateur era without admitting an
 * obvious typo like `195` or `19999`.
 */
const MIN_LEAGUE_YEAR = 1850;

/** How many near matches the "did you mean?" prompt shows. */
const LEAGUE_NEAR_MATCH_LIMIT = 5;

/**
 * Sort order for `listForManagement`: the professional pyramid, top down, with
 * UNSET LAST.
 *
 * Unset is last rather than first because an unclassified league is the row
 * the operator still has work to do on, and no backfill was run (NEO-240), so
 * on day one that is most of them. Putting them on top would bury every league
 * that is already correct under the queue of ones that are not.
 */
const LEAGUE_LEVEL_ORDER: Record<LeagueLevel, number> = {
  major: 0,
  minor: 1,
  college: 2,
  international: 3,
  independent: 4,
  other: 5,
};

function leagueLevelRank(level: LeagueLevel | undefined): number {
  return level === undefined ? LEAGUE_LEVELS.length : LEAGUE_LEVEL_ORDER[level];
}

/**
 * Trim, drop empties, drop anything that is just the row's own name, and
 * dedupe on the NORMALISED form (so "MLB", "mlb" and "M.L.B." are one entry,
 * and the first spelling the operator typed is the one kept).
 *
 * Bounds are checked on the RAW input, before this collapses it: refusing 200
 * aliases only after deduping them to 3 would accept a payload this exists to
 * refuse, and the operator's own count is the number worth reporting back.
 */
function normalizeAliasList(raw: string[], ownName: string): string[] {
  if (raw.length > MAX_LEAGUE_ALIASES) {
    // The COUNT, never the values: this string reaches Sentry and the browser
    // console through Convex's error path, and the values are operator input.
    throw new ConvexError(
      `A league has ${raw.length} aliases; the limit is ${MAX_LEAGUE_ALIASES}.`,
    );
  }

  const ownNormalized = normalizeLeagueName(ownName);
  const seen = new Set<string>();
  const out: string[] = [];

  for (const entry of raw) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    if (trimmed.length > MAX_LEAGUE_ALIAS_LENGTH) {
      throw new ConvexError(
        `An alias is ${trimmed.length} characters; the limit is ${MAX_LEAGUE_ALIAS_LENGTH}.`,
      );
    }
    const normalized = normalizeLeagueName(trimmed);
    // A name with nothing left after normalisation ("---") can never match
    // anything, so storing it would only be noise in the editor.
    if (!normalized) continue;
    // Dropped SILENTLY rather than refused: an operator typing the league's
    // own name into the alias box has expressed a redundancy, not an error,
    // and the row already answers to it.
    if (normalized === ownNormalized) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(trimmed);
  }

  return out;
}

/** Whole years, in range, and ending no earlier than they start. */
function validateLeagueYears(years: { from: number; to?: number }): void {
  // The upper bound is NEXT year, not this one: a league announced for the
  // coming season is a real row, and refusing it would make the editor wrong
  // every winter. Same rule as `players.savePlayerFields`.
  const maxYear = new Date().getFullYear() + 1;
  if (
    !Number.isInteger(years.from) ||
    years.from < MIN_LEAGUE_YEAR ||
    years.from > maxYear
  ) {
    throw new ConvexError(
      `A league start year must be a whole year between ${MIN_LEAGUE_YEAR} and ${maxYear}.`,
    );
  }
  if (years.to !== undefined) {
    if (
      !Number.isInteger(years.to) ||
      years.to < MIN_LEAGUE_YEAR ||
      years.to > maxYear
    ) {
      throw new ConvexError(
        `A league end year must be a whole year between ${MIN_LEAGUE_YEAR} and ${maxYear}.`,
      );
    }
    if (years.to < years.from) {
      throw new ConvexError("A league cannot end before it starts.");
    }
  }
}

/** Refuse an empty or over-long operator-typed league name. */
function requireValidLeagueName(raw: string): string {
  const name = raw.trim();
  if (name.length === 0) {
    throw new ConvexError("A league name is required.");
  }
  if (name.length > MAX_LEAGUE_NAME_LENGTH) {
    // The LENGTH, never the name.
    throw new ConvexError(
      `A league name is ${name.length} characters; the limit is ${MAX_LEAGUE_NAME_LENGTH}.`,
    );
  }
  return name;
}

/**
 * NEO-240: the whole league list, for League Management.
 *
 * `.collect()` rather than the capped `.take()` its `players` / `teams`
 * counterparts use, because leagues are a genuinely small set — one row per
 * league per sport, tens of them even once MiLB arrives through Wikidata
 * career teams, against 500 players and 2000 teams. `truncated` is returned
 * anyway, always `false`, so the page renders the same "showing all N" affordance
 * as its two siblings and gains a cap later without a client change.
 *
 * Sorted server-side by (level, name) rather than left to the client: the level
 * ORDER is a property of the taxonomy — see `LEAGUE_LEVEL_ORDER` — and a client
 * sorting the level strings alphabetically would silently produce
 * "college, independent, international, major, minor", which reads as an
 * ordering and is not one.
 */
export const listForManagement = query({
  args: { sportId: v.optional(v.id("selectorOptions")) },
  returns: v.object({
    leagues: v.array(leagueDocValidator),
    totalCount: v.number(),
    truncated: v.boolean(),
  }),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);

    const rows = args.sportId
      ? await ctx.db
          .query("leagues")
          .withIndex("by_sport_id", (q) => q.eq("sportId", args.sportId!))
          .collect()
      : await ctx.db.query("leagues").collect();

    rows.sort((a, b) => {
      const byLevel = leagueLevelRank(a.level) - leagueLevelRank(b.level);
      if (byLevel !== 0) return byLevel;
      return a.name.localeCompare(b.name);
    });

    return { leagues: rows, totalCount: rows.length, truncated: false };
  },
});

/**
 * NEO-240: `get`, for an id that came out of a URL rather than out of a query.
 *
 * The exact twin of `players.getByIdParam` (NEO-235), and it exists for the
 * same reason: `/admin/leagues?league=<id>` puts an id somewhere anybody can
 * retype, and a `v.id("leagues")` argument that does not parse is an ARGUMENT
 * VALIDATION failure — raised before the handler runs, surfaced on a `useQuery`
 * as a thrown render, and answered by the app-level error boundary. A
 * hand-mangled query string is not a broken application.
 *
 * `normalizeId` is the honest check and the only one that knows the id names
 * THIS table, so it happens on the server. An unparseable or wrong-table id
 * gets `null` — the same answer a well-formed id for a deleted row already
 * got, which keeps the page to one "no such league" branch.
 *
 * Admin, unlike its `players` twin: this is the League Management deep link,
 * and the collector-facing read of leagues is `list` above.
 */
export const getByIdParam = query({
  args: { id: v.string() },
  returns: v.union(leagueDocValidator, v.null()),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const id = ctx.db.normalizeId("leagues", args.id);
    if (id === null) return null;
    return await ctx.db.get(id);
  },
});

/**
 * NEO-240: the "did you mean?" prompt in front of creating a league — the twin
 * of `players.nearMatches` / `teams.nearMatches`.
 *
 * No search index, unlike those two, and none is wanted: the whole per-sport
 * set is tens of rows, so the ranker sees EVERY candidate rather than the ten
 * a BM25 ranking happened to surface. That removes this function's version of
 * the failure the search-backed twins have to work around with a second
 * fallback query.
 *
 * Aliases are candidate strings in their own right, so typing "American
 * League" finds the Major League Baseball row it is an alias of — and the
 * result names the row's CANONICAL name, because that is the row the operator
 * would be reusing.
 *
 * `exact` is `normalizeLeagueName` equality against the name or any alias —
 * the same key `findOrCreateLeague` writes, so an exact hit here is a row that
 * helper would have returned anyway. `close` is whatever `rankTeamCandidates`
 * ranks (containment either way, plus shared significant tokens). Note that
 * ranker's own `exact` verdict is deliberately NOT trusted for this
 * function's `exact`: it normalises with a TOKEN SORT, which would call
 * "National League" and "League National" the same league, and
 * `normalizeLeagueName` exists precisely because they are not.
 *
 * Advisory only. Every result is a prompt for a human decision and nothing
 * here may be used to merge or skip automatically.
 */
export const nearMatches = query({
  args: {
    name: v.string(),
    sportId: v.id("selectorOptions"),
  },
  returns: v.array(
    v.object({
      _id: v.id("leagues"),
      name: v.string(),
      confidence: v.union(v.literal("exact"), v.literal("close")),
    }),
  ),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);

    const name = args.name.trim();
    if (!name) return [];
    // The same bound the write paths put on a STORED name, applied to the
    // search term: nothing that could ever match a stored row is longer than a
    // storable name, so refusing costs nothing real. Refused rather than
    // truncated, matching `createByAdmin` and `saveLeagueFields`.
    if (name.length > MAX_LEAGUE_NAME_LENGTH) {
      throw new ConvexError(
        `A league name is ${name.length} characters; the limit is ${MAX_LEAGUE_NAME_LENGTH}.`,
      );
    }

    const rows = await ctx.db
      .query("leagues")
      .withIndex("by_sport_id", (q) => q.eq("sportId", args.sportId))
      .collect();

    // Keyed by row id, so a row matched through both its name and an alias
    // collapses to one result. Insertion order is the result order, and the
    // exact leg runs first, so exacts lead.
    const matched = new Map<
      Id<"leagues">,
      { _id: Id<"leagues">; name: string; confidence: "exact" | "close" }
    >();

    const nameNormalized = normalizeLeagueName(name);
    for (const row of rows) {
      if (leagueAnswersTo(row, nameNormalized)) {
        matched.set(row._id, { _id: row._id, name: row.name, confidence: "exact" });
      }
    }

    // One candidate per NAME STRING, not per row: an alias has to be ranked on
    // its own text, and the row it belongs to is carried alongside so the
    // result can report the canonical name.
    const candidates: Array<{ name: string; rowId: Id<"leagues">; rowName: string }> = [];
    for (const row of rows) {
      candidates.push({ name: row.name, rowId: row._id, rowName: row.name });
      for (const alias of row.aliases ?? []) {
        candidates.push({ name: alias, rowId: row._id, rowName: row.name });
      }
    }

    for (const { index } of rankTeamCandidates(name, candidates)) {
      const candidate = candidates[index];
      // Already exact, or already ranked `close` through a better-ranked
      // string of the same row — either way this row has its answer.
      if (matched.has(candidate.rowId)) continue;
      matched.set(candidate.rowId, {
        _id: candidate.rowId,
        name: candidate.rowName,
        confidence: "close",
      });
    }

    return [...matched.values()].slice(0, LEAGUE_NEAR_MATCH_LIMIT);
  },
});

/**
 * NEO-240: admin quick-add for a league, the counterpart of
 * `players.createByAdmin`.
 *
 * Separate from `create` above rather than a widening of it, because `create`
 * is Team Management's inline "add new league" and returns a bare id — a shape
 * its caller depends on, and one that cannot answer the question this page
 * asks. `created` is what lets the page say "already here" and jump to the
 * existing row instead of claiming a creation it did not make.
 *
 * `created: false` on an ALIAS hit as much as on a name hit: typing "MLB" when
 * Major League Baseball already exists found a league, and reporting that
 * honestly is the entire reason aliases were added.
 */
export const createByAdmin = mutation({
  args: {
    name: v.string(),
    abbreviation: v.optional(v.string()),
    level: v.optional(leagueLevelValidator),
    sportId: v.id("selectorOptions"),
  },
  returns: v.object({
    id: v.id("leagues"),
    created: v.boolean(),
  }),
  handler: async (ctx, args): Promise<{ id: Id<"leagues">; created: boolean }> => {
    await requireAdmin(ctx);

    const name = requireValidLeagueName(args.name);

    const abbreviation = args.abbreviation?.trim() || undefined;
    if (abbreviation && abbreviation.length > MAX_LEAGUE_ABBREVIATION_LENGTH) {
      throw new ConvexError(
        `An abbreviation is ${abbreviation.length} characters; the limit is ${MAX_LEAGUE_ABBREVIATION_LENGTH}.`,
      );
    }

    // `sportId` is a bare `v.id("selectorOptions")` — the validator proves it
    // is an id in that table, not that it points at a SPORT. A league hung off,
    // say, a variantType row is unreachable by every query that matters (they
    // all key on the sport row id), so it would be an orphan. The same check
    // `players.createByAdmin` and `teams.findOrCreate` make.
    const sportRow = await ctx.db.get(args.sportId);
    if (!sportRow || sportRow.level !== "sport") {
      throw new ConvexError("A league must be created under a sport.");
    }

    // Asked BEFORE the write so `created` reports what actually happened.
    // `findOrCreateLeague` returns an id either way and cannot answer this on
    // its own; changing it to would change four `teams.ts` call sites for one
    // caller's benefit.
    const existing = await findLeagueByName(ctx, { name, sportId: args.sportId });

    const id = await findOrCreateLeague(ctx, {
      name,
      abbreviation,
      level: args.level,
      sportId: args.sportId,
    });

    // An audit trail for a shared-row creation an operator triggers from a
    // form. Structured JSON, not concatenation — the name is operator input
    // and must not be able to shape a log line.
    if (!existing) {
      console.log(
        JSON.stringify({ msg: "league_created", leagueId: id, sportId: args.sportId }),
      );
    }

    return { id, created: existing === null };
  },
});

/**
 * NEO-240: manual field entry for the league editor — the counterpart of
 * `players.savePlayerFields` / `teams.saveTeamFields`.
 *
 * ## Field semantics
 *
 * Omitting a field leaves it alone; `null` clears it. "" and "unset" are
 * different states and only one of them is a valid abbreviation, level or
 * span, so the clear has to be explicit. `aliases` is the exception and takes
 * no `null`: it is replaced wholesale, and `[]` is already the empty answer.
 *
 * `name` changes rewrite `nameNormalized` too, or the row becomes invisible to
 * every lookup that resolves a league name back onto it — silently, and only
 * discovered later as a duplicate league.
 *
 * `sportId` is NOT editable, deliberately. A league's sport is its identity
 * here ("National League" means nothing without one) and every row that points
 * at the league — every team in it — was filed under that sport. Moving it
 * would strand them, so the answer is a new league and a re-assignment of the
 * teams, both of which are visible operations.
 */
export const saveLeagueFields = mutation({
  args: {
    id: v.id("leagues"),
    name: v.optional(v.string()),
    abbreviation: v.optional(v.union(v.string(), v.null())),
    level: v.optional(v.union(leagueLevelValidator, v.null())),
    yearsActive: v.optional(v.union(leagueYearsActiveValidator, v.null())),
    /** Replaced wholesale. `[]` clears the list; there is no `null` form. */
    aliases: v.optional(v.array(v.string())),
    /** `null` clears `externalIds.wikidataId`; a string must be a `Q<digits>` id. */
    wikidataId: v.optional(v.union(v.string(), v.null())),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);

    const existing = await ctx.db.get(args.id);
    if (!existing) throw new ConvexError("League not found");

    const patch: {
      name?: string;
      nameNormalized?: string;
      abbreviation?: string;
      level?: LeagueLevel;
      yearsActive?: { from: number; to?: number };
      aliases?: string[];
      externalIds?: { wikidataId?: string };
      lastUpdated: number;
    } = { lastUpdated: Date.now() };

    // ── Name and aliases are decided TOGETHER ──────────────────────────────
    //
    // They are two halves of one key: what this row answers to. Validating
    // them separately would let a rename land while the alias list that must
    // be re-checked against it is still in flight, and would run the
    // collision scan twice. So the prospective final state of both is computed
    // first, then checked against the rest of the sport once.
    const nextName = args.name !== undefined ? requireValidLeagueName(args.name) : existing.name;
    const nextNameNormalized = normalizeLeagueName(nextName);

    // Recomputed from the stored list even when only the NAME changed: an
    // alias that was fine before can become the row's own name, and an alias
    // equal to the name is dropped silently.
    const nextAliases = normalizeAliasList(
      args.aliases !== undefined ? args.aliases : (existing.aliases ?? []),
      nextName,
    );

    if (args.name !== undefined || args.aliases !== undefined) {
      const keys = new Set<string>([
        nextNameNormalized,
        ...nextAliases.map((alias) => normalizeLeagueName(alias)),
      ]);

      // A rename or an alias onto a key another row already answers to would
      // create the exact ambiguity the whole dedup scheme exists to prevent:
      // `findOrCreateLeague` would then resolve that name to whichever row it
      // scanned first, non-deterministically. Refuse, and hand the page the
      // OTHER row's id so it can offer "go to that league" instead of leaving
      // the operator to search for it. The message carries an id and nothing
      // else — same rule as `players.savePlayerFields`'s NAME_TAKEN.
      const siblings = await ctx.db
        .query("leagues")
        .withIndex("by_sport_id", (q) => q.eq("sportId", existing.sportId))
        .collect();

      for (const sibling of siblings) {
        if (sibling._id === args.id) continue;
        const siblingKeys = [
          sibling.nameNormalized,
          ...(sibling.aliases ?? []).map((alias) => normalizeLeagueName(alias)),
        ];
        if (siblingKeys.some((key) => keys.has(key))) {
          throw new ConvexError(`NAME_TAKEN:${sibling._id}`);
        }
      }
    }

    if (args.name !== undefined) {
      patch.name = nextName;
      patch.nameNormalized = nextNameNormalized;
    }
    // Written whenever EITHER changed: a rename can drop an alias that has
    // become the name, and that drop has to be persisted.
    if (args.aliases !== undefined || args.name !== undefined) {
      // Undefined rather than `[]` once empty, so a cleared row is
      // indistinguishable from one that never had aliases — the same shape
      // `players.savePlayerFields` gives a cleared `externalIds`.
      patch.aliases = nextAliases.length > 0 ? nextAliases : undefined;
    }

    if (args.abbreviation !== undefined) {
      // An empty string is a cleared text box, which is the same intent as
      // `null` — the editor should not have to send a different value
      // depending on how the operator emptied the field.
      const trimmed = args.abbreviation?.trim() ?? "";
      if (trimmed.length > MAX_LEAGUE_ABBREVIATION_LENGTH) {
        throw new ConvexError(
          `An abbreviation is ${trimmed.length} characters; the limit is ${MAX_LEAGUE_ABBREVIATION_LENGTH}.`,
        );
      }
      patch.abbreviation = trimmed || undefined;
    }

    if (args.level !== undefined) {
      patch.level = args.level ?? undefined;
    }

    if (args.yearsActive !== undefined) {
      if (args.yearsActive !== null) validateLeagueYears(args.yearsActive);
      patch.yearsActive = args.yearsActive ?? undefined;
    }

    if (args.wikidataId !== undefined) {
      const rest: { wikidataId?: string } = { ...(existing.externalIds ?? {}) };
      if (args.wikidataId === null) {
        delete rest.wikidataId;
      } else {
        const qid = args.wikidataId.trim();
        // Validated at the write, not just in the UI. A malformed id is worse
        // than a missing one: enrichment treats ANY stored `wikidataId` as
        // "already enriched" and skips the row forever, so a typo here
        // silently opts the league out of it.
        if (!isWikidataQid(qid)) {
          // The raw argument rather than `qid`: `isWikidataQid` is a type
          // guard, so inside this branch `qid` has narrowed to `never`.
          throw new ConvexError(`Not a Wikidata entity id: ${args.wikidataId}`);
        }
        rest.wikidataId = qid;
      }
      patch.externalIds = Object.keys(rest).length > 0 ? rest : undefined;
    }

    await ctx.db.patch(args.id, patch);
    return null;
  },
});

/**
 * NEO-240: the teams in one league, for League Management's detail panel.
 *
 * Reads the `teams.by_league_id` index this ticket added — the reverse of
 * `teams.leagueId`. Without it the panel is a full `teams` scan filtered in
 * memory once per league the operator clicks.
 *
 * A narrow projection rather than the whole team document, and that is a
 * decision rather than an economy: this panel exists to say "here is what is
 * IN this league", so it returns the identifying name plus the two facts a
 * league view can sanity-check at a glance (the city, and the colours that
 * make a wrong-league team obvious). Everything else about a team belongs to
 * Team Management, which owns editing it.
 *
 * `.collect()` rather than a capped `.take()`: a league holds tens of teams,
 * bounded by the sport itself, and truncating this list would misreport a
 * league as smaller than it is with nothing on screen saying so.
 */
export const teamsIn = query({
  args: { leagueId: v.id("leagues") },
  returns: v.array(
    v.object({
      _id: v.id("teams"),
      name: v.string(),
      city: v.optional(v.string()),
      colors: v.optional(
        v.object({
          primary: v.optional(v.string()),
          secondary: v.optional(v.string()),
        }),
      ),
    }),
  ),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);

    const rows = await ctx.db
      .query("teams")
      .withIndex("by_league_id", (q) => q.eq("leagueId", args.leagueId))
      .collect();

    return rows
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((team) => ({
        _id: team._id,
        name: team.name,
        city: team.city,
        colors: team.colors,
      }));
  },
});

/**
 * NEO-240: "Discover" for one league — the admin's explicit re-lookup.
 *
 * ## THE ONLY SANCTIONED PATH TO RE-LOOK-UP AN EXISTING LEAGUE
 *
 * Automatic enrichment is CREATION-ONLY: `scheduleLeagueEnrichment` is called
 * on the insert branch of `findOrCreateLeague` and nowhere else (Jason,
 * 2026-09-02, on the players/teams equivalents: "if the player is already
 * known we should not try to look up the data again"). This action is the
 * deliberate exception, exactly as its `players` and `teams` twins are: it is
 * admin-gated, human-initiated on a specific row, and its purpose is the one
 * case where the stored answer is wrong. It therefore passes `force`. No
 * automatic caller may — see the contract on `wikidataPool.enqueueEnrichment`.
 *
 * Fire-and-forget: the pool runs the work in the background and the enrichment
 * action persists its own result. An enqueue failure is logged rather than
 * thrown, because an un-enriched league is a perfectly valid end state and the
 * operator's click should not surface as a broken screen.
 *
 * The lookup itself is a placeholder until NEO-240 WP1 lands its body — see
 * `adapters/wikidata.enrichLeague`.
 */
export const enrichFromWikidata = action({
  args: { id: v.id("leagues") },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    await requireAdmin(ctx);
    try {
      await ctx.runMutation(internal.wikidataPool.enqueueEnrichment, {
        leagueIds: [args.id],
        // The operator exception — see the note above. Automatic callers must
        // never set this.
        force: true,
      });
    } catch (error) {
      console.error("[leagues.enrichFromWikidata] enqueue failed:", error);
    }
    return null;
  },
});

/**
 * NEO-240: internal `get`, for actions that run outside user auth — the twin of
 * `teams.getInternal`. `adapters/wikidata.enrichLeague` reads the row through
 * this before deciding whether it needs a lookup at all.
 */
export const getInternal = internalQuery({
  args: { id: v.id("leagues") },
  returns: v.union(leagueDocValidator, v.null()),
  handler: async (ctx, args) => await ctx.db.get(args.id),
});

/**
 * NEO-240: write enrichment results back onto a league row.
 *
 * GAP-FILL ONLY, on every field — the rule `teams.applyEnrichmentInternal`
 * arrived at in NEO-203 and the reason it exists: background enrichment must
 * never overwrite an operator-visible value it did not write. Every field here
 * is editable by hand in `saveLeagueFields`, and a corrected abbreviation or a
 * hand-entered span that survives only until the next lookup is worse than one
 * that was never applied.
 *
 * `name` is deliberately NOT settable from enrichment. The name is the row's
 * identity and its dedup key; a source renaming it under an operator is the
 * silent-overwrite failure the whole gap-fill rule exists to prevent, and a
 * source that disagrees about the name has really found a different league.
 * Its wording belongs in `aliases`, which only an operator adds.
 */
export const applyEnrichmentInternal = internalMutation({
  args: {
    id: v.id("leagues"),
    abbreviation: v.optional(v.string()),
    yearsActive: v.optional(leagueYearsActiveValidator),
    wikidataId: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.id);
    if (!existing) return null;

    const patch: {
      abbreviation?: string;
      yearsActive?: { from: number; to?: number };
      externalIds?: { wikidataId?: string };
      lastUpdated: number;
    } = { lastUpdated: Date.now() };

    if (args.abbreviation !== undefined && !existing.abbreviation) {
      patch.abbreviation = args.abbreviation;
    }
    if (args.yearsActive !== undefined && !existing.yearsActive) {
      patch.yearsActive = args.yearsActive;
    }
    // A `wikidataId` that is not `Q<digits>` is DROPPED rather than stored —
    // the same rule as `players`/`teams`. The value arrives from
    // query.wikidata.org with no operator in the path, and a stored id is what
    // a creation-only guard reads to decide the row is done, so persisting a
    // malformed one would permanently opt the league out of enrichment.
    if (
      args.wikidataId !== undefined &&
      isWikidataQid(args.wikidataId) &&
      !existing.externalIds?.wikidataId
    ) {
      patch.externalIds = {
        ...(existing.externalIds ?? {}),
        wikidataId: args.wikidataId,
      };
    }

    await ctx.db.patch(args.id, patch);
    return null;
  },
});
