/**
 * NEO-254 — bulk-preload players and teams from the committed datasets.
 *
 * ## Operator command
 *
 *   # 0. arm the deployment (and DISARM it again afterwards on production)
 *   npx convex env set ALLOW_PRELOAD_PLAYERS true
 *
 *   # 1. dry run — reports what it WOULD do, writes nothing
 *   npx convex run preloadPlayers:run '{"sport":"baseball","confirm":"PRELOAD","dryRun":true}'
 *
 *   # 2. for real, one sport at a time
 *   npx convex run preloadPlayers:run '{"sport":"baseball","confirm":"PRELOAD"}'
 *   npx convex run preloadPlayers:run '{"sport":"football","confirm":"PRELOAD"}'
 *
 *   # resume where a run stopped (the summary prints `nextStart`)
 *   npx convex run preloadPlayers:run '{"sport":"baseball","confirm":"PRELOAD","start":12800}'
 *
 * Runbook: `docs/operations/neo254-player-preload.md`.
 *
 * No `--identity`: this is an `internalAction`, unreachable from any client, so
 * it carries no `requireAdmin` that an identity would satisfy — and
 * `convex run --identity` resolves PUBLIC functions only, so passing it breaks
 * the call outright. Same reasoning as `selectorOptions:resetSetBuilderDataFromCli`.
 *
 * ## Why a scripted admin task rather than a button
 *
 * Standing rule from NEO-214: a bulk data operation is something an operator
 * runs deliberately and reads the output of. This one writes tens of thousands
 * of globally-shared reference rows; a misdirected click should not be able to
 * start it, and the operator should see a dry run first.
 *
 * ## What it is NOT
 *
 * Not a source of truth (product invariant). Lahman and nflverse seed a row at
 * creation and their id is kept so a re-run finds the row it made last time.
 * After that:
 *
 *  - It NEVER overwrites. An existing team keeps its league and years; an
 *    existing player keeps its name, career and Hall-of-Fame flag. Only fields
 *    that are ABSENT are filled in.
 *  - It never deletes or renames anything.
 *  - Nothing user-facing keys on a dataset value. The ids are linkage only.
 *
 * ## Safe to re-run, and it converges
 *
 * Every player is found by its source id on the second pass, so a re-run
 * creates nothing. A run interrupted halfway is resumed with `start`, and
 * re-running from 0 is equally safe — just slower.
 *
 * ## Ambiguity is skipped and reported, never guessed
 *
 * Lahman alone has 558 names shared by two or more players. Where the preload
 * cannot tell which existing NB row is the same person, it writes nothing and
 * says so; the operator (or the review wizard) resolves it. Same principle as
 * the card-number rule in the product invariant: no logic on a non-unique key
 * without an exactly-one-match guard.
 */

