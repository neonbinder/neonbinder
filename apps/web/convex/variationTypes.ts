import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { requireAdmin } from "./auth";
import {
  BOOTSTRAP_VARIATION_ALIASES,
  displayVariationLabel,
  variationLabelKey,
} from "../lib/cards/variations";

/**
 * NEO-189 — the NeonBinder variation vocabulary, and the reconciliation that
 * fills it.
 *
 * ## The problem this exists to solve
 *
 * BSC and SportLots name the same printing variation differently, and the
 * product owner's position (2026-08-27) is that mismatches are **very common**:
 *
 *   NeonBinder            BSC              SportLots
 *   Action                Action           Action Image
 *   Throwback Alternate   Alternate        Throwback Alternate
 *   Team Color Swap       Team Color       Team Name Color Swap
 *
 * Two of the six pairs measured are worded completely differently. Storing
 * whichever marketplace synced last would make the same card's variation change
 * name depending on sync order, so **NeonBinder owns the name** and each
 * marketplace's spelling is recorded as a link.
 *
 * ## Why the admin decides, not a table in the source
 *
 * We only have evidence for six pairs, from one set. Every set nobody has
 * looked at will contain names not on that list, and guessing is how you
 * silently merge two different variations or split one into two. So an
 * unrecognised label is **not** an error and **not** auto-mapped: it is
 * surfaced to the admin building the set, who either points it at an existing
 * canonical name or creates a new one. That decision is stored and never asked
 * again.
 *
 * This mirrors `entityReviewQueue`, which does exactly this for unknown player
 * and team names. Wiring variation labels into that same wizard is the
 * intended integration (see NEO-189) — deliberately left until the review-step
 * redesign shared with NEO-101/NEO-102, so three tickets do not each build
 * their own dialog.
 */

const platformValidator = v.union(v.literal("bsc"), v.literal("sportlots"));

/** One marketplace label the admin has not ruled on yet. */
const unresolvedLabelValidator = v.object({
  platform: platformValidator,
  labelRaw: v.string(),
  labelKey: v.string(),
});

/**
 * Resolve marketplace variation labels to canonical NeonBinder names.
 *
 * Returns a decision for every label it can, and reports the rest as
 * `unresolved` — the queue the reconciliation step works from. A caller must
 * NOT fall back to using the raw label as if it were canonical; that is the
 * silent-merge failure this whole module exists to prevent.
 */
