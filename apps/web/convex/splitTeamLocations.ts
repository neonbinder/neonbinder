/**
 * NEO-236 — the one-shot backfill that splits `teams.name` into
 * `location` + `name`.
 *
 * Before NEO-236 a team row held the whole franchise name in `name` ("San
 * Diego Padres"). After it, `name` is the nickname ("Padres") and `location`
 * is the optional place part ("San Diego"). Every row that existed before the
 * split still holds the whole string, and nothing in the app rewrites it —
 * `applyEnrichmentInternal` gap-fills only, and no creation path touches an
 * existing row. This task is what walks the table once and applies the split.
 *
 * ## Operator commands
 *
 *   # 1. arm the deployment (prod arms for the run and disarms after)
 *   npx convex env set ALLOW_SPLIT_TEAM_LOCATIONS true --prod
 *
 *   # 2. dry run — reports exactly what a real run would do, patches nothing
 *   npx convex run splitTeamLocations:run '{"confirm":"SPLIT","dryRun":true}' --prod
 *
 *   # 3. for real
 *   npx convex run splitTeamLocations:run '{"confirm":"SPLIT","dryRun":false}' --prod
 *
 *   # 4. disarm, in the same sitting
 *   npx convex env remove ALLOW_SPLIT_TEAM_LOCATIONS --prod
 *
 * Full runbook: `docs/operations/neo236-split-team-locations.md`.
 *
 * DO NOT ADD `--identity`. It does not authorise this and it BREAKS it:
 * `convex run --identity` routes the call through the path that resolves
 * PUBLIC functions only, so an `internalAction` comes back "Could not find
 * function" (NEO-214 learned this the hard way in CI). There is no user
 * identity on a CLI run and none is wanted — reaching an internal function at
 * all required the deployment's own admin credential, and reaching `--prod`
 * required prod deploy credentials. That is the real boundary; the arming flag
 * is the "arm before you fire" friction on top of it.
 *
 * ## ESPN is the ONLY source, and the task never guesses
 *
 * Jason, 2026-09-05: no code path may invent a location. A first-token
 * heuristic would turn "Nippon-Ham Fighters" into ("Nippon-Ham", "Fighters")
 * and "San Diego State Aztecs men's basketball" into a college side located in
 * San Diego — both wrong, both unreviewable once written. So the split is
 * applied only where ESPN's own per-league team list names a team whose
 * display name is *the same team* (identical dedup key) and whose `location`
 * corresponds to a leading run of whole words in the row's name — either
 * character-for-character, or by word-boundary equivalence when only the
 * punctuation differs (`splitTeamNameAtEquivalentPrefix`). Everything else is
 * left whole and LISTED in the result for an operator to split by hand on
 * `/admin/teams`.
 *
 * Wikidata is deliberately not consulted: its P159/P131 values are corporate
 * headquarters, not team locations — dev's rows read "Nishi-Shinjuku" for the
 * Chiba Lotte Marines and "Aichi Prefecture" for the Chunichi Dragons.
 *
 * ## Why splitting cannot change a dedup key
 *
 * `normalizeTeamName` token-SORTS, so "San Diego Padres" and
 * ("San Diego", "Padres") normalise identically (see lib/teams/team-name.ts).
 * Every patch here therefore recomputes the key through `teamRowFields` and
 * ASSERTS it came out unchanged; a mismatch aborts the whole batch rather than
 * writing a row that would dedupe as a second team.
 *
 * A row whose stored `nameNormalized` does not already match its own name is
 * NEVER touched (`skipped_key_mismatch`). Such a key was written by hand or by
 * something that predates `teamRowFields`, and re-deriving it here would
 * silently repoint every card that resolves through it.
 *
 * ## Idempotent
 *
 * A second run reports every row it split as `skipped_already_split` (a row
 * carrying a `location` is finished, by definition) and writes nothing.
 */

