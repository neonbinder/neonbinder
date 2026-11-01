/**
 * NEO-370 — the collector's side of marketplace listing: starting to list,
 * a set's Sync button, the Sync status tab (theirs, and the read-only admin
 * view across collectors), and the Sales screen.
 *
 * Revision 4 (Jason, 2026-11-01): there is no per-platform switch and no
 * pause. Everything in a LISTED box (a box whose "Listed on marketplaces"
 * setting is not off, `listingOutbox.listsOnMarketplaces`) lists on every
 * platform the collector has STARTED. Starting is one-way and explicit
 * (`startListing`, the button under the warning beside the saved sign-in);
 * saving a sign-in alone starts nothing. Removing the sign-in stops listing
 * and clears the start (`listingOutbox.setListingCredentialsDormant`).
 *
 * The owner's `marketplaceListingStates` row is made by the first Start and
 * then kept. Starting queues every card the collector holds in a listed box
 * (paged through scheduled internal mutations, so a 100k-copy inventory never
 * meets a transaction limit) and the walk's last page runs the drain.
 *
 * Every collector function here is the signed-in caller's own: the owner is
 * always `requireSignedIn`, never an argument. The admin reads take an owner
 * and are `requireAdmin`-gated and read-only. A sync record's `leaseToken`,
 * the owner's drain lease, a marketplace's card ids, the seller account id,
 * an order's id and a line's SKU are server-only and never returned.
 */
