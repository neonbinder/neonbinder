/**
 * NEO-415 — a collector's eBay seller connection and the settings eBay needs
 * before NeonBinder lists anything there.
 *
 * eBay signs in by OAuth consent, never by password: `beginConnect` mints a
 * one-use nonce (the OAuth `state`, which also names the origin to come back
 * to) and hands the web eBay's consent URL; eBay redirects to NB's fixed
 * return page (NEO-422), which forwards to the web with `code` and `state`;
 * `completeConnect`
 * checks the nonce and has the browser service exchange the code and store
 * the session (`credentials.connectEbay`). Convex holds no eBay token or
 * client secret: only the has-credentials flag, the seller's eBay user id
 * (the one-owner-per-account key) and the display username.
 *
 * Connected = listing (NEO-370 Revision 5), but nothing reaches eBay until
 * the collector's settings are complete (`lib/ebayListing.ebaySetupMissing`):
 * two shipping policies (cards under $20, and $20 and up), a payment and a
 * return policy (the collector's OWN eBay business policies, read in, or
 * NB's standard ones made on their account by "Set me up"), and a ship-from
 * location. Until then the drain refuses with `setupIncomplete`
 * (`listingDrain.claimDrain`) and the queue waits. A settings save re-queues
 * the owner's listed boxes so every live listing picks the change up.
 *
 * Also here: eBay's Marketplace Account Deletion endpoint (registered on
 * eBay's developer portal; required before production keys work), routed by
 * `http.ts`.
 *
 * Every eBay value read here (policy names and ids, service codes) is
 * linkage or a choice the collector makes; none decides NB behaviour on its
 * own, and the ESE-only check reads eBay's service CODE, never a name.
 */
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import type { ActionCtx, MutationCtx, QueryCtx } from "./_generated/server";
import {
  action,
  httpAction,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { requireSignedIn } from "./auth";
import { isPlatformPaused } from "./marketplacePause";
import { kickListingDrain, listingStateOf, pushesCounts, stopListingForSite } from "./listingOutbox";
import { platformSettings } from "./listingSync";
import { ebayAuthorizeUrl, ebayConfig, ebayConfigured, type EbayEnvironment } from "./lib/ebayEnv";
import {
  EBAY_COST_TYPE_CALCULATED,
  EBAY_COST_TYPE_FLAT_RATE,
  EBAY_ESE_CARRIER_FALLBACK,
  EBAY_ESE_SERVICE_CODE,
  EBAY_MARKETPLACE_ID,
  EBAY_MERCHANT_LOCATION_KEY,
  EBAY_USPS_CARRIER_FALLBACK,
  ebayGroundAdvantageService,
  ebayServiceCarrier,
  ebayServiceNames,
  ebaySetupMissing,
  ebayServiceTakesCalculated,
  isRecord,
  isUsPostalCode,
  isUsStateCode,
  policyFitness,
  readFulfillmentPolicies,
  readPaymentPolicies,
  readReturnPolicies,
  type EbaySetupItem,
} from "./lib/ebayListing";
import {
  SELLING_POLICY_MANAGEMENT,
  createPolicy,
  getOptedInPrograms,
  getPolicies,
  getShippingServices,
  openEbaySellerSession,
  optInToProgram,
  sayEbayFailure as sayEbayStepFailure,
  upsertInventoryLocation,
  type EbayFailure,
  type EbaySellerSession,
  type EbayShippingServiceInfo,
} from "./adapters/ebaySeller";
import type { EbayConnectError } from "./credentials";
import { encodeEbayReturnState, isAllowedEbayReturnOrigin } from "../lib/marketplace/ebay-oauth-return";

// ── Copy (NB voice; the web shows these sentences as they are) ─────────────

const NOT_CONFIGURED = "eBay isn't hooked up on this NeonBinder yet.";
const PAUSED = "eBay is on pause for now. Check back soon.";
const NOT_CONNECTED = "Connect your eBay seller account first.";
const NONCE_STALE = "That eBay hookup timed out. Press Connect again.";
const ACCOUNT_SWITCH = "Disconnect eBay first, then connect the other account.";
const CONNECT_ERRORS: Record<EbayConnectError, string> = {
  busy: "NeonBinder is already working on your eBay hookup. Give it a sec and try again.",
  notConfigured: NOT_CONFIGURED,
  consentRefused: "eBay didn't let that one through. Press Connect and say yes on eBay's page.",
  unavailable: "eBay's not answering right now. Try again in a bit.",
  serviceNotReady: "NeonBinder's eBay hookup is still warming up. Try again in a few minutes.",
  badRequest: "That eBay answer didn't look right. Press Connect again.",
  internal: "Something hiccuped on our side. Try again in a bit.",
  accountSwitch: ACCOUNT_SWITCH,
  environmentMismatch: "NeonBinder's eBay hookup is crossed up on our side. We're on it; try again later.",
};
const ESE_FOR_20_PLUS =
  "Standard Envelope only covers cards under $20. Pick a policy with tracked shipping for cards $20 and up.";
const POLICY_GONE = "eBay doesn't have that policy on your account anymore. Pick another.";
const OPT_IN_PENDING =
  "eBay is still switching on business policies for your account. Try Set me up again in a few minutes.";
const SHIP_FROM_FIRST =
  "Save where you ship from first. eBay works out each buyer's shipping from your ZIP code and the card's weight.";
const LOCATION_REFUSED = "eBay wouldn't take that address. Check the ZIP, city and state, then save again.";
const POLICIES_REFUSED = "eBay wouldn't hand over your policies just now. Try again in a bit.";
const OPT_IN_REFUSED =
  "eBay wouldn't switch on business policies for your account. Try Set me up again in a bit, or switch them on in eBay's Seller Hub.";
const SERVICES_REFUSED = "eBay wouldn't list its shipping services just now. Try Set me up again in a bit.";
const NO_GROUND_ADVANTAGE = "eBay didn't offer USPS Ground Advantage, so NeonBinder couldn't make tracked shipping.";
/** Set me up hit a busy or unreadable eBay: pressing again is safe, since it finds what it made by name. */
const SET_ME_UP_BUSY = "eBay's not answering right now. Press Set me up again in a bit; it never makes anything twice.";
/** Which of NB's standard policies eBay refused, and what the collector can do instead. */
const SET_ME_UP_REFUSED = {
  ese: "eBay turned down the Standard Envelope policy, so Set me up stopped there. Pick one of your own shipping policies for cards under $20, or make one on eBay and come back.",
  tracked:
    "eBay turned down the tracked USPS Ground Advantage policy, so Set me up stopped there. Pick one of your own shipping policies for cards $20 and up, or make one on eBay and come back.",
  free: "eBay turned down the free shipping policy, so Set me up stopped there. Pick one of your own shipping policies, or make one on eBay and come back.",
  payment: "eBay turned down the payment policy, so Set me up stopped there. Make a payment policy on eBay, then pick it here.",
  returns: "eBay turned down the returns policy, so Set me up stopped there. Make a return policy on eBay, then pick it here.",
} as const;
const NO_CALCULATED = (service: string) =>
  `eBay isn't offering weight-based rates for ${service} on your account, so NeonBinder made nothing. Pick your own shipping policies instead.`;

/** How long a Connect press's nonce is good for. */
const CONNECT_NONCE_TTL_MS = 15 * 60 * 1000;
const MAX_CODE_LENGTH = 4096;
/**
 * The longest `state` NB issues or accepts back. NEO-422's composite state is
 * the 48-hex nonce, a dot, and base64url of the origin Connect was pressed
 * on; the longest origin the return pages forward to (a Vercel hash preview,
 * `https://neonbinder-<9>-neon-binder.vercel.app`, 51 chars) makes 48 + 1 +
 * 68 = 117. An origin too long to fit could never be one the return page
 * forwards to, so `returnStateFor` falls back to the bare nonce for it.
 */
const MAX_STATE_LENGTH = 128;
/** A cheap cap before parsing: anything longer cannot fit MAX_STATE_LENGTH anyway. */
const MAX_RETURN_ORIGIN_LENGTH = 256;
/**
 * Where both RuNames' accept URLs live (NEO-422): the production keyset's
 * points at `/oauth/ebay/return`, the sandbox keyset's at
 * `/oauth/ebay/sandbox-return`, both on this origin.
 */
const EBAY_RETURN_PAGE_ORIGIN = "https://www.neonbinder.io";
const MAX_POLICY_ID = 64;
/** Rows one purge or listing page touches. */
const PURGE_PAGE = 200;
/** Sale rows one purge page deletes (they are the larger rows). */
const SALES_PURGE_PAGE = 100;

/** NB's standard policies "Set me up" makes on the seller's account (names are the idempotency key). */
export const NB_POLICY_NAMES = {
  ese: "NB Standard Envelope (under $20)",
  tracked: "NB Tracked (USPS Ground Advantage)",
  free: "NB Free Shipping",
  payment: "NB Payment",
  returns: "NB Returns (30 days)",
} as const;
/**
 * Defaults for those policies. Product defaults, open for Jason to change.
 * No shipping amounts: the envelope and tracked policies are CALCULATED, so
 * buyers pay eBay's own rate for the card's package weight
 * (lib/ebayListing.ts `ebayPackageFor`) from the seller's ship-from ZIP.
 */
const NB_POLICY_DEFAULTS = {
  handlingDays: 1,
  returnDays: 30,
} as const;

// ── Shapes ─────────────────────────────────────────────────────────────────

const locationValidator = v.object({
  postalCode: v.string(),
  city: v.string(),
  stateOrProvince: v.string(),
});

const setupItemValidator = v.union(
  v.literal("location"),
  v.literal("shippingUnder20"),
  v.literal("shipping20Plus"),
  v.literal("payment"),
  v.literal("returns"),
);

const connectionStateValidator = v.object({
  configured: v.boolean(),
  environment: v.union(v.literal("sandbox"), v.literal("production"), v.null()),
  status: v.union(
    v.literal("notConnected"),
    v.literal("connected"),
    v.literal("needsReauth"),
    v.literal("paused"),
    v.literal("sellerConflict"),
  ),
  ebayUsername: v.union(v.string(), v.null()),
  since: v.union(v.number(), v.null()),
  settings: v.object({
    fulfillmentPolicyUnder20Id: v.union(v.string(), v.null()),
    fulfillmentPolicy20PlusId: v.union(v.string(), v.null()),
    paymentPolicyId: v.union(v.string(), v.null()),
    returnPolicyId: v.union(v.string(), v.null()),
    location: v.union(locationValidator, v.null()),
    bestOffer: v.boolean(),
  }),
  setupComplete: v.boolean(),
  missing: v.array(setupItemValidator),
});

const errorResult = v.object({ ok: v.literal(false), error: v.string() });
type Fail = { ok: false; error: string };

async function settingsOf(
  ctx: Pick<QueryCtx, "db">,
  ownerId: string,
): Promise<Doc<"ebaySellerSettings"> | null> {
  return await ctx.db
    .query("ebaySellerSettings")
    .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
    .unique();
}

/** Get-or-create the owner's settings row, then patch it. */
async function patchSettings(
  ctx: MutationCtx,
  ownerId: string,
  patch: Partial<Omit<Doc<"ebaySellerSettings">, "_id" | "_creationTime" | "ownerId">>,
): Promise<void> {
  const now = Date.now();
  const row = await settingsOf(ctx, ownerId);
  if (row) await ctx.db.patch(row._id, { ...patch, lastUpdated: now });
  else await ctx.db.insert("ebaySellerSettings", { ownerId, ...patch, lastUpdated: now });
}

/**
 * The settings changed: every card the owner has in listed boxes is queued
 * again for eBay (the walk a saved sign-in starts, whose last page kicks the
 * drain), so live listings pick up the new policies or Best Offer, and a
 * queue that waited on `setupIncomplete` runs. Not listing: nothing to do.
 */
async function settingsChanged(ctx: MutationCtx, ownerId: string): Promise<void> {
  const state = await listingStateOf(ctx, ownerId, "ebay");
  if (!state || !pushesCounts(state)) return;
  if (state.listingStartedAt !== undefined) {
    await ctx.scheduler.runAfter(0, internal.listingSync.startListingWalk, {
      ownerId,
      platform: "ebay",
      startedAt: state.listingStartedAt,
    });
  } else {
    await kickListingDrain(ctx, ownerId, "ebay");
  }
}

function connectionFailure(failure: EbayFailure): string {
  return failure.message;
}

/** An eBay failure in NB's words for the step that hit it (`adapters/ebaySeller.sayEbayFailure`; busy defaults to "unavailable"). */
function sayEbayFailure(failure: EbayFailure, refused: string, busy: string = CONNECT_ERRORS.unavailable): string {
  return sayEbayStepFailure(failure, refused, busy);
}

/** Opens a seller session for the signed-in owner, or says why not (an NB sentence). */
async function sessionFor(ctx: ActionCtx, ownerId: string): Promise<{ ok: true; session: EbaySellerSession } | Fail> {
  if (!ebayConfigured()) return { ok: false, error: NOT_CONFIGURED };
  if (isPlatformPaused("ebay")) return { ok: false, error: PAUSED };
  const opened = await openEbaySellerSession(ctx, ownerId);
  if (!opened.ok) {
    return { ok: false, error: opened.failure.kind === "no_token" ? NOT_CONNECTED : connectionFailure(opened.failure) };
  }
  return { ok: true, session: opened.value };
}

// ── Connection state ───────────────────────────────────────────────────────

/** Where the signed-in collector stands with eBay. Small and subscribable (one profile, one state, one settings row). */
export const connectionState = query({
  args: {},
  returns: connectionStateValidator,
  handler: async (ctx) => {
    const ownerId = await requireSignedIn(ctx);
    const config = ebayConfig();
    const row = await settingsOf(ctx, ownerId);
    const platform = await platformSettings(ctx, ownerId, "ebay");
    const status = platform.paused
      ? ("paused" as const)
      : !platform.connected
        ? ("notConnected" as const)
        : platform.sellerConflict
          ? ("sellerConflict" as const)
          : platform.needsReauth
            ? ("needsReauth" as const)
            : ("connected" as const);
    const missing: EbaySetupItem[] = ebaySetupMissing(row);
    return {
      configured: config !== null,
      environment: config?.environment ?? null,
      status,
      ebayUsername: platform.connected ? (row?.ebayUsername ?? null) : null,
      since: platform.connected ? (row?.connectedAt ?? null) : null,
      settings: {
        fulfillmentPolicyUnder20Id: row?.fulfillmentPolicyUnder20Id ?? null,
        fulfillmentPolicy20PlusId: row?.fulfillmentPolicy20PlusId ?? null,
        paymentPolicyId: row?.paymentPolicyId ?? null,
        returnPolicyId: row?.returnPolicyId ?? null,
        location: row?.location ?? null,
        bestOffer: row?.bestOffer !== false,
      },
      setupComplete: missing.length === 0,
      missing,
    };
  },
});

// ── Connect ────────────────────────────────────────────────────────────────

function newNonce(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The OAuth `state` for a Connect pressed on `returnOrigin` (NEO-422): eBay
 * always sends the collector to one fixed return page on the production
 * site (the RuName's accept URL), which forwards to `/profile/ebay` on the
 * origin named in the state, so a preview or local build gets its own code
 * back. `<nonce>.<base64url(origin)>`, encoded by the return page's own
 * module so the two can never drift.
 *
 * Only a bare http(s) origin (what `window.location.origin` gives) that the
 * return page for this deployment's keyset would forward to is encoded: the
 * production page (production keys) takes only NB's production origins, the
 * sandbox page also takes local dev and Vercel hash previews. The check is
 * the return page's own allowlist (`isAllowedEbayReturnOrigin`), run as that
 * page would run it, so a state NB issues never strands the collector on the
 * "trip got lost" page and production state never names a preview or local
 * origin. Anything else, or nothing, falls back to the bare nonce, which the
 * return page reads as "stay on my origin".
 */
export function returnStateFor(
  nonce: string,
  returnOrigin: string | undefined,
  environment: EbayEnvironment,
): string {
  if (returnOrigin === undefined || returnOrigin.length === 0) return nonce;
  if (returnOrigin.length > MAX_RETURN_ORIGIN_LENGTH) return nonce;
  let parsed: URL;
  try {
    parsed = new URL(returnOrigin);
  } catch {
    return nonce;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return nonce;
  if (parsed.origin !== returnOrigin) return nonce;
  if (!isAllowedEbayReturnOrigin(returnOrigin, EBAY_RETURN_PAGE_ORIGIN, environment)) return nonce;
  const state = encodeEbayReturnState(nonce, returnOrigin);
  return state.length <= MAX_STATE_LENGTH ? state : nonce;
}

/**
 * Starts a Connect press: a fresh nonce (replacing any earlier one) and eBay's
 * consent URL. The stored `connectNonce` is the WHOLE state eBay echoes back
 * (nonce plus return origin), so `consumeConnectNonce` compares it as one
 * opaque string. Refused (an NB sentence) while eBay is connected and working:
 * switching seller accounts goes through Disconnect, which ends NB's
 * listings on the old account first. A connection that needs signing in
 * again (`needsReauth`) may start one; the service then holds it to the
 * same account (`credentials.connectEbay`).
 */
export const beginConnect = mutation({
  /** `returnOrigin`: the web's `window.location.origin`, where eBay's return page sends the collector back. */
  args: { returnOrigin: v.optional(v.string()) },
  returns: v.union(v.object({ authorizeUrl: v.string() }), errorResult),
  handler: async (ctx, args): Promise<{ authorizeUrl: string } | Fail> => {
    const ownerId = await requireSignedIn(ctx);
    const config = ebayConfig();
    if (!config) return { ok: false, error: NOT_CONFIGURED };
    if (isPlatformPaused("ebay")) return { ok: false, error: PAUSED };
    const platform = await platformSettings(ctx, ownerId, "ebay");
    if (platform.connected && !platform.needsReauth) return { ok: false, error: ACCOUNT_SWITCH };
    const state = returnStateFor(newNonce(), args.returnOrigin, config.environment);
    await patchSettings(ctx, ownerId, { connectNonce: state, connectNonceAt: Date.now() });
    return { authorizeUrl: ebayAuthorizeUrl(config, state) };
  },
});

/** Checks and spends the owner's Connect nonce. True only for the live one. */
export const consumeConnectNonce = internalMutation({
  args: { ownerId: v.string(), state: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const row = await settingsOf(ctx, args.ownerId);
    if (!row?.connectNonce || row.connectNonceAt === undefined) return false;
    const fresh = Date.now() - row.connectNonceAt < CONNECT_NONCE_TTL_MS;
    const match = fresh && row.connectNonce === args.state;
    // Spent on a match; an expired one is cleared too. A wrong state leaves
    // a live nonce alone (the real redirect may still be on its way).
    if (match || !fresh) await ctx.db.patch(row._id, { connectNonce: undefined, connectNonceAt: undefined });
    return match;
  },
});

/** True when the owner has any eBay link row (a listing NB made, live or not). */
async function hasEbayLinks(ctx: Pick<QueryCtx, "db">, ownerId: string): Promise<boolean> {
  const first = await ctx.db
    .query("marketplaceListingLinks")
    .withIndex("by_owner_platform_card_condition", (q) => q.eq("ownerId", ownerId).eq("platform", "ebay"))
    .first();
  return first !== null;
}

/**
 * Before a connect reaches the browser service: the eBay account it must
 * stay on, or null when any account may connect. NB's link rows hold offer
 * ids on the account the profile names, so while any exist a re-auth must
 * come back as that same seller (the service refuses a different one with
 * `409 account_mismatch` BEFORE it overwrites the stored session).
 */
export const connectGuard = internalQuery({
  args: { ownerId: v.string() },
  returns: v.object({ expectEbayUserId: v.union(v.string(), v.null()) }),
  handler: async (ctx, args) => {
    const profile = await ctx.db
      .query("userProfiles")
      .withIndex("by_user", (q) => q.eq("userId", args.ownerId))
      .first();
    const known = profile?.marketplaceAccountIds?.ebayUserId;
    if (known === undefined) return { expectEbayUserId: null };
    return { expectEbayUserId: (await hasEbayLinks(ctx, args.ownerId)) ? known : null };
  },
});

/**
 * `credentials.connectEbay`, after the service stored a session: checks the
 * account and only then records it, in one transaction. A DIFFERENT seller
 * than the one the profile names, while link rows exist, is refused writing
 * nothing (`accountSwitch`; the service's own check normally stops it
 * first). Otherwise the seller's immutable eBay user id goes on the profile
 * (`marketplaceAccountIds.ebayUserId`, the one-owner-per-account key the
 * listing setup checks next), with the display username and when the
 * connection started. `staleLinks`: the profile named no account (a
 * Disconnect cleared it) but link rows are left from a different account the
 * listing state last bound (listings eBay would not end at Disconnect); the
 * caller clears them, since their offer ids mean nothing on this account.
 */
export const recordEbayConnection = internalMutation({
  args: { ownerId: v.string(), ebayUserId: v.string(), ebayUsername: v.string() },
  returns: v.union(
    v.object({ kind: v.literal("accountSwitch") }),
    v.object({ kind: v.literal("recorded"), staleLinks: v.boolean() }),
  ),
  handler: async (ctx, args) => {
    if (!EBAY_USER_ID_RE.test(args.ebayUserId)) throw new Error("eBay user id has an unexpected shape");
    const profile = await ctx.db
      .query("userProfiles")
      .withIndex("by_user", (q) => q.eq("userId", args.ownerId))
      .first();
    const known = profile?.marketplaceAccountIds?.ebayUserId;
    const linked = await hasEbayLinks(ctx, args.ownerId);
    if (known !== undefined && known !== args.ebayUserId && linked) return { kind: "accountSwitch" as const };
    const state = await listingStateOf(ctx, args.ownerId, "ebay");
    const staleLinks =
      known === undefined &&
      linked &&
      state?.platformAccountId !== undefined &&
      state.platformAccountId !== args.ebayUserId;
    const accounts = { ...(profile?.marketplaceAccountIds ?? {}), ebayUserId: args.ebayUserId };
    if (profile) await ctx.db.patch(profile._id, { marketplaceAccountIds: accounts });
    else await ctx.db.insert("userProfiles", { userId: args.ownerId, marketplaceAccountIds: accounts });
    await patchSettings(ctx, args.ownerId, {
      ebayUsername: args.ebayUsername.slice(0, 64),
      connectedAt: Date.now(),
      connectNonce: undefined,
      connectNonceAt: undefined,
    });
    return { kind: "recorded" as const, staleLinks };
  },
});

/** Runs the owner's eBay drain now (a reconnect after re-auth leaves a queue that waited). */
export const kickEbayDrain = internalMutation({
  args: { ownerId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await kickListingDrain(ctx, args.ownerId, "ebay");
    return null;
  },
});

/** eBay sent the collector back with a consent code: exchange it and connect. */
export const completeConnect = action({
  args: { code: v.string(), state: v.string() },
  returns: v.union(v.object({ ok: v.literal(true), ebayUsername: v.string() }), errorResult),
  handler: async (ctx, args): Promise<{ ok: true; ebayUsername: string } | Fail> => {
    const ownerId = await requireSignedIn(ctx);
    if (!ebayConfigured()) return { ok: false, error: NOT_CONFIGURED };
    if (isPlatformPaused("ebay")) return { ok: false, error: PAUSED };
    if (args.state.length === 0 || args.state.length > MAX_STATE_LENGTH) return { ok: false, error: NONCE_STALE };
    if (args.code.length === 0 || args.code.length > MAX_CODE_LENGTH) return { ok: false, error: CONNECT_ERRORS.badRequest };
    const live = await ctx.runMutation(internal.ebayConnect.consumeConnectNonce, { ownerId, state: args.state });
    if (!live) return { ok: false, error: NONCE_STALE };
    // eBay's code arrives URL-encoded in the redirect; a router may or may
    // not have decoded it. The browser service wants it decoded.
    let code = args.code;
    if (code.includes("%")) {
      try {
        code = decodeURIComponent(code);
      } catch {
        return { ok: false, error: CONNECT_ERRORS.badRequest };
      }
    }
    const result = await ctx.runAction(internal.credentials.connectEbay, { userId: ownerId, code, listing: "save" });
    if (!result.ok) return { ok: false, error: CONNECT_ERRORS[result.error] };
    await ctx.runMutation(internal.ebayConnect.kickEbayDrain, { ownerId });
    return { ok: true, ebayUsername: result.username };
  },
});

/** One page of the owner's LIVE eBay listings (offer ids), for Disconnect to take down. */
export const liveEbayLinksPage = internalQuery({
  args: { ownerId: v.string(), cursor: v.union(v.string(), v.null()) },
  returns: v.object({
    offers: v.array(v.object({ sku: v.string(), offerId: v.string() })),
    cursor: v.string(),
    isDone: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("marketplaceListingLinks")
      .withIndex("by_owner_platform_card_condition", (q) => q.eq("ownerId", args.ownerId).eq("platform", "ebay"))
      .paginate({ numItems: PURGE_PAGE, cursor: args.cursor });
    const offers: Array<{ sku: string; offerId: string }> = [];
    for (const row of page.page) {
      if (row.status === "live" && row.offerId) offers.push({ sku: row.sku, offerId: row.offerId });
    }
    return { offers, cursor: page.continueCursor, isDone: page.isDone };
  },
});

/** Disconnect's first step: listing on eBay stops (the queue cleared, a running drain stands down at its next write). */
export const stopEbayListing = internalMutation({
  args: { ownerId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await stopListingForSite(ctx, args.ownerId, "ebay");
    return null;
  },
});

/**
 * Disconnect's bookkeeping, under the credential lock once the session is
 * gone: the settings row (a reconnect starts setup fresh) and the eBay user
 * id on the profile. The listing state keeps the account it last bound
 * (`platformAccountId`), so a later connect can tell whether link rows left
 * live belong to the account coming back (`recordEbayConnection`).
 */
export const forgetEbayConnection = internalMutation({
  args: { ownerId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await settingsOf(ctx, args.ownerId);
    if (row) await ctx.db.delete(row._id);
    const profile = await ctx.db
      .query("userProfiles")
      .withIndex("by_user", (q) => q.eq("userId", args.ownerId))
      .first();
    if (profile?.marketplaceAccountIds?.ebayUserId !== undefined) {
      const { ebayUserId: _gone, ...rest } = profile.marketplaceAccountIds;
      await ctx.db.patch(profile._id, { marketplaceAccountIds: rest });
    }
    return null;
  },
});

/**
 * Marks link rows ended after Disconnect withdrew their listings on eBay
 * (the drain's own zero writes the same: status `ended`, pushed quantity 0).
 * By SKU; a SKU with no row or two rows is skipped.
 */
export const markEbayLinksEnded = internalMutation({
  args: { ownerId: v.string(), skus: v.array(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();
    for (const sku of args.skus.slice(0, PURGE_PAGE)) {
      const rows = await ctx.db
        .query("marketplaceListingLinks")
        .withIndex("by_owner_platform_sku", (q) => q.eq("ownerId", args.ownerId).eq("platform", "ebay").eq("sku", sku))
        .take(2);
      if (rows.length !== 1) continue;
      const row = rows[0];
      await ctx.db.patch(row._id, {
        status: "ended",
        ...(row.pushed ? { pushed: { ...row.pushed, quantity: 0 } } : {}),
        lastUpdated: now,
      });
    }
    return null;
  },
});

/** Whether a drain run still holds the owner's eBay lease (Disconnect waits for it to stand down). */
export const ebayDrainRunning = internalQuery({
  args: { ownerId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const state = await listingStateOf(ctx, args.ownerId, "ebay");
    return state?.drainLeaseToken !== undefined && (state.drainLeaseExpiresAt ?? 0) > Date.now();
  },
});

/** The owner's live eBay listings NB knows of (what a refused Disconnect reports as not ended). */
async function countLiveEbayLinks(ctx: Pick<ActionCtx, "runQuery">, ownerId: string): Promise<number> {
  let live = 0;
  for (let cursor: string | null = null; ; ) {
    const page: { offers: Array<{ sku: string; offerId: string }>; cursor: string; isDone: boolean } = await ctx.runQuery(
      internal.ebayConnect.liveEbayLinksPage,
      { ownerId, cursor },
    );
    live += page.offers.length;
    if (page.isDone) return live;
    cursor = page.cursor;
  }
}

/** How long Disconnect waits for a running drain to stand down; past it, Disconnect refuses and deletes nothing. */
const DRAIN_STAND_DOWN_WAIT_MS = 60_000;
const DRAIN_STAND_DOWN_POLL_MS = 2_000;

/**
 * Disconnects eBay. Listing stops first (the queue cleared; a running drain
 * stands down at its next write, and Disconnect waits for it, up to a
 * minute). Then, under the credential lock so no publish or token refresh
 * runs beside it (`credentials.disconnectEbayAndWithdraw`): every live NB
 * listing is withdrawn on eBay and its link marked ended (best effort;
 * otherwise eBay keeps selling quantities NB no longer updates), the stored
 * session goes, the link rows go except any still live, and the settings and
 * the eBay user id NB kept go. Sales history stays. `notEnded`: live
 * listings NB could not take down; the collector ends those on eBay.
 */
export const disconnect = action({
  args: {},
  returns: v.object({ ok: v.boolean(), notEnded: v.number() }),
  handler: async (ctx): Promise<{ ok: boolean; notEnded: number }> => {
    const ownerId = await requireSignedIn(ctx);
    const startedAt = Date.now();
    await ctx.runMutation(internal.ebayConnect.stopEbayListing, { ownerId });
    let drainStoodDown = true;
    for (const waitStarted = Date.now(); await ctx.runQuery(internal.ebayConnect.ebayDrainRunning, { ownerId }); ) {
      if (Date.now() - waitStarted >= DRAIN_STAND_DOWN_WAIT_MS) {
        drainStoodDown = false;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, DRAIN_STAND_DOWN_POLL_MS));
    }
    // A drain still running could publish after the withdraw read the links:
    // touch nothing and let the collector press Disconnect again.
    const result = drainStoodDown
      ? await ctx.runAction(internal.credentials.disconnectEbayAndWithdraw, { userId: ownerId })
      : { ok: false, notEnded: await countLiveEbayLinks(ctx, ownerId) };
    console.log(
      JSON.stringify({
        msg: "ebay_disconnect",
        platform: "ebay",
        operation: "disconnect",
        ok: result.ok,
        drainStoodDown,
        notEnded: result.notEnded,
        durationMs: Date.now() - startedAt,
      }),
    );
    return result;
  },
});

// ── Policies ───────────────────────────────────────────────────────────────

interface PolicyLists {
  fulfillment: Array<{ id: string; name: string; eseFit: boolean; eseOnly: boolean; freeShipping: boolean; summary: string }>;
  payment: Array<{ id: string; name: string }>;
  returns: Array<{ id: string; name: string; summary: string }>;
}

/**
 * The seller's three policy lists (empty when the account is not in business
 * policies yet). eBay's shipping metadata is read beside them so a policy's
 * summary names each service by eBay's own name, never its code; when that
 * read fails the summaries say "eBay shipping" and the lists still load.
 * `services`: the metadata, when it was read (Set me up reuses it).
 */
async function readPolicyLists(
  ctx: ActionCtx,
  session: EbaySellerSession,
): Promise<{ ok: true; lists: PolicyLists; optedIn: boolean; services: EbayShippingServiceInfo[] | null } | Fail> {
  const programs = await getOptedInPrograms(ctx, session);
  if (!programs.ok) return { ok: false, error: sayEbayFailure(programs.failure, POLICIES_REFUSED) };
  if (!programs.value.includes(SELLING_POLICY_MANAGEMENT)) {
    return { ok: true, lists: { fulfillment: [], payment: [], returns: [] }, optedIn: false, services: null };
  }
  const [fulfillment, payment, returns, metadata] = await Promise.all([
    getPolicies(ctx, session, "fulfillment_policy"),
    getPolicies(ctx, session, "payment_policy"),
    getPolicies(ctx, session, "return_policy"),
    getShippingServices(ctx, session),
  ]);
  for (const r of [fulfillment, payment, returns]) if (!r.ok) return { ok: false, error: sayEbayFailure(r.failure, POLICIES_REFUSED) };
  if (!fulfillment.ok || !payment.ok || !returns.ok) return { ok: false, error: CONNECT_ERRORS.unavailable };
  const services = metadata.ok ? metadata.value : null;
  const names = ebayServiceNames(services ?? []);
  return {
    ok: true,
    optedIn: true,
    services,
    lists: {
      fulfillment: readFulfillmentPolicies(fulfillment.value).map((p) => ({ id: p.id, name: p.name, ...policyFitness(p, names) })),
      payment: readPaymentPolicies(payment.value),
      returns: readReturnPolicies(returns.value),
    },
  };
}

const policiesResult = v.union(
  v.object({
    ok: v.literal(true),
    fulfillment: v.array(
      v.object({
        id: v.string(),
        name: v.string(),
        eseFit: v.boolean(),
        eseOnly: v.boolean(),
        freeShipping: v.boolean(),
        summary: v.string(),
      }),
    ),
    payment: v.array(v.object({ id: v.string(), name: v.string() })),
    returns: v.array(v.object({ id: v.string(), name: v.string(), summary: v.string() })),
  }),
  errorResult,
);

/** The collector's eBay business policies, for the pickers. */
export const readPolicies = action({
  args: {},
  returns: policiesResult,
  handler: async (ctx): Promise<({ ok: true } & PolicyLists) | Fail> => {
    const ownerId = await requireSignedIn(ctx);
    const opened = await sessionFor(ctx, ownerId);
    if (!opened.ok) return opened;
    const read = await readPolicyLists(ctx, opened.session);
    if (!read.ok) return read;
    return { ok: true, ...read.lists };
  },
});

const CATEGORY_TYPES = [{ name: "ALL_EXCLUDING_MOTORS_VEHICLES" }];

/** A shipping service as a policy names it: eBay's service code and the carrier code beside it. */
interface PolicyService {
  code: string;
  carrier: string;
}

/**
 * A one-service domestic fulfillment policy (Sell Account
 * FulfillmentPolicyRequest).
 *   calculated  costType CALCULATED and no shippingCost: eBay prices each
 *               order from the item's package weight and size and the
 *               ship-from postal code (the offer's inventory location)
 *   free        costType FLAT_RATE at $0.00 with freeShipping
 * Every service names its carrier (`shippingCarrierCode`, from eBay's
 * metadata; `policyService`). The contract calls the field optional, but
 * eBay's own live eSE policies all carry it, and NB's first create without
 * it was refused (20403). Fields eBay echoes back on a read
 * (`packageHandlingCost` 0.0, `shipToLocations` {}, `globalShipping` false,
 * `buyerResponsibleFor*` false) are not sent: the contract requires none of
 * them and each is eBay's default.
 */
export function fulfillmentBody(name: string, service: PolicyService, pricing: "calculated" | "free"): Record<string, unknown> {
  const free = pricing === "free";
  return {
    name,
    marketplaceId: EBAY_MARKETPLACE_ID,
    categoryTypes: CATEGORY_TYPES,
    handlingTime: { value: NB_POLICY_DEFAULTS.handlingDays, unit: "DAY" },
    shippingOptions: [
      {
        optionType: "DOMESTIC",
        costType: free ? EBAY_COST_TYPE_FLAT_RATE : EBAY_COST_TYPE_CALCULATED,
        shippingServices: [
          {
            shippingCarrierCode: service.carrier,
            shippingServiceCode: service.code,
            ...(free ? { shippingCost: { value: "0.00", currency: "USD" } } : {}),
            freeShipping: free,
            sortOrder: 1,
          },
        ],
      },
    ],
  };
}

/** `code` with the carrier eBay's metadata lists for it (`fallback` when it lists none). */
function policyService(services: EbayShippingServiceInfo[], code: string, fallback: string): PolicyService {
  return { code, carrier: ebayServiceCarrier(services, code, fallback) };
}

/** Whether the owner has saved where they ship from (calculated shipping prices from it). */
export const shipFromSaved = internalQuery({
  args: { ownerId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => !ebaySetupMissing(await settingsOf(ctx, args.ownerId)).includes("location"),
});

/**
 * eBay's USPS Ground Advantage service code, read from eBay's own metadata
 * (never hard-coded; the rule is `lib/ebayListing.ebayGroundAdvantageService`).
 * Null when eBay lists none, or several that fit equally. A miss logs the
 * domestic USPS services eBay did list (eBay's public catalogue: codes and
 * names, nothing of the seller's), so a red live run shows what to match.
 */
function groundAdvantageCode(services: EbayShippingServiceInfo[]): string | null {
  const found = ebayGroundAdvantageService(services);
  if (found) return found.code;
  const usps = services
    .filter((s) => !s.international && (/usps/i.test(s.code) || /usps/i.test(s.description ?? "") || /usps/i.test(s.carrier ?? "")))
    .slice(0, 25)
    .map((s) => ({ code: s.code, description: s.description, validForSelling: s.validForSelling, costTypes: s.costTypes }));
  console.warn(
    JSON.stringify({
      msg: "ebay_ground_advantage_unresolved",
      platform: "ebay",
      operation: "createStandardPolicies",
      servicesListed: services.length,
      usps,
    }),
  );
  return null;
}

/**
 * "Set me up": NB's standard policies on the collector's eBay account —
 * Standard Envelope (cards under $20) and Tracked (USPS Ground Advantage),
 * both calculated by weight so buyers pay eBay's own rates, and Free
 * Shipping (Ground Advantage at $0), plus a payment and a return policy
 * only when the account has none. Opts the account into business policies
 * first when needed. Idempotent by name: a policy NB already made is not
 * made again. Fills only EMPTY settings slots with what it made. Refuses
 * until the ship-from location is saved, since calculated rates need it.
 */
export const createStandardPolicies = action({
  args: {},
  returns: v.union(v.object({ ok: v.literal(true), created: v.array(v.string()) }), errorResult),
  handler: async (ctx): Promise<{ ok: true; created: string[] } | Fail> => {
    const ownerId = await requireSignedIn(ctx);
    const opened = await sessionFor(ctx, ownerId);
    if (!opened.ok) return opened;
    const session = opened.session;
    // Calculated shipping prices from the ship-from ZIP: no location, no policies.
    if (!(await ctx.runQuery(internal.ebayConnect.shipFromSaved, { ownerId }))) return { ok: false, error: SHIP_FROM_FIRST };
    let read = await readPolicyLists(ctx, session);
    if (!read.ok) return read;
    let justOptedIn = false;
    if (!read.optedIn) {
      const optIn = await optInToProgram(ctx, session, SELLING_POLICY_MANAGEMENT);
      if (!optIn.ok) return { ok: false, error: sayEbayFailure(optIn.failure, OPT_IN_REFUSED, SET_ME_UP_BUSY) };
      justOptedIn = true;
      read = await readPolicyLists(ctx, session);
      if (!read.ok) return { ok: false, error: OPT_IN_PENDING };
    }
    const services = read.services ? { ok: true as const, value: read.services } : await getShippingServices(ctx, session);
    if (!services.ok) return { ok: false, error: sayEbayFailure(services.failure, SERVICES_REFUSED, SET_ME_UP_BUSY) };
    const ground = groundAdvantageCode(services.value);
    if (!ground) return { ok: false, error: NO_GROUND_ADVANTAGE };

    const byName = new Map(read.lists.fulfillment.map((p) => [p.name, p.id]));
    const created: string[] = [];
    const ids: { ese?: string; tracked?: string; free?: string; payment?: string; returns?: string } = {
      ese: byName.get(NB_POLICY_NAMES.ese),
      tracked: byName.get(NB_POLICY_NAMES.tracked),
      free: byName.get(NB_POLICY_NAMES.free),
    };
    // NB never invents a shipping rate: when eBay's own metadata says a
    // service has no calculated rate, nothing is made and the collector picks.
    if (!ids.ese && !ebayServiceTakesCalculated(services.value, EBAY_ESE_SERVICE_CODE)) {
      return { ok: false, error: NO_CALCULATED("Standard Envelope") };
    }
    if (!ids.tracked && !ebayServiceTakesCalculated(services.value, ground)) {
      return { ok: false, error: NO_CALCULATED("USPS Ground Advantage") };
    }
    const envelope = policyService(services.value, EBAY_ESE_SERVICE_CODE, EBAY_ESE_CARRIER_FALLBACK);
    // Ground Advantage is a USPS service by construction (`ebayGroundAdvantageService`).
    const tracked = policyService(services.value, ground, EBAY_USPS_CARRIER_FALLBACK);
    const make = async (
      slot: keyof typeof ids,
      kind: "fulfillment_policy" | "payment_policy" | "return_policy",
      name: string,
      body: Record<string, unknown>,
    ): Promise<Fail | null> => {
      const r = await createPolicy(ctx, session, kind, body);
      if (!r.ok) {
        if (justOptedIn) return { ok: false, error: OPT_IN_PENDING };
        return { ok: false, error: sayEbayFailure(r.failure, SET_ME_UP_REFUSED[slot], SET_ME_UP_BUSY) };
      }
      ids[slot] = r.value;
      created.push(name);
      return null;
    };
    const steps: Array<() => Promise<Fail | null>> = [];
    if (!ids.ese) {
      steps.push(() =>
        make("ese", "fulfillment_policy", NB_POLICY_NAMES.ese, fulfillmentBody(NB_POLICY_NAMES.ese, envelope, "calculated")),
      );
    }
    if (!ids.tracked) {
      steps.push(() =>
        make("tracked", "fulfillment_policy", NB_POLICY_NAMES.tracked, fulfillmentBody(NB_POLICY_NAMES.tracked, tracked, "calculated")),
      );
    }
    if (!ids.free) {
      steps.push(() => make("free", "fulfillment_policy", NB_POLICY_NAMES.free, fulfillmentBody(NB_POLICY_NAMES.free, tracked, "free")));
    }
    if (read.lists.payment.length === 0) {
      steps.push(() =>
        make("payment", "payment_policy", NB_POLICY_NAMES.payment, {
          name: NB_POLICY_NAMES.payment,
          marketplaceId: EBAY_MARKETPLACE_ID,
          categoryTypes: CATEGORY_TYPES,
          immediatePay: true,
        }),
      );
    } else if (read.lists.payment.length === 1) {
      ids.payment = read.lists.payment[0].id;
    }
    if (read.lists.returns.length === 0) {
      steps.push(() =>
        make("returns", "return_policy", NB_POLICY_NAMES.returns, {
          name: NB_POLICY_NAMES.returns,
          marketplaceId: EBAY_MARKETPLACE_ID,
          categoryTypes: CATEGORY_TYPES,
          returnsAccepted: true,
          returnPeriod: { value: NB_POLICY_DEFAULTS.returnDays, unit: "DAY" },
          returnShippingCostPayer: "BUYER",
          refundMethod: "MONEY_BACK",
        }),
      );
    } else if (read.lists.returns.length === 1) {
      ids.returns = read.lists.returns[0].id;
    }
    for (const step of steps) {
      const failed = await step();
      if (failed) {
        // What was made stays made (and is found by name next time).
        await ctx.runMutation(internal.ebayConnect.fillEmptyPolicySlots, {
          ownerId,
          ...(ids.ese ? { under20: ids.ese } : {}),
          ...(ids.tracked ? { twentyPlus: ids.tracked } : {}),
          ...(ids.payment ? { payment: ids.payment } : {}),
          ...(ids.returns ? { returns: ids.returns } : {}),
        });
        return failed;
      }
    }
    await ctx.runMutation(internal.ebayConnect.fillEmptyPolicySlots, {
      ownerId,
      ...(ids.ese ? { under20: ids.ese } : {}),
      ...(ids.tracked ? { twentyPlus: ids.tracked } : {}),
      ...(ids.payment ? { payment: ids.payment } : {}),
      ...(ids.returns ? { returns: ids.returns } : {}),
    });
    return { ok: true, created };
  },
});

/** "Set me up" fills the settings slots the collector has not chosen yet; a chosen slot is never replaced. */
export const fillEmptyPolicySlots = internalMutation({
  args: {
    ownerId: v.string(),
    under20: v.optional(v.string()),
    twentyPlus: v.optional(v.string()),
    payment: v.optional(v.string()),
    returns: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await settingsOf(ctx, args.ownerId);
    const patch: Partial<Doc<"ebaySellerSettings">> = {};
    if (args.under20 && !row?.fulfillmentPolicyUnder20Id) patch.fulfillmentPolicyUnder20Id = args.under20;
    if (args.twentyPlus && !row?.fulfillmentPolicy20PlusId) patch.fulfillmentPolicy20PlusId = args.twentyPlus;
    if (args.payment && !row?.paymentPolicyId) patch.paymentPolicyId = args.payment;
    if (args.returns && !row?.returnPolicyId) patch.returnPolicyId = args.returns;
    if (Object.keys(patch).length === 0) return null;
    await patchSettings(ctx, args.ownerId, patch);
    await settingsChanged(ctx, args.ownerId);
    return null;
  },
});

/** Writes chosen policies (already checked against eBay) and re-queues. */
export const writePolicySettings = internalMutation({
  args: {
    ownerId: v.string(),
    fulfillmentPolicyUnder20Id: v.optional(v.string()),
    fulfillmentPolicy20PlusId: v.optional(v.string()),
    paymentPolicyId: v.optional(v.string()),
    returnPolicyId: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { ownerId, ...patch } = args;
    if (Object.keys(patch).length === 0) return null;
    await patchSettings(ctx, ownerId, patch);
    await settingsChanged(ctx, ownerId);
    return null;
  },
});

/** Saves the collector's policy picks after checking each against their eBay account. */
export const savePolicies = action({
  args: {
    fulfillmentPolicyUnder20Id: v.optional(v.string()),
    fulfillmentPolicy20PlusId: v.optional(v.string()),
    paymentPolicyId: v.optional(v.string()),
    returnPolicyId: v.optional(v.string()),
  },
  returns: v.union(v.object({ ok: v.literal(true) }), errorResult),
  handler: async (ctx, args): Promise<{ ok: true } | Fail> => {
    const ownerId = await requireSignedIn(ctx);
    for (const id of Object.values(args)) {
      if (typeof id === "string" && (id.length === 0 || id.length > MAX_POLICY_ID)) return { ok: false, error: POLICY_GONE };
    }
    const opened = await sessionFor(ctx, ownerId);
    if (!opened.ok) return opened;
    const read = await readPolicyLists(ctx, opened.session);
    if (!read.ok) return read;
    const fulfillment = new Map(read.lists.fulfillment.map((p) => [p.id, p]));
    if (args.fulfillmentPolicyUnder20Id !== undefined && !fulfillment.has(args.fulfillmentPolicyUnder20Id)) {
      return { ok: false, error: POLICY_GONE };
    }
    if (args.fulfillmentPolicy20PlusId !== undefined) {
      const policy = fulfillment.get(args.fulfillmentPolicy20PlusId);
      if (!policy) return { ok: false, error: POLICY_GONE };
      if (policy.eseOnly) return { ok: false, error: ESE_FOR_20_PLUS };
    }
    if (args.paymentPolicyId !== undefined && !read.lists.payment.some((p) => p.id === args.paymentPolicyId)) {
      return { ok: false, error: POLICY_GONE };
    }
    if (args.returnPolicyId !== undefined && !read.lists.returns.some((p) => p.id === args.returnPolicyId)) {
      return { ok: false, error: POLICY_GONE };
    }
    await ctx.runMutation(internal.ebayConnect.writePolicySettings, { ownerId, ...args });
    return { ok: true };
  },
});

// ── Ship-from location ─────────────────────────────────────────────────────

export const writeLocationSettings = internalMutation({
  args: { ownerId: v.string(), location: locationValidator, merchantLocationKey: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await patchSettings(ctx, args.ownerId, { location: args.location, merchantLocationKey: args.merchantLocationKey });
    await settingsChanged(ctx, args.ownerId);
    return null;
  },
});

/** Saves where the collector ships from, creating (or updating) the inventory location on their eBay account. */
export const saveLocation = action({
  args: locationValidator.fields,
  returns: v.union(v.object({ ok: v.literal(true) }), errorResult),
  handler: async (ctx, args): Promise<{ ok: true } | Fail> => {
    const ownerId = await requireSignedIn(ctx);
    const postalCode = args.postalCode.trim();
    const city = args.city.trim().replace(/\s+/g, " ");
    const stateOrProvince = args.stateOrProvince.trim().toUpperCase();
    if (!isUsPostalCode(postalCode)) return { ok: false, error: "That ZIP code doesn't look right. Five digits, like 53703." };
    if (city.length === 0 || city.length > 64) return { ok: false, error: "Add the city you ship from." };
    if (!isUsStateCode(stateOrProvince)) return { ok: false, error: "Use the two-letter state, like WI." };
    const opened = await sessionFor(ctx, ownerId);
    if (!opened.ok) return opened;
    const location = { postalCode, city, stateOrProvince };
    const r = await upsertInventoryLocation(ctx, opened.session, EBAY_MERCHANT_LOCATION_KEY, location);
    if (!r.ok) return { ok: false, error: sayEbayFailure(r.failure, LOCATION_REFUSED) };
    await ctx.runMutation(internal.ebayConnect.writeLocationSettings, {
      ownerId,
      location,
      merchantLocationKey: EBAY_MERCHANT_LOCATION_KEY,
    });
    return { ok: true };
  },
});

// ── Best Offer ─────────────────────────────────────────────────────────────

/** Turns Best Offer on or off for every eBay listing NB makes for the collector (default on). */
export const setBestOffer = mutation({
  args: { on: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const ownerId = await requireSignedIn(ctx);
    const row = await settingsOf(ctx, ownerId);
    if ((row?.bestOffer !== false) === args.on) return null;
    await patchSettings(ctx, ownerId, { bestOffer: args.on });
    await settingsChanged(ctx, ownerId);
    return null;
  },
});

// ── Marketplace Account Deletion ───────────────────────────────────────────
//
// https://developer.ebay.com/marketplace-account-deletion
// GET  ?challenge_code=… → 200 {"challengeResponse": hex(sha256(challengeCode + verificationToken + endpoint))}
// POST {metadata:{topic:"MARKETPLACE_ACCOUNT_DELETION"}, notification:{data:{username, userId, eiasToken}}}
//
// eBay pushes a notice for EVERY eBay account deleted, not only sellers NB
// knows. The POST is unauthenticated, so nothing is acted on until its
// `X-EBAY-SIGNATURE` is verified: the browser service holds the app
// credentials eBay's public key needs (`credentials.verifyEbayNotification`).
// Verifying is rate limited, so a notice naming no NB owner is acknowledged
// (200) without it: nothing would be acted on anyway. For a notice that
// names one:
//   signature invalid            → 412, nothing scheduled
//   verifier unreachable         → 500, nothing scheduled (eBay retries)
//   verification not configured  → 503, nothing scheduled
//   verified                     → scheduled delete, 200
// Owners are matched on the immutable eBay user id alone (a username can be
// renamed, and is public). The delete removes only NB's eBay-side data,
// never a copy, card or box.

/** Where eBay calls: the deployment's site URL plus the route, unless set explicitly. */
function deletionEndpointUrl(): string | null {
  const explicit = process.env.EBAY_DELETION_ENDPOINT_URL?.trim();
  if (explicit) return explicit;
  const site = process.env.CONVEX_SITE_URL?.trim();
  return site ? `${site.replace(/\/+$/, "")}/webhooks/ebay/account-deletion` : null;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

const JSON_HEADERS = { "content-type": "application/json", "cache-control": "no-store" };
/** What NB reads of a notice at all. */
const MAX_NOTICE_BYTES = 64 * 1024;
/** Below what the verifier takes (`services/browser`, its JSON body limit); a real notice is well under 1 KB. */
const MAX_VERIFIABLE_NOTICE_CHARS = 4096;
const MAX_SIGNATURE_HEADER_CHARS = 4096;
const EBAY_USER_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
/** Owners one eBay account can match (seller conflicts are off on sandbox testing deployments). */
const MAX_DELETION_OWNERS = 50;
/** Tries of the scheduled delete for owners it could not finish, then it gives up (logged). */
const MAX_DELETION_ATTEMPTS = 10;
const DELETION_RETRY_BASE_MS = 60_000;
const DELETION_RETRY_MAX_MS = 60 * 60_000;

/** GET: eBay's endpoint-validation challenge. */
export const ebayDeletionChallenge = httpAction(async (_ctx, req) => {
  const token = process.env.EBAY_DELETION_VERIFICATION_TOKEN?.trim();
  const endpoint = deletionEndpointUrl();
  if (!token || !endpoint) return new Response(JSON.stringify({ error: "not_configured" }), { status: 503, headers: JSON_HEADERS });
  const challengeCode = new URL(req.url).searchParams.get("challenge_code") ?? "";
  if (challengeCode.length === 0 || challengeCode.length > 512) {
    return new Response(JSON.stringify({ error: "bad_request" }), { status: 400, headers: JSON_HEADERS });
  }
  const challengeResponse = await sha256Hex(challengeCode + token + endpoint);
  return new Response(JSON.stringify({ challengeResponse }), { status: 200, headers: JSON_HEADERS });
});

/** The eBay user id an account-deletion notice names, or null when it is not one. */
function deletionNoticeUserId(raw: string): string | null {
  let body: unknown = null;
  try {
    body = JSON.parse(raw);
  } catch {
    return null;
  }
  const metadata = isRecord(body) && isRecord(body.metadata) ? body.metadata : null;
  const notification = isRecord(body) && isRecord(body.notification) ? body.notification : null;
  const data = notification && isRecord(notification.data) ? notification.data : null;
  const userId = typeof data?.userId === "string" ? data.userId : "";
  return metadata?.topic === "MARKETPLACE_ACCOUNT_DELETION" && EBAY_USER_ID_RE.test(userId) ? userId : null;
}

function logNotice(outcome: string, startedAt: number, extra: Record<string, number> = {}): void {
  // Warn, never error: a flood of forged notices (the verifier's key-fetch
  // cap answers 502, so `unavailable`) must not page anyone.
  const log = outcome === "unavailable" || outcome === "notConfigured" ? console.warn : console.log;
  log(
    JSON.stringify({
      msg: "ebay_account_deletion",
      platform: "ebay",
      operation: "notice",
      outcome,
      ...extra,
      durationMs: Date.now() - startedAt,
    }),
  );
}

/** POST: a seller deleted their eBay account. Verified before anything is scheduled (see above). */
export const ebayDeletionNotice = httpAction(async (ctx, req) => {
  const startedAt = Date.now();
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_NOTICE_BYTES) {
    logNotice("too_large", startedAt);
    return new Response(null, { status: 413 });
  }
  const raw = await req.text().catch(() => "");
  if (raw.length > MAX_NOTICE_BYTES) {
    logNotice("too_large", startedAt);
    return new Response(null, { status: 413 });
  }
  const ebayUserId = deletionNoticeUserId(raw);
  const owners: string[] = ebayUserId
    ? await ctx.runQuery(internal.ebayConnect.ownersForEbayAccount, { ebayUserId })
    : [];
  if (ebayUserId === null || owners.length === 0) {
    // Not a deletion notice, or not a seller NB knows: nothing to act on.
    // Accepted (security review): 200 here vs 412 below tells a caller
    // whether an eBay user id is an NB seller (a membership oracle); the id
    // is opaque and nothing is acted on without a verified signature.
    logNotice(ebayUserId === null ? "not_a_deletion" : "no_owner", startedAt);
    return new Response(null, { status: 200 });
  }
  if (!process.env.EBAY_DELETION_VERIFICATION_TOKEN?.trim() || !ebayConfigured()) {
    logNotice("not_configured", startedAt);
    return new Response(null, { status: 503 });
  }
  const signatureHeader = req.headers.get("x-ebay-signature") ?? "";
  if (
    signatureHeader.length === 0 ||
    signatureHeader.length > MAX_SIGNATURE_HEADER_CHARS ||
    raw.length > MAX_VERIFIABLE_NOTICE_CHARS
  ) {
    logNotice("invalid", startedAt);
    return new Response(null, { status: 412 });
  }
  const verdict = await ctx.runAction(internal.credentials.verifyEbayNotification, { signatureHeader, body: raw });
  if (verdict !== "valid") {
    logNotice(verdict, startedAt);
    return new Response(null, { status: verdict === "invalid" ? 412 : verdict === "notConfigured" ? 503 : 500 });
  }
  await ctx.scheduler.runAfter(0, internal.ebayConnect.processAccountDeletion, { ebayUserId, attempt: 0 });
  logNotice("scheduled", startedAt, { owners: owners.length });
  return new Response(null, { status: 200 });
});

/**
 * The NB owners holding this eBay seller account, by its immutable user id
 * alone: the profiles that name it (connected now), and the listing states
 * that last bound it (a Disconnect cleared the profile but left link rows
 * eBay would not end).
 */
export const ownersForEbayAccount = internalQuery({
  args: { ebayUserId: v.string() },
  returns: v.array(v.string()),
  handler: async (ctx, args) => {
    const owners = new Set<string>();
    const profiles = await ctx.db
      .query("userProfiles")
      .withIndex("by_ebay_user", (q) => q.eq("marketplaceAccountIds.ebayUserId", args.ebayUserId))
      .take(MAX_DELETION_OWNERS);
    for (const profile of profiles) owners.add(profile.userId);
    const states = await ctx.db
      .query("marketplaceListingStates")
      .withIndex("by_platform_account", (q) => q.eq("platform", "ebay").eq("platformAccountId", args.ebayUserId))
      .take(MAX_DELETION_OWNERS);
    for (const state of states) owners.add(state.ownerId);
    return [...owners].slice(0, MAX_DELETION_OWNERS);
  },
});

/**
 * One page of the owner's eBay link rows, deleted. `keepLive` (Disconnect)
 * leaves a row still `live` (a listing eBay would not end) so a reconnect to
 * the same account can manage it again; the account-deletion sweep and a
 * stale-account clear delete every row.
 */
export const purgeEbayLinksPage = internalMutation({
  args: {
    ownerId: v.string(),
    keepLive: v.boolean(),
    cursor: v.union(v.string(), v.null()),
    /** Delete only while the listing state is still bound to this eBay account (else nothing, done). */
    whileStamped: v.optional(v.string()),
  },
  returns: v.object({ cursor: v.string(), isDone: v.boolean(), keptLive: v.number() }),
  handler: async (ctx, args) => {
    if (args.whileStamped !== undefined) {
      const state = await listingStateOf(ctx, args.ownerId, "ebay");
      if (state?.platformAccountId !== args.whileStamped) return { cursor: "", isDone: true, keptLive: 0 };
    }
    const page = await ctx.db
      .query("marketplaceListingLinks")
      .withIndex("by_owner_platform_card_condition", (q) => q.eq("ownerId", args.ownerId).eq("platform", "ebay"))
      .paginate({ numItems: PURGE_PAGE, cursor: args.cursor });
    let keptLive = 0;
    for (const row of page.page) {
      if (args.keepLive && row.status === "live") keptLive += 1;
      else await ctx.db.delete(row._id);
    }
    return { cursor: page.continueCursor, isDone: page.isDone, keptLive };
  },
});

/** One page of the owner's eBay sales and sync records, deleted (account deletion only). True when more remain. */
export const purgeEbayHistoryPage = internalMutation({
  args: { ownerId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const sales = await ctx.db
      .query("marketplaceSales")
      .withIndex("by_owner_platform_order", (q) => q.eq("ownerId", args.ownerId).eq("platform", "ebay"))
      .take(SALES_PURGE_PAGE);
    for (const row of sales) await ctx.db.delete(row._id);
    if (sales.length === SALES_PURGE_PAGE) return true;
    const syncs = await ctx.db
      .query("marketplaceListingSyncs")
      .withIndex("by_owner_platform_run", (q) => q.eq("ownerId", args.ownerId).eq("platform", "ebay"))
      .take(PURGE_PAGE);
    for (const row of syncs) await ctx.db.delete(row._id);
    return syncs.length === PURGE_PAGE;
  },
});

/** Pages through every link row of the owner (see `purgeEbayLinksPage`). Returns the live rows kept. */
export async function purgeEbayLinks(
  ctx: Pick<ActionCtx, "runMutation">,
  ownerId: string,
  keepLive: boolean,
  whileStamped?: string,
): Promise<number> {
  let keptLive = 0;
  for (let cursor: string | null = null; ; ) {
    const page: { cursor: string; isDone: boolean; keptLive: number } = await ctx.runMutation(
      internal.ebayConnect.purgeEbayLinksPage,
      { ownerId, keepLive, cursor, ...(whileStamped !== undefined ? { whileStamped } : {}) },
    );
    keptLive += page.keptLive;
    if (page.isDone) return keptLive;
    cursor = page.cursor;
  }
}

/** Last step: the settings row, the eBay user id on the profile, and the account stamp on the state row. */
export const forgetEbayAccount = internalMutation({
  args: { ownerId: v.string(), ebayUserId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const settings = await settingsOf(ctx, args.ownerId);
    if (settings) await ctx.db.delete(settings._id);
    const profile = await ctx.db
      .query("userProfiles")
      .withIndex("by_user", (q) => q.eq("userId", args.ownerId))
      .unique();
    if (profile?.marketplaceAccountIds?.ebayUserId === args.ebayUserId) {
      const { ebayUserId: _gone, ...rest } = profile.marketplaceAccountIds;
      await ctx.db.patch(profile._id, { marketplaceAccountIds: rest });
    }
    const state = await listingStateOf(ctx, args.ownerId, "ebay");
    if (state && state.platformAccountId === args.ebayUserId) {
      await ctx.db.patch(state._id, { platformAccountId: undefined, lastUpdated: Date.now() });
    }
    return null;
  },
});

/**
 * How a deleted eBay account relates to an owner the sweep matched:
 * `account` (the profile names it, or names none: the owner's eBay data is
 * that account's) or `oldStamp` (the profile names a DIFFERENT account now;
 * only the listing state still carries the deleted one, from before a
 * reconnect). An `oldStamp` owner's session and sales belong to the new
 * account and are never touched.
 */
export const ebayDeletionMatch = internalQuery({
  args: { ownerId: v.string(), ebayUserId: v.string() },
  returns: v.union(v.literal("account"), v.literal("oldStamp")),
  handler: async (ctx, args) => {
    const profile = await ctx.db
      .query("userProfiles")
      .withIndex("by_user", (q) => q.eq("userId", args.ownerId))
      .first();
    const named = profile?.marketplaceAccountIds?.ebayUserId;
    return named === undefined || named === args.ebayUserId ? "account" : "oldStamp";
  },
});

/** Clears the deleted account's stamp from the owner's listing state (the `oldStamp` case). */
export const clearEbayAccountStamp = internalMutation({
  args: { ownerId: v.string(), ebayUserId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const state = await listingStateOf(ctx, args.ownerId, "ebay");
    if (state && state.platformAccountId === args.ebayUserId) {
      await ctx.db.patch(state._id, { platformAccountId: undefined, lastUpdated: Date.now() });
    }
    return null;
  },
});

/** Wait before try `attempt` (1-based) of the scheduled delete: doubling from a minute, at most an hour. */
export function deletionRetryDelayMs(attempt: number): number {
  return Math.min(DELETION_RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1), DELETION_RETRY_MAX_MS);
}

/**
 * Deletes NB's eBay-side data for a seller who deleted their eBay account
 * (scheduled only for a VERIFIED notice): the stored session and saved
 * sign-in (`credentials.disconnectEbay`, which stops listing), every link
 * row (eBay ends a deleted account's listings itself), the eBay sales and
 * sync records (eBay's rule for a deleted account), the settings row, and
 * the eBay user id NB kept. NB's own copies, cards and boxes stay.
 *
 * An owner matched only through an old listing-state stamp while the
 * profile names a different account keeps its session and sales; only the
 * old account's link rows and the stamp go (`ebayDeletionMatch`).
 *
 * Owners it could not finish (the credential lock held, the service down)
 * are tried again together in ONE scheduled retry, with backoff, up to
 * `MAX_DELETION_ATTEMPTS` tries in all; then it gives up, logged. Safe to
 * retry: every step is a no-op once done.
 */
export const processAccountDeletion = internalAction({
  args: { ebayUserId: v.string(), ownerIds: v.optional(v.array(v.string())), attempt: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const startedAt = Date.now();
    const owners: string[] =
      args.ownerIds ?? (await ctx.runQuery(internal.ebayConnect.ownersForEbayAccount, { ebayUserId: args.ebayUserId }));
    const failed: string[] = [];
    for (const ownerId of owners.slice(0, MAX_DELETION_OWNERS)) {
      const match = await ctx.runQuery(internal.ebayConnect.ebayDeletionMatch, { ownerId, ebayUserId: args.ebayUserId });
      if (match === "oldStamp") {
        // Matched only through the listing state; the owner is on another
        // eBay account now. While the state is still bound to the deleted
        // account every link row is that account's (a drain binds the new
        // one before its first write), so only those rows and the stamp go.
        await purgeEbayLinks(ctx, ownerId, false, args.ebayUserId);
        await ctx.runMutation(internal.ebayConnect.clearEbayAccountStamp, { ownerId, ebayUserId: args.ebayUserId });
        continue;
      }
      const disconnected = await ctx.runAction(internal.credentials.disconnectEbay, { userId: ownerId });
      if (!disconnected.ok) {
        failed.push(ownerId);
        continue;
      }
      await purgeEbayLinks(ctx, ownerId, false);
      for (let page = 0; page < 500; page += 1) {
        const more = await ctx.runMutation(internal.ebayConnect.purgeEbayHistoryPage, { ownerId });
        if (!more) break;
      }
      await ctx.runMutation(internal.ebayConnect.forgetEbayAccount, { ownerId, ebayUserId: args.ebayUserId });
    }
    const nextAttempt = args.attempt + 1;
    const retrying = failed.length > 0 && nextAttempt < MAX_DELETION_ATTEMPTS;
    if (retrying) {
      await ctx.scheduler.runAfter(deletionRetryDelayMs(nextAttempt), internal.ebayConnect.processAccountDeletion, {
        ebayUserId: args.ebayUserId,
        ownerIds: failed,
        attempt: nextAttempt,
      });
    }
    const log = failed.length > 0 && !retrying ? console.error : console.log;
    log(
      JSON.stringify({
        msg: "ebay_account_deletion",
        platform: "ebay",
        operation: "process",
        attempt: args.attempt,
        owners: owners.length,
        failed: failed.length,
        outcome: failed.length === 0 ? "done" : retrying ? "retry_scheduled" : "gave_up",
        durationMs: Date.now() - startedAt,
      }),
    );
    return null;
  },
});
