/**
 * NEO-370 — the copy-change hook's half of listing: record that a card's
 * for-sale count may have changed, and (on the triggers that ask for it) wake
 * the owner's drainer.
 *
 * NB is the only truth. A copy in a LISTED box (`listsOnMarketplaces`: a box
 * whose "Listed on marketplaces" setting is not off) is for sale on every
 * platform the collector has a saved sign-in for, and each shows NB's count;
 * nothing about a listing is stored in NB. `listingOutbox` is the change list
 * (one row per owner + platform + card, see its schema comment), and
 * `marketplaceListingStates` is the standing (`listingStartedAt`, stamped
 * when the sign-in is saved), NB's `dormant` and the drain latch.
 *
 * Called from `collection.applyCopyChanges` (every copy write, a sale applied
 * by the order poll included) for the cards whose copy lived in a box before
 * or after the write, and from `listingSync` when a collector starts listing,
 * presses Sync, or flips a box's listed setting. Two copy writers skip
 * `applyCopyChanges` and call in here themselves: an operator's card move
 * (`setShapeMove`, through `enqueueMovedListingCards`) and the condition
 * backfill (`backfillCopyCondition`, through `queueOwnerCards`). It is cheap
 * when the owner lists nowhere: one indexed read of their state rows, then
 * return.
 *
 * A box write only ENQUEUES. Nothing here runs on a timer: the drain runs
 * when something asks for it (`kickListingDrain`): a Sync press
 * (`listingSync.syncVariant`), an intake run the collector closed with "Done
 * adding photos" once it settles (`intakeRuns`), the end of the walk a
 * saved sign-in starts,
 * and the 15-minute cron (`listingSales.finishPoll`).
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
type ContainerRow = Doc<"collectionContainers">;

/**
 * A `drainScheduledAt` older than this is a drain that never ran or died
 * before clearing the latch: the next kick schedules a fresh one.
 */
export const DRAIN_SCHEDULE_STALE_MS = 10 * 60_000;

/** State rows one owner can have: one per platform, with room to spare. */
const MAX_STATES_PER_OWNER = 8;

/**
 * State rows read for one seller account (`sellerAccountHolder`). Only a
 * listing row is stamped with an account and only one can list from it, so
 * rows past the first few are stopped ones; the cap bounds the read.
 */
const MAX_ACCOUNT_ROWS = 50;

/** Cards of a variant looked through for one that can wake its sync. */
export const WAKE_SCAN_CARDS = 50;

/** Outbox rows one page of the stop-listing sweep deletes. */
export const CLEAR_PAGE_ROWS = 500;

/** Every listing platform NB has, in the order the Sync status tab shows them. */
export const LISTING_PLATFORMS: ReadonlyArray<ListingPlatform> = ["bsc"];

/** The credential site key each listing platform signs in through. */
export const LISTING_CREDENTIAL_SITE: Record<ListingPlatform, string> = { bsc: "buysportscards" };

/** The listing platform a credential site serves, or null for none. */
export function listingPlatformForSite(site: string): ListingPlatform | null {
  for (const [platform, credentialSite] of Object.entries(LISTING_CREDENTIAL_SITE)) {
    if (credentialSite === site) return platform as ListingPlatform;
  }
  return null;
}

/**
 * NB pushes counts to the platform for this owner. Revision 5 (Jason,
 * 2026-11-01: "If you have credentials you are syncing"): saving a sign-in
 * for the platform's site starts listing (`listingSync.setUpListing` stamps
 * `listingStartedAt`, the "since"), and removing it stops listing (clears
 * the stamp, `dormant: "noCredentials"`). So this reads: started by a saved
 * sign-in, not made dormant by NB, and not held off by the E2E test marker
 * (`testListingOff`, written only by the testing seed). Whether NB has
 * paused the platform for everyone is read where it matters
 * (`marketplacePause.isPlatformPaused`), not stored here. The retired
 * `enabled` is never read.
 */
