/**
 * NEO-483 — the collector's BuySportsCards seller account, read in the
 * background when NB does not know it yet.
 *
 * A BSC listing names the seller account (`sellerId`) in every PUT. NB learns
 * it from BSC's profile endpoint, which stalls for long spells. Before this,
 * a sync that needed it read it live and failed when BSC stalled; now nothing
 * waits on that read. When the account is unknown for an owner who lists on
 * BSC, `ensureBscSellerIdFetch` starts one spaced chain of reads (one per
 * owner, deduplicated on the state row's `sellerIdFetch`), and the drain
 * holds its run (`awaitingSeller`) until the account lands.
 *
 * Schedule: the first read `firstDelayMs` after the chain starts (30 s after
 * a save or sign-in that found no account, 0 s when a drain claim finds
 * none), then 60 s, 120 s and 300 s after each failed read, then every 300 s.
 * The field is cleared only when the account is known: it lands (from this
 * chain or from any sign-in that returned it:
 * `userProfile.setMarketplaceAccountIdInternal` → `landBscSellerId`), or a
 * tick finds it already stored. A tick also stands down, writing nothing,
 * when the row is gone or a newer chain replaced this one.
 * The chain ENDS, and its field is kept with `endedAt` and `endReason`, when:
 *   - a tick finds nothing left to do for now (`stopped`): the owner stopped
 *     listing on BSC, BSC is paused or signed the owner out, or no token can
 *     be read,
 *   - BSC answered with no seller profile (`noSellerProfile`): the account is
 *     not set up to sell, and asking again will not change that,
 *   - `BSC_SELLER_ID_FETCH_MAX_ATTEMPTS` reads failed (`gaveUp`, ~39 min).
 * A 429, like every other failed read, waits for the next scheduled tick:
 * there is no immediate retry (one attempt per tick, `fetchBscSellerId`'s
 * `attempts: 1`).
 *
 * Re-arming (NEO-483 audit). Every hourly token renewal and every 15-minute
 * poll's drain claim calls `ensureBscSellerIdFetch`, so a chain that cleared
 * itself on giving up was started again at once, forever, for an account BSC
 * never answers for. An ended chain therefore stays on the row, and only a
 * user action (`userAction: true`: Connect or saving the BSC sign-in, the Sync
 * press, turning listing on) starts a new one before
 * `BSC_SELLER_ID_FETCH_COOLDOWN_MS` has passed. Renewals, Test Credentials and
 * scheduled claims get `coolingDown`. A user action itself waits out a floor
 * per end reason (`BSC_SELLER_ID_FETCH_USER_RETRY_MS`), so pressing Sync over
 * and over reads BSC at most once a minute (once per 5 min after BSC said
 * there is no seller profile). A `stopped` chain holds every caller to its
 * 60 s floor and no longer.
 *
 * Cost: a tick is a handful of function calls and one BSC request, and runs
 * only for owners who list on BSC with no account stored; at most one chain
 * per owner per cooldown unless the owner acts.
 *
 * The seller id is always read live from BSC and stored only on the
 * collector's profile and state row. Logs carry platform, operation, outcome,
 * attempt and timing, never the id, a token or an owner.
 */
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { MutationCtx } from "./_generated/server";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import {
  closeBscSellerSession,
  fetchBscSellerId,
  openBscSellerSession,
  type BscSellerFailureKind,
} from "./adapters/bscSeller";
import {
  kickListingDrain,
  listingStateOf,
  newToken,
  pushesCounts,
  pushesCountsNow,
  sellerAccountHolder,
} from "./listingOutbox";
import { isPlatformPaused } from "./marketplacePause";

/** The `credentials` site key for BuySportsCards. */
const SITE = "buysportscards" as const;

/**
 * The wait before each read. Index 0 is the default first wait (a save or
 * sign-in); after read N fails the next waits `[min(N, last)]`, so the last
 * entry repeats.
 */
export const BSC_SELLER_ID_FETCH_DELAYS_MS: ReadonlyArray<number> = [30_000, 60_000, 120_000, 300_000];