export const resolveVariationLabels = query({
  args: {
    labels: v.array(v.object({ platform: platformValidator, label: v.string() })),
  },
  returns: v.object({
    resolved: v.array(
      v.object({
        platform: platformValidator,
        labelKey: v.string(),
        canonicalName: v.string(),
        variationTypeId: v.id("variationTypes"),
      }),
    ),
    unresolved: v.array(unresolvedLabelValidator),
  }),
  handler: async (ctx, args) => {
    const resolved: Array<{
      platform: "bsc" | "sportlots";
      labelKey: string;
      canonicalName: string;
      variationTypeId: Id<"variationTypes">;
    }> = [];
    const unresolved: Array<{
      platform: "bsc" | "sportlots";
      labelRaw: string;
      labelKey: string;
    }> = [];

    // De-dupe first: a 900-card set hits the same handful of labels hundreds of
    // times, and each distinct one is a single indexed read.
    const seen = new Set<string>();
    for (const { platform, label } of args.labels) {
      const labelKey = variationLabelKey(label);
      if (!labelKey) continue;
      const dedupeKey = `${platform}:${labelKey}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      const alias = await ctx.db
        .query("variationTypeAliases")
        .withIndex("by_platform_and_label", (q) =>
          q.eq("platform", platform).eq("labelKey", labelKey),
        )
        .unique();

      if (!alias) {
        unresolved.push({
          platform,
          labelRaw: displayVariationLabel(label),
          labelKey,
        });
        continue;
      }
      const type = await ctx.db.get(alias.variationTypeId);
      if (!type) {
        // The alias outlived its type. Treat as unresolved rather than
        // throwing: the admin can simply re-decide it.
        unresolved.push({
          platform,
          labelRaw: displayVariationLabel(label),
          labelKey,
        });
        continue;
      }
      resolved.push({
        platform,
        labelKey,
        canonicalName: type.name,
        variationTypeId: type._id,
      });
    }

    return { resolved, unresolved };
  },
});

/** The whole vocabulary, for the reconciliation step's "link to existing" list. */
export const listVariationTypes = query({
  args: {},
  returns: v.array(
    v.object({
      _id: v.id("variationTypes"),
      _creationTime: v.number(),
      name: v.string(),
      nameNormalized: v.string(),
      createdByUserId: v.optional(v.string()),
      lastUpdated: v.number(),
    }),
  ),
  handler: async (ctx) => {
    return await ctx.db.query("variationTypes").collect();
  },
});

/**
 * Record the admin's decision for one marketplace label.
 *
 * `link` points the label at an existing canonical name; `create` mints a new
 * one. Both write the alias, so the same label is never asked about twice.
 *
 * Idempotent on the (platform, label) pair — re-deciding overwrites, which is
 * what an admin correcting a mistake expects.
 */
export const decideVariationLabel = mutation({
  args: {
    platform: platformValidator,
    label: v.string(),
    decision: v.union(
      v.object({
        action: v.literal("link"),
        variationTypeId: v.id("variationTypes"),
      }),
      v.object({ action: v.literal("create"), name: v.string() }),
    ),
  },
  returns: v.object({
    variationTypeId: v.id("variationTypes"),
    canonicalName: v.string(),
  }),
  handler: async (ctx, args) => {
    const userId = await requireAdmin(ctx);
    const labelKey = variationLabelKey(args.label);
    if (!labelKey) throw new Error("decideVariationLabel: empty label");

    let variationTypeId: Id<"variationTypes">;
    let canonicalName: string;

    if (args.decision.action === "link") {
      const type = await ctx.db.get(args.decision.variationTypeId);
      if (!type) throw new Error("decideVariationLabel: no such variation type");
      variationTypeId = type._id;
      canonicalName = type.name;
    } else {
      const name = displayVariationLabel(args.decision.name);
      if (!name) throw new Error("decideVariationLabel: empty name");
      const nameNormalized = variationLabelKey(name);
      // Creating a name that already exists is a link, not a duplicate row —
      // two admins reaching for "Nickname" independently must converge.
      const existing = await ctx.db
        .query("variationTypes")
        .withIndex("by_name_normalized", (q) =>
          q.eq("nameNormalized", nameNormalized),
        )
        .unique();
      if (existing) {
        variationTypeId = existing._id;
        canonicalName = existing.name;
      } else {
        variationTypeId = await ctx.db.insert("variationTypes", {
          name,
          nameNormalized,
          createdByUserId: userId,
          lastUpdated: Date.now(),
        });
        canonicalName = name;
      }
    }

    const existingAlias = await ctx.db
      .query("variationTypeAliases")
      .withIndex("by_platform_and_label", (q) =>
        q.eq("platform", args.platform).eq("labelKey", labelKey),
      )
      .unique();

    const patch = {
      platform: args.platform,
      labelKey,
      labelRaw: displayVariationLabel(args.label),
      variationTypeId,
      decidedByUserId: userId,
      lastUpdated: Date.now(),
    };
    if (existingAlias) await ctx.db.patch(existingAlias._id, patch);
    else await ctx.db.insert("variationTypeAliases", patch);

    return { variationTypeId, canonicalName };
  },
});

/**
 * Seed the six measured pairs, once, into an empty vocabulary.
 *
 * Bootstrap ONLY: it never overwrites a decision an admin has made, and nothing
 * consults `BOOTSTRAP_VARIATION_ALIASES` at runtime. The seeded rows carry no
 * `decidedByUserId`, which is how the UI can show them as "proposed" and invite
 * a rename — the canonical spellings in the seed are a starting proposal, not a
 * product decision.
 */
export const seedVariationTypes = internalMutation({
  args: {},
  returns: v.object({ typesCreated: v.number(), aliasesCreated: v.number() }),
  handler: async (ctx) => {
    let typesCreated = 0;
    let aliasesCreated = 0;

    for (const entry of BOOTSTRAP_VARIATION_ALIASES) {
      const nameNormalized = variationLabelKey(entry.canonical);
      let type = await ctx.db
        .query("variationTypes")
        .withIndex("by_name_normalized", (q) =>
          q.eq("nameNormalized", nameNormalized),
        )
        .unique();
      if (!type) {
        const id = await ctx.db.insert("variationTypes", {
          name: entry.canonical,
          nameNormalized,
          lastUpdated: Date.now(),
        });
        type = await ctx.db.get(id);
        typesCreated++;
      }
      if (!type) continue;

      for (const [platform, labels] of [
        ["bsc", entry.bsc],
        ["sportlots", entry.sportlots],
      ] as const) {
        for (const label of labels) {
          const labelKey = variationLabelKey(label);
          const existing = await ctx.db
            .query("variationTypeAliases")
            .withIndex("by_platform_and_label", (q) =>
              q.eq("platform", platform).eq("labelKey", labelKey),
            )
            .unique();
          // Never clobber a real decision with a seed.
          if (existing) continue;
          await ctx.db.insert("variationTypeAliases", {
            platform,
            labelKey,
            labelRaw: label,
            variationTypeId: type._id,
            lastUpdated: Date.now(),
          });
          aliasesCreated++;
        }
      }
    }

    return { typesCreated, aliasesCreated };
  },
});
