/**
 * NEO-121 — scan visibility for bought postage.
 *
 * Two ways a `labelPurchases` row learns what USPS has done with the letter,
 * both landing in the SAME snapshot mutation:
 *
 *  1. **EasyPost webhooks** (the live path). Each seller has their own EasyPost
 *     account (NEO-120), so each seller gets their own webhook, registered on
 *     their account with their key — through the browser service, because the
 *     key never reaches Convex. The URL carries a per-seller random token and
 *     the body is HMAC'd with a per-seller random secret. See the
 *     `easypostWebhooks` table comment for why both exist.
 *  2. **`postage.refreshTracking`** (the backstop). A seller-pressed button for
 *     rows bought before webhooks existed, for the deploy window, and for the
 *     day a webhook silently stops.
 *
 * ## Runtime split — why the outbound calls are NOT in this file
 * {@link handleEasypostWebhook} is an `httpAction`, which pins this module to
 * the default Convex runtime. The browser-service transport
 * (`browserFetch`/`browserAuthHeaders`) lives behind `google-auth-library` and
 * is therefore `"use node"`, and a default-runtime module cannot import a Node
 * one. So the split is: POLICY here (when to register, what to adopt, what to
 * record), TRANSPORT in `convex/postage.ts` (`easypostListWebhooks`,
 * `easypostCreateWebhook`, `easypostDeleteWebhook`), reached through the
 * generated `internal` object rather than an import. Moving the actions here
 * "for tidiness" will push and then fail at runtime.
 *
 * ## What is trustworthy here, and what is not
 * A tracker snapshot is SELLER-FORGEABLE: a seller can read their own webhook
 * URL and secret from the EasyPost dashboard and post whatever they like to
 * their own ingest path. That is contained — the webhook row's `userId` scopes
 * every write, so the worst case is fake scan lines on the seller's own rows —
 * but it means nothing on `labelPurchases` derived from a tracker is proof of
 * anything. Never build delivery guarantees, refunds, or money on these fields.
 */

