/**
 * NEO-147: the cached teamcolorcodes.com page index, and colour resolution
 * against it.
 *
 * Why an index table at all: the site's slugs cannot be constructed (see
 * `adapters/teamColorCodes.ts`), so every match has to go through an
 * enumeration of ~2190 team pages. Enrichment runs one team per action
 * invocation, paced by the queue's INTER_ENTITY_DELAY_MS, so caching this in
 * module state would re-fetch ~1.5MB of sitemap per team.
 *
 * Refreshing is an explicit admin operation. Nothing here is on a read path.
 */

import { v } from "convex/values";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  query,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { requireAdmin } from "./auth";
import {
  colorSourceMatchKey,
  fetchTeamColorSourceIndex,
  fetchTeamColors,
} from "./adapters/teamColorCodes";

/**
 * Rows written per mutation while refreshing.
 *
 * Each entry costs one indexed read (the upsert probe) plus one write, so this
 * stays comfortably inside a single mutation's document budget while keeping
 * the whole refresh to ~6 mutations rather than ~2190.
 */
const REFRESH_CHUNK_SIZE = 400;

/** Stale rows deleted per mutation during the sweep at the end of a refresh. */
const DELETE_CHUNK_SIZE = 400;

const sourceEntryValidator = v.object({
  name: v.string(),
  url: v.string(),
});

// ---------------------------------------------------------------------------
// Index maintenance
// ---------------------------------------------------------------------------

/**
 * Upsert one chunk, stamping `refreshedAt` on every row it touches.
 *
 * Upsert rather than wipe-and-insert so the table is never empty mid-refresh —
 * a concurrent enrichment reading it gets either the old answer or the new
 * one, never "no such team".
 */
export const upsertChunkInternal = internalMutation({
  args: {
    entries: v.array(sourceEntryValidator),
    refreshedAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    for (const entry of args.entries) {
      const nameKey = colorSourceMatchKey(entry.name);
      if (!nameKey) continue;
      const existing = await ctx.db
        .query("teamColorSources")
        .withIndex("by_name_key", (q) => q.eq("nameKey", nameKey))
        .first();
      if (existing) {
        await ctx.db.patch(existing._id, {
          name: entry.name,
          url: entry.url,
          refreshedAt: args.refreshedAt,
        });
      } else {
        await ctx.db.insert("teamColorSources", {
          name: entry.name,
          nameKey,
          url: entry.url,
          refreshedAt: args.refreshedAt,
        });
      }
    }
    return null;
  },
});

/**
 * Delete rows the current refresh did not touch — pages that left the sitemap.
 * Returns how many it deleted so the caller can loop until the sweep is dry.
 */
export const deleteStaleChunkInternal = internalMutation({
  args: { refreshedAt: v.number() },
  returns: v.object({ deleted: v.number() }),
  handler: async (ctx, args) => {
    const stale = await ctx.db
      .query("teamColorSources")
      .filter((q) => q.lt(q.field("refreshedAt"), args.refreshedAt))
      .take(DELETE_CHUNK_SIZE);
    for (const row of stale) await ctx.db.delete(row._id);
    return { deleted: stale.length };
  },
});

/**
 * Re-enumerate the site into the index.
 *
 * Safe to re-run: it is a full upsert plus a stale sweep, so it converges on
 * whatever the sitemap currently says. Refuses to touch anything when the
 * fetch comes back empty — an unreachable site must not empty the table.
 */
export const refreshIndex = action({
  args: {},
  returns: v.object({ indexed: v.number(), removed: v.number() }),
  handler: async (ctx): Promise<{ indexed: number; removed: number }> => {
    await requireAdmin(ctx);

    const entries = await fetchTeamColorSourceIndex();
    if (entries.length === 0) {
      // Every failure mode in the adapter funnels to []. Wiping a good index
      // because the site was briefly down would turn a transient outage into
      // a permanent loss of every resolved match.
      console.warn("[teamColorSources] refresh aborted — source index was empty");
      return { indexed: 0, removed: 0 };
    }

    const refreshedAt = Date.now();
    for (let i = 0; i < entries.length; i += REFRESH_CHUNK_SIZE) {
      await ctx.runMutation(internal.teamColorSources.upsertChunkInternal, {
        entries: entries.slice(i, i + REFRESH_CHUNK_SIZE),
        refreshedAt,
      });
    }

    let removed = 0;
    for (;;) {
      const { deleted } = await ctx.runMutation(
        internal.teamColorSources.deleteStaleChunkInternal,
        { refreshedAt },
      );
      removed += deleted;
      if (deleted < DELETE_CHUNK_SIZE) break;
    }

    return { indexed: entries.length, removed };
  },
});

