/**
 * NEO-370 — the copy-change hook's half of listing: record that a card's
 * for-sale count may have changed, and wake the owner's drainer.
 *
 * NB is the only truth. A box copy is for sale; every platform the collector
 * lists on shows NB's box count, and nothing about a listing is stored in NB.
 * `listingOutbox` is the change list (one row per owner + platform + card,
 * see its schema comment), and `marketplaceListingStates` is both the switch
 * ("this owner lists on this platform": the row exists) and the drain latch.
 *
 * Called from `collection.applyCopyChanges` (every copy write, a sale applied
 * by the order poll included) for the cards whose copy lived in a box before
 * or after the write, and from `listingSync` when a collector turns listing
 * on or presses Resync. Two copy writers skip `applyCopyChanges` and call in
 * here themselves: an operator's card move (`setShapeMove`, through
 * `enqueueMovedListingCards`) and the condition backfill
 * (`backfillCopyCondition`, through `queueOwnerCards`). It is cheap when the
 * owner lists nowhere: one indexed read of their state rows, then return.
 *
 * Kept out of `collection.ts` and free of any import from it, so the hook can
 * be imported there without a module cycle (the `binderFits` rule).
 */
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalMutation } from "./_generated/server";

export type ListingPlatform = Doc<"marketplaceListingStates">["platform"];
type StateRow = Doc<"marketplaceListingStates">;
type CardRow = Doc<"cardChecklist">;

/** How long after the first change the owner's drainer runs (debounce). */
export const DRAIN_DEBOUNCE_MS = 60_000;

/**
 * A `drainScheduledAt` older than this is a drain that never ran or died
 * before clearing the latch: the next change schedules a fresh one.
 */
export const DRAIN_SCHEDULE_STALE_MS = 10 * 60_000;

/** State rows one owner can have: one per platform, with room to spare. */
const MAX_STATES_PER_OWNER = 8;

/**
 * Whether the card carries the id a platform lists it by. Read from the
 * card's own slot (`platformData.<side>.ref`), never derived from a name or
 * number: a card with no id for a platform is never queued for it.
 */
export function carriesPlatformRef(card: Pick<CardRow, "platformData">, platform: ListingPlatform): boolean {
  switch (platform) {
    case "bsc":
      return typeof card.platformData?.bsc?.ref === "string" && card.platformData.bsc.ref.length > 0;
  }
}

/** The owner's state row for one platform, or null when they don't list there. */
export async function listingStateOf(
  ctx: Pick<QueryCtx, "db">,
  ownerId: string,
  platform: ListingPlatform,
): Promise<StateRow | null> {
  return await ctx.db
    .query("marketplaceListingStates")
    .withIndex("by_owner_platform", (q) => q.eq("ownerId", ownerId).eq("platform", platform))
    .first();
}

/**
 * Queue `cardIds` for every platform the owner lists on (only `platforms`,
 * when given): one `listingOutbox` row per (owner, platform, card), upserted
 * with `seq` bumped, for catalog cards that carry that platform's id. A
 * private card (`privateCards`) and a card that has left the catalog are
 * skipped. Then wakes each platform's drainer that got a row. Returns how
 * many rows were written.
 *
 * `ownerId` is the signed-in caller (or the owner of the rows being written),
 * never a value taken from a client's arguments.
 */
