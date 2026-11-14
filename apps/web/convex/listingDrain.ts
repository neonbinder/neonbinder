/**
 * NEO-370 — the per-owner listing drainer: pushes a collector's changed
 * for-sale counts to a listing platform. BuySportsCards only today.
 *
 * NB is the only truth. A box-side write (`collection.applyCopyChanges` and
 * its hook) upserts one `listingOutbox` row per (owner, platform, card); it
 * schedules nothing. `drainOwner` runs when something kicks it
 * (`listingOutbox.kickListingDrain`): a Sync press (`listingSync.syncVariant`),
 * an intake run the collector closed with "Done adding photos" once it
 * settles, the end of the walk a saved sign-in starts, and the 15-minute cron after each
 * owner's order poll. Only copies in a LISTED box count
 * (`listingOutbox.listsOnMarketplaces`); an in-person box counts 0.
 * This drainer:
 *
 *   1. CLAIMS the owner's state row (a lease, written once on claim and once
 *      on release; the hook reads this row on every box write) and clears
 *      `drainScheduledAt`. The claim is the credential gate: no saved
 *      credentials puts the state to sleep (`dormant`), and a session that
 *      needs a fresh sign-in is not logged into (the hourly order poll is
 *      what retries it). NEO-483: on BSC it is also the seller-account gate:
 *      with no seller account stored, nothing runs until the background read
 *      (`bscSellerId`) lands one and kicks the drain again.
 *   2. Walks the outbox one VARIANT at a time (BSC is a by-set platform):
 *      snapshots the variant's rows and their `seq`, re-reads each card's
 *      current variant (a moved card's row is re-pointed, a deleted card's is
 *      cleared), claims the variant's `marketplaceListingSyncs` row, gathers
 *      the owner's copies and the variant's cards, reads BSC's seller sheet
 *      for every condition that matters, plans with `planBscSheet`, uploads
 *      seller photos, PUTs the changed rows, reads the changed conditions back
 *      to confirm, then writes the sync record and deletes the rows whose
 *      `seq` did not move. NEO-415: each of those steps (one read per
 *      condition sheet, photos, the send, one confirm per condition sent) is
 *      ticked off on the sync record as it lands (`ProgressLedger`).
 *   3. Stops after a time budget and reschedules itself at once when work
 *      remains, or when a kick landed while it ran (`drainRequested`).
 *      Otherwise rows that land after it wait for the next kick.
 *
 * Errors are per variant: one bad variant is recorded on its own sync record
 * and the drain moves on. A sign-in BSC refuses even after a refresh stops
 * the whole drain (every later call would fail the same way).
 *
 * Product invariant: a BSC row is matched to an NB card ONLY through the
 * card's own `platformData.bsc.ref` (`planBscSheet`); the BSC query is built
 * from slot ids (`resolveBscFacetFilters`), never an NB display value.
 */
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { ActionCtx, MutationCtx, QueryCtx } from "./_generated/server";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { listingPlatformValidator, listingProblemReasonValidator, listingSyncStepValidator } from "./schema";
import {
  kickListingDrain,
  listingCredentialOf,
  listsOnMarketplaces,
  newToken,
  pushesCounts,
  scheduleLinkedDrain,
  sellerAccountHolder,
} from "./listingOutbox";
import { ebayConfigured } from "./lib/ebayEnv";
import { ebaySetupMissing } from "./lib/ebayListing";
import { drainEbayOwnerImpl } from "./listingDrainEbay";
import { copyPhotoObjectKey, MAX_COPY_PHOTO_BYTES } from "./copyPhotos";
import { planBscFanOut, resolveBscFacetFilters } from "./bscFacets";
import { resolvableSides, type ResolvableRow } from "./marketplaceResolvability";
import { r2Config } from "./lib/r2";
import { commonPriceCentsOf } from "./listingGate";
import {
  bscConditionsForEra,
  bscEraForYear,
  isBscConditionOfEra,
  nbConditionsFor,
  type BscEra,
  type NbCondition,
} from "./lib/bscConditions";
import {
  foldBscTargets,
  joinNarrowedSheets,
  photoKeyFor,
  planBscSheet,
  rowNeedsSellerPhoto,
  type BscPhotoKeys,
  type BscSheetPlan,
  type BscSheetRow,
  type NarrowedBscSheet,
  type BscTarget,
  type ListingCopy,
  type ListingProblem,
  type NbVariantCard,
  type PlannedBscPut,
} from "./lib/bscSheetPlan";
import { ensureBscSellerIdFetch } from "./bscSellerId";
import {
  closeBscSellerSession,
  isBscSellerId,
  openBscSellerSession,
  putBscListings,
  readBscSellerSheet,
  uploadBscSellerPhoto,
  type BscSellerFailure,
  type BscSellerResult,
  type BscSellerSession,
} from "./adapters/bscSeller";
import type { BscWaitEdge } from "./lib/bscCallTelemetry";

// ── Limits ─────────────────────────────────────────────────────────────────

/** How long one drain run may start new variants for (actions stop at 10 min). */
export const DRAIN_BUDGET_MS = 4 * 60 * 1000;
/** The owner lease: past the longest action, so a live run is never stolen. */
export const DRAIN_LEASE_MS = 12 * 60 * 1000;
/** A variant's lease on its sync record (the same reasoning). */
export const VARIANT_LEASE_MS = 12 * 60 * 1000;
/**
 * NEO-475 — the waits before a 503'd sheet read is tried again, shared by the
 * whole `readSheets` call (two retries at most, in this order). BSC's gateway
 * answers 503 after ~30 s while its seller API is cold, mostly on a session's
 * first read, and can take minutes to warm. Kept short on purpose (Jason):
 * the drain runs again on the next kick.
 */
export const BSC_SHEET_RETRY_PAUSES_MS: readonly number[] = [10_000, 30_000];
/** NEO-433: how often `watchDrainRun` reads the platform's record of a held run. */
export const DRAIN_WATCH_TICK_MS = 30 * 1000;
/**
 * NEO-433: how long a dead run's lease stands. A call the run had in flight can
 * still land after the run is gone, and a second writer beside it can create
 * duplicate seller rows, so the next run waits out the longest single call: 90 s
 * (`BSC_SELLER_TIMEOUTS_MS.sheet`/`.put`, `EBAY_TIMEOUTS_MS.bulk`) plus 10 s.
 */
export const DRAIN_DEATH_GRACE_MS = 100 * 1000;
/** Newest sync records searched for a dead run's running one (it holds the owner's latest `lastRunAt`). */
const DEAD_RUN_RECORD_SCAN = 20;
/** Next run when this one ran out of budget, or a kick landed while it ran. */
export const DRAIN_CONTINUE_MS = 1000;
/** Outbox rows one variant pass snapshots; more wait for the next run. */
export const MAX_OUTBOX_ROWS_PER_PASS = 1000;
/** Cards / copies one page query returns. */
export const CARD_PAGE_SIZE = 500;
export const COPY_PAGE_SIZE = 500;
/** Seller photo sides one variant uploads per run (the rest go next time). */
export const MAX_PHOTO_UPLOADS_PER_VARIANT = 40;
/** The sync record keeps at most this many problems (`problemsTotal` is exact). */
export const MAX_STORED_PROBLEMS = 200;
/**
 * NEO-481 — BSC runs that may try one card's photo refresh before the drain
 * gives up on it: the flag is dropped and a listing problem says so.
 */
export const MAX_PHOTO_REFRESH_ATTEMPTS = 5;
/** The problem a refresh that gave up leaves on the Sync status tab. */
export const PHOTO_REFRESH_GAVE_UP_DETAIL =
  "NeonBinder couldn't send this card's new photo after several tries. Edit or replace the photo to try again.";
const MAX_DETAIL = 160;
const MAX_ERROR = 300;

type Platform = Doc<"listingOutbox">["platform"];
export type StoredProblem = Doc<"marketplaceListingSyncs">["problems"][number];
type StoredReason = typeof listingProblemReasonValidator.type;

// ── Owner lease ────────────────────────────────────────────────────────────

export { newToken };

const fullVariantIdsValidator = v.optional(v.array(v.id("selectorOptions")));

/** NEO-415 — the sentence a variant held back by unfinished eBay settings shows. */
export const EBAY_SETUP_INCOMPLETE_ERROR =
  "Finish your eBay setup (shipping, payment, returns and ship-from) in Profile → Credentials → eBay, and these cards go up.";
/** Variants one refused claim marks (the rest are marked by later kicks). */
const SETUP_MARK_VARIANTS = 10;

/**
 * Marks the first few variants waiting on eBay as held back by unfinished
 * settings, so the Sync status tab says why nothing moved. Writes only a
 * record that does not already say so.
 */
async function markSetupIncomplete(ctx: MutationCtx, ownerId: string, now: number): Promise<void> {
  const rows = await ctx.db
    .query("listingOutbox")
    .withIndex("by_owner_platform_variant", (q) => q.eq("ownerId", ownerId).eq("platform", "ebay"))
    .take(200);
  const variants = [...new Set(rows.map((r) => r.variantId))].slice(0, SETUP_MARK_VARIANTS);
  for (const variantId of variants) {
    const record = await ctx.db
      .query("marketplaceListingSyncs")
      .withIndex("by_owner_variant_platform", (q) =>
        q.eq("ownerId", ownerId).eq("variantId", variantId).eq("platform", "ebay"),
      )
      .unique();
    const marked = {
      status: "error" as const,
      lastRunAt: now,
      lastError: EBAY_SETUP_INCOMPLETE_ERROR,
      problems: [{ reason: "setupIncomplete" as const }],
      problemsTotal: 1,
      lastUpdated: now,
    };
    if (!record) {
      await ctx.db.insert("marketplaceListingSyncs", {
        ownerId,
        variantId,
        platform: "ebay",
        conditionsPushed: [],
        ...marked,
      });
    } else if (record.status !== "running" && record.lastError !== EBAY_SETUP_INCOMPLETE_ERROR) {
      // No run happened: the last run's steps would read as this one's.
      await ctx.db.patch(record._id, { ...marked, progress: undefined });
    }
  }
}

/**
 * Claims the owner's drain, and is the drain's gate:
 *   - no state row, a row not listing (`pushesCounts`: the stamp cleared, a
 *     dormant row, the E2E test marker): `off`;
 *   - no saved credentials for the platform: listing stops as it does when
 *     the sign-in is removed (`noCredentials` dormancy, no poll and no drain
 *     until it is saved again, and the stamp cleared; saving again starts
 *     it again);
 *   - credentials that need a fresh sign-in: `needsReauth`, nothing
 *     written (the hourly order poll retries the sign-in; a drain never does);
 *   - NEO-483, BuySportsCards: no seller account stored for the owner
 *     (`storedBscSellerId`): `awaitingSeller`. The queue waits, the spaced
 *     background read is armed at once (`ensureBscSellerIdFetch`, a no-op
 *     while one is in flight), and the account landing kicks the drain
 *     (`bscSellerId.landBscSellerId`). The drain never reads it live, so a
 *     BSC profile stall can no longer fail a set's send. A claim is never a
 *     user action (the poll, a scheduled drain, a kick): it arms without
 *     `userAction`, so an ended chain's cooldown stands (`coolingDown`) and
 *     the claim still answers `awaitingSeller`. The collector's Sync press
 *     arms with `userAction` itself, before its kick
 *     (`listingSync.syncVariant`);
 *   - another run's live lease: `busy`, and that run is asked to run once
 *     more on release (`drainRequested`).
 * A claim clears `drainScheduledAt` and `drainRequested`. NEO-433: it also
 * spends the kick's link. The run holding the kick's token is the run the
 * function id names, so the watcher starts on that id; any other run (a stale
 * kick, a retry) has no signal and simply gets the 12-minute lease.
 */
