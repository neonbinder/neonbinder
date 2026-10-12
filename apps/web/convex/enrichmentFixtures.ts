/**
 * NEO-289 — capture and audit the recorded enrichment lookups.
 *
 * The recording itself, the switch that lets a deployment read it, and the
 * one key normaliser live in `adapters/enrichmentFixtures.ts`; the lookup
 * wrappers that consult it are in `adapters/wikidata.ts`. This module is the
 * operator's side: two `npx convex run` entry points that produce the file
 * and report what it does not cover.
 *
 * ## Which names: the ones this deployment's runs looked up
 *
 * Not every name the deployment holds. Since NEO-330 every CI preview is
 * loaded with the reference catalogue (six figures of players, five of
 * teams) before the seed runs, and no flow looks up more than a few hundred
 * of those. A list of "every row of the sport" is then mostly names nothing
 * ever asked about: as a coverage report its `missing` list is noise, and as
 * a capture it is a day of Wikidata traffic. So the list is scoped to the
 * names a run actually sent to `lookup*Enrichment`, read from three places
 * the lookups leave a durable trace. No new table.
 *
 * (a) `players`, `teams` and `leagues` rows of the sport CREATED SINCE the
 *     run's boundary (below). A row the review wizard creates was a staged
 *     queue row first, and every staged row is looked up
 *     (`runEntityReviewLookup`); a player or league created on an admin page
 *     is looked up at creation (`enrichPlayer`, `enrichLeague`). A team's
 *     name is its COMPOSED full name (`teamFullName`), because that is what
 *     the wizard hands `lookupTeamEnrichment` and what ESPN's `displayName`
 *     matches. Teams and leagues pass their stored `externalIds.wikidataId`
 *     as `knownQid`.
 * (b) `entityReviewQueue` rows for the sport (since the boundary when there
 *     is one). The commit deletes its own batch, so these are the lookups
 *     still in flight or never committed — and on a deployment where the
 *     seed stalled at exactly the lookups this recording is meant to replace,
 *     (a) is empty while (b) holds every name that stalled it. For a queue
 *     row `knownQid` is `source.wikidataId` when present (a career team or
 *     league staged off a Wikidata statement — the id the live path would
 *     read), else `enrichment.wikidataId` when the lookup already answered.
 * (c) `entityReviewSkips` rows (since the boundary when there is one) whose
 *     set sits under the sport. A skipped name was staged, so it was looked
 *     up, but it never becomes an entity row and its queue row is gone after
 *     the commit; without this source a skip-heavy batch (the NEO-330
 *     Venezuelan Winter League flow skips 200 players) would be invisible.
 *
 * In every case the id is the same linkage the wizard's own lookup uses, so
 * the recording reads the record the row is linked to rather than searching
 * for its label.
 *
 * ### The boundary
 *
 * The reference catalogue is imported with its source `_creationTime`s
 * (`scripts/reference-seed`, "`_id` and `_creationTime` kept"), so every
 * catalogue row is older than anything a run creates. The boundary is the
 * caller's `since` (ms since the epoch) when given; otherwise the
 * `_creationTime` of the OLDEST `year` row in `selectorOptions`. That is
 * structural rather than a guess: a name reaches the review wizard only
 * through a set, a set hangs off a year, and the CI seed's catalogue load
 * replaces `selectorOptions` with sport rows only, so the first year row is
 * the first thing the seed builds. With no year row at all (no set was ever
 * built) the entity tables contribute nothing and (b)/(c) are read whole.
 *
 * Every source is an index RANGE from the boundary (`by_sport_id` and the
 * built-in `by_creation_time` both end in `_creationTime`), so the reads
 * scale with what the run created, never with the catalogue. On a
 * deployment whose year rows predate its catalogue load (a developer's
 * deployment loaded with `--sports remap`) the default boundary admits
 * catalogue rows; the per-source cap then stops the read and the result
 * says so in `truncatedSources` — pass `since` there.
 *
 * Known gap, by construction: a staged name the operator LINKED to an
 * existing row leaves no row of its own (and the alias tables carry no sport
 * index to range over), so it is not listed. The recording's own §4a
 * procedure adds those by hand.
 *
 * ## Armed, internal, and CLI-only
 *
 * Both actions are `internalAction`s driven by `npx convex run` WITHOUT
 * `--identity` (an internal function is unreachable with one), so neither
 * carries `requireAdmin`. Both take the literal `confirm` arg as a typo
 * guard. Only `captureFromCli` is additionally ARMED by
 * `ALLOW_ENRICHMENT_FIXTURE_CAPTURE=true` on the deployment (the
 * `convex/bulkLoad.ts` shape, set for the run and removed after): it fans out
 * to Wikidata and ESPN for every name on the deployment, and the flag is what
 * stops a stray internal caller doing that on its own. `coverageReportFromCli`
 * reads the committed file and the looked-up names, writes nothing and
 * makes no outbound call, and CI runs it after every seed on a preview whose
 * env it cannot set per invocation — so it is deliberately NOT env-armed
 * (security audit, 2026-09-20).
 *
 * ## Running it
 *
 *     npx convex env set ALLOW_ENRICHMENT_FIXTURE_CAPTURE true
 *     npx convex run enrichmentFixtures:captureFromCli \
 *       '{"confirm":"CAPTURE_ENRICHMENT_FIXTURES","sportQid":"Q5369"}' > capture.json
 *     npx convex env remove ALLOW_ENRICHMENT_FIXTURE_CAPTURE
 *     npx convex run enrichmentFixtures:coverageReportFromCli \
 *       '{"confirm":"CAPTURE_ENRICHMENT_FIXTURES","sportQid":"Q5369"}'
 *
 * A capture holds only the names one run looked up, so its `fixture.entries`
 * are MERGED into the committed file (the runbook's merge step), never
 * written over it: the file also carries batches recorded on other runs.
 *
 * `offset`/`limit` page the name list when a single run would outlast the
 * CLI's wait; merge the pages' `entries` objects by hand (keys are unique
 * across pages). `since` overrides the boundary above for both actions.
 * `skippedTransport` lists names whose lookup did not
 * complete — a timeout, a 429, ESPN down — and which were therefore NOT
 * recorded as no-match; re-run for those once the source recovers.
 *
 * Runs in the V8 runtime (no `"use node"`) so the two queries below can live
 * beside the actions; the live lookups are reached through
 * `internal.adapters.wikidata.runCaptureLookups`, the node half.
 */