import { ConvexError, v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { fetchEspnTeamList } from "./adapters/espn";
import { normalizeEntityName } from "./lib/entityNearMatch";
import { teamRowFields } from "./lib/teamRow";
import { splitTeamName, teamFullName } from "../lib/teams/team-name";

/**
 * Rows per batch mutation. `teams` is ~80 rows on both deployments today, so
 * this is one or two batches; the loop exists for the same reason NEO-214's
 * does — a single mutation has a per-execution read limit, and the table only
 * grows (MiLB, defunct franchises, colleges).
 */
const BATCH_SIZE = 50;

/**
 * A guard against a cursor that never advances. `teams` would have to grow
 * past 50,000 rows for a legitimate run to reach this, and a run that spins
 * forever against production is worse than one that stops and says so.
 */
const MAX_BATCHES = 1000;

/**
 * The arming check, asserted at BOTH layers — the entry point and every batch
 * mutation it loops.
 *
 * The duplication is the point, and it is the same argument NEO-214's
 * `assertResetArmed` documents: there is no identity check anywhere under this
 * entry point (a CLI run carries none), so the flag is the only thing standing
 * between a call and a rewritten `teams` table. Asserting solely at the entry
 * point would let a future internal caller — a migration, a cron, a
 * well-meaning `ctx.runMutation` — patch every team row by going straight to
 * the batch. So the check sits next to the writes.
 *
 * Asserted on a DRY RUN too. A dry run writes nothing, but it does hit ESPN
 * once per league and walk the whole table, and keeping one gate rather than
 * two ("armed for writes, unarmed for reads") is what makes the rule easy to
 * state and impossible to get subtly wrong later.
 *
 * `ConvexError` rather than `Error`: production Convex REDACTS a plain `Error`
 * message, and the entire point of this refusal is to name the flag you have
 * to set.
 */
function assertSplitArmed(): void {
  if (process.env.ALLOW_SPLIT_TEAM_LOCATIONS !== "true") {
    throw new ConvexError(
      "The team location split is not armed on this deployment. Set " +
        "ALLOW_SPLIT_TEAM_LOCATIONS=true on it first " +
        "(`npx convex env set ALLOW_SPLIT_TEAM_LOCATIONS true`), and unset it " +
        "again afterwards on production.",
    );
  }
}

/**
 * The punctuation fallback: split at the same WORD BOUNDARY ESPN used, keeping
 * OUR spelling of the place.
 *
 * `splitTeamName` (lib/teams/team-name.ts) compares raw characters, which is
 * exactly right for deciding "is this string the front of that one" and exactly
 * wrong for the case prod actually holds: our row reads "St Louis Blues" and
 * ESPN spells the place "St. Louis". The two are the same team — they share a
 * dedup key, which is how we found the ESPN entry at all — but the character
 * comparison fails on the period and the row would sit in `skipped_not_prefix`
 * forever.
 *
 * The rule, and it is a rule rather than a judgement:
 *
 *   N = the word count of ESPN's location (2 for "St. Louis")
 *   take the first N whitespace-separated words of OUR name ("St Louis")
 *   accept ONLY if those words normalise to what ESPN's location normalises to
 *
 * `normalizeEntityName` is the same function that decides two team names are
 * the same row, so "these N words ARE that place" is settled by the codebase's
 * existing notion of name equality, not by a new one invented here.
 *
 * Two properties this must have, both pinned by tests:
 *
 * - **Our spelling wins.** The returned location is the words as OUR row spells
 *   them ("St Louis"), never ESPN's ("St. Louis"). Writing ESPN's punctuation
 *   onto a row an operator typed would be a rename wearing a split's clothes,
 *   and the whole task exists to not do that. It also keeps the recomposed full
 *   name byte-identical to what the row already held, which is what makes the
 *   dedup-key assertion downstream trivially true.
 * - **It still refuses a real mismatch.** "Yankees, New York" against ESPN's
 *   "New York": the first two words are "Yankees, New", which normalise to
 *   "new yankees" — not "new york" — so this returns null and the row is
 *   reported rather than mangled. Word COUNT alone is never enough; the
 *   equivalence check is what makes this exact instead of a guess.
 *
 * Returns null when the counts leave nothing for the nickname, so a row whose
 * whole name is the location is never emptied.
 */
function splitTeamNameAtEquivalentPrefix(
  fullName: string,
  location: string,
): { location: string; name: string } | null {
  const full = fullName.trim().replace(/\s+/g, " ");
  const loc = location.trim().replace(/\s+/g, " ");
  if (!full || !loc) return null;

  const locWords = loc.split(" ");
  const fullWords = full.split(" ");
  // Strictly fewer, so something is always left to be the nickname.
  if (fullWords.length <= locWords.length) return null;

  const prefix = fullWords.slice(0, locWords.length).join(" ");
  const name = fullWords.slice(locWords.length).join(" ");
  if (!name) return null;

  const prefixKey = normalizeEntityName(prefix);
  if (prefixKey.length === 0 || prefixKey !== normalizeEntityName(loc)) return null;

  // `prefix`, not `loc`: our spelling, never ESPN's.
  return { location: prefix, name };
}

/**
 * What happened to one row. Every row lands in exactly one of these, and the
 * counts sum to the number of rows scanned.
 */
type Outcome =
  /** Already carries a `location` — split by an earlier run or by hand. */
  | "skipped_already_split"
  /** ESPN named the place part and it is a whole-word prefix. Patched. */
  | "split_espn"
  /**
   * No ESPN team in this row's sport shares its dedup key: colleges, NPB/KBO,
   * minor-league affiliates, E2E leftovers, and every row in a sport with no
   * `sportConfig.espn` or whose league list did not come back. Listed by name
   * so an operator can split it by hand.
   */
  | "skipped_no_source"
  /**
   * ESPN matched the team, but its `location` does not correspond to any
   * leading run of words in our name — ESPN says "Los Angeles" where our row
   * reads "LA Angels", or "New York" against "Yankees, New York". Both the
   * character-exact prefix and the word-boundary equivalence fallback said no.
   * Never forced: splitting anyway would produce a name nobody wrote. Listed
   * with ESPN's answer so the hand split is one glance rather than a lookup.
   *
   * A pure punctuation difference ("St. Louis" against a row reading "St Louis
   * Blues") does NOT land here — see `splitTeamNameAtEquivalentPrefix`.
   */
  | "skipped_not_prefix"
  /**
   * The row's stored `nameNormalized` is not what its own name normalises to.
   * A hand-written or legacy key — repairing it is not this task's job and
   * doing it silently would repoint everything that resolves through it.
   */
  | "skipped_key_mismatch";

type Counts = Record<Outcome, number> & { scanned: number };

function emptyCounts(): Counts {
  return {
    scanned: 0,
    skipped_already_split: 0,
    split_espn: 0,
    skipped_no_source: 0,
    skipped_not_prefix: 0,
    skipped_key_mismatch: 0,
  };
}

/** A row this task declined to split, with enough to hand-split it. */
type NoSourceRow = { name: string; sport: string };
type NotPrefixRow = { name: string; sport: string; espnLocation: string };

/**
 * `applyBatch`'s return, spelled out.
 *
 * The explicit types on this and `SplitRunResult` are not decoration: `run`
 * calls `applyBatch` and `listSportsForSplit` from the SAME module, and
 * Convex's generated `internal` object makes that a circular inference for
 * TypeScript unless the handlers annotate what they return.
 */
type ApplyBatchResult = {
  counts: Counts;
  isDone: boolean;
  continueCursor: string;
  noSource: NoSourceRow[];
  notPrefix: NotPrefixRow[];
  keyMismatch: string[];
};

type SportForSplit = {
  sportId: Id<"selectorOptions">;
  sport: string;
  espn?: { path: string; leagueName: string };
};

type SplitRunResult = {
  dryRun: boolean;
  counts: Counts;
  espnLeagues: Array<{ sport: string; teams: number | null }>;
  noSource: NoSourceRow[];
  notPrefix: NotPrefixRow[];
  keyMismatch: string[];
};

/** One sport's ESPN answer, as handed to each batch. */
const espnSportValidator = v.object({
  sportId: v.id("selectorOptions"),
  /** The sport row's display label, used only for the report. */
  sport: v.string(),
  /**
   * ESPN's current teams for this sport, keyed the way `teams.nameNormalized`
   * is keyed. Empty when the sport has no `sportConfig.espn`, when the fetch
   * failed, or when every entry was ambiguous — all of which read as "no
   * source" for every row in that sport, never as a licence to guess.
   */
  teams: v.array(
    v.object({
      displayNameNormalized: v.string(),
      location: v.string(),
    }),
  ),
});

const countsValidator = v.object({
  scanned: v.number(),
  skipped_already_split: v.number(),
  split_espn: v.number(),
  skipped_no_source: v.number(),
  skipped_not_prefix: v.number(),
  skipped_key_mismatch: v.number(),
});

/**
 * Read-only: the sport rows, with whatever ESPN league each carries.
 *
 * Keyed exactly the way `selectorOptions.getSportEnrichmentContext` keys it —
 * off the ROW's `sportConfig.espn`, never off a display-name map — so this
 * task can never disagree with what enrichment would have looked up. No
 * arming check: it reads and returns nothing sensitive, and the write path is
 * gated where the writes are.
 */
export const listSportsForSplit = internalQuery({
  args: {},
  returns: v.array(
    v.object({
      sportId: v.id("selectorOptions"),
      sport: v.string(),
      espn: v.optional(v.object({ path: v.string(), leagueName: v.string() })),
    }),
  ),
  handler: async (ctx) => {
    // One row per sport — four in a seeded deployment. Cannot approach the
    // document budget.
    const rows = await ctx.db
      .query("selectorOptions")
      .withIndex("by_level", (q) => q.eq("level", "sport"))
      .collect();
    return rows.map((row) => ({
      sportId: row._id,
      sport: row.value,
      ...(row.sportConfig?.espn ? { espn: row.sportConfig.espn } : {}),
    }));
  },
});

/**
 * One page of `teams`, classified and (unless `dryRun`) patched.
 *
 * Separate from the driver because the ESPN fetches belong in an action and
 * the patches belong in a mutation. It re-asserts the arming flag as its first
 * statement — see `assertSplitArmed`.
 *
 * Paginates the table in creation order with no index: a patch never moves a
 * row, so the cursor stays valid across the whole walk.
 */
export const applyBatch = internalMutation({
  args: {
    dryRun: v.boolean(),
    cursor: v.union(v.string(), v.null()),
    espn: v.array(espnSportValidator),
  },
  returns: v.object({
    counts: countsValidator,
    isDone: v.boolean(),
    continueCursor: v.string(),
    noSource: v.array(v.object({ name: v.string(), sport: v.string() })),
    notPrefix: v.array(
      v.object({ name: v.string(), sport: v.string(), espnLocation: v.string() }),
    ),
    keyMismatch: v.array(v.string()),
  }),
  handler: async (ctx, args): Promise<ApplyBatchResult> => {
    // First statement, before any read of `teams` and long before any patch.
    assertSplitArmed();

    // sportId → { label, teams keyed by normalised display name }.
    const bySport = new Map<
      string,
      { sport: string; locations: Map<string, string> }
    >();
    for (const entry of args.espn) {
      bySport.set(entry.sportId as unknown as string, {
        sport: entry.sport,
        locations: new Map(
          entry.teams.map((t) => [t.displayNameNormalized, t.location]),
        ),
      });
    }

    const page = await ctx.db
      .query("teams")
      .paginate({ cursor: args.cursor, numItems: BATCH_SIZE });

    const counts = emptyCounts();
    const noSource: NoSourceRow[] = [];
    const notPrefix: NotPrefixRow[] = [];
    const keyMismatch: string[] = [];

    for (const row of page.page) {
      counts.scanned += 1;
      const sportInfo = bySport.get(row.sportId as unknown as string);
      // A sport row that vanished between the action's read and this batch.
      // Reported rather than skipped silently.
      const sport = sportInfo?.sport ?? "(unknown sport)";

      // 1. Finished already. `location` is the marker: a split row has one, an
      //    unsplit row does not, and that is what makes a re-run a no-op.
      if (row.location !== undefined && row.location !== "") {
        counts.skipped_already_split += 1;
        continue;
      }

      const fullName = teamFullName(row);
      const currentKey = normalizeEntityName(fullName);

      // 2. The stored key disagrees with the row's own name. Do not touch it —
      //    see the module docblock.
      if (row.nameNormalized !== currentKey) {
        counts.skipped_key_mismatch += 1;
        keyMismatch.push(row.name);
        continue;
      }

      // 3. Ask ESPN — by dedup key, so punctuation and word order cannot cause
      //    a miss between "St. Louis Blues" and "Blues, St Louis".
      const espnLocation = sportInfo?.locations.get(currentKey);
      if (espnLocation === undefined) {
        counts.skipped_no_source += 1;
        noSource.push({ name: row.name, sport });
        continue;
      }

      // 4. Mechanical, whole-word, case-insensitive prefix first; then the
      //    word-boundary equivalence fallback for the case where the two spell
      //    the place differently ("St. Louis" vs "St Louis"). Neither decides
      //    anything — both answer "is this place the front of that name", and
      //    a null from both means the answer is no. Never forced.
      const split =
        splitTeamName(row.name, espnLocation) ??
        splitTeamNameAtEquivalentPrefix(row.name, espnLocation);
      if (!split) {
        counts.skipped_not_prefix += 1;
        notPrefix.push({ name: row.name, sport, espnLocation });
        continue;
      }

      const fields = teamRowFields({ name: split.name, location: split.location });

      // 5. The invariant, asserted rather than assumed. `normalizeTeamName`
      //    token-sorts so this cannot fail — which is exactly why a failure
      //    means something upstream changed and the run must stop, not carry
      //    on writing rows that would dedupe as new teams. Throwing aborts the
      //    whole batch transactionally; nothing in it lands.
      if (fields.nameNormalized !== row.nameNormalized) {
        throw new ConvexError(
          `Refusing to split "${row.name}" at "${espnLocation}": the dedup key ` +
            `would change from "${row.nameNormalized}" to ` +
            `"${fields.nameNormalized}". No row was modified.`,
        );
      }

      if (!args.dryRun) {
        await ctx.db.patch(row._id, {
          name: fields.name,
          location: fields.location,
          nameNormalized: fields.nameNormalized,
          lastUpdated: Date.now(),
        });
      }
      counts.split_espn += 1;
    }

    console.log(
      JSON.stringify({
        msg: "split_team_locations_batch",
        dryRun: args.dryRun,
        ...counts,
        isDone: page.isDone,
      }),
    );

    return {
      counts,
      isDone: page.isDone,
      continueCursor: page.continueCursor,
      noSource,
      notPrefix,
      keyMismatch,
    };
  },
});

/**
 * The ONLY entry point. Fetches each sport's ESPN team list once, then loops
 * `applyBatch` over `teams` until the table is drained.
 *
 * `confirm: "SPLIT"` because `convex run` is one tab-completion away from a
 * neighbouring function name, and this rewrites the identity fields of every
 * team row on the deployment it is pointed at.
 */
export const run = internalAction({
  args: {
    confirm: v.literal("SPLIT"),
    /** Report what would change without writing anything. */
    dryRun: v.boolean(),
  },
  returns: v.object({
    dryRun: v.boolean(),
    counts: countsValidator,
    /**
     * How many current teams ESPN returned per sport. `null` means the sport
     * has no `sportConfig.espn`, or the fetch failed — and then EVERY row in
     * that sport lands in `noSource`. Reported because the difference between
     * "these rows genuinely have no source" and "ESPN was down for four
     * seconds" is invisible in the counts alone, and the second one is a
     * re-run, not 32 hand splits.
     */
    espnLeagues: v.array(
      v.object({ sport: v.string(), teams: v.union(v.number(), v.null()) }),
    ),
    noSource: v.array(v.object({ name: v.string(), sport: v.string() })),
    notPrefix: v.array(
      v.object({ name: v.string(), sport: v.string(), espnLocation: v.string() }),
    ),
    keyMismatch: v.array(v.string()),
  }),
  handler: async (ctx, args): Promise<SplitRunResult> => {
    // Fail here rather than partway through the loop, so an unarmed run costs
    // nothing — not even the ESPN fetches. Each batch re-asserts independently.
    assertSplitArmed();
    // No identity check here or in the batch below: reaching an internalAction
    // at all required the deployment's admin credential. See the docblock.

    const sports: SportForSplit[] = await ctx.runQuery(
      internal.splitTeamLocations.listSportsForSplit,
      {},
    );

    const espn: Array<{
      sportId: Id<"selectorOptions">;
      sport: string;
      teams: Array<{ displayNameNormalized: string; location: string }>;
    }> = [];
    const espnLeagues: Array<{ sport: string; teams: number | null }> = [];

    for (const sportRow of sports) {
      // `fetchEspnTeamList` memoises successes for the isolate's lifetime, so
      // a sport appearing twice costs one request. It is no-throw: an unmapped
      // sport or a failed fetch is `null`, which becomes an empty list here and
      // "no source" for every row in that sport.
      const list = sportRow.espn ? await fetchEspnTeamList(sportRow.espn) : null;
      espnLeagues.push({ sport: sportRow.sport, teams: list ? list.length : null });

      // Ambiguity is dropped, not resolved. If two ESPN entries in one league
      // normalise to the same key with DIFFERENT locations, there is no answer
      // to "where is this team", and picking one would be exactly the guess
      // this task refuses to make.
      const locations = new Map<string, string>();
      const ambiguous = new Set<string>();
      for (const entry of list ?? []) {
        if (!entry.displayName || !entry.location) continue;
        const key = normalizeEntityName(entry.displayName);
        if (key.length === 0) continue;
        const seen = locations.get(key);
        if (seen !== undefined && seen !== entry.location) {
          ambiguous.add(key);
          continue;
        }
        locations.set(key, entry.location);
      }
      for (const key of ambiguous) locations.delete(key);

      espn.push({
        sportId: sportRow.sportId,
        sport: sportRow.sport,
        teams: [...locations].map(([displayNameNormalized, location]) => ({
          displayNameNormalized,
          location,
        })),
      });
    }

    const counts = emptyCounts();
    const noSource: NoSourceRow[] = [];
    const notPrefix: NotPrefixRow[] = [];
    const keyMismatch: string[] = [];

    let cursor: string | null = null;
    for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
      const result: ApplyBatchResult = await ctx.runMutation(
        internal.splitTeamLocations.applyBatch,
        {
          dryRun: args.dryRun,
          cursor,
          espn,
        },
      );
      for (const key of Object.keys(counts) as Array<keyof Counts>) {
        counts[key] += result.counts[key];
      }
      noSource.push(...result.noSource);
      notPrefix.push(...result.notPrefix);
      keyMismatch.push(...result.keyMismatch);
      if (result.isDone) break;
      cursor = result.continueCursor;
    }

    console.log(
      JSON.stringify({
        msg: "split_team_locations_done",
        dryRun: args.dryRun,
        ...counts,
        espnLeagues,
      }),
    );

    return { dryRun: args.dryRun, counts, espnLeagues, noSource, notPrefix, keyMismatch };
  },
});