/** Reads per chain before it gives up (~39 min with a 30 s start). */
export const BSC_SELLER_ID_FETCH_MAX_ATTEMPTS = 10;

/**
 * A RUNNING chain older than this is stale and a new one replaces it. Longer
 * than a whole chain (30 + 60 + 120 + 7 × 300 s = 38.5 min, plus up to ten
 * reads' 20 s waits, ~42 min), with room for a slow scheduler, so a live
 * chain is never doubled; short enough that a chain whose tick was lost (a
 * deploy, a failed scheduled function) does not block the next for long.
 */
export const BSC_SELLER_ID_FETCH_STALE_MS = 60 * 60_000;

/**
 * After a chain ENDS (`gaveUp` or `noSellerProfile`), how long before
 * anything but a user action may start another. Token renewals (hourly) and
 * scheduled drain claims (every 15 min) would otherwise re-arm it at once.
 */
export const BSC_SELLER_ID_FETCH_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/**
 * Why an ended chain ended (`marketplaceListingStates.sellerIdFetch.endReason`):
 * - `gaveUp`: `BSC_SELLER_ID_FETCH_MAX_ATTEMPTS` reads failed;
 * - `noSellerProfile`: BSC answered with no seller profile;
 * - `stopped`: a tick found nothing left to do for now (the owner stopped
 *   listing, BSC is paused, BSC signed the owner out, no token could be
 *   read). Not a stall: Sync status shows no wait for it.
 * An ended chain with no reason (none is written so) reads as `gaveUp`.
 */
export type BscSellerIdFetchEndReason = "gaveUp" | "noSellerProfile" | "stopped";

/**
 * The floor a user action (Connect/save, Sync press, turning listing on) must
 * wait after a chain ENDED before it may start another, per end reason and
 * per state row (so per owner, not per set). Without it a scripted Sync press
 * loop on an account BSC says has no seller profile would read BSC every few
 * seconds. `stopped` holds every caller, user or not, to its floor (no 6 h
 * cooldown: the stop was not BSC's answer, so a renewal or a drain claim may
 * resume the read once the floor has passed).
 */
export const BSC_SELLER_ID_FETCH_USER_RETRY_MS: Readonly<Record<BscSellerIdFetchEndReason, number>> = {
  gaveUp: 60_000,
  noSellerProfile: 5 * 60_000,
  stopped: 60_000,
};

/**
 * How long after `chain` ended a caller must wait before replacing it: the
 * user-action floor for a user action or a stopped chain, the cooldown
 * otherwise.
 */
function endedChainWaitMs(endReason: BscSellerIdFetchEndReason, userAction: boolean): number {
  if (userAction || endReason === "stopped") return BSC_SELLER_ID_FETCH_USER_RETRY_MS[endReason];
  return BSC_SELLER_ID_FETCH_COOLDOWN_MS;
}

/** What `ensureBscSellerIdFetch` did. */
export type EnsureBscSellerIdFetchResult = "started" | "inFlight" | "coolingDown" | "notListing";

/** One read's wait for BSC's answer, headers and body. */
export const BSC_SELLER_ID_FETCH_TIMEOUT_MS = 20_000;

/** The wait before read `attempt + 1`, after read `attempt` (1-based) failed. */
export function bscSellerIdFetchDelayAfter(attempt: number): number {
  const i = Math.min(Math.max(attempt, 0), BSC_SELLER_ID_FETCH_DELAYS_MS.length - 1);
  return BSC_SELLER_ID_FETCH_DELAYS_MS[i];
}

function logFetch(fields: {
  operation: string;
  outcome: string;
  attempt?: number;
  delayMs?: number;
  failure?: BscSellerFailureKind;
  httpStatus?: number;
  durationMs?: number;
  endReason?: BscSellerIdFetchEndReason;
  userAction?: boolean;
}): void {
  console.log(JSON.stringify({ msg: "bsc_seller_id_fetch", platform: "bsc", ...fields }));
}

