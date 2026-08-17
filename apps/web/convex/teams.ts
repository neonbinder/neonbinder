import { query, mutation, internalMutation, internalQuery, action } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { getCurrentUserId, requireAdmin } from "./auth";
import { findOrCreateLeague, resolveDefaultLeagueId } from "./leagues";
import { normalizePlayerName } from "./players";

/**
 * Lowercase + strip punctuation + token-sort. Same shape as the player
 * normalizer — keeps "Yankees, New York" and "New York Yankees" deduped
 * to one row. Used as the dedup key on `teams.nameNormalized`.
 */
export function normalizeTeamName(raw: string): string {
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
 * Teams are intentionally globally-shared rows: a single (name, sport)
 * key resolves to the same `teams._id` regardless of which user
 * triggered the row's creation. Yankees are Yankees. Do NOT add
 * per-user fields to this table — push user-specific data onto
 * separate per-user join tables instead. See the analogous note in
 * `convex/players.ts`.
 */
const teamDocValidator = v.object({
  _id: v.id("teams"),
  _creationTime: v.number(),
  name: v.string(),
  nameNormalized: v.string(),
  // NEO-96: reference to the sport-level selectorOptions row.
  sportId: v.id("selectorOptions"),
  // NEO-156: reference to the league row. `league` below is its deprecated
  // free-text predecessor, kept only until the backfill drains — see the schema.
  leagueId: v.optional(v.id("leagues")),
  league: v.optional(v.string()),
  city: v.optional(v.string()),
  yearsActive: v.optional(v.object({
    from: v.number(),
    to: v.optional(v.number()),
  })),
  colors: v.optional(v.object({
    primary: v.optional(v.string()),
    secondary: v.optional(v.string()),
  })),
  // NEO-147 — see the schema for what these two mean and why ambiguity parks
  // in `colorCandidates` instead of being guessed.
  colorSource: v.optional(v.object({
    url: v.string(),
    matchedName: v.string(),
    resolvedAt: v.number(),
  })),
  colorCandidates: v.optional(v.array(v.object({
    name: v.string(),
    url: v.string(),
  }))),
  externalIds: v.optional(v.object({
    wikidataId: v.optional(v.string()),
    espnId: v.optional(v.string()),
  })),
  lastUpdated: v.number(),
});

export const findByNameAndSport = query({
  args: {
    name: v.string(),
    sportId: v.id("selectorOptions"),
  },
  returns: v.union(teamDocValidator, v.null()),
  handler: async (ctx, args) => {
    const normalized = normalizeTeamName(args.name);
    const matches = await ctx.db
      .query("teams")
      .withIndex("by_name_normalized", (q) => q.eq("nameNormalized", normalized))
      .collect();
    return matches.find((t) => t.sportId === args.sportId) ?? null;
  },
});

export const findOrCreate = mutation({
  args: {
    name: v.string(),
    sportId: v.id("selectorOptions"),
  },
  returns: v.id("teams"),
  handler: async (ctx, args): Promise<Id<"teams">> => {
    const normalized = normalizeTeamName(args.name);
    const matches = await ctx.db
      .query("teams")
      .withIndex("by_name_normalized", (q) => q.eq("nameNormalized", normalized))
      .collect();
    const existing = matches.find((t) => t.sportId === args.sportId);
    if (existing) return existing._id;

    return await ctx.db.insert("teams", {
      name: args.name.trim(),
      nameNormalized: normalized,
      sportId: args.sportId,
      // NEO-156: every creation path attaches a league. Undefined when the
      // sport has no configured one (a custom sport) — legitimate, and
      // assignable later in Team Management.
      leagueId: await resolveDefaultLeagueId(ctx, args.sportId),
      lastUpdated: Date.now(),
    });
  },
});

/**
 * Idempotent: ensures a fixed set of teams exists for Maestro E2E
 * flows that need a deterministic typeahead match (TeamPicker tests
 * assert "Add New York Yankees" / "Add New York Mets" by aria-label).
 * The cascade `cards-base` flow normally populates the teams table
 * via the "Confirm New Players & Teams" dialog, but its output
 * depends on marketplace data and skip-some flows can leave specific
 * teams absent. Calling this from cascade/setup.yaml guarantees the
 * test teams exist regardless of cascade output.
 *
 * Admin-only + ALLOW_RESET_SET_BUILDER_DATA gate mirrors the reset
 * mutation: same blast radius (test deployments only).
 */
export const seedTestTeams = mutation({
  args: {},
  returns: v.object({
    created: v.number(),
    existing: v.number(),
    playersCreated: v.number(),
  }),
  handler: async (ctx) => {
    await requireAdmin(ctx);
    if (process.env.ALLOW_RESET_SET_BUILDER_DATA !== "true") {
      throw new Error(
        "Seed Test Teams is not enabled in this environment. " +
          "Set ALLOW_RESET_SET_BUILDER_DATA=true on the Convex deployment to enable.",
      );
    }
    // NEO-96: teams now reference the sport row, so the Baseball row must
    // already exist — i.e. the sport sync has to have run before this. That is
    // an ORDERING REQUIREMENT for setup.yaml, not an incidental detail: seeding
    // before the sync would silently produce zero teams and the TeamPicker
    // flows would fail far downstream with no clue why. Fail loudly instead.
    const baseball = await ctx.db
      .query("selectorOptions")
      .withIndex("by_level", (q) => q.eq("level", "sport"))
      .collect();
    const baseballRow = baseball.find(
      (o) => o.value.toLowerCase().trim() === "baseball",
    );
    if (!baseballRow) {
      throw new Error(
        "Seed Test Teams requires the Baseball sport row to exist — run the " +
          "sport sync first (setup.yaml must sync sports before seeding teams).",
      );
    }

    // Colours are part of the fixture, not decoration. After a reset the teams
    // table is empty, so NOTHING has colours — and the spine-label designer,
    // Team Management's detail panel and the contrast readout all read them.
    // Without a deterministic pair here those surfaces can only be tested
    // against whatever a deployment happens to hold, which is how they ended up
    // with no E2E coverage at all.
    const seeds = [
      {
        name: "New York Yankees",
        colors: { primary: "#132448", secondary: "#c4ced3" },
      },
      {
        name: "New York Mets",
        colors: { primary: "#002d72", secondary: "#ff5910" },
      },
    ];
    let created = 0;
    let existing = 0;
    for (const seed of seeds) {
      const normalized = normalizeTeamName(seed.name);
      const matches = await ctx.db
        .query("teams")
        .withIndex("by_name_normalized", (q) =>
          q.eq("nameNormalized", normalized),
        )
        .collect();
      const already = matches.find((t) => t.sportId === baseballRow._id);
      if (already) {
        existing += 1;
        // A fixture has to be AUTHORITATIVE, not merely present. A row that
        // already exists — synced from a marketplace, or seeded from the
        // bundled colour dataset — carries whatever colours that source gave
        // it, which is not what the flows assert on. Repair it rather than
        // skipping, or the fixture silently means something different on a
        // deployment that was not freshly reset.
        if (
          already.colors?.primary !== seed.colors.primary ||
          already.colors?.secondary !== seed.colors.secondary
        ) {
          await ctx.db.patch(already._id, {
            colors: seed.colors,
            lastUpdated: Date.now(),
          });
        }
        continue;
      }
      await ctx.db.insert("teams", {
        name: seed.name,
        nameNormalized: normalized,
        sportId: baseballRow._id,
        colors: seed.colors,
        // NEO-156 — see the note in findOrCreate.
        leagueId: await resolveDefaultLeagueId(ctx, baseballRow._id),
        lastUpdated: Date.now(),
      });
      created += 1;
    }

    // A fixture PLAYER with career teams, so the player-driven half of the
    // spine designer is testable: picking a player must surface their teams as
    // chips and default to the one they spent longest with.
    //
    // Two stints of deliberately different length — 10 years with the Yankees
    // against 2 with the Mets — so "longest tenure" has something to be right
    // or wrong about. A single-team fixture would pass whatever the logic did.
    //
    // The name is unmistakably a fixture so it cannot collide with a real
    // player from the 2024 Topps Chrome sync this flow also performs.
    const teamIdByName = new Map<string, Id<"teams">>();
    for (const seed of seeds) {
      const row = (
        await ctx.db
          .query("teams")
          .withIndex("by_name_normalized", (q) =>
            q.eq("nameNormalized", normalizeTeamName(seed.name)),
          )
          .collect()
      ).find((t) => t.sportId === baseballRow._id);
      if (row) teamIdByName.set(seed.name, row._id);
    }

    const FIXTURE_PLAYER = "E2E Fixture Player";
    const playerNormalized = normalizePlayerName(FIXTURE_PLAYER);
    const existingPlayer = (
      await ctx.db
        .query("players")
        .withIndex("by_name_normalized_and_sport_id", (q) =>
          q.eq("nameNormalized", playerNormalized).eq("sportId", baseballRow._id),
        )
        .collect()
    )[0];

    let playersCreated = 0;
    const yankees = teamIdByName.get("New York Yankees");
    const mets = teamIdByName.get("New York Mets");
    if (!existingPlayer && yankees && mets) {
      await ctx.db.insert("players", {
        name: FIXTURE_PLAYER,
        nameNormalized: playerNormalized,
        sportId: baseballRow._id,
        teamYears: [
          { teamId: yankees, fromYear: 2010, toYear: 2020 },
          { teamId: mets, fromYear: 2021, toYear: 2023 },
        ],
        lastUpdated: Date.now(),
      });
      playersCreated += 1;
    }

    return { created, existing, playersCreated };
  },
});

export const list = query({
  args: {
    sportId: v.optional(v.id("selectorOptions")),
    limit: v.optional(v.number()),
  },
  returns: v.array(teamDocValidator),
  handler: async (ctx, args) => {
    const limit = args.limit ?? 100;
    if (args.sportId) {
      return await ctx.db
        .query("teams")
        .withIndex("by_sport_id", (q) => q.eq("sportId", args.sportId!))
        .take(limit);
    }
    return await ctx.db.query("teams").take(limit);
  },
});

export const get = query({
  args: { id: v.id("teams") },
  returns: v.union(teamDocValidator, v.null()),
  handler: async (ctx, args) => await ctx.db.get(args.id),
});

/**
 * Batch lookup for resolving a list of teamIds back to display rows.
 * Used by the CardChecklistItem display row + TeamPicker chip view to
 * render the names without N round-trips. Missing IDs are silently
 * dropped (an orphaned link is a soft data error, not a fatal one).
 */
export const getManyByIds = query({
  args: { ids: v.array(v.id("teams")) },
  returns: v.array(teamDocValidator),
  handler: async (ctx, args) => {
    const rows = await Promise.all(args.ids.map((id) => ctx.db.get(id)));
    return rows.filter((r): r is NonNullable<typeof r> => r !== null);
  },
});

/**
 * Internal `get` and `findOrCreate` for actions that run outside user
 * auth (e.g. Wikidata enrichment). The Wikidata player adapter resolves
 * each P54 team membership through findOrCreateInternal, which is why
 * enriching one player can spawn many team rows in a single pass.
 */
export const getInternal = internalQuery({
  args: { id: v.id("teams") },
  returns: v.union(teamDocValidator, v.null()),
  handler: async (ctx, args) => await ctx.db.get(args.id),
});

export const findOrCreateInternal = internalMutation({
  args: {
    name: v.string(),
    sportId: v.id("selectorOptions"),
  },
  returns: v.id("teams"),
  handler: async (ctx, args): Promise<Id<"teams">> => {
    const normalized = normalizeTeamName(args.name);
    const matches = await ctx.db
      .query("teams")
      .withIndex("by_name_normalized", (q) => q.eq("nameNormalized", normalized))
      .collect();
    const existing = matches.find((t) => t.sportId === args.sportId);
    if (existing) return existing._id;

    return await ctx.db.insert("teams", {
      name: args.name.trim(),
      nameNormalized: normalized,
      sportId: args.sportId,
      // NEO-156: every creation path attaches a league. Undefined when the
      // sport has no configured one (a custom sport) — legitimate, and
      // assignable later in Team Management.
      leagueId: await resolveDefaultLeagueId(ctx, args.sportId),
      lastUpdated: Date.now(),
    });
  },
});

export const applyEnrichmentInternal = internalMutation({
  args: {
    id: v.id("teams"),
    league: v.optional(v.string()),
    city: v.optional(v.string()),
    yearsActive: v.optional(v.object({
      from: v.number(),
      to: v.optional(v.number()),
    })),
    // NEO-91: from ESPN (adapters/espn.ts) — see schema.ts's doc comment on
    // `teams.colors` for why this doesn't come from Wikidata.
    colors: v.optional(v.object({
      primary: v.optional(v.string()),
      secondary: v.optional(v.string()),
    })),
    wikidataId: v.optional(v.string()),
    espnId: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.id);
    if (!existing) return null;

    const patch: {
      leagueId?: Id<"leagues">;
      city?: string;
      yearsActive?: { from: number; to?: number };
      colors?: { primary?: string; secondary?: string };
      externalIds?: { wikidataId?: string; espnId?: string };
      lastUpdated: number;
    } = { lastUpdated: Date.now() };

    // NEO-156: enrichment reports a league NAME (ESPN's full league name, or
    // Wikidata's label). Resolve it to a row rather than storing the string —
    // otherwise "Major League Baseball" from ESPN and "Major League Baseball"
    // from Wikidata are two facts about the same league with nothing tying
    // them together, which is exactly the drift NEO-96 fixed for sports.
    //
    // Only ever fills a GAP: a league an operator assigned by hand in Team
    // Management outranks whatever a source guessed, so enrichment must not
    // overwrite it.
    if (args.league !== undefined && !existing.leagueId) {
      patch.leagueId = await findOrCreateLeague(ctx, {
        name: args.league,
        sportId: existing.sportId,
      });
    }
    if (args.city !== undefined) patch.city = args.city;
    if (args.yearsActive !== undefined) patch.yearsActive = args.yearsActive;
    if (args.colors !== undefined) patch.colors = args.colors;
    if (args.wikidataId !== undefined || args.espnId !== undefined) {
      patch.externalIds = {
        ...(existing.externalIds ?? {}),
        ...(args.wikidataId !== undefined ? { wikidataId: args.wikidataId } : {}),
        ...(args.espnId !== undefined ? { espnId: args.espnId } : {}),
      };
    }
    await ctx.db.patch(args.id, patch);
    return null;
  },
});

