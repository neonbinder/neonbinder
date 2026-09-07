/**
 * NEO-254 — the armed bulk upsert. Four internal mutations, no dataset.
 *
 * ## What this is
 *
 * A generic, resumable, id-keyed way to push leagues, franchises, teams and
 * players into a deployment from a script run on somebody's laptop. It is the
 * SERVER half of the player/team preload; the other half — downloading Lahman,
 * nflverse, the Hockey Databank, RAPTOR/hoopR and the Transfermarkt dump,
 * splitting Location from Name, and deciding what a row should say — lives in
 * gitignored local scripts and is thrown away afterwards.
 *
 * That split is deliberate and it is the reason nothing dataset-specific
 * appears in this file. Jason, 2026-09-06: the CSVs do not live in git and are
 * not bundled. What ships is this: a mechanism with no opinion about baseball.
 *
 * ## Product invariant
 *
 * Every row this writes is an NB row with an NB id, created from an operator's
 * own dataset. No marketplace value seeds anything here, no marketplace id is
 * written, and nothing downstream keys on one. Sources are an INITIAL INPUT and
 * this is the input step; after it, these rows are NB's.
 *
 * ## The four rules, and why each exists
 *
 * 1. **Armed, twice.** `confirm: "BULK_LOAD"` (the validator) and
 *    `ALLOW_BULK_LOAD === "true"` on the target deployment (asserted inside
 *    every mutation). A CLI run carries no identity — see the long note on
 *    `selectorOptions.resetSetBuilderDataFromCli` — so the flag is the only
 *    thing between a mistyped `--prod` and thirty thousand rows in the wrong
 *    place. Asserted in EVERY mutation rather than once at an entry point,
 *    because there is no entry point: the loop runs on the operator's machine.
 * 2. **Never invents a sport row.** Sports are created by the marketplace sync.
 *    A missing one is a named refusal, not a silent insert, for the reason
 *    `seedTeamColors` gives: a sport row nothing else recognises produces teams
 *    and players no query can ever find.
 * 3. **Never overwrites.** An existing row is ADOPTED and gap-filled — a fact
 *    the row already carries always outranks the dataset's. This is the product
 *    invariant applied to our own data: the dataset is an initial input, and
 *    after creation only an operator changes a row.
 * 4. **Never prompts, never guesses.** Where the natural key is ambiguous the
 *    row comes back `ambiguous` with its candidates and NOTHING is written for
 *    it. The script asks the human and resubmits that row with a `decision`.
 *    A mutation cannot ask a question, and a mutation that guesses produces
 *    exactly the duplicate-person rows this ticket exists to avoid.
 *
 * ## Chunking
 *
 * Each mutation is one Convex transaction with a 4096-row read budget, so the
 * caller loops in chunks — at most 50 teams or 100 players per call. The
 * per-call caps are ENFORCED here rather than documented, because a script that
 * quietly sends 500 fails halfway through with a limit error and leaves the
 * operator guessing which rows landed.
 *
 * ## Nothing here schedules enrichment — including through its helpers
 *
 * `teams.findOrCreate` and `players.findOrCreate` each enqueue a Wikidata
 * lookup on insert. This file deliberately does not: the whole point of the
 * preload is that these rows arrive already carrying the career data Wikidata
 * would have been asked for, and thirty thousand queued lookups is not a
 * bounded amount of work. `seedTeamColors` makes the same call for the same
 * reason.
 *
 * That claim has to cover the HELPERS too, and originally it did not:
 * `findOrCreateLeague`'s insert branch schedules a league lookup, and
 * `resolveDefaultLeagueId` reaches it on the fallback path every bulk-created
 * team takes. So both now accept `skipEnrichment`, and every call in this file
 * passes it. Asserted in `bulkLoad.test.ts` off `_scheduled_functions`, because
 * a comment is exactly the wrong place for this to live.
 *
 * Anything a preloaded row is missing is still reachable through the admin
 * "Re-enrich from Wikidata" button — the deliberate, human version.
 *
 * ## `decision: { create: true }` is NOT idempotent, and cannot be made so
 *
 * Every other outcome here converges on a re-run: an adopted row is found
 * again, an unmatched name creates once and is adopted thereafter. `create`
 * is the exception BY DEFINITION — it means "none of the rows sharing this
 * key is the one I mean", and the row it inserts then shares that key too, so
 * replaying it inserts a second one. The server cannot tell a replay from a
 * genuine second person of the same name; only the caller knows.
 *
 * **The caller must therefore record the `id` a `create` decision returned and
 * replay that row as `{ adopt: id }`, never as `{ create: true }`.** That is
 * what the Phase B loader's answers file is for. A script that replays
 * `create` will duplicate a row on every run, silently.
 *
 * Runbook and the loader script: NEO-254 Phase B.
 */

import { internalMutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import {
  findLeagueByName,
  findOrCreateLeague,
  normalizeLeagueName,
  resolveDefaultLeagueId,
} from "./leagues";
import type { LeagueLevel } from "./leagues";
import { findOrCreateFranchise } from "./franchises";
import { normalizePlayerName } from "./players";
import { findTeamsByFullName, teamRowFields } from "./lib/teamRow";
import { normalizeEntityName } from "./lib/entityNearMatch";
import { teamFullName } from "../lib/teams/team-name";
import { sortTeamYears } from "../lib/players/team-tenure";
import {
  CAREER_SUMMARY_MAX_TEAMS,
  formatCareerSummary,
  type CareerSummaryStint,
} from "../lib/players/career-summary";

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/**
 * Rows per call. Sized so one mutation stays well inside Convex's 4096-row
 * read budget with room for the lookups each row makes: a player costs one
 * indexed candidate scan (up to 8) plus one read per distinct stint team, and
 * a team costs one candidate scan plus its league and franchise.
 */
const MAX_LEAGUES_PER_CALL = 50;
const MAX_FRANCHISES_PER_CALL = 100;
const MAX_TEAMS_PER_CALL = 50;
const MAX_PLAYERS_PER_CALL = 100;

/**
 * How many same-key rows are looked at before the answer is just "several".
 *
 * The branch is none / one / more-than-one, so eight is not a limit on
 * correctness — it is a limit on how many candidate rows an ambiguous result
 * puts in front of the operator, and eight same-name players in one sport is
 * already a dataset problem rather than a choice.
 */
const CANDIDATE_SCAN_LIMIT = 8;

/**
 * Stints per player. Same value and same reasoning as
 * `players.MAX_PLAYER_TEAM_YEARS`: an array written from an upstream payload
 * reaches a globally-shared row. The longest real career in any of the five
 * datasets is nowhere near this.
 */
const MAX_STINTS_PER_PLAYER = 64;

/** Bounds on the strings this writes. Same values as their admin twins. */
const MAX_NAME_LENGTH = 120;
/** A caller-supplied correlation key, echoed back in results. Bounded because
 *  it is echoed into refusal messages. */
const MAX_KEY_LENGTH = 120;

/** The earliest year any of these datasets can legitimately carry. */
const MIN_YEAR = 1800;

/**
 * The per-chunk league cache's slot for "no league named, use the sport
 * default". Prefixed so it cannot collide with `name:<normalised>`, which is
 * how every real league name is keyed.
 */
const DEFAULT_LEAGUE_CACHE_KEY = "default:";

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/**
 * Asserted at the top of every mutation in this file, exactly as
 * `assertResetArmed` is asserted next to every delete.
 *
 * The duplication is the point: there is no single entry point to guard,
 * because the loop that calls these runs on an operator's laptop. A future
 * internal caller — a migration, a cron, a well-meaning `ctx.runMutation` —
 * that reached one of these directly would otherwise write unarmed.
 *
 * `ConvexError` rather than `Error`, because production Convex redacts a plain
 * `Error` message and the entire job of this refusal is to name the flag.
 *
 * The `confirm` literal is re-checked even though the validator already
 * enforces it. Belt and braces on a write path this wide costs one comparison.
 */
function assertBulkLoadArmed(confirm: string): void {
  if (confirm !== "BULK_LOAD") {
    throw new ConvexError("Bulk load requires confirm: \"BULK_LOAD\".");
  }
  if (process.env.ALLOW_BULK_LOAD !== "true") {
    throw new ConvexError(
      "Bulk load is not armed on this deployment. Set ALLOW_BULK_LOAD=true on " +
        "it first (`npx convex env set ALLOW_BULK_LOAD true`), and unset it " +
        "again afterwards (`npx convex env remove ALLOW_BULK_LOAD`).",
    );
  }
}

// ---------------------------------------------------------------------------
// Shared validators
// ---------------------------------------------------------------------------

const confirmValidator = v.literal("BULK_LOAD");

const yearsValidator = v.object({ from: v.number(), to: v.optional(v.number()) });

const levelValidator = v.union(
  v.literal("major"),
  v.literal("minor"),
  v.literal("college"),
  v.literal("international"),
  v.literal("independent"),
  v.literal("other"),
);

/**
 * What happened to one row. `created` and `adopted` both mean "this key now has
 * an id"; `ambiguous` means nothing was written and the caller has a question
 * to answer.
 */
const statusValidator = v.union(
  v.literal("created"),
  v.literal("adopted"),
  v.literal("ambiguous"),
);

/**
 * The caller's answer to an `ambiguous` result, sent back on the same row.
 *
 * Two shapes rather than a nullable id, because "use this row" and "none of
 * those, make a new one" are different answers and a script must not be able to
 * express the second by accident.
 */
const teamDecisionValidator = v.union(
  v.object({ adopt: v.id("teams") }),
  v.object({ create: v.literal(true) }),
);

const playerDecisionValidator = v.union(
  v.object({ adopt: v.id("players") }),
  v.object({ create: v.literal(true) }),
);

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Trim, collapse whitespace, refuse empty or over-long. */
function boundedName(raw: string, what: string, key: string): string {
  const name = raw.trim().replace(/\s+/g, " ");
  if (name.length === 0) {
    throw new ConvexError(`${what} for "${key}" is empty.`);
  }
  if (name.length > MAX_NAME_LENGTH) {
    // The LENGTH, never the value — this reaches Sentry through Convex's
    // error path, same rule as every other name bound in the codebase.
    throw new ConvexError(
      `${what} for "${key}" is ${name.length} characters; the limit is ${MAX_NAME_LENGTH}.`,
    );
  }
  return name;
}

/** The caller's own correlation handle, echoed into results and refusals. */
function boundedKey(raw: string): string {
  const key = raw.trim();
  if (key.length === 0) throw new ConvexError("A row key cannot be empty.");
  if (key.length > MAX_KEY_LENGTH) {
    throw new ConvexError(
      `A row key is ${key.length} characters; the limit is ${MAX_KEY_LENGTH}.`,
    );
  }
  return key;
}

/**
 * Whole years, in range, ending no earlier than they start.
 *
 * The upper bound is NEXT year rather than this one, matching
 * `leagues.validateLeagueYears` and `players.savePlayerFields`: a season
 * already announced is a real span, and refusing it would make the loader wrong
 * every winter.
 */
function assertYears(
  years: { from: number; to?: number },
  what: string,
  key: string,
): void {
  const maxYear = new Date().getFullYear() + 1;
  if (!Number.isInteger(years.from) || years.from < MIN_YEAR || years.from > maxYear) {
    throw new ConvexError(
      `${what} for "${key}" starts in ${years.from}; expected a whole year between ${MIN_YEAR} and ${maxYear}.`,
    );
  }
  if (years.to !== undefined) {
    if (!Number.isInteger(years.to) || years.to < MIN_YEAR || years.to > maxYear) {
      throw new ConvexError(
        `${what} for "${key}" ends in ${years.to}; expected a whole year between ${MIN_YEAR} and ${maxYear}.`,
      );
    }
    if (years.to < years.from) {
      throw new ConvexError(`${what} for "${key}" ends before it starts.`);
    }
  }
}

/** Refuse a chunk bigger than one transaction should carry. */
function assertChunkSize(count: number, max: number, what: string): void {
  if (count > max) {
    throw new ConvexError(
      `${count} ${what} in one call; the limit is ${max}. Send them in chunks.`,
    );
  }
}

/**
 * The sport row this call is about — looked up, never created.
 *
 * Matched case-insensitively on `selectorOptions.value` among `level: "sport"`
 * rows, the same lookup `seedTeamColors` makes. A miss NAMES the sport, because
 * the operator's next move is either to sync it or to fix a typo in their
 * script, and "no sport" tells them neither.
 */
async function requireSportId(
  ctx: MutationCtx,
  sport: string,
): Promise<Id<"selectorOptions">> {
  const wanted = sport.trim().toLowerCase();
  if (!wanted) throw new ConvexError("A sport is required.");
  if (wanted.length > MAX_NAME_LENGTH) {
    throw new ConvexError("That sport name is too long to be a sport row.");
  }
  const rows = await ctx.db
    .query("selectorOptions")
    .withIndex("by_level", (q) => q.eq("level", "sport"))
    .collect();
  const hit = rows.find((row) => (row.value ?? "").trim().toLowerCase() === wanted);
  if (!hit) {
    throw new ConvexError(
      `No sport row for "${sport.trim()}" on this deployment. Sports are created ` +
        `by the marketplace sync and are never invented here — sync it first.`,
    );
  }
  return hit._id;
}

// ---------------------------------------------------------------------------
// Leagues
// ---------------------------------------------------------------------------

/**
 * Leagues, keyed by name-or-alias within the sport.
 *
 * Thin over `findOrCreateLeague`, which every other league writer already goes
 * through, so a bulk-loaded league dedupes against one an operator added by
 * hand and vice versa. The only thing this adds is `yearsActive`, which that
 * helper has no argument for and which the datasets do carry (the Federal
 * League ran 1914-15 and saying so is the fact that stops a 1914 set's league
 * being confused with a same-named successor). Gap-filled, never overwritten.
 */
export const upsertLeagues = internalMutation({
  args: {
    confirm: confirmValidator,
    sport: v.string(),
    leagues: v.array(
      v.object({
        name: v.string(),
        abbreviation: v.optional(v.string()),
        level: v.optional(levelValidator),
        yearsActive: v.optional(yearsValidator),
        aliases: v.optional(v.array(v.string())),
      }),
    ),
  },
  returns: v.object({
    results: v.array(
      v.object({
        name: v.string(),
        id: v.id("leagues"),
        created: v.boolean(),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    assertBulkLoadArmed(args.confirm);
    assertChunkSize(args.leagues.length, MAX_LEAGUES_PER_CALL, "leagues");
    const sportId = await requireSportId(ctx, args.sport);

    const results: { name: string; id: Id<"leagues">; created: boolean }[] = [];

    for (const row of args.leagues) {
      const name = boundedName(row.name, "A league name", row.name);
      const abbreviation = row.abbreviation?.trim() || undefined;
      if (row.yearsActive) assertYears(row.yearsActive, "A league span", name);

      // Asked BEFORE the helper runs, because `findOrCreateLeague` does not say
      // whether it inserted and the script's report is the operator's only view
      // of what a run did.
      const before = await findLeagueByName(ctx, { name, sportId });

      const id = await findOrCreateLeague(ctx, {
        name,
        ...(abbreviation ? { abbreviation } : {}),
        sportId,
        // See the header: no call in this file queues a Wikidata lookup.
        skipEnrichment: true,
        ...(row.level ? { level: row.level as LeagueLevel } : {}),
        ...(row.aliases && row.aliases.length > 0
          ? { aliases: row.aliases.map((a) => a.trim()).filter(Boolean) }
          : {}),
      });

      // Gap-fill only. A span already on the row was put there by an operator
      // or an earlier, better source; the dataset does not get to correct it.
      if (row.yearsActive) {
        const current = await ctx.db.get(id);
        if (current && current.yearsActive === undefined) {
          await ctx.db.patch(id, {
            yearsActive: row.yearsActive,
            lastUpdated: Date.now(),
          });
        }
      }

      results.push({ name, id, created: before === null });
    }

    return { results };
  },
});

// ---------------------------------------------------------------------------
// Franchises
// ---------------------------------------------------------------------------

/**
 * Franchises, keyed by normalised name within the sport.
 *
 * `key` is the CALLER's correlation handle — whatever its script calls this
 * thread internally — and is echoed back untouched so the loader can join the
 * results to its own rows. It is not stored: a franchise row holds a name, a
 * sport and nothing else (see `convex/franchises.ts`).
 *
 * A team row references its franchise by `franchiseKey`, and that key is
 * matched against the franchise NAME, not against this `key`. Passing the same
 * string as both is therefore the simplest thing a script can do; see
 * `upsertTeams` for the full rule.
 */
export const upsertFranchises = internalMutation({
  args: {
    confirm: confirmValidator,
    sport: v.string(),
    franchises: v.array(v.object({ key: v.string(), name: v.string() })),
  },
  returns: v.object({
    results: v.array(
      v.object({
        key: v.string(),
        id: v.id("franchises"),
        created: v.boolean(),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    assertBulkLoadArmed(args.confirm);
    assertChunkSize(args.franchises.length, MAX_FRANCHISES_PER_CALL, "franchises");
    const sportId = await requireSportId(ctx, args.sport);

    const results: { key: string; id: Id<"franchises">; created: boolean }[] = [];

    for (const row of args.franchises) {
      const key = boundedKey(row.key);
      const name = boundedName(row.name, "A franchise name", key);
      const { id, created } = await findOrCreateFranchise(ctx, { name, sportId });
      results.push({ key, id, created });
    }

    return { results };
  },
});

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------

/**
 * The dedup key NEO-236 gave teams: `normalizeTeamName` of the COMPOSED full
 * name. Read through `findTeamsByFullName`, which owns that derivation, so a
 * bulk-loaded ("San Diego", "Padres") lands on an existing "San Diego Padres"
 * row rather than beside it — and so this file never touches the identity
 * index itself (`convex/teams.dedupPin.test.ts` greps for that, and the split
 * is exactly what it protects).
 */
async function sameKeyTeams(
  ctx: MutationCtx,
  sportId: Id<"selectorOptions">,
  fullName: string,
): Promise<Doc<"teams">[]> {
  return await findTeamsByFullName(ctx, sportId, fullName, CANDIDATE_SCAN_LIMIT);
}

/**
 * Teams — one row per historical NAME, which is what a card says.
 *
 * ## Matching
 *
 * On `(nameNormalized, sportId)`, the NEO-236 key. None → create. Exactly one →
 * adopt it. Two or more → `ambiguous` with the candidates and NOTHING written;
 * two rows sharing a key in one sport is already a defect (`saveTeamFields`
 * refuses to create one), so this is the loader refusing to pick a side in a
 * mess it did not make.
 *
 * ## Franchise linkage
 *
 * `franchiseKey` is matched against the franchise NAME within the sport, using
 * the same normaliser franchises dedupe on. It must already exist — send the
 * franchises first — and a key that resolves to nothing is reported as
 * `franchiseMissing` rather than silently creating one, because a franchise
 * invented from a team's spelling of it is exactly the guess this table exists
 * to avoid. `franchiseId` may be sent instead, straight from an
 * `upsertFranchises` result, and wins when both are present.
 *
 * ## League
 *
 * `league` is a NAME, resolved through `findOrCreateLeague` — the same dedup
 * every other writer gets. With no league named, a created team falls back to
 * `resolveDefaultLeagueId`, exactly as `teams.findOrCreate` does, which may
 * legitimately yield nothing for a sport with no configured league.
 *
 * ## Adoption gap-fills, never overwrites
 *
 * An adopted row takes a league, a franchise and a span ONLY where it has none.
 * Its name and location are never touched at all — a row an operator split by
 * hand outranks a dataset's spelling of the same team, permanently.
 */
export const upsertTeams = internalMutation({
  args: {
    confirm: confirmValidator,
    sport: v.string(),
    teams: v.array(
      v.object({
        key: v.string(),
        location: v.optional(v.string()),
        name: v.string(),
        league: v.optional(v.string()),
        franchiseKey: v.optional(v.string()),
        franchiseId: v.optional(v.id("franchises")),
        yearsActive: v.optional(yearsValidator),
        decision: v.optional(teamDecisionValidator),
      }),
    ),
  },
  returns: v.object({
    results: v.array(
      v.object({
        key: v.string(),
        id: v.union(v.id("teams"), v.null()),
        status: statusValidator,
        candidates: v.optional(
          v.array(
            v.object({
              id: v.id("teams"),
              location: v.optional(v.string()),
              name: v.string(),
              yearsActive: v.optional(yearsValidator),
            }),
          ),
        ),
        /** The `franchiseKey` resolved to nothing. The team still landed. */
        franchiseMissing: v.optional(v.boolean()),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    assertBulkLoadArmed(args.confirm);
    assertChunkSize(args.teams.length, MAX_TEAMS_PER_CALL, "teams");
    const sportId = await requireSportId(ctx, args.sport);

    type TeamResult = {
      key: string;
      id: Id<"teams"> | null;
      status: "created" | "adopted" | "ambiguous";
      candidates?: {
        id: Id<"teams">;
        location?: string;
        name: string;
        yearsActive?: { from: number; to?: number };
      }[];
      franchiseMissing?: boolean;
    };
    const results: TeamResult[] = [];

    // One franchise lookup per distinct key across the whole chunk, not per
    // team. A 50-team chunk for one sport is typically two or three franchises.
    const franchiseByKey = new Map<string, Id<"franchises"> | null>();
    // The same, for leagues — see `resolveLeagueId` below for why the scan it
    // saves is the expensive one.
    const leagueByName = new Map<string, Id<"leagues"> | null>();
    const resolveFranchise = async (
      row: { franchiseId?: Id<"franchises">; franchiseKey?: string },
    ): Promise<{ id: Id<"franchises"> | null; missing: boolean }> => {
      if (row.franchiseId) {
        const doc = await ctx.db.get(row.franchiseId);
        if (!doc || doc.sportId !== sportId) return { id: null, missing: true };
        return { id: doc._id, missing: false };
      }
      const raw = row.franchiseKey?.trim();
      if (!raw) return { id: null, missing: false };
      const normalized = normalizeEntityName(raw);
      if (!normalized) return { id: null, missing: true };
      if (!franchiseByKey.has(normalized)) {
        const found = await ctx.db
          .query("franchises")
          .withIndex("by_name_normalized_and_sport_id", (q) =>
            q.eq("nameNormalized", normalized).eq("sportId", sportId),
          )
          .first();
        franchiseByKey.set(normalized, found?._id ?? null);
      }
      const id = franchiseByKey.get(normalized) ?? null;
      return { id, missing: id === null };
    };

    for (const row of args.teams) {
      const key = boundedKey(row.key);
      const name = boundedName(row.name, "A team name", key);
      const location = row.location?.trim().replace(/\s+/g, " ") || undefined;
      const fullName = teamFullName({ name, location });
      if (fullName.length > MAX_NAME_LENGTH) {
        throw new ConvexError(
          `The team name for "${key}" is ${fullName.length} characters; the limit is ${MAX_NAME_LENGTH}.`,
        );
      }
      if (row.yearsActive) assertYears(row.yearsActive, "A team span", key);

      const fields = teamRowFields({ name, location });
      const franchise = await resolveFranchise(row);

      // The league is resolved once per CHUNK, not once per row. A dataset
      // slice is fifty teams in two or three leagues, and `findLeagueByName`'s
      // alias leg is a `by_sport_id` collect — an array member cannot be
      // indexed — so resolving per row would pay that scan fifty times to
      // reach the same handful of ids. Keyed on the normalised name, and on a
      // reserved key for the sport-default fallback, so the two paths share
      // one cache without being able to collide with a real league name.
      const leagueName = row.league?.trim();
      const resolveLeagueId = async (): Promise<Id<"leagues"> | undefined> => {
        const cacheKey = leagueName
          ? `name:${normalizeLeagueName(leagueName)}`
          : DEFAULT_LEAGUE_CACHE_KEY;
        if (!leagueByName.has(cacheKey)) {
          const resolved = leagueName
            ? await findOrCreateLeague(ctx, {
                name: boundedName(leagueName, "A league name", key),
                sportId,
                // See the header: the helper's insert branch schedules a
                // Wikidata lookup, and a bulk write must not queue pooled
                // network work as a side effect.
                skipEnrichment: true,
              })
            : await resolveDefaultLeagueId(ctx, sportId, {
                skipEnrichment: true,
              });
          leagueByName.set(cacheKey, resolved ?? null);
        }
        return leagueByName.get(cacheKey) ?? undefined;
      };

      const adopt = async (existing: Doc<"teams">): Promise<TeamResult> => {
        const patch: Record<string, unknown> = {};
        if (!existing.leagueId) {
          const leagueId = await resolveLeagueId();
          if (leagueId) {
            patch.leagueId = leagueId;
            // The deprecated free-text `league` is cleared as its replacement
            // lands, exactly as `teams.saveTeamFields` and
            // `teams.convertLegacyLeagueInternal` do it. A row carrying both
            // is a row with two answers to one question, and the reads that
            // prefer `leagueId` would leave the string to rot unnoticed.
            patch.league = undefined;
          }
        }
        if (!existing.franchiseId && franchise.id) patch.franchiseId = franchise.id;
        if (existing.yearsActive === undefined && row.yearsActive) {
          patch.yearsActive = row.yearsActive;
        }
        if (Object.keys(patch).length > 0) {
          await ctx.db.patch(existing._id, { ...patch, lastUpdated: Date.now() });
        }
        return {
          key,
          id: existing._id,
          status: "adopted",
          ...(franchise.missing ? { franchiseMissing: true } : {}),
        };
      };

      const create = async (): Promise<TeamResult> => {
        const leagueId = await resolveLeagueId();
        const id = await ctx.db.insert("teams", {
          ...fields,
          sportId,
          ...(leagueId ? { leagueId } : {}),
          ...(franchise.id ? { franchiseId: franchise.id } : {}),
          ...(row.yearsActive ? { yearsActive: row.yearsActive } : {}),
          lastUpdated: Date.now(),
        });
        return {
          key,
          id,
          status: "created",
          ...(franchise.missing ? { franchiseMissing: true } : {}),
        };
      };

      /**
       * An answered question wins over the match — but only over the CHOICE,
       * never over the key.
       *
       * `adopt` exists to pick between rows that all share this row's natural
       * key, so the chosen row is checked against three things: it exists, it
       * is in this sport, and its key equals this row's. Without the third, a
       * mis-keyed answers file — a copy-paste slip, a stale id from a previous
       * run, an off-by-one join in the loader — silently writes this dataset
       * row's league, franchise and years onto an unrelated team, and nothing
       * anywhere reports it. Refused instead, naming the row so the operator
       * can go and fix the answer.
       */
      if (row.decision && "adopt" in row.decision) {
        const chosen = await ctx.db.get(row.decision.adopt);
        if (!chosen || chosen.sportId !== sportId) {
          throw new ConvexError(
            `The team chosen for "${key}" is not a team in this sport.`,
          );
        }
        if (chosen.nameNormalized !== fields.nameNormalized) {
          throw new ConvexError(
            `The team chosen for "${key}" is a different team. A decision can ` +
              `only pick between teams that share the name being loaded.`,
          );
        }
        results.push(await adopt(chosen));
        continue;
      }
      // `create` is deliberately unconditional — it is the operator saying
      // "none of these is the one I mean". It is also the one decision that
      // does NOT converge on a replay; see the header.
      if (row.decision && "create" in row.decision) {
        results.push(await create());
        continue;
      }

      const candidates = await sameKeyTeams(ctx, sportId, fullName);
      if (candidates.length === 0) {
        results.push(await create());
      } else if (candidates.length === 1) {
        results.push(await adopt(candidates[0]));
      } else {
        results.push({
          key,
          id: null,
          status: "ambiguous",
          candidates: candidates.map((team) => ({
            id: team._id,
            name: team.name,
            ...(team.location !== undefined ? { location: team.location } : {}),
            ...(team.yearsActive !== undefined
              ? { yearsActive: team.yearsActive }
              : {}),
          })),
        });
      }
    }

    return { results };
  },
});

// ---------------------------------------------------------------------------
// Players
// ---------------------------------------------------------------------------

/**
 * NEO-254 — which of several same-name rows a birth year identifies, if it
 * identifies exactly one.
 *
 * The same rule `players.candidateForBirthYear` applies, restated here rather
 * than imported because that one is module-private and this file must not
 * widen `players.ts`'s surface (Agent A owns it this ticket). A year that
 * matches two rows is still a question; a year that matches none is not
 * evidence of a new person, since every pre-NEO-254 row has no year at all.
 */
function candidateForBirthYear(
  candidates: ReadonlyArray<Doc<"players">>,
  birthYear: number | undefined,
): Doc<"players"> | null {
  if (birthYear === undefined) return null;
  const hits = candidates.filter((p) => p.birthYear === birthYear);
  return hits.length === 1 ? hits[0] : null;
}

/**
 * Players — matched on `(nameNormalized, sportId)`, disambiguated by birth
 * year, and never merged on a guess.
 *
 * ## The rules, and the reasoning behind each
 *
 * - **No candidate** → create.
 * - **One candidate**: adopt when the birth years cannot contradict — either
 *   side absent, or equal. A DIFFERENT year is positive evidence of two people
 *   (both Tony Gwynns are real), so that creates a second row rather than
 *   merging a father into a son.
 * - **Two or more**: adopt the one whose birth year matches, when exactly one
 *   does. Otherwise `ambiguous` with the candidates, and nothing written.
 *
 * A `decision` from the operator overrides all of it, which is what makes a
 * re-run with an answers file converge.
 *
 * ## Adoption gap-fills, never overwrites
 *
 * `birthYear`, `isHallOfFame` and `teamYears` are written ONLY where the row
 * has none. A player who already carries a career — from Wikidata, or from an
 * operator typing it — keeps exactly the career they had. This is the product
 * invariant applied to a dataset: initial input, never a source of truth.
 *
 * ## Stints
 *
 * `teamId`s come from the caller's own `upsertTeams` results. Each is verified
 * to exist and to be in this sport — the validator proves only that the id is a
 * team — and the list is capped, deduped on `(teamId, fromYear)` and sorted
 * with `sortTeamYears`, the one ordering every career writer shares.
 */
export const upsertPlayers = internalMutation({
  args: {
    confirm: confirmValidator,
    sport: v.string(),
    players: v.array(
      v.object({
        key: v.string(),
        name: v.string(),
        birthYear: v.optional(v.number()),
        isHallOfFame: v.optional(v.boolean()),
        stints: v.array(
          v.object({
            teamId: v.id("teams"),
            fromYear: v.number(),
            toYear: v.optional(v.number()),
          }),
        ),
        decision: v.optional(playerDecisionValidator),
      }),
    ),
  },
  returns: v.object({
    results: v.array(
      v.object({
        key: v.string(),
        id: v.union(v.id("players"), v.null()),
        status: statusValidator,
        candidates: v.optional(
          v.array(
            v.object({
              id: v.id("players"),
              name: v.string(),
              birthYear: v.optional(v.number()),
              careerSummary: v.string(),
            }),
          ),
        ),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    assertBulkLoadArmed(args.confirm);
    assertChunkSize(args.players.length, MAX_PLAYERS_PER_CALL, "players");
    const sportId = await requireSportId(ctx, args.sport);

    type PlayerResult = {
      key: string;
      id: Id<"players"> | null;
      status: "created" | "adopted" | "ambiguous";
      candidates?: {
        id: Id<"players">;
        name: string;
        birthYear?: number;
        careerSummary: string;
      }[];
    };
    const results: PlayerResult[] = [];

    // One read per distinct team across the whole chunk. A hundred players from
    // one dataset slice share a handful of teams, so without this the stint
    // check alone would be the read budget.
    const teamCache = new Map<string, Doc<"teams"> | null>();
    const readTeam = async (id: Id<"teams">): Promise<Doc<"teams"> | null> => {
      if (!teamCache.has(id)) teamCache.set(id, await ctx.db.get(id));
      return teamCache.get(id) ?? null;
    };

    const maxYear = new Date().getFullYear() + 1;

    for (const row of args.players) {
      const key = boundedKey(row.key);
      const name = boundedName(row.name, "A player name", key);
      const nameNormalized = normalizePlayerName(name);
      if (!nameNormalized) {
        // Punctuation only. It would store a key nothing can ever match, so the
        // row would be invisible to every lookup including its own.
        throw new ConvexError(
          `The player name for "${key}" has no letters or digits in it.`,
        );
      }
      if (row.birthYear !== undefined) {
        if (
          !Number.isInteger(row.birthYear) ||
          row.birthYear < MIN_YEAR ||
          row.birthYear > maxYear
        ) {
          throw new ConvexError(
            `The birth year for "${key}" is ${row.birthYear}; expected a whole year between ${MIN_YEAR} and ${maxYear}.`,
          );
        }
      }

      // ---- stints -------------------------------------------------------
      if (row.stints.length > MAX_STINTS_PER_PLAYER) {
        throw new ConvexError(
          `"${key}" has ${row.stints.length} stints; the limit is ${MAX_STINTS_PER_PLAYER}.`,
        );
      }
      const seenStints = new Set<string>();
      for (const stint of row.stints) {
        assertYears(
          { from: stint.fromYear, ...(stint.toYear !== undefined ? { to: stint.toYear } : {}) },
          "A stint",
          key,
        );
        const team = await readTeam(stint.teamId);
        if (!team) {
          throw new ConvexError(`A stint for "${key}" points at a team that does not exist.`);
        }
        if (team.sportId !== sportId) {
          // The team's own name is reference data the caller just created, so
          // it is safe to name and it is the only useful thing to say.
          throw new ConvexError(
            `A stint for "${key}" is on ${teamFullName(team)}, which is a team in another sport.`,
          );
        }
        const dedupe = `${stint.teamId}:${stint.fromYear}`;
        if (seenStints.has(dedupe)) {
          throw new ConvexError(
            `"${key}" has two stints on ${teamFullName(team)} starting in ${stint.fromYear}.`,
          );
        }
        seenStints.add(dedupe);
      }
      const teamYears = sortTeamYears(
        row.stints.map((s) => ({
          teamId: s.teamId,
          fromYear: s.fromYear,
          ...(s.toYear !== undefined ? { toYear: s.toYear } : {}),
        })),
      );

      // ---- write --------------------------------------------------------
      const adopt = async (existing: Doc<"players">): Promise<PlayerResult> => {
        const patch: Record<string, unknown> = {};
        if (existing.birthYear === undefined && row.birthYear !== undefined) {
          patch.birthYear = row.birthYear;
        }
        if (existing.isHallOfFame === undefined && row.isHallOfFame !== undefined) {
          patch.isHallOfFame = row.isHallOfFame;
        }
        // A career already on the row is never merged into, only filled in
        // when there is nothing there. Merging two sources' stints would need a
        // reconciliation rule nobody has written, and getting it wrong writes a
        // career that never happened.
        if (
          (existing.teamYears === undefined || existing.teamYears.length === 0) &&
          teamYears.length > 0
        ) {
          patch.teamYears = teamYears;
        }
        if (Object.keys(patch).length > 0) {
          await ctx.db.patch(existing._id, { ...patch, lastUpdated: Date.now() });
        }
        return { key, id: existing._id, status: "adopted" };
      };

      const create = async (): Promise<PlayerResult> => {
        const id = await ctx.db.insert("players", {
          name,
          nameNormalized,
          sportId,
          ...(row.birthYear !== undefined ? { birthYear: row.birthYear } : {}),
          ...(row.isHallOfFame !== undefined ? { isHallOfFame: row.isHallOfFame } : {}),
          ...(teamYears.length > 0 ? { teamYears } : {}),
          lastUpdated: Date.now(),
        });
        return { key, id, status: "created" };
      };

      // Three checks, for the reason spelled out on the team twin above: a
      // decision picks between rows that SHARE the natural key, so a chosen row
      // whose name differs is a mis-keyed answers file writing this player's
      // career onto somebody else.
      if (row.decision && "adopt" in row.decision) {
        const chosen = await ctx.db.get(row.decision.adopt);
        if (!chosen || chosen.sportId !== sportId) {
          throw new ConvexError(
            `The player chosen for "${key}" is not a player in this sport.`,
          );
        }
        if (chosen.nameNormalized !== nameNormalized) {
          throw new ConvexError(
            `The player chosen for "${key}" is a different person. A decision ` +
              `can only pick between players that share the name being loaded.`,
          );
        }
        results.push(await adopt(chosen));
        continue;
      }
      // Not idempotent on replay — record the returned id and send it back as
      // `{ adopt: id }` next run. See the header.
      if (row.decision && "create" in row.decision) {
        results.push(await create());
        continue;
      }

      const candidates = await ctx.db
        .query("players")
        .withIndex("by_name_normalized_and_sport_id", (q) =>
          q.eq("nameNormalized", nameNormalized).eq("sportId", sportId),
        )
        .take(CANDIDATE_SCAN_LIMIT);

      if (candidates.length === 0) {
        results.push(await create());
        continue;
      }

      if (candidates.length === 1) {
        const only = candidates[0];
        const contradicts =
          only.birthYear !== undefined &&
          row.birthYear !== undefined &&
          only.birthYear !== row.birthYear;
        results.push(contradicts ? await create() : await adopt(only));
        continue;
      }

      const decided = candidateForBirthYear(candidates, row.birthYear);
      if (decided) {
        results.push(await adopt(decided));
        continue;
      }

      results.push({
        key,
        id: null,
        status: "ambiguous",
        candidates: await Promise.all(
          candidates.map(async (player) => ({
            id: player._id,
            name: player.name,
            ...(player.birthYear !== undefined ? { birthYear: player.birthYear } : {}),
            careerSummary: await summariseCareer(player, readTeam),
          })),
        ),
      });
    }

    return { results };
  },
});

/**
 * "Padres 1982–2001 · Yankees 2003–present +2 more" for one candidate.
 *
 * Reads at most `CAREER_SUMMARY_MAX_TEAMS` team documents and tells the
 * formatter how many it skipped, rather than reading a whole career to print a
 * number — the same trade `players.buildExistingPlayerCandidates` makes, and
 * the reason `formatCareerSummary` takes an `extra` count at all. Team reads go
 * through the caller's cache, so the eight candidates of an ambiguous name
 * share every team they have in common.
 */
async function summariseCareer(
  player: Doc<"players">,
  readTeam: (id: Id<"teams">) => Promise<Doc<"teams"> | null>,
): Promise<string> {
  const stints = player.teamYears ?? [];
  if (stints.length === 0) return "";
  const head = stints.slice(0, CAREER_SUMMARY_MAX_TEAMS);
  const resolved: CareerSummaryStint[] = [];
  for (const stint of head) {
    const team = await readTeam(stint.teamId);
    if (!team) continue;
    resolved.push({
      teamName: teamFullName(team),
      fromYear: stint.fromYear,
      ...(stint.toYear !== undefined ? { toYear: stint.toYear } : {}),
    });
  }
  return formatCareerSummary(resolved, {
    maxTeams: CAREER_SUMMARY_MAX_TEAMS,
    extra: stints.length - resolved.length,
  });
}
