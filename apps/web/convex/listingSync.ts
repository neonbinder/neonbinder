/**
 * NEO-370 — the collector's side of marketplace listing: the per-user switch,
 * a variant's listing status, Resync, the flush on leaving a checklist, and
 * the Sales screen.
 *
 * Listing is opt-in, per collector and per platform, off by default. The
 * owner's `marketplaceListingStates` row is made by the first switch-on and
 * then kept: `enabled: false` is "off". Off stops pushing NB's counts only:
 * the copy-change hook queues nothing and the drainer stands down, but what
 * the platform lists stays up and can still sell, so the order poll keeps
 * running (while credentials are saved) and keeps lowering NB copies.
 * Turning it on queues every card the collector holds in a box (paged
 * through scheduled internal mutations, so a 100k-copy inventory never meets
 * a transaction limit) and the walk's last page runs the drain; turning it
 * off drops the owner's queued changes for that platform.
 *
 * Every public function here is the signed-in caller's own: the owner is
 * always `requireSignedIn`, never an argument. A sync record's `leaseToken`,
 * a marketplace's card ids, an order's id and a line's SKU are server-only
 * and never returned.
 */
import { v } from "convex/values";
import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalMutation, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireSignedIn } from "./auth";
import { COLLECTION_ERRORS, HomeSides, MAX_CONTAINERS, MAX_SYSTEM_CONTAINERS, refuse } from "./collection";
import { findSetForSelectorOption } from "./lib/selectorAncestry";
import { isPlatformPaused } from "./marketplacePause";
import {
  enqueueListingCards,
  kickListingDrain,
  kickOwnerDrains,
  LISTING_CREDENTIAL_SITE,
  listingCredentialOf,
  listingStateOf,
  pushesCounts,
  sellerAccountHolder,
  wakeVariant,
  type ListingPlatform,
} from "./listingOutbox";
import {
  listingPlatformValidator,
  listingProblemReasonValidator,
  saleItemProblemValidator,
} from "./schema";

/** Copy lines one page of a queueing walk reads (enable, Resync). */
export const QUEUE_PAGE_LINES = 200;
/** Outbox rows one page of the turn-off sweep deletes. */
export const CLEAR_PAGE_ROWS = 500;
/** Orders one Sales page returns at most. */
export const MAX_SALES_PAGE = 50;
/** A Resync pressed within this long of the last one (or during a run) is ignored. */
export const RESYNC_THROTTLE_MS = 60_000;

const SELLER_CONFLICT_MESSAGE =
  "That BuySportsCards seller account is already listing from another NeonBinder account, so it can't list from this one too.";

// ───────────────────────────────────────────────────────────────────────────
// Settings
// ───────────────────────────────────────────────────────────────────────────

const platformSettingsValidator = v.object({
  /** The collector has listing switched on (counts are pushed). */
  enabled: v.boolean(),
  /** Their credentials for it are saved (Profile → Credentials). */
  connected: v.boolean(),
  /** The saved session died and they must sign in again on Profile. */
  needsReauth: v.boolean(),
  /** NB has paused this platform for everyone (`NEONBINDER_PAUSED_PLATFORMS`). */
  paused: v.boolean(),
  /** Their seller account already lists from another NeonBinder account: nothing is pushed or polled. */
  sellerConflict: v.boolean(),
});

async function platformSettings(ctx: QueryCtx, ownerId: string, platform: ListingPlatform) {
  const state = await listingStateOf(ctx, ownerId, platform);
  const credential = await listingCredentialOf(ctx, ownerId, platform);
  return {
    enabled: state !== null && state.enabled !== false,
    connected: credential.hasCredentials,
    needsReauth: credential.needsReauth,
    paused: isPlatformPaused(LISTING_CREDENTIAL_SITE[platform]),
    sellerConflict: state?.dormant === "sellerConflict",
  };
}

/** Where the collector stands with each listing platform. Small and subscribable. */
export const listingSettings = query({
  args: {},
  returns: v.object({ bsc: platformSettingsValidator }),
  handler: async (ctx) => {
    const ownerId = await requireSignedIn(ctx);
    return { bsc: await platformSettings(ctx, ownerId, "bsc") };
  },
});