/**
 * "Discover" — re-run every source for ONE team, on demand.
 *
 * A newly created team already gets this automatically: every creation path
 * enqueues it, and `adapters/wikidata.enrichTeam` resolves league, city, years
 * and colors for it. This action is the manual counterpart — for a team that
 * predates the pipeline, one whose sources had nothing at the time, or one
 * whose match turned out to be the wrong franchise.
 *
 * NEO-156 folded the legacy league conversion in here. It was a bulk
 * "backfill legacy leagues" button, which is a control that becomes
 * permanently useless the moment it succeeds; doing it as a side effect of
 * work already happening means the migration finishes without anyone
 * remembering to run it.
 *
 * `force` re-runs the color search for a team that already has a resolved
 * source — otherwise that step is skipped as already done.
 *
 * Returns the color outcome so the UI can say what happened. Enrichment errors
 * stay swallowed: it is best-effort by design, and an unchanged row IS the
 * "found nothing" signal.
 */
export const enrichFromWikidata = action({
  args: { id: v.id("teams"), force: v.optional(v.boolean()) },
  returns: v.union(
    v.literal("resolved"),
    v.literal("ambiguous"),
    v.literal("no-match"),
    v.literal("skipped"),
    v.literal("unreadable"),
  ),
  handler: async (ctx, args): Promise<
    "resolved" | "ambiguous" | "no-match" | "skipped" | "unreadable"
  > => {
    await requireAdmin(ctx);

    await ctx.runMutation(internal.teams.convertLegacyLeagueInternal, {
      id: args.id,
    });

    try {
      await ctx.runAction(internal.adapters.wikidata.enrichTeam, {
        teamId: args.id,
      });
    } catch (error) {
      console.error("[teams.enrichFromWikidata] enrichment failed:", error);
    }

    // enrichTeam already attempts colors, but skips a team that has a resolved
    // source. `force` is the whole reason this runs again: re-searching a bad
    // match is the operator's remedy for a wrong franchise.
    if (!args.force) return "skipped";
    try {
      return await ctx.runAction(internal.teamColorSources.resolveTeamColors, {
        teamId: args.id,
        force: true,
      });
    } catch (error) {
      console.error("[teams.enrichFromWikidata] color lookup failed:", error);
      return "unreadable";
    }
  },
});