import {
  httpAction,
  internalAction,
  internalMutation,
  internalQuery,
  query,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import type { QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { getCurrentUserId } from "./auth";
import { trackerSnapshotValidator } from "./schema";
import {
  computeEasypostSignature,
  constantTimeEqual,
  rewriteWeightForSignature,
} from "./lib/easypostWebhookSignature";

/** The url token is base64url of 32 random bytes — always exactly 43 chars. */
const URL_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** Path prefix the handler is mounted under (see convex/http.ts). */
const WEBHOOK_PATH_PREFIX = "/webhooks/easypost/";

/**
 * Every stored string is truncated to this. A tracker payload is attacker-
 * influenced (see the module comment), and a row that grows past Convex's
 * document limit would make every subsequent write throw — which EasyPost sees
 * as a failed delivery and retries, forever.
 */
const MAX_STORED_STRING = 200;

/** Newest N scans kept. A letter gets single digits; 50 is headroom, not a fit. */
const MAX_STORED_SCANS = 50;

/**
 * A `publicTrackingUrl` longer than this is DROPPED rather than truncated —
 * truncating a URL produces a broken link that looks real, which is worse than
 * no link. EasyPost's own public URLs are ~60 chars.
 */
const MAX_PUBLIC_URL = 200;

/** Request bodies above this are rejected unread-past. EasyPost sends ~4 KB. */
const MAX_BODY_BYTES = 256 * 1024;

/** No sooner than hourly between registration ATTEMPTS. */
const REGISTRATION_RETRY_MS = 60 * 60 * 1000;

/**
 * Deployments allowed to register a webhook on a seller's real EasyPost
 * account, by `*.convex.site` subdomain — dev and prod, nothing else.
 *
 * **Why an allowlist and not a preview-detector** (decision 5): a Convex
 * preview deployment is named exactly like a permanent one
 * (`adjective-animal-NN`), so there is no shape to detect and no built-in
 * "am I a preview" flag to read. An allowlist fails CLOSED on anything it does
 * not recognise, which is the safe direction: `preview-cleanup.yml` deletes the
 * per-PR deployment when the PR closes, and nothing would ever unregister the
 * hook it left behind on the shared test account. Every preview would leave one
 * more dead webhook, retried and eventually disabled by EasyPost, on an account
 * the E2E suite depends on.
 *
 * A deployment rename means registration stops, `lastError: "unavailable"`
 * appears on the setup chip, and this list needs the new name.
 */
const REGISTERABLE_DEPLOYMENTS = [
  "first-starfish-800", // production
  "focused-fox-53", // dev
];

type RegistrationError = "rejected" | "unauthorized" | "unavailable" | "no_key";

/**
 * The transport results from `convex/postage.ts`, restated here as types.
 *
 * NOT redundant, and not a style choice: this module and postage.ts call each
 * other through the generated `internal` object, which makes their inferred
 * types mutually recursive — TypeScript gives up and infers `any` (TS7022/7023)
 * for every function in the cycle, silently erasing the type safety of BOTH
 * modules and several unrelated ones that read `api`. Annotating the values
 * that cross the cycle breaks it. Keep these in step with the `returns`
 * validators on the postage.ts actions; a drift is a runtime validation error
 * there, not a silent bug here.
 */
type RegisteredHook = {
  webhookId: string;
  url: string;
  mode?: "test" | "production";
  disabledAt?: number;
};
type EnsureWebhookStatus =
  | "registered"
  | "adopted"
  | "deferred"
  | "skipped"
  | "failed";
type ListWebhooksResult =
  | { ok: true; hooks: RegisteredHook[] }
  | { ok: false; error: RegistrationError };
type CreateWebhookResult =
  | { ok: true; webhookId: string; mode?: "test" | "production" }
  | { ok: false; error: RegistrationError };

const registrationErrorValidator = v.union(
  v.literal("rejected"),
  v.literal("unauthorized"),
  v.literal("unavailable"),
  v.literal("no_key"),
);

/** Shape the browser service hands back, mirroring `trackerSnapshotValidator`. */
export interface TrackerSnapshot {
  trackerId: string;
  status: string;
  statusDetail?: string;
  updatedAt: number;
  lastScanAt?: number;
  estDeliveryAt?: number;
  publicTrackingUrl?: string;
  scans: Array<{
    at: number;
    status: string;
    message: string;
    city?: string;
    state?: string;
    zip?: string;
    country?: string;
  }>;
}

// ─── snapshot sanitising ─────────────────────────────────────────────────────

function truncate(value: string): string {
  return value.length > MAX_STORED_STRING ? value.slice(0, MAX_STORED_STRING) : value;
}

function truncateOptional(value: string | undefined): string | undefined {
  return value === undefined ? undefined : truncate(value);
}

/**
 * `https:` only, and short enough to store whole.
 *
 * Checked here rather than only at the anchor because a stored `javascript:`
 * URL is a trap for the NEXT reader of this table, who has no reason to expect
 * one. The frontend checks again — two cheap checks, one boundary each.
 */
function safePublicUrl(raw: string | undefined): string | undefined {
  if (!raw || raw.length > MAX_PUBLIC_URL) return undefined;
  try {
    return new URL(raw).protocol === "https:" ? raw : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The stored form of a tracker snapshot: every string truncated, scans sorted
 * oldest→newest and capped at the newest {@link MAX_STORED_SCANS}, public URL
 * scheme-checked.
 *
 * Exported because `shipping.recordLabelPurchase` writes the same fields from
 * the tracker the buy response carries — one sanitiser, so the webhook path and
 * the purchase path cannot diverge on what "stored" means.
 */
export function sanitizeSnapshot(snapshot: TrackerSnapshot) {
  const scans = [...snapshot.scans]
    .sort((a, b) => a.at - b.at)
    .slice(-MAX_STORED_SCANS)
    .map((scan) => ({
      at: scan.at,
      status: truncate(scan.status),
      message: truncate(scan.message),
      city: truncateOptional(scan.city),
      state: truncateOptional(scan.state),
      zip: truncateOptional(scan.zip),
      country: truncateOptional(scan.country),
    }));

  const lastScanAt =
    snapshot.lastScanAt ??
    (scans.length > 0 ? scans[scans.length - 1].at : undefined);

  return {
    trackerId: truncate(snapshot.trackerId),
    trackingStatus: truncate(snapshot.status),
    trackingStatusDetail: truncateOptional(snapshot.statusDetail),
    trackerUpdatedAt: snapshot.updatedAt,
    lastScanAt,
    estDeliveryAt: snapshot.estDeliveryAt,
    publicTrackingUrl: safePublicUrl(snapshot.publicTrackingUrl),
    scans,
  };
}

// ─── reads ───────────────────────────────────────────────────────────────────

/**
 * The webhook row a URL token names.
 *
 * Internal, and returns the `secret` — the handler needs it to verify the HMAC.
 * Neither the secret nor the token may appear in any PUBLIC validator; see
 * {@link getMyTrackingSetup}, which is the public view of this same row.
 */
export const getWebhookByToken = internalQuery({
  args: { urlToken: v.string() },
  returns: v.union(
    v.object({
      _id: v.id("easypostWebhooks"),
      userId: v.string(),
      secret: v.string(),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("easypostWebhooks")
      .withIndex("by_token", (q) => q.eq("urlToken", args.urlToken))
      .unique();
    if (!row) return null;
    return { _id: row._id, userId: row.userId, secret: row.secret };
  },
});

/**
 * The purchase row a webhook event belongs to — scoped to the webhook's own
 * user, so one seller's ingest path can never reach another seller's row even
 * if EasyPost sent the wrong shipment id.
 *
 * `.first()` and NOT `.unique()`: a duplicate row (two purchases recorded for
 * one shipment id — possible if a retried buy ever double-records) would make
 * `.unique()` throw INSIDE the webhook handler, which EasyPost reads as a
 * failed delivery and retries until it disables the hook. A duplicate is a
 * data annoyance; a wedged webhook is the feature not working.
 */
export const findPurchaseForWebhook = internalQuery({
  args: { userId: v.string(), easypostShipmentId: v.string() },
  returns: v.union(v.id("labelPurchases"), v.null()),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("labelPurchases")
      .withIndex("by_shipment", (q) =>
        q.eq("easypostShipmentId", args.easypostShipmentId),
      )
      .filter((q) => q.eq(q.field("userId"), args.userId))
      .first();
    return row?._id ?? null;
  },
});

/** Internal read of the seller's webhook row, for the registration actions. */
export const getWebhookStateForUser = internalQuery({
  args: { userId: v.string() },
  returns: v.union(
    v.object({
      _id: v.id("easypostWebhooks"),
      urlToken: v.string(),
      secret: v.string(),
      webhookId: v.optional(v.string()),
      url: v.string(),
      lastAttemptAt: v.number(),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const row = await readWebhookRow(ctx, args.userId);
    if (!row) return null;
    return {
      _id: row._id,
      urlToken: row.urlToken,
      secret: row.secret,
      webhookId: row.webhookId,
      url: row.url,
      lastAttemptAt: row.lastAttemptAt,
    };
  },
});

/** Whether the seller already has a live registration — the buy path's gate. */
export const isWebhookRegistered = internalQuery({
  args: { userId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const row = await readWebhookRow(ctx, args.userId);
    return !!row?.webhookId && !row.disabledAt;
  },
});

/**
 * What the seller is told about scan updates, on `/print/labels`.
 *
 * The validator is deliberately a closed object with FOUR fields and no
 * pass-through of the row: `urlToken` is a bearer credential and `secret` is an
 * HMAC key, and returning the document would hand both to any signed-in client.
 * `lastError` is an NB-authored enum for the same reason — EasyPost's own error
 * text echoes the URL it rejected, and that URL contains the token.
 */
export const getMyTrackingSetup = query({
  args: {},
  returns: v.object({
    connected: v.boolean(),
    pending: v.boolean(),
    lastEventAt: v.optional(v.number()),
    lastError: v.optional(registrationErrorValidator),
  }),
  handler: async (ctx) => {
    const userId = await getCurrentUserId(ctx);
    if (!userId) return { connected: false, pending: false };

    const row = await readWebhookRow(ctx, userId);
    if (!row) return { connected: false, pending: false };

    const connected = !!row.webhookId && !row.disabledAt;
    return {
      connected,
      // An attempt is in flight (or scheduled) when the row exists, has no
      // hook yet, and has not recorded a reason. Anything else is a state the
      // seller can act on, so it must not read as "connecting…" forever.
      pending: !connected && row.lastError === undefined,
      lastEventAt: row.lastEventAt,
      lastError: row.lastError,
    };
  },
});

/**
 * One row per user (the table comment says so), so `.first()` on `by_user` is
 * the whole read. Shared by every reader here rather than repeated, because
 * "which row is the seller's" must have exactly one answer.
 */
async function readWebhookRow(
  ctx: QueryCtx,
  userId: string,
): Promise<Doc<"easypostWebhooks"> | null> {
  return await ctx.db
    .query("easypostWebhooks")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .first();
}

// ─── writes ──────────────────────────────────────────────────────────────────

/**
 * Apply a tracker snapshot to one purchase row.
 *
 * Three guards, each of which has to hold on its own:
 *
 *  - **Ownership is re-asserted HERE**, not only at the caller (the NEO-213
 *    lesson: `getLabelPurchaseForUser` proves a row is the caller's, and the
 *    write that trusts it must prove it again — the two are one boundary).
 *    A mismatch throws, because it can only mean a caller bug or an attack.
 *  - **Monotonic**: nothing is applied unless the snapshot is strictly newer
 *    than what the row already has. EasyPost redelivers, reorders, and repeats;
 *    every one of those is a no-op rather than a rewrite with stale data.
 *  - **Bounded**: {@link sanitizeSnapshot} truncates and caps, so a hostile
 *    payload cannot push the row past the document limit.
 *
 * `refreshedAt` stamps the cooldown clock and is applied EVEN WHEN the snapshot
 * is a no-op — the seller pressed the button and EasyPost was called, which is
 * exactly what the cooldown exists to rate-limit.
 */
export const applyTrackerSnapshot = internalMutation({
  args: {
    purchaseId: v.id("labelPurchases"),
    userId: v.string(),
    snapshot: trackerSnapshotValidator,
    refreshedAt: v.optional(v.number()),
  },
  returns: v.object({ applied: v.boolean(), newScans: v.number() }),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.purchaseId);
    if (!row) return { applied: false, newScans: 0 };
    if (row.userId !== args.userId) {
      // Never reachable from the webhook (the row is FOUND by userId) nor from
      // refreshTracking (ownership proved first). Loud on purpose.
      throw new Error("applyTrackerSnapshot: purchase row belongs to another user");
    }

    if (args.refreshedAt !== undefined) {
      await ctx.db.patch(args.purchaseId, { lastRefreshAt: args.refreshedAt });
    }

    if (args.snapshot.updatedAt <= (row.trackerUpdatedAt ?? -1)) {
      return { applied: false, newScans: 0 };
    }

    const clean = sanitizeSnapshot(args.snapshot);
    const previousLastScanAt = row.lastScanAt ?? -1;
    const newScans = clean.scans.filter((scan) => scan.at > previousLastScanAt).length;

    // `undefined` on a patch REMOVES the field, which is the behaviour we want:
    // a snapshot is a replacement, so a detail EasyPost dropped must not linger.
    await ctx.db.patch(args.purchaseId, clean);

    return { applied: true, newScans };
  },
});

/** Record that a verified event arrived, for the setup chip's "last event". */
export const touchWebhookEvent = internalMutation({
  args: { webhookRowId: v.id("easypostWebhooks"), at: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.webhookRowId);
    if (!row) return null;
    await ctx.db.patch(args.webhookRowId, { lastEventAt: args.at });
    return null;
  },
});

/**
 * Create the seller's webhook row if it does not exist, and stamp the attempt.
 *
 * The token and secret are MINTED BY THE CALLING ACTION and passed in, rather
 * than generated here: a mutation can be retried by Convex, and fresh random
 * bytes on a retry would mean a row whose token no longer matches the URL a
 * previous attempt may already have registered. Generated once, in the action,
 * and only used if this insert actually happens.
 */
export const ensureWebhookRow = internalMutation({
  args: {
    userId: v.string(),
    urlToken: v.string(),
    secret: v.string(),
    url: v.string(),
    attemptAt: v.number(),
  },
  returns: v.object({
    _id: v.id("easypostWebhooks"),
    urlToken: v.string(),
    secret: v.string(),
    webhookId: v.optional(v.string()),
    url: v.string(),
  }),
  handler: async (ctx, args) => {
    const existing = await readWebhookRow(ctx, args.userId);
    if (existing) {
      await ctx.db.patch(existing._id, { lastAttemptAt: args.attemptAt });
      return {
        _id: existing._id,
        urlToken: existing.urlToken,
        secret: existing.secret,
        webhookId: existing.webhookId,
        url: existing.url,
      };
    }

    const _id = await ctx.db.insert("easypostWebhooks", {
      userId: args.userId,
      urlToken: args.urlToken,
      secret: args.secret,
      url: args.url,
      lastAttemptAt: args.attemptAt,
    });
    return {
      _id,
      urlToken: args.urlToken,
      secret: args.secret,
      webhookId: undefined,
      url: args.url,
    };
  },
});

/** Patch the outcome of a registration attempt onto the row. */
export const recordRegistrationResult = internalMutation({
  args: {
    webhookRowId: v.id("easypostWebhooks"),
    webhookId: v.optional(v.string()),
    mode: v.optional(v.union(v.literal("test"), v.literal("production"))),
    url: v.optional(v.string()),
    registeredAt: v.optional(v.number()),
    disabledAt: v.optional(v.number()),
    lastError: v.optional(registrationErrorValidator),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.webhookRowId);
    if (!row) return null;

    if (args.lastError !== undefined) {
      await ctx.db.patch(args.webhookRowId, { lastError: args.lastError });
      return null;
    }

    // Success: adopt the registration and clear any recorded reason. `mode`,
    // `disabledAt` and `lastError` are patched with `undefined` when absent,
    // which removes them — a hook we just (re)registered is not disabled and
    // has no outstanding error.
    await ctx.db.patch(args.webhookRowId, {
      webhookId: args.webhookId,
      mode: args.mode,
      url: args.url ?? row.url,
      registeredAt: args.registeredAt,
      disabledAt: args.disabledAt,
      lastError: undefined,
    });
    return null;
  },
});

/** Drop the row once EasyPost has confirmed the hook is gone. */
export const deleteWebhookRow = internalMutation({
  args: { webhookRowId: v.id("easypostWebhooks") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.webhookRowId);
    if (row) await ctx.db.delete(args.webhookRowId);
    return null;
  },
});

// ─── registration (policy; transport lives in postage.ts) ────────────────────

/**
 * Base64url of 32 random bytes → 43 chars, matching {@link URL_TOKEN_RE}.
 *
 * Hand-rolled rather than `btoa` + replace so it depends on nothing but
 * `crypto.getRandomValues`, which every Convex runtime has.
 */
function randomToken(): string {
  const ALPHABET =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);

  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const remaining = bytes.length - i;
    const b0 = bytes[i];
    const b1 = remaining > 1 ? bytes[i + 1] : 0;
    const b2 = remaining > 2 ? bytes[i + 2] : 0;
    out += ALPHABET[b0 >> 2];
    out += ALPHABET[((b0 & 0b11) << 4) | (b1 >> 4)];
    if (remaining > 1) out += ALPHABET[((b1 & 0b1111) << 2) | (b2 >> 6)];
    if (remaining > 2) out += ALPHABET[b2 & 0b111111];
  }
  return out;
}

