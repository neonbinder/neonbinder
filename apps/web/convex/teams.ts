import { query, mutation, internalMutation, internalQuery, action } from "./_generated/server";
import { internal } from "./_generated/api";
import { ConvexError, v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { getCurrentUserId, requireAdmin, requireSignedIn } from "./auth";
import { findOrCreateLeague, resolveDefaultLeagueId } from "./leagues";
import { normalizePlayerName } from "./players";
import { MANUAL_COLOR_SOURCE_URL } from "./teamColorSources";
import { longestToken, rankTeamCandidates } from "./lib/entityNearMatch";
// NEO-212 security review: the shared `Q<digits>` chokepoint — see
// lib/players/wikidata-id.ts. Named for players only because that is where the
// id first appeared; the shape is the same for every Wikidata entity.
import { isWikidataQid } from "../lib/players/wikidata-id";

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
    await requireSignedIn(ctx);
    const normalized = normalizeTeamName(args.name);
    const matches = await ctx.db
      .query("teams")
      .withIndex("by_name_normalized", (q) => q.eq("nameNormalized", normalized))
      .collect();
    return matches.find((t) => t.sportId === args.sportId) ?? null;
  },
});

/**
 * NEO-208 security condition — a bound on an operator-typed team name.
 *
 * A real franchise name is nowhere near this long. The cap exists because this
 * mutation is the one place a human string becomes a globally-shared `teams`
 * row that spine labels, listing titles and every picker then render, and
 * because an over-long name is now also what a Wikidata lookup gets pointed
 * at. Over-length is refused rather than trimmed: silently storing something
 * other than what was typed is how a mangled name gets treated as canonical.
 */
const MAX_TEAM_NAME_LENGTH = 120;

