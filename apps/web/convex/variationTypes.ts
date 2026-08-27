import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireAdmin } from "./auth";
import { displayVariationLabel, variationLabelKey } from "../lib/cards/variations";

/**
 * NEO-189 — the NeonBinder vocabulary of card-variation names.
 *
 * "Action", "Nickname", "Team Color Swap". A controlled list for the same
 * reason `leagues` is one: an admin picks a name rather than forty people
 * typing it forty ways, and renaming it once fixes every card that uses it.
 *
 * ## What is deliberately NOT here
 *
 * Any record of what a marketplace calls a variation. An earlier draft carried
 * a `variationTypeAliases` table mapping BSC's "Action" and SportLots'
 * "Action Image" onto one name. The product owner removed it (2026-08-27):
 *
 *   "I don't want to hold their data because it is not relevant to NB. The
 *    only thing that is relevant is that NB has a card and its variations and
 *    when a user adds one we can successfully sync it to the marketplaces."
 *
 * That is the right call, and nothing is lost by it:
 *
 *   SYNC does not need it. Listing a card on BSC or SportLots needs that card's
 *   per-platform REF — `cardChecklist.platformData.bsc.ref` / `.sportlots.ref`
 *   — which is already on the card row. A translation of what the variation is
 *   called plays no part.
 *
 *   MATCHING needed it, but only transiently. Reconciling a BSC fetch against
 *   an SL fetch has to decide that BSC's `11b` and SL's `#11 [ VAR Action
 *   Image ]` are the same NeonBinder card. The label is a useful hint there —
 *   but the durable output of that decision is the two refs, so the hint can be
 *   computed per set and thrown away. `suggestVariationPairings` in
 *   lib/cards/variations.ts does exactly that, and stores nothing.
 *
 * Storing it was also unsound. The alias table asserted a GLOBAL label mapping
 * inferred from 11 cards of one set. A label that means one thing in 2021
 * Heritage may mean another elsewhere, and a stored alias would have mismatched
 * silently rather than asking.
 */

const variationTypeDoc = v.object({
  _id: v.id("variationTypes"),
  _creationTime: v.number(),
  name: v.string(),
  nameNormalized: v.string(),
  createdByUserId: v.optional(v.string()),
  lastUpdated: v.number(),
});

/** The whole vocabulary — the picker's list, and the set builder's labels. */
export const listVariationTypes = query({
  args: {},
  returns: v.array(variationTypeDoc),
  handler: async (ctx) => {
    const all = await ctx.db.query("variationTypes").collect();
    return all.sort((a, b) => a.name.localeCompare(b.name));
  },
});

/**
 * Add a variation name to the vocabulary, or return the existing one.
 *
 * Get-or-create rather than insert, so two admins independently reaching for
 * "Nickname" converge on one row instead of creating a near-duplicate the
 * picker then shows twice.
 */
export const createVariationType = mutation({
  args: { name: v.string() },
  returns: v.object({
    variationTypeId: v.id("variationTypes"),
    name: v.string(),
    created: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const userId = await requireAdmin(ctx);
    const name = displayVariationLabel(args.name);
    if (!name) throw new Error("createVariationType: empty name");
    const nameNormalized = variationLabelKey(name);

    const existing = await ctx.db
      .query("variationTypes")
      .withIndex("by_name_normalized", (q) =>
        q.eq("nameNormalized", nameNormalized),
      )
      .unique();
    if (existing) {
      return {
        variationTypeId: existing._id,
        name: existing.name,
        created: false,
      };
    }

    const variationTypeId = await ctx.db.insert("variationTypes", {
      name,
      nameNormalized,
      createdByUserId: userId,
      lastUpdated: Date.now(),
    });
    return { variationTypeId, name, created: true };
  },
});

/**
 * Rename a variation type in place.
 *
 * Cards point at the row, not the string, so every card carrying this variation
 * follows the rename with no backfill — the reason this is a table at all.
 *
 * Renaming onto a name that already exists is refused rather than silently
 * merging two vocabularies: merging is a different, lossier operation and the
 * admin should ask for it explicitly.
 */
export const renameVariationType = mutation({
  args: { variationTypeId: v.id("variationTypes"), name: v.string() },
  returns: v.object({ name: v.string() }),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const row = await ctx.db.get(args.variationTypeId);
    if (!row) throw new Error("renameVariationType: no such variation type");

    const name = displayVariationLabel(args.name);
    if (!name) throw new Error("renameVariationType: empty name");
    const nameNormalized = variationLabelKey(name);

    const clash = await ctx.db
      .query("variationTypes")
      .withIndex("by_name_normalized", (q) =>
        q.eq("nameNormalized", nameNormalized),
      )
      .unique();
    if (clash && clash._id !== row._id) {
      throw new Error(
        `renameVariationType: "${name}" already exists. Merging two variation types is a separate operation.`,
      );
    }

    await ctx.db.patch(row._id, {
      name,
      nameNormalized,
      lastUpdated: Date.now(),
    });
    return { name };
  },
});