/**
 * NEO-156: convert this one team's legacy free-text `league` into a real
 * league row, if it still has one.
 *
 * Replaces the bulk `leagues.backfillLeagueIds` mutation. A no-op for a team
 * with no legacy string or an existing `leagueId`, so it never overwrites a
 * league an operator assigned by hand.
 */
export const convertLegacyLeagueInternal = internalMutation({
  args: { id: v.id("teams") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const team = await ctx.db.get(args.id);
    if (!team?.league || team.leagueId) return null;

    const leagueId = await findOrCreateLeague(ctx, {
      name: team.league,
      sportId: team.sportId,
    });
    await ctx.db.patch(args.id, {
      leagueId,
      // Clear the string as it converts, so a row never carries two answers to
      // the same question.
      league: undefined,
      lastUpdated: Date.now(),
    });
    return null;
  },
});

/** `#rgb` or `#rrggbb`. The only colour form `teams.colors` is allowed to hold. */
const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/**
 * NEO-147: manual field entry for the team editor.
 *
 * The counterpart to Discover — for the teams no source will ever carry
 * (Estrellas Orientales, an Arizona League affiliate) and for correcting a
 * source that matched the wrong franchise.
 *
 * Every field is optional-and-clearable: passing `null` erases it, omitting it
 * leaves it alone. That distinction matters because "" and "unset" are
 * different states for `colors.primary` — an empty string would render as a
 * transparent swatch rather than falling back to manual entry.
 *
 * `name` changes rewrite `nameNormalized` too, or the row becomes invisible to
 * every by_name_normalized lookup that resolves sync results back onto it.
 */
