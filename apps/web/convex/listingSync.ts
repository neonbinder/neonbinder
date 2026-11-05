/**
 * NEO-370 — the collector's side of marketplace listing: what a saved
 * sign-in starts, a set's Sync button, the Sync status tab (theirs, and the
 * read-only admin view across collectors), and the Sales screen.
 *
 * Revision 5 (Jason, 2026-11-01): "If you have credentials you are syncing."
 * A sign-in saved for a listing platform's site, on a platform NB has not
 * paused, IS listing: NB pushes the counts of everything in the collector's
 * LISTED boxes (a box whose "Listed on marketplaces" setting is not off,
 * `listingOutbox.listsOnMarketplaces`) and polls that platform's orders.
 * There is no Start button, no switch and no pause. Saving the sign-in
 * starts it (`setUpListing`, from `userProfile.updateSiteCredentialStatus`);
 * removing it stops it (`listingOutbox.stopListingForSite`). A sign-in saved
 * before this rule is set up by the order-poll cron (`setUpSavedSignInsPage`).
 *
 * Setting up makes the owner's `marketplaceListingStates` row (or wakes the
 * kept one), stamps `listingStartedAt` and queues every card the collector
 * holds in a listed box (paged through scheduled internal mutations, so a
 * 100k-copy inventory never meets a transaction limit); the walk's last page
 * runs the drain.
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
  platformReachable,
  pushesCounts,
  sellerAccountHolder,
  wakeVariant,
  type ListingPlatform,
} from "./listingOutbox";
import {
  collectionCopyConditionValidator,
  listingPlatformValidator,
  listingProblemReasonValidator,
  listingSyncStepKindValidator,
  listingSyncStepStatusValidator,
  saleItemProblemValidator,
} from "./schema";

/** Copy lines one page of a queueing walk reads (a saved sign-in, a box flip, Sync). */
export const QUEUE_PAGE_LINES = 200;
/** Orders one Sales page returns at most. */
export const MAX_SALES_PAGE = 50;
/** A Sync pressed within this long of the last one is ignored. */
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
// Settings, and what a saved sign-in starts
// ───────────────────────────────────────────────────────────────────────────

const platformSettingsValidator = v.object({
  /** Their sign-in for it is saved (Profile → Credentials). */
  connected: v.boolean(),
  /**
   * NB is pushing their counts and polling their sales: the sign-in is saved,
   * the platform is not paused, NB has not made the row dormant (a seller
   * conflict, a removed sign-in) and no test marker holds it off.
   */
  listing: v.boolean(),
  /** When the saved sign-in started listing (absent while not listing). */
  listingSince: v.optional(v.number()),
  /** The saved session died and they must sign in again on Profile. */
  needsReauth: v.boolean(),
  /** NB has paused this platform for everyone (`NEONBINDER_PAUSED_PLATFORMS`). */
  paused: v.boolean(),
  /** Their seller account already lists from another NeonBinder account: nothing is pushed or polled. */
  sellerConflict: v.boolean(),
});
type PlatformSettings = typeof platformSettingsValidator.type;

/** The owner lists on the platform now: the state row's rule (`pushesCounts`) and the platform not paused. */
function listsNow(row: Doc<"marketplaceListingStates"> | null, platform: ListingPlatform): boolean {
  return row !== null && pushesCounts(row) && platformReachable(platform);
}

export async function platformSettings(
  ctx: QueryCtx,
  ownerId: string,
  platform: ListingPlatform,
  state?: Doc<"marketplaceListingStates"> | null,
): Promise<PlatformSettings> {
  const row = state === undefined ? await listingStateOf(ctx, ownerId, platform) : state;
  const credential = await listingCredentialOf(ctx, ownerId, platform);
  const listing = credential.hasCredentials && listsNow(row, platform);
  return {
    connected: credential.hasCredentials,
    listing,
    ...(listing && row?.listingStartedAt !== undefined ? { listingSince: row.listingStartedAt } : {}),
    needsReauth: credential.needsReauth,
    paused: isPlatformPaused(LISTING_CREDENTIAL_SITE[platform]),
    sellerConflict: row?.dormant === "sellerConflict",
  };
}

