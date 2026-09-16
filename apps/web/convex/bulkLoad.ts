/**
 * NEO-284 — the armed bulk upsert, brought back slim for the NCAA D1 / ABL
 * team preload. Two internal mutations, one read-only preview, no dataset.
 *
 * ## What this is
 *
 * The SERVER half of a scripted preload: a resumable, key-correlated way to
 * push leagues and teams into a deployment from a script run on somebody's
 * laptop. The other half — the college dataset, the chunking loop, the
 * `answers.json` / `progress.jsonl` bookkeeping — lives in the private
 * wrapper and is not in this repository. Nothing dataset-specific appears
 * here; what ships is a mechanism with no opinion about baseball.
 *
 * NEO-254 (#241) shipped the first version of this file with franchises and
 * players as well; #250 removed it once that load was done. This is the
 * leagues + teams half only, re-cut around the alias model NEO-284 adds. The
 * players leg comes back with NEO-285 if it is needed.
 *
 * ## Product invariant
 *
 * Every row this writes is an NB row with an NB id, created from an operator's
 * own curated dataset. No marketplace value seeds anything here, no marketplace
 * id is written, and nothing downstream keys on one. `externalIds.wikidataId`
 * is linkage for Team Management's "Discover", never resolution. Sources are an
 * INITIAL INPUT and this is the input step; after it, these rows are NB's.
 *
 * ## The rules, and why each exists
 *
 * 1. **Armed, twice.** `confirm: "BULK_LOAD"` (the validator) and
 *    `ALLOW_BULK_LOAD === "true"` on the target deployment (asserted inside
 *    every mutation). A CLI run carries no identity — see the long note on
 *    `selectorOptions.resetSetBuilderDataFromCli` — so the flag is the only
 *    thing between a mistyped `--prod` and a thousand rows in the wrong place.
 *    Asserted in EVERY mutation rather than once at an entry point, because
 *    there is no entry point: the loop runs on the operator's machine. The
 *    preview query needs no arming — it writes nothing — but carries the
 *    confirm literal so a script cannot call the wrong one by accident.
 * 2. **Never invents a sport row.** Sports are created by the marketplace sync.
 *    A missing one is a named refusal, not a silent insert: a sport row nothing
 *    else recognises produces teams no query can ever find.
 * 3. **Never overwrites, never renames.** An existing row is ADOPTED and
 *    gap-filled — a fact the row already carries always outranks the
 *    dataset's, and `name`, `location`, colours and franchise are never
 *    touched at all. Aliases are UNIONED, never removed. This is the product
 *    invariant applied to our own data: after creation only an operator
 *    changes a row.
 * 4. **Never prompts, never guesses.** Where the match is ambiguous the row
 *    comes back `ambiguous` with its candidates and NOTHING is written for it.
 *    The script asks the human and resubmits that row with a `decision`. A
 *    mutation cannot ask a question, and one that guesses produces exactly the
 *    duplicate program rows this preload exists to avoid.
 *
 * ## Matching — the per-row protocol (plan §3 step 3; the ticket's section D)
 *
 * Prod already holds college teams: some created by hand under a proper
 * Location / Name split, some created from a raw Wikidata label ("Washington
 * Huskies baseball"). The dataset's canonical name for a program may be
 * neither, so a row is matched in three widening steps and every outcome says
 * HOW it matched:
 *
 *  1. **Decision replay.** An `adopt` answer from a previous run wins over the
 *     match — but only over the CHOICE, never over the key (see the branch).
 *     A `create` answer is unconditional and non-idempotent (below).
 *  2. **By name.** `findTeamsByExactName` on the composed full name, narrowed
 *     by `eraMatch` (the NEO-254 rule, unchanged: overlapping eras adopt, no
 *     overlap creates a new era, several → ambiguous, undated rival + CLOSED
 *     incoming → ambiguous, undated rival + OPEN incoming → adopt).
 *  3. **By alias**, only when the name found NOTHING: rows whose alias is the
 *     incoming full name; rows whose PRIMARY name is one of the incoming
 *     aliases — this is the label-named prod row, because the dataset always
 *     carries the Wikidata label as an alias, so it is found by construction;
 *     and rows merely SHARING an alias with the incoming row. Era-narrowed
 *     the same way. One row found through either of the first two legs →
 *     adopt with `matchedBy: "alias"`, `matchedOn`, and a `suggestion`
 *     carrying the dataset's canonical split — a REPORT LINE for the operator
 *     (plan decision 4), never written: an adopt never renames. A row found
 *     ONLY through a shared alias is `ambiguous` with that row as the
 *     candidate and `matchedOn` naming the string: one side's primary name is
 *     evidence of identity, two "also known as" lists touching is not — a
 *     bare "Miami" typed onto prod's RedHawks and carried by the dataset's
 *     Hurricanes would otherwise have written the Hurricanes' years, Q-id and
 *     aliases onto the RedHawks with nothing anywhere saying so. The operator
 *     answers adopt or create, and either converges.
 *  4. **Alias ownership.** Before any write, every incoming alias another row
 *     in the sport already holds as its name or an alias makes this row
 *     `ambiguous` with `aliasOwnedBy`, and nothing is written. Stricter than
 *     the player editor (advisory there): an alias the loader would attach
 *     unattended is exactly the shared-string case the dataset already dropped
 *     175 of. This also covers security condition S1 — an alias equal to
 *     another row's PRIMARY name, in any era — so the loader does not call
 *     `teams.assertAliasesNotPrimaryNames`; applying it here as well would
 *     turn a reported ambiguity into a thrown chunk. With a `decision` present the operator HAS looked, so the owned
 *     aliases are skipped and reported as `aliasesSkipped` while the rest
 *     land — otherwise an `aliasOwnedBy` row would have no expressible answer
 *     and the run could never converge.
 *  5. **Adopt** gap-fills ABSENT fields only: `leagueId` (clearing the legacy
 *     `league` string), `yearsActive`, `externalIds.wikidataId`; aliases are
 *     unioned. A different `wikidataId` already on the row is reported as
 *     `wikidataMismatch` and left alone — it is the one signal that the match
 *     picked the wrong program.
 *  6. **Create** inserts the row with its aliases through the one index writer
 *     and reports `nearExisting`: rows in the sport that share the location
 *     token, ranked by `rankTeamCandidates`. That is what surfaces "Hawaii /
 *     Rainbow Warriors" created beside prod's "Hawaii / Rainbows" — two
 *     historical names are two rows by the NEO-254 model, and the loader never
 *     adopts across a rename; the operator dates the eras afterwards.
 *
 * ## Chunking
 *
 * Each mutation is one Convex transaction, so the caller loops in chunks of at
 * most 50 rows. The cap is ENFORCED here rather than documented, because a
 * script that quietly sends 500 fails halfway through with a limit error and
 * leaves the operator guessing which rows landed. A row costs one indexed read
 * per incoming alias (most of them empty) plus a `db.get` per hit; a chunk of
 * rows carrying the dataset's 64-alias maximum should be sent smaller.
 *
 * ## Nothing here schedules enrichment — including through its helpers
 *
 * `findOrCreateLeague`'s insert branch schedules a league lookup, and
 * `resolveDefaultLeagueId` reaches it on the fallback path a team with no
 * league takes. Both accept `skipEnrichment` and every call in this file
 * passes it. Teams are not enriched at creation anywhere (NEO-254). Asserted
 * in `bulkLoad.test.ts` off `_scheduled_functions`, because a comment is
 * exactly the wrong place for this to live.
 *
 * ## `decision: { create: true }` is NOT idempotent, and cannot be made so
 *
 * Every other outcome converges on a re-run: an adopted row is found again, an
 * unmatched name creates once and is adopted thereafter (by name and era, or
 * by the aliases it now carries). `create` is the exception BY DEFINITION — it
 * means "none of the rows sharing this key is the one I mean", and the row it
 * inserts then shares that key too, so replaying it inserts a second one.
 * **The caller must record the `id` a `create` decision returned and replay
 * that row as `{ adopt: id }`, never as `{ create: true }`.** That is what the
 * wrapper's answers file is for.
 *
 * ## Dry run
 *
 * `dryRun: true` on `upsertTeams`, and the sibling `previewTeams` query, run
 * the same protocol minus the writes and report the same shape with `status`
 * `would-create` / `would-adopt` (`ambiguous` is `ambiguous` either way —
 * nothing would be written). The `leagues` summary on every result says what
 * each league name in the chunk resolved to; `null` there means the write run
 * would CREATE that league, which for "NCAA" is the assumption-10 signal to
 * add an alias in League Management first.
 *
 * Runbook: `docs/operations/neo284-team-aliases-preload.md`.
 */