export const saveTeamFields = mutation({
  args: {
    id: v.id("teams"),
    name: v.optional(v.string()),
    // NEO-156: a reference, picked from the league dropdown. `null` clears it.
    // The free-text `league` predecessor is not settable here — assigning a
    // league by typing is exactly what created the drift this replaced.
    leagueId: v.optional(v.union(v.id("leagues"), v.null())),
    city: v.optional(v.union(v.string(), v.null())),
    yearsActive: v.optional(
      v.union(
        v.object({ from: v.number(), to: v.optional(v.number()) }),
        v.null(),
      ),
    ),
    colors: v.optional(
      v.union(
        v.object({
          primary: v.optional(v.string()),
          secondary: v.optional(v.string()),
        }),
        v.null(),
      ),
    ),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const existing = await ctx.db.get(args.id);
    if (!existing) throw new Error("Team not found");

    const patch: Record<string, unknown> = { lastUpdated: Date.now() };

    if (args.name !== undefined) {
      const trimmed = args.name.trim();
      if (!trimmed) throw new Error("Team name cannot be empty");
      patch.name = trimmed;
      patch.nameNormalized = normalizeTeamName(trimmed);
    }
    if (args.leagueId !== undefined) {
      patch.leagueId = args.leagueId ?? undefined;
      // Assigning a league supersedes the legacy string, so a row never
      // carries two answers to the same question.
      patch.league = undefined;
    }
    if (args.city !== undefined) patch.city = args.city ?? undefined;
    if (args.yearsActive !== undefined) {
      patch.yearsActive = args.yearsActive ?? undefined;
    }
    if (args.colors !== undefined) {
      // Validated at the write, not just in the UI. These values are
      // interpolated into a `style="..."` attribute by
      // lib/print/spine-label-html.ts, which defends itself with its own
      // allowlist — but storing only real hex keeps the row self-describing
      // and means a future consumer inherits the guarantee rather than having
      // to rediscover it.
      if (args.colors !== null) {
        for (const value of [args.colors.primary, args.colors.secondary]) {
          if (value !== undefined && !HEX_COLOR.test(value)) {
            throw new Error(`Not a hex color: ${value}`);
          }
        }
      }
      patch.colors = args.colors ?? undefined;
    }

    await ctx.db.patch(args.id, patch);
    return null;
  },
});