/** Where the collector stands with each listing platform. Small and subscribable. */
export const listingSettings = query({
  args: {},
  returns: v.object({ bsc: platformSettingsValidator, ebay: platformSettingsValidator }),
  handler: async (ctx) => {
    const ownerId = await requireSignedIn(ctx);
    return {
      bsc: await platformSettings(ctx, ownerId, "bsc"),
      ebay: await platformSettings(ctx, ownerId, "ebay"),
    };
  },
});

/** What `setUpListing` did. */
export type ListingSetup =
  /** Already listing: nothing written (a repeated save, a token refresh). */
  | "listing"
  /** Listing started now: row stamped, the owner's boxes queued, the drain to follow. */
  | "started"
  /** Another NB owner lists from the same seller account: the row is dormant, nothing queued. */
  | "sellerConflict"
  /** NB has paused the platform and this is no real save: nothing written. */
  | "paused"
  /** No saved sign-in for the platform's site: nothing written. */
  | "notConnected"
  /**
   * The E2E test marker holds this owner off and this is no real save, or
   * this is a testing deployment and no real save: nothing written.
   */
  | "testOff";

/**
 * A sign-in for `platform`'s site was saved (or found saved by the cron):
 * start listing there. Called from `userProfile.updateSiteCredentialStatus`
 * on every save and every successful login (`credentials` re-asserts the
 * flag), and from `setUpSavedSignInsPage`. `save` is true only for a real
 * save (the collector's own, through the product UI, or the testing seed
 * asking for listing); a login re-asserting the flag, and the cron, pass
 * false.
 *
 * Cheap and idempotent: an owner already listing costs one state read and
 * writes nothing, so a token refresh or a repeated save never walks twice.
 * Otherwise, in order:
 *   - no real save while NB has paused the platform: nothing written
 *     (`paused`). A real save while paused DOES set up (row, stamp, walk):
 *     the walk only queues, the drain is not kicked while paused (its own
 *     token read honours the pause too), the poll skips a paused platform
 *     and Sync refuses one, so nothing reaches the platform until the pause
 *     lifts, and nothing is left for a later pass to set up;
 *   - no real save on a TESTING deployment (dev, previews; the testing flag
 *     is set): nothing written (`testOff`). There a login re-asserting a
 *     suite account's sign-in must never start listing, row or no row; only
 *     an explicit save (the product's, or the seed asking for listing) does;
 *   - held off, writing nothing, by the E2E test marker unless this is a
 *     real save, which clears it (`testOff`);
 *   - a row dormant on a seller conflict stays so, writing nothing, unless
 *     this is a real save, which checks again (`sellerConflict`): a token
 *     refresh never restarts a walk the drain would only refuse again;
 *   - refused, writing nothing, with no saved sign-in (`notConnected`);
 *   - a seller account another NB owner LISTS from now (`sellerAccountHolder`
 *     counts only active holders): the row is made (or kept) dormant
 *     `sellerConflict`, nothing queued, and the account is NOT stamped on it,
 *     so a conflicted row never holds the account against anyone (one NB
 *     owner per seller account, the account the owner's last sign-in
 *     captured when known; the drainer checks again before its first push);
 *   - otherwise the row is made (or woken: dormancy cleared, the re-sign-in
 *     poll limit reset, the marker cleared on a real save),
 *     `listingStartedAt` stamped NOW, and one walk scheduled that queues
 *     every card in the owner's listed boxes and then runs the drain
 *     (`startListingWalk`). The stamp names the walk, so a walk from an
 *     earlier save (removed and saved again within the walk) stands down.
 */