import { internalMutation, internalQuery } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import {
  defaultLeagueNameFor,
  findLeagueByName,
  findOrCreateLeague,
  normalizeAliasList as normalizeLeagueAliasList,
  normalizeLeagueName,
  requireValidLeagueAbbreviation,
  resolveDefaultLeagueId,
} from "./leagues";
import type { LeagueLevel } from "./leagues";
// NEO-284 — the loader is a second door into `teams.aliases`, so it uses the
// SAME normaliser and the same index writer the admin editor does. A second
// derivation here is a second chance to write an alias the editor would have
// refused.
import {
  MAX_TEAM_ALIASES,
  normalizeTeamAliasList,
  normalizeTeamName,
  syncTeamAliases,
} from "./teams";
import {
  findTeamsByAlias,
  findTeamsByExactName,
  findTeamsByFullName,
  teamRowFields,
} from "./lib/teamRow";
import { erasOverlap } from "../lib/teams/team-era";
import { longestToken, nameTokens, rankTeamCandidates } from "./lib/entityNearMatch";
import { teamFullName } from "../lib/teams/team-name";
import { isWikidataQid } from "../lib/players/wikidata-id";

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/**
 * Rows per call. Sized so one mutation stays well inside Convex's read budget
 * with room for the lookups each row makes: a team costs one name read, one
 * indexed read per incoming alias, a `db.get` per hit, its league, and on
 * create one search-index read for `nearExisting`.
 */