/**
 * Turn listing on one platform on or off for the caller.
 *
 * On: needs saved credentials, and refuses a seller account another NB
 * owner already lists from (one NB owner per seller account; the account is
 * the one the owner's last sign-in captured, when known, and the drainer
 * checks it again before its first push). Makes the state row (or switches
 * the kept one back on, clearing a dormancy that no longer applies) and
 * queues every card the collector holds in a box (paged, scheduled); the
 * walk's last page runs the drain.
 *
 * Off: keeps the state row with `enabled: false` (sales are still polled and
 * applied) and drops the caller's queued changes for that platform (paged);
 * what the platform lists is left as it is.
 *
 * Asking for the state it is already in writes nothing.
 */
export const setListingEnabled = mutation({
  args: { platform: listingPlatformValidator, enabled: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const ownerId = await requireSignedIn(ctx);
    const state = await listingStateOf(ctx, ownerId, args.platform);
    const now = Date.now();
    if (args.enabled) {
      if (state && pushesCounts(state)) return null;
      const credential = await listingCredentialOf(ctx, ownerId, args.platform);
      if (!credential.hasCredentials) {
        refuse(
          COLLECTION_ERRORS.invalid,
          "Connect your BuySportsCards account on your Profile first, then switch listing on.",
        );
      }
      const accountId = credential.sellerId ?? state?.platformAccountId ?? null;
      if (accountId !== null && (await sellerAccountHolder(ctx, args.platform, accountId, ownerId))) {
        refuse(COLLECTION_ERRORS.invalid, SELLER_CONFLICT_MESSAGE);
      }
      const on = {
        enabled: true,
        dormant: undefined,
        ...(accountId !== null ? { platformAccountId: accountId } : {}),
        lastUpdated: now,
      };
      if (state) await ctx.db.patch(state._id, on);
      else await ctx.db.insert("marketplaceListingStates", { ownerId, platform: args.platform, ...on });
      const boxIds = await boxIdsOf(ctx, ownerId);
      if (boxIds.length > 0) {
        await ctx.scheduler.runAfter(0, internal.listingSync.queueBoxesPage, {
          ownerId,
          platform: args.platform,
          boxIds,
          index: 0,
          cursor: null,
        });
      }
      return null;
    }
    if (!state || state.enabled === false) return null;
    await ctx.db.patch(state._id, { enabled: false, drainRequested: undefined, lastUpdated: now });
    await clearOutbox(ctx, ownerId, args.platform);
    return null;
  },
});

/**
 * Run the caller's listing drain now, for every platform they push counts to
 * that has changes queued. The web app calls it when the collector leaves a
 * checklist page (navigate away, or the page is hidden), so the changes they
 * just made reach the platform without waiting for the 15-minute cron.
 * Cheap and idempotent: nothing queued, listing off, or a drain already
 * scheduled writes nothing; a drain already running is asked to run once
 * more when it finishes.
 */
export const flushListing = mutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const ownerId = await requireSignedIn(ctx);
    await kickOwnerDrains(ctx, ownerId);
    return null;
  },
});

/** The owner's boxes (Unsorted included), oldest first. One bounded read. */
async function boxIdsOf(ctx: QueryCtx, ownerId: string): Promise<Array<Id<"collectionContainers">>> {
  const rows = await ctx.db
    .query("collectionContainers")
    .withIndex("by_owner_and_system", (q) => q.eq("ownerId", ownerId))
    .take(MAX_CONTAINERS + MAX_SYSTEM_CONTAINERS);
  return rows.filter((row) => row.kind === "box").map((row) => row._id);
}

/**
 * The enable walk: one page of one box's copies, queued for `platform`, then
 * the next page (or the next box) on the scheduler; the last page runs the
 * drain (the owner's first sync). Stops as soon as the owner has turned
 * listing off again.
 */