export async function setUpListing(
  ctx: MutationCtx,
  ownerId: string,
  platform: ListingPlatform,
  opts: { save: boolean },
): Promise<ListingSetup> {
  if (!opts.save && isPlatformPaused(LISTING_CREDENTIAL_SITE[platform])) return "paused";
  if (!opts.save && process.env.TESTING_RESET_SECRET) return "testOff";
  const state = await listingStateOf(ctx, ownerId, platform);
  if (state && pushesCounts(state)) return "listing";
  if (state?.testListingOff === true && !opts.save) return "testOff";
  if (state?.dormant === "sellerConflict" && !opts.save) return "sellerConflict";
  const credential = await listingCredentialOf(ctx, ownerId, platform);
  if (!credential.hasCredentials) return "notConnected";
  const now = Date.now();
  // Only a real save reaches here with the marker set (see above).
  const clearMarker = state?.testListingOff !== undefined ? { testListingOff: undefined } : {};
  const accountId = credential.sellerId ?? state?.platformAccountId ?? null;
  if (accountId !== null && (await sellerAccountHolder(ctx, platform, accountId, ownerId))) {
    // Already held back, stamp and marker clear: nothing to write.
    if (
      state?.dormant === "sellerConflict" &&
      state.listingStartedAt === undefined &&
      !("testListingOff" in clearMarker)
    ) {
      return "sellerConflict";
    }
    // No `platformAccountId` here: only a row that lists holds the account.
    const held = {
      dormant: "sellerConflict" as const,
      listingStartedAt: undefined,
      ...clearMarker,
      lastUpdated: now,
    };
    if (state) await ctx.db.patch(state._id, held);
    else await ctx.db.insert("marketplaceListingStates", { ownerId, platform, ...held });
    return "sellerConflict";
  }
  const on = {
    listingStartedAt: now,
    dormant: undefined,
    reauthPollAt: undefined,
    ...(accountId !== null ? { platformAccountId: accountId } : {}),
    ...clearMarker,
    lastUpdated: now,
  };
  if (state) await ctx.db.patch(state._id, on);
  else await ctx.db.insert("marketplaceListingStates", { ownerId, platform, ...on });
  await ctx.scheduler.runAfter(0, internal.listingSync.startListingWalk, { ownerId, platform, startedAt: now });
  return "started";
}

/**
 * The E2E test marker, set: the testing seed signed this account in without
 * asking for listing (`testing.seedMyTestCredentials`, `listing` false), so
 * nothing is pushed or polled for it. Makes the row when there is none (so a
 * sign-in found by the cron is never set up), stops a listing already under
 * way (stamp cleared, queue dropped) and writes nothing more.
 *
 * Testing deployments only: refuses (throws) where the testing flag is unset,
 * so production can never write it. Called only by the testing seed's
 * credential write (`userProfile.updateSiteCredentialStatus` with
 * `listing: "testOff"`).
 */
export async function holdTestListingOff(ctx: MutationCtx, ownerId: string, platform: ListingPlatform): Promise<void> {
  if (!process.env.TESTING_RESET_SECRET) {
    throw new Error("The listing test marker is not enabled on this deployment");
  }
  const state = await listingStateOf(ctx, ownerId, platform);
  const now = Date.now();
  if (!state) {
    await ctx.db.insert("marketplaceListingStates", { ownerId, platform, testListingOff: true, lastUpdated: now });
    return;
  }
  if (state.testListingOff !== true || state.listingStartedAt !== undefined || state.drainRequested !== undefined) {
    await ctx.db.patch(state._id, {
      testListingOff: true,
      listingStartedAt: undefined,
      drainRequested: undefined,
      lastUpdated: now,
    });
  }
  await clearListingOutbox(ctx, ownerId, platform);
}

/**
 * The walk a saved sign-in starts: reads the owner's listed boxes once and
 * hands them to `queueBoxesPage`, whose last page runs the drain. Stands down
 * when the owner no longer lists there, or a later save restamped the row
 * (`startedAt` is the stamp this walk was started with).
 */