/**
 * Starts the owner's background seller-account read unless one is under way
 * or one ended recently.
 *
 * - `notListing`: the owner has no BSC state row, does not list there now
 *   (stopped, dormant, test marker) or BSC is paused. Nothing written.
 * - `inFlight`: a RUNNING chain (no `endedAt`) started under
 *   `BSC_SELLER_ID_FETCH_STALE_MS` ago. Nothing written (its own schedule
 *   stands). `userAction` does not override this.
 * - `coolingDown`: an ENDED chain ended too recently to replace. A user
 *   action waits out `BSC_SELLER_ID_FETCH_USER_RETRY_MS[endReason]` (60 s
 *   after `gaveUp`, 5 min after `noSellerProfile`); anything else waits
 *   `BSC_SELLER_ID_FETCH_COOLDOWN_MS` (6 h), except after `stopped`, where
 *   every caller waits only the 60 s floor. Nothing written, nothing
 *   scheduled.
 * - `started`: a new chain was stamped on the row (replacing a stale or
 *   ended one, whose ticks then stand down on the token) and its first read
 *   scheduled `opts.firstDelayMs` from now.
 *
 * `opts.userAction` is true only for something the collector did: Connect or
 * saving the BSC sign-in, the Sync press, turning listing on. Token renewals,
 * Test Credentials and scheduled drain claims leave it unset.
 *
 * Callers call it when no account is stored for the owner; a tick that
 * finds one stored stops without contacting BSC.
 */
export async function ensureBscSellerIdFetch(
  ctx: MutationCtx,
  ownerId: string,
  opts: { firstDelayMs: number; userAction?: boolean },
): Promise<EnsureBscSellerIdFetchResult> {
  const state = await listingStateOf(ctx, ownerId, "bsc");
  if (!state || !pushesCountsNow(state)) return "notListing";
  const now = Date.now();
  const chain = state.sellerIdFetch;
  if (chain !== undefined) {
    if (chain.endedAt === undefined) {
      if (now - chain.startedAt < BSC_SELLER_ID_FETCH_STALE_MS) return "inFlight";
    } else {
      const endReason = chain.endReason ?? "gaveUp";
      if (now - chain.endedAt < endedChainWaitMs(endReason, opts.userAction === true)) {
        logFetch({
          operation: "ensure",
          outcome: "cooling_down",
          endReason,
          ...(opts.userAction === true ? { userAction: true } : {}),
        });
        return "coolingDown";
      }
    }
  }
  const token = newToken();
  const firstDelayMs = Math.max(0, opts.firstDelayMs);
  await ctx.db.patch(state._id, { sellerIdFetch: { token, startedAt: now }, lastUpdated: now });
  await ctx.scheduler.runAfter(firstDelayMs, internal.bscSellerId.fetchTick, { ownerId, token, attempt: 1 });
  logFetch({
    operation: "ensure",
    outcome: "started",
    delayMs: firstDelayMs,
    ...(opts.userAction === true ? { userAction: true } : {}),
  });
  return "started";
}

/**
 * The single place a landed BSC seller account is acted on, called by
 * `userProfile.setMarketplaceAccountIdInternal` after it stores the id on the
 * profile (from any sign-in that returned it, or from a chain's read).
 *
 * Clears any chain, running or ended. Then, if the owner lists on BSC:
 *   - another NB owner who lists now holds the account
 *     (`listingOutbox.sellerAccountHolder`): the row goes dormant
 *     `sellerConflict` and the account is not stamped on it (the same
 *     outcome as the drain's `bindSellerAccount`);
 *   - otherwise the account is stamped (`platformAccountId`) and, when it was
 *     newly learned or a chain was waiting for it, the drain is kicked so a
 *     run held for the account goes now.
 * An owner who does not list gets only the chain cleared; setup reads the
 * profile's id when listing starts.
 */
