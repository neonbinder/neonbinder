/**
 * NEO-401 — the one write-time hook of the stored smart-binder fits
 * (`collectionBinderFits`, see `binderRules.recomputeFits`).
 *
 * A parallel's cards are stored only while the binder holds a card of it
 * (`binderRules.binderNeeds`), so the first card of a parallel the binder did
 * not hold before is the one arrival that changes WHICH cards fit, not just
 * which are missing. `noteArrivals` spots it and schedules the recompute;
 * every other write to a smart binder changes nothing stored and costs one
 * cached container read per home.
 *
 * Kept out of `binderRules.ts` on purpose: `collection.ts` calls this from
 * `applyCopyChanges`, and `binderRules.ts` imports `collection.ts`, so the
 * rule module can never be imported back from there. Only the generated
 * `internal` reference is used to name the recompute.
 */

import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { variantTypeKind } from "./variantRole";

/** One copy write as `applyCopyChanges` sees it: the card and where it landed. */
export type Arrival = {
  cardId: string;
  homeId: Id<"collectionContainers"> | null;
  /** Where the row was before (null for an insert). Same home means no arrival. */
  fromId: Id<"collectionContainers"> | null;
};

export async function noteArrivals(ctx: MutationCtx, arrivals: ReadonlyArray<Arrival>): Promise<void> {
  // Every read here is cached for the call, so a hundred copies moving into
  // one smart binder cost a handful of reads, not a few hundred.
  const homes = new Map<string, boolean>(); // homeId -> has a rule
  const parallels = new Map<string, boolean>(); // variantId -> is a parallel
  const known = new Map<string, boolean>(); // homeId/variantId -> stored already
  const scheduled = new Set<string>();
  for (const a of arrivals) {
    if (!a.homeId || a.homeId === a.fromId || scheduled.has(a.homeId as string)) continue;
    const key = a.homeId as string;
    if (!homes.has(key)) {
      const home = await ctx.db.get(a.homeId);
      homes.set(key, Boolean(home?.rule));
    }
    if (!homes.get(key)) continue;
    const cardId = ctx.db.normalizeId("cardChecklist", a.cardId);
    if (!cardId) continue; // a private card (NEO-361) is in no catalog set
    const card = await ctx.db.get(cardId);
    if (!card) continue;
    const variantId = card.selectorOptionId;
    if (!parallels.has(variantId as string)) {
      const variant = await ctx.db.get(variantId);
      parallels.set(
        variantId as string,
        variant?.level === "parallel" ||
          (variant?.level === "insert" &&
            variant.parentId !== undefined &&
            variantTypeKind(await ctx.db.get(variant.parentId)) === "parallel"),
      );
    }
    if (!parallels.get(variantId as string)) continue;
    const pair = `${key}/${variantId as string}`;
    if (!known.has(pair)) {
      const stored = await ctx.db
        .query("collectionBinderFits")
        .withIndex("by_binder_variant", (q) => q.eq("binderId", a.homeId!).eq("variantId", variantId))
        .first();
      known.set(pair, stored !== null);
    }
    if (known.get(pair)) continue;
    scheduled.add(key);
    await ctx.scheduler.runAfter(0, internal.binderRules.recomputeFits, { binderId: a.homeId });
  }
}