export const startListingWalk = internalMutation({
  args: { ownerId: v.string(), platform: listingPlatformValidator, startedAt: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const state = await listingStateOf(ctx, args.ownerId, args.platform);
    if (!state || !pushesCounts(state) || state.listingStartedAt !== args.startedAt) return null;
    const boxIds = await listedBoxIdsOf(ctx, args.ownerId);
    if (boxIds.length === 0) return null;
    await ctx.scheduler.runAfter(0, internal.listingSync.queueBoxesPage, {
      ownerId: args.ownerId,
      platform: args.platform,
      startedAt: args.startedAt,
      boxIds,
      index: 0,
      cursor: null,
    });
    return null;
  },
});

/** Profiles one page of the saved-sign-in pass reads. */
export const SIGN_IN_SCAN_PAGE = 50;

/** The `listingBackfillState` key the saved-sign-in pass records itself done under. */
export const SAVED_SIGN_INS_PASS_KEY = "savedSignInsSetUp";

/** Whether the saved-sign-in pass has finished for good (`listingBackfillState`). One indexed read. */
export async function savedSignInsPassDone(ctx: Pick<QueryCtx, "db">): Promise<boolean> {
  const row = await ctx.db
    .query("listingBackfillState")
    .withIndex("by_key", (q) => q.eq("key", SAVED_SIGN_INS_PASS_KEY))
    .first();
  return row !== null;
}

/**
 * Sign-ins saved before Revision 5 have no state row (saving never made one
 * then), so nothing would ever list them. Since Revision 5 every save sets
 * itself up (even while the platform is paused, `setUpListing`), so this is
 * a one-time backfill: the order-poll cron (`listingSales.pollAll`) starts a
 * pass while it is not done. A page of `SIGN_IN_SCAN_PAGE` profiles, each
 * with a saved sign-in for a listing platform's site that is not set up yet
 * (no row, or a row that is neither listing, nor held off by the test
 * marker, nor a seller conflict) is set up as a login re-asserting it would
 * (`setUpListing` with `save` false: never clears the marker or re-checks a
 * seller conflict), then the next page on the scheduler. Each page is one
 * bounded transaction: the profiles, one state read each, and for the few
 * not set up a setup (a handful of reads and one scheduled walk).
 *
 * Self-ending: the pass's last page records it done (`listingBackfillState`)
 * when no page deferred a sign-in (one found while the platform was paused,
 * `deferred`), and the cron never starts it again. A pass that deferred one
 * is simply run again on a later tick (the cron starts none while paused).
 *
 * Not run on a testing deployment (dev, previews): there the suite's accounts
 * keep sign-ins saved between runs, and only the seed decides whether they
 * list (`testListingOff`).
 */
