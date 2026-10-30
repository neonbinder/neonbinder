/**
 * NEO-401 — the write-time hooks of the stored smart-binder fits
 * (`collectionBinderFits`, see `binderRules.recomputeFits`): the `held` mark
 * on each stored slot (`refreshHeld`), and the one arrival that changes which
 * cards fit (`noteArrivals`).
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

import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { variantTypeKind } from "./variantRole";

/** Lines one card may have for one collector (`collection.MAX_LINES_PER_CARD`; not imported: `collection.ts` imports this file). */
const MAX_LINES_PER_CARD = 200;

/**
 * Does the owner hold `cardId` in a binder other than `except`? One index
 * read on the card's lines plus one cached `get` per home. This is the
 * `held` mark on an empty slot; `writeFitsPage` stores it on the fits row
 * and `refreshHeld` keeps it current, so the slots read never asks per card.
 */
export function heldReader(ctx: Pick<QueryCtx, "db">, ownerId: string) {
  const kinds = new Map<string, Doc<"collectionContainers"> | null>();
  return async (cardId: Id<"cardChecklist">, except: Id<"collectionContainers">): Promise<boolean> => {
    const lines = await ctx.db
      .query("collectionCopies")
      .withIndex("by_owner_and_card", (q) => q.eq("ownerId", ownerId).eq("cardId", cardId))
      .take(MAX_LINES_PER_CARD);
    for (const line of lines) {
      if (line.homeId === except || line.quantity < 1) continue;
      const key = line.homeId as string;
      if (!kinds.has(key)) kinds.set(key, await ctx.db.get(line.homeId));
      if (kinds.get(key)?.kind === "binder") return true;
    }
    return false;
  };
}

/**
 * A copy of `cardIds` was written: re-mark `held` on every fits row the
 * owner stores for those cards (`by_owner_card`, a handful of rows per
 * card). Bounded by the write's own cards, so a save on the binder screen
 * costs a few indexed reads and at most one patch per smart binder.
 */
export async function refreshHeld(
  ctx: MutationCtx,
  ownerId: string,
  cardIds: Iterable<string>,
): Promise<void> {
  const held = heldReader(ctx, ownerId);
  for (const raw of new Set(cardIds)) {
    const cardId = ctx.db.normalizeId("cardChecklist", raw);
    if (!cardId) continue; // a private card (NEO-361) is in no smart binder's fits
    const rows = await ctx.db
      .query("collectionBinderFits")
      .withIndex("by_owner_card", (q) => q.eq("ownerId", ownerId).eq("cardId", cardId))
      .collect();
    for (const row of rows) {
      const now = await held(cardId, row.binderId);
      if (row.held !== now) await ctx.db.patch(row._id, { held: now });
    }
  }
}

/** One copy write as `applyCopyChanges` sees it: the card and where it landed. */
export type Arrival = {
  cardId: string;
  homeId: Id<"collectionContainers"> | null;
  /** Where the row was before (null for an insert). Same home means no arrival. */
  fromId: Id<"collectionContainers"> | null;
};

export async function noteArrivals(
  ctx: MutationCtx,
  ownerId: string,
  arrivals: ReadonlyArray<Arrival>,
): Promise<void> {
  // The `held` mark of every stored slot for these cards, first: a copy that
  // moved, arrived, left or hit zero changes it whatever its home is.
  await refreshHeld(ctx, ownerId, arrivals.map((a) => a.cardId));
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