/**
 * The `*.convex.site` base for this deployment's HTTP actions, but only on a
 * deployment that is allowed to register (see {@link REGISTERABLE_DEPLOYMENTS}).
 * `null` means "do not register from here".
 */
function registrableSiteUrl(): string | null {
  const siteUrl = process.env.CONVEX_SITE_URL;
  if (!siteUrl) return null;

  let host: string;
  try {
    const parsed = new URL(siteUrl);
    if (parsed.protocol !== "https:") return null;
    host = parsed.host;
  } catch {
    return null;
  }

  const slug = host.split(".")[0];
  if (!REGISTERABLE_DEPLOYMENTS.includes(slug)) return null;
  return siteUrl.replace(/\/+$/, "");
}

/**
 * Make sure this seller's EasyPost account has our webhook registered — the
 * self-healing half of decision 5.
 *
 * Scheduled (never awaited) from `postage.saveEasypostKey` and from a
 * successful `postage.buyLetterLabel`, which is how a seller who saved their
 * key before this feature existed gets registered without doing anything.
 * Nothing here can fail the money path, and nothing here throws: every failure
 * becomes an enum on the row and a retry no sooner than an hour later.
 *
 * **Reconcile before create.** A lost response from a previous attempt would
 * otherwise leave a hook we never recorded, and creating a second one means
 * EasyPost delivers every event twice, forever, with no way to tell which hook
 * to remove. So: list the account's hooks first, adopt one whose URL is exactly
 * ours, delete any other hook under our prefix (a stale token, or a preview's
 * leftovers), and only then create.
 *
 * "Our prefix" is deliberately THIS deployment's site URL and not any
 * `/webhooks/easypost/` path: a seller could have the same EasyPost key saved
 * on dev and on prod, and a broader match would have each deployment delete the
 * other's hook on every attempt, forever. The cost is that a hook left behind by
 * a CHANGED `CONVEX_SITE_URL` is not reaped here — it points at a site that no
 * longer answers, and EasyPost disables it on its own.
 */