export const claimDrain = internalMutation({
  args: {
    ownerId: v.string(),
    platform: listingPlatformValidator,
    leaseToken: v.string(),
    fullVariantIds: fullVariantIdsValidator,
    kickToken: v.optional(v.string()),
  },
  returns: v.union(
    v.object({ claimed: v.literal(true) }),
    v.object({
      claimed: v.literal(false),
      reason: v.union(
        v.literal("off"),
        v.literal("busy"),
        v.literal("noCredentials"),
        v.literal("needsReauth"),
        v.literal("setupIncomplete"),
        v.literal("awaitingSeller"),
      ),
    }),
  ),
  handler: async (ctx, args) => {
    const now = Date.now();
    const state = await ctx.db
      .query("marketplaceListingStates")
      .withIndex("by_owner_platform", (q) => q.eq("ownerId", args.ownerId).eq("platform", args.platform))
      .unique();
    if (!state || !pushesCounts(state)) {
      if (state?.drainScheduledAt !== undefined) {
        await ctx.db.patch(state._id, { drainScheduledAt: undefined, drainRequested: undefined, lastUpdated: now });
      }
      return { claimed: false as const, reason: "off" as const };
    }
    const credential = await listingCredentialOf(ctx, args.ownerId, args.platform);
    if (!credential.hasCredentials) {
      await ctx.db.patch(state._id, {
        dormant: "noCredentials",
        listingStartedAt: undefined,
        drainScheduledAt: undefined,
        drainRequested: undefined,
        lastUpdated: now,
      });
      return { claimed: false as const, reason: "noCredentials" as const };
    }
    if (credential.needsReauth) {
      if (state.drainScheduledAt !== undefined || state.drainRequested !== undefined) {
        await ctx.db.patch(state._id, { drainScheduledAt: undefined, drainRequested: undefined, lastUpdated: now });
      }
      return { claimed: false as const, reason: "needsReauth" as const };
    }
    if (args.platform === "bsc" && storedBscSellerId(credential.sellerId) === null) {
      // NEO-483: nothing is sent without the seller account a PUT names. The
      // queue waits; the read that fetches the account starts now (or is
      // already running, or is cooling down after an ended chain), and its
      // landing kicks the drain again.
      if (state.drainScheduledAt !== undefined || state.drainRequested !== undefined) {
        await ctx.db.patch(state._id, { drainScheduledAt: undefined, drainRequested: undefined, lastUpdated: now });
      }
      await ensureBscSellerIdFetch(ctx, args.ownerId, { firstDelayMs: 0 });
      return { claimed: false as const, reason: "awaitingSeller" as const };
    }
    if (args.platform === "ebay") {
      // NEO-415: a deployment not wired to eBay drains nothing (quietly).
      if (!ebayConfigured()) {
        if (state.drainScheduledAt !== undefined || state.drainRequested !== undefined) {
          await ctx.db.patch(state._id, { drainScheduledAt: undefined, drainRequested: undefined, lastUpdated: now });
        }
        return { claimed: false as const, reason: "off" as const };
      }
      // Nothing reaches eBay half-configured: the collector's shipping,
      // payment, returns and ship-from must all be set first. The queue
      // waits; saving the settings kicks the drain (`ebayConnect`).
      const settings = await ctx.db
        .query("ebaySellerSettings")
        .withIndex("by_owner", (q) => q.eq("ownerId", args.ownerId))
        .unique();
      if (ebaySetupMissing(settings).length > 0) {
        await markSetupIncomplete(ctx, args.ownerId, now);
        if (state.drainScheduledAt !== undefined || state.drainRequested !== undefined) {
          await ctx.db.patch(state._id, { drainScheduledAt: undefined, drainRequested: undefined, lastUpdated: now });
        }
        return { claimed: false as const, reason: "setupIncomplete" as const };
      }
    }
    if (state.drainLeaseToken !== undefined && (state.drainLeaseExpiresAt ?? 0) > now) {
      // Drop the latch that scheduled this run and ask the live run to run
      // once more when it releases, so whatever this run was kicked for is
      // not left for the cron. A run that dies holding its lease is picked
      // up by the cron (`listingSales.finishPoll`) once the lease runs out.
      // A full re-read asked of this run cannot ride on the live one, so it alone is
      // retried when that lease runs out.
      if (args.fullVariantIds && args.fullVariantIds.length > 0) {
        await ctx.scheduler.runAt((state.drainLeaseExpiresAt ?? now) + 1000, internal.listingDrain.drainOwner, {
          ownerId: args.ownerId,
          platform: args.platform,
          fullVariantIds: args.fullVariantIds,
        });
      }
      await ctx.db.patch(state._id, { drainScheduledAt: undefined, drainRequested: true, lastUpdated: now });
      return { claimed: false as const, reason: "busy" as const };
    }
    await ctx.db.patch(state._id, {
      drainScheduledAt: undefined,
      drainRequested: undefined,
      drainLeaseToken: args.leaseToken,
      drainLeaseExpiresAt: now + DRAIN_LEASE_MS,
      drainRunDeadAt: undefined,
      drainKickToken: undefined,
      drainKickFnId: undefined,
      lastUpdated: now,
    });
    if (args.kickToken !== undefined && args.kickToken === state.drainKickToken && state.drainKickFnId !== undefined) {
      await ctx.scheduler.runAfter(DRAIN_WATCH_TICK_MS, internal.listingDrain.watchDrainRun, {
        ownerId: args.ownerId,
        platform: args.platform,
        leaseToken: args.leaseToken,
        fnId: state.drainKickFnId,
      });
    }
    return { claimed: true as const };
  },
});

/**
 * Releases the owner's drain (only the run holding `leaseToken` may) and runs
 * the next one at once (`DRAIN_CONTINUE_MS`) when outbox rows remain or full
 * re-reads were left over AND either this run ran out of budget
 * (`next: "continue"`) or a kick landed while it ran (`drainRequested`). A
 * run that stopped on a sign-in or pause failure (`next: "stop"`) schedules
 * nothing: the cron's next kick tries again. No timer otherwise: rows wait
 * for the next kick. `drainScheduledAt` is stamped with NOW (when it was
 * scheduled), the kick's own convention (`listingOutbox.kickListingDrain`: a
 * stamp under 10 minutes old is a live latch).
 */
export const releaseDrain = internalMutation({
  args: {
    ownerId: v.string(),
    platform: listingPlatformValidator,
    leaseToken: v.string(),
    next: v.union(v.literal("continue"), v.literal("done"), v.literal("stop")),
    leftoverFullVariantIds: fullVariantIdsValidator,
  },
  returns: v.object({ released: v.boolean(), scheduledInMs: v.union(v.number(), v.null()) }),
  handler: async (ctx, args) => {
    const now = Date.now();
    const state = await ctx.db
      .query("marketplaceListingStates")
      .withIndex("by_owner_platform", (q) => q.eq("ownerId", args.ownerId).eq("platform", args.platform))
      .unique();
    if (!state || state.drainLeaseToken !== args.leaseToken) return { released: false, scheduledInMs: null };
    const pending = await ctx.db
      .query("listingOutbox")
      .withIndex("by_owner_platform_variant", (q) => q.eq("ownerId", args.ownerId).eq("platform", args.platform))
      .first();
    const leftover = args.leftoverFullVariantIds ?? [];
    let scheduledInMs: number | null = null;
    const patch: Partial<Doc<"marketplaceListingStates">> = {
      drainLeaseToken: undefined,
      drainLeaseExpiresAt: undefined,
      drainRequested: undefined,
      drainRunDeadAt: undefined,
      lastDrainAt: now,
      lastUpdated: now,
    };
    const again =
      args.next === "continue" || (args.next === "done" && state.drainRequested === true);
    if (
      again &&
      pushesCounts(state) &&
      (pending !== null || leftover.length > 0) &&
      state.drainScheduledAt === undefined
    ) {
      scheduledInMs = DRAIN_CONTINUE_MS;
      const link = await scheduleLinkedDrain(ctx, {
        ownerId: args.ownerId,
        platform: args.platform,
        delayMs: scheduledInMs,
        fullVariantIds: leftover,
      });
      Object.assign(patch, link);
      patch.drainScheduledAt = now;
    }
    await ctx.db.patch(state._id, patch);
    return { released: true, scheduledInMs };
  },
});

/**
 * NEO-433 — a run the platform killed releases nothing. `watchDrainRun` reads
 * the platform's own record of the function that claimed the lease, every
 * `DRAIN_WATCH_TICK_MS` while that lease is held:
 *   - released, reclaimed or the lease run out: the watch ends. At 12 minutes a
 *     held run is left to today's rule (the next claim takes the lease);
 *   - `failed`, or `success` with the lease still held: the run is over and
 *     never released. The lease shortens to the death plus the grace, and its
 *     running sync record settles now, so an open status page flips by itself
 *     (a query does not re-run as time passes; this write is what moves it);
 *   - anything else, a missing record and `canceled` included, is NOT death: a
 *     live slow run must never be reclaimed, since two runs writing to BSC at
 *     once can create duplicate seller rows.
 * When the grace is up the lease clears, and a drain runs only if a kick asked
 * for one meanwhile (`drainRequested`): no retry on its own, or a run that keeps
 * getting killed would loop. Outbox rows are never touched; the next run takes them.
 *
 * `graceMs` and `tickMs` are for `testing.seedMyTestKilledDrain` alone.
 */
export const watchDrainRun = internalMutation({
  args: {
    ownerId: v.string(),
    platform: listingPlatformValidator,
    leaseToken: v.string(),
    fnId: v.id("_scheduled_functions"),
    graceMs: v.optional(v.number()),
    tickMs: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const state = await ctx.db
      .query("marketplaceListingStates")
      .withIndex("by_owner_platform", (q) => q.eq("ownerId", args.ownerId).eq("platform", args.platform))
      .unique();
    if (!state || state.drainLeaseToken !== args.leaseToken) return null;
    const expiresAt = state.drainLeaseExpiresAt ?? 0;
    if (state.drainRunDeadAt !== undefined) {
      if (expiresAt > now) {
        await ctx.scheduler.runAt(expiresAt, internal.listingDrain.watchDrainRun, args);
        return null;
      }
      await ctx.db.patch(state._id, {
        drainLeaseToken: undefined,
        drainLeaseExpiresAt: undefined,
        drainRunDeadAt: undefined,
        drainRequested: undefined,
        lastUpdated: now,
      });
      if (state.drainRequested === true) await kickListingDrain(ctx, args.ownerId, args.platform);
      return null;
    }
    if (expiresAt <= now) return null;
    const run = await ctx.db.system.get(args.fnId);
    if (!run || (run.state.kind !== "failed" && run.state.kind !== "success")) {
      await ctx.scheduler.runAfter(args.tickMs ?? DRAIN_WATCH_TICK_MS, internal.listingDrain.watchDrainRun, args);
      return null;
    }
    const deadAt = run.completedTime ?? now;
    const graceEnd = Math.min(expiresAt, deadAt + (args.graceMs ?? DRAIN_DEATH_GRACE_MS));
    await ctx.db.patch(state._id, { drainRunDeadAt: deadAt, drainLeaseExpiresAt: graceEnd, lastUpdated: now });
    await settleDeadRunRecord(ctx, args, now);
    await ctx.scheduler.runAt(graceEnd, internal.listingDrain.watchDrainRun, args);
    console.warn(
      JSON.stringify({ msg: "listing_drain_run_died", platform: args.platform, operation: "watchDrainRun", outcome: run.state.kind }),
    );
    return null;
  },
});

/**
 * The dead run's running sync record reads as its last result: the step it was
 * on failed, what it never reached dropped, no new `lastError`. The token comes
 * off, so a late write from that run records nothing. `lastRunAt` stays, so a
 * Sync pressed since still earns its full read.
 */
async function settleDeadRunRecord(
  ctx: MutationCtx,
  args: { ownerId: string; platform: Platform; leaseToken: string },
  now: number,
): Promise<void> {
  const records = await ctx.db
    .query("marketplaceListingSyncs")
    .withIndex("by_owner_platform_run", (q) => q.eq("ownerId", args.ownerId).eq("platform", args.platform))
    .order("desc")
    .take(DEAD_RUN_RECORD_SCAN);
  for (const record of records) {
    if (record.status !== "running" || record.leaseToken !== args.leaseToken) continue;
    await ctx.db.patch(record._id, {
      status: record.lastError !== undefined ? "error" : "idle",
      leaseToken: undefined,
      leaseExpiresAt: undefined,
      ...(record.progress
        ? { progress: { ...record.progress, steps: settleSteps(record.progress.steps, "error", now) } }
        : {}),
      lastUpdated: now,
    });
  }
}

// ── The outbox snapshot ────────────────────────────────────────────────────

