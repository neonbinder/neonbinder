/**
 * NEO-370 — the collector's side of marketplace listing: the per-user switch,
 * a variant's listing status, Resync, and the Sales screen.
 *
 * Listing is opt-in, per collector and per platform, off by default. "On"
 * is exactly the existence of the owner's `marketplaceListingStates` row:
 * the copy-change hook (`listingOutbox.enqueueListingCards`) queues box
 * changes only for platforms with a row, and the order poll polls only
 * owners with one. Turning it on queues every card the collector holds in a
 * box (paged through scheduled internal mutations, so a 100k-copy inventory
 * never meets a transaction limit); turning it off deletes the row and the
 * owner's queued changes for that platform, and leaves what is listed on the
 * platform as it is.
 *
 * Every public function here is the signed-in caller's own: the owner is
 * always `requireSignedIn`, never an argument. A sync record's `leaseToken`
 * is server-only and never returned.
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
  carriesPlatformRef,
  enqueueListingCards,
  listingStateOf,
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
/** Cards of a variant Resync looks through for one to wake an empty variant with. */
const WAKE_SCAN_CARDS = 50;

/** The credential site key each listing platform signs in through. */
const CREDENTIAL_SITE: Record<ListingPlatform, string> = { bsc: "buysportscards" };

// ───────────────────────────────────────────────────────────────────────────
// Settings
// ───────────────────────────────────────────────────────────────────────────

const platformSettingsValidator = v.object({
  /** The collector lists on this platform (their state row exists). */
  enabled: v.boolean(),
  /** Their credentials for it are saved (Profile → Credentials). */
  connected: v.boolean(),
  /** The saved session died and they must sign in again on Profile. */
  needsReauth: v.boolean(),
  /** NB has paused this platform for everyone (`NEONBINDER_PAUSED_PLATFORMS`). */
  paused: v.boolean(),
});

async function platformSettings(ctx: QueryCtx, ownerId: string, platform: ListingPlatform) {
  const state = await listingStateOf(ctx, ownerId, platform);
  const site = CREDENTIAL_SITE[platform];
  const profile = await ctx.db
    .query("userProfiles")
    .withIndex("by_user", (q) => q.eq("userId", ownerId))
    .first();
  const credential = profile?.siteCredentials?.find((c) => c.site === site);
  return {
    enabled: state !== null,
    connected: credential?.hasCredentials === true,
    needsReauth: credential?.needsReauth === true,
    paused: isPlatformPaused(site),
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
 * Turn listing on one platform on or off for the caller. On: needs saved
 * credentials; makes the state row and queues every card the collector holds
 * in a box (paged, scheduled). Off: deletes the state row and the caller's
 * queued changes for that platform (paged); what the platform lists is left
 * as it is. Asking for the state it is already in writes nothing.
 */
export const setListingEnabled = mutation({
  args: { platform: listingPlatformValidator, enabled: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const ownerId = await requireSignedIn(ctx);
    const state = await listingStateOf(ctx, ownerId, args.platform);
    if (args.enabled) {
      if (state) return null;
      const settings = await platformSettings(ctx, ownerId, args.platform);
      if (!settings.connected) {
        refuse(
          COLLECTION_ERRORS.invalid,
          "Connect your BuySportsCards account on your Profile first, then switch listing on.",
        );
      }
      await ctx.db.insert("marketplaceListingStates", {
        ownerId,
        platform: args.platform,
        lastUpdated: Date.now(),
      });
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
    if (!state) return null;
    await ctx.db.delete(state._id);
    await clearOutbox(ctx, ownerId, args.platform);
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
 * the next page (or the next box) on the scheduler. Stops as soon as the
 * owner has turned listing off again (no state row).
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
    if (!(await listingStateOf(ctx, args.ownerId, args.platform))) return null;
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
    if (await listingStateOf(ctx, args.ownerId, args.platform)) return null;
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
  problems: v.array(
    v.object({
      cardId: v.optional(v.id("cardChecklist")),
      platformCardId: v.optional(v.string()),
      reason: listingProblemReasonValidator,
      detail: v.optional(v.string()),
    }),
  ),
  problemsTotal: v.optional(v.number()),
});

type SyncRecord = Doc<"marketplaceListingSyncs">;

/** A sync record as a client may see it: no lease token, no internal bookkeeping. */
function publicRecord(row: SyncRecord): typeof syncRecordValidator.type {
  return {
    status: row.status,
    ...(row.leaseExpiresAt !== undefined ? { leaseExpiresAt: row.leaseExpiresAt } : {}),
    ...(row.lastRunAt !== undefined ? { lastRunAt: row.lastRunAt } : {}),
    ...(row.lastSuccessAt !== undefined ? { lastSuccessAt: row.lastSuccessAt } : {}),
    ...(row.lastError !== undefined ? { lastError: row.lastError } : {}),
    ...(row.counts !== undefined ? { counts: row.counts } : {}),
    problems: row.problems,
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
 * run reads every condition the platform has) and queue the variant's box
 * cards. A variant with nothing in a box still gets one card queued, so the
 * run happens and sets the platform to NB's zero. Answers `queued: 0` and
 * writes nothing while listing is off.
 */
export const resyncVariant = mutation({
  args: { variantId: v.id("selectorOptions"), platform: v.optional(listingPlatformValidator) },
  returns: v.object({ queued: v.number() }),
  handler: async (ctx, args) => {
    const ownerId = await requireSignedIn(ctx);
    const platform = args.platform ?? "bsc";
    if (!(await listingStateOf(ctx, ownerId, platform))) return { queued: 0 };
    const record = await recordOf(ctx, ownerId, args.variantId, platform);
    if (record && record.lastSuccessAt !== undefined) {
      await ctx.db.patch(record._id, { lastSuccessAt: undefined, lastUpdated: Date.now() });
    }
    const setId = await findSetForSelectorOption(ctx, args.variantId);
    let queued = 0;
    if (setId) {
      queued = await queueVariantLines(ctx, { ownerId, platform, setId, variantId: args.variantId, cursor: null });
    }
    if (queued === 0) queued = await wakeVariant(ctx, ownerId, platform, args.variantId);
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
    if (!(await listingStateOf(ctx, args.ownerId, args.platform))) return null;
    await queueVariantLines(ctx, args);
    return null;
  },
});

/** Queue the variant's first card that carries the platform's id, so its run happens. */
async function wakeVariant(
  ctx: MutationCtx,
  ownerId: string,
  platform: ListingPlatform,
  variantId: Id<"selectorOptions">,
): Promise<number> {
  const cards = await ctx.db
    .query("cardChecklist")
    .withIndex("by_selector_option", (q) => q.eq("selectorOptionId", variantId))
    .take(WAKE_SCAN_CARDS);
  const card = cards.find((c) => carriesPlatformRef(c, platform));
  if (!card) return 0;
  return await enqueueListingCards(ctx, { ownerId, cardIds: [card._id], platforms: [platform] });
}

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
  items: v.array(
    v.object({
      platformCardId: v.string(),
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
      platformCardId: item.platformCardId,
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