export const ensureWebhook = internalAction({
  args: { userId: v.string() },
  returns: v.object({
    status: v.union(
      v.literal("registered"),
      v.literal("adopted"),
      v.literal("deferred"),
      v.literal("skipped"),
      v.literal("failed"),
    ),
  }),
  handler: async (ctx, args): Promise<{ status: EnsureWebhookStatus }> => {
    const now = Date.now();
    const siteUrl = registrableSiteUrl();

    const existing = await ctx.runQuery(
      internal.shipmentTracking.getWebhookStateForUser,
      { userId: args.userId },
    );

    if (!siteUrl) {
      // A preview (or an unrecognised deployment). Record the reason so the
      // seller's chip says something honest, and never call EasyPost.
      if (existing) {
        await ctx.runMutation(internal.shipmentTracking.recordRegistrationResult, {
          webhookRowId: existing._id,
          lastError: "unavailable",
        });
      }
      return { status: "skipped" as const };
    }

    const prefix = `${siteUrl}${WEBHOOK_PATH_PREFIX}`;

    if (existing?.webhookId && existing.url === `${prefix}${existing.urlToken}`) {
      return { status: "registered" as const };
    }
    if (existing && now - existing.lastAttemptAt < REGISTRATION_RETRY_MS) {
      return { status: "deferred" as const };
    }

    const row = await ctx.runMutation(internal.shipmentTracking.ensureWebhookRow, {
      userId: args.userId,
      urlToken: randomToken(),
      secret: randomToken(),
      url: "", // replaced by the registered URL on success
      attemptAt: now,
    });
    const desiredUrl = `${prefix}${row.urlToken}`;

    const listed: ListWebhooksResult = await ctx.runAction(
      internal.postage.easypostListWebhooks,
      { userId: args.userId },
    );
    if (!listed.ok) {
      await ctx.runMutation(internal.shipmentTracking.recordRegistrationResult, {
        webhookRowId: row._id,
        lastError: listed.error,
      });
      return { status: "failed" as const };
    }

    const ours = listed.hooks.filter((hook) => hook.url.startsWith(prefix));
    const mine = ours.find((hook) => hook.url === desiredUrl);

    // Anything else under our prefix is a hook we can no longer verify bodies
    // for (its token is not this row's) — a torn-down preview, or a token that
    // was rotated. Leaving it means duplicate deliveries and eventually an
    // EasyPost-disabled account hook. Best effort: a failed delete is not a
    // reason to skip registering.
    for (const stale of ours) {
      if (stale.webhookId === mine?.webhookId) continue;
      await ctx.runAction(internal.postage.easypostDeleteWebhook, {
        userId: args.userId,
        webhookId: stale.webhookId,
      });
    }

    if (mine) {
      await ctx.runMutation(internal.shipmentTracking.recordRegistrationResult, {
        webhookRowId: row._id,
        webhookId: mine.webhookId,
        mode: mine.mode,
        url: desiredUrl,
        registeredAt: now,
        // Mirrored, not cleared: an adopted hook EasyPost has already disabled
        // is not working, and the chip must not claim it is.
        disabledAt: mine.disabledAt,
      });
      return { status: "adopted" as const };
    }

    const created: CreateWebhookResult = await ctx.runAction(
      internal.postage.easypostCreateWebhook,
      { userId: args.userId, url: desiredUrl, secret: row.secret },
    );
    if (!created.ok) {
      await ctx.runMutation(internal.shipmentTracking.recordRegistrationResult, {
        webhookRowId: row._id,
        lastError: created.error,
      });
      return { status: "failed" as const };
    }

    await ctx.runMutation(internal.shipmentTracking.recordRegistrationResult, {
      webhookRowId: row._id,
      webhookId: created.webhookId,
      mode: created.mode,
      url: desiredUrl,
      registeredAt: now,
    });
    return { status: "registered" as const };
  },
});

