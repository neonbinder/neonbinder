/**
 * NEO-289 — capture and audit the recorded enrichment lookups.
 *
 * The recording itself, the switch that lets a deployment read it, and the
 * one key normaliser live in `adapters/enrichmentFixtures.ts`; the lookup
 * wrappers that consult it are in `adapters/wikidata.ts`. This module is the
 * operator's side: two `npx convex run` entry points that produce the file
 * and report what it does not cover.
 *
 * ## Which names
 *
 * Two sources, unioned and deduped by `fixtureKey`; no new table.
 *
 * (a) The deployment's `players`, `teams` and `leagues` rows for the sport —
 *     after the seed has committed, these ARE the names the wizard confirmed.
 *     A team's name is its COMPOSED full name (`teamFullName`), because that
 *     is what the wizard hands `lookupTeamEnrichment` and what ESPN's
 *     `displayName` matches. Teams and leagues pass their stored
 *     `externalIds.wikidataId` as `knownQid`.
 * (b) The `entityReviewQueue` rows for the sport. The seed's names exist as
 *     queue rows the moment the wizard opens, whether or not it ever reaches
 *     "Confirm & Save" — and on a deployment where the seed stalled at
 *     exactly the lookups this recording is meant to replace, (a) is empty
 *     while (b) holds every name that stalled it. For a queue row `knownQid`
 *     is `source.wikidataId` when present (a career team or league staged off
 *     a Wikidata statement — the id the live path would read), else
 *     `enrichment.wikidataId` when the lookup already answered.
 *
 * In both cases the id is the same linkage the wizard's own lookup uses, so
 * the recording reads the record the row is linked to rather than searching
 * for its label.
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
 * reads the committed file and the deployment's names, writes nothing and
 * makes no outbound call, and CI runs it after every seed on a preview whose
 * env it cannot set per invocation — so it is deliberately NOT env-armed
 * (security audit, 2026-09-20).
 *
 * ## Running it
 *
 *     npx convex env set ALLOW_ENRICHMENT_FIXTURE_CAPTURE true
 *     npx convex run enrichmentFixtures:captureFromCli \
 *       '{"confirm":"CAPTURE_ENRICHMENT_FIXTURES","sportQid":"Q5369"}' \
 *       | jq .fixture > convex/adapters/__fixtures__/enrichment-lookups.json
 *     npx convex env remove ALLOW_ENRICHMENT_FIXTURE_CAPTURE
 *     npx convex run enrichmentFixtures:coverageReportFromCli \
 *       '{"confirm":"CAPTURE_ENRICHMENT_FIXTURES","sportQid":"Q5369"}'
 *
 * `offset`/`limit` page the name list when a single run would outlast the
 * CLI's wait; merge the pages' `entries` objects by hand (keys are unique
 * across pages). `skippedTransport` lists names whose lookup did not
 * complete — a timeout, a 429, ESPN down — and which were therefore NOT
 * recorded as no-match; re-run for those once the source recovers.
 *
 * Runs in the V8 runtime (no `"use node"`) so the two queries below can live
 * beside the actions; the live lookups are reached through
 * `internal.adapters.wikidata.runCaptureLookups`, the node half.
 */