/** How many pages the index currently holds — drives the admin UI's empty state. */
export const indexStatus = query({
  args: {},
  returns: v.object({ count: v.number(), refreshedAt: v.union(v.number(), v.null()) }),
  handler: async (ctx) => {
    // `take` bounds the read; the exact count past the cap is not interesting,
    // the UI only needs "empty / stale / populated".
    const rows = await ctx.db.query("teamColorSources").take(5000);
    const refreshedAt = rows.length
      ? rows.reduce((max, r) => Math.max(max, r.refreshedAt), 0)
      : null;
    return { count: rows.length, refreshedAt };
  },
});

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export const findByNameKeyInternal = internalQuery({
  args: { nameKey: v.string() },
  returns: v.array(sourceEntryValidator),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("teamColorSources")
      .withIndex("by_name_key", (q) => q.eq("nameKey", args.nameKey))
      .collect();
    return rows.map((r) => ({ name: r.name, url: r.url }));
  },
});

export const applyColorsInternal = internalMutation({
  args: {
    teamId: v.id("teams"),
    colors: v.optional(v.object({
      primary: v.optional(v.string()),
      secondary: v.optional(v.string()),
    })),
    colorSource: v.optional(v.object({
      url: v.string(),
      matchedName: v.string(),
      resolvedAt: v.number(),
    })),
    colorCandidates: v.optional(v.array(sourceEntryValidator)),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const team = await ctx.db.get(args.teamId);
    if (!team) return null;

    const patch: Record<string, unknown> = { lastUpdated: Date.now() };
    if (args.colors) patch.colors = args.colors;
    if (args.colorSource) {
      patch.colorSource = args.colorSource;
      // Resolving supersedes any ambiguity that was parked here.
      patch.colorCandidates = undefined;
    }
    if (args.colorCandidates) patch.colorCandidates = args.colorCandidates;

    await ctx.db.patch(args.teamId, patch);
    return null;
  },
});

/**
 * Resolve one team's colors against the cached index.
 *
 * Three outcomes, and the distinction between the last two is the whole point
 * of the ticket's "ambiguous matches go to a human" requirement:
 *
 *  - exactly one match  → fetch the page, write colors + `colorSource`
 *  - several matches    → write `colorCandidates`, write NOTHING to `colors`
 *  - no match           → write nothing; the team stays visible to the backfill
 *
 * Several is common, not exotic: the site carries 10+ distinct "Huskies".
 * Guessing one would silently print a binder in another school's colors.
 *
 * Teams that already carry `colorSource` are skipped, which is what makes the
 * backfill re-runnable — including for a team a human resolved by hand.
 */
export const resolveTeamColors = internalAction({
  args: { teamId: v.id("teams"), force: v.optional(v.boolean()) },
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
    const team = await ctx.runQuery(internal.teams.getInternal, {
      id: args.teamId,
    });
    if (!team) return "skipped";
    if (team.colorSource && !args.force) return "skipped";

    const nameKey = colorSourceMatchKey(team.name);
    if (!nameKey) return "no-match";

    const matches = await ctx.runQuery(
      internal.teamColorSources.findByNameKeyInternal,
      { nameKey },
    );

    if (matches.length === 0) return "no-match";

    if (matches.length > 1) {
      await ctx.runMutation(internal.teamColorSources.applyColorsInternal, {
        teamId: args.teamId,
        colorCandidates: matches,
      });
      return "ambiguous";
    }

    const match = matches[0];
    const parsed = await fetchTeamColors(match.url);
    if (!parsed || !parsed.primary) {
      // The page exists but did not yield colors — a shape change, or a stub
      // page. Deliberately does NOT write `colorSource`, so a later re-run
      // retries instead of treating this team as permanently done.
      return "unreadable";
    }

    await ctx.runMutation(internal.teamColorSources.applyColorsInternal, {
      teamId: args.teamId,
      colors: { primary: parsed.primary, secondary: parsed.secondary },
      colorSource: {
        url: match.url,
        matchedName: match.name,
        resolvedAt: Date.now(),
      },
    });
    return "resolved";
  },
});

/**
 * Human resolution of an ambiguous match, from the team editor.
 *
 * Takes the URL the user picked out of `colorCandidates` rather than a colour,
 * so the row ends up indistinguishable from an automatic resolution — same
 * provenance, same skip behaviour on the next backfill.
 */
export const chooseColorSource = action({
  args: { teamId: v.id("teams"), url: v.string() },
  returns: v.union(v.literal("resolved"), v.literal("unreadable")),
  handler: async (ctx, args): Promise<"resolved" | "unreadable"> => {
    await requireAdmin(ctx);

    const parsed = await fetchTeamColors(args.url);
    if (!parsed || !parsed.primary) return "unreadable";

    await ctx.runMutation(internal.teamColorSources.applyColorsInternal, {
      teamId: args.teamId as Id<"teams">,
      colors: { primary: parsed.primary, secondary: parsed.secondary },
      colorSource: {
        url: args.url,
        matchedName: parsed.heading,
        resolvedAt: Date.now(),
      },
    });
    return "resolved";
  },
});
