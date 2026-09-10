/**
 * NEO-147/156 — resolving a team's colors against teamcolorcodes.com.
 *
 * ## No cache, by decision
 *
 * This module used to mirror the site's ~2190 pages into a `teamColorSources`
 * table that an operator had to remember to refresh. NEO-156 deleted it. A
 * local copy of someone else's data goes stale silently — a team added
 * upstream simply stopped being findable until a human pressed a button, and
 * nothing surfaced that. The lookup now reads the sitemap live at the moment
 * someone asks.
 *
 * That trade is only sound because the ask is manual and one team at a time:
 * a search costs the sitemap index plus up to four children, roughly 1.5MB.
 * **Nothing here may be called from a loop, a background queue, or a render
 * path.** `enrichTeam` deliberately does NOT call it for that reason — the
 * queues feed it dozens of teams at a time.
 *
 * ## Ambiguity is still never guessed
 *
 * The site carries 10+ distinct "Huskies". Several matches park in
 * `teams.colorCandidates` for a human to pick from, and picking sends an
 * INDEX rather than a URL — see `chooseColorSource`.
 */

import { v } from "convex/values";
import { action, internalMutation, internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireAdmin } from "./auth";
import { colorSourceMatchKey, fetchTeamColors, findTeamColorPages } from "./adapters/teamColorCodes";
// NEO-236: teamcolorcodes.com names teams in full ("San Diego Padres"), so
// every match here is on the composed name.
import { teamFullName } from "../lib/teams/team-name";

/**
 * NEO-203 — provenance for colors an OPERATOR typed in Team Management.
 *
 * `resolveTeamColors` below already refuses to overwrite a team that carries a
 * `colorSource` unless explicitly forced. Hand-entered colors had no
 * provenance at all, so they failed that check and were silently replaced by
 * the next background lookup — and a checklist commit enqueues one
 * (`commitCardChecklistFinalize` → `wikidataPool.enqueueEnrichment` →
 * `enrichTeam`), so "the operator's colors survive until the next sync" was
 * the real behaviour.
 *
 * Stamped by `teams.updateTeam`. A `colorSource.url` that names where the
 * answer came from when it was not a fetched page.
 */
export const MANUAL_COLOR_SOURCE_URL = "operator:team-management";

const sourceEntryValidator = v.object({
  name: v.string(),
  url: v.string(),
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
    /** Explicitly clear a stale ambiguity when a search now finds nothing. */
    clearCandidates: v.optional(v.boolean()),
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
    if (args.clearCandidates) patch.colorCandidates = undefined;

    await ctx.db.patch(args.teamId, patch);
    return null;
  },
});

export type ResolveOutcome =
  | "resolved"
  | "ambiguous"
  | "no-match"
  | "skipped"
  | "unreadable";

/**
 * Search for one team's colors and apply what is found.
 *
 * Three outcomes, and the distinction between the last two is the whole point
 * of never guessing:
 *
 *  - exactly one match → fetch the page, write colors + `colorSource`
 *  - several matches   → write `colorCandidates`, write NOTHING to `colors`
 *  - no match          → write nothing; the team stays eligible for a retry
 *
 * `force` re-runs a team that already has a resolved source, which is what the
 * operator wants when a match turns out to be the wrong franchise.
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
  handler: async (ctx, args): Promise<ResolveOutcome> => {
    const team = await ctx.runQuery(internal.teams.getInternal, {
      id: args.teamId,
    });
    if (!team) return "skipped";
    if (team.colorSource && !args.force) return "skipped";

    // NEO-236: the FULL name is the match key for every step below. The source
    // site's pages are titled "San Diego Padres"; a split row's `name` alone is
    // "Padres", which matches nothing there and would collide the two Chicago
    // and two Los Angeles franchises with each other.
    const fullName = teamFullName(team);
    if (!colorSourceMatchKey(fullName)) return "no-match";

    const matches = await findTeamColorPages(fullName);

    if (matches.length === 0) {
      // Clear a previous ambiguity: the operator asked again and the answer is
      // now "nothing", so leaving stale candidates on screen would be a lie.
      if ((team.colorCandidates?.length ?? 0) > 0) {
        await ctx.runMutation(internal.teamColorSources.applyColorsInternal, {
          teamId: args.teamId,
          clearCandidates: true,
        });
      }
      return "no-match";
    }

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
      // The page exists but yielded no colors — a shape change, or a stub.
      // Deliberately does NOT write `colorSource`, so a later attempt retries
      // instead of treating this team as permanently done.
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
 * Human resolution of an ambiguous match, from Team Management.
 *
 * SECURITY — why this takes an INDEX and not a URL:
 *
 * The obvious API is "the client sends back the URL it picked", and it is
 * wrong. A Convex action's `fetch` runs inside Convex's network, so accepting
 * a caller-supplied URL makes this a server-side request forgery primitive: an
 * admin session, or any CSRF-shaped mistake on an admin surface, could aim our
 * backend at an arbitrary host and read the outcome through the
 * resolved/unreadable/timing signal. `requireAdmin` bounds WHO calls this, not
 * WHERE it points.
 *
 * Validating an incoming URL against the stored candidates would also close
 * it, but it keeps the bad shape — a scrape target crossing the trust boundary
 * with the server obliged to prove it legitimate, a check a later edit can
 * weaken. Taking an index means no URL is representable in the argument
 * validator at all.
 */
export const chooseColorSource = action({
  args: { teamId: v.id("teams"), candidateIndex: v.number() },
  returns: v.union(v.literal("resolved"), v.literal("unreadable")),
  handler: async (ctx, args): Promise<"resolved" | "unreadable"> => {
    await requireAdmin(ctx);

    const team = await ctx.runQuery(internal.teams.getInternal, {
      id: args.teamId,
    });
    if (!team) throw new Error("Team not found");

    const candidate = (team.colorCandidates ?? [])[args.candidateIndex];
    if (!candidate) throw new Error("No such color source for this team");

    const parsed = await fetchTeamColors(candidate.url);
    if (!parsed || !parsed.primary) return "unreadable";

    await ctx.runMutation(internal.teamColorSources.applyColorsInternal, {
      teamId: args.teamId,
      colors: { primary: parsed.primary, secondary: parsed.secondary },
      colorSource: {
        url: candidate.url,
        matchedName: candidate.name,
        resolvedAt: Date.now(),
      },
    });
    return "resolved";
  },
});