import { ConvexError, v } from "convex/values";
import { internalAction, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { findOrCreateLeague, normalizeLeagueName, resolveDefaultLeagueId } from "./leagues";
import { normalizeTeamName } from "./teams";
import { normalizePlayerName } from "./players";
import { sortTeamYears } from "../lib/players/team-tenure";
import type { TransactionMetrics } from "convex/server";
import type { PreloadFile } from "../lib/players/preload/preload-shape";

// The ONLY module allowed to import these. They are ~5.9 MB together and
// Convex bundles per module, so an import anywhere else would put the whole
// dataset into an unrelated function's bundle. Regenerate with
// `node scripts/build-preload-data.mjs`; see data/preload/README.md.
import mlbData from "../data/preload/mlb.json";
import nflData from "../data/preload/nfl.json";

/** The sports this task can load, and the dataset behind each. */
const PRELOAD_DATA: Record<"baseball" | "football", PreloadFile> = {
  baseball: mlbData as unknown as PreloadFile,
  football: nflData as unknown as PreloadFile,
};

/** Which `externalIds` slot the sport's source id lives in. */
const SOURCE_ID_FIELD = {
  baseball: "lahmanId",
  football: "nflverseId",
} as const;

/**
 * Teams per mutation. 141 (MLB) / 119 (NFL) rows in total, so this is four
 * calls — small enough that an interrupted phase costs almost nothing to redo.
 */
const TEAM_CHUNK_SIZE = 40;

/**
 * Players per mutation. Each player costs one indexed read for its source id,
 * up to one more for the name lookup, and one write. Team ids are resolved
 * once per mutation and memoised, so a chunk reads at most a few hundred
 * documents against Convex's 4096 budget — and `loadPlayersChunk` re-checks
 * the real headroom as it goes and stops early rather than trusting this
 * number.
 */
const PLAYER_CHUNK_SIZE = 100;

/**
 * Stop the action and report `nextStart` after this long, so a very large load
 * never runs into the action time limit with nothing to show for it. The
 * operator re-runs with the printed `start`.
 */
const MAX_ACTION_MS = 6 * 60 * 1000;

/**
 * Matches `MAX_PLAYER_TEAM_YEARS` in `convex/players.ts` and
 * `MAX_MANUAL_CAREER_TEAMS` in `convex/entityReviewQueue.ts`. The datasets do
 * not come close (the longest real career here is 18 stints), so this only
 * exists so a future refresh cannot write an unbounded array into a
 * globally-shared row through a path with no editor in front of it.
 *
 * Truncation keeps the EARLIEST stints and reports the count: a career read
 * from its start is a career with a hole at the end, which is obvious; one
 * read from an arbitrary window is a career that silently begins in the wrong
 * decade.
 */
const MAX_TEAM_YEARS = 64;

/**
 * The arming check, asserted inside EVERY mutation below and again at the
 * action entry point.
 *
 * The duplication is deliberate, for the same reason as `assertResetArmed` in
 * `convex/selectorOptions.ts` (NEO-214 security review): there is no identity
 * on a CLI run, so this flag plus the `confirm` literal is the ONLY thing
 * between a call and tens of thousands of new rows. Checking only at the entry
 * point would let a future internal caller — a migration, a cron, a
 * well-meaning `ctx.runMutation` — reach a chunk mutation directly.
 *
 * `ConvexError` rather than `Error`: production Convex redacts a plain
 * `Error`'s message, and the whole point of this refusal is to name the flag.
 */
function assertPreloadArmed(): void {
  if (process.env.ALLOW_PRELOAD_PLAYERS !== "true") {
    throw new ConvexError(
      "The player preload is not armed on this deployment. Set " +
        "ALLOW_PRELOAD_PLAYERS=true on it first " +
        "(`npx convex env set ALLOW_PRELOAD_PLAYERS true`), and unset it " +
        "again afterwards on production.",
    );
  }
}

// ---------------------------------------------------------------------------
// Validators for the rows the action hands each mutation
// ---------------------------------------------------------------------------

const leagueArg = v.object({
  code: v.string(),
  name: v.string(),
  abbreviation: v.optional(v.string()),
  from: v.number(),
  to: v.optional(v.number()),
  default: v.optional(v.boolean()),
});

const teamArg = v.object({
  key: v.string(),
  name: v.string(),
  location: v.string(),
  nickname: v.string(),
  league: v.string(),
  from: v.number(),
  to: v.optional(v.number()),
  franchise: v.string(),
});

const playerArg = v.object({
  id: v.string(),
  name: v.string(),
  birthYear: v.optional(v.number()),
  hof: v.optional(v.boolean()),
  lowConfidence: v.optional(v.boolean()),
  // `[teamIndex, fromSeason, toSeason]`. A tuple is not expressible as a
  // validator, so the length is asserted in the handler instead.
  stints: v.array(v.array(v.number())),
});

const sportArg = v.union(v.literal("baseball"), v.literal("football"));

// ---------------------------------------------------------------------------
// Phase 1 — leagues and teams
// ---------------------------------------------------------------------------

export const loadTeamsChunk = internalMutation({
  args: {
    sport: sportArg,
    leagues: v.array(leagueArg),
    teams: v.array(teamArg),
    dryRun: v.boolean(),
  },
  returns: v.object({
    leaguesCreated: v.number(),
    teamsCreated: v.number(),
    teamsAdopted: v.number(),
    skippedNoSport: v.number(),
  }),
  handler: async (ctx, args) => {
    assertPreloadArmed();

    // Sport rows are created by the marketplace sync, never here — inventing
    // one produces a row nothing else recognises. Same rule as seedTeamColors.
    const sportRows = await ctx.db
      .query("selectorOptions")
      .withIndex("by_level", (q) => q.eq("level", "sport"))
      .collect();
    const sport = sportRows.find(
      (r) => r.value.toLowerCase().trim() === args.sport,
    );
    if (!sport) {
      return {
        leaguesCreated: 0,
        teamsCreated: 0,
        teamsAdopted: 0,
        skippedNoSport: args.teams.length,
      };
    }
    const sportId = sport._id;

    const leaguesBefore = await ctx.db
      .query("leagues")
      .withIndex("by_sport_id", (q) => q.eq("sportId", sportId))
      .collect();
    const leagueCountBefore = leaguesBefore.length;

    const leagueByCode = new Map(args.leagues.map((l) => [l.code, l]));
    const resolvedLeagues = new Map<string, Id<"leagues"> | undefined>();

    /**
     * The NB league row for a dataset league code, created on first use.
     *
     * A league flagged `default` is the sport's OWN league, so it goes through
     * `resolveDefaultLeagueId`, which derives it from `sportConfig` — the
     * preload must never mint a rival "Major League Baseball" beside the row
     * every other creation path already uses. Everything else is a real
     * historical league (the Federal League, the AAFC) and gets its own row at
     * `level: "major"`, which is what they were.
     */
    const leagueIdFor = async (code: string): Promise<Id<"leagues"> | undefined> => {
      if (resolvedLeagues.has(code)) return resolvedLeagues.get(code);
      const meta = leagueByCode.get(code);
      let id: Id<"leagues"> | undefined;
      if (!meta) {
        id = undefined;
      } else if (meta.default) {
        id = await resolveDefaultLeagueId(ctx, sportId);
        if (!id) {
          // The sport row has no configured league (a custom sport). Create
          // the dataset's league by name rather than leaving the team without
          // one — NEO-156's rule is that every created team gets a league.
          id = await findOrCreateLeague(ctx, {
            name: meta.name,
            abbreviation: meta.abbreviation,
            sportId,
            level: "major",
          });
        }
      } else {
        id = await findOrCreateLeague(ctx, {
          name: meta.name,
          abbreviation: meta.abbreviation,
          sportId,
          level: "major",
        });
      }
      resolvedLeagues.set(code, id);
      return id;
    };

    let teamsCreated = 0;
    let teamsAdopted = 0;
    // Dry-run league accounting, which cannot call the writing helper above.
    // It compares normalised NAMES only, so a league an existing row answers
    // to through an ALIAS reads here as one that would be created. The real
    // run resolves the alias and creates nothing, so this can over-count but
    // never under-count.
    const dryRunNewLeagues = new Set<string>();
    const noteDryRunLeague = (code: string) => {
      const meta = leagueByCode.get(code);
      if (!meta) return;
      const normalized = normalizeLeagueName(meta.name);
      if (leaguesBefore.some((l) => l.nameNormalized === normalized)) return;
      dryRunNewLeagues.add(meta.code);
    };

    for (const team of args.teams) {
      const nameNormalized = normalizeTeamName(team.name);
      const matches = await ctx.db
        .query("teams")
        .withIndex("by_name_normalized_and_sport_id", (q) =>
          q.eq("nameNormalized", nameNormalized).eq("sportId", sportId),
        )
        .collect();
      const existing = matches[0];

      const yearsActive = {
        from: team.from,
        ...(team.to === undefined ? {} : { to: team.to }),
      };

      if (existing) {
        teamsAdopted += 1;
        if (args.dryRun) {
          if (!existing.leagueId) noteDryRunLeague(team.league);
          continue;
        }
        // GAP-FILL ONLY. A league an operator set, or years a human corrected,
        // outrank the dataset — which is a snapshot, and is initial input
        // rather than truth.
        const patch: Record<string, unknown> = {};
        if (!existing.leagueId) {
          const leagueId = await leagueIdFor(team.league);
          if (leagueId) patch.leagueId = leagueId;
        }
        if (!existing.yearsActive) patch.yearsActive = yearsActive;
        if (Object.keys(patch).length > 0) {
          await ctx.db.patch(existing._id, { ...patch, lastUpdated: Date.now() });
        }
        continue;
      }

      teamsCreated += 1;
      if (args.dryRun) {
        noteDryRunLeague(team.league);
        continue;
      }

      await ctx.db.insert("teams", {
        name: team.name,
        nameNormalized,
        sportId,
        // NEO-156: every creation path attaches a league.
        leagueId: await leagueIdFor(team.league),
        yearsActive,
        lastUpdated: Date.now(),
      });
    }

    if (args.dryRun) {
      return {
        leaguesCreated: dryRunNewLeagues.size,
        teamsCreated,
        teamsAdopted,
        skippedNoSport: 0,
      };
    }

    const leagueCountAfter = (
      await ctx.db
        .query("leagues")
        .withIndex("by_sport_id", (q) => q.eq("sportId", sportId))
        .collect()
    ).length;

    return {
      leaguesCreated: leagueCountAfter - leagueCountBefore,
      teamsCreated,
      teamsAdopted,
      skippedNoSport: 0,
    };
  },
});

// ---------------------------------------------------------------------------
// Phase 2 — players
// ---------------------------------------------------------------------------

/**
 * Which existing row (if any) is the player the dataset is describing.
 *
 * Decision 3 of the NEO-254 plan, extended so a run over a dataset that itself
 * holds several people of one name still converges:
 *
 *  - No match at all → a new row.
 *  - Exactly one match on the birth year → that is them.
 *  - Several matches on the birth year → ambiguous. Skip and report; guessing
 *    would attach a career to the wrong person.
 *  - No match on the birth year, and every candidate HAS a birth year → they
 *    are all demonstrably other people, so this is a new row. (This is what
 *    lets the second "Bob Allen" in the dataset be created after the first.)
 *  - A single bare candidate — no birth year, no career, no Wikidata id — is
 *    adopted: that is the shape of a row the checklist flow created from a
 *    card, with nothing on it that could contradict the dataset.
 *  - Anything else → ambiguous. Skip and report.
 */
/**
 * The `externalIds` slot for this sport's source id, as a literal object.
 *
 * A computed key would type as `Record<string, string>`, which the schema
 * validator rejects — the field names have to be statically visible.
 */
function sourceIdField(
  field: "lahmanId" | "nflverseId",
  id: string,
): { lahmanId?: string; nflverseId?: string } {
  return field === "lahmanId" ? { lahmanId: id } : { nflverseId: id };
}

type PlayerMatch =
  | { kind: "create" }
  | { kind: "adopt"; row: Doc<"players"> }
  | { kind: "ambiguous"; candidates: number };

export function matchExistingPlayer(
  candidates: Doc<"players">[],
  sourceBirthYear: number | undefined,
): PlayerMatch {
  if (candidates.length === 0) return { kind: "create" };

  if (sourceBirthYear !== undefined) {
    const sameBirthYear = candidates.filter((c) => c.birthYear === sourceBirthYear);
    if (sameBirthYear.length === 1) return { kind: "adopt", row: sameBirthYear[0] };
    if (sameBirthYear.length > 1) {
      return { kind: "ambiguous", candidates: sameBirthYear.length };
    }
    if (candidates.every((c) => c.birthYear !== undefined)) return { kind: "create" };
  }

  if (candidates.length === 1) {
    const only = candidates[0];
    const bare =
      only.birthYear === undefined &&
      (only.teamYears === undefined || only.teamYears.length === 0) &&
      !only.externalIds?.wikidataId;
    if (bare) return { kind: "adopt", row: only };
  }

  return { kind: "ambiguous", candidates: candidates.length };
}

export const loadPlayersChunk = internalMutation({
  args: {
    sport: sportArg,
    /**
     * The dataset's full team-name list, so a stint's `teamIndex` resolves
     * without shipping the whole file into every call. ~120-140 short strings.
     */
    teamNames: v.array(v.string()),
    players: v.array(playerArg),
    dryRun: v.boolean(),
  },
  returns: v.object({
    /** How many of `players` were handled. Less than the input when the
     * transaction ran short of headroom; the action resumes from there. */
    processed: v.number(),
    playersCreated: v.number(),
    playersAdopted: v.number(),
    playersSkippedAmbiguous: v.number(),
    playersSkippedNoSport: v.number(),
    truncatedStints: v.number(),
    /** Stints dropped because their team row does not exist (phase 1 skipped
     * or, in a dry run, never wrote it). Reported so a silent gap is visible. */
    droppedStints: v.number(),
  }),
  handler: async (ctx, args) => {
    assertPreloadArmed();

    const sportRows = await ctx.db
      .query("selectorOptions")
      .withIndex("by_level", (q) => q.eq("level", "sport"))
      .collect();
    const sport = sportRows.find(
      (r) => r.value.toLowerCase().trim() === args.sport,
    );
    if (!sport) {
      return {
        processed: args.players.length,
        playersCreated: 0,
        playersAdopted: 0,
        playersSkippedAmbiguous: 0,
        playersSkippedNoSport: args.players.length,
        truncatedStints: 0,
        droppedStints: 0,
      };
    }
    const sportId = sport._id;
    const idField = SOURCE_ID_FIELD[args.sport];

    // teamIndex → NB team id, resolved once per mutation. A chunk of 100
    // players touches a few dozen distinct teams, so this is the difference
    // between ~40 reads and ~250.
    const teamIdByIndex = new Map<number, Id<"teams"> | null>();
    const teamIdFor = async (index: number): Promise<Id<"teams"> | null> => {
      if (teamIdByIndex.has(index)) return teamIdByIndex.get(index) ?? null;
      const name = args.teamNames[index];
      let id: Id<"teams"> | null = null;
      if (name !== undefined) {
        const matches = await ctx.db
          .query("teams")
          .withIndex("by_name_normalized_and_sport_id", (q) =>
            q.eq("nameNormalized", normalizeTeamName(name)).eq("sportId", sportId),
          )
          .collect();
        id = matches[0]?._id ?? null;
      }
      teamIdByIndex.set(index, id);
      return id;
    };

    let processed = 0;
    let playersCreated = 0;
    let playersAdopted = 0;
    let playersSkippedAmbiguous = 0;
    let truncatedStints = 0;
    let droppedStints = 0;

    for (const source of args.players) {
      if (await outOfHeadroom(ctx)) break;
      processed += 1;

      // 1. Our own row from a previous run. Indexed on the source id, so this
      //    is what makes a re-run cheap and non-duplicating.
      const bySourceId =
        idField === "lahmanId"
          ? await ctx.db
              .query("players")
              .withIndex("by_lahman_id", (q) =>
                q.eq("externalIds.lahmanId", source.id),
              )
              .collect()
          : await ctx.db
              .query("players")
              .withIndex("by_nflverse_id", (q) =>
                q.eq("externalIds.nflverseId", source.id),
              )
              .collect();
      if (bySourceId.length > 0) {
        playersAdopted += 1;
        continue;
      }

      // 2. An existing NB row for the same name in this sport.
      const nameNormalized = normalizePlayerName(source.name);
      const candidates = await ctx.db
        .query("players")
        .withIndex("by_name_normalized_and_sport_id", (q) =>
          q.eq("nameNormalized", nameNormalized).eq("sportId", sportId),
        )
        .collect();

      const decision = matchExistingPlayer(candidates, source.birthYear);
      if (decision.kind === "ambiguous") {
        playersSkippedAmbiguous += 1;
        console.log(
          JSON.stringify({
            msg: "preload_player_skipped_ambiguous",
            sport: args.sport,
            sourceId: source.id,
            name: source.name,
            birthYear: source.birthYear ?? null,
            candidates: decision.candidates,
          }),
        );
        continue;
      }

      // 3. Career stints, in NB's canonical order (NEO-212).
      const teamYears: Array<{ teamId: Id<"teams">; fromYear: number; toYear?: number }> =
        [];
      for (const stint of source.stints) {
        if (stint.length < 3) continue;
        const teamId = await teamIdFor(stint[0]);
        if (!teamId) {
          droppedStints += 1;
          continue;
        }
        teamYears.push({ teamId, fromYear: stint[1], toYear: stint[2] });
      }
      const sorted = sortTeamYears(teamYears);
      const capped = sorted.slice(0, MAX_TEAM_YEARS);
      if (sorted.length > capped.length) truncatedStints += 1;

      if (decision.kind === "adopt") {
        playersAdopted += 1;
        if (args.dryRun) continue;
        const row = decision.row;
        // GAP-FILL ONLY, every field. The dataset is initial input; a career
        // an operator entered, or an enrichment already stored, outranks it.
        const patch: Record<string, unknown> = {
          externalIds: { ...(row.externalIds ?? {}), ...sourceIdField(idField, source.id) },
        };
        if (row.birthYear === undefined && source.birthYear !== undefined) {
          patch.birthYear = source.birthYear;
        }
        if (
          (row.teamYears === undefined || row.teamYears.length === 0) &&
          capped.length > 0
        ) {
          patch.teamYears = capped;
        }
        if (row.isHallOfFame === undefined && source.hof) patch.isHallOfFame = true;
        await ctx.db.patch(row._id, { ...patch, lastUpdated: Date.now() });
        continue;
      }

      playersCreated += 1;
      if (source.lowConfidence) {
        // NEO-254 decision 8: the source had neither an id nor a birth date
        // for this person, so two same-named people may have been folded into
        // one row upstream. 117 of 33,248 football players; none in baseball.
        // Named individually because "117 rows are approximate" is not
        // something an operator can act on, but a list of names is.
        console.log(
          JSON.stringify({
            msg: "preload_player_low_confidence_identity",
            sport: args.sport,
            sourceId: source.id,
            name: source.name,
          }),
        );
      }
      if (args.dryRun) continue;
      await ctx.db.insert("players", {
        // The SOURCE spelling, accents and all. `nameNormalized` is what
        // identity is compared on, so the display name does not have to be
        // flattened to be findable.
        name: source.name,
        nameNormalized,
        sportId,
        ...(source.birthYear !== undefined ? { birthYear: source.birthYear } : {}),
        ...(capped.length > 0 ? { teamYears: capped } : {}),
        // Absent rather than `false` when they are not in the Hall. `false` is
        // an enrichment MARKER ("we looked, they are not in it") and would
        // make `enrichPlayer` skip a player the datasets say nothing about.
        ...(source.hof ? { isHallOfFame: true } : {}),
        externalIds: sourceIdField(idField, source.id),
        lastUpdated: Date.now(),
      });
    }

    return {
      processed,
      playersCreated,
      playersAdopted,
      playersSkippedAmbiguous,
      playersSkippedNoSport: 0,
      truncatedStints,
      droppedStints,
    };
  },
});

/**
 * True when this transaction is close enough to Convex's per-execution limits
 * that another player might not fit.
 *
 * `PLAYER_CHUNK_SIZE` is already conservative, so this should never fire on
 * these datasets — it exists so that a deployment where one name matches an
 * unexpected number of rows degrades into "stop early, report `nextStart`"
 * rather than into a failed transaction that loses the whole chunk.
 *
 * Wrapped in try/catch because the check must never be the thing that breaks
 * the load: a runtime without the metrics API simply gets the unguarded
 * behaviour it had before.
 */
async function outOfHeadroom(ctx: {
  meta: { getTransactionMetrics: () => Promise<TransactionMetrics> };
}): Promise<boolean> {
  try {
    const metrics = await ctx.meta.getTransactionMetrics();
    return (
      metrics.documentsRead.remaining < 200 || metrics.documentsWritten.remaining < 20
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// The entry point
// ---------------------------------------------------------------------------

const summaryValidator = v.object({
  dryRun: v.boolean(),
  sport: v.string(),
  leaguesCreated: v.number(),
  teamsCreated: v.number(),
  teamsAdopted: v.number(),
  playersCreated: v.number(),
  playersAdopted: v.number(),
  playersSkippedAmbiguous: v.number(),
  playersSkippedNoSport: v.number(),
  truncatedStints: v.number(),
  droppedStints: v.number(),
  /** Where to resume, or null when the whole file was processed. */
  nextStart: v.union(v.number(), v.null()),
});

type PreloadSummary = {
  dryRun: boolean;
  sport: string;
  leaguesCreated: number;
  teamsCreated: number;
  teamsAdopted: number;
  playersCreated: number;
  playersAdopted: number;
  playersSkippedAmbiguous: number;
  playersSkippedNoSport: number;
  truncatedStints: number;
  droppedStints: number;
  nextStart: number | null;
};

export const run = internalAction({
  args: {
    sport: sportArg,
    // `convex run` is one tab-completion away from a neighbouring function
    // name, and this writes tens of thousands of shared rows. Make it explicit.
    confirm: v.literal("PRELOAD"),
    /** Report what would happen. Writes nothing, anywhere. */
    dryRun: v.optional(v.boolean()),
    /** Resume the player phase at this index. Teams are re-checked regardless
     * — four cheap, convergent mutations that guarantee the stints below have
     * teams to point at. */
    start: v.optional(v.number()),
  },
  returns: summaryValidator,
  handler: async (ctx, args): Promise<PreloadSummary> => {
    // Fail here rather than partway through, so an unarmed run costs nothing.
    // Every chunk mutation asserts it again independently.
    assertPreloadArmed();

    const dryRun = args.dryRun ?? false;
    const data = PRELOAD_DATA[args.sport];
    const startedAt = Date.now();

    const summary: PreloadSummary = {
      dryRun,
      sport: args.sport,
      leaguesCreated: 0,
      teamsCreated: 0,
      teamsAdopted: 0,
      playersCreated: 0,
      playersAdopted: 0,
      playersSkippedAmbiguous: 0,
      playersSkippedNoSport: 0,
      truncatedStints: 0,
      droppedStints: 0,
      nextStart: null,
    };

    // Phase 1 — leagues and teams. Players are useless without them: a stint
    // needs a team row to point at.
    let sportMissing = false;
    for (let start = 0; start < data.teams.length; start += TEAM_CHUNK_SIZE) {
      const result = await ctx.runMutation(internal.preloadPlayers.loadTeamsChunk, {
        sport: args.sport,
        leagues: data.leagues,
        teams: data.teams.slice(start, start + TEAM_CHUNK_SIZE),
        dryRun,
      });
      summary.leaguesCreated += result.leaguesCreated;
      summary.teamsCreated += result.teamsCreated;
      summary.teamsAdopted += result.teamsAdopted;
      if (result.skippedNoSport > 0) sportMissing = true;
    }

    // The one failure mode that looks like success: the sport has never been
    // synced, so there is no sport row to hang anything off. Report it and
    // stop rather than walking 21,000 players to skip every one.
    if (sportMissing) {
      summary.playersSkippedNoSport = data.players.length;
      console.log(JSON.stringify({ msg: "preload_complete", ...summary }));
      return summary;
    }

    const teamNames = data.teams.map((t) => t.name);
    let index = Math.max(0, args.start ?? 0);
    while (index < data.players.length) {
      if (Date.now() - startedAt > MAX_ACTION_MS) {
        summary.nextStart = index;
        break;
      }
      const slice = data.players.slice(index, index + PLAYER_CHUNK_SIZE);
      const result = await ctx.runMutation(internal.preloadPlayers.loadPlayersChunk, {
        sport: args.sport,
        teamNames,
        players: slice,
        dryRun,
      });
      if (result.processed === 0) {
        // A chunk that handles nothing would loop forever. This cannot happen
        // with a non-empty slice, so treat it as a bug rather than retrying.
        throw new Error(
          `preloadPlayers: chunk at ${index} processed 0 of ${slice.length} players`,
        );
      }
      summary.playersCreated += result.playersCreated;
      summary.playersAdopted += result.playersAdopted;
      summary.playersSkippedAmbiguous += result.playersSkippedAmbiguous;
      summary.truncatedStints += result.truncatedStints;
      summary.droppedStints += result.droppedStints;
      index += result.processed;
    }

    console.log(JSON.stringify({ msg: "preload_complete", ...summary }));
    return summary;
  },
});