/** Hard ceiling on rows returned by the team list queries below. */
const TEAM_MANAGEMENT_CAP = 2000;

/**
 * NEO-156: teams for a picker, for any signed-in user.
 *
 * The spine-label designer needs to offer teams to a COLLECTOR, and
 * `listForManagement` above is admin-only. Same rows, different audience —
 * teams are globally-shared reference data with no user content on them, so
 * the only thing being gated is cost.
 *
 * Signed-in rather than fully public for the same reason as `players.search`:
 * a deployment URL ships in the client bundle, and an ungated list of every
 * team is free read amplification for anyone who wants it. Returns empty
 * rather than throwing, so a signed-out render is a quiet no-op.
 *
 * Filtering is the client's job, as on the admin screen — right at today's
 * scale, and the explicit cap is what stops that being silently wrong later.
 */
export const listForPicker = query({
  args: { sportId: v.optional(v.id("selectorOptions")) },
  returns: v.array(teamDocValidator),
  handler: async (ctx, args) => {
    if (!(await getCurrentUserId(ctx))) return [];

    const rows = args.sportId
      ? await ctx.db
          .query("teams")
          .withIndex("by_sport_id", (q) => q.eq("sportId", args.sportId!))
          .take(TEAM_MANAGEMENT_CAP)
      : await ctx.db.query("teams").take(TEAM_MANAGEMENT_CAP);

    return rows.sort((a, b) => a.name.localeCompare(b.name));
  },
});