export function pushesCounts(
  state: Pick<StateRow, "listingStartedAt" | "dormant" | "testListingOff">,
): boolean {
  return state.listingStartedAt !== undefined && state.dormant === undefined && state.testListingOff !== true;
}

/**
 * NB polls the platform's orders for this owner on the same rule as pushing
 * (`pushesCounts`): a saved sign-in is listing AND selling, so reading the
 * seller's orders goes with it. The pause is checked by the poll itself.
 */
export function pollsSales(
  state: Pick<StateRow, "listingStartedAt" | "dormant" | "testListingOff">,
): boolean {
  return pushesCounts(state);
}

/**
 * A home whose copies list on marketplaces: a box whose "Listed on
 * marketplaces" setting is not off (absent means on). A binder never is; an
 * in-person box (`listedOnMarketplaces: false`) holds copies that are for
 * sale in NB but count 0 on every platform.
 */
export function listsOnMarketplaces(row: Pick<ContainerRow, "kind" | "listedOnMarketplaces">): boolean {
  return row.kind === "box" && row.listedOnMarketplaces !== false;
}

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

/** The owner's state row for one platform, or null when they never listed there. */
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

async function statesOf(ctx: Pick<QueryCtx, "db">, ownerId: string): Promise<StateRow[]> {
  return await ctx.db
    .query("marketplaceListingStates")
    .withIndex("by_owner_platform", (q) => q.eq("ownerId", ownerId))
    .take(MAX_STATES_PER_OWNER);
}

/**
 * Queue `cardIds` for every platform the owner pushes counts to (only
 * `platforms`, when given): one `listingOutbox` row per (owner, platform,
 * card), upserted with `seq` bumped, for catalog cards that carry that
 * platform's id. A private card (`privateCards`) and a card that has left the
 * catalog are skipped. Enqueues only: no drain is scheduled. Returns how many
 * rows were written.
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
  const wanted = (await statesOf(ctx, args.ownerId)).filter(
    (s) => pushesCounts(s) && (!args.platforms || args.platforms.includes(s.platform)),
  );
  if (wanted.length === 0) return 0;

  const now = Date.now();
  const seen = new Set<string>();
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
      written += 1;
    }
  }
  return written;
}

/**
 * Whether the owner pushes counts to any platform: one indexed read. The copy
 * writers outside `applyCopyChanges` (an operator's card move, the condition
 * backfill) ask this first, so an owner who lists nowhere costs exactly that.
 */
export async function listsAnywhere(ctx: Pick<QueryCtx, "db">, ownerId: string): Promise<boolean> {
  return (await statesOf(ctx, ownerId)).some(pushesCounts);
}

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
 *     platform's id (`wakeCardOf`), queued at the old variant.
 *     When the old variant has no such card left, the moved card's row is
 *     queued at the OLD variant instead; the drainer syncs that variant,
 *     then re-points the row to the card's current one (`settleRows`), which
 *     syncs next. When the old variant is gone, nothing is queued for it: a
 *     move never drops a marketplace link, so the variant that took its
 *     links (and its cards) re-syncs that sheet.
 *
 * `wakeCards` caches the wake card per (platform, variant) across owners, so
 * a move with many owners scans each old variant once. Cheap when the owner
 * lists nowhere: one indexed read. Enqueues only. Returns how many rows were
 * written.
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
  const states = (await statesOf(ctx, args.ownerId)).filter(pushesCounts);
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
      if (!wakeCards.has(key)) wakeCards.set(key, await wakeCardOf(ctx, platform, fromVariantId));
      const wake = wakeCards.get(key) ?? null;
      if (wake !== null) {
        await upsertOutboxRow(ctx, args.ownerId, platform, wake, fromVariantId, now);
        written += 1;
      } else if (await ctx.db.get(fromVariantId)) {
        // The same row as above, re-pointed: not a new one.
        await upsertOutboxRow(ctx, args.ownerId, platform, movedCardId, fromVariantId, now);
      }
    }
  }
  return written;
}