/**
 * Unregister this seller's webhook, before their key is deleted.
 *
 * `postage.clearEasypostKey` AWAITS this rather than scheduling it: scheduled,
 * it would run after the key is gone and could never authenticate, leaving a
 * hook on the seller's account that we can no longer remove and they did not
 * ask to keep.
 *
 * The row is deleted ONLY on a confirmed delete (EasyPost's own 404 counts —
 * the browser client decides that, so the router's "no key saved" JSON 404 can
 * never be mistaken for a completed delete). Otherwise the row stays, with its
 * `webhookId`, so a later attempt can finish the job.
 */
export const removeWebhook = internalAction({
  args: { userId: v.string() },
  returns: v.object({ removed: v.boolean() }),
  handler: async (ctx, args): Promise<{ removed: boolean }> => {
    const row = await ctx.runQuery(
      internal.shipmentTracking.getWebhookStateForUser,
      { userId: args.userId },
    );
    if (!row) return { removed: true };

    if (row.webhookId) {
      const result: { confirmed: boolean } = await ctx.runAction(
        internal.postage.easypostDeleteWebhook,
        { userId: args.userId, webhookId: row.webhookId },
      );
      if (!result.confirmed) return { removed: false };
    }

    await ctx.runMutation(internal.shipmentTracking.deleteWebhookRow, {
      webhookRowId: row._id,
    });
    return { removed: true };
  },
});

