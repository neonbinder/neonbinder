/**
 * NEO-415 — a collector's eBay seller connection and the settings eBay needs
 * before NeonBinder lists anything there.
 *
 * eBay signs in by OAuth consent, never by password: `beginConnect` mints a
 * one-use nonce (the OAuth `state`) and hands the web eBay's consent URL;
 * eBay redirects back to the web with `code` and `state`; `completeConnect`
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
import { ebayAuthorizeUrl, ebayConfig, ebayConfigured } from "./lib/ebayEnv";
import {
  EBAY_ESE_SERVICE_CODE,
  EBAY_MARKETPLACE_ID,
  EBAY_MERCHANT_LOCATION_KEY,
  ebaySetupMissing,
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
  upsertInventoryLocation,
  withdrawOffer,
  type EbayFailure,
  type EbaySellerSession,
} from "./adapters/ebaySeller";
import type { EbayConnectError } from "./credentials";

// ── Copy (NB voice; the web shows these sentences as they are) ─────────────

const NOT_CONFIGURED = "eBay isn't hooked up on this NeonBinder yet.";
const PAUSED = "eBay is on pause for now. Check back soon.";
const NOT_CONNECTED = "Connect your eBay seller account first.";
const NONCE_STALE = "That eBay hookup timed out. Press Connect again.";
const CONNECT_ERRORS: Record<EbayConnectError, string> = {
  busy: "NeonBinder is already working on your eBay hookup. Give it a sec and try again.",
  notConfigured: NOT_CONFIGURED,
  consentRefused: "eBay didn't let that one through. Press Connect and say yes on eBay's page.",
  unavailable: "eBay's not answering right now. Try again in a bit.",
  serviceNotReady: "NeonBinder's eBay hookup is still warming up. Try again in a few minutes.",
  badRequest: "That eBay answer didn't look right. Press Connect again.",
  internal: "Something hiccuped on our side. Try again in a bit.",
};
const ESE_FOR_20_PLUS =
  "Standard Envelope only covers cards under $20. Pick a policy with tracked shipping for cards $20 and up.";
const POLICY_GONE = "eBay doesn't have that policy on your account anymore. Pick another.";
const OPT_IN_PENDING =
  "eBay is still switching on business policies for your account. Try Set me up again in a few minutes.";

/** How long a Connect press's nonce is good for. */
const CONNECT_NONCE_TTL_MS = 15 * 60 * 1000;
const MAX_CODE_LENGTH = 4096;
const MAX_STATE_LENGTH = 128;
const MAX_POLICY_ID = 64;
/** Rows one purge or listing page touches. */
const PURGE_PAGE = 200;