export async function landBscSellerId(ctx: MutationCtx, ownerId: string, accountId: string): Promise<void> {
  const state = await listingStateOf(ctx, ownerId, "bsc");
  if (!state) return;
  const now = Date.now();
  const wasWaiting = state.sellerIdFetch !== undefined;
  const clearChain = wasWaiting ? { sellerIdFetch: undefined } : {};
  if (!pushesCounts(state)) {
    if (wasWaiting) await ctx.db.patch(state._id, { ...clearChain, lastUpdated: now });
    return;
  }
  if (await sellerAccountHolder(ctx, "bsc", accountId, ownerId)) {
    await ctx.db.patch(state._id, { ...clearChain, dormant: "sellerConflict", lastUpdated: now });
    console.warn(
      JSON.stringify({ msg: "listing_seller_conflict", platform: "bsc", operation: "landBscSellerId" }),
    );
    return;
  }
  const newlyKnown = state.platformAccountId !== accountId;
  if (newlyKnown || wasWaiting) {
    await ctx.db.patch(state._id, {
      ...clearChain,
      ...(newlyKnown ? { platformAccountId: accountId } : {}),
      lastUpdated: now,
    });
    await kickListingDrain(ctx, ownerId, "bsc");
  }
}

/**
 * `ensureBscSellerIdFetch` for an action (a sign-in that came back without a
 * seller account, `credentials.runSiteLogin`). Does nothing when the profile
 * already stores one (`known`). `firstDelayMs` defaults to the save/sign-in
 * wait (`BSC_SELLER_ID_FETCH_DELAYS_MS[0]`), so a `"use node"` caller need
 * not import this module. `userAction`: see `ensureBscSellerIdFetch` (true
 * for a Connect/save, unset for a renewal or Test Credentials).
 */
export const ensureFetch = internalMutation({
  args: { ownerId: v.string(), firstDelayMs: v.optional(v.number()), userAction: v.optional(v.boolean()) },
  returns: v.union(
    v.literal("started"),
    v.literal("inFlight"),
    v.literal("coolingDown"),
    v.literal("notListing"),
    v.literal("known"),
  ),
  handler: async (ctx, args): Promise<EnsureBscSellerIdFetchResult | "known"> => {
    const profile = await ctx.db
      .query("userProfiles")
      .withIndex("by_user", (q) => q.eq("userId", args.ownerId))
      .first();
    if (profile?.marketplaceAccountIds?.bscSellerId) return "known";
    return await ensureBscSellerIdFetch(ctx, args.ownerId, {
      firstDelayMs: args.firstDelayMs ?? BSC_SELLER_ID_FETCH_DELAYS_MS[0],
      ...(args.userAction === true ? { userAction: true } : {}),
    });
  },
});

/**
 * What a tick may do, read before BSC is contacted:
 * - `stale`: the row is gone, another chain owns it, or this chain has
 *   already ended; write nothing.
 * - `stop`: this chain's work is over (the owner stopped listing, BSC is
 *   paused, or the account is already stored); `stopChain` ends it
 *   `stopped`, or clears the field when the account is stored.
 * - `go`: read the account.
 */
export const tickState = internalQuery({
  args: { ownerId: v.string(), token: v.string() },
  returns: v.union(v.literal("go"), v.literal("stop"), v.literal("stale")),
  handler: async (ctx, args): Promise<"go" | "stop" | "stale"> => {
    const state = await listingStateOf(ctx, args.ownerId, "bsc");
    if (!state || !runningChainOwns(state, args.token)) return "stale";
    if (!pushesCountsNow(state)) return "stop";
    const profile = await ctx.db
      .query("userProfiles")
      .withIndex("by_user", (q) => q.eq("userId", args.ownerId))
      .first();
    if (profile?.marketplaceAccountIds?.bscSellerId) return "stop";
    return "go";
  },
});

/** True when `state` holds a RUNNING chain named `token`. */
function runningChainOwns(state: { sellerIdFetch?: { token: string; endedAt?: number } }, token: string): boolean {
  return state.sellerIdFetch?.token === token && state.sellerIdFetch.endedAt === undefined;
}

/**
 * Stops the RUNNING chain named by `token`, if it still owns the row:
 * - the account is already stored: the field is cleared (as a landing does);
 * - otherwise (the owner stopped listing, BSC is paused or signed the owner
 *   out, no token could be read): the chain ENDS `stopped`, the field kept,
 *   so nothing restarts it inside `BSC_SELLER_ID_FETCH_USER_RETRY_MS.stopped`
 *   (a cleared field let a Sync press loop restart it at once).
 */