const MAX_LEAGUES_PER_CALL = 50;
const MAX_TEAMS_PER_CALL = 50;

/** Bounds on the strings this writes. Same values as their admin twins. */
const MAX_NAME_LENGTH = 120;
/** A caller-supplied correlation key, echoed back in results. Bounded because
 *  it is echoed into refusal messages. */
const MAX_KEY_LENGTH = 120;

/** The earliest year any of these datasets can legitimately carry. */
const MIN_YEAR = 1800;

/** How many `nearExisting` rows a create reports, and how many the search feeds it. */
const NEAR_EXISTING_SEARCH_CANDIDATES = 10;
const NEAR_EXISTING_LIMIT = 5;

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
 * What happened to one row. `created` and `adopted` both mean "this key now
 * has an id"; `ambiguous` means nothing was written and the caller has a
 * question to answer; the `would-` pair is the dry run's report of what the
 * write run would do. `ambiguous` has no `would-` form because it writes
 * nothing in either mode.
 */
const statusValidator = v.union(
  v.literal("created"),
  v.literal("adopted"),
  v.literal("ambiguous"),
  v.literal("would-create"),
  v.literal("would-adopt"),
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

/** One incoming team row. See the header for what each field does. */
const teamRowValidator = v.object({
  key: v.string(),
  location: v.optional(v.string()),
  name: v.string(),
  aliases: v.optional(v.array(v.string())),
  league: v.optional(v.string()),
  yearsActive: v.optional(yearsValidator),
  wikidataId: v.optional(v.string()),
  decision: v.optional(teamDecisionValidator),
});

/** A row on file, as an `ambiguous` result lists it for the operator. */
const candidateValidator = v.object({
  id: v.id("teams"),
  location: v.optional(v.string()),
  name: v.string(),
  yearsActive: v.optional(yearsValidator),
  aliases: v.optional(v.array(v.string())),
});

/** Another row that already answers to one of the incoming aliases. */
const aliasOwnerValidator = v.object({
  alias: v.string(),
  id: v.id("teams"),
  /** The owner's FULL name. */
  name: v.string(),
});

const teamResultValidator = v.object({
  key: v.string(),
  id: v.union(v.id("teams"), v.null()),
  status: statusValidator,
  /** How an adopt found its row. `decision` is a replayed answer. */
  matchedBy: v.optional(
    v.union(v.literal("name"), v.literal("alias"), v.literal("decision")),
  ),
  /** The incoming string that matched, when `matchedBy` is `alias`. */
  matchedOn: v.optional(v.string()),
  /**
   * The dataset's canonical Location / Name for a row adopted by alias. A
   * REPORT LINE — never written; the operator renames in Team Management if
   * they want to.
   */
  suggestion: v.optional(
    v.object({ location: v.optional(v.string()), name: v.string() }),
  ),
  /** Which absent fields an adopt filled: leagueId, yearsActive, wikidataId. */
  filled: v.optional(v.array(v.string())),
  /** How many aliases an adopt added to the row (unioned, never removed). */
  aliasesAdded: v.optional(v.number()),
  /**
   * Incoming aliases NOT attached because another row already answers to
   * them — only on a row carrying a `decision`; without one the row is
   * `ambiguous` with `aliasOwnedBy` instead.
   */
  aliasesSkipped: v.optional(v.array(aliasOwnerValidator)),
  /** The row already carries a DIFFERENT Wikidata id. Left alone; look at it. */
  wikidataMismatch: v.optional(v.boolean()),
  /** `ambiguous`: the rows the match could not choose between. */
  candidates: v.optional(v.array(candidateValidator)),
  /** `ambiguous`: incoming aliases another row already holds. */
  aliasOwnedBy: v.optional(v.array(aliasOwnerValidator)),
  /** `created`: rows in the sport that look like the same program. */
  nearExisting: v.optional(
    v.array(
      v.object({
        id: v.id("teams"),
        name: v.string(),
        yearsActive: v.optional(yearsValidator),
      }),
    ),
  ),
});

const teamsResultValidator = v.object({
  results: v.array(teamResultValidator),
  /**
   * What every league name in the chunk resolved to. `null` means the write
   * run would create it — for "NCAA" that is the signal to add an alias to the
   * existing league row first rather than let the loader mint a second one.
   */
  leagues: v.array(
    v.object({ name: v.string(), id: v.union(v.id("leagues"), v.null()) }),
  ),
});

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

/**
 * A Wikidata id is `Q<digits>` or it is refused — not dropped, as
 * `teams.applyEnrichmentInternal` drops one, because this value comes off a
 * curated dataset with an operator in the path and a bad one is a dataset bug
 * they should hear about.
 */
function boundedQid(raw: string, key: string): string {
  const qid = raw.trim();
  if (!isWikidataQid(qid)) {
    throw new ConvexError(`The Wikidata id for "${key}" is not a Q-number.`);
  }
  return qid;
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
 * rows. A miss NAMES the sport, because the operator's next move is either to
 * sync it or to fix a typo in their script, and "no sport" tells them neither.
 */
async function requireSportId(
  ctx: QueryCtx | MutationCtx,
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
 * hand and vice versa. That helper already gap-fills abbreviation, level,
 * years and the Wikidata id on a row it finds; the one thing this adds is the
 * alias GAP-FILL — the helper deliberately never widens an existing row's
 * aliases (that is an operator decision in League Management), and a preload
 * of a league nobody has touched is the one caller for which "absent, so take
 * the dataset's" is the right rule. A row that already has ANY alias keeps
 * exactly what it has.
 *
 * `dryRun` resolves and reports without writing: `id: null` with
 * `created: true` means the write run would insert this league.
 */
export const upsertLeagues = internalMutation({
  args: {
    confirm: confirmValidator,
    sport: v.string(),
    dryRun: v.optional(v.boolean()),
    leagues: v.array(
      v.object({
        name: v.string(),
        abbreviation: v.optional(v.string()),
        level: v.optional(levelValidator),
        yearsActive: v.optional(yearsValidator),
        aliases: v.optional(v.array(v.string())),
        wikidataId: v.optional(v.string()),
      }),
    ),
  },
  returns: v.object({
    results: v.array(
      v.object({
        name: v.string(),
        id: v.union(v.id("leagues"), v.null()),
        created: v.boolean(),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    assertBulkLoadArmed(args.confirm);
    assertChunkSize(args.leagues.length, MAX_LEAGUES_PER_CALL, "leagues");
    const sportId = await requireSportId(ctx, args.sport);
    const write = !args.dryRun;

    const results: { name: string; id: Id<"leagues"> | null; created: boolean }[] = [];

    for (const row of args.leagues) {
      const name = boundedName(row.name, "A league name", row.name);
      // The admin editor's own bound (16), so the loader cannot store an
      // abbreviation League Management would refuse to save back.
      const abbreviation = requireValidLeagueAbbreviation(row.abbreviation);
      if (row.yearsActive) assertYears(row.yearsActive, "A league span", name);
      const wikidataId = row.wikidataId ? boundedQid(row.wikidataId, name) : undefined;
      // Bounded the way League Management bounds them, own name dropped.
      const aliases = row.aliases ? normalizeLeagueAliasList(row.aliases, name) : [];

      // Asked BEFORE the helper runs, because `findOrCreateLeague` does not say
      // whether it inserted and the script's report is the operator's only view
      // of what a run did.
      const before = await findLeagueByName(ctx, { name, sportId });

      if (!write) {
        results.push({ name, id: before?._id ?? null, created: before === null });
        continue;
      }

      const id = await findOrCreateLeague(ctx, {
        name,
        ...(abbreviation ? { abbreviation } : {}),
        sportId,
        // See the header: no call in this file queues a Wikidata lookup.
        skipEnrichment: true,
        ...(row.level ? { level: row.level as LeagueLevel } : {}),
        ...(aliases.length > 0 ? { aliases } : {}),
        ...(row.yearsActive ? { yearsActive: row.yearsActive } : {}),
        ...(wikidataId ? { wikidataId } : {}),
      });

      // Alias gap-fill on a row the helper FOUND — see the doc comment.
      if (before && aliases.length > 0 && (before.aliases ?? []).length === 0) {
        await ctx.db.patch(id, { aliases, lastUpdated: Date.now() });
      }

      results.push({ name, id, created: before === null });
    }

    return { results };
  },
});

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------

/** What matching an incoming team row against the eras already on file found. */
type EraMatch =
  | { kind: "none" }
  | { kind: "one"; team: Doc<"teams"> }
  | { kind: "several"; teams: Doc<"teams">[] };

/**
 * NEO-254 — which ERA of this name the incoming row is.
 *
 * Two Winnipeg Jets exist: 1972-1996 and 2011-. Matching on the name alone
 * folded them into one row, so the loader would have adopted the 2011
 * franchise for every 1970s roster it carried.
 *
 * The rule, and each branch is a different kind of certainty:
 *
 *  - **Overlapping eras.** `erasOverlap` treats an undated side as unknown, so
 *    a dataset row with years matches an undated row on file (we cannot say it
 *    is a different team) and vice versa. Exactly one overlap is the answer.
 *  - **No overlap at all.** Every row on file is a franchise that had ended
 *    before this one began, or began after it ended. That is positive evidence
 *    of a NEW era, so the caller creates — this is what puts the 1972 Jets
 *    beside the 2011 Jets instead of on top of them.
 *  - **Two or more overlaps.** The years do not separate them and the loader
 *    does not guess. `ambiguous`, with the candidates and their years, for the
 *    operator to answer and resubmit.
 */
function eraMatch(
  candidates: readonly Doc<"teams">[],
  yearsActive: { from: number; to?: number } | undefined,
): EraMatch {
  if (candidates.length === 0) return { kind: "none" };
  const overlapping = candidates.filter((team) =>
    erasOverlap(team.yearsActive, yearsActive),
  );
  if (overlapping.length === 0) return { kind: "none" };
  if (overlapping.length > 1) return { kind: "several", teams: overlapping };

  /**
   * One overlap — but if it overlaps only because it is UNDATED, adopting it
   * is order-dependent, and that is a bug rather than a tie.
   *
   * The case: prod holds an undated "Adelaide Giants" carrying a league and
   * colours. The dataset then sends both ABL eras. Whichever arrives FIRST
   * matches the undated row, adopts it, gap-fills its years and inherits
   * everything on it; the second arrives, no longer overlaps, and is created
   * bare. Run the chunks in the other order and the colours land on the other
   * era. Nothing errors, and the result depends on array order in a file.
   *
   * So an undated row is only adopted by an era that could plausibly BE it —
   * an OPEN one, which is what an undated row created from today's roster
   * actually is. A CLOSED incoming era (1989-1999) is a historical club, the
   * one thing an undated "as it stands today" row is least likely to mean, so
   * it comes back ambiguous with that row as the candidate and the operator
   * dates it once. Both arrival orders then converge, because neither writes.
   */
  const only = overlapping[0];
  const undatedRival = only.yearsActive === undefined;
  const incomingIsClosed = yearsActive?.to !== undefined;
  if (undatedRival && incomingIsClosed) {
    return { kind: "several", teams: overlapping };
  }
  return { kind: "one", team: only };
}

type TeamRowInput = {
  key: string;
  location?: string;
  name: string;
  aliases?: string[];
  league?: string;
  yearsActive?: { from: number; to?: number };
  wikidataId?: string;
  decision?: { adopt: Id<"teams"> } | { create: true };
};

type TeamStatus = "created" | "adopted" | "ambiguous" | "would-create" | "would-adopt";

type AliasOwner = { alias: string; id: Id<"teams">; name: string };

type TeamResult = {
  key: string;
  id: Id<"teams"> | null;
  status: TeamStatus;
  matchedBy?: "name" | "alias" | "decision";
  matchedOn?: string;
  suggestion?: { location?: string; name: string };
  filled?: string[];
  aliasesAdded?: number;
  aliasesSkipped?: AliasOwner[];
  wikidataMismatch?: boolean;
  candidates?: {
    id: Id<"teams">;
    location?: string;
    name: string;
    yearsActive?: { from: number; to?: number };
    aliases?: string[];
  }[];
  aliasOwnedBy?: AliasOwner[];
  nearExisting?: {
    id: Id<"teams">;
    name: string;
    yearsActive?: { from: number; to?: number };
  }[];
};

type TeamsResult = {
  results: TeamResult[];
  leagues: { name: string; id: Id<"leagues"> | null }[];
};

function candidateOf(team: Doc<"teams">): NonNullable<TeamResult["candidates"]>[number] {
  return {
    id: team._id,
    name: team.name,
    ...(team.location !== undefined ? { location: team.location } : {}),
    ...(team.yearsActive !== undefined ? { yearsActive: team.yearsActive } : {}),
    ...(team.aliases !== undefined && team.aliases.length > 0
      ? { aliases: team.aliases }
      : {}),
  };
}

/**
 * The protocol, shared by the mutation and the preview query. `ctx` is a
 * mutation context only when `write` is true; every write below is behind that
 * flag and the query passes false. Kept as one function rather than two so the
 * dry run cannot drift from what the write run does — the dry run's only job is
 * to predict it.
 */
async function loadTeams(
  ctx: QueryCtx | MutationCtx,
  args: { sport: string; teams: TeamRowInput[] },
  write: boolean,
): Promise<TeamsResult> {
  assertChunkSize(args.teams.length, MAX_TEAMS_PER_CALL, "teams");
  const sportId = await requireSportId(ctx, args.sport);
  const mutationCtx = write ? (ctx as MutationCtx) : null;

  const results: TeamResult[] = [];

  // The league is resolved once per CHUNK, not once per row. A dataset slice
  // is fifty teams in one or two leagues, and `findLeagueByName`'s alias leg
  // is a `by_sport_id` collect — an array member cannot be indexed — so
  // resolving per row would pay that scan fifty times to reach one id. Keyed
  // on the normalised name, and on a reserved key for the sport-default
  // fallback, so the two paths share one cache without colliding with a real
  // league name. The cache doubles as the `leagues` summary on the result.
  const leagueCache = new Map<string, { name: string; id: Id<"leagues"> | null }>();
  const resolveLeagueId = async (
    leagueName: string | undefined,
    key: string,
  ): Promise<Id<"leagues"> | undefined> => {
    const cacheKey = leagueName
      ? `name:${normalizeLeagueName(leagueName)}`
      : DEFAULT_LEAGUE_CACHE_KEY;
    if (!leagueCache.has(cacheKey)) {
      if (leagueName) {
        const name = boundedName(leagueName, "A league name", key);
        const id = mutationCtx
          ? await findOrCreateLeague(mutationCtx, {
              name,
              sportId,
              // See the header: the helper's insert branch schedules a
              // Wikidata lookup, and a bulk write must not queue pooled
              // network work as a side effect.
              skipEnrichment: true,
            })
          : ((await findLeagueByName(ctx, { name, sportId }))?._id ?? null);
        leagueCache.set(cacheKey, { name, id });
      } else {
        // The sport default: the same name `resolveDefaultLeagueId` would
        // resolve, read without the create when this is a dry run.
        const configured = await defaultLeagueNameFor(ctx, sportId);
        const name = configured?.name ?? "(sport default)";
        const id = !configured
          ? null
          : mutationCtx
            ? ((await resolveDefaultLeagueId(mutationCtx, sportId, {
                skipEnrichment: true,
              })) ?? null)
            : ((await findLeagueByName(ctx, { name, sportId }))?._id ?? null);
        leagueCache.set(cacheKey, { name, id });
      }
    }
    return leagueCache.get(cacheKey)?.id ?? undefined;
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
    const wikidataId = row.wikidataId ? boundedQid(row.wikidataId, key) : undefined;

    const fields = teamRowFields({ name, location });
    // Bounded and de-duplicated on the way in, exactly as the admin editor
    // does it, and against the full name this row would carry — so the
    // dataset's own label for the row is dropped when it IS the row's name.
    const aliases = row.aliases ? normalizeTeamAliasList(row.aliases, fullName) : [];
    const incomingKeys = new Set<string>([
      fields.nameNormalized,
      ...aliases.map((alias) => normalizeTeamName(alias)),
    ]);

    /**
     * Who already answers to each incoming alias — by name OR by alias, the
     * shared identity lookup. Read once per row and used twice: as the alias
     * legs of the match (a row whose PRIMARY name is one of these aliases is
     * the label-named prod row) and as the ownership check before any write.
     */
    const holdersByAlias = new Map<string, Doc<"teams">[]>();
    for (const alias of aliases) {
      holdersByAlias.set(alias, await findTeamsByFullName(ctx, sportId, alias));
    }
    const ownersExcept = (self: Id<"teams"> | null): AliasOwner[] => {
      const owners: AliasOwner[] = [];
      for (const [alias, holders] of holdersByAlias) {
        for (const holder of holders) {
          if (holder._id === self) continue;
          owners.push({ alias, id: holder._id, name: teamFullName(holder) });
        }
      }
      return owners;
    };

    // ---- the two writes --------------------------------------------------

    const adopt = async (
      existing: Doc<"teams">,
      how: { matchedBy: "name" | "alias" | "decision"; matchedOn?: string },
      skipped: AliasOwner[],
    ): Promise<TeamResult> => {
      const patch: Record<string, unknown> = {};
      const filled: string[] = [];
      if (!existing.leagueId) {
        const leagueId = await resolveLeagueId(row.league, key);
        if (leagueId) {
          patch.leagueId = leagueId;
          // The deprecated free-text `league` is cleared as its replacement
          // lands, exactly as `teams.saveTeamFields` and
          // `teams.convertLegacyLeagueInternal` do it. A row carrying both
          // is a row with two answers to one question.
          patch.league = undefined;
          filled.push("leagueId");
        }
      }
      if (existing.yearsActive === undefined && row.yearsActive) {
        patch.yearsActive = row.yearsActive;
        filled.push("yearsActive");
      }
      let wikidataMismatch = false;
      if (wikidataId) {
        const held = existing.externalIds?.wikidataId;
        if (!held) {
          patch.externalIds = { ...(existing.externalIds ?? {}), wikidataId };
          filled.push("wikidataId");
        } else if (held !== wikidataId) {
          wikidataMismatch = true;
        }
      }

      /*
       * Aliases are UNIONED, never replaced. Every other field here is
       * gap-filled; an alias list is different, because the row's existing
       * entries may have been typed by an operator who knew something the
       * dataset does not, and a load that dropped them would undo that work
       * on every re-run. The union is de-duplicated on the key the index uses
       * and checked against the row's OWN full name (not the dataset's), so
       * "Washington Huskies baseball" is not written as an alias of the row
       * that is named that. Aliases another row owns were removed by the
       * caller before this point.
       */
      const skippedKeys = new Set(skipped.map((s) => normalizeTeamName(s.alias)));
      const safeAliases = aliases.filter(
        (alias) => !skippedKeys.has(normalizeTeamName(alias)),
      );
      const existingAliases = existing.aliases ?? [];
      const existingKeys = new Set(existingAliases.map((a) => normalizeTeamName(a)));
      const additions = safeAliases.filter(
        (alias) => !existingKeys.has(normalizeTeamName(alias)),
      );
      let merged = existingAliases;
      if (additions.length > 0) {
        // Bounded like every other alias write. The dataset never exceeds the
        // cap on its own, so this only trips when the row already carries
        // aliases — a refusal the operator should hear, not a silent trim.
        if (existingAliases.length + additions.length > MAX_TEAM_ALIASES) {
          throw new ConvexError(
            `Adopting "${key}" would leave the row with ` +
              `${existingAliases.length + additions.length} aliases; the limit is ${MAX_TEAM_ALIASES}.`,
          );
        }
        merged = normalizeTeamAliasList(
          [...existingAliases, ...additions],
          teamFullName(existing),
        );
        if (merged.length !== existingAliases.length) patch.aliases = merged;
      }
      const aliasesAdded = merged.length - existingAliases.length;

      if (mutationCtx && Object.keys(patch).length > 0) {
        await mutationCtx.db.patch(existing._id, { ...patch, lastUpdated: Date.now() });
        if (patch.aliases) {
          await syncTeamAliases(mutationCtx, {
            teamId: existing._id,
            sportId,
            aliases: merged,
          });
        }
      }
      return {
        key,
        id: existing._id,
        status: write ? "adopted" : "would-adopt",
        matchedBy: how.matchedBy,
        ...(how.matchedOn !== undefined ? { matchedOn: how.matchedOn } : {}),
        // The dataset's canonical split, for the operator to consider — only
        // where the row's name is NOT what the dataset calls it.
        ...(how.matchedBy !== "name" && existing.nameNormalized !== fields.nameNormalized
          ? { suggestion: { ...(location ? { location } : {}), name } }
          : {}),
        filled,
        aliasesAdded,
        ...(skipped.length > 0 ? { aliasesSkipped: skipped } : {}),
        ...(wikidataMismatch ? { wikidataMismatch: true } : {}),
      };
    };

    const create = async (skipped: AliasOwner[]): Promise<TeamResult> => {
      const skippedKeys = new Set(skipped.map((s) => normalizeTeamName(s.alias)));
      const safeAliases = aliases.filter(
        (alias) => !skippedKeys.has(normalizeTeamName(alias)),
      );

      /*
       * `nearExisting` — computed BEFORE the insert so the new row is not its
       * own neighbour. A search-index read on the location token (or the
       * name's longest token for a location-less club), ranked against the
       * full name by the same ranker the wizard's "did you mean?" uses;
       * `close` is what "Hawaii / Rainbows" scores for "Hawaii / Rainbow
       * Warriors". Rows in the sport only. Mutations may read search indexes.
       */
      const term = nameTokens(location ?? "").join(" ") || longestToken(name) || "";
      const nearExisting: NonNullable<TeamResult["nearExisting"]> = [];
      if (term) {
        const hits = await ctx.db
          .query("teams")
          .withSearchIndex("search_name", (q) =>
            q.search("nameNormalized", term).eq("sportId", sportId),
          )
          .take(NEAR_EXISTING_SEARCH_CANDIDATES);
        const named = hits.map((hit) => ({ hit, name: teamFullName(hit) }));
        for (const { index } of rankTeamCandidates(fullName, named).slice(
          0,
          NEAR_EXISTING_LIMIT,
        )) {
          const { hit } = named[index];
          nearExisting.push({
            id: hit._id,
            name: teamFullName(hit),
            ...(hit.yearsActive !== undefined ? { yearsActive: hit.yearsActive } : {}),
          });
        }
      }

      const leagueId = await resolveLeagueId(row.league, key);
      let id: Id<"teams"> | null = null;
      if (mutationCtx) {
        id = await mutationCtx.db.insert("teams", {
          ...teamRowFields({ name, location }),
          sportId,
          ...(leagueId ? { leagueId } : {}),
          ...(row.yearsActive ? { yearsActive: row.yearsActive } : {}),
          ...(safeAliases.length > 0 ? { aliases: safeAliases } : {}),
          ...(wikidataId ? { externalIds: { wikidataId } } : {}),
          lastUpdated: Date.now(),
        });
        if (safeAliases.length > 0) {
          await syncTeamAliases(mutationCtx, { teamId: id, sportId, aliases: safeAliases });
        }
      }
      return {
        key,
        id,
        status: write ? "created" : "would-create",
        ...(skipped.length > 0 ? { aliasesSkipped: skipped } : {}),
        ...(nearExisting.length > 0 ? { nearExisting } : {}),
      };
    };

    const ambiguous = (
      extra: Pick<TeamResult, "candidates" | "aliasOwnedBy">,
    ): TeamResult => ({ key, id: null, status: "ambiguous", ...extra });

    // ---- 1. decision replay ----------------------------------------------

    /**
     * An answered question wins over the match — but only over the CHOICE,
     * never over the key.
     *
     * `adopt` exists to pick between rows the match could not choose between,
     * so the chosen row is checked against three things: it exists, it is in
     * this sport, and it shares the name being loaded OR answers to one of the
     * incoming strings by name or alias (relaxed from NEO-254's "same name"
     * because adopting a label-named row through an alias is now legitimate).
     * Without the third, a mis-keyed answers file — a copy-paste slip, a stale
     * id from a previous run, an off-by-one join in the loader — silently
     * writes this dataset row's league, years and aliases onto an unrelated
     * team, and nothing anywhere reports it. Refused instead, naming the key
     * so the operator can go and fix the answer.
     */
    if (row.decision && "adopt" in row.decision) {
      const chosen = await ctx.db.get(row.decision.adopt);
      if (!chosen || chosen.sportId !== sportId) {
        throw new ConvexError(
          `The team chosen for "${key}" is not a team in this sport.`,
        );
      }
      const answers =
        incomingKeys.has(chosen.nameNormalized) ||
        (chosen.aliases ?? []).some((alias) => incomingKeys.has(normalizeTeamName(alias)));
      if (!answers) {
        throw new ConvexError(
          `The team chosen for "${key}" is a different team. A decision can ` +
            `only pick a team that shares the name being loaded or answers to ` +
            `one of its aliases.`,
        );
      }
      results.push(await adopt(chosen, { matchedBy: "decision" }, ownersExcept(chosen._id)));
      continue;
    }
    // `create` is deliberately unconditional — it is the operator saying
    // "none of these is the one I mean". It is also the one decision that
    // does NOT converge on a replay; see the header.
    if (row.decision && "create" in row.decision) {
      results.push(await create(ownersExcept(null)));
      continue;
    }

    // ---- 2. by name --------------------------------------------------------

    const byName = await findTeamsByExactName(ctx, sportId, fullName);
    const nameMatch = eraMatch(byName, row.yearsActive);
    if (nameMatch.kind === "several") {
      results.push(ambiguous({ candidates: nameMatch.teams.map(candidateOf) }));
      continue;
    }

    // ---- 3. by alias, only when the name found nothing at all -------------

    let aliasMatch: EraMatch = { kind: "none" };
    const matchedOnById = new Map<string, string>();
    // Rows a PRIMARY name vouches for — legs (i) and (ii). A row reached only
    // through leg (iii), a shared alias, is never in here; see the header.
    const vouched = new Set<string>();
    if (nameMatch.kind === "none" && byName.length === 0) {
      const union: Doc<"teams">[] = [];
      const seen = new Set<string>();
      const add = (team: Doc<"teams">, on: string, primary: boolean) => {
        if (primary) vouched.add(team._id);
        if (seen.has(team._id)) return;
        seen.add(team._id);
        matchedOnById.set(team._id, on);
        union.push(team);
      };
      // (i) rows whose ALIAS is the incoming full name — OUR primary name.
      for (const team of await findTeamsByAlias(ctx, sportId, fullName)) {
        add(team, fullName, true);
      }
      // (ii) rows whose PRIMARY name is one of our aliases, and (iii) rows
      // that merely share one — the reads already made for the ownership
      // check, told apart by whether the holder's own key is the alias.
      for (const [alias, holders] of holdersByAlias) {
        const aliasKey = normalizeTeamName(alias);
        for (const team of holders) add(team, alias, team.nameNormalized === aliasKey);
      }
      aliasMatch = eraMatch(union, row.yearsActive);
      if (aliasMatch.kind === "several") {
        results.push(ambiguous({ candidates: aliasMatch.teams.map(candidateOf) }));
        continue;
      }
      if (aliasMatch.kind === "one" && !vouched.has(aliasMatch.team._id)) {
        results.push({
          ...ambiguous({ candidates: [candidateOf(aliasMatch.team)] }),
          matchedOn: matchedOnById.get(aliasMatch.team._id) ?? fullName,
        });
        continue;
      }
    }

    // ---- 4. alias ownership, then 5/6 the write ---------------------------

    const found =
      nameMatch.kind === "one"
        ? { team: nameMatch.team, how: { matchedBy: "name" as const } }
        : aliasMatch.kind === "one"
          ? {
              team: aliasMatch.team,
              how: {
                matchedBy: "alias" as const,
                matchedOn: matchedOnById.get(aliasMatch.team._id) ?? fullName,
              },
            }
          : null;
    if (found) {
      const owners = ownersExcept(found.team._id);
      if (owners.length > 0) {
        results.push(
          ambiguous({ candidates: [candidateOf(found.team)], aliasOwnedBy: owners }),
        );
        continue;
      }
      results.push(await adopt(found.team, found.how, []));
      continue;
    }

    const owners = ownersExcept(null);
    if (owners.length > 0) {
      results.push(ambiguous({ aliasOwnedBy: owners }));
      continue;
    }
    results.push(await create([]));
  }

  return { results, leagues: [...leagueCache.values()] };
}

/**
 * Teams — one row per historical NAME, which is what a card says. The
 * protocol is in the module header; this is the armed entry point.
 */
export const upsertTeams = internalMutation({
  args: {
    confirm: confirmValidator,
    sport: v.string(),
    /** Same protocol, no writes, `would-` statuses. See the header. */
    dryRun: v.optional(v.boolean()),
    teams: v.array(teamRowValidator),
  },
  returns: teamsResultValidator,
  handler: async (ctx, args) => {
    assertBulkLoadArmed(args.confirm);
    return await loadTeams(ctx, args, !args.dryRun);
  },
});

/**
 * The dry run as a QUERY, so it can be pointed at an unarmed deployment —
 * the rehearsal reads a restored prod snapshot before anything is armed, and
 * prod itself is dry-run before the flag is set. Same handler as
 * `upsertTeams` minus the writes; the confirm literal is kept so a script
 * cannot call the wrong one by accident.
 */
export const previewTeams = internalQuery({
  args: {
    confirm: confirmValidator,
    sport: v.string(),
    teams: v.array(teamRowValidator),
  },
  returns: teamsResultValidator,
  handler: async (ctx, args) => {
    if (args.confirm !== "BULK_LOAD") {
      throw new ConvexError("Bulk load preview requires confirm: \"BULK_LOAD\".");
    }
    return await loadTeams(ctx, args, false);
  },
});