import { ConvexError, v, type Infer } from "convex/values";
import { internalAction, internalQuery, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { findSportForSelectorOption } from "./cardChecklist";
import { teamFullName } from "../lib/teams/team-name";
import { isWikidataQid } from "../lib/players/wikidata-id";
// Not from `./adapters/wikidata`: that module is `"use node"`, and a V8 module
// cannot import one. Everything shared with it goes through the pure fixture
// module.
import {
  FIXTURE_VERSION,
  captureItemValidator,
  captureSkipValidator,
  captureSportValidator,
  fixtureFileValidator,
  fixtureKey,
  hasFixtureEntry,
  type EnrichmentFixtureEntry,
} from "./adapters/enrichmentFixtures";

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

const CONFIRM_LITERAL = "CAPTURE_ENRICHMENT_FIXTURES";
const confirmValidator = v.literal(CONFIRM_LITERAL);

/**
 * The typo guard both actions share. Re-checked even though the validator
 * already enforces the literal — belt and braces, as `bulkLoad.ts` does.
 */
function assertConfirmed(confirm: string): void {
  if (confirm !== CONFIRM_LITERAL) {
    throw new ConvexError(`Fixture capture requires confirm: "${CONFIRM_LITERAL}".`);
  }
}

/**
 * Asserted at the top of `captureFromCli` ONLY — see the header for why the
 * coverage report is not env-armed. `ConvexError` rather than `Error`, as in
 * `bulkLoad.ts`: production redacts a plain `Error` and the whole job of this
 * refusal is to name the flag.
 */
function assertCaptureArmed(confirm: string): void {
  assertConfirmed(confirm);
  if (process.env.ALLOW_ENRICHMENT_FIXTURE_CAPTURE !== "true") {
    throw new ConvexError(
      "Fixture capture is not armed on this deployment. Set " +
        "ALLOW_ENRICHMENT_FIXTURE_CAPTURE=true on it first " +
        "(`npx convex env set ALLOW_ENRICHMENT_FIXTURE_CAPTURE true`), and unset " +
        "it again afterwards (`npx convex env remove ALLOW_ENRICHMENT_FIXTURE_CAPTURE`).",
    );
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Per-SOURCE ceiling on the rows one name list reads (each of `players`,
 * `teams`, `leagues`, `entityReviewQueue`, `entityReviewSkips`). A CI run
 * creates and stages a few hundred names; 2 000 is several runs' worth, and
 * five sources at this cap stay well inside a query's document and byte
 * budgets even for `players` rows carrying long `teamYears`. Past it the
 * source is cut, never silently: it is named in `truncatedSources`, the
 * coverage report says so, and a capture refuses.
 */
export const MAX_ROWS_PER_SOURCE = 2_000;

/**
 * Distinct sets whose sport a list will resolve for `entityReviewSkips` rows
 * (each is an ancestor walk of a handful of `db.get`s). Past it the skips of
 * the remaining sets are left out and the source is reported as truncated.
 */
export const MAX_SKIP_SETS = 200;

/** How many names go to the node action per call, so no single call runs long. */
const CHUNK = 25;

type SportContext = Infer<typeof captureSportValidator>;

/**
 * The sport row whose `sportConfig.wikidata.sportQid` is the given QID —
 * exactly one, or a refusal. Resolved by the id on the row rather than by a
 * display name, for the reason `SportEnrichmentContext` gives.
 */
export const resolveSportByQid = internalQuery({
  args: { sportQid: v.string() },
  returns: v.object({ sportId: v.id("selectorOptions"), sport: captureSportValidator }),
  handler: async (ctx, args): Promise<{ sportId: Id<"selectorOptions">; sport: SportContext }> => {
    const sports = await ctx.db
      .query("selectorOptions")
      .withIndex("by_level", (q) => q.eq("level", "sport"))
      .collect();
    const matches = sports.filter((row) => row.sportConfig?.wikidata?.sportQid === args.sportQid);
    if (matches.length !== 1) {
      throw new ConvexError(
        `Expected exactly one sport row with sportConfig.wikidata.sportQid=${args.sportQid}; found ${matches.length}.`,
      );
    }
    const row = matches[0];
    return {
      sportId: row._id,
      sport: {
        label: row.value,
        ...(row.sportConfig?.espn ? { espn: row.sportConfig.espn } : {}),
        ...(row.sportConfig?.wikidata ? { wikidata: row.sportConfig.wikidata } : {}),
      },
    };
  },
});

type CaptureItem = Infer<typeof captureItemValidator>;

const KIND_ORDER: Record<CaptureItem["kind"], number> = { player: 0, team: 1, league: 2 };

const sinceSourceValidator = v.union(
  v.literal("arg"),
  v.literal("firstYearRow"),
  v.literal("none"),
);

type SinceSource = Infer<typeof sinceSourceValidator>;

/**
 * The boundary the header describes: the caller's `since`, else the oldest
 * `year` row's `_creationTime` (`by_level` ends in `_creationTime`, so
 * `.first()` is the oldest), else none.
 */
async function lookupBoundary(
  ctx: QueryCtx,
  since: number | undefined,
): Promise<{ since: number | null; sinceSource: SinceSource }> {
  if (since !== undefined) {
    if (!Number.isFinite(since) || since < 0) {
      throw new ConvexError("`since` must be a non-negative number of milliseconds since the epoch.");
    }
    return { since, sinceSource: "arg" };
  }
  const oldestYear = await ctx.db
    .query("selectorOptions")
    .withIndex("by_level", (q) => q.eq("level", "year"))
    .first();
  return oldestYear
    ? { since: oldestYear._creationTime, sinceSource: "firstYearRow" }
    : { since: null, sinceSource: "none" };
}

const lookedUpNamesValidator = v.object({
  items: v.array(captureItemValidator),
  /** True when any source hit `MAX_ROWS_PER_SOURCE` (or the skips' set cap). */
  truncated: v.boolean(),
  /** Which sources were cut, so a truncated list is never mistaken for a whole one. */
  truncatedSources: v.array(v.string()),
  /** The boundary applied, ms since the epoch; null when there was none. */
  since: v.union(v.number(), v.null()),
  sinceSource: sinceSourceValidator,
});

type LookedUpNames = Infer<typeof lookedUpNamesValidator>;

/**
 * The names this deployment's runs looked up for the sport (see the header:
 * entity rows created since the boundary, open review-queue rows, skipped
 * names), as the lookups would be asked for them, deduped by `fixtureKey`
 * (an entity row wins over a queue row, a queue row over a skip), in a
 * stable order (kind, then name by code point) so `offset`/`limit` paging is
 * repeatable across calls.
 *
 * Bounded: every read is an index range from the boundary capped at
 * `MAX_ROWS_PER_SOURCE + 1`, and at most `MAX_SKIP_SETS` ancestor walks. The
 * queue and the skips have no `sportId` index, so they range over the
 * built-in `by_creation_time` and are filtered to the sport in memory.
 */
export const listLookedUpNames = internalQuery({
  args: { sportId: v.id("selectorOptions"), since: v.optional(v.number()) },
  returns: lookedUpNamesValidator,
  handler: async (ctx, args): Promise<LookedUpNames> => {
    const { since, sinceSource } = await lookupBoundary(ctx, args.since);
    const truncatedSources: string[] = [];
    const cap = <Row>(source: string, rows: Row[]): Row[] => {
      if (rows.length <= MAX_ROWS_PER_SOURCE) return rows;
      truncatedSources.push(source);
      return rows.slice(0, MAX_ROWS_PER_SOURCE);
    };
    const take = MAX_ROWS_PER_SOURCE + 1;

    // (a) Entity rows created since the boundary. With no boundary these
    // would be the whole catalogue, which nothing looked up: skip them.
    const [players, teams, leagues] =
      since === null
        ? [[], [], []]
        : await Promise.all([
            ctx.db
              .query("players")
              .withIndex("by_sport_id", (q) => q.eq("sportId", args.sportId).gte("_creationTime", since))
              .take(take),
            ctx.db
              .query("teams")
              .withIndex("by_sport_id", (q) => q.eq("sportId", args.sportId).gte("_creationTime", since))
              .take(take),
            ctx.db
              .query("leagues")
              .withIndex("by_sport_id", (q) => q.eq("sportId", args.sportId).gte("_creationTime", since))
              .take(take),
          ]);

    // (b) and (c): staged names. Whole-table when there is no boundary —
    // these tables only ever hold names a lookup was asked about.
    const queueRows = await (since === null
      ? ctx.db.query("entityReviewQueue").take(take)
      : ctx.db
          .query("entityReviewQueue")
          .withIndex("by_creation_time", (q) => q.gte("_creationTime", since))
          .take(take));
    const skipRows = await (since === null
      ? ctx.db.query("entityReviewSkips").take(take)
      : ctx.db
          .query("entityReviewSkips")
          .withIndex("by_creation_time", (q) => q.gte("_creationTime", since))
          .take(take));

    const knownQidOf = (id: string | undefined): { knownQid: string } | Record<never, never> =>
      id && isWikidataQid(id) ? { knownQid: id } : {};

    const fromEntities: CaptureItem[] = [
      ...cap("players", players).map((row): CaptureItem => ({ kind: "player", name: row.name })),
      ...cap("teams", teams).map(
        (row): CaptureItem => ({
          kind: "team",
          name: teamFullName(row),
          ...knownQidOf(row.externalIds?.wikidataId),
        }),
      ),
      ...cap("leagues", leagues).map(
        (row): CaptureItem => ({
          kind: "league",
          name: row.name,
          ...knownQidOf(row.externalIds?.wikidataId),
        }),
      ),
    ];
    const fromQueue: CaptureItem[] = cap("entityReviewQueue", queueRows)
      .filter((row) => row.sportId === args.sportId)
      .map(
        (row): CaptureItem => ({
          kind: row.kind,
          name: row.name,
          // The staged id first: it is the record the live path READS rather
          // than a search result, so it is the stronger linkage.
          ...knownQidOf(row.source?.wikidataId ?? row.enrichment?.wikidataId),
        }),
      );

    // A skip carries its SET, not its sport: resolve each distinct set once.
    const sportOfSet = new Map<Id<"selectorOptions">, Id<"selectorOptions"> | undefined>();
    let skipSetsCut = false;
    const fromSkips: CaptureItem[] = [];
    for (const row of cap("entityReviewSkips", skipRows)) {
      if (!sportOfSet.has(row.selectorOptionId)) {
        if (sportOfSet.size >= MAX_SKIP_SETS) {
          skipSetsCut = true;
          continue;
        }
        sportOfSet.set(row.selectorOptionId, await findSportForSelectorOption(ctx, row.selectorOptionId));
      }
      if (sportOfSet.get(row.selectorOptionId) === args.sportId) {
        fromSkips.push({ kind: row.kind, name: row.name });
      }
    }
    if (skipSetsCut) truncatedSources.push("entityReviewSkips (sets)");

    // Union, deduped by fixture key, first source wins. Every item here is
    // the same sport, so the key's sport segment is a constant and an empty
    // one dedupes exactly as the real QID would.
    const byKey = new Map<string, CaptureItem>();
    for (const item of [...fromEntities, ...fromQueue, ...fromSkips]) {
      const key = fixtureKey(item.kind, "", item.name);
      if (!byKey.has(key)) byKey.set(key, item);
    }
    const items = [...byKey.values()];
    items.sort((a, b) => {
      const byKind = KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
      if (byKind !== 0) return byKind;
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });
    return { items, truncated: truncatedSources.length > 0, truncatedSources, since, sinceSource };
  },
});

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

const captureResultValidator = v.object({
  fixture: fixtureFileValidator,
  skippedTransport: v.array(captureSkipValidator),
  /** Looked-up names for the sport (see the header), before paging. */
  total: v.number(),
  offset: v.number(),
  /** Names this call looked up (recorded + skipped). */
  scanned: v.number(),
  /** The boundary the name list used — see the header. */
  since: v.union(v.number(), v.null()),
  sinceSource: sinceSourceValidator,
});

type CaptureResult = Infer<typeof captureResultValidator>;

/**
 * Record the live lookup answer for every name the deployment's runs looked
 * up (`listLookedUpNames`; on a catalogue-loaded preview that is the run's
 * names, not the catalogue's).
 *
 * Bypasses the fixture switch by construction: `runCaptureLookups` calls the
 * `*Live` bodies, so a deployment that already reads fixtures still captures
 * fresh answers. Writes nothing to the database; the return value IS the
 * output, for the developer to MERGE into the committed file — it holds one
 * run's names, and the file holds every recorded batch.
 *
 * A truncated name list is refused rather than captured: past
 * `MAX_ROWS_PER_SOURCE` the list is no longer "what a run looked up", and
 * capturing it is the day of Wikidata traffic the cap exists to stop.
 */
export const captureFromCli = internalAction({
  args: {
    confirm: confirmValidator,
    sportQid: v.string(),
    offset: v.optional(v.number()),
    limit: v.optional(v.number()),
    since: v.optional(v.number()),
  },
  returns: captureResultValidator,
  handler: async (ctx, args): Promise<CaptureResult> => {
    assertCaptureArmed(args.confirm);
    const offset = Math.max(0, Math.floor(args.offset ?? 0));
    const limit = args.limit === undefined ? undefined : Math.max(0, Math.floor(args.limit));

    const { sportId, sport } = await ctx.runQuery(internal.enrichmentFixtures.resolveSportByQid, {
      sportQid: args.sportQid,
    });
    const listed = await ctx.runQuery(internal.enrichmentFixtures.listLookedUpNames, {
      sportId,
      ...(args.since === undefined ? {} : { since: args.since }),
    });
    if (listed.truncated) {
      throw new ConvexError(
        `The looked-up name list is truncated (${listed.truncatedSources.join(", ")}: more than ` +
          `${MAX_ROWS_PER_SOURCE} rows since ${listed.since ?? "the start"}, boundary from ` +
          `${listed.sinceSource}). Pass \`since\` (ms since the epoch) as the start of the run to capture.`,
      );
    }
    const page = listed.items.slice(offset, limit === undefined ? undefined : offset + limit);

    const entries: Record<string, EnrichmentFixtureEntry> = {};
    const skippedTransport: CaptureResult["skippedTransport"] = [];
    for (let start = 0; start < page.length; start += CHUNK) {
      const chunk = page.slice(start, start + CHUNK);
      const result = await ctx.runAction(internal.adapters.wikidata.runCaptureLookups, {
        sport,
        sportQid: args.sportQid,
        items: chunk,
      });
      for (const { key, entry } of result.entries) entries[key] = entry;
      skippedTransport.push(...result.skippedTransport);
    }

    // Sorted keys, so two captures of the same deployment diff cleanly.
    const sortedEntries: Record<string, EnrichmentFixtureEntry> = {};
    for (const key of Object.keys(entries).sort()) sortedEntries[key] = entries[key];

    console.log(
      JSON.stringify({
        msg: "enrichment_fixture_capture_done",
        sportQid: args.sportQid,
        total: listed.items.length,
        offset,
        scanned: page.length,
        recorded: Object.keys(sortedEntries).length,
        skippedTransport: skippedTransport.length,
        since: listed.since,
        sinceSource: listed.sinceSource,
      }),
    );

    return {
      fixture: {
        version: FIXTURE_VERSION,
        capturedAt: new Date().toISOString(),
        sportQid: args.sportQid,
        entries: sortedEntries,
      },
      skippedTransport,
      total: listed.items.length,
      offset,
      scanned: page.length,
      since: listed.since,
      sinceSource: listed.sinceSource,
    };
  },
});

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

const coverageResultValidator = v.object({
  covered: v.number(),
  /** `${kind}: ${name}` for each looked-up name the committed fixture lacks. */
  missing: v.array(v.string()),
  /** Looked-up names considered: `covered + missing.length`. */
  total: v.number(),
  /**
   * True when a source was cut at `MAX_ROWS_PER_SOURCE`: `covered`/`missing`
   * then describe only the rows read, and `truncatedSources` names the cut
   * sources. Reported, never thrown — the report must not fail the job.
   */
  truncated: v.boolean(),
  truncatedSources: v.array(v.string()),
  /** The boundary the name list used — see the header. */
  since: v.union(v.number(), v.null()),
  sinceSource: sinceSourceValidator,
});

type CoverageResult = Infer<typeof coverageResultValidator>;

/**
 * Which of the names this deployment's runs looked up (`listLookedUpNames`)
 * the COMMITTED fixture answers. Reads the file regardless of the fixture
 * switch — the question is about the repo, not about this deployment's
 * configuration — and makes no outbound request. Internal + the confirm
 * literal, no env arming (see the header).
 *
 * `missing` is the staleness signal: a name a run asked about that the
 * recording would have sent live. A truncated list is still reported, with
 * `truncated`/`truncatedSources` set, never silently and never as a throw.
 */
export const coverageReportFromCli = internalAction({
  args: { confirm: confirmValidator, sportQid: v.string(), since: v.optional(v.number()) },
  returns: coverageResultValidator,
  handler: async (ctx, args): Promise<CoverageResult> => {
    assertConfirmed(args.confirm);
    const { sportId } = await ctx.runQuery(internal.enrichmentFixtures.resolveSportByQid, {
      sportQid: args.sportQid,
    });
    const listed = await ctx.runQuery(internal.enrichmentFixtures.listLookedUpNames, {
      sportId,
      ...(args.since === undefined ? {} : { since: args.since }),
    });

    let covered = 0;
    const missing: string[] = [];
    for (const item of listed.items) {
      if (hasFixtureEntry(item.kind, args.sportQid, item.name)) covered += 1;
      else missing.push(`${item.kind}: ${item.name}`);
    }
    console.log(
      JSON.stringify({
        msg: "enrichment_fixture_coverage",
        sportQid: args.sportQid,
        covered,
        missing: missing.length,
        truncated: listed.truncated,
        truncatedSources: listed.truncatedSources,
        since: listed.since,
        sinceSource: listed.sinceSource,
      }),
    );
    return {
      covered,
      missing,
      total: listed.items.length,
      truncated: listed.truncated,
      truncatedSources: listed.truncatedSources,
      since: listed.since,
      sinceSource: listed.sinceSource,
    };
  },
});