export const stopChain = internalMutation({
  args: { ownerId: v.string(), token: v.string() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const state = await listingStateOf(ctx, args.ownerId, "bsc");
    if (!state || !runningChainOwns(state, args.token)) return null;
    const profile = await ctx.db
      .query("userProfiles")
      .withIndex("by_user", (q) => q.eq("userId", args.ownerId))
      .first();
    if (profile?.marketplaceAccountIds?.bscSellerId) {
      await ctx.db.patch(state._id, { sellerIdFetch: undefined, lastUpdated: Date.now() });
      return null;
    }
    await endChain(ctx, args.ownerId, args.token, "stopped");
    return null;
  },
});

/**
 * Ends the RUNNING chain named by `token`: keeps the field with `endedAt`
 * and `endReason`, so renewals and scheduled claims cool down
 * (`ensureBscSellerIdFetch`). False when the chain no longer owns the row or
 * has already ended.
 */
async function endChain(
  ctx: MutationCtx,
  ownerId: string,
  token: string,
  endReason: BscSellerIdFetchEndReason,
): Promise<boolean> {
  const state = await listingStateOf(ctx, ownerId, "bsc");
  const chain = state?.sellerIdFetch;
  if (!state || chain === undefined || !runningChainOwns(state, token)) return false;
  const now = Date.now();
  await ctx.db.patch(state._id, {
    sellerIdFetch: { token, startedAt: chain.startedAt, endedAt: now, endReason },
    lastUpdated: now,
  });
  return true;
}

/**
 * BSC answered the profile read (2xx) with no seller profile: the account is
 * not set up to sell. Terminal for this chain (`endReason: "noSellerProfile"`).
 */
export const endChainNoSellerProfile = internalMutation({
  args: { ownerId: v.string(), token: v.string() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    await endChain(ctx, args.ownerId, args.token, "noSellerProfile");
    return null;
  },
});

/**
 * After read `attempt` failed: schedules the next, or ends the chain
 * (`endReason: "gaveUp"`, the field kept) once
 * `BSC_SELLER_ID_FETCH_MAX_ATTEMPTS` reads have failed. Does nothing when the
 * chain no longer owns the row or has already ended.
 */
export const scheduleNext = internalMutation({
  args: { ownerId: v.string(), token: v.string(), attempt: v.number() },
  returns: v.union(v.literal("scheduled"), v.literal("gaveUp"), v.literal("stale")),
  handler: async (ctx, args): Promise<"scheduled" | "gaveUp" | "stale"> => {
    const state = await listingStateOf(ctx, args.ownerId, "bsc");
    if (!state || !runningChainOwns(state, args.token)) return "stale";
    if (args.attempt >= BSC_SELLER_ID_FETCH_MAX_ATTEMPTS) {
      await endChain(ctx, args.ownerId, args.token, "gaveUp");
      logFetch({ operation: "tick", outcome: "gave_up", attempt: args.attempt, endReason: "gaveUp" });
      return "gaveUp";
    }
    const delayMs = bscSellerIdFetchDelayAfter(args.attempt);
    await ctx.scheduler.runAfter(delayMs, internal.bscSellerId.fetchTick, {
      ownerId: args.ownerId,
      token: args.token,
      attempt: args.attempt + 1,
    });
    logFetch({ operation: "tick", outcome: "next_scheduled", attempt: args.attempt, delayMs });
    return "scheduled";
  },
});

/** Failures after which another read cannot help until the owner acts. */
const STOPPING_FAILURES: ReadonlySet<BscSellerFailureKind> = new Set(["signed_out", "no_token", "paused"]);

