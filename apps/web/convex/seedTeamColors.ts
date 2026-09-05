/**
 * NEO-156 — seed leagues and teams from the bundled colour dataset.
 *
 * Run at release. Creates the six leagues the dataset covers and a team row
 * per entry, so the big leagues are populated without anyone scraping
 * anything. What it cannot cover — NCAA, NPB, MiLB, Dominican winter league —
 * still falls through to the live lookup; see `lib/teams/seed-team-colors.ts`.
 *
 * Idempotent throughout. It is a release step, so it will run again on the
 * next release and must converge rather than duplicate:
 *
 *  - Leagues are found-or-created by (name, sport).
 *  - Teams are found-or-created by (nameNormalized, sport), under the
 *    franchise's CURRENT name — seeding "Cleveland Indians" beside our
 *    "Cleveland Guardians" row would leave two rows for one franchise.
 *  - Colours are only ever written to a team that has NONE. A colour an
 *    operator entered by hand, or one already resolved from the live source,
 *    outranks this dataset — which is stale in places and has no
 *    per-franchise recency we could compare against.
 *
 * Chunked because a release step that half-succeeds should be resumable, and
 * because 165 upserts plus their league lookups is more document traffic than
 * belongs in one mutation.
 */

import { v } from "convex/values";
import { action, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { requireAdmin } from "./auth";
import { findOrCreateLeague } from "./leagues";
import { findTeamByFullName, teamRowFields } from "./lib/teamRow";
import { SEED_LEAGUES, SEED_TEAMS } from "../lib/teams/seed-team-colors";
import { currentFranchiseParts } from "../lib/teams/seed-team-lookup";
import { teamFullName } from "../lib/teams/team-name";

/** Teams handled per mutation. Keeps each well inside the document budget. */
const SEED_CHUNK_SIZE = 40;

export const seedChunkInternal = internalMutation({
  args: { start: v.number(), count: v.number() },
  returns: v.object({
    teamsCreated: v.number(),
    colorsApplied: v.number(),
    skippedNoSport: v.number(),
  }),
  handler: async (ctx, args) => {
    const slice = SEED_TEAMS.slice(args.start, args.start + args.count);

    // Sport rows are created by the marketplace sync, never here: inventing
    // one would produce a row nothing else recognises. A sport we have not
    // synced simply yields no teams for its leagues.
    const sportRows = await ctx.db
      .query("selectorOptions")
      .withIndex("by_level", (q) => q.eq("level", "sport"))
      .collect();
    const sportByValue = new Map(
      sportRows.map((r) => [r.value.toLowerCase().trim(), r._id]),
    );

    let teamsCreated = 0;
    let colorsApplied = 0;
    let skippedNoSport = 0;

    for (const seed of SEED_TEAMS.length ? slice : []) {
      const leagueMeta = SEED_LEAGUES[seed.league];
      const sportId = sportByValue.get(
        leagueMeta.sportValue.toLowerCase(),
      ) as Id<"selectorOptions"> | undefined;
      if (!sportId) {
        skippedNoSport += 1;
        continue;
      }

      const leagueId = await findOrCreateLeague(ctx, {
        name: leagueMeta.name,
        abbreviation: leagueMeta.abbreviation,
        sportId,
      });

      // Under the CURRENT name, so a stale dataset entry cannot mint a second
      // row for a franchise we already hold.
      //
      // NEO-236: this is the ONE remaining automatic path that inserts a team,
      // and it is allowed to because it is not guessing — the dataset carries
      // Location and Name split by hand (see `SeedTeam`), which is exactly the
      // input every operator creation form collects. Fields come from
      // `teamRowFields` so the dedup key is derived from the composition, and
      // the lookup uses the same composition, so a seed run after the split
      // migration finds the rows it created before it.
      const parts = currentFranchiseParts(seed);
      const fields = teamRowFields(parts);

      const existing = await findTeamByFullName(
        ctx,
        sportId,
        teamFullName(parts),
      );

      const colors =
        seed.hex.length > 0
          ? { primary: seed.hex[0], ...(seed.hex[1] ? { secondary: seed.hex[1] } : {}) }
          : undefined;

      if (existing) {
        const patch: Record<string, unknown> = {};
        if (!existing.leagueId) patch.leagueId = leagueId;
        // Never overwrite colours that are already there — see the header.
        if (colors && !existing.colors?.primary) {
          patch.colors = colors;
          colorsApplied += 1;
        }
        if (Object.keys(patch).length > 0) {
          await ctx.db.patch(existing._id, { ...patch, lastUpdated: Date.now() });
        }
        continue;
      }

      await ctx.db.insert("teams", {
        ...fields,
        sportId,
        leagueId,
        ...(colors ? { colors } : {}),
        lastUpdated: Date.now(),
      });
      teamsCreated += 1;
      if (colors) colorsApplied += 1;
    }

    return { teamsCreated, colorsApplied, skippedNoSport };
  },
});

/**
 * Seed everything. Safe to re-run.
 *
 * Reports what it did rather than returning null, because "0 teams created"
 * after a release should be distinguishable from "did not run" — and
 * `skippedNoSport` is the signal that a sport has not been synced yet, which
 * is the one failure mode that looks like success.
 */
export const seedFromBundledData = action({
  args: {},
  returns: v.object({
    teamsCreated: v.number(),
    colorsApplied: v.number(),
    skippedNoSport: v.number(),
    total: v.number(),
  }),
  handler: async (
    ctx,
  ): Promise<{
    teamsCreated: number;
    colorsApplied: number;
    skippedNoSport: number;
    total: number;
  }> => {
    await requireAdmin(ctx);

    let teamsCreated = 0;
    let colorsApplied = 0;
    let skippedNoSport = 0;

    for (let start = 0; start < SEED_TEAMS.length; start += SEED_CHUNK_SIZE) {
      const result = await ctx.runMutation(
        internal.seedTeamColors.seedChunkInternal,
        { start, count: SEED_CHUNK_SIZE },
      );
      teamsCreated += result.teamsCreated;
      colorsApplied += result.colorsApplied;
      skippedNoSport += result.skippedNoSport;
    }

    console.log(
      `[seedTeamColors] created ${teamsCreated} teams, applied ${colorsApplied} colour sets, ` +
        `skipped ${skippedNoSport} for unsynced sports, of ${SEED_TEAMS.length} entries`,
    );
    return {
      teamsCreated,
      colorsApplied,
      skippedNoSport,
      total: SEED_TEAMS.length,
    };
  },
});
