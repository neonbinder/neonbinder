import { query, mutation, internalMutation, internalQuery, action } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { requireAdmin } from "./auth";

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
  returns: v.object({ created: v.number(), existing: v.number() }),
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

    const seeds = [{ name: "New York Yankees" }, { name: "New York Mets" }];
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
      if (matches.find((t) => t.sportId === baseballRow._id)) {
        existing += 1;
        continue;
      }
      await ctx.db.insert("teams", {
        name: seed.name,
        nameNormalized: normalized,
        sportId: baseballRow._id,
        lastUpdated: Date.now(),
      });
      created += 1;
    }
    return { created, existing };
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
      league?: string;
      city?: string;
      yearsActive?: { from: number; to?: number };
      colors?: { primary?: string; secondary?: string };
      externalIds?: { wikidataId?: string; espnId?: string };
      lastUpdated: number;
    } = { lastUpdated: Date.now() };

    if (args.league !== undefined) patch.league = args.league;
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
 * Per-team enrichment, on demand — the "Discover" button in the Set Builder
 * team editor (NEO-147).
 *
 * NEO-147 added `requireAdmin`. This action predates any caller (it had none
 * until the team editor), and as a public action with no authorization check
 * it let any client spend an outbound ESPN/Wikidata/teamColorCodes round-trip
 * per call, for any team id, at any rate. Enrichment writes to globally-shared
 * team rows, so it belongs behind the same boundary as every other write here.
 *
 * Errors are swallowed rather than thrown: enrichment is best-effort by
 * design (`lookupTeamEnrichment` returns null when no source matches), and the
 * caller's job is to show the user what landed on the row, not to distinguish
 * "no match" from "source was down". The editor re-reads the team after this
 * resolves, so an unchanged row IS the "found nothing" signal.
 */
export const enrichFromWikidata = action({
  args: { id: v.id("teams") },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    await requireAdmin(ctx);
    try {
      await ctx.runAction(internal.adapters.wikidata.enrichTeam, { teamId: args.id });
    } catch (error) {
      console.error("[teams.enrichFromWikidata] failed:", error);
    }
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
    league: v.optional(v.union(v.string(), v.null())),
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
    if (args.league !== undefined) patch.league = args.league ?? undefined;
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

/**
 * How many teams one "enrich the unenriched" pass will pick up.
 *
 * The queue paces itself at INTER_ENTITY_DELAY_MS (3s) per team, so this is a
 * duration cap as much as a count: 50 teams is ~2.5 minutes of trickle. The
 * pass is idempotent and cheap to repeat, so draining a large backlog is
 * several clicks rather than one long-running job that can fail halfway.
 */
const ENRICH_UNENRICHED_BATCH = 50;

/**
 * NEO-147: enqueue every team that still has no colors.
 *
 * Two populations need this, for different reasons:
 *
 *  - Career teams created by commitCardChecklist's `resolveTeamIdByName`
 *    BEFORE that path started enqueueing them (see the NEO-147 note there).
 *    They were inserted bare and had no route to enrichment at all.
 *  - Teams whose enrichment genuinely ran but found nothing at the time. The
 *    58-row prod survey showed espnId 0/58 — ESPN carries no NPB, MiLB,
 *    Dominican winter league, or NCAA baseball, which is most of that table.
 *    Now that `enrichTeam` also resolves against teamcolorcodes.com (see
 *    convex/teamColorSources.ts), re-running them can succeed where it
 *    previously could not.
 *
 * Selecting on "no colors AND no resolved source" is what makes repeat passes
 * cheap without tracking attempt counts. `colorSource` is the durable "this
 * one is done" marker — it is written both by an automatic resolution and by a
 * human picking from `colorCandidates`, so neither gets re-fetched on the next
 * pass.
 *
 * A team that no source will ever carry (Estrellas Orientales) still has
 * neither, so it stays in the result set and is retried on each pass. That is
 * the deliberate cost of not recording failures, bounded by the batch cap;
 * entering its colors by hand in the editor removes it permanently.
 */
export const enrichUnenrichedTeams = mutation({
  args: {
    sportId: v.optional(v.id("selectorOptions")),
    limit: v.optional(v.number()),
  },
  returns: v.object({ enqueued: v.number() }),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const limit = Math.min(args.limit ?? ENRICH_UNENRICHED_BATCH, ENRICH_UNENRICHED_BATCH);

    const rows = args.sportId
      ? await ctx.db
          .query("teams")
          .withIndex("by_sport_id", (q) => q.eq("sportId", args.sportId!))
          .collect()
      : await ctx.db.query("teams").collect();

    const needsColors = rows
      .filter((t) => !t.colors?.primary && !t.colorSource)
      .slice(0, limit)
      .map((t) => t._id);

    if (needsColors.length > 0) {
      await ctx.scheduler.runAfter(
        0,
        internal.adapters.wikidata.processEnrichmentQueue,
        { playerIds: [], teamIds: needsColors },
      );
    }
    return { enqueued: needsColors.length };
  },
});

/** Rows returned per bucket by `listColorReview`. Enough to work through, not a browse. */
const COLOR_REVIEW_PAGE = 50;

/**
 * NEO-147: the admin team-colors worklist.
 *
 * Two buckets, because they need different actions from the human:
 *
 *  - `ambiguous` — the backfill matched several source pages and refused to
 *    guess. One click resolves it (`teamColorSources.chooseColorSource`).
 *  - `missing` — no colors and no resolved source. Either the backfill has not
 *    reached this row yet, or no source will ever carry it (Estrellas
 *    Orientales), in which case the fix is typing two hex values.
 *
 * `resolvedCount` is reported so the admin can see the backfill making
 * progress rather than inferring it from a shrinking worklist.
 */
export const listColorReview = query({
  args: { sportId: v.optional(v.id("selectorOptions")) },
  returns: v.object({
    ambiguous: v.array(teamDocValidator),
    missing: v.array(teamDocValidator),
    resolvedCount: v.number(),
    totalCount: v.number(),
  }),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);

    const rows = args.sportId
      ? await ctx.db
          .query("teams")
          .withIndex("by_sport_id", (q) => q.eq("sportId", args.sportId!))
          .collect()
      : await ctx.db.query("teams").collect();

    const ambiguous = rows.filter((t) => (t.colorCandidates?.length ?? 0) > 0);
    const missing = rows.filter(
      (t) => !t.colors?.primary && (t.colorCandidates?.length ?? 0) === 0,
    );

    return {
      ambiguous: ambiguous.slice(0, COLOR_REVIEW_PAGE),
      missing: missing.slice(0, COLOR_REVIEW_PAGE),
      resolvedCount: rows.filter((t) => Boolean(t.colors?.primary)).length,
      totalCount: rows.length,
    };
  },
});