/**
 * NEO-156: the whole team list, for Team Management.
 *
 * Replaces NEO-147's `listColorReview`, which returned two pre-computed
 * buckets (ambiguous / missing colors). The screen is now master-detail over
 * every team, so the client needs the rows themselves and derives those states
 * from `colorCandidates` and `colors` — the same two facts, without the server
 * deciding in advance which of them the operator is allowed to see.
 *
 * Filtering and sorting are the client's job. That is right at today's scale
 * (58 prod teams) and wrong past a few thousand, at which point this becomes a
 * paginated search — hence the explicit cap rather than an unbounded
 * `.collect()` that would one day exceed Convex's read limit and fail as an
 * error rather than a slow query.
 */

export const listForManagement = query({
  args: { sportId: v.optional(v.id("selectorOptions")) },
  returns: v.object({
    teams: v.array(teamDocValidator),
    totalCount: v.number(),
    truncated: v.boolean(),
  }),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);

    const rows = args.sportId
      ? await ctx.db
          .query("teams")
          .withIndex("by_sport_id", (q) => q.eq("sportId", args.sportId!))
          .take(TEAM_MANAGEMENT_CAP + 1)
      : await ctx.db.query("teams").take(TEAM_MANAGEMENT_CAP + 1);

    const truncated = rows.length > TEAM_MANAGEMENT_CAP;
    const teams = rows.slice(0, TEAM_MANAGEMENT_CAP);
    teams.sort((a, b) => a.name.localeCompare(b.name));

    // Reported rather than silently dropped: a list that quietly stops at 2000
    // reads as "that is all the teams", which is the kind of wrong the
    // operator cannot see.
    return { teams, totalCount: teams.length, truncated };
  },
});
