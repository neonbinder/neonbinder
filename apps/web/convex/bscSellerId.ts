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
 * The chain stops when:
 *   - the account lands (from this chain or from any sign-in that returned
 *     it: `userProfile.setMarketplaceAccountIdInternal` → `landBscSellerId`),
 *   - the owner stops listing on BSC, BSC is paused, the row is gone, or a
 *     newer chain replaced this one (its token no longer matches),
 *   - BSC signed the owner out or no token can be read,
 *   - `BSC_SELLER_ID_FETCH_MAX_ATTEMPTS` reads failed (~39 min).
 * It is re-armed only by the next drain claim, save or sign-in. A 429, like
 * every other failed read, waits for the next scheduled tick: there is no
 * immediate retry (one attempt per tick, `fetchBscSellerId`'s `attempts: 1`).
 *
 * Cost: a tick is a handful of function calls and one BSC request, and runs
 * only for owners who list on BSC with no account stored.
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
 * A chain older than this is stale and a new one replaces it. Longer than a
 * whole chain (30 + 60 + 120 + 7 × 300 s, plus each read's wait), so a live
 * chain is never doubled; short enough that a chain whose tick was lost (a
 * deploy, a failed scheduled function) does not block the next for long.
 */
export const BSC_SELLER_ID_FETCH_STALE_MS = 45 * 60_000;

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
}): void {
  console.log(JSON.stringify({ msg: "bsc_seller_id_fetch", platform: "bsc", ...fields }));
}

/**
 * Starts the owner's background seller-account read unless one is under way.
 *
 * - `notListing`: the owner has no BSC state row, does not list there now
 *   (stopped, dormant, test marker) or BSC is paused. Nothing written.
 * - `inFlight`: a chain started under `BSC_SELLER_ID_FETCH_STALE_MS` ago is
 *   still running. Nothing written (its own schedule stands).
 * - `started`: a new chain was stamped on the row (replacing a stale one,
 *   whose ticks then stand down on the token) and its first read scheduled
 *   `opts.firstDelayMs` from now.
 *
 * Callers call it when no account is stored for the owner; a tick that
 * finds one stored stops without contacting BSC.
 */
export async function ensureBscSellerIdFetch(
  ctx: MutationCtx,
  ownerId: string,
  opts: { firstDelayMs: number },
): Promise<"started" | "inFlight" | "notListing"> {
  const state = await listingStateOf(ctx, ownerId, "bsc");
  if (!state || !pushesCountsNow(state)) return "notListing";
  const now = Date.now();
  if (state.sellerIdFetch !== undefined && now - state.sellerIdFetch.startedAt < BSC_SELLER_ID_FETCH_STALE_MS) {
    return "inFlight";
  }
  const token = newToken();
  const firstDelayMs = Math.max(0, opts.firstDelayMs);
  await ctx.db.patch(state._id, { sellerIdFetch: { token, startedAt: now }, lastUpdated: now });
  await ctx.scheduler.runAfter(firstDelayMs, internal.bscSellerId.fetchTick, { ownerId, token, attempt: 1 });
  logFetch({ operation: "ensure", outcome: "started", delayMs: firstDelayMs });
  return "started";
}

/**
 * The single place a landed BSC seller account is acted on, called by
 * `userProfile.setMarketplaceAccountIdInternal` after it stores the id on the
 * profile (from any sign-in that returned it, or from a chain's read).
 *
 * Clears any chain under way. Then, if the owner lists on BSC:
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
 * not import this module.
 */
export const ensureFetch = internalMutation({
  args: { ownerId: v.string(), firstDelayMs: v.optional(v.number()) },
  returns: v.union(v.literal("started"), v.literal("inFlight"), v.literal("notListing"), v.literal("known")),
  handler: async (ctx, args): Promise<"started" | "inFlight" | "notListing" | "known"> => {
    const profile = await ctx.db
      .query("userProfiles")
      .withIndex("by_user", (q) => q.eq("userId", args.ownerId))
      .first();
    if (profile?.marketplaceAccountIds?.bscSellerId) return "known";
    return await ensureBscSellerIdFetch(ctx, args.ownerId, {
      firstDelayMs: args.firstDelayMs ?? BSC_SELLER_ID_FETCH_DELAYS_MS[0],
    });
  },
});

/**
 * What a tick may do, read before BSC is contacted:
 * - `stale`: the row is gone or another chain owns it; write nothing.
 * - `stop`: this chain's work is over (the owner stopped listing, BSC is
 *   paused, or the account is already stored); clear the field.
 * - `go`: read the account.
 */
export const tickState = internalQuery({
  args: { ownerId: v.string(), token: v.string() },
  returns: v.union(v.literal("go"), v.literal("stop"), v.literal("stale")),
  handler: async (ctx, args): Promise<"go" | "stop" | "stale"> => {
    const state = await listingStateOf(ctx, args.ownerId, "bsc");
    if (!state || state.sellerIdFetch?.token !== args.token) return "stale";
    if (!pushesCountsNow(state)) return "stop";
    const profile = await ctx.db
      .query("userProfiles")
      .withIndex("by_user", (q) => q.eq("userId", args.ownerId))
      .first();
    if (profile?.marketplaceAccountIds?.bscSellerId) return "stop";
    return "go";
  },
});

/** Ends the chain named by `token`, if it still owns the row. */
export const stopChain = internalMutation({
  args: { ownerId: v.string(), token: v.string() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const state = await listingStateOf(ctx, args.ownerId, "bsc");
    if (!state || state.sellerIdFetch?.token !== args.token) return null;
    await ctx.db.patch(state._id, { sellerIdFetch: undefined, lastUpdated: Date.now() });
    return null;
  },
});

/**
 * After read `attempt` failed: schedules the next, or gives up (clears the
 * field) once `BSC_SELLER_ID_FETCH_MAX_ATTEMPTS` reads have failed. Does
 * nothing when the chain no longer owns the row.
 */
export const scheduleNext = internalMutation({
  args: { ownerId: v.string(), token: v.string(), attempt: v.number() },
  returns: v.union(v.literal("scheduled"), v.literal("gaveUp"), v.literal("stale")),
  handler: async (ctx, args): Promise<"scheduled" | "gaveUp" | "stale"> => {
    const state = await listingStateOf(ctx, args.ownerId, "bsc");
    if (!state || state.sellerIdFetch?.token !== args.token) return "stale";
    if (args.attempt >= BSC_SELLER_ID_FETCH_MAX_ATTEMPTS) {
      await ctx.db.patch(state._id, { sellerIdFetch: undefined, lastUpdated: Date.now() });
      logFetch({ operation: "tick", outcome: "gave_up", attempt: args.attempt });
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
 *   - signed out, no token or paused: the chain stops;
 *   - anything else (a timeout, a 429 or other non-2xx, a garbled body, an
 *     answer with no usable id): the next tick, or give up after the last.
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
    if (!result.ok && STOPPING_FAILURES.has(result.failure.kind)) {
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
      outcome: result.ok ? "no_account" : "failed",
      attempt: args.attempt,
      ...(result.ok ? {} : { failure: result.failure.kind }),
      ...(!result.ok && result.failure.httpStatus !== undefined ? { httpStatus: result.failure.httpStatus } : {}),
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