/**
 * The variant's first card (of `WAKE_SCAN_CARDS`) that carries the
 * platform's id: queueing it makes the variant's run happen even when the
 * owner holds nothing of it in a box (so the run sets the platform to NB's
 * zero). Null when none of those cards carries the id.
 */
export async function wakeCardOf(
  ctx: Pick<QueryCtx, "db">,
  platform: ListingPlatform,
  variantId: Id<"selectorOptions">,
): Promise<Id<"cardChecklist"> | null> {
  const cards = await ctx.db
    .query("cardChecklist")
    .withIndex("by_selector_option", (q) => q.eq("selectorOptionId", variantId))
    .take(WAKE_SCAN_CARDS);
  return cards.find((c) => carriesPlatformRef(c, platform))?._id ?? null;
}

/** Queue the variant's wake card for one owner (`wakeCardOf`). Returns rows written. */
export async function wakeVariant(
  ctx: MutationCtx,
  ownerId: string,
  platform: ListingPlatform,
  variantId: Id<"selectorOptions">,
): Promise<number> {
  const card = await wakeCardOf(ctx, platform, variantId);
  if (!card) return 0;
  return await enqueueListingCards(ctx, { ownerId, cardIds: [card], platforms: [platform] });
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

/** What a kick did, for tests and logs. */
export type DrainKick =
  /** No state row, listing off, or the row is dormant: nothing to drain. */
  | "notListing"
  /** Nothing queued for the platform. */
  | "nothingPending"
  /** A drain is scheduled and has not started yet: it will see the rows. */
  | "alreadyScheduled"
  /** A drain is running: its release runs the next one at once. */
  | "requested"
  /** A drain was scheduled to run now. */
  | "scheduled";

/**
 * Run the owner's drainer for one platform now, if there is anything to push.
 * Cheap and idempotent: one state read and one outbox read; when a drain is
 * already scheduled nothing more is written, and when one is running it is
 * asked (`drainRequested`) to run again once it releases, so a change landing
 * mid-drain is not left for the cron. The drainer itself gates on the
 * owner's credentials.
 */
export async function kickListingDrain(
  ctx: MutationCtx,
  ownerId: string,
  platform: ListingPlatform,
): Promise<DrainKick> {
  const state = await listingStateOf(ctx, ownerId, platform);
  if (!state) return "notListing";
  return await kickWithState(ctx, state, Date.now());
}

/** `kickListingDrain` for every platform the owner pushes counts to. */
export async function kickOwnerDrains(ctx: MutationCtx, ownerId: string): Promise<DrainKick[]> {
  const out: DrainKick[] = [];
  for (const state of await statesOf(ctx, ownerId)) out.push(await kickWithState(ctx, state, Date.now()));
  return out;
}

async function kickWithState(ctx: MutationCtx, state: StateRow, now: number): Promise<DrainKick> {
  if (!pushesCounts(state)) return "notListing";
  const pending = await ctx.db
    .query("listingOutbox")
    .withIndex("by_owner_platform_variant", (q) => q.eq("ownerId", state.ownerId).eq("platform", state.platform))
    .first();
  if (!pending) return "nothingPending";
  if (state.drainLeaseToken !== undefined && (state.drainLeaseExpiresAt ?? 0) > now) {
    if (state.drainRequested !== true) await ctx.db.patch(state._id, { drainRequested: true });
    return "requested";
  }
  if (state.drainScheduledAt !== undefined && now - state.drainScheduledAt < DRAIN_SCHEDULE_STALE_MS) {
    return "alreadyScheduled";
  }
  await ctx.db.patch(state._id, { drainScheduledAt: now });
  await ctx.scheduler.runAfter(0, internal.listingDrain.drainOwner, {
    ownerId: state.ownerId,
    platform: state.platform,
  });
  return "scheduled";
}

/**
 * The owner's saved sign-in for `site` was removed: listing on the platform
 * that signs in through that site STOPS, and so does its order poll. The row
 * goes dormant (`noCredentials`; a seller conflict stays as it is),
 * `listingStartedAt` is cleared, a drain asked to run again is not, and the
 * owner's queued changes for that platform are dropped (paged; a drain
 * already running stands down at its next write, `listingDrain`). What the
 * platform lists is left as it is. Saving a sign-in again starts listing
 * again (`listingSync.setUpListing`).
 *
 * Does nothing for a site no listing platform uses, or an owner with no
 * state row there.
 */
export async function stopListingForSite(ctx: MutationCtx, ownerId: string, site: string): Promise<void> {
  const platform = listingPlatformForSite(site);
  if (!platform) return;
  const state = await listingStateOf(ctx, ownerId, platform);
  if (!state) return;
  if (state.dormant === undefined || state.listingStartedAt !== undefined || state.drainRequested !== undefined) {
    await ctx.db.patch(state._id, {
      ...(state.dormant === undefined ? { dormant: "noCredentials" as const } : {}),
      listingStartedAt: undefined,
      drainRequested: undefined,
      lastUpdated: Date.now(),
    });
  }
  await clearListingOutbox(ctx, ownerId, platform);
}

/**
 * Delete one page of the owner's queued changes for `platform`, and schedule
 * the next (`listingSync.clearOutboxPage`) while a full page came back. The
 * scheduled pages stop once the owner lists there again (the walk a fresh
 * save starts owns the queue from then on).
 */
export async function clearListingOutbox(
  ctx: MutationCtx,
  ownerId: string,
  platform: ListingPlatform,
): Promise<void> {
  const rows = await ctx.db
    .query("listingOutbox")
    .withIndex("by_owner_platform_variant", (q) => q.eq("ownerId", ownerId).eq("platform", platform))
    .take(CLEAR_PAGE_ROWS);
  for (const row of rows) await ctx.db.delete(row._id);
  if (rows.length === CLEAR_PAGE_ROWS) {
    await ctx.scheduler.runAfter(0, internal.listingSync.clearOutboxPage, { ownerId, platform });
  }
}

/** The owner's saved credential entry for a listing platform's site. */
export async function listingCredentialOf(
  ctx: Pick<QueryCtx, "db">,
  ownerId: string,
  platform: ListingPlatform,
): Promise<{ hasCredentials: boolean; needsReauth: boolean; sellerId: string | null }> {
  const profile = await ctx.db
    .query("userProfiles")
    .withIndex("by_user", (q) => q.eq("userId", ownerId))
    .first();
  const entry = profile?.siteCredentials?.find((c) => c.site === LISTING_CREDENTIAL_SITE[platform]);
  return {
    hasCredentials: entry?.hasCredentials === true,
    needsReauth: entry?.needsReauth === true,
    sellerId: platform === "bsc" ? (profile?.marketplaceAccountIds?.bscSellerId ?? null) : null,
  };
}

/**
 * Another NB owner's state row on `platform` that holds the seller account
 * `accountId` NOW, or null: a row that lists (`pushesCounts`). One NB owner
 * per seller account: two owners pushing counts to one seller would
 * overwrite each other, and a sale there would lower both owners' copies.
 * A row that stopped (sign-in removed), went dormant (a conflict of its own)
 * or carries the test marker holds nothing, so a holder that stops frees the
 * account and two owners can never lock each other out.
 */
export async function sellerAccountHolder(
  ctx: Pick<QueryCtx, "db">,
  platform: ListingPlatform,
  accountId: string,
  ownerId: string,
): Promise<StateRow | null> {
  const holders = await ctx.db
    .query("marketplaceListingStates")
    .withIndex("by_platform_account", (q) => q.eq("platform", platform).eq("platformAccountId", accountId))
    .take(MAX_ACCOUNT_ROWS);
  return holders.find((s) => s.ownerId !== ownerId && pushesCounts(s)) ?? null;
}