const snapshotRowValidator = v.object({
  rowId: v.id("listingOutbox"),
  cardId: v.id("cardChecklist"),
  seq: v.number(),
  /** The card's variant now; null when the card is gone. */
  currentVariantId: v.union(v.id("selectorOptions"), v.null()),
  /** NEO-481: a photo of the card changed; BSC uploads it even over a seller photo. */
  refreshPhotos: v.optional(v.literal(true)),
  /** NEO-481: runs that could not finish that refresh so far. */
  refreshAttempts: v.optional(v.number()),
});
export type SnapshotRow = typeof snapshotRowValidator.type;

/**
 * The next variant with pending rows after `afterVariantId` (index order), or
 * null when none is left. Reads one row.
 */
export const nextOutboxVariant = internalQuery({
  args: {
    ownerId: v.string(),
    platform: listingPlatformValidator,
    afterVariantId: v.optional(v.id("selectorOptions")),
  },
  returns: v.union(v.id("selectorOptions"), v.null()),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("listingOutbox")
      .withIndex("by_owner_platform_variant", (q) => {
        const base = q.eq("ownerId", args.ownerId).eq("platform", args.platform);
        return args.afterVariantId === undefined ? base : base.gt("variantId", args.afterVariantId);
      })
      .first();
    return row?.variantId ?? null;
  },
});

/**
 * One variant's pending rows (at most `MAX_OUTBOX_ROWS_PER_PASS`), each with
 * the `seq` read now and its card's CURRENT variant (the row's `variantId` is
 * a grouping hint only; a card moved since keeps the old value there).
 */
export const outboxSnapshot = internalQuery({
  args: { ownerId: v.string(), platform: listingPlatformValidator, variantId: v.id("selectorOptions") },
  returns: v.array(snapshotRowValidator),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("listingOutbox")
      .withIndex("by_owner_platform_variant", (q) =>
        q.eq("ownerId", args.ownerId).eq("platform", args.platform).eq("variantId", args.variantId),
      )
      .take(MAX_OUTBOX_ROWS_PER_PASS);
    const out: SnapshotRow[] = [];
    for (const row of rows) {
      const card = await ctx.db.get(row.cardId);
      out.push({
        rowId: row._id,
        cardId: row.cardId,
        seq: row.seq,
        currentVariantId: card ? card.selectorOptionId : null,
        ...(row.refreshPhotos === true ? { refreshPhotos: true as const } : {}),
        ...(row.refreshAttempts !== undefined ? { refreshAttempts: row.refreshAttempts } : {}),
      });
    }
    return out;
  },
});

// ── The variant's sync record ──────────────────────────────────────────────

/**
 * True while the owner's state row pushes counts and carries this run's
 * lease. Listing stopped (the sign-in removed: start cleared, row dormant)
 * makes a run between variants, or between PUT chunks, stand down. A run the
 * watcher recorded as dead holds nothing, whatever its token says (NEO-433).
 */
async function holdsDrain(
  ctx: QueryCtx,
  args: { ownerId: string; platform: Platform; leaseToken: string },
): Promise<boolean> {
  const state = await ctx.db
    .query("marketplaceListingStates")
    .withIndex("by_owner_platform", (q) => q.eq("ownerId", args.ownerId).eq("platform", args.platform))
    .unique();
  return (
    state !== null &&
    pushesCounts(state) &&
    state.drainLeaseToken === args.leaseToken &&
    state.drainRunDeadAt === undefined
  );
}