import { v } from "convex/values";
import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalMutation, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireAdmin, requireSignedIn } from "./auth";
import { HomeSides, MAX_CONTAINERS, MAX_SYSTEM_CONTAINERS } from "./collection";
import { findSetForSelectorOption } from "./lib/selectorAncestry";
import { ListingLabels } from "./lib/listingLabels";
import { isPlatformPaused } from "./marketplacePause";
import { DRAIN_LEASE_MS, MAX_STORED_PROBLEMS } from "./listingDrain";
import {
  clearListingOutbox,
  enqueueListingCards,
  kickListingDrain,
  LISTING_CREDENTIAL_SITE,
  LISTING_PLATFORMS,
  listingCredentialOf,
  listingStateOf,
  listsOnMarketplaces,
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

/** Copy lines one page of a queueing walk reads (Start, a box flip, Sync). */
export const QUEUE_PAGE_LINES = 200;
/** Orders one Sales page returns at most. */
export const MAX_SALES_PAGE = 50;
/** A Sync pressed within this long of the last one (or during a run) is ignored. */
export const RESYNC_THROTTLE_MS = 60_000;

/** The Sync status tab's caps, per platform (NEO-392: a subscribed read stays small). */
export const STATUS_CAPS = {
  /** Cards queued for the next sync, oldest first. */
  queued: 100,
  /** Of those, the first this many are named (card + players); the rest carry ids, set and time only. */
  queuedLabelled: 30,
  /** Sets, most recent run first. */
  sets: 50,
  /** Held-back cards named per set; the rest through `syncSetProblems`. */
  problemsPerSet: 5,
  /** Held-back cards read (card + players) across all sets of one platform. */
  problemCards: 60,
} as const;
/**
 * The admin view across collectors (no owner picked): each owner's lists cut
 * to a glance (the latest few sets and queued cards), so 25 owners stay a few
 * hundred reads. Filtering to one collector shows `STATUS_CAPS`.
 */
export const ADMIN_ALL_CAPS = { queued: 3, queuedLabelled: 3, sets: 3, problemsPerSet: 2, problemCards: 2 } as const;
/** Collectors the admin view shows at once with no owner picked. */
export const ADMIN_STATUS_OWNERS = 25;
/** Collectors the admin owner picker lists. */
export const ADMIN_OWNER_LIST = 200;

type StatusCaps = { queued: number; queuedLabelled: number; sets: number; problemsPerSet: number; problemCards: number };

// ───────────────────────────────────────────────────────────────────────────
// Settings and Start
// ───────────────────────────────────────────────────────────────────────────

const platformSettingsValidator = v.object({
  /** Their sign-in for it is saved (Profile → Credentials). */
  connected: v.boolean(),
  /** They pressed Start and NB is pushing their counts (not dormant). */
  listing: v.boolean(),
  /** When they pressed Start (kept while a seller conflict holds pushing back). */
  listingSince: v.optional(v.number()),
  /** The saved session died and they must sign in again on Profile. */
  needsReauth: v.boolean(),
  /** NB has paused this platform for everyone (`NEONBINDER_PAUSED_PLATFORMS`). */
  paused: v.boolean(),
  /** Their seller account already lists from another NeonBinder account: nothing is pushed or polled. */
  sellerConflict: v.boolean(),
});
type PlatformSettings = typeof platformSettingsValidator.type;

async function platformSettings(
  ctx: QueryCtx,
  ownerId: string,
  platform: ListingPlatform,
  state?: Doc<"marketplaceListingStates"> | null,
): Promise<PlatformSettings> {
  const row = state === undefined ? await listingStateOf(ctx, ownerId, platform) : state;
  const credential = await listingCredentialOf(ctx, ownerId, platform);
  return {
    connected: credential.hasCredentials,
    listing: row !== null && pushesCounts(row),
    ...(row?.listingStartedAt !== undefined ? { listingSince: row.listingStartedAt } : {}),
    needsReauth: credential.needsReauth,
    paused: isPlatformPaused(LISTING_CREDENTIAL_SITE[platform]),
    sellerConflict: row?.dormant === "sellerConflict",
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
 * Start listing on one platform: the one-way consent (Profile, under the
 * warning beside the saved sign-in). There is no stop here; removing the
 * sign-in stops listing.
 *
 * Refused while NB has paused the platform (`paused`, the same switch the
 * drain honours). Needs a saved sign-in (`notConnected` otherwise), and refuses a seller
 * account another NB owner already lists from (`sellerConflict`; one NB owner
 * per seller account, the account the owner's last sign-in captured when
 * known; the drainer checks it again before its first push). Neither refusal
 * writes anything.
 *
 * Starting makes the state row (or wakes the kept one, clearing a dormancy
 * that no longer applies), stamps `listingStartedAt` and queues every card the
 * collector holds in a listed box (paged, scheduled); the walk's last page
 * runs the drain. Idempotent: pressed while already listing, it answers
 * `started: true` and writes nothing.
 */
export const startListing = mutation({
  args: { platform: listingPlatformValidator },
  returns: v.object({
    started: v.boolean(),
    reason: v.optional(v.union(v.literal("notConnected"), v.literal("sellerConflict"), v.literal("paused"))),
  }),
  handler: async (ctx, args) => {
    const ownerId = await requireSignedIn(ctx);
    // NB has paused the platform for everyone (the switch the drain's token
    // read honours): nothing would push, so nothing starts.
    if (isPlatformPaused(LISTING_CREDENTIAL_SITE[args.platform])) return { started: false, reason: "paused" as const };
    const state = await listingStateOf(ctx, ownerId, args.platform);
    if (state && pushesCounts(state)) return { started: true };
    const credential = await listingCredentialOf(ctx, ownerId, args.platform);
    if (!credential.hasCredentials) return { started: false, reason: "notConnected" as const };
    const accountId = credential.sellerId ?? state?.platformAccountId ?? null;
    if (accountId !== null && (await sellerAccountHolder(ctx, args.platform, accountId, ownerId))) {
      return { started: false, reason: "sellerConflict" as const };
    }
    const now = Date.now();
    const on = {
      listingStartedAt: state?.listingStartedAt ?? now,
      dormant: undefined,
      ...(accountId !== null ? { platformAccountId: accountId } : {}),
      lastUpdated: now,
    };
    if (state) await ctx.db.patch(state._id, on);
    else await ctx.db.insert("marketplaceListingStates", { ownerId, platform: args.platform, ...on });
    const boxIds = await listedBoxIdsOf(ctx, ownerId);
    if (boxIds.length > 0) {
      await ctx.scheduler.runAfter(0, internal.listingSync.queueBoxesPage, {
        ownerId,
        platform: args.platform,
        boxIds,
        index: 0,
        cursor: null,
      });
    }
    return { started: true };
  },
});

/** The owner's listed boxes (Unsorted included, in-person boxes left out), oldest first. One bounded read. */
async function listedBoxIdsOf(ctx: QueryCtx, ownerId: string): Promise<Array<Id<"collectionContainers">>> {
  const rows = await ctx.db
    .query("collectionContainers")
    .withIndex("by_owner_and_system", (q) => q.eq("ownerId", ownerId))
    .take(MAX_CONTAINERS + MAX_SYSTEM_CONTAINERS);
  return rows.filter(listsOnMarketplaces).map((row) => row._id);
}

/** A flip's walk stamped within this long is taken as still pending (see `listedQueuedAt`). */
export const LISTED_WALK_PENDING_MS = 60_000;

/** The platforms the owner has started and NB pushes to now. */
async function startedPlatformsOf(ctx: QueryCtx, ownerId: string): Promise<ListingPlatform[]> {
  const out: ListingPlatform[] = [];
  for (const platform of LISTING_PLATFORMS) {
    const state = await listingStateOf(ctx, ownerId, platform);
    if (state && pushesCounts(state)) out.push(platform);
  }
  return out;
}

/**
 * Queue one box's cards on every platform the owner lists on: a box's
 * "Listed on marketplaces" setting was flipped to `listed`
 * (`collectionContainers.setContainerListed`), so every card in it may now
 * count differently there. Like a move, it only queues: the next trigger
 * (Sync, a finished intake, the cron) pushes. Paged and scheduled
 * (`queueListedBoxPage`), so a box of any size is safe.
 *
 * Debounced: one walk per box. A flip while the box's walk is pending (its
 * `listedQueuedAt` stamp is under `LISTED_WALK_PENDING_MS` old) schedules
 * nothing; that walk reads the box's setting on every page and follows it.
 * Writes nothing when the owner lists nowhere. Returns whether a walk was
 * scheduled.
 */
export async function queueBoxForListing(
  ctx: MutationCtx,
  ownerId: string,
  box: Pick<Doc<"collectionContainers">, "_id" | "listedQueuedAt">,
  listed: boolean,
): Promise<boolean> {
  if ((await startedPlatformsOf(ctx, ownerId)).length === 0) return false;
  const now = Date.now();
  if (box.listedQueuedAt !== undefined && now - box.listedQueuedAt < LISTED_WALK_PENDING_MS) return false;
  await ctx.db.patch(box._id, { listedQueuedAt: now });
  await ctx.scheduler.runAfter(0, internal.listingSync.queueListedBoxPage, {
    ownerId,
    boxId: box._id,
    listed,
    queuedAt: now,
    cursor: null,
  });
  return true;
}

/**
 * One page of a box flip's walk: the box's copies queued on every platform
 * the owner has started, then the next page on the scheduler; the last page
 * clears the box's stamp. It only queues (no drain).
 *
 *   - Superseded (the box carries another stamp: a newer walk replaced one
 *     taken for dead) or gone: stands down, writes nothing.
 *   - The owner lists nowhere now: clears the stamp and stops.
 *   - The box's setting no longer matches `listed` (flipped back while this
 *     walk was pending): this walk stops, and one fresh walk carrying the
 *     box's current setting starts over from the first page, because cards
 *     this walk already queued may have been pushed under the old setting.
 */
export const queueListedBoxPage = internalMutation({
  args: {
    ownerId: v.string(),
    boxId: v.id("collectionContainers"),
    /** The setting the flip set (`true` = listed). */
    listed: v.boolean(),
    /** The stamp this walk was started with (`listedQueuedAt`). */
    queuedAt: v.number(),
    cursor: v.union(v.string(), v.null()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const box = await ctx.db.get(args.boxId);
    if (!box || box.ownerId !== args.ownerId || box.kind !== "box") return null;
    if (box.listedQueuedAt !== args.queuedAt) return null;
    const platforms = await startedPlatformsOf(ctx, args.ownerId);
    if (platforms.length === 0) {
      await ctx.db.patch(box._id, { listedQueuedAt: undefined });
      return null;
    }
    const listedNow = listsOnMarketplaces(box);
    if (listedNow !== args.listed) {
      const now = Date.now();
      await ctx.db.patch(box._id, { listedQueuedAt: now });
      await ctx.scheduler.runAfter(0, internal.listingSync.queueListedBoxPage, {
        ownerId: args.ownerId,
        boxId: args.boxId,
        listed: listedNow,
        queuedAt: now,
        cursor: null,
      });
      return null;
    }
    const page = await ctx.db
      .query("collectionCopies")
      .withIndex("by_owner_home_slot", (q) => q.eq("ownerId", args.ownerId).eq("homeId", args.boxId))
      .paginate({ numItems: QUEUE_PAGE_LINES, cursor: args.cursor });
    await enqueueListingCards(ctx, {
      ownerId: args.ownerId,
      cardIds: page.page.map((row) => row.cardId),
      platforms,
    });
    if (page.isDone) await ctx.db.patch(box._id, { listedQueuedAt: undefined });
    else await ctx.scheduler.runAfter(0, internal.listingSync.queueListedBoxPage, { ...args, cursor: page.continueCursor });
    return null;
  },
});

/**
 * The Start walk over boxes: one page of one box's copies, queued for
 * `platform`, then the next page (or the next box) on the scheduler. Its last
 * page runs the drain (the owner's first sync). Stops as soon as the owner no
 * longer lists on the platform. (A box flip walks `queueListedBoxPage`.)
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
 * One more page of the stop-listing sweep (`listingOutbox.clearListingOutbox`,
 * run when the sign-in is removed). Stands down once the owner lists on the
 * platform again: a fresh Start walk owns the queue from then on.
 */
export const clearOutboxPage = internalMutation({
  args: { ownerId: v.string(), platform: listingPlatformValidator },
  returns: v.null(),
  handler: async (ctx, args) => {
    const state = await listingStateOf(ctx, args.ownerId, args.platform);
    if (state && pushesCounts(state)) return null;
    await clearListingOutbox(ctx, args.ownerId, args.platform);
    return null;
  },
});

// ───────────────────────────────────────────────────────────────────────────
// Sync: one set, every platform
// ───────────────────────────────────────────────────────────────────────────

async function recordOf(
  ctx: QueryCtx,
  ownerId: string,
  variantId: Id<"selectorOptions">,
  platform: ListingPlatform,
): Promise<Doc<"marketplaceListingSyncs"> | null> {
  return await ctx.db
    .query("marketplaceListingSyncs")
    .withIndex("by_owner_variant_platform", (q) =>
      q.eq("ownerId", ownerId).eq("variantId", variantId).eq("platform", platform),
    )
    .first();
}

/**
 * The checklist's Sync button: read this set's sheet on every platform the
 * collector lists on, for EVERY condition, set every card to NB's counts and
 * push. Per platform it stamps the press on the variant's sync record (the
 * next run reads every condition, see `listingDrain.claimVariant`), queues the
 * variant's box cards (one card that carries the platform's id when none is
 * in a box, so the run happens and sets the platform to NB's zero) and runs
 * the drain now.
 *
 * Answers `ignored: "notListing"` (and writes nothing) when no platform is
 * started. A press while the variant's run is under way, or within
 * `RESYNC_THROTTLE_MS` of the last press, is dropped on that platform: the run
 * under way, or about to start, reads the set in full. `queued` is true when
 * at least one platform took the press (queued work, or kicked a drain for a
 * change already queued); `ignored: "throttled"` only when every started
 * platform dropped it. `queued: false` with no reason: nothing to sync here
 * (the set has no card any started platform can list, or the collector holds
 * no copy of it and never synced it).
 */
export const syncVariant = mutation({
  args: { variantId: v.id("selectorOptions") },
  returns: v.object({
    queued: v.boolean(),
    ignored: v.optional(v.union(v.literal("throttled"), v.literal("notListing"))),
  }),
  handler: async (ctx, args) => {
    const ownerId = await requireSignedIn(ctx);
    const platforms = await startedPlatformsOf(ctx, ownerId);
    if (platforms.length === 0) return { queued: false, ignored: "notListing" as const };
    let queued = false;
    let throttled = 0;
    for (const platform of platforms) {
      const outcome = await syncOnePlatform(ctx, ownerId, platform, args.variantId);
      if (outcome === "queued") queued = true;
      else if (outcome === "throttled") throttled += 1;
    }
    if (queued) return { queued: true };
    if (throttled === platforms.length) return { queued: false, ignored: "throttled" as const };
    return { queued: false };
  },
});

async function syncOnePlatform(
  ctx: MutationCtx,
  ownerId: string,
  platform: ListingPlatform,
  variantId: Id<"selectorOptions">,
): Promise<"queued" | "throttled" | "nothing"> {
  const now = Date.now();
  const record = await recordOf(ctx, ownerId, variantId, platform);
  if (record) {
    const running = record.status === "running" && (record.leaseExpiresAt ?? 0) > now;
    const recent = record.resyncRequestedAt !== undefined && now - record.resyncRequestedAt < RESYNC_THROTTLE_MS;
    if (running || recent) return "throttled";
  } else {
    // Never run yet (its first run reads every condition anyway): no record
    // to stamp. A change queued for the variant in the last minute (a box
    // write, or a press) is not queued again, but the press still runs the
    // drain that syncs it: taken, not dropped.
    const queuedRow = await ctx.db
      .query("listingOutbox")
      .withIndex("by_owner_platform_variant", (q) =>
        q.eq("ownerId", ownerId).eq("platform", platform).eq("variantId", variantId),
      )
      .first();
    if (queuedRow && now - queuedRow.changedAt < RESYNC_THROTTLE_MS) {
      await kickListingDrain(ctx, ownerId, platform);
      return "queued";
    }
  }
  const setId = await findSetForSelectorOption(ctx, variantId);
  let written = 0;
  let holdsCopy = false;
  if (setId) {
    const lines = await queueVariantLines(ctx, { ownerId, platform, setId, variantId, cursor: null });
    written = lines.queued;
    holdsCopy = lines.holdsCopy;
  }
  // Nothing in a box: wake the variant (one card, so its run sets the
  // platform to NB's zero) only for a set the collector has synced before or
  // holds a copy of; any other set id is nothing to sync.
  if (written === 0 && (record !== null || holdsCopy)) written = await wakeVariant(ctx, ownerId, platform, variantId);
  if (written === 0) return "nothing";
  if (record) await ctx.db.patch(record._id, { resyncRequestedAt: now, lastUpdated: now });
  await kickListingDrain(ctx, ownerId, platform);
  return "queued";
}

/**
 * One page of a variant's copies: the box ones queued, the next page on the
 * scheduler. Returns how many outbox rows the page wrote, and whether the
 * page held any copy of the variant at all (any home).
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
): Promise<{ queued: number; holdsCopy: boolean }> {
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
  return { queued, holdsCopy: page.page.length > 0 };
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
// The Sync status tab
// ───────────────────────────────────────────────────────────────────────────

/** One held-back card: NB's number and label, never a marketplace id. */
const syncProblemValidator = v.object({
  cardNo: v.optional(v.string()),
  cardLabel: v.optional(v.string()),
  reason: listingProblemReasonValidator,
  detail: v.optional(v.string()),
});
type SyncProblem = typeof syncProblemValidator.type;

const countsValidator = v.object({
  listed: v.number(),
  pushed: v.number(),
  zeroed: v.number(),
  skipped: v.number(),
});

const platformStatusValidator = v.object({
  platform: listingPlatformValidator,
  connected: v.boolean(),
  listing: v.boolean(),
  needsReauth: v.boolean(),
  paused: v.boolean(),
  sellerConflict: v.boolean(),
  /** A sync running now: since when, and the set it is on when known. */
  running: v.union(
    v.null(),
    v.object({
      startedAt: v.number(),
      setLabel: v.optional(v.string()),
      variantId: v.optional(v.id("selectorOptions")),
    }),
  ),
  /** A sync is scheduled to start (kicked, not yet running). */
  scheduledAt: v.optional(v.number()),
  lastDrainAt: v.optional(v.number()),
  /** Cards waiting for the next sync, oldest first, `STATUS_CAPS.queued` at most. */
  queued: v.object({
    cards: v.array(
      v.object({
        cardId: v.id("cardChecklist"),
        cardNo: v.optional(v.string()),
        cardLabel: v.optional(v.string()),
        variantId: v.id("selectorOptions"),
        setLabel: v.string(),
        changedAt: v.number(),
      }),
    ),
    more: v.boolean(),
  }),
  /** Each set's last result, most recent run first, `STATUS_CAPS.sets` at most. */
  sets: v.array(
    v.object({
      variantId: v.id("selectorOptions"),
      setLabel: v.string(),
      status: v.union(v.literal("idle"), v.literal("running"), v.literal("error")),
      lastRunAt: v.optional(v.number()),
      lastSuccessAt: v.optional(v.number()),
      lastError: v.optional(v.string()),
      counts: v.optional(countsValidator),
      problemsTotal: v.number(),
      /** The first few only; the rest through `syncSetProblems`. */
      problems: v.array(syncProblemValidator),
    }),
  ),
});
type PlatformStatus = typeof platformStatusValidator.type;

const syncStatusValidator = v.object({ platforms: v.array(platformStatusValidator) });
type SyncStatus = typeof syncStatusValidator.type;

/** A stored problem as the tab shows it: hydrated while `budget` lasts, else reason and detail only. */
async function publicProblem(
  labels: ListingLabels,
  problem: Doc<"marketplaceListingSyncs">["problems"][number],
  budget: { left: number },
): Promise<SyncProblem> {
  const out: SyncProblem = {
    reason: problem.reason,
    ...(problem.detail !== undefined ? { detail: problem.detail } : {}),
  };
  if (problem.cardId === undefined || budget.left <= 0) return out;
  budget.left -= 1;
  const card = await labels.card(problem.cardId);
  if (!card) return out;
  return {
    cardNo: card.cardNo,
    ...(card.cardLabel !== undefined ? { cardLabel: card.cardLabel } : {}),
    ...out,
  };
}

async function platformStatus(
  ctx: QueryCtx,
  labels: ListingLabels,
  ownerId: string,
  platform: ListingPlatform,
  caps: StatusCaps,
): Promise<PlatformStatus> {
  const now = Date.now();
  const state = await listingStateOf(ctx, ownerId, platform);
  const settings = await platformSettings(ctx, ownerId, platform, state);

  const records = await ctx.db
    .query("marketplaceListingSyncs")
    .withIndex("by_owner_platform_run", (q) => q.eq("ownerId", ownerId).eq("platform", platform))
    .order("desc")
    .take(caps.sets);
  const live = (r: Doc<"marketplaceListingSyncs">) => r.status === "running" && (r.leaseExpiresAt ?? 0) > now;

  // Running: the owner's drain lease, and the set its run holds now (a
  // running record with a live lease; most recent first).
  const runningRecord = records.find(live) ?? null;
  const drainLive = state?.drainLeaseToken !== undefined && (state.drainLeaseExpiresAt ?? 0) > now;
  let running: PlatformStatus["running"] = null;
  if (drainLive || runningRecord) {
    const startedAt = drainLive
      ? (state!.drainLeaseExpiresAt as number) - DRAIN_LEASE_MS
      : (runningRecord!.lastRunAt ?? now);
    running = {
      startedAt,
      ...(runningRecord
        ? { variantId: runningRecord.variantId, setLabel: await labels.setLabel(runningRecord.variantId) }
        : {}),
    };
  }

  const rows = await ctx.db
    .query("listingOutbox")
    .withIndex("by_owner_platform_changed", (q) => q.eq("ownerId", ownerId).eq("platform", platform))
    .take(caps.queued + 1);
  const cards: PlatformStatus["queued"]["cards"] = [];
  for (const [i, row] of rows.slice(0, caps.queued).entries()) {
    // Past the first `queuedLabelled`, no card (or player) is read: the row's
    // own variant and a cached set label only.
    const card = i < caps.queuedLabelled ? await labels.card(row.cardId) : null;
    const variantId = card?.variantId ?? row.variantId;
    cards.push({
      cardId: row.cardId,
      ...(card ? { cardNo: card.cardNo } : {}),
      ...(card?.cardLabel !== undefined ? { cardLabel: card.cardLabel } : {}),
      variantId,
      setLabel: await labels.setLabel(variantId),
      changedAt: row.changedAt,
    });
  }

  const budget = { left: caps.problemCards };
  const sets: PlatformStatus["sets"] = [];
  for (const r of records) {
    const problems: SyncProblem[] = [];
    for (const p of r.problems.slice(0, caps.problemsPerSet)) problems.push(await publicProblem(labels, p, budget));
    sets.push({
      variantId: r.variantId,
      setLabel: await labels.setLabel(r.variantId),
      // A `running` record whose lease ran out is a run that died: it reads
      // as its last result until the next run reclaims it.
      status: r.status === "running" && !live(r) ? (r.lastError !== undefined ? "error" : "idle") : r.status,
      ...(r.lastRunAt !== undefined ? { lastRunAt: r.lastRunAt } : {}),
      ...(r.lastSuccessAt !== undefined ? { lastSuccessAt: r.lastSuccessAt } : {}),
      ...(r.lastError !== undefined ? { lastError: r.lastError } : {}),
      ...(r.counts !== undefined ? { counts: r.counts } : {}),
      problemsTotal: r.problemsTotal ?? r.problems.length,
      problems,
    });
  }

  return {
    platform,
    connected: settings.connected,
    listing: settings.listing,
    needsReauth: settings.needsReauth,
    paused: settings.paused,
    sellerConflict: settings.sellerConflict,
    running,
    ...(state?.drainScheduledAt !== undefined ? { scheduledAt: state.drainScheduledAt } : {}),
    ...(state?.lastDrainAt !== undefined ? { lastDrainAt: state.lastDrainAt } : {}),
    queued: { cards, more: rows.length > caps.queued },
    sets,
  };
}

async function syncStatusOf(
  ctx: QueryCtx,
  ownerId: string,
  caps: StatusCaps,
  labels: ListingLabels = new ListingLabels(ctx),
): Promise<SyncStatus> {
  const platforms: PlatformStatus[] = [];
  for (const platform of LISTING_PLATFORMS) platforms.push(await platformStatus(ctx, labels, ownerId, platform, caps));
  return { platforms };
}

/** The full held-back list of one set on one platform (what the record kept, `MAX_STORED_PROBLEMS` at most). */
async function setProblemsOf(
  ctx: QueryCtx,
  ownerId: string,
  variantId: Id<"selectorOptions">,
  platform: ListingPlatform,
): Promise<{ problems: SyncProblem[]; problemsTotal: number }> {
  const record = await recordOf(ctx, ownerId, variantId, platform);
  if (!record) return { problems: [], problemsTotal: 0 };
  const labels = new ListingLabels(ctx);
  const budget = { left: MAX_STORED_PROBLEMS };
  const problems: SyncProblem[] = [];
  for (const p of record.problems.slice(0, MAX_STORED_PROBLEMS)) problems.push(await publicProblem(labels, p, budget));
  return { problems, problemsTotal: record.problemsTotal ?? record.problems.length };
}

const setProblemsValidator = v.object({ problems: v.array(syncProblemValidator), problemsTotal: v.number() });

/**
 * The caller's Sync status tab: per platform, the sync running now, the cards
 * queued for the next one and each set's last result (no run log). Capped
 * (`STATUS_CAPS`) so the subscription stays a few hundred reads.
 */
export const syncStatus = query({
  args: {},
  returns: syncStatusValidator,
  handler: async (ctx) => {
    const ownerId = await requireSignedIn(ctx);
    return await syncStatusOf(ctx, ownerId, STATUS_CAPS);
  },
});

/** One of the caller's sets, every held-back card (read when its row is expanded). */
export const syncSetProblems = query({
  args: { variantId: v.id("selectorOptions"), platform: listingPlatformValidator },
  returns: setProblemsValidator,
  handler: async (ctx, args) => {
    const ownerId = await requireSignedIn(ctx);
    return await setProblemsOf(ctx, ownerId, args.variantId, args.platform);
  },
});

// ── Admin: the same screen across collectors, read-only ─────────────────────

/** A collector as the admin screen names them: their public display name or @username, else the id. */
async function ownerLabel(ctx: QueryCtx, ownerId: string): Promise<string> {
  const profile = await ctx.db
    .query("publicProfiles")
    .withIndex("by_user", (q) => q.eq("userId", ownerId))
    .first();
  const display = profile?.displayName?.trim();
  if (display) return display;
  if (profile?.username) return `@${profile.username}`;
  return ownerId;
}

/** Collectors with a listing state on any platform, at most `cap`, de-duplicated. */
async function listingOwners(ctx: QueryCtx, cap: number): Promise<{ ownerIds: string[]; more: boolean }> {
  const seen = new Set<string>();
  const ownerIds: string[] = [];
  let more = false;
  for (const platform of LISTING_PLATFORMS) {
    const rows = await ctx.db
      .query("marketplaceListingStates")
      .withIndex("by_platform_dormant_polled", (q) => q.eq("platform", platform))
      .take(cap + 1);
    if (rows.length > cap) more = true;
    for (const row of rows.slice(0, cap)) {
      if (seen.has(row.ownerId)) continue;
      if (ownerIds.length >= cap) {
        more = true;
        break;
      }
      seen.add(row.ownerId);
      ownerIds.push(row.ownerId);
    }
  }
  return { ownerIds, more };
}

/** The admin owner picker: every collector with a listing state (`ADMIN_OWNER_LIST` at most). */
export const adminSyncOwners = query({
  args: {},
  returns: v.array(v.object({ ownerId: v.string(), label: v.string() })),
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const { ownerIds } = await listingOwners(ctx, ADMIN_OWNER_LIST);
    const out = [];
    for (const ownerId of ownerIds) out.push({ ownerId, label: await ownerLabel(ctx, ownerId) });
    return out;
  },
});

/**
 * The admin Sync status, read-only. One collector (`ownerId`): their full
 * status (`STATUS_CAPS`). None: the first `ADMIN_STATUS_OWNERS` collectors
 * with a listing state, each with shorter lists (`ADMIN_ALL_CAPS`); `more`
 * says there are more collectors than shown.
 */
export const adminSyncStatus = query({
  args: { ownerId: v.optional(v.string()) },
  returns: v.object({
    owners: v.array(v.object({ ownerId: v.string(), label: v.string(), status: syncStatusValidator })),
    more: v.boolean(),
  }),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    if (args.ownerId !== undefined) {
      return {
        owners: [
          {
            ownerId: args.ownerId,
            label: await ownerLabel(ctx, args.ownerId),
            status: await syncStatusOf(ctx, args.ownerId, STATUS_CAPS),
          },
        ],
        more: false,
      };
    }
    const { ownerIds, more } = await listingOwners(ctx, ADMIN_STATUS_OWNERS);
    // One label cache across owners: collectors in the same sets read each set's chain once.
    const labels = new ListingLabels(ctx);
    const owners = [];
    for (const ownerId of ownerIds) {
      owners.push({
        ownerId,
        label: await ownerLabel(ctx, ownerId),
        status: await syncStatusOf(ctx, ownerId, ADMIN_ALL_CAPS, labels),
      });
    }
    return { owners, more };
  },
});

/** One collector's set, every held-back card. Admin only, read-only. */
export const adminSyncSetProblems = query({
  args: { ownerId: v.string(), variantId: v.id("selectorOptions"), platform: listingPlatformValidator },
  returns: setProblemsValidator,
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    return await setProblemsOf(ctx, args.ownerId, args.variantId, args.platform);
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