export async function enqueueListingCards(
  ctx: MutationCtx,
  args: {
    ownerId: string;
    cardIds: ReadonlyArray<string>;
    platforms?: ReadonlyArray<ListingPlatform>;
  },
): Promise<number> {
  if (args.cardIds.length === 0) return 0;
  const states = await ctx.db
    .query("marketplaceListingStates")
    .withIndex("by_owner_platform", (q) => q.eq("ownerId", args.ownerId))
    .take(MAX_STATES_PER_OWNER);
  const wanted = args.platforms ? states.filter((s) => args.platforms!.includes(s.platform)) : states;
  if (wanted.length === 0) return 0;

  const now = Date.now();
  const seen = new Set<string>();
  const touched = new Set<ListingPlatform>();
  let written = 0;
  for (const raw of args.cardIds) {
    if (seen.has(raw)) continue;
    seen.add(raw);
    // A private card's id is another table's: never listed, never queued.
    const cardId = ctx.db.normalizeId("cardChecklist", raw);
    if (!cardId) continue;
    const card = await ctx.db.get(cardId);
    if (!card) continue;
    for (const state of wanted) {
      if (!carriesPlatformRef(card, state.platform)) continue;
      await upsertOutboxRow(ctx, args.ownerId, state.platform, cardId, card.selectorOptionId, now);
      touched.add(state.platform);
      written += 1;
    }
  }
  for (const state of wanted) {
    if (touched.has(state.platform)) await kickWithState(ctx, state, now);
  }
  return written;
}

/**
 * Whether the owner lists on any platform: one indexed read. The copy writers
 * outside `applyCopyChanges` (an operator's card move, the condition
 * backfill) ask this first, so an owner who lists nowhere costs exactly that.
 */
export async function listsAnywhere(ctx: Pick<QueryCtx, "db">, ownerId: string): Promise<boolean> {
  const state = await ctx.db
    .query("marketplaceListingStates")
    .withIndex("by_owner_platform", (q) => q.eq("ownerId", ownerId))
    .first();
  return state !== null;
}

/** Cards of a variant looked through for one that can wake its sync. */
export const WAKE_SCAN_CARDS = 50;

/** One card an operator moved, and the variant it (and the owner's copy) left. */
export interface MovedListingCard {
  cardId: Id<"cardChecklist">;
  fromVariantId: Id<"selectorOptions">;
}

/**
 * Queue cards an operator moved to another variant (`setShapeMove`), for one
 * owner who holds them in a box. A move changes which marketplace set a card
 * lists under, so BOTH variants must re-sync:
 *
 *   - the NEW variant, so the card lists there: the card's own row, at its
 *     current variant (as `enqueueListingCards` writes it);
 *   - the OLD variant, so what it listed for the card goes to NB's zero. The
 *     card's own row can't carry that (one row per card, and the next box
 *     write points it at the card's current variant), so the old variant
 *     gets its own trigger: another card still in it that carries the
 *     platform's id (the `resyncVariant` wake), queued at the old variant.
 *     When the old variant has no such card left, the moved card's row is
 *     queued at the OLD variant instead; the drainer syncs that variant,
 *     then re-points the row to the card's current one (`settleRows`), which
 *     syncs next. When the old variant is gone, nothing is queued for it: a
 *     move never drops a marketplace link, so the variant that took its
 *     links (and its cards) re-syncs that sheet.
 *
 * `wakeCards` caches the wake card per (platform, variant) across owners, so
 * a move with many owners scans each old variant once. Cheap when the owner
 * lists nowhere: one indexed read. Returns how many rows were written.
 */