/**
 * One read of the owner's seller account. Checks its row first (the chain
 * still owns it, the owner still lists, BSC not paused, no account stored),
 * so a stopped chain never contacts BSC. Then one profile read, one attempt,
 * `BSC_SELLER_ID_FETCH_TIMEOUT_MS`:
 *   - an id: stored through `userProfile.setMarketplaceAccountIdInternal`,
 *     which lands it (`landBscSellerId`: clears the chain, binds, kicks);
 *   - a 2xx with no seller profile (or no usable id in it): the chain ends
 *     (`noSellerProfile`): BSC has answered, and reading again will not
 *     change it until the collector finishes seller setup and acts;
 *   - signed out, no token or paused: the chain ends `stopped` (`stopChain`);
 *   - anything else (a timeout, a 429 or other non-2xx, a garbled body): the
 *     next tick, or give up (`gaveUp`) after the last.
 */
export const fetchTick = internalAction({
  args: { ownerId: v.string(), token: v.string(), attempt: v.number() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const startedAt = Date.now();
    if (isPlatformPaused(SITE)) {
      await ctx.runMutation(internal.bscSellerId.stopChain, { ownerId: args.ownerId, token: args.token });
      logFetch({ operation: "tick", outcome: "paused", attempt: args.attempt });
      return null;
    }
    const gate = await ctx.runQuery(internal.bscSellerId.tickState, { ownerId: args.ownerId, token: args.token });
    if (gate === "stale") {
      logFetch({ operation: "tick", outcome: "stale", attempt: args.attempt });
      return null;
    }
    if (gate === "stop") {
      await ctx.runMutation(internal.bscSellerId.stopChain, { ownerId: args.ownerId, token: args.token });
      logFetch({ operation: "tick", outcome: "stopped", attempt: args.attempt });
      return null;
    }

    const opened = await openBscSellerSession(ctx, args.ownerId, { op: "bscSellerIdFetch" });
    if (!opened.ok) {
      if (STOPPING_FAILURES.has(opened.failure.kind)) {
        await ctx.runMutation(internal.bscSellerId.stopChain, { ownerId: args.ownerId, token: args.token });
        logFetch({
          operation: "tick",
          outcome: "stopped",
          attempt: args.attempt,
          failure: opened.failure.kind,
          durationMs: Date.now() - startedAt,
        });
        return null;
      }
      await ctx.runMutation(internal.bscSellerId.scheduleNext, {
        ownerId: args.ownerId,
        token: args.token,
        attempt: args.attempt,
      });
      return null;
    }
    const session = opened.value;
    let result: Awaited<ReturnType<typeof fetchBscSellerId>>;
    try {
      result = await fetchBscSellerId(ctx, session, { attempts: 1, timeoutMs: BSC_SELLER_ID_FETCH_TIMEOUT_MS });
    } finally {
      await closeBscSellerSession(ctx, session);
    }

    if (result.ok && result.value !== null) {
      await ctx.runMutation(internal.userProfile.setMarketplaceAccountIdInternal, {
        userId: args.ownerId,
        site: SITE,
        accountId: result.value,
      });
      logFetch({ operation: "tick", outcome: "landed", attempt: args.attempt, durationMs: Date.now() - startedAt });
      return null;
    }
    if (result.ok) {
      await ctx.runMutation(internal.bscSellerId.endChainNoSellerProfile, {
        ownerId: args.ownerId,
        token: args.token,
      });
      logFetch({
        operation: "tick",
        outcome: "no_seller_profile",
        attempt: args.attempt,
        endReason: "noSellerProfile",
        durationMs: Date.now() - startedAt,
      });
      return null;
    }
    if (STOPPING_FAILURES.has(result.failure.kind)) {
      await ctx.runMutation(internal.bscSellerId.stopChain, { ownerId: args.ownerId, token: args.token });
      logFetch({
        operation: "tick",
        outcome: "stopped",
        attempt: args.attempt,
        failure: result.failure.kind,
        durationMs: Date.now() - startedAt,
      });
      return null;
    }
    logFetch({
      operation: "tick",
      outcome: "failed",
      attempt: args.attempt,
      failure: result.failure.kind,
      ...(result.failure.httpStatus !== undefined ? { httpStatus: result.failure.httpStatus } : {}),
      durationMs: Date.now() - startedAt,
    });
    await ctx.runMutation(internal.bscSellerId.scheduleNext, {
      ownerId: args.ownerId,
      token: args.token,
      attempt: args.attempt,
    });
    return null;
  },
});