export const drainHeld = internalQuery({
  args: { ownerId: v.string(), platform: listingPlatformValidator, leaseToken: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => await holdsDrain(ctx, args),
});

/**
 * Claims one variant's sync record (made on its first sync). A `running`
 * record whose lease has not run out belongs to another run: stand down.
 * `fullReadRequested`: a Sync was pressed since the record's last run
 * (`resyncRequestedAt` later than `lastRunAt`); the claim stamps `lastRunAt`,
 * so only this one run sees it. eBay reads every card of the variant on it;
 * BuySportsCards ignores it (NEO-475: a BSC run always reads the conditions
 * in use plus `conditionsPushed`, never the whole era).
 */
export const claimVariant = internalMutation({
  args: {
    ownerId: v.string(),
    platform: listingPlatformValidator,
    variantId: v.id("selectorOptions"),
    leaseToken: v.string(),
  },
  returns: v.union(
    v.object({
      claimed: v.literal(true),
      lastSuccessAt: v.union(v.number(), v.null()),
      fullReadRequested: v.boolean(),
      conditionsPushed: v.array(v.string()),
    }),
    v.object({ claimed: v.literal(false), reason: v.union(v.literal("busy"), v.literal("listingOff")) }),
  ),
  handler: async (ctx, args) => {
    const now = Date.now();
    // Listing stopped or dormant under the run: stand down, write nothing.
    if (!(await holdsDrain(ctx, args))) return { claimed: false as const, reason: "listingOff" as const };
    const record = await ctx.db
      .query("marketplaceListingSyncs")
      .withIndex("by_owner_variant_platform", (q) =>
        q.eq("ownerId", args.ownerId).eq("variantId", args.variantId).eq("platform", args.platform),
      )
      .unique();
    // NEO-415: a claimed run starts an empty ledger (the last run's goes).
    const progress = { runStartedAt: now, steps: [] };
    if (!record) {
      await ctx.db.insert("marketplaceListingSyncs", {
        ownerId: args.ownerId,
        variantId: args.variantId,
        platform: args.platform,
        status: "running",
        leaseToken: args.leaseToken,
        leaseExpiresAt: now + VARIANT_LEASE_MS,
        lastRunAt: now,
        problems: [],
        conditionsPushed: [],
        progress,
        lastUpdated: now,
      });
      return { claimed: true as const, lastSuccessAt: null, fullReadRequested: false, conditionsPushed: [] };
    }
    if (record.status === "running" && (record.leaseExpiresAt ?? 0) > now && record.leaseToken !== args.leaseToken) {
      return { claimed: false as const, reason: "busy" as const };
    }
    const fullReadRequested =
      record.resyncRequestedAt !== undefined && record.resyncRequestedAt > (record.lastRunAt ?? 0);
    await ctx.db.patch(record._id, {
      status: "running",
      leaseToken: args.leaseToken,
      leaseExpiresAt: now + VARIANT_LEASE_MS,
      lastRunAt: now,
      progress,
      lastUpdated: now,
    });
    return {
      claimed: true as const,
      lastSuccessAt: record.lastSuccessAt ?? null,
      fullReadRequested,
      conditionsPushed: record.conditionsPushed,
    };
  },
});

/**
 * NEO-475 — adds conditions to a variant's `conditionsPushed` before the run
 * sends anything under them, so a run that dies after a PUT (and never
 * reaches `finishVariant`) still leaves the record a later run reads and
 * zeroes from (product rule 5: a listing NB made is never lost track of).
 * Only while this run holds the variant's lease; false otherwise, and then
 * the run must not send.
 */
export const recordConditionsPushed = internalMutation({
  args: {
    ownerId: v.string(),
    platform: listingPlatformValidator,
    variantId: v.id("selectorOptions"),
    leaseToken: v.string(),
    conditions: v.array(v.string()),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const record = await ctx.db
      .query("marketplaceListingSyncs")
      .withIndex("by_owner_variant_platform", (q) =>
        q.eq("ownerId", args.ownerId).eq("variantId", args.variantId).eq("platform", args.platform),
      )
      .unique();
    if (!record || record.status !== "running" || record.leaseToken !== args.leaseToken) return false;
    const pushed = new Set(record.conditionsPushed);
    const before = pushed.size;
    for (const c of args.conditions) pushed.add(c);
    if (pushed.size !== before) {
      await ctx.db.patch(record._id, { conditionsPushed: [...pushed], lastUpdated: Date.now() });
    }
    return true;
  },
});

const storedProblemValidator = v.object({
  cardId: v.optional(v.id("cardChecklist")),
  platformCardId: v.optional(v.string()),
  reason: listingProblemReasonValidator,
  detail: v.optional(v.string()),
});

const finishOutcomeValidator = v.union(
  v.object({
    kind: v.literal("ok"),
    counts: v.object({ listed: v.number(), pushed: v.number(), zeroed: v.number(), skipped: v.number() }),
    problems: v.array(storedProblemValidator),
    problemsTotal: v.number(),
    conditionsPushed: v.array(v.string()),
  }),
  v.object({
    kind: v.literal("error"),
    error: v.string(),
    problems: v.optional(v.array(storedProblemValidator)),
    problemsTotal: v.optional(v.number()),
    conditionsPushed: v.optional(v.array(v.string())),
  }),
);
export type FinishOutcome = typeof finishOutcomeValidator.type;

/**
 * Finishes one variant: writes its sync record (only while this run still
 * holds its lease) and settles the snapshot's outbox rows by point read:
 * `clear` rows are deleted, `repoint` rows get their card's current variant,
 * each only if its `seq` is still the one the snapshot read (a change landing
 * mid-push keeps its row for the next run).
 *
 * NEO-433 — an `ok` outcome never stores an empty ledger: a run replaces the
 * last run's steps with its own, and a run that had nothing to do says so with
 * its one `check` step, done. The drainers hold this up: eBay starts `check`
 * right after the claim, BSC either reads at least one sheet or starts `check`.
 */
export const finishVariant = internalMutation({
  args: {
    ownerId: v.string(),
    platform: listingPlatformValidator,
    variantId: v.id("selectorOptions"),
    leaseToken: v.string(),
    outcome: finishOutcomeValidator,
    clear: v.array(v.object({ rowId: v.id("listingOutbox"), seq: v.number() })),
    repoint: v.array(
      v.object({ rowId: v.id("listingOutbox"), seq: v.number(), variantId: v.id("selectorOptions") }),
    ),
    /** NEO-415: the run's ledger as the drainer holds it (settled here; absent keeps the stored one, settled). */
    progress: v.optional(v.array(listingSyncStepValidator)),
    /** NEO-481: kept rows whose photo refresh this run could not finish; each counts one more try. */
    refreshTried: v.optional(v.array(v.object({ rowId: v.id("listingOutbox"), seq: v.number() }))),
  },
  returns: v.object({ cleared: v.number(), repointed: v.number(), recorded: v.boolean() }),
  handler: async (ctx, args) => {
    const now = Date.now();
    let cleared = 0;
    let repointed = 0;
    for (const { rowId, seq } of args.refreshTried ?? []) {
      const row = await ctx.db.get(rowId);
      // At the seq the run read: a change since (a new photo) starts the count again.
      if (row && row.seq === seq && row.ownerId === args.ownerId && row.refreshPhotos === true) {
        await ctx.db.patch(rowId, { refreshAttempts: (row.refreshAttempts ?? 0) + 1 });
      }
    }
    for (const { rowId, seq } of args.clear) {
      const row = await ctx.db.get(rowId);
      if (row && row.seq === seq && row.ownerId === args.ownerId) {
        await ctx.db.delete(rowId);
        cleared += 1;
      }
    }
    for (const { rowId, seq, variantId } of args.repoint) {
      const row = await ctx.db.get(rowId);
      if (row && row.seq === seq && row.ownerId === args.ownerId) {
        await ctx.db.patch(rowId, { variantId });
        repointed += 1;
      }
    }
    const record = await ctx.db
      .query("marketplaceListingSyncs")
      .withIndex("by_owner_variant_platform", (q) =>
        q.eq("ownerId", args.ownerId).eq("variantId", args.variantId).eq("platform", args.platform),
      )
      .unique();
    if (!record || record.leaseToken !== args.leaseToken) return { cleared, repointed, recorded: false };
    const o = args.outcome;
    const pushed = new Set(record.conditionsPushed);
    for (const c of o.conditionsPushed ?? []) pushed.add(c);
    const steps = args.progress ?? record.progress?.steps;
    const progress =
      steps === undefined
        ? {}
        : {
            progress: {
              runStartedAt: record.progress?.runStartedAt ?? record.lastRunAt ?? now,
              steps: settleSteps(steps, o.kind, now),
            },
          };
    if (o.kind === "ok") {
      await ctx.db.patch(record._id, {
        ...progress,
        status: "idle",
        leaseToken: undefined,
        leaseExpiresAt: undefined,
        lastSuccessAt: now,
        lastError: undefined,
        counts: o.counts,
        problems: o.problems.slice(0, MAX_STORED_PROBLEMS),
        problemsTotal: o.problemsTotal,
        conditionsPushed: [...pushed],
        lastUpdated: now,
      });
    } else {
      await ctx.db.patch(record._id, {
        ...progress,
        status: "error",
        leaseToken: undefined,
        leaseExpiresAt: undefined,
        lastError: o.error.slice(0, MAX_ERROR),
        ...(o.problems ? { problems: o.problems.slice(0, MAX_STORED_PROBLEMS) } : {}),
        ...(o.problemsTotal !== undefined ? { problemsTotal: o.problemsTotal } : {}),
        conditionsPushed: [...pushed],
        lastUpdated: now,
      });
    }
    return { cleared, repointed, recorded: true };
  },
});

// ── Run progress (NEO-415) ─────────────────────────────────────────────────

export type ListingSyncStep = typeof listingSyncStepValidator.type;
export type ListingSyncStepKind = ListingSyncStep["kind"];

/** Steps one ledger keeps (a vintage BSC run is ~22). */
export const MAX_PROGRESS_STEPS = 40;

/**
 * A finished run's ledger: steps still `waiting` are dropped (the run never
 * needed them, or died before them); a step still `working` ends `done` on a
 * clean finish and `failed` otherwise (the step the run died on).
 */
export function settleSteps(
  steps: readonly ListingSyncStep[],
  outcome: "ok" | "error",
  now: number,
): ListingSyncStep[] {
  return steps
    .filter((s) => s.status !== "waiting")
    .slice(0, MAX_PROGRESS_STEPS)
    .map((s) => {
      // PR 451: a finished run waits on nothing. The measured total stays.
      const { marketplaceWaitingSince: _open, ...rest } = s;
      return rest.status === "working"
        ? { ...rest, status: outcome === "ok" ? ("done" as const) : ("failed" as const), finishedAt: now }
        : rest;
    });
}

/**
 * Writes a running variant's ledger. Only the run holding the variant's
 * lease writes; a run that lost it writes nothing. One small patch per step.
 */
export const writeProgress = internalMutation({
  args: {
    ownerId: v.string(),
    platform: listingPlatformValidator,
    variantId: v.id("selectorOptions"),
    leaseToken: v.string(),
    steps: v.array(listingSyncStepValidator),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const record = await ctx.db
      .query("marketplaceListingSyncs")
      .withIndex("by_owner_variant_platform", (q) =>
        q.eq("ownerId", args.ownerId).eq("variantId", args.variantId).eq("platform", args.platform),
      )
      .unique();
    if (!record || record.status !== "running" || record.leaseToken !== args.leaseToken) return false;
    await ctx.db.patch(record._id, {
      progress: {
        runStartedAt: record.progress?.runStartedAt ?? record.lastRunAt ?? Date.now(),
        steps: args.steps.slice(0, MAX_PROGRESS_STEPS),
      },
    });
    return true;
  },
});

/** A step as the drainer plans it: an internal key (never stored) plus what is stored. */
export interface PlannedStep {
  key: string;
  kind: ListingSyncStepKind;
  /** NB conditions a read or confirm covers, best first; empty or absent for other steps. */
  conditions?: readonly NbCondition[];
}

/**
 * The drainer's in-memory ledger for one variant run. `start` is the one
 * write per step: it ends the step that was working (`done`) and starts the
 * next. Appends, inserts, drops and failures ride on the next write, or on
 * `finishVariant` (which settles what is left). Keys are the drainer's own;
 * only kind, NB conditions, status and finish time are stored.
 */
export class ProgressLedger {
  private entries: Array<{ key: string; step: ListingSyncStep }> = [];
  /** PR 451: the BSC session's last wait edge said a call is outstanding. */
  private bscWaiting = false;
  /** Set by `finishWaits`: the record is being finished, edges are ignored. */
  private waitsFinished = false;
  /**
   * Every `writeProgress` of this ledger, in order, so a wait edge's write
   * and a step's write never land out of order. Each write sends the ledger
   * as it stands when it runs.
   */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly ctx: DrainCtx,
    private readonly ids: {
      ownerId: string;
      platform: Platform;
      variantId: Id<"selectorOptions">;
      leaseToken: string;
    },
    private readonly now: () => number = Date.now,
  ) {}

  private static toStep(p: PlannedStep): ListingSyncStep {
    const conditions = p.conditions ?? [];
    return {
      kind: p.kind,
      ...(conditions.length > 0 ? { condition: conditions[0], conditions: [...conditions] } : {}),
      status: "waiting",
    };
  }

  has(key: string): boolean {
    return this.entries.some((e) => e.key === key);
  }

  /** Replaces the plan (every step `waiting`). No write. */
  plan(steps: readonly PlannedStep[]): void {
    this.entries = steps.map((p) => ({ key: p.key, step: ProgressLedger.toStep(p) }));
  }

  /** Adds steps at the end (or before `beforeKey`). No write. */
  add(steps: readonly PlannedStep[], beforeKey?: string): void {
    const fresh = steps.filter((p) => !this.has(p.key)).map((p) => ({ key: p.key, step: ProgressLedger.toStep(p) }));
    const at = beforeKey === undefined ? -1 : this.entries.findIndex((e) => e.key === beforeKey);
    if (at < 0) this.entries.push(...fresh);
    else this.entries.splice(at, 0, ...fresh);
  }

  /** Removes a step the run turns out not to need. No write. */
  drop(key: string): void {
    this.entries = this.entries.filter((e) => e.key !== key);
  }

  /** Marks a step failed (the run goes on past it). No write. */
  fail(key: string): void {
    const entry = this.entries.find((e) => e.key === key);
    if (!entry) return;
    const at = this.now();
    entry.step = { ...ProgressLedger.closeWait(entry.step, at), status: "failed", finishedAt: at };
  }

  /** Ends the working step `done`. No write. */
  endWorking(): void {
    const at = this.now();
    for (const e of this.entries) {
      if (e.step.status === "working") {
        e.step = { ...ProgressLedger.closeWait(e.step, at), status: "done", finishedAt: at };
      }
    }
  }

  /** Ends the working step `done` and starts `key`: one write. Already working: nothing. */
  async start(key: string): Promise<void> {
    const entry = this.entries.find((e) => e.key === key);
    if (!entry || entry.step.status === "working") return;
    this.endWorking();
    entry.step = { ...entry.step, status: "working" };
    // A BSC burst still open when the step changes carries on in the new one.
    if (this.bscWaiting && !this.waitsFinished) entry.step = { ...entry.step, marketplaceWaitingSince: this.now() };
    await this.write();
  }

  /** Writes the ledger as it stands (the plan, before the first step starts). */
  async write(): Promise<void> {
    const write = this.chain.then(() => this.send());
    this.chain = write.catch(() => undefined);
    await write;
  }

  private async send(): Promise<void> {
    await this.ctx.runMutation(internal.listingDrain.writeProgress, { ...this.ids, steps: this.steps() });
  }

  /** A step with its open wait (if any) added to its total and closed. */
  private static closeWait(step: ListingSyncStep, at: number): ListingSyncStep {
    if (step.marketplaceWaitingSince === undefined) return step;
    const { marketplaceWaitingSince: since, ...rest } = step;
    return { ...rest, marketplaceWaitMs: (step.marketplaceWaitMs ?? 0) + Math.max(0, at - since) };
  }

  /**
   * PR 451 (NEO-487) — one wait edge of the run's BSC session recorder
   * (`openBscSellerSession`'s `onWaitEdge`): measured, never the step's
   * elapsed time. `waiting: true` (a BSC call went out with none
   * outstanding) stamps the working step's `marketplaceWaitingSince`;
   * `waiting: false` (no call outstanding for the recorder's idle grace) adds
   * the interval to its `marketplaceWaitMs` and clears it. Each change is one
   * `writeProgress`, chained behind the step writes, so the status is live
   * while the call is out. Synchronous for the recorder; a failed write is
   * logged and dropped (the status is a convenience, never a reason to stop
   * a run). An edge with no working step writes nothing; `start` picks the
   * wait up if it is still open.
   */
  waitEdge(edge: BscWaitEdge): void {
    if (this.waitsFinished) return;
    this.bscWaiting = edge.waiting;
    let changed = false;
    for (const e of this.entries) {
      if (edge.waiting) {
        if (e.step.status === "working" && e.step.marketplaceWaitingSince === undefined) {
          e.step = { ...e.step, marketplaceWaitingSince: edge.at };
          changed = true;
        }
      } else if (e.step.marketplaceWaitingSince !== undefined) {
        e.step = ProgressLedger.closeWait(e.step, edge.at);
        changed = true;
      }
    }
    if (!changed) return;
    const write = this.chain.then(() => this.send());
    this.chain = write.catch((error: unknown) => {
      try {
        console.warn(
          JSON.stringify({
            msg: "listing_wait_write_failed",
            platform: this.ids.platform,
            operation: "writeProgress",
            error: error instanceof Error ? error.name : "unknown",
          }),
        );
      } catch {
        // never throws into a call
      }
    });
  }

  /**
   * Before the run's record is finished: closes any open wait now, stops
   * taking edges, and waits for every queued write to land, so none lands
   * after `finishVariant` (it would be refused anyway: the lease is gone).
   */
  async finishWaits(): Promise<void> {
    this.waitsFinished = true;
    this.bscWaiting = false;
    const at = this.now();
    for (const e of this.entries) e.step = ProgressLedger.closeWait(e.step, at);
    await this.chain;
  }

  steps(): ListingSyncStep[] {
    return this.entries.map((e) => e.step);
  }
}

/**
 * The read (or confirm) steps of some BSC condition sheets, in read order:
 * one per sheet NB has a condition name for (era order), then one step for
 * every sheet NB lists nothing under (their names are BSC's and are never
 * shown). `order` is the sheets in that order. Since NEO-475 no run reads the
 * whole era, so that last step is defensive: it is reached only by a stored
 * `conditionsPushed` key NB has no name for in the era. Kept, and tested.
 */
export function bscSheetSteps(
  kind: "read" | "confirm",
  sheets: readonly string[],
  era: BscEra,
): { steps: PlannedStep[]; order: string[]; keyOf: (sheet: string) => string } {
  const named: PlannedStep[] = [];
  const namedSheets: string[] = [];
  const otherSheets: string[] = [];
  const keys = new Map<string, string>();
  for (const sheet of sheets) {
    if (keys.has(sheet)) continue;
    const nb = nbConditionsFor(sheet, era);
    if (nb.length > 0) {
      const key = `${kind}:${sheet}`;
      keys.set(sheet, key);
      named.push({ key, kind, conditions: nb });
      namedSheets.push(sheet);
    } else {
      keys.set(sheet, `${kind}:other`);
      otherSheets.push(sheet);
    }
  }
  const steps = otherSheets.length > 0 ? [...named, { key: `${kind}:other`, kind }] : named;
  return { steps, order: [...namedSheets, ...otherSheets], keyOf: (sheet) => keys.get(sheet) ?? `${kind}:other` };
}

// ── One NB owner per seller account ────────────────────────────────────────

/**
 * Before a run's first PUT: ties the owner's state row to the seller account
 * the PUT names (`platformAccountId`), unless another NB owner's row already
 * holds it. On a conflict the row goes dormant (`sellerConflict`: no drain,
 * no poll) and nothing is pushed; the collector is told on the variant and
 * in their listing settings, and saving the sign-in again re-checks.
 * Only the run holding the lease may bind.
 */
export const bindSellerAccount = internalMutation({
  args: {
    ownerId: v.string(),
    platform: listingPlatformValidator,
    leaseToken: v.string(),
    accountId: v.string(),
  },
  returns: v.union(v.literal("bound"), v.literal("conflict"), v.literal("off")),
  handler: async (ctx, args) => {
    const state = await ctx.db
      .query("marketplaceListingStates")
      .withIndex("by_owner_platform", (q) => q.eq("ownerId", args.ownerId).eq("platform", args.platform))
      .unique();
    if (!state || !pushesCounts(state) || state.drainLeaseToken !== args.leaseToken || state.drainRunDeadAt !== undefined) {
      return "off";
    }
    const now = Date.now();
    if (await sellerAccountHolder(ctx, args.platform, args.accountId, args.ownerId)) {
      await ctx.db.patch(state._id, { dormant: "sellerConflict", lastUpdated: now });
      console.warn(
        JSON.stringify({ msg: "listing_seller_conflict", platform: args.platform, operation: "bindSellerAccount" }),
      );
      return "conflict";
    }
    if (state.platformAccountId !== args.accountId) {
      await ctx.db.patch(state._id, { platformAccountId: args.accountId, lastUpdated: now });
    }
    return "bound";
  },
});