export async function enqueueMovedListingCards(
  ctx: MutationCtx,
  args: {
    ownerId: string;
    moved: ReadonlyArray<MovedListingCard>;
    wakeCards?: Map<string, Id<"cardChecklist"> | null>;
  },
): Promise<number> {
  if (args.moved.length === 0) return 0;
  const states = await ctx.db
    .query("marketplaceListingStates")
    .withIndex("by_owner_platform", (q) => q.eq("ownerId", args.ownerId))
    .take(MAX_STATES_PER_OWNER);
  if (states.length === 0) return 0;
  const wakeCards = args.wakeCards ?? new Map<string, Id<"cardChecklist"> | null>();
  const now = Date.now();
  const cards = new Map<string, CardRow | null>();
  const cardOf = async (cardId: Id<"cardChecklist">): Promise<CardRow | null> => {
    if (!cards.has(cardId)) cards.set(cardId, await ctx.db.get(cardId));
    return cards.get(cardId) ?? null;
  };
  let written = 0;
  for (const state of states) {
    const platform = state.platform;
    // Old variant → the first moved card (still carrying the id) that left it.
    const left = new Map<Id<"selectorOptions">, Id<"cardChecklist">>();
    const queued = new Set<string>();
    for (const { cardId, fromVariantId } of args.moved) {
      const card = await cardOf(cardId);
      if (!card || !carriesPlatformRef(card, platform)) continue;
      if (!queued.has(cardId)) {
        queued.add(cardId);
        await upsertOutboxRow(ctx, args.ownerId, platform, cardId, card.selectorOptionId, now);
        written += 1;
      }
      if (fromVariantId !== card.selectorOptionId && !left.has(fromVariantId)) left.set(fromVariantId, cardId);
    }
    for (const [fromVariantId, movedCardId] of left) {
      const key = `${platform}|${fromVariantId}`;
      if (!wakeCards.has(key)) {
        const inVariant = await ctx.db
          .query("cardChecklist")
          .withIndex("by_selector_option", (q) => q.eq("selectorOptionId", fromVariantId))
          .take(WAKE_SCAN_CARDS);
        wakeCards.set(key, inVariant.find((c) => carriesPlatformRef(c, platform))?._id ?? null);
      }
      const wake = wakeCards.get(key) ?? null;
      if (wake !== null) {
        await upsertOutboxRow(ctx, args.ownerId, platform, wake, fromVariantId, now);
        written += 1;
      } else if (await ctx.db.get(fromVariantId)) {
        // The same row as above, re-pointed: not a new one.
        await upsertOutboxRow(ctx, args.ownerId, platform, movedCardId, fromVariantId, now);
      }
    }
    if (queued.size > 0) await kickWithState(ctx, state, now);
  }
  return written;
}

/**
 * Queue `cardIds` for `ownerId` (`enqueueListingCards`), from a copy writer
 * that does its own page and hands the listing work on rather than spend its
 * transaction on it (`backfillCopyCondition`). The caller bounds `cardIds`.
 */
export const queueOwnerCards = internalMutation({
  args: { ownerId: v.string(), cardIds: v.array(v.string()) },
  returns: v.object({ queued: v.number() }),
  handler: async (ctx, args) => ({ queued: await enqueueListingCards(ctx, args) }),
});

async function upsertOutboxRow(
  ctx: MutationCtx,
  ownerId: string,
  platform: ListingPlatform,
  cardId: Id<"cardChecklist">,
  variantId: Id<"selectorOptions">,
  now: number,
): Promise<void> {
  const existing = await ctx.db
    .query("listingOutbox")
    .withIndex("by_owner_platform_card", (q) =>
      q.eq("ownerId", ownerId).eq("platform", platform).eq("cardId", cardId),
    )
    .unique();
  if (existing) {
    await ctx.db.patch(existing._id, { seq: existing.seq + 1, changedAt: now, variantId });
    return;
  }
  await ctx.db.insert("listingOutbox", { ownerId, platform, cardId, variantId, seq: 1, changedAt: now });
}

/**
 * Wake the owner's drainer for one platform, debounced: schedules
 * `listingDrain.drainOwner` a minute out and stamps `drainScheduledAt`, only
 * when no drain is already scheduled (or the stamp is stale). The drainer
 * clears the stamp before it reads any outbox row, so a change landing
 * mid-drain schedules the next one. Does nothing when the owner doesn't list
 * on the platform.
 */
export async function kickListingDrain(
  ctx: MutationCtx,
  ownerId: string,
  platform: ListingPlatform,
): Promise<void> {
  const state = await listingStateOf(ctx, ownerId, platform);
  if (state) await kickWithState(ctx, state, Date.now());
}

async function kickWithState(ctx: MutationCtx, state: StateRow, now: number): Promise<void> {
  if (state.drainScheduledAt !== undefined && now - state.drainScheduledAt < DRAIN_SCHEDULE_STALE_MS) return;
  await ctx.db.patch(state._id, { drainScheduledAt: now });
  await ctx.scheduler.runAfter(DRAIN_DEBOUNCE_MS, internal.listingDrain.drainOwner, {
    ownerId: state.ownerId,
    platform: state.platform,
  });
}