export const queueBoxesPage = internalMutation({
  args: {
    ownerId: v.string(),
    platform: listingPlatformValidator,
    boxIds: v.array(v.id("collectionContainers")),
    index: v.number(),
    cursor: v.union(v.string(), v.null()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const state = await listingStateOf(ctx, args.ownerId, args.platform);
    if (!state || !pushesCounts(state)) return null;
    const homeId = args.boxIds[args.index];
    if (homeId === undefined) return null;
    const page = await ctx.db
      .query("collectionCopies")
      .withIndex("by_owner_home_slot", (q) => q.eq("ownerId", args.ownerId).eq("homeId", homeId))
      .paginate({ numItems: QUEUE_PAGE_LINES, cursor: args.cursor });
    await enqueueListingCards(ctx, {
      ownerId: args.ownerId,
      cardIds: page.page.map((row) => row.cardId),
      platforms: [args.platform],
    });
    const next = page.isDone
      ? args.index + 1 < args.boxIds.length
        ? { index: args.index + 1, cursor: null }
        : null
      : { index: args.index, cursor: page.continueCursor };
    if (next) {
      await ctx.scheduler.runAfter(0, internal.listingSync.queueBoxesPage, { ...args, ...next });
    } else {
      await kickListingDrain(ctx, args.ownerId, args.platform);
    }
    return null;
  },
});

/**
 * Delete one page of the owner's queued changes for `platform`, and schedule
 * the next while a full page came back. Stops when listing is on again (a
 * fresh enable walk owns the queue from then on).
 */
async function clearOutbox(ctx: MutationCtx, ownerId: string, platform: ListingPlatform): Promise<void> {
  const rows = await ctx.db
    .query("listingOutbox")
    .withIndex("by_owner_platform_variant", (q) => q.eq("ownerId", ownerId).eq("platform", platform))
    .take(CLEAR_PAGE_ROWS);
  for (const row of rows) await ctx.db.delete(row._id);
  if (rows.length === CLEAR_PAGE_ROWS) {
    await ctx.scheduler.runAfter(0, internal.listingSync.clearOutboxPage, { ownerId, platform });
  }
}

export const clearOutboxPage = internalMutation({
  args: { ownerId: v.string(), platform: listingPlatformValidator },
  returns: v.null(),
  handler: async (ctx, args) => {
    const state = await listingStateOf(ctx, args.ownerId, args.platform);
    if (state && pushesCounts(state)) return null;
    await clearOutbox(ctx, args.ownerId, args.platform);
    return null;
  },
});

// ───────────────────────────────────────────────────────────────────────────
// A variant's status, and Resync
// ───────────────────────────────────────────────────────────────────────────

const syncRecordValidator = v.object({
  status: v.union(v.literal("idle"), v.literal("running"), v.literal("error")),
  leaseExpiresAt: v.optional(v.number()),
  lastRunAt: v.optional(v.number()),
  lastSuccessAt: v.optional(v.number()),
  lastError: v.optional(v.string()),
  counts: v.optional(
    v.object({
      listed: v.number(),
      pushed: v.number(),
      zeroed: v.number(),
      skipped: v.number(),
    }),
  ),
  /** No marketplace id: a problem with no `cardId` is a platform row NB can't tie to a card. */
  problems: v.array(
    v.object({
      cardId: v.optional(v.id("cardChecklist")),
      reason: listingProblemReasonValidator,
      detail: v.optional(v.string()),
    }),
  ),
  problemsTotal: v.optional(v.number()),
});

type SyncRecord = Doc<"marketplaceListingSyncs">;

/**
 * A sync record as a client may see it: no lease token, no marketplace card
 * id, no internal bookkeeping.
 */
function publicRecord(row: SyncRecord): typeof syncRecordValidator.type {
  return {
    status: row.status,
    ...(row.leaseExpiresAt !== undefined ? { leaseExpiresAt: row.leaseExpiresAt } : {}),
    ...(row.lastRunAt !== undefined ? { lastRunAt: row.lastRunAt } : {}),
    ...(row.lastSuccessAt !== undefined ? { lastSuccessAt: row.lastSuccessAt } : {}),
    ...(row.lastError !== undefined ? { lastError: row.lastError } : {}),
    ...(row.counts !== undefined ? { counts: row.counts } : {}),
    problems: row.problems.map((p) => ({
      ...(p.cardId !== undefined ? { cardId: p.cardId } : {}),
      reason: p.reason,
      ...(p.detail !== undefined ? { detail: p.detail } : {}),
    })),
    ...(row.problemsTotal !== undefined ? { problemsTotal: row.problemsTotal } : {}),
  };
}

async function recordOf(
  ctx: QueryCtx,
  ownerId: string,
  variantId: Id<"selectorOptions">,
  platform: ListingPlatform,
): Promise<SyncRecord | null> {
  return await ctx.db
    .query("marketplaceListingSyncs")
    .withIndex("by_owner_variant_platform", (q) =>
      q.eq("ownerId", ownerId).eq("variantId", variantId).eq("platform", platform),
    )
    .first();
}

/**
 * How the caller's last push of one variant to a platform went (null before
 * its first run), and whether a change in it is still queued (`pending`).
 * Two point reads: the Inventory checklist panel subscribes to it.
 */
export const variantStatus = query({
  args: { variantId: v.id("selectorOptions"), platform: v.optional(listingPlatformValidator) },
  returns: v.object({ record: v.union(syncRecordValidator, v.null()), pending: v.boolean() }),
  handler: async (ctx, args) => {
    const ownerId = await requireSignedIn(ctx);
    const platform = args.platform ?? "bsc";
    const record = await recordOf(ctx, ownerId, args.variantId, platform);
    const queued = await ctx.db
      .query("listingOutbox")
      .withIndex("by_owner_platform_variant", (q) =>
        q.eq("ownerId", ownerId).eq("platform", platform).eq("variantId", args.variantId),
      )
      .first();
    return { record: record ? publicRecord(record) : null, pending: queued !== null };
  },
});

/**
 * Resync one variant on a platform: forget its last clean run (so the next
 * run reads every condition the platform has), queue the variant's box cards
 * and run the drain now. A variant with nothing in a box still gets one card
 * queued, so the run happens and sets the platform to NB's zero.
 *
 * Answers `queued: 0` and writes nothing while listing is off. A press while
 * the variant's run is under way, or within `RESYNC_THROTTLE_MS` of the last
 * press, is ignored (`ignored: true`): the run already under way, or about
 * to start, reads the variant in full.
 */
export const resyncVariant = mutation({
  args: { variantId: v.id("selectorOptions"), platform: v.optional(listingPlatformValidator) },
  returns: v.object({ queued: v.number(), ignored: v.optional(v.boolean()) }),
  handler: async (ctx, args) => {
    const ownerId = await requireSignedIn(ctx);
    const platform = args.platform ?? "bsc";
    const state = await listingStateOf(ctx, ownerId, platform);
    if (!state || !pushesCounts(state)) return { queued: 0 };
    const now = Date.now();
    const record = await recordOf(ctx, ownerId, args.variantId, platform);
    if (record) {
      const running = record.status === "running" && (record.leaseExpiresAt ?? 0) > now;
      const recent = record.resyncRequestedAt !== undefined && now - record.resyncRequestedAt < RESYNC_THROTTLE_MS;
      if (running || recent) return { queued: 0, ignored: true };
      await ctx.db.patch(record._id, { lastSuccessAt: undefined, resyncRequestedAt: now, lastUpdated: now });
    } else {
      // Never run yet: no record to stamp. A change queued for the variant
      // in the last minute (a press, or a box write) is the throttle.
      const queuedRow = await ctx.db
        .query("listingOutbox")
        .withIndex("by_owner_platform_variant", (q) =>
          q.eq("ownerId", ownerId).eq("platform", platform).eq("variantId", args.variantId),
        )
        .first();
      if (queuedRow && now - queuedRow.changedAt < RESYNC_THROTTLE_MS) {
        await kickListingDrain(ctx, ownerId, platform);
        return { queued: 0, ignored: true };
      }
    }
    const setId = await findSetForSelectorOption(ctx, args.variantId);
    let queued = 0;
    if (setId) {
      queued = await queueVariantLines(ctx, { ownerId, platform, setId, variantId: args.variantId, cursor: null });
    }
    if (queued === 0) queued = await wakeVariant(ctx, ownerId, platform, args.variantId);
    await kickListingDrain(ctx, ownerId, platform);
    return { queued };
  },
});

/**
 * One page of a variant's copies: the box ones queued, the next page on the
 * scheduler. Returns how many outbox rows the page wrote.
 */
async function queueVariantLines(
  ctx: MutationCtx,
  args: {
    ownerId: string;
    platform: ListingPlatform;
    setId: Id<"selectorOptions">;
    variantId: Id<"selectorOptions">;
    cursor: string | null;
  },
): Promise<number> {
  const page = await ctx.db
    .query("collectionCopies")
    .withIndex("by_owner_set_variant", (q) =>
      q.eq("ownerId", args.ownerId).eq("setId", args.setId).eq("variantId", args.variantId),
    )
    .paginate({ numItems: QUEUE_PAGE_LINES, cursor: args.cursor });
  const boxed = await new HomeSides(ctx, args.ownerId).keep(page.page, "inventory");
  const queued = await enqueueListingCards(ctx, {
    ownerId: args.ownerId,
    cardIds: boxed.map((row) => row.cardId),
    platforms: [args.platform],
  });
  if (!page.isDone) {
    await ctx.scheduler.runAfter(0, internal.listingSync.queueVariantPage, {
      ...args,
      cursor: page.continueCursor,
    });
  }
  return queued;
}

export const queueVariantPage = internalMutation({
  args: {
    ownerId: v.string(),
    platform: listingPlatformValidator,
    setId: v.id("selectorOptions"),
    variantId: v.id("selectorOptions"),
    cursor: v.union(v.string(), v.null()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const state = await listingStateOf(ctx, args.ownerId, args.platform);
    if (!state || !pushesCounts(state)) return null;
    await queueVariantLines(ctx, args);
    // The variant's later pages: the run they join (or the next) reads them.
    await kickListingDrain(ctx, args.ownerId, args.platform);
    return null;
  },
});

// ───────────────────────────────────────────────────────────────────────────
// Sales
// ───────────────────────────────────────────────────────────────────────────

export const saleValidator = v.object({
  _id: v.id("marketplaceSales"),
  platform: listingPlatformValidator,
  orderNo: v.string(),
  orderDate: v.number(),
  status: v.string(),
  totals: v.object({
    subtotalCents: v.optional(v.number()),
    shippingCents: v.optional(v.number()),
    feesCents: v.optional(v.number()),
    netCents: v.optional(v.number()),
    totalCents: v.optional(v.number()),
  }),
  /** No marketplace card id and no SKU: a line with no `cardId` is one NB couldn't tie to a card. */
  items: v.array(
    v.object({
      cardId: v.optional(v.id("cardChecklist")),
      condition: v.string(),
      quantity: v.number(),
      priceCents: v.number(),
      applied: v.boolean(),
      problem: v.optional(saleItemProblemValidator),
      shortBy: v.optional(v.number()),
    }),
  ),
});

function publicSale(row: Doc<"marketplaceSales">): typeof saleValidator.type {
  return {
    _id: row._id,
    platform: row.platform,
    orderNo: row.orderNo,
    orderDate: row.orderDate,
    status: row.status,
    totals: row.totals,
    items: row.items.map((item) => ({
      ...(item.cardId !== undefined ? { cardId: item.cardId } : {}),
      condition: item.condition,
      quantity: item.quantity,
      priceCents: item.priceCents,
      applied: item.applied,
      ...(item.problem !== undefined ? { problem: item.problem } : {}),
      ...(item.shortBy !== undefined ? { shortBy: item.shortBy } : {}),
    })),
  };
}

/** The caller's orders on every platform, newest first, a page at a time. */
export const listSales = query({
  args: { paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(saleValidator),
  handler: async (ctx, args) => {
    const ownerId = await requireSignedIn(ctx);
    const result = await ctx.db
      .query("marketplaceSales")
      .withIndex("by_owner_date", (q) => q.eq("ownerId", ownerId))
      .order("desc")
      .paginate({
        ...args.paginationOpts,
        numItems: Math.max(1, Math.min(args.paginationOpts.numItems, MAX_SALES_PAGE)),
      });
    return { ...result, page: result.page.map(publicSale) };
  },
});