export const setUpSavedSignInsPage = internalMutation({
  args: {
    cursor: v.union(v.string(), v.null()),
    /** Sign-ins earlier pages of this pass could not set up (paused). */
    deferred: v.optional(v.number()),
  },
  returns: v.object({ started: v.number(), deferred: v.number(), done: v.boolean() }),
  handler: async (ctx, args) => {
    if (process.env.TESTING_RESET_SECRET) return { started: 0, deferred: 0, done: false };
    if (await savedSignInsPassDone(ctx)) return { started: 0, deferred: 0, done: true };
    const page = await ctx.db.query("userProfiles").paginate({ numItems: SIGN_IN_SCAN_PAGE, cursor: args.cursor });
    let started = 0;
    let deferred = args.deferred ?? 0;
    for (const profile of page.page) {
      for (const platform of LISTING_PLATFORMS) {
        const saved = profile.siteCredentials?.some(
          (c) => c.site === LISTING_CREDENTIAL_SITE[platform] && c.hasCredentials === true,
        );
        if (!saved) continue;
        const state = await listingStateOf(ctx, profile.userId, platform);
        const setUp =
          state !== null &&
          (pushesCounts(state) || state.testListingOff === true || state.dormant === "sellerConflict");
        if (setUp) continue;
        const outcome = await setUpListing(ctx, profile.userId, platform, { save: false });
        if (outcome === "started") started += 1;
        else if (outcome === "paused") deferred += 1;
      }
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.listingSync.setUpSavedSignInsPage, {
        cursor: page.continueCursor,
        deferred,
      });
      return { started, deferred, done: false };
    }
    if (deferred > 0) return { started, deferred, done: false };
    await ctx.db.insert("listingBackfillState", { key: SAVED_SIGN_INS_PASS_KEY, doneAt: Date.now() });
    return { started, deferred, done: true };
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

/**
 * The platforms whose state row lists (`pushesCounts`): where a box flip
 * queues. A paused platform is included: its queue waits for the pause to
 * lift, and the drain itself honours the pause. Sync leaves a paused one out.
 */
async function listingPlatformsOf(ctx: QueryCtx, ownerId: string): Promise<ListingPlatform[]> {
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
  if ((await listingPlatformsOf(ctx, ownerId)).length === 0) return false;
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
 * the owner lists on, then the next page on the scheduler; the last page
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
    const platforms = await listingPlatformsOf(ctx, args.ownerId);
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
 * The walk a saved sign-in starts (`startListingWalk`), over boxes: one page
 * of one box's copies, queued for `platform`, then the next page (or the
 * next box) on the scheduler. Its last page runs the drain (the owner's first
 * sync). Stands down as soon as the owner no longer lists on the platform,
 * or a later save restamped the row (`startedAt`). (A box flip walks
 * `queueListedBoxPage`.)
 */
export const queueBoxesPage = internalMutation({
  args: {
    ownerId: v.string(),
    platform: listingPlatformValidator,
    /** The `listingStartedAt` this walk was started with. */
    startedAt: v.number(),
    boxIds: v.array(v.id("collectionContainers")),
    index: v.number(),
    cursor: v.union(v.string(), v.null()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const state = await listingStateOf(ctx, args.ownerId, args.platform);
    if (!state || !pushesCounts(state) || state.listingStartedAt !== args.startedAt) return null;
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
    } else if (!isPlatformPaused(LISTING_CREDENTIAL_SITE[args.platform])) {
      // Paused (a save while NB paused the platform): the cards wait queued;
      // the cron's first poll after the pause lifts kicks the drain.
      await kickListingDrain(ctx, args.ownerId, args.platform);
    }
    return null;
  },
});

/**
 * One more page of the stop-listing sweep (`listingOutbox.clearListingOutbox`,
 * run when the sign-in is removed or the test marker is set). Stands down
 * once the owner lists on the platform again: the walk a fresh save starts
 * owns the queue from then on.
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
 * Answers `ignored: "notListing"` (and writes nothing) when the collector
 * has no saved sign-in on a platform NB has not paused. A press within
 * `RESYNC_THROTTLE_MS` of the last press is dropped on that platform: the run
 * it asked for reads the set in full. A first press on a never-synced variant
 * has no record to stamp, so a second press within the minute can run one more
 * full read, after which the stamp holds. A press while the variant's run is under
 * way is taken: that run claimed before the press, so what it reads is fixed,
 * and the queued cards and the stamp send the set round again in full once it
 * releases. `queued` is true when at least one platform
 * took the press (queued work, or kicked a drain for a change already queued);
 * `ignored: "throttled"` only when every listing platform dropped it.
 * `queued: false` with no reason: nothing to sync here (the set has no card
 * any listing platform can list, or the collector holds no copy of it and
 * never synced it).
 */
export const syncVariant = mutation({
  args: { variantId: v.id("selectorOptions") },
  returns: v.object({
    queued: v.boolean(),
    ignored: v.optional(v.union(v.literal("throttled"), v.literal("notListing"))),
  }),
  handler: async (ctx, args) => {
    const ownerId = await requireSignedIn(ctx);
    const platforms = (await listingPlatformsOf(ctx, ownerId)).filter(platformReachable);
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
    if (record.resyncRequestedAt !== undefined && now - record.resyncRequestedAt < RESYNC_THROTTLE_MS) return "throttled";
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
  // A run under way claimed before this press, so it keeps what it reads. The
  // re-queued rows outlive its finish (their `seq` moved), the kick asks it to
  // run again on release, and the stamp is later than its `lastRunAt`, so that
  // next run reads the set in full.
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

/**
 * NEO-415 — one step of a set's run, in run order, as the tab ticks it off.
 * NB vocabulary only (the web writes the label from `kind` and NB's
 * condition names). `conditions` is every NB condition a read or confirm
 * covers (BSC folds Mint and Near Mint into one modern sheet), `condition`
 * its first; a read or confirm with neither covers the sheets NB lists
 * nothing under.
 */
const syncStepValidator = v.object({
  kind: listingSyncStepKindValidator,
  condition: v.optional(collectionCopyConditionValidator),
  conditions: v.optional(v.array(collectionCopyConditionValidator)),
  status: listingSyncStepStatusValidator,
});
type SyncStep = typeof syncStepValidator.type;

/**
 * A record's steps as the tab shows them (no extra reads: the ledger rides on
 * the record). A run that died holding its lease reads as finished: what it
 * was working on failed, what it never reached is dropped.
 */
function stepsOf(record: Doc<"marketplaceListingSyncs">, died: boolean): SyncStep[] {
  const out: SyncStep[] = [];
  for (const s of record.progress?.steps ?? []) {
    if (died && s.status === "waiting") continue;
    out.push({
      kind: s.kind,
      ...(s.condition !== undefined ? { condition: s.condition } : {}),
      ...(s.conditions !== undefined ? { conditions: s.conditions } : {}),
      status: died && s.status === "working" ? "failed" : s.status,
    });
  }
  return out;
}

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
      /** NEO-415: the running set's steps so far, in run order (empty until its plan is written). */
      steps: v.array(syncStepValidator),
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
      /** NEO-415: this set's run, in order: the one running now, else the last one. */
      steps: v.array(syncStepValidator),
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
      steps: runningRecord ? stepsOf(runningRecord, false) : [],
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
      steps: stepsOf(r, r.status === "running" && !live(r)),
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

/** What the admin screen calls a collector with no public profile name. */
export const UNNAMED_COLLECTOR = "Collector without a name";

/**
 * A collector as the admin screen names them: their public display name, else
 * @username (`named`), else "Collector without a name" with the id's last six
 * characters, so two such collectors still read apart. Never the raw sign-in
 * id. The page asks Clerk for the unnamed ones' names
 * (`adminUsers.adminResolveOwnerLabels`): NB keeps no other copy of a name.
 */
async function ownerLabel(ctx: QueryCtx, ownerId: string): Promise<{ label: string; named: boolean }> {
  const profile = await ctx.db
    .query("publicProfiles")
    .withIndex("by_user", (q) => q.eq("userId", ownerId))
    .first();
  const display = profile?.displayName?.trim();
  if (display) return { label: display, named: true };
  if (profile?.username) return { label: `@${profile.username}`, named: true };
  return { label: `${UNNAMED_COLLECTOR} (…${ownerId.slice(-6)})`, named: false };
}

/** An owner as the admin functions return them. */
const adminOwnerFields = { ownerId: v.string(), label: v.string(), named: v.boolean() };

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
  returns: v.array(v.object(adminOwnerFields)),
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const { ownerIds } = await listingOwners(ctx, ADMIN_OWNER_LIST);
    const out = [];
    for (const ownerId of ownerIds) out.push({ ownerId, ...(await ownerLabel(ctx, ownerId)) });
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
    owners: v.array(v.object({ ...adminOwnerFields, status: syncStatusValidator })),
    more: v.boolean(),
  }),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    if (args.ownerId !== undefined) {
      return {
        owners: [
          {
            ownerId: args.ownerId,
            ...(await ownerLabel(ctx, args.ownerId)),
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
        ...(await ownerLabel(ctx, ownerId)),
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
