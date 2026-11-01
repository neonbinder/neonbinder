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
 * on or presses Resync. It is cheap when the owner lists nowhere: one indexed
 * read of their state rows, then return.
 *
 * Kept out of `collection.ts` and free of any import from it, so the hook can
 * be imported there without a module cycle (the `binderFits` rule).
 */
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";

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