/**
 * NEO-483 — the BuySportsCards seller account NB holds for an owner
 * (`userProfiles.marketplaceAccountIds.bscSellerId`), or null when none is
 * stored or the stored one is not a seller id a PUT can name. The drain's gate
 * (`claimDrain`), its PUTs (`variantSyncInput`), listing set-up and Sync
 * status all read it through here, so they never disagree.
 */
export function storedBscSellerId(sellerId: string | null | undefined): string | null {
  return sellerId != null && isBscSellerId(sellerId) ? sellerId : null;
}

const SELLER_CONFLICT_ERROR =
  "This BuySportsCards seller account already lists from another NeonBinder account, so NeonBinder stopped listing from this one.";

// ── What a variant push reads from NB ──────────────────────────────────────

const variantInputValidator = v.union(
  v.object({ kind: v.literal("gone") }),
  v.object({ kind: v.literal("noScope") }),
  v.object({ kind: v.literal("noEra") }),
  v.object({
    kind: v.literal("ok"),
    era: v.union(v.literal("modern"), v.literal("vintage")),
    /** One single-valued facet filter set per request (`planBscFanOut`). */
    requests: v.array(v.record(v.string(), v.array(v.string()))),
    setId: v.union(v.id("selectorOptions"), v.null()),
    commonPriceCents: v.union(v.number(), v.null()),
    sellerId: v.union(v.string(), v.null()),
    /** Every `cardNumberPrefix` on the variant's chain (`planBscSheet`). */
    cardNumberPrefixes: v.array(v.string()),
  }),
);
export type VariantInput = typeof variantInputValidator.type;

/**
 * The variant's BSC scope (from its slot ids, the checklist gate's own rule:
 * `resolvableSides` with `leafGate`, then `resolveBscFacetFilters`), its era
 * (from NB's year row), its set, the owner's common price and BSC seller id,
 * and the card-number prefixes its chain carries.
 */
export const variantSyncInput = internalQuery({
  args: { ownerId: v.string(), variantId: v.id("selectorOptions") },
  returns: variantInputValidator,
  handler: async (ctx, args): Promise<VariantInput> => {
    const leaf = await ctx.db.get(args.variantId);
    if (!leaf) return { kind: "gone" };
    const chain: Array<ResolvableRow & { id: Id<"selectorOptions"> }> = [];
    const cardNumberPrefixes: string[] = [];
    let cursor: Doc<"selectorOptions"> | null = leaf;
    for (let depth = 0; cursor && depth < 16; depth += 1) {
      chain.unshift({
        id: cursor._id,
        level: cursor.level,
        value: cursor.value,
        platformData: cursor.platformData ?? {},
        platformFacets: cursor.platformFacets,
      });
      if (cursor.metadata?.cardNumberPrefix) cardNumberPrefixes.push(cursor.metadata.cardNumberPrefix);
      cursor = cursor.parentId ? await ctx.db.get(cursor.parentId) : null;
    }
    const resolution = resolvableSides(chain, { bscScope: "checklist", leafGate: true });
    if (!resolution.bsc.resolvable) return { kind: "noScope" };
    const yearRow = chain.find((row) => row.level === "year");
    const era = yearRow?.value !== undefined ? bscEraForYear(yearRow.value) : null;
    if (era === null) return { kind: "noEra" };
    const { filters } = resolveBscFacetFilters(chain);
    const plan = planBscFanOut(filters);
    if (plan.capped) {
      console.warn(
        JSON.stringify({ msg: "listing_fanout_capped", platform: "bsc", operation: "drain", requests: plan.totalBeforeCap }),
      );
    }
    const requests = plan.combos.map((combo) => {
      const call: Record<string, string[]> = { ...filters };
      for (const [facet, value] of Object.entries(combo)) call[facet] = [value];
      return call;
    });
    const setId = chain.find((row) => row.level === "setName")?.id ?? null;
    // The same read the add gate prices by (`listingGate.commonPriceCentsOf`).
    const commonPriceCents = await commonPriceCentsOf(ctx, args.ownerId, args.variantId);
    const profile = await ctx.db
      .query("userProfiles")
      .withIndex("by_user", (q) => q.eq("userId", args.ownerId))
      .unique();
    return {
      kind: "ok",
      era,
      requests,
      setId,
      commonPriceCents,
      sellerId: storedBscSellerId(profile?.marketplaceAccountIds?.bscSellerId ?? null),
      cardNumberPrefixes,
    };
  },
});

const cardOutValidator = v.object({
  cardId: v.id("cardChecklist"),
  cardNumber: v.string(),
  bscRef: v.union(v.string(), v.null()),
});

/** One page of the variant's cards: number and BSC ref only. */
export const variantCardsPage = internalQuery({
  args: { variantId: v.id("selectorOptions"), cursor: v.union(v.string(), v.null()) },
  returns: v.object({ cards: v.array(cardOutValidator), cursor: v.string(), isDone: v.boolean() }),
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("cardChecklist")
      .withIndex("by_selector_option", (q) => q.eq("selectorOptionId", args.variantId))
      .paginate({ numItems: CARD_PAGE_SIZE, cursor: args.cursor });
    return {
      cards: page.page.map((card) => ({
        cardId: card._id,
        cardNumber: card.cardNumber,
        bscRef: card.platformData?.bsc?.ref ?? null,
      })),
      cursor: page.continueCursor,
      isDone: page.isDone,
    };
  },
});

const copyOutValidator = v.object({
  copyId: v.id("collectionCopies"),
  homeId: v.id("collectionContainers"),
  cardId: v.id("cardChecklist"),
  homeIsBox: v.boolean(),
  graded: v.boolean(),
  quantity: v.number(),
  condition: v.optional(
    v.union(
      v.literal("Mint"),
      v.literal("Near Mint"),
      v.literal("Excellent"),
      v.literal("Very Good"),
      v.literal("Good"),
      v.literal("Poor"),
    ),
  ),
  minPriceCents: v.optional(v.number()),
  acquiredOn: v.optional(v.string()),
  creationTime: v.number(),
  hasPhotos: v.boolean(),
});
export type CopyOut = typeof copyOutValidator.type;

/**
 * One page of the owner's copies in the variant, with whether each one lists
 * (`homeIsBox`: its home is a LISTED box, `listingOutbox.listsOnMarketplaces`;
 * a binder copy and an in-person box copy both count 0 on the platform).
 * Private-card copies carry no variant, so none reach here.
 */
export const variantCopiesPage = internalQuery({
  args: {
    ownerId: v.string(),
    setId: v.id("selectorOptions"),
    variantId: v.id("selectorOptions"),
    cursor: v.union(v.string(), v.null()),
  },
  returns: v.object({ copies: v.array(copyOutValidator), cursor: v.string(), isDone: v.boolean() }),
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("collectionCopies")
      .withIndex("by_owner_set_variant", (q) =>
        q.eq("ownerId", args.ownerId).eq("setId", args.setId).eq("variantId", args.variantId),
      )
      .paginate({ numItems: COPY_PAGE_SIZE, cursor: args.cursor });
    const listed = new Map<string, boolean>();
    const homeLists = async (homeId: Id<"collectionContainers">): Promise<boolean> => {
      const known = listed.get(homeId);
      if (known !== undefined) return known;
      const home = await ctx.db.get(homeId);
      const lists = home !== null && home.ownerId === args.ownerId && listsOnMarketplaces(home);
      listed.set(homeId, lists);
      return lists;
    };
    const copies: CopyOut[] = [];
    for (const row of page.page) {
      const cardId = ctx.db.normalizeId("cardChecklist", row.cardId);
      if (cardId === null) continue;
      copies.push({
        copyId: row._id,
        homeId: row.homeId,
        cardId,
        homeIsBox: await homeLists(row.homeId),
        graded: row.grading !== undefined,
        quantity: row.quantity,
        ...(row.condition !== undefined ? { condition: row.condition } : {}),
        ...(row.minPriceCents !== undefined ? { minPriceCents: row.minPriceCents } : {}),
        ...(row.acquiredOn !== undefined ? { acquiredOn: row.acquiredOn } : {}),
        creationTime: row._creationTime,
        hasPhotos: row.hasPhotos === true,
      });
    }
    return { copies, cursor: page.continueCursor, isDone: page.isDone };
  },
});