/** NB's standard policies "Set me up" makes on the seller's account (names are the idempotency key). */
export const NB_POLICY_NAMES = {
  ese: "NB Standard Envelope (under $20)",
  tracked: "NB Tracked (USPS Ground Advantage)",
  free: "NB Free Shipping",
  payment: "NB Payment",
  returns: "NB Returns (30 days)",
} as const;
/** Defaults for those policies. Product defaults, open for Jason to change. */
const NB_POLICY_DEFAULTS = {
  eseCost: "1.00",
  trackedCost: "4.99",
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
  v.literal("shippingUnder20"),
  v.literal("shipping20Plus"),
  v.literal("payment"),
  v.literal("returns"),
  v.literal("location"),
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

/** Starts a Connect press: a fresh nonce (replacing any earlier one) and eBay's consent URL. */
export const beginConnect = mutation({
  args: {},
  returns: v.object({ authorizeUrl: v.string() }),
  handler: async (ctx) => {
    const ownerId = await requireSignedIn(ctx);
    const config = ebayConfig();
    if (!config) throw new Error(NOT_CONFIGURED);
    if (isPlatformPaused("ebay")) throw new Error(PAUSED);
    const nonce = newNonce();
    await patchSettings(ctx, ownerId, { connectNonce: nonce, connectNonceAt: Date.now() });
    return { authorizeUrl: ebayAuthorizeUrl(config, nonce) };
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

/** `credentials.connectEbay` records the display username and when the connection started. */
export const recordConnection = internalMutation({
  args: { ownerId: v.string(), ebayUsername: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await patchSettings(ctx, args.ownerId, {
      ebayUsername: args.ebayUsername.slice(0, 64),
      connectedAt: Date.now(),
      connectNonce: undefined,
      connectNonceAt: undefined,
    });
    return null;
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

/** Disconnect's last step: the settings row goes (a reconnect starts setup fresh). */
export const deleteEbaySettings = internalMutation({
  args: { ownerId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await settingsOf(ctx, args.ownerId);
    if (row) await ctx.db.delete(row._id);
    return null;
  },
});

/** Time Disconnect spends taking listings down before it gives up on the rest. */
const WITHDRAW_BUDGET_MS = 8 * 60 * 1000;

/**
 * Takes every live NB listing on the owner's eBay account down
 * (`withdrawOffer`), best effort: a listing eBay will not end is logged and
 * counted, never a reason to keep the session. Returns how many were ended
 * and how many were not; null when eBay could not be reached at all (not
 * wired, paused, no session), which the caller logs.
 */
async function withdrawAllLive(ctx: ActionCtx, ownerId: string): Promise<{ ended: number; failed: number } | null> {
  if (!ebayConfigured() || isPlatformPaused("ebay")) return null;
  const opened = await openEbaySellerSession(ctx, ownerId);
  if (!opened.ok) return null;
  const startedAt = Date.now();
  let ended = 0;
  let failed = 0;
  for (let cursor: string | null = null; ; ) {
    const page: { offers: Array<{ sku: string; offerId: string }>; cursor: string; isDone: boolean } = await ctx.runQuery(
      internal.ebayConnect.liveEbayLinksPage,
      { ownerId, cursor },
    );
    for (const offer of page.offers) {
      if (Date.now() - startedAt > WITHDRAW_BUDGET_MS) {
        failed += 1;
        continue;
      }
      const r = await withdrawOffer(ctx, opened.value, offer.offerId);
      // 404: eBay no longer has it live.
      if (r.ok || r.failure.httpStatus === 404) ended += 1;
      else failed += 1;
    }
    if (page.isDone) break;
    cursor = page.cursor;
  }
  return { ended, failed };
}

/**
 * Disconnects eBay. NB's listings come down first: listing stops (so no
 * drain puts them back), every live NB listing is withdrawn on eBay (best
 * effort; otherwise eBay keeps selling quantities NB no longer updates),
 * then the stored session, the link rows and the settings go. Sales history
 * stays.
 */
export const disconnect = action({
  args: {},
  returns: v.object({ ok: v.boolean() }),
  handler: async (ctx): Promise<{ ok: boolean }> => {
    const ownerId = await requireSignedIn(ctx);
    const startedAt = Date.now();
    await ctx.runMutation(internal.ebayConnect.stopEbayListing, { ownerId });
    const withdrawn = await withdrawAllLive(ctx, ownerId);
    const result = await ctx.runAction(internal.credentials.disconnectEbay, { userId: ownerId });
    if (result.ok) {
      for (let page = 0; page < 500; page += 1) {
        const more = await ctx.runMutation(internal.ebayConnect.purgeEbayDataPage, { ownerId, history: false });
        if (!more) break;
      }
      await ctx.runMutation(internal.ebayConnect.deleteEbaySettings, { ownerId });
    }
    console.log(
      JSON.stringify({
        msg: "ebay_disconnect",
        platform: "ebay",
        operation: "disconnect",
        ok: result.ok,
        withdrawReached: withdrawn !== null,
        ended: withdrawn?.ended ?? 0,
        failed: withdrawn?.failed ?? 0,
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

/** The seller's three policy lists (empty when the account is not in business policies yet). */
async function readPolicyLists(
  ctx: ActionCtx,
  session: EbaySellerSession,
): Promise<{ ok: true; lists: PolicyLists; optedIn: boolean } | Fail> {
  const programs = await getOptedInPrograms(ctx, session);
  if (!programs.ok) return { ok: false, error: programs.failure.message };
  if (!programs.value.includes(SELLING_POLICY_MANAGEMENT)) {
    return { ok: true, lists: { fulfillment: [], payment: [], returns: [] }, optedIn: false };
  }
  const [fulfillment, payment, returns] = await Promise.all([
    getPolicies(ctx, session, "fulfillment_policy"),
    getPolicies(ctx, session, "payment_policy"),
    getPolicies(ctx, session, "return_policy"),
  ]);
  for (const r of [fulfillment, payment, returns]) if (!r.ok) return { ok: false, error: r.failure.message };
  if (!fulfillment.ok || !payment.ok || !returns.ok) return { ok: false, error: CONNECT_ERRORS.unavailable };
  return {
    ok: true,
    optedIn: true,
    lists: {
      fulfillment: readFulfillmentPolicies(fulfillment.value).map((p) => ({ id: p.id, name: p.name, ...policyFitness(p) })),
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

function fulfillmentBody(name: string, serviceCode: string, cost: string, free: boolean): Record<string, unknown> {
  return {
    name,
    marketplaceId: EBAY_MARKETPLACE_ID,
    categoryTypes: CATEGORY_TYPES,
    handlingTime: { value: NB_POLICY_DEFAULTS.handlingDays, unit: "DAY" },
    shippingOptions: [
      {
        optionType: "DOMESTIC",
        costType: "FLAT_RATE",
        shippingServices: [
          {
            shippingServiceCode: serviceCode,
            shippingCost: { value: free ? "0.00" : cost, currency: "USD" },
            freeShipping: free,
            sortOrder: 1,
          },
        ],
      },
    ],
  };
}

/**
 * eBay's USPS Ground Advantage service code, read from eBay's own metadata
 * (never hard-coded): a domestic service valid for selling whose code names
 * Ground Advantage. Null when eBay lists none.
 */
function groundAdvantageCode(services: Array<{ code: string; international: boolean; validForSelling: boolean }>): string | null {
  const domestic = services.filter((s) => !s.international && s.validForSelling && /groundadvantage/i.test(s.code));
  return (domestic.find((s) => /^USPS/i.test(s.code)) ?? domestic[0])?.code ?? null;
}

/**
 * "Set me up": NB's standard policies on the collector's eBay account —
 * Standard Envelope (cards under $20), Tracked (USPS Ground Advantage) and
 * Free Shipping (Ground Advantage at $0), plus a payment and a return policy
 * only when the account has none. Opts the account into business policies
 * first when needed. Idempotent by name: a policy NB already made is not
 * made again. Fills only EMPTY settings slots with what it made.
 */
export const createStandardPolicies = action({
  args: {},
  returns: v.union(v.object({ ok: v.literal(true), created: v.array(v.string()) }), errorResult),
  handler: async (ctx): Promise<{ ok: true; created: string[] } | Fail> => {
    const ownerId = await requireSignedIn(ctx);
    const opened = await sessionFor(ctx, ownerId);
    if (!opened.ok) return opened;
    const session = opened.session;
    let read = await readPolicyLists(ctx, session);
    if (!read.ok) return read;
    let justOptedIn = false;
    if (!read.optedIn) {
      const optIn = await optInToProgram(ctx, session, SELLING_POLICY_MANAGEMENT);
      if (!optIn.ok) return { ok: false, error: optIn.failure.message };
      justOptedIn = true;
      read = await readPolicyLists(ctx, session);
      if (!read.ok) return { ok: false, error: OPT_IN_PENDING };
    }
    const services = await getShippingServices(ctx, session);
    if (!services.ok) return { ok: false, error: services.failure.message };
    const ground = groundAdvantageCode(services.value);
    if (!ground) return { ok: false, error: "eBay didn't offer USPS Ground Advantage, so NeonBinder couldn't make tracked shipping." };

    const byName = new Map(read.lists.fulfillment.map((p) => [p.name, p.id]));
    const created: string[] = [];
    const ids: { ese?: string; tracked?: string; free?: string; payment?: string; returns?: string } = {
      ese: byName.get(NB_POLICY_NAMES.ese),
      tracked: byName.get(NB_POLICY_NAMES.tracked),
      free: byName.get(NB_POLICY_NAMES.free),
    };
    const make = async (
      slot: keyof typeof ids,
      kind: "fulfillment_policy" | "payment_policy" | "return_policy",
      name: string,
      body: Record<string, unknown>,
    ): Promise<Fail | null> => {
      const r = await createPolicy(ctx, session, kind, body);
      if (!r.ok) return { ok: false, error: justOptedIn ? OPT_IN_PENDING : r.failure.message };
      ids[slot] = r.value;
      created.push(name);
      return null;
    };
    const steps: Array<() => Promise<Fail | null>> = [];
    if (!ids.ese) {
      steps.push(() =>
        make("ese", "fulfillment_policy", NB_POLICY_NAMES.ese, fulfillmentBody(NB_POLICY_NAMES.ese, EBAY_ESE_SERVICE_CODE, NB_POLICY_DEFAULTS.eseCost, false)),
      );
    }
    if (!ids.tracked) {
      steps.push(() =>
        make("tracked", "fulfillment_policy", NB_POLICY_NAMES.tracked, fulfillmentBody(NB_POLICY_NAMES.tracked, ground, NB_POLICY_DEFAULTS.trackedCost, false)),
      );
    }
    if (!ids.free) {
      steps.push(() => make("free", "fulfillment_policy", NB_POLICY_NAMES.free, fulfillmentBody(NB_POLICY_NAMES.free, ground, "0.00", true)));
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
    if (!r.ok) return { ok: false, error: r.failure.message };
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
// POST {metadata:{topic:"MARKETPLACE_ACCOUNT_DELETION"}, notification:{data:{username, userId, eiasToken}}} → 200,
//      then NB deletes its eBay-side data for that seller (scheduled).
//
// The POST carries an `X-EBAY-SIGNATURE` header NB does NOT verify here:
// verifying needs eBay's public key, fetched with an application token,
// which needs the client secret only the browser service holds. Until a
// verify route exists there, the scheduled delete acts only when BOTH the
// eBay user id and the username match what NB stored at Connect, and deletes
// only NB's eBay-side linkage (never a copy, card or box).

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
const MAX_NOTICE_BYTES = 64 * 1024;
const EBAY_USER_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

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

/** POST: a seller deleted their eBay account. Acknowledge at once; delete on the scheduler. */
export const ebayDeletionNotice = httpAction(async (ctx, req) => {
  const raw = await req.text().catch(() => "");
  if (raw.length > MAX_NOTICE_BYTES) return new Response(null, { status: 413 });
  let body: unknown = null;
  try {
    body = JSON.parse(raw);
  } catch {
    body = null;
  }
  const metadata = isRecord(body) && isRecord(body.metadata) ? body.metadata : null;
  const notification = isRecord(body) && isRecord(body.notification) ? body.notification : null;
  const data = notification && isRecord(notification.data) ? notification.data : null;
  const userId = typeof data?.userId === "string" ? data.userId.trim() : "";
  const username = typeof data?.username === "string" ? data.username.trim().slice(0, 64) : "";
  if (metadata?.topic === "MARKETPLACE_ACCOUNT_DELETION" && EBAY_USER_ID_RE.test(userId) && username.length > 0) {
    await ctx.scheduler.runAfter(0, internal.ebayConnect.processAccountDeletion, { ebayUserId: userId, ebayUsername: username });
  }
  console.log(
    JSON.stringify({ msg: "ebay_account_deletion", platform: "ebay", operation: "notice", accepted: userId.length > 0 }),
  );
  // eBay wants a 2xx for every notice, including ones for sellers NB never saw.
  return new Response(null, { status: 200 });
});

/** The NB owners holding this eBay seller account, where the stored username matches too. */
export const ownersForEbayAccount = internalQuery({
  args: { ebayUserId: v.string(), ebayUsername: v.string() },
  returns: v.array(v.string()),
  handler: async (ctx, args) => {
    const profiles = await ctx.db
      .query("userProfiles")
      .withIndex("by_ebay_user", (q) => q.eq("marketplaceAccountIds.ebayUserId", args.ebayUserId))
      .take(10);
    const owners: string[] = [];
    for (const profile of profiles) {
      const settings = await settingsOf(ctx, profile.userId);
      const stored = settings?.ebayUsername;
      // Connect stores the id as the username when eBay sent none.
      if (stored === undefined || stored.toLowerCase() === args.ebayUsername.toLowerCase() || stored === args.ebayUserId) {
        owners.push(profile.userId);
      }
    }
    return owners;
  },
});

/**
 * One page of an owner's NB-side eBay data: link rows, then (with
 * `history`, the account-deletion path) eBay sales and sync records. True
 * when more remain.
 */
export const purgeEbayDataPage = internalMutation({
  args: { ownerId: v.string(), history: v.boolean() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const links = await ctx.db
      .query("marketplaceListingLinks")
      .withIndex("by_owner_platform_card_condition", (q) => q.eq("ownerId", args.ownerId).eq("platform", "ebay"))
      .take(PURGE_PAGE);
    for (const row of links) await ctx.db.delete(row._id);
    if (links.length === PURGE_PAGE) return true;
    if (!args.history) return false;
    const sales = await ctx.db
      .query("marketplaceSales")
      .withIndex("by_owner_platform_order", (q) => q.eq("ownerId", args.ownerId).eq("platform", "ebay"))
      .take(PURGE_PAGE);
    for (const row of sales) await ctx.db.delete(row._id);
    if (sales.length === PURGE_PAGE) return true;
    const syncs = await ctx.db
      .query("marketplaceListingSyncs")
      .withIndex("by_owner_platform_run", (q) => q.eq("ownerId", args.ownerId).eq("platform", "ebay"))
      .take(PURGE_PAGE);
    for (const row of syncs) await ctx.db.delete(row._id);
    return syncs.length === PURGE_PAGE;
  },
});

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
 * Deletes NB's eBay-side data for a seller who deleted their eBay account:
 * the stored session and saved sign-in (`credentials.disconnectEbay`, which
 * stops listing), the link rows, the eBay sales and sync records, the
 * settings row, and the eBay user id NB kept. NB's own copies, cards and
 * boxes stay. Safe to retry: every step is a no-op once done.
 */
export const processAccountDeletion = internalAction({
  args: { ebayUserId: v.string(), ebayUsername: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const startedAt = Date.now();
    const owners: string[] = await ctx.runQuery(internal.ebayConnect.ownersForEbayAccount, args);
    for (const ownerId of owners) {
      const disconnected = await ctx.runAction(internal.credentials.disconnectEbay, { userId: ownerId });
      if (!disconnected.ok) {
        // The lock is held or the service is down: try again shortly.
        await ctx.scheduler.runAfter(60_000, internal.ebayConnect.processAccountDeletion, args);
        continue;
      }
      for (let page = 0; page < 500; page += 1) {
        const more = await ctx.runMutation(internal.ebayConnect.purgeEbayDataPage, { ownerId, history: true });
        if (!more) break;
      }
      await ctx.runMutation(internal.ebayConnect.forgetEbayAccount, { ownerId, ebayUserId: args.ebayUserId });
    }
    console.log(
      JSON.stringify({
        msg: "ebay_account_deletion",
        platform: "ebay",
        operation: "process",
        owners: owners.length,
        durationMs: Date.now() - startedAt,
      }),
    );
    return null;
  },
});