import { ConvexError, v, type Infer } from "convex/values";
import { internalAction, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
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
 * Per-table ceiling on the names a capture will read. A seeded preview holds
 * a few hundred; a deployment past this has been bulk-loaded and is the wrong
 * place to capture from (the recording is for the seed's names, and a
 * 20k-row capture would be a day of Wikidata traffic for nothing).
 */
const MAX_ROWS_PER_TABLE = 5_000;

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

/**
 * Every name the deployment holds for the sport — entity rows AND review-queue
 * rows (see the header) — as the lookups would be asked for it, deduped by
 * `fixtureKey` (an entity row wins over a queue row for the same key), in a
 * stable order (kind, then name by code point) so `offset`/`limit` paging is
 * repeatable across calls.
 *
 * `entityReviewQueue` has no `sportId` index (its reads are per set and per
 * batch), so it is a bounded whole-table scan filtered in memory, under the
 * same 5 000-row refusal as the entity tables. The rows are per-batch
 * throwaways swept after commit, so the table is small on any deployment a
 * capture should run against.
 */
export const listCaptureNames = internalQuery({
  args: { sportId: v.id("selectorOptions") },
  returns: v.object({ items: v.array(captureItemValidator), truncated: v.boolean() }),
  handler: async (ctx, args): Promise<{ items: CaptureItem[]; truncated: boolean }> => {
    const queueRows = await ctx.db.query("entityReviewQueue").take(MAX_ROWS_PER_TABLE + 1);
    const players = await ctx.db
      .query("players")
      .withIndex("by_sport_id", (q) => q.eq("sportId", args.sportId))
      .take(MAX_ROWS_PER_TABLE + 1);
    const teams = await ctx.db
      .query("teams")
      .withIndex("by_sport_id", (q) => q.eq("sportId", args.sportId))
      .take(MAX_ROWS_PER_TABLE + 1);
    const leagues = await ctx.db
      .query("leagues")
      .withIndex("by_sport_id", (q) => q.eq("sportId", args.sportId))
      .take(MAX_ROWS_PER_TABLE + 1);
    const truncated = [players, teams, leagues, queueRows].some(
      (rows) => rows.length > MAX_ROWS_PER_TABLE,
    );

    const knownQidOf = (id: string | undefined): { knownQid: string } | Record<never, never> =>
      id && isWikidataQid(id) ? { knownQid: id } : {};

    const fromEntities: CaptureItem[] = [
      ...players.slice(0, MAX_ROWS_PER_TABLE).map((row): CaptureItem => ({ kind: "player", name: row.name })),
      ...teams.slice(0, MAX_ROWS_PER_TABLE).map(
        (row): CaptureItem => ({
          kind: "team",
          name: teamFullName(row),
          ...knownQidOf(row.externalIds?.wikidataId),
        }),
      ),
      ...leagues.slice(0, MAX_ROWS_PER_TABLE).map(
        (row): CaptureItem => ({
          kind: "league",
          name: row.name,
          ...knownQidOf(row.externalIds?.wikidataId),
        }),
      ),
    ];
    const fromQueue: CaptureItem[] = queueRows
      .slice(0, MAX_ROWS_PER_TABLE)
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

    // Union, deduped by fixture key. Entity rows are listed first and win.
    // Every item here is the same sport, so the key's sport segment is a
    // constant and an empty one dedupes exactly as the real QID would.
    const byKey = new Map<string, CaptureItem>();
    for (const item of [...fromEntities, ...fromQueue]) {
      const key = fixtureKey(item.kind, "", item.name);
      if (!byKey.has(key)) byKey.set(key, item);
    }
    const items = [...byKey.values()];
    items.sort((a, b) => {
      const byKind = KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
      if (byKind !== 0) return byKind;
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });
    return { items, truncated };
  },
});

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

const captureResultValidator = v.object({
  fixture: fixtureFileValidator,
  skippedTransport: v.array(captureSkipValidator),
  /** Names on the deployment for the sport, before paging. */
  total: v.number(),
  offset: v.number(),
  /** Names this call looked up (recorded + skipped). */
  scanned: v.number(),
});

type CaptureResult = Infer<typeof captureResultValidator>;

/**
 * Record the live lookup answer for every name on the deployment.
 *
 * Bypasses the fixture switch by construction: `runCaptureLookups` calls the
 * `*Live` bodies, so a deployment that already reads fixtures still captures
 * fresh answers. Writes nothing to the database; the return value IS the
 * output, for the developer to write to the file and commit.
 */
export const captureFromCli = internalAction({
  args: {
    confirm: confirmValidator,
    sportQid: v.string(),
    offset: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  returns: captureResultValidator,
  handler: async (ctx, args): Promise<CaptureResult> => {
    assertCaptureArmed(args.confirm);
    const offset = Math.max(0, Math.floor(args.offset ?? 0));
    const limit = args.limit === undefined ? undefined : Math.max(0, Math.floor(args.limit));

    const { sportId, sport } = await ctx.runQuery(internal.enrichmentFixtures.resolveSportByQid, {
      sportQid: args.sportQid,
    });
    const listed = await ctx.runQuery(internal.enrichmentFixtures.listCaptureNames, { sportId });
    if (listed.truncated) {
      throw new ConvexError(
        `More than ${MAX_ROWS_PER_TABLE} rows in a table for this sport; capture from a seeded preview, not a bulk-loaded deployment.`,
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
    };
  },
});

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

const coverageResultValidator = v.object({
  covered: v.number(),
  /** `${kind}: ${name}` for each deployment name the committed fixture lacks. */
  missing: v.array(v.string()),
});

type CoverageResult = Infer<typeof coverageResultValidator>;

/**
 * Which of the deployment's names the COMMITTED fixture answers. Reads the
 * file regardless of the fixture switch — the question is about the repo,
 * not about this deployment's configuration — and makes no outbound request.
 * Internal + the confirm literal, no env arming (see the header).
 */
export const coverageReportFromCli = internalAction({
  args: { confirm: confirmValidator, sportQid: v.string() },
  returns: coverageResultValidator,
  handler: async (ctx, args): Promise<CoverageResult> => {
    assertConfirmed(args.confirm);
    const { sportId } = await ctx.runQuery(internal.enrichmentFixtures.resolveSportByQid, {
      sportQid: args.sportQid,
    });
    const listed = await ctx.runQuery(internal.enrichmentFixtures.listCaptureNames, { sportId });

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
      }),
    );
    return { covered, missing };
  },
});