/** The live photos of some copies (each row's photo copy, when the row needs one). */
export const copyPhotosForListing = internalQuery({
  args: { ownerId: v.string(), copyIds: v.array(v.id("collectionCopies")) },
  returns: v.array(
    v.object({
      copyId: v.id("collectionCopies"),
      side: v.union(v.literal("front"), v.literal("back")),
      key: v.string(),
      contentType: v.union(v.literal("image/jpeg"), v.literal("image/webp")),
      imageBytes: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const out = [];
    for (const copyId of args.copyIds.slice(0, MAX_PHOTO_UPLOADS_PER_VARIANT)) {
      const photos = await ctx.db
        .query("collectionCopyPhotos")
        .withIndex("by_copy_and_status", (q) => q.eq("copyId", copyId).eq("status", "live"))
        .take(2);
      for (const photo of photos) {
        if (photo.ownerId !== args.ownerId) continue;
        out.push({
          copyId,
          side: photo.side,
          key: copyPhotoObjectKey(photo.token, "image", photo.contentType),
          contentType: photo.contentType,
          imageBytes: photo.imageBytes,
        });
      }
    }
    return out;
  },
});

// ── Problems: the plan's reasons → the stored, NB-authored vocabulary ──────

/** Maps a planner problem to what the sync record stores; null = not shown. */
export function toStoredProblem(p: ListingProblem, cardIds: ReadonlySet<string>): StoredProblem | null {
  const cardId = p.cardId !== undefined && cardIds.has(p.cardId) ? (p.cardId as Id<"cardChecklist">) : undefined;
  const base = {
    ...(cardId ? { cardId } : {}),
    ...(p.bscCardId ? { platformCardId: p.bscCardId } : {}),
  };
  const withDetail = (reason: StoredReason, detail?: string): StoredProblem => ({
    ...base,
    reason,
    ...(detail ? { detail: detail.slice(0, MAX_DETAIL) } : {}),
  });
  switch (p.reason) {
    case "no_bsc_id":
      return withDetail("noLink");
    case "shared_bsc_id":
      return withDetail("sharedLink");
    case "card_number_conflict":
      // NB-only detail (the planner writes NB's number, never BSC's).
      return withDetail("numberMismatch", p.detail);
    case "not_on_bsc_sheet":
      return withDetail("notOnSheet");
    case "condition_not_read":
      return withDetail("notOnSheet", "NeonBinder didn't read that condition this time.");
    case "no_price":
      return withDetail("noPrice");
    case "price_too_high":
      return withDetail("priceTooHigh");
    case "no_condition":
    case "no_era":
      return withDetail("noCondition");
    case "graded":
      return withDetail("graded");
    case "duplicate_sheet_row":
      return withDetail("rejected", "BuySportsCards shows this card twice in one condition, so NeonBinder left it alone.");
    case "unreadable_sheet_row":
      return withDetail("rejected", `Some BuySportsCards rows couldn't be read (${p.detail ?? "unknown"}).`);
    case "private_card":
    case "card_not_in_variant":
      return null;
  }
}

/**
 * The detail of a push BSC did not take (the read-back disagreed). NB-only,
 * like `numberMismatch`: NB's condition names and the quantity NB sent, never
 * BSC's condition string or the count BSC shows. A condition NB has no name
 * for (a zeroed row of a condition outside the era) is left out.
 */
export function rejectedPushDetail(sent: number, bscCondition: string, era: BscEra): string {
  const names = nbConditionsFor(bscCondition, era);
  const which = names.length > 0 ? ` for ${names.join(" / ")}` : "";
  return `NeonBinder sent ${sent}${which}, but the listing didn't take it.`.slice(0, MAX_DETAIL);
}

// ── The drain ──────────────────────────────────────────────────────────────

/** PR 451: where a drain's BSC session sends its wait edges (the running variant's ledger). */
interface BscWaitTarget {
  ledger?: ProgressLedger;
}

/** What `drainOwnerImpl` needs of an action ctx (a stub in tests). */
export type DrainCtx = Pick<ActionCtx, "runQuery" | "runMutation" | "runAction">;

export interface DrainOptions {
  budgetMs?: number;
  now?: () => number;
  /** Fetches one R2 object's bytes; the real one signs with `lib/r2`. */
  fetchPhoto?: (key: string, maxBytes: number) => Promise<ArrayBuffer | null>;
  /**
   * The wait before a retry: an eBay publish's one busy retry (`publishOffer`)
   * and a BSC sheet read's 503 retries (`readSheets`, NEO-475). Tests pass one
   * that returns at once.
   */
  pause?: (ms: number) => Promise<void>;
}

export interface DrainReport {
  claimed: boolean;
  variants: Array<{ variantId: Id<"selectorOptions">; result: VariantResult["kind"] }>;
  stoppedFor:
    | "done"
    | "budget"
    | "signedOut"
    | "paused"
    | "noToken"
    | "notClaimed"
    | "listingOff"
    | "noCredentials"
    | "needsReauth"
    | "sellerConflict"
    /** NEO-415: eBay settings are not complete; nothing was sent. */
    | "setupIncomplete"
    /** NEO-415: eBay is not wired on this deployment. */
    | "notConfigured"
    /** NEO-483: no BuySportsCards seller account stored yet; its read is armed, nothing was sent. */
    | "awaitingSeller";
}

type SessionResult = BscSellerResult<BscSellerSession>;

type VariantResult =
  | { kind: "ok" }
  | { kind: "error" }
  | { kind: "skipped" }
  | { kind: "stop"; failure: BscSellerFailure }
  /** Listing stopped under the run (sign-in removed): stop, write nothing more. */
  | { kind: "off" }
  /** Another NB owner holds the seller account: stop, push nothing. */
  | { kind: "sellerConflict" };

export async function defaultFetchPhoto(key: string, maxBytes: number): Promise<ArrayBuffer | null> {
  const config = r2Config();
  if (!config) return null;
  const res = await config.client.fetch(`${config.base}/${key.split("/").map(encodeURIComponent).join("/")}`, {
    method: "GET",
  });
  if (!res.ok) {
    await res.text().catch(() => "");
    return null;
  }
  const bytes = await res.arrayBuffer();
  return bytes.byteLength > maxBytes ? null : bytes;
}

/**
 * The drain itself, as a plain function so a test can drive it with a stub
 * ctx (a short budget, a fake clock). `drainOwner` is the scheduled entry.
 */
export async function drainOwnerImpl(
  ctx: DrainCtx,
  args: { ownerId: string; platform: Platform; fullVariantIds?: Array<Id<"selectorOptions">>; kickToken?: string },
  opts: DrainOptions = {},
): Promise<DrainReport> {
  // NEO-415: eBay is card-level and has its own walk (`listingDrainEbay`);
  // everything below is BuySportsCards' sheet-level push, unchanged.
  if (args.platform === "ebay") return await drainEbayOwnerImpl(ctx, args, opts);
  const now = opts.now ?? Date.now;
  const budgetMs = opts.budgetMs ?? DRAIN_BUDGET_MS;
  const startedAt = now();
  const leaseToken = newToken();
  const report: DrainReport = { claimed: false, variants: [], stoppedFor: "done" };
  // NEO-475: condition sheets this run began reading (the run log's `conditionsRead`).
  const tally = { conditionsRead: 0 };

  const claim = await ctx.runMutation(internal.listingDrain.claimDrain, {
    ownerId: args.ownerId,
    platform: args.platform,
    leaseToken,
    ...(args.fullVariantIds ? { fullVariantIds: args.fullVariantIds } : {}),
    ...(args.kickToken !== undefined ? { kickToken: args.kickToken } : {}),
  });
  if (!claim.claimed) {
    report.stoppedFor =
      claim.reason === "noCredentials"
        ? "noCredentials"
        : claim.reason === "needsReauth"
          ? "needsReauth"
          : claim.reason === "setupIncomplete"
            ? "setupIncomplete"
            : claim.reason === "awaitingSeller"
              ? "awaitingSeller"
              : "notClaimed";
    return report;
  }
  report.claimed = true;

  let next: "continue" | "done" | "stop" = "done";
  const fullQueue = [...new Set(args.fullVariantIds ?? [])];
  let opened: SessionResult | null = null;
  // NEO-475: the open session, closed (its call summary flushed) in `finally`.
  const held: { session?: BscSellerSession } = {};
  // PR 451: the session's BSC wait edges go to the variant running now.
  const waitTarget: BscWaitTarget = {};
  const getSession = async (): Promise<SessionResult> => {
    opened ??= await openBscSellerSession(ctx, args.ownerId, {
      op: "drainOwner",
      onWaitEdge: (edge) => waitTarget.ledger?.waitEdge(edge),
    });
    if (opened.ok) held.session = opened.value;
    return opened;
  };
  // The seller account this run's PUTs name, checked once per run.
  let bound: string | null = null;
  const bindSeller = async (accountId: string): Promise<"bound" | "conflict" | "off"> => {
    if (bound === accountId) return "bound";
    const r = await ctx.runMutation(internal.listingDrain.bindSellerAccount, {
      ownerId: args.ownerId,
      platform: args.platform,
      leaseToken,
      accountId,
    });
    if (r === "bound") bound = accountId;
    return r;
  };

  try {
    const done = new Set<string>();
    let afterVariantId: Id<"selectorOptions"> | undefined;
    for (;;) {
      if (now() - startedAt >= budgetMs) {
        report.stoppedFor = "budget";
        next = "continue";
        break;
      }
      let variantId: Id<"selectorOptions"> | null;
      let full = false;
      if (fullQueue.length > 0) {
        variantId = fullQueue.shift() ?? null;
        full = true;
      } else {
        variantId = await ctx.runQuery(internal.listingDrain.nextOutboxVariant, {
          ownerId: args.ownerId,
          platform: args.platform,
          ...(afterVariantId ? { afterVariantId } : {}),
        });
        if (variantId === null) break;
        afterVariantId = variantId;
        if (done.has(variantId)) continue;
      }
      if (variantId === null) continue;
      done.add(variantId);
      let result: VariantResult;
      try {
        result = await syncVariant(ctx, { ...args, variantId, leaseToken }, getSession, bindSeller, opts, tally, waitTarget);
      } finally {
        waitTarget.ledger = undefined;
      }
      report.variants.push({ variantId, result: result.kind });
      if (result.kind === "sellerConflict") {
        report.stoppedFor = "sellerConflict";
        next = "stop";
        fullQueue.length = 0;
        break;
      }
      if (result.kind === "off") {
        report.stoppedFor = "listingOff";
        fullQueue.length = 0;
        break;
      }
      if (result.kind === "stop") {
        report.stoppedFor =
          result.failure.kind === "paused" ? "paused" : result.failure.kind === "no_token" ? "noToken" : "signedOut";
        next = "stop";
        // A full re-read that never ran stays queued.
        fullQueue.unshift(...(full ? [variantId] : []));
        break;
      }
    }
  } finally {
    try {
      await ctx.runMutation(internal.listingDrain.releaseDrain, {
        ownerId: args.ownerId,
        platform: args.platform,
        leaseToken,
        next,
        ...(fullQueue.length > 0 ? { leftoverFullVariantIds: fullQueue } : {}),
      });
    } finally {
      // NEO-475: the session's BSC call summary, once per run. Never throws.
      if (held.session) await closeBscSellerSession(ctx, held.session);
    }
  }
  console.log(
    JSON.stringify({
      msg: "listing_drain",
      platform: args.platform,
      operation: "drainOwner",
      variants: report.variants.length,
      conditionsRead: tally.conditionsRead,
      stoppedFor: report.stoppedFor,
      durationMs: now() - startedAt,
    }),
  );
  return report;
}

/** Splits a snapshot into rows this variant settles and rows to re-point. */
export function settleRows(snapshot: readonly SnapshotRow[], variantId: Id<"selectorOptions">) {
  const mine: SnapshotRow[] = [];
  const gone: SnapshotRow[] = [];
  const moved: SnapshotRow[] = [];
  for (const row of snapshot) {
    if (row.currentVariantId === null) gone.push(row);
    else if (row.currentVariantId === variantId) mine.push(row);
    else moved.push(row);
  }
  return {
    mine: mine.map(({ rowId, seq }) => ({ rowId, seq })),
    /**
     * NEO-481: the cards of `mine` whose row asks for a photo refresh. A moved
     * card's flag rides its re-pointed row to its new variant's run.
     */
    refreshCardIds: new Set(mine.filter((r) => r.refreshPhotos === true).map((r) => r.cardId as string)),
    /** Row ids of `mine` by card, so a refresh this run could not finish keeps its row. */
    mineRowOfCard: new Map(mine.map((r) => [r.cardId as string, r.rowId as string])),
    /** NEO-481: each refreshed card's row, its seq, and the tries it has had. */
    refreshRowOfCard: new Map(
      mine
        .filter((r) => r.refreshPhotos === true)
        .map((r) => [r.cardId as string, { rowId: r.rowId, seq: r.seq, attempts: r.refreshAttempts ?? 0 }]),
    ),
    gone: gone.map(({ rowId, seq }) => ({ rowId, seq })),
    repoint: moved.map(({ rowId, seq, currentVariantId }) => ({
      rowId,
      seq,
      variantId: currentVariantId as Id<"selectorOptions">,
    })),
  };
}

/** One variant, start to finish. Never throws for a BSC failure. */
async function syncVariant(
  ctx: DrainCtx,
  args: {
    ownerId: string;
    platform: Platform;
    variantId: Id<"selectorOptions">;
    leaseToken: string;
  },
  getSession: () => Promise<SessionResult>,
  bindSeller: (accountId: string) => Promise<"bound" | "conflict" | "off">,
  opts: DrainOptions,
  tally: { conditionsRead: number },
  waitTarget: BscWaitTarget,
): Promise<VariantResult> {
  const { ownerId, platform, variantId, leaseToken } = args;
  const snapshot = await ctx.runQuery(internal.listingDrain.outboxSnapshot, { ownerId, platform, variantId });
  const rows = settleRows(snapshot, variantId);

  const claim = await ctx.runMutation(internal.listingDrain.claimVariant, {
    ownerId,
    platform,
    variantId,
    leaseToken,
  });
  if (!claim.claimed && claim.reason === "listingOff") return { kind: "off" };
  if (!claim.claimed) {
    // Another run (a Sync's) holds this variant. Re-point and drop what is
    // not ours to push; the rest waits.
    await ctx.runMutation(internal.listingDrain.finishVariant, {
      ownerId,
      platform,
      variantId,
      leaseToken,
      outcome: { kind: "error", error: "busy" },
      clear: rows.gone,
      repoint: rows.repoint,
    });
    return { kind: "skipped" };
  }

  // NEO-415: the run's steps, ticked off on the sync record as they land.
  const ledger = new ProgressLedger(ctx, { ownerId, platform, variantId, leaseToken }, opts.now);
  // NEO-481: rows of `mine` an ok finish still keeps: a photo refresh this run
  // could not finish (the upload cap, a fetch or an upload that failed) stays
  // queued, flag and all, for the next run, as eBay keeps a card queued.
  const keepRowIds = new Set<string>();
  // ...and each such row's try is counted, on an ok finish only (a run that
  // failed as a whole tried nothing for one card in particular).
  const refreshTried: Array<{ rowId: Id<"listingOutbox">; seq: number }> = [];
  // PR 451: this variant's ledger hears the session's BSC wait edges until it finishes.
  waitTarget.ledger = ledger;
  const finish = async (outcome: FinishOutcome, clearMine: boolean): Promise<unknown> => {
    await ledger.finishWaits();
    return await ctx.runMutation(internal.listingDrain.finishVariant, {
      ownerId,
      platform,
      variantId,
      leaseToken,
      outcome,
      clear: clearMine ? [...rows.mine.filter((r) => !keepRowIds.has(r.rowId)), ...rows.gone] : rows.gone,
      repoint: rows.repoint,
      progress: ledger.steps(),
      ...(clearMine && refreshTried.length > 0 ? { refreshTried } : {}),
    });
  };

  const input = await ctx.runQuery(internal.listingDrain.variantSyncInput, { ownerId, variantId });
  if (input.kind === "gone") {
    await finish({ kind: "error", error: "This variant is gone from NeonBinder." }, true);
    return { kind: "error" };
  }
  if (input.kind === "noScope") {
    await finish(
      {
        kind: "error",
        error: "This variant isn't linked to BuySportsCards, so nothing in it can list there yet.",
      },
      true,
    );
    return { kind: "error" };
  }
  if (input.kind === "noEra") {
    await finish(
      { kind: "error", error: "This set's year isn't one BuySportsCards can read, so NeonBinder can't pick its conditions." },
      true,
    );
    return { kind: "error" };
  }

  // NB's side: every card of the variant, and the owner's copies in it.
  const cards: NbVariantCard[] = [];
  for (let cursor: string | null = null; ; ) {
    const page: { cards: NbVariantCard[]; cursor: string; isDone: boolean } = await ctx.runQuery(
      internal.listingDrain.variantCardsPage,
      { variantId, cursor },
    );
    cards.push(...page.cards);
    if (page.isDone) break;
    cursor = page.cursor;
  }
  const copies: CopyOut[] = [];
  if (input.setId !== null) {
    for (let cursor: string | null = null; ; ) {
      const page: { copies: CopyOut[]; cursor: string; isDone: boolean } = await ctx.runQuery(
        internal.listingDrain.variantCopiesPage,
        { ownerId, setId: input.setId, variantId, cursor },
      );
      copies.push(...page.copies);
      if (page.isDone) break;
      cursor = page.cursor;
    }
  }
  const era: BscEra = input.era;
  const fold = foldBscTargets({
    copies: copies.map(
      (c): ListingCopy => ({
        copyId: c.copyId,
        homeId: c.homeId,
        card: { kind: "catalog", id: c.cardId },
        homeIsBox: c.homeIsBox,
        graded: c.graded,
        quantity: c.quantity,
        ...(c.condition !== undefined ? { condition: c.condition } : {}),
        ...(c.minPriceCents !== undefined ? { minPriceCents: c.minPriceCents } : {}),
        ...(c.acquiredOn !== undefined ? { acquiredOn: c.acquiredOn } : {}),
        creationTime: c.creationTime,
        hasPhotos: c.hasPhotos,
      }),
    ),
    era,
    commonPriceCents: input.commonPriceCents,
  });

  // Which condition sheets to read (NEO-475, Jason 2026-11-09): the targets'
  // conditions plus every condition NB has pushed before (so a row NB once
  // listed is still found and zeroed), on every run: a first sync and a Sync
  // press included. Never the whole era: a collector's own BSC stock under a
  // condition NB never listed in for this variant is left as it is.
  const conditions = [
    ...new Set([
      ...fold.targets.map((t) => t.bscCondition as string),
      ...claim.conditionsPushed.filter((c) => isBscConditionOfEra(c, era)),
    ]),
  ];

  const cardIds = new Set(cards.map((c) => c.cardId as string));
  const foldProblems = fold.problems;

  if (conditions.length === 0) {
    // Nothing to read or send: the compare with the boxes is the whole run.
    ledger.plan([{ key: "check", kind: "check" }]);
    await ledger.start("check");
    const stored = foldProblems.map((p) => toStoredProblem(p, cardIds)).filter((p): p is StoredProblem => p !== null);
    await finish(
      {
        kind: "ok",
        counts: { listed: 0, pushed: 0, zeroed: 0, skipped: distinctCards(stored) },
        problems: stored.slice(0, MAX_STORED_PROBLEMS),
        problemsTotal: stored.length,
        conditionsPushed: [],
      },
      true,
    );
    return { kind: "ok" };
  }

  // The plan: one read per condition sheet, then the send. Photos and the
  // confirms are added once the reads say whether they are needed.
  const reads = bscSheetSteps("read", conditions, era);
  ledger.plan([...reads.steps, { key: "send", kind: "send" }]);
  // NEO-489 — the first read starts BEFORE the session opens: the sign-in
  // (the token read) is BSC wait time, and a wait edge with no working step
  // shows nothing. `readSheets` starts the same key first (`reads.order[0]`,
  // the key it reads first, not `conditions[0]`), which is then a no-op. A
  // session that cannot open fails this step: the read it was signing in for.
  await ledger.start(reads.keyOf(reads.order[0]));

  const opened = await getSession();
  if (!opened.ok) {
    await finish({ kind: "error", error: opened.failure.message }, false);
    return { kind: "stop", failure: opened.failure };
  }
  const session = opened.value;

  const fail = async (failure: BscSellerFailure, problems?: StoredProblem[]): Promise<VariantResult> => {
    await finish(
      {
        kind: "error",
        error: failure.message,
        ...(problems ? { problems: problems.slice(0, MAX_STORED_PROBLEMS), problemsTotal: problems.length } : {}),
      },
      false,
    );
    return failure.kind === "signed_out" || failure.kind === "paused" || failure.kind === "no_token"
      ? { kind: "stop", failure }
      : { kind: "error" };
  };

  // Read every sheet that matters, one at a time, ticking each condition off.
  const retry = { pausesMs: BSC_SHEET_RETRY_PAUSES_MS, ...(opts.pause ? { pause: opts.pause } : {}) };
  const sheet = await readSheets(
    ctx,
    session,
    input.requests,
    reads.order,
    async (c) => {
      tally.conditionsRead += 1;
      await ledger.start(reads.keyOf(c));
    },
    retry,
  );
  if (!sheet.ok) return await fail(sheet.failure);

  // Seller id for the PUT: the stored account only (NEO-483). `claimDrain`
  // refuses a run without one, so a null here means it went under the run.
  const sellerId = input.sellerId;

  const planInput = {
    sheetRows: sheet.sheet,
    conditionsRead: conditions,
    targets: fold.targets,
    cards,
    cardNumberPrefixes: input.cardNumberPrefixes,
    refreshPhotoCardIds: rows.refreshCardIds,
  };
  const plan1 = planBscSheet(planInput);

  // Seller photos for rows that still show BSC's image, or whose card's photo
  // changed (NEO-481), and whose group has a copy with one.
  const photoKeys = await uploadPhotos(ctx, session, {
    ownerId,
    plan: plan1,
    targets: fold.targets,
    cards,
    sheetRows: sheet.sheet.rows,
    refreshCardIds: rows.refreshCardIds,
    fetchPhoto: opts.fetchPhoto ?? defaultFetchPhoto,
    onStart: async () => {
      ledger.add([{ key: "photos", kind: "photos" }], "send");
      await ledger.start("photos");
    },
  });
  if (!photoKeys.ok) return await fail(photoKeys.failure);
  // A refresh this run could not finish stays queued for the next, until its
  // last try: then the flag goes with the row and the Sync status tab says so.
  const refreshGaveUp: string[] = [];
  for (const cardId of photoKeys.refreshPending) {
    const refreshRow = rows.refreshRowOfCard.get(cardId);
    if (refreshRow && refreshRow.attempts + 1 >= MAX_PHOTO_REFRESH_ATTEMPTS) {
      refreshGaveUp.push(cardId);
      continue;
    }
    const rowId = rows.mineRowOfCard.get(cardId);
    if (rowId !== undefined) keepRowIds.add(rowId);
    if (refreshRow) refreshTried.push({ rowId: refreshRow.rowId, seq: refreshRow.seq });
  }

  const plan = photoKeys.value.size > 0 ? planBscSheet({ ...planInput, photoKeys: photoKeys.value }) : plan1;

  const problems: StoredProblem[] = [...foldProblems, ...plan.problems]
    .map((p) => toStoredProblem(p, cardIds))
    .filter((p): p is StoredProblem => p !== null);
  for (const cardId of refreshGaveUp) {
    problems.push({
      ...(cardIds.has(cardId) ? { cardId: cardId as Id<"cardChecklist"> } : {}),
      reason: "rejected",
      detail: PHOTO_REFRESH_GAVE_UP_DETAIL,
    });
  }

  // Conditions NB holds a listed row under (pushed now or already matching).
  const blockedCards = new Set(plan.problems.map((p) => p.cardId).filter((id): id is string => id !== undefined));
  const listedConditions = new Set(
    fold.targets.filter((t) => !blockedCards.has(t.cardId)).map((t) => t.bscCondition as string),
  );

  let pushed = 0;
  let zeroed = 0;
  // The send, and one confirm per condition it touches (era order); nothing
  // to send drops the send step.
  const touchedSet = new Set(plan.puts.map((p) => p.condition as string));
  const confirms = bscSheetSteps(
    "confirm",
    [...bscConditionsForEra(era).filter((c) => touchedSet.has(c)), ...touchedSet],
    era,
  );
  if (plan.puts.length === 0) ledger.drop("send");
  else {
    ledger.add(confirms.steps);
    await ledger.start("send");
  }
  if (plan.puts.length > 0) {
    if (sellerId === null) {
      return await fail(
        { kind: "bad_response", message: "BuySportsCards didn't say which seller account this is." },
        problems,
      );
    }
    // One NB owner per seller account, checked before anything is pushed.
    const binding = await bindSeller(sellerId);
    if (binding === "off") {
      await finish({ kind: "error", error: "Listing on BuySportsCards stopped part-way through (the sign-in was removed)." }, false);
      return { kind: "off" };
    }
    if (binding === "conflict") {
      await finish({ kind: "error", error: SELLER_CONFLICT_ERROR, problems: problems.slice(0, MAX_STORED_PROBLEMS), problemsTotal: problems.length }, false);
      return { kind: "sellerConflict" };
    }
    // NEO-475: the conditions this run lists under go on the record BEFORE
    // the first PUT. Reads are no longer the whole era, so a run that dies
    // after a PUT must still leave a later run reading (and able to zero)
    // what it sent. Zeroes need no entry: their condition was read, so it is
    // in use or already recorded.
    const sendingUnder = [...new Set(plan.puts.filter((p) => p.kind === "set").map((p) => p.condition as string))];
    if (sendingUnder.length > 0) {
      const recorded = await ctx.runMutation(internal.listingDrain.recordConditionsPushed, {
        ownerId,
        platform,
        variantId,
        leaseToken,
        conditions: sendingUnder,
      });
      // The variant's lease is gone (another run took it): send nothing.
      if (!recorded) {
        await finish({ kind: "error", error: "Listing on BuySportsCards stopped part-way through." }, false);
        return { kind: "error" };
      }
    }
    let putFailure: BscSellerFailure | null = null;
    for (const chunk of plan.chunks) {
      // Stopped mid-variant: push nothing more ("what the platform lists
      // is left as it is"). The variant's record is closed rather than left
      // "running"; it keeps the conditions this run may already have pushed,
      // so a later run still reads (and can zero) them.
      if (!(await ctx.runQuery(internal.listingDrain.drainHeld, { ownerId, platform, leaseToken }))) {
        await finish(
          {
            kind: "error",
            error: "Listing on BuySportsCards stopped part-way through (the sign-in was removed).",
            conditionsPushed: [...listedConditions],
          },
          false,
        );
        return { kind: "off" };
      }
      const put = await putBscListings(ctx, session, { sellerId, listings: chunk });
      if (!put.ok) {
        putFailure = put.failure;
        if (put.failure.kind === "signed_out") break;
      }
    }
    if (putFailure?.kind === "signed_out") return await fail(putFailure, problems);
    // A chunk BSC refused: the send failed, the read-back still runs.
    if (putFailure) ledger.fail("send");

    // Confirm by reading back every condition the push touched.
    const back = await readSheets(
      ctx,
      session,
      input.requests,
      confirms.order,
      (c) => ledger.start(confirms.keyOf(c)),
      retry,
    );
    if (!back.ok) return await fail(back.failure, problems);
    const after = new Map<string, number>();
    for (const row of back.sheet.rows) after.set(photoKeyFor(row.bscCardId, row.condition), row.quantity);
    logPhotoConfirm(plan.puts, back.sheet.rows);
    for (const put of plan.puts) {
      const shown = after.get(photoKeyFor(put.bscCardId, put.condition));
      if (shown === put.row.availableQuantity) {
        if (put.kind === "zero") zeroed += 1;
        else pushed += 1;
        continue;
      }
      problems.push({
        ...(put.cardId ? { cardId: put.cardId } : {}),
        platformCardId: put.bscCardId,
        reason: "rejected",
        detail: rejectedPushDetail(put.row.availableQuantity, put.condition, era),
      });
      if (put.kind === "set") listedConditions.delete(put.condition);
    }
    pushed += zeroed;
    if (putFailure) {
      // The last confirm landed; the run's failure is the send's.
      ledger.endWorking();
      await finish(
        {
          kind: "error",
          error: putFailure.message,
          problems: problems.slice(0, MAX_STORED_PROBLEMS),
          problemsTotal: problems.length,
          conditionsPushed: [...listedConditions],
        },
        false,
      );
      return { kind: "error" };
    }
  }

  await finish(
    {
      kind: "ok",
      counts: { listed: plan.counts.listed, pushed, zeroed, skipped: distinctCards(problems) },
      problems: problems.slice(0, MAX_STORED_PROBLEMS),
      problemsTotal: problems.length,
      conditionsPushed: [...listedConditions],
    },
    true,
  );
  return { kind: "ok" };
}

/**
 * NEO-481 (risk R2) — whether BSC now shows the seller photos this push sent,
 * as one log line: sides sent, sides shown, and the same two for sides sent
 * over a seller photo BSC already had (a refresh). Nothing in BSC's API says a
 * new image key on a PUT replaces an existing seller photo; this line is the
 * evidence on every run. Log only: counts, no ids or keys.
 */
export function logPhotoConfirm(puts: readonly PlannedBscPut[], rowsAfter: readonly BscSheetRow[]): void {
  const shownRows = new Map(rowsAfter.map((r) => [photoKeyFor(r.bscCardId, r.condition), r]));
  const tally = { sent: 0, shown: 0, replaced: 0, replacedShown: 0 };
  for (const put of puts) {
    if (put.kind !== "set") continue;
    for (const side of ["front", "back"] as const) {
      const sent = put.row[side === "front" ? "sellerImgFront" : "sellerImgBack"];
      if (typeof sent !== "string") continue;
      const row = shownRows.get(photoKeyFor(put.bscCardId, put.condition));
      const now = row ? (side === "front" ? row.sellerImgFront : row.sellerImgBack) : null;
      // BSC may answer the key with its own path in front: compare the file name.
      const shown = now !== null && now.endsWith(sent.slice(sent.lastIndexOf("/") + 1));
      const overSeller = !(side === "front" ? put.needsPhotoFront : put.needsPhotoBack);
      tally.sent += 1;
      if (shown) tally.shown += 1;
      if (overSeller) {
        tally.replaced += 1;
        if (shown) tally.replacedShown += 1;
      }
    }
  }
  if (tally.sent === 0) return;
  console.log(JSON.stringify({ msg: "bsc_photo_confirm", platform: "bsc", operation: "photoConfirm", ...tally }));
}

export function distinctCards(problems: readonly StoredProblem[]): number {
  return new Set(problems.map((p) => p.cardId).filter((id) => id !== undefined)).size;
}

/**
 * Every (condition × facet request) sheet, narrowed as each is read (only
 * readable rows are kept), rows deduped by BSC product id.
 *
 * One read at a time, on purpose. NEO-415 tried four concurrent reads per
 * seller and BSC's answers came back with two rows (two product ids) for one
 * card in one condition, so the planner held every card back as
 * `duplicate_sheet_row` and nothing listed or came down. Serial reads never
 * showed it. Keep this loop serial unless BSC is shown to answer overlapping
 * sheet reads for one seller correctly.
 *
 * NEO-475 — `retry.pausesMs`: a read BSC answers 503 is tried again, the same
 * condition and filters, after the next pause of the list; the list is shared
 * by the whole call (each pause is used once), so the waits are bounded
 * however many sheets there are. Still one read at a time: the retry starts
 * only after the 503 has answered and the pause has run, and the reads go on
 * from the condition that failed. Nothing else is retried here: a timeout or
 * any other status fails the call, and a 401 keeps `send`'s own one refresh.
 * Each retry logs one `bsc_sheet_retry` line (pause, attempt, outcome; no ids).
 */
export async function readSheets(
  ctx: DrainCtx,
  session: BscSellerSession,
  requests: ReadonlyArray<Record<string, string[]>>,
  conditions: readonly string[],
  /** NEO-415: awaited before a condition's first read (the ledger's step write); keeps the reads serial. */
  onCondition?: (condition: string) => Promise<void>,
  retry?: { pausesMs: readonly number[]; pause?: (ms: number) => Promise<void> },
): Promise<{ ok: true; sheet: NarrowedBscSheet } | { ok: false; failure: BscSellerFailure }> {
  const sheets: NarrowedBscSheet[] = [];
  const seenProducts = new Set<string>();
  const pauses = retry?.pausesMs ?? [];
  const pause = retry?.pause ?? realPause;
  let pausesUsed = 0;
  for (const condition of conditions) {
    await onCondition?.(condition);
    for (const filters of requests) {
      let attempt = 1;
      let r = await readBscSellerSheet(ctx, session, { filters, condition, attempt });
      while (!r.ok && isColdSheetAnswer(r.failure) && pausesUsed < pauses.length) {
        const pauseMs = pauses[pausesUsed];
        pausesUsed += 1;
        attempt += 1;
        await pause(pauseMs);
        const startedAt = Date.now();
        r = await readBscSellerSheet(ctx, session, { filters, condition, attempt });
        logSheetRetry(pauseMs, attempt, r, Date.now() - startedAt);
      }
      if (!r.ok) return { ok: false, failure: r.failure };
      const rows: BscSheetRow[] = [];
      for (const row of r.value.rows) {
        const productId = typeof row.raw.productId === "string" ? row.raw.productId : null;
        if (productId !== null) {
          if (seenProducts.has(productId)) continue;
          seenProducts.add(productId);
        }
        rows.push(row);
      }
      sheets.push({ ...r.value, rows });
    }
  }
  return { ok: true, sheet: joinNarrowedSheets(sheets) };
}

/** A 503 from BSC's gateway: the seller API was cold. The only answer `readSheets` retries. */
function isColdSheetAnswer(failure: BscSellerFailure): boolean {
  return failure.kind === "http" && failure.httpStatus === 503;
}

function realPause(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/** One line per sheet retry: the wait, which attempt, and how it went. No ids, no seller data. */
function logSheetRetry(
  pauseMs: number,
  attempt: number,
  r: BscSellerResult<NarrowedBscSheet>,
  durationMs: number,
): void {
  const outcome = r.ok
    ? "ok"
    : r.failure.kind === "http" && r.failure.httpStatus !== undefined
      ? `http_${r.failure.httpStatus}`
      : r.failure.kind;
  console.log(
    JSON.stringify({ msg: "bsc_sheet_retry", platform: "bsc", operation: "sheetRead", pauseMs, attempt, outcome, durationMs }),
  );
}

/**
 * Uploads the photo copy's photos (the oldest copy in the row's group with
 * any, NEO-427) for rows that still show BSC's own image, and (NEO-481) for
 * rows whose card's photo changed (`refreshCardIds`), over a seller photo too.
 * Only for targets the planner did not refuse. Capped per variant; the rest
 * go on a later run. A photo NB cannot fetch is skipped silently (the row
 * lists without it).
 *
 * `refreshPending`: the refreshed cards with a side this run meant to send
 * but did not (the cap, a fetch that came back empty, an upload BSC failed).
 * Their outbox rows stay queued, flag and all: unlike a stock image, a seller
 * photo already on BSC never tells a later run that NB's is missing. A side
 * the photo copy has no photo for (or one too big) is not pending: nothing
 * later would change that.
 */
async function uploadPhotos(
  ctx: DrainCtx,
  session: BscSellerSession,
  args: {
    ownerId: string;
    plan: BscSheetPlan;
    targets: readonly BscTarget[];
    cards: readonly NbVariantCard[];
    sheetRows: readonly BscSheetRow[];
    /** NEO-481: cards whose outbox row carries `refreshPhotos`. */
    refreshCardIds?: ReadonlySet<string>;
    fetchPhoto: (key: string, maxBytes: number) => Promise<ArrayBuffer | null>;
    /** NEO-415: awaited once, before the first upload, when any row wants a photo. */
    onStart?: () => Promise<void>;
  },
): Promise<
  | { ok: true; value: Map<string, BscPhotoKeys>; refreshPending: Set<string> }
  | { ok: false; failure: BscSellerFailure }
> {
  const keys = new Map<string, BscPhotoKeys>();
  const refreshPending = new Set<string>();
  const refused = new Set(args.plan.problems.map((p) => p.cardId).filter((id): id is string => id !== undefined));
  const refOf = new Map(args.cards.map((c) => [c.cardId as string, c.bscRef]));
  const rowsByKey = new Map<string, BscSheetRow>();
  for (const row of args.sheetRows) rowsByKey.set(photoKeyFor(row.bscCardId, row.condition), row);
  const wanted: Array<{
    key: string;
    cardId: string;
    copyId: Id<"collectionCopies">;
    front: boolean;
    back: boolean;
    refresh: boolean;
  }> = [];
  for (const t of args.targets) {
    if (refused.has(t.cardId) || t.photoCopyId === null) continue;
    const ref = refOf.get(t.cardId);
    if (!ref) continue;
    const key = photoKeyFor(ref, t.bscCondition);
    const row = rowsByKey.get(key);
    if (!row) continue;
    const refresh = args.refreshCardIds?.has(t.cardId) === true;
    const front = refresh || rowNeedsSellerPhoto(row, "front");
    const back = refresh || rowNeedsSellerPhoto(row, "back");
    if (front || back) wanted.push({ key, cardId: t.cardId, copyId: t.photoCopyId, front, back, refresh });
  }
  if (wanted.length === 0) return { ok: true, value: keys, refreshPending };
  await args.onStart?.();

  // `copyPhotosForListing` reads at most MAX_PHOTO_UPLOADS_PER_VARIANT copies;
  // a copy past them is one this run has no room for (the cap), not one
  // without a photo.
  const copyIds = [...new Set(wanted.map((w) => w.copyId))].slice(0, MAX_PHOTO_UPLOADS_PER_VARIANT);
  const read = new Set<string>(copyIds);
  const photos = await ctx.runQuery(internal.listingDrain.copyPhotosForListing, {
    ownerId: args.ownerId,
    copyIds,
  });
  let uploads = 0;
  for (const w of wanted) {
    for (const side of ["front", "back"] as const) {
      if (!(side === "front" ? w.front : w.back)) continue;
      const later = () => {
        if (w.refresh) refreshPending.add(w.cardId);
      };
      if (!read.has(w.copyId) || uploads >= MAX_PHOTO_UPLOADS_PER_VARIANT) {
        later();
        continue;
      }
      const photo = photos.find((p) => p.copyId === w.copyId && p.side === side);
      if (!photo || photo.imageBytes > MAX_COPY_PHOTO_BYTES) continue;
      let bytes: ArrayBuffer | null = null;
      try {
        bytes = await args.fetchPhoto(photo.key, MAX_COPY_PHOTO_BYTES);
      } catch {
        bytes = null;
      }
      if (!bytes) {
        later();
        continue;
      }
      uploads += 1;
      const up = await uploadBscSellerPhoto(ctx, session, {
        bytes,
        contentType: photo.contentType,
        fileName: `${side}.${photo.contentType === "image/webp" ? "webp" : "jpg"}`,
      });
      if (!up.ok) {
        if (up.failure.kind === "signed_out") return { ok: false, failure: up.failure };
        later();
        continue; // the row lists without this photo
      }
      const entry = keys.get(w.key) ?? {};
      entry[side] = up.value;
      keys.set(w.key, entry);
    }
  }
  return { ok: true, value: keys, refreshPending };
}

/**
 * The scheduled entry (`listingOutbox.kickListingDrain` schedules it; this
 * module reschedules it to continue). `fullVariantIds` asks for those
 * variants to run first, outbox rows or not (a Sync press). On BSC that run
 * reads what any run reads (NEO-475); eBay reads every card of them.
 */
export const drainOwner = internalAction({
  args: {
    ownerId: v.string(),
    platform: listingPlatformValidator,
    fullVariantIds: fullVariantIdsValidator,
    /** NEO-433: what links this run to the scheduled function id its kick stamped. */
    kickToken: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await drainOwnerImpl(ctx, args);
    return null;
  },
});