// ─── the webhook endpoint ────────────────────────────────────────────────────

/** One fixed body for every "no such token" — a 256-bit token needs no oracle. */
function notFound(): Response {
  return new Response(JSON.stringify({ error: "not_found" }), {
    status: 404,
    headers: { "content-type": "application/json" },
  });
}

function parseMs(value: unknown): number | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * EasyPost's `Tracker` → our snapshot shape.
 *
 * Mirrors the browser service's `retrieveTracker` normalisation deliberately:
 * both feed the SAME mutation, so if the two disagreed about (say) whether
 * `datetime` is ms or seconds, the webhook path and the refresh path would
 * write different histories for one letter. Every field is treated as
 * possibly-absent and possibly-null — `tracking_location` is missing outright
 * on some scans and partially null on others.
 */
export function trackerFromEvent(result: Record<string, unknown>): TrackerSnapshot | null {
  const trackerId = optionalString(result.id);
  if (!trackerId) return null;

  const details = Array.isArray(result.tracking_details) ? result.tracking_details : [];
  const scans = details.map((entry) => {
    const detail = (entry ?? {}) as Record<string, unknown>;
    const location = (detail.tracking_location ?? {}) as Record<string, unknown>;
    return {
      at: parseMs(detail.datetime) ?? 0,
      status: optionalString(detail.status) ?? "unknown",
      message: optionalString(detail.message) ?? "",
      city: optionalString(location.city),
      state: optionalString(location.state),
      zip: optionalString(location.zip),
      country: optionalString(location.country),
    };
  });

  const lastScanAt = scans.reduce<number | undefined>(
    (newest, scan) => (newest === undefined || scan.at > newest ? scan.at : newest),
    undefined,
  );

  return {
    trackerId,
    status: optionalString(result.status) ?? "unknown",
    statusDetail: optionalString(result.status_detail),
    // Newest scan, then 0 — the SAME fallback ladder the browser service's
    // `retrieveTracker` uses, and deliberately never `Date.now()`. A clock
    // reading would make an undated snapshot the newest thing the row has ever
    // seen and let it overwrite a real one; 0 makes it lose every comparison
    // against real data, which is the right way for a snapshot carrying no
    // timestamp to fail.
    updatedAt: parseMs(result.updated_at) ?? lastScanAt ?? 0,
    lastScanAt,
    estDeliveryAt: parseMs(result.est_delivery_date),
    publicTrackingUrl: optionalString(result.public_url),
    scans,
  };
}