export const findOrCreate = mutation({
  args: {
    name: v.string(),
    sportId: v.id("selectorOptions"),
  },
  returns: v.id("teams"),
  handler: async (ctx, args): Promise<Id<"teams">> => {
    // NEO-154 gave this its first auth check at all — it was the one
    // unauthenticated write primitive left after the myFunctions deletion, so
    // anyone who could reach the deployment URL could insert team rows.
    //
    // NEO-208 raised it from `requireSignedIn` to `requireAdmin`, on the
    // security review of this ticket. Two reasons, and the second is new:
    // sign-up is open, so "signed in" is not a meaningful bound on who may
    // create shared rows; and the insert branch below now SCHEDULES a Wikidata
    // enrichment, so a signed-in caller could enqueue unbounded pooled lookup
    // work. `wikidataPool` caps concurrency, not total queued work. Every
    // caller of this mutation is admin tooling already — `TeamPicker`, and so
    // every screen under `components/SetSelector/` — so nothing legitimate
    // loses access. `findOrCreateInternal` below is unchanged and remains the
    // path for server-side callers.
    const userId = await requireAdmin(ctx);

    const name = args.name.trim();
    if (name.length === 0) {
      throw new ConvexError("A team name is required.");
    }
    if (name.length > MAX_TEAM_NAME_LENGTH) {
      // The LENGTH, never the name: this string reaches Sentry and the browser
      // console through Convex's error path.
      throw new ConvexError(
        `A team name is ${name.length} characters; the limit is ${MAX_TEAM_NAME_LENGTH}.`,
      );
    }

    // NEO-208 security condition: `sportId` is a bare `v.id("selectorOptions")`
    // — the validator proves it is an id in that table, not that it points at
    // a SPORT. A team hung off, say, a variantType row is unreachable by every
    // query that matters (`teams.list` and `findByNameAndSport` both key on
    // the sport row id, and `findSportForSelectorOption` only ever yields a
    // `level === "sport"` row), so it would be an orphan with a league
    // attached — the same class of unfindable row the old `sport ?? ""`
    // fallback produced before NEO-96.
    const sportRow = await ctx.db.get(args.sportId);
    if (!sportRow || sportRow.level !== "sport") {
      throw new ConvexError("A team must be created under a sport.");
    }

    const normalized = normalizeTeamName(name);
    const matches = await ctx.db
      .query("teams")
      .withIndex("by_name_normalized", (q) => q.eq("nameNormalized", normalized))
      .collect();
    const existing = matches.find((t) => t.sportId === args.sportId);
    // NOT enqueued — see the creation-only note on the insert below.
    if (existing) return existing._id;

    const id = await ctx.db.insert("teams", {
      name,
      nameNormalized: normalized,
      sportId: args.sportId,
      // NEO-156: every creation path attaches a league. Undefined when the
      // sport has no configured one (a custom sport) — legitimate, and
      // assignable later in Team Management.
      leagueId: await resolveDefaultLeagueId(ctx, args.sportId),
      lastUpdated: Date.now(),
    });

    // NEO-208 security condition: an audit trail for a shared-row creation an
    // operator can trigger from a typeahead. Structured JSON, not concatenation
    // — the name is operator input and must not be able to shape a log line.
    console.log(
      JSON.stringify({ msg: "team_created", teamId: id, sportId: args.sportId, userId }),
    );

    /**
     * NEO-208 — enrich the team we just INSERTED, and only that.
     *
     * This was the one team-creation path in the product with no enrichment at
     * all. A team the review wizard creates arrives already enriched
     * (`processEntityReviewQueue` → `lookupTeamEnrichment` runs before the
     * insert); a career team the commit prelude invents is enqueued by
     * `commitCardChecklistFinalize` from `prelude.enrichmentTeamIds` (see
     * `selectorOptions.ts`, `resolveTeamIdByName`). A team born HERE — from
     * the drawer's picker, the attention walker's fixer, and since NEO-208 the
     * quick-add form — stayed bare forever, and `teams.colors` is what spine
     * labels read, so "bare forever" is user-visible.
     *
     * The early `return existing._id` above is what makes this honour
     * `enqueueEnrichment`'s CREATION-ONLY contract (see the contract note in
     * `wikidataPool.ts`): a team this mutation FOUND leaves without being
     * enqueued. Jason, 2026-09-02: "the enrichment writes should only fire if
     * the team is new. We should never be firing that on an update. Team data
     * generally doesn't change." Scheduled rather than awaited inline because
     * enrichment is a network round-trip and this is a mutation — the same
     * reason the prelude collects ids and lets finalize enqueue them.
     */
    await ctx.scheduler.runAfter(0, internal.wikidataPool.enqueueEnrichment, {
      teamIds: [id],
    });

    return id;
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
    await requireSignedIn(ctx);
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
  handler: async (ctx, args) => {
    await requireSignedIn(ctx);
    return await ctx.db.get(args.id);
  },
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
    await requireSignedIn(ctx);
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
    // NEO-203: fill-a-gap ONLY, on every field — same rule the `leagueId`
    // branch above already followed, now applied to the three that did not.
    //
    // Background enrichment must never overwrite an operator-visible value it
    // did not write. These three are all editable by hand in Team Management
    // (`updateTeam` below), and every one of them was being blindly restamped
    // on each re-enrichment: a corrected city, a hand-entered franchise span,
    // or hand-picked spine-label colors survived only until the next time the
    // team was enqueued — which a checklist commit does routinely
    // (`commitCardChecklistFinalize` → `wikidataPool.enqueueEnrichment`).
    //
    // Enrichment beating enrichment is still fine and still happens: a team
    // with no colors takes ESPN's here, and `resolveTeamColors` may then
    // supersede those with teamcolorcodes.com's better-covered answer — see
    // the ordering note in adapters/wikidata.ts `enrichTeam`. What changed is
    // that a value a HUMAN put there is no longer in that contest.
    if (args.city !== undefined && !existing.city) patch.city = args.city;
    if (args.yearsActive !== undefined && !existing.yearsActive) {
      patch.yearsActive = args.yearsActive;
    }
    if (
      args.colors !== undefined &&
      !existing.colors?.primary &&
      !existing.colors?.secondary
    ) {
      patch.colors = args.colors;
    }
    // NEO-212 security review: a `wikidataId` that is not `Q<digits>` is
    // DROPPED rather than stored — same rule and same reasoning as
    // `players.applyEnrichmentInternal`. The value arrives from
    // query.wikidata.org with no operator in the path, and a stored id is what
    // `enrichTeam`'s creation-only guard reads to decide the row is done.
    const enrichedQid =
      args.wikidataId !== undefined && isWikidataQid(args.wikidataId)
        ? args.wikidataId
        : undefined;
    if (enrichedQid !== undefined || args.espnId !== undefined) {
      patch.externalIds = {
        ...(existing.externalIds ?? {}),
        ...(enrichedQid !== undefined ? { wikidataId: enrichedQid } : {}),
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
 * NEO-99: the Wikidata leg enqueues onto the shared pool
 * (convex/wikidataPool.ts) rather than running inline, so this entry point
 * spends the SAME deployment-wide 5-parallel SPARQL budget as the
 * review-wizard drain instead of adding an uncoordinated request. The pool
 * runs enrichTeam in the background and it persists its own result; an
 * unenriched team is a valid end state.
 *
 * NEO-156 folded the legacy league conversion in here. It was a bulk
 * "backfill legacy leagues" button, which is a control that becomes
 * permanently useless the moment it succeeds; doing it as a side effect of
 * work already happening means the migration finishes without anyone
 * remembering to run it.
 *
 * `force` re-runs the color search for a team that already has a resolved
 * source — otherwise that step is skipped as already done. The color search
 * (teamColorSources, not Wikidata) still runs inline, which is what lets
 * this return an outcome at all.
 *
 * Returns the color outcome so the UI can say what happened. Enrichment errors
 * stay swallowed: it is best-effort by design, and an unchanged row IS the
 * "found nothing" signal.
 *
 * ## THE ONLY SANCTIONED PATH TO RE-ENRICH AN EXISTING TEAM (NEO-203)
 *
 * Jason, 2026-09-02: automatic enrichment fires for NEW teams only — "we should
 * never be firing that on an update. Team data generally doesn't change." This
 * action is the deliberate exception and the only one: it is admin-gated, it is
 * initiated by a human looking at the row, and it exists precisely for the case
 * where the stored answer is WRONG (a match against the wrong franchise), which
 * is the one situation where re-running a source is the remedy rather than
 * churn.
 *
 * That is why it passes `force` down both legs. `enrichTeam` otherwise skips
 * any team already carrying enrichment markers, which is every team an operator
 * would want to fix. Do NOT copy this flag into an automatic caller — see the
 * contract on `wikidataPool.enqueueEnrichment`.
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
      await ctx.runMutation(internal.wikidataPool.enqueueEnrichment, {
        teamIds: [args.id],
        // NEO-203: the operator exception. Without this the enqueued
        // `enrichTeam` would skip the team as already-enriched, which is
        // exactly the team this button exists to re-do.
        force: true,
      });
    } catch (error) {
      console.error("[teams.enrichFromWikidata] enqueue failed:", error);
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
      // NEO-203: stamp PROVENANCE alongside the value. `resolveTeamColors`
      // skips any team that already carries a `colorSource`, and hand-entered
      // colors carried none — so the next background lookup (which a checklist
      // commit schedules for every team it touches) overwrote them. Clearing
      // the colors clears the marker too, which puts the team back in the
      // automatic lane exactly as it was before anyone edited it.
      patch.colorSource = args.colors
        ? {
            url: MANUAL_COLOR_SOURCE_URL,
            matchedName: existing.name,
            resolvedAt: Date.now(),
          }
        : undefined;
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

// ---------------------------------------------------------------------------
// NEO-212 — the entity review wizard's dedup surface.
//
// The wizard's job is to stop a second "New York Yankees" row appearing under
// a different spelling. Three queries back that, in ascending softness:
// `resolveNames` (the exact key, in bulk, for the "will create N · M exist"
// line), `nearMatches` (exact + fuzzy, for the per-name "did you mean?"
// prompt), and `search` (free typeahead, for the operator who wants to go
// looking themselves).
//
// **Convex search semantics, as they bear on all three** (verified against the
// Convex docs, `docs/search/text-search.mdx`, on 2026-09-03):
//
//   * A search expression is split into words and matched word-wise, case- and
//     punctuation-insensitively. It is OR-ish, not AND: a document matching
//     ANY term can come back. Documents matching more terms rank higher, by
//     BM25 (word frequency, field length, match proximity), ties broken toward
//     newer documents.
//   * Prefix matching applies to the FINAL term only — searching "r" matches
//     "rabbit" and "send request", but "r nolan" prefix-matches only "nolan".
//   * Typo/fuzzy matching no longer exists (removed after 2025-01-15). A
//     misspelled token matches nothing.
//   * Hard limits: 16 terms per query, 8 filter expressions, terms truncated
//     at 32 characters, and at most 1024 index results scanned.
//
// That OR-ish behaviour is why `nearMatches` can search the whole name and
// still find a row storing only part of it. The single-token FALLBACK search
// exists for the other direction: with a multi-word query, every row sharing a
// generic leading token ("New …", "Los …") is also a hit, and BM25 can rank
// enough of them above the one row that actually matters to push it out of the
// ten we take. Re-querying on the distinctive token alone gives that row a
// field to itself. It is a second query rather than a wider `.take()` because
// the miss is a ranking problem, not a volume one.
// ---------------------------------------------------------------------------

/**
 * Default and maximum result counts for `search`. Mirrors `players.search` —
 * see its comment for why the cap matters more than the default.
 */
const TEAM_SEARCH_DEFAULT_LIMIT = 10;
const TEAM_SEARCH_MAX_LIMIT = 25;

/**
 * NEO-212: server-side team typeahead over the `search_name` index, the twin
 * of `players.search`.
 *
 * Signed-in rather than admin, and returning `[]` rather than throwing when
 * signed out, exactly as `players.search` does: team rows are globally-shared
 * reference data with no per-user fields (see `teamDocValidator`), so the gate
 * is about cost — a deployment URL ships in the client bundle and search is
 * the most expensive query class Convex offers — not confidentiality.
 *
 * An empty query returns nothing rather than the first N teams: a typeahead
 * that suggests before you type is noise, and it would be an unbounded browse.
 */
export const search = query({
  args: {
    query: v.string(),
    sportId: v.optional(v.id("selectorOptions")),
    limit: v.optional(v.number()),
  },
  returns: v.array(teamDocValidator),
  handler: async (ctx, args) => {
    if (!(await getCurrentUserId(ctx))) return [];

    const term = args.query.trim();
    if (!term) return [];

    // NEO-212 security review: FLOORED as well as capped. `Math.min` alone let
    // a client pass `limit: 0` or a negative, and Convex's `.take()` rejects a
    // negative outright — a thrown query inside `useQuery` unmounts the calling
    // component rather than returning nothing. Clamping into [1, MAX] keeps a
    // nonsense argument a nonsense RESULT instead of a crash.
    const limit = Math.max(
      1,
      Math.min(args.limit ?? TEAM_SEARCH_DEFAULT_LIMIT, TEAM_SEARCH_MAX_LIMIT),
    );

    return await ctx.db
      .query("teams")
      .withSearchIndex("search_name", (q) => {
        const search = q.search("name", term);
        return args.sportId ? search.eq("sportId", args.sportId) : search;
      })
      .take(limit);
  },
});

/**
 * The most names one `resolveNames` call will answer for.
 *
 * A single checklist fetch surfaces a few dozen unknown teams at the outside.
 * Over-length is REFUSED rather than truncated, and that is the whole point of
 * the bound: this query's only consumer is the wizard's "will create N new
 * teams · M already exist" line, and a silently truncated answer is a WRONG
 * COUNT — the operator reads "3 new" and commits 70. A thrown error is
 * something they can see.
 */
const RESOLVE_NAMES_MAX = 64;

/**
 * NEO-212: bulk existence check by the exact dedup key.
 *
 * Answers, for each submitted name, whether `commitCardChecklist` would find
 * an existing row or insert a new one — the same `normalizeTeamName` +
 * `by_name_normalized_and_sport_id` lookup `findOrCreate` performs, so the
 * wizard's preview and the commit cannot disagree. This is the STRICT
 * comparison; `nearMatches` below is the soft one, and the two are deliberately
 * separate: an operator needs to know both "this will be created" and "…but
 * something like it already exists".
 *
 * Returns one entry per input, in input order, duplicates included — the caller
 * zips the result against its own list. Names normalising to the same key are
 * looked up once.
 *
 * Admin-gated like every other operator-facing function in this file: the only
 * caller is the review wizard, which lives behind admin tooling.
 */
export const resolveNames = query({
  args: {
    names: v.array(v.string()),
    sportId: v.id("selectorOptions"),
  },
  returns: v.array(
    v.object({
      name: v.string(),
      existingTeamId: v.optional(v.id("teams")),
      existingName: v.optional(v.string()),
    }),
  ),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);

    if (args.names.length > RESOLVE_NAMES_MAX) {
      // The COUNT, never the names: this string reaches Sentry and the browser
      // console through Convex's error path.
      throw new ConvexError(
        `Too many names to resolve at once (${args.names.length}; max ${RESOLVE_NAMES_MAX}).`,
      );
    }

    const seen = new Map<string, { id: Id<"teams">; name: string } | null>();
    const results: Array<{
      name: string;
      existingTeamId?: Id<"teams">;
      existingName?: string;
    }> = [];

    for (const raw of args.names) {
      const normalized = normalizeTeamName(raw);
      // A name that normalises to nothing (punctuation only) can never match a
      // stored key, and must not be reported as existing.
      if (!normalized) {
        results.push({ name: raw });
        continue;
      }

      if (!seen.has(normalized)) {
        const found = await ctx.db
          .query("teams")
          .withIndex("by_name_normalized_and_sport_id", (q) =>
            q.eq("nameNormalized", normalized).eq("sportId", args.sportId),
          )
          .first();
        seen.set(
          normalized,
          found ? { id: found._id, name: found.name } : null,
        );
      }

      const hit = seen.get(normalized) ?? null;
      results.push(
        hit
          ? { name: raw, existingTeamId: hit.id, existingName: hit.name }
          : { name: raw },
      );
    }

    return results;
  },
});

/** How many search-index rows feed the ranker, and how many rank out by default. */
const NEAR_MATCH_SEARCH_CANDIDATES = 10;
const NEAR_MATCH_DEFAULT_LIMIT = 5;
const NEAR_MATCH_MAX_LIMIT = 25;

/**
 * NEO-212: the "did you mean?" prompt in front of creating a team.
 *
 * Three steps, widening:
 *
 *   1. The exact dedup key, via `by_name_normalized_and_sport_id`. Cheap, and
 *      it is the one hit that must never be missed — a row `findOrCreate`
 *      would silently reuse.
 *   2. The `search_name` index on the whole name, then, only if that returned
 *      nothing at all, a second search on the name's longest token. See the
 *      section header above for what Convex's search actually does and why the
 *      fallback is a separate query.
 *   3. `rankTeamCandidates` over the union, dropping everything it ranks
 *      neither exact nor close.
 *
 * Advisory only. Nothing here may auto-merge or auto-skip: `close` is a
 * heuristic over case-folded containment and shared tokens, and the operator is
 * the one who knows whether the 1962 Mets and the Mets are the same row.
 */
export const nearMatches = query({
  args: {
    name: v.string(),
    sportId: v.id("selectorOptions"),
    limit: v.optional(v.number()),
  },
  returns: v.array(
    v.object({
      _id: v.id("teams"),
      name: v.string(),
      confidence: v.union(v.literal("exact"), v.literal("close")),
    }),
  ),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);

    const name = args.name.trim();
    if (!name) return [];
    // NEO-212 security review: the same bound `findOrCreate` puts on a STORED
    // team name, applied to the search term. Nothing longer than a storable
    // name could ever match a stored row, so refusing costs nothing real, and
    // an unbounded term otherwise reaches both the search index and
    // `rankTeamCandidates`'s per-token work. Refused rather than truncated,
    // matching the write path.
    if (name.length > MAX_TEAM_NAME_LENGTH) {
      throw new ConvexError(
        `A team name is ${name.length} characters; the limit is ${MAX_TEAM_NAME_LENGTH}.`,
      );
    }

    // Floored as well as capped: `limit: 0` returned an empty list that reads
    // as "nothing like this exists" — the exact wrong answer from a query whose
    // only job is to warn before a duplicate write — and `limit: -1` made
    // `.slice(0, -1)` silently drop the last candidate.
    const limit = Math.max(
      1,
      Math.min(args.limit ?? NEAR_MATCH_DEFAULT_LIMIT, NEAR_MATCH_MAX_LIMIT),
    );

    // Keyed by id so the exact hit and a search hit for the same row collapse.
    const candidates = new Map<Id<"teams">, { _id: Id<"teams">; name: string }>();

    const normalized = normalizeTeamName(name);
    if (normalized) {
      const exact = await ctx.db
        .query("teams")
        .withIndex("by_name_normalized_and_sport_id", (q) =>
          q.eq("nameNormalized", normalized).eq("sportId", args.sportId),
        )
        .first();
      if (exact) candidates.set(exact._id, { _id: exact._id, name: exact.name });
    }

    const searchTeams = async (term: string) =>
      await ctx.db
        .query("teams")
        .withSearchIndex("search_name", (q) =>
          q.search("name", term).eq("sportId", args.sportId),
        )
        .take(NEAR_MATCH_SEARCH_CANDIDATES);

    let hits = await searchTeams(name);
    if (hits.length === 0) {
      const fallbackTerm = longestToken(name);
      if (fallbackTerm) hits = await searchTeams(fallbackTerm);
    }
    for (const hit of hits) {
      candidates.set(hit._id, { _id: hit._id, name: hit.name });
    }

    const rows = [...candidates.values()];
    return rankTeamCandidates(name, rows)
      .slice(0, limit)
      .map(({ index, confidence }) => ({
        _id: rows[index]._id,
        name: rows[index].name,
        confidence,
      }));
  },
});