/**
 * `POST /webhooks/easypost/<token>` — one seller's tracker events.
 *
 * Order matters and is the security design, not an implementation detail:
 *
 *  1. **Token shape, then lookup.** `pathPrefix` matches an EMPTY final
 *     segment too, so the charset/length check runs before any database read.
 *  2. **Size cap before parsing.**
 *  3. **HMAC before any write.** A bad or missing signature is a 401 and
 *     changes nothing, and the log line carries neither the body nor the token.
 *  4. Only then is the event interpreted, and the write is scoped to the
 *     webhook row's OWN user: token → user → that user's shipment.
 *
 * Everything unrecognised answers 200. EasyPost retries non-2xx and disables a
 * hook that keeps failing, so "an event we do not care about" must never look
 * like "delivery failed" — a shipment bought outside NB on the same account is
 * a normal, permanent condition, not an error.
 *
 * Nothing in this path calls out, so it answers well inside EasyPost's 7 s
 * budget: two indexed reads and a patch.
 */
export const handleEasypostWebhook = httpAction(async (ctx, req) => {
  const pathname = new URL(req.url).pathname;
  const token = pathname.slice(pathname.lastIndexOf("/") + 1);
  if (!URL_TOKEN_RE.test(token)) return notFound();

  const hook = await ctx.runQuery(internal.shipmentTracking.getWebhookByToken, {
    urlToken: token,
  });
  if (!hook) return notFound();

  const declaredLength = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return new Response(JSON.stringify({ error: "payload_too_large" }), {
      status: 413,
      headers: { "content-type": "application/json" },
    });
  }

  const raw = await req.text();
  if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) {
    return new Response(JSON.stringify({ error: "payload_too_large" }), {
      status: 413,
      headers: { "content-type": "application/json" },
    });
  }

  const presented = req.headers.get("x-hmac-signature") ?? "";
  const expected = await computeEasypostSignature(
    hook.secret,
    rewriteWeightForSignature(raw),
  );
  if (!constantTimeEqual(presented, expected)) {
    // No body, no token, no signature in the log — this line exists to make a
    // flood visible, not to help anyone reproduce it.
    console.warn(JSON.stringify({ msg: "easypost_webhook_bad_signature" }));
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }

  let event: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") throw new Error("not an object");
    event = parsed as Record<string, unknown>;
  } catch {
    return new Response(JSON.stringify({ error: "bad_request" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const ignored = Response.json({ ignored: true });
  const description = event.description;
  if (description !== "tracker.created" && description !== "tracker.updated") {
    return ignored;
  }

  const result = (event.result ?? {}) as Record<string, unknown>;
  const shipmentId = optionalString(result.shipment_id);
  if (!shipmentId) return ignored;

  const snapshot = trackerFromEvent(result);
  if (!snapshot) return ignored;

  const purchaseId = await ctx.runQuery(
    internal.shipmentTracking.findPurchaseForWebhook,
    { userId: hook.userId, easypostShipmentId: shipmentId },
  );
  // A shipment bought outside NeonBinder on the same EasyPost account. Normal
  // and permanent — 200, or EasyPost retries it until it disables the hook.
  if (!purchaseId) return ignored;

  const applied = await ctx.runMutation(
    internal.shipmentTracking.applyTrackerSnapshot,
    { purchaseId, userId: hook.userId, snapshot },
  );
  await ctx.runMutation(internal.shipmentTracking.touchWebhookEvent, {
    webhookRowId: hook._id,
    at: Date.now(),
  });

  return Response.json(applied);
});
