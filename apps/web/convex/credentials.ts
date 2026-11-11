"use node";

import { action, internalAction } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { v } from "convex/values";
import { getCurrentUserId } from "./auth";
import { randomUUID } from "crypto";
import { oidcAudienceFor } from "./browserAudience";
import { buildAuthHeaders } from "./lib/cloudRunAuth";
import {
  classifyAdapterError,
  recordCredentialTest,
  sanitizeLoginDiagnostic,
} from "./observability";
import type { CredentialTestProperties } from "./observability";
import { isPlatformPaused } from "./marketplacePause";
import { ebayConfig, ebayConfigured } from "./lib/ebayEnv";
import { withdrawOffer, type EbaySellerSession } from "./adapters/ebaySeller";
import {
  isAbortTimeout,
  logMarketplaceLimiter,
  scrubLogText,
} from "./lib/marketplaceFetchFailure";

const MAX_INPUT_LENGTH = 256;
const SUPPORTED_SITES = ["buysportscards", "sportlots"];

function isSupportedSite(site: string): boolean {
  return (SUPPORTED_SITES as readonly string[]).includes(site);
}

/**
 * Per-site login wiring. Deliberately explicit (no dynamic dispatch): adding a
 * marketplace means adding a row here, which is the right place to confirm the
 * new site's login route accepts transient credentials (NEO-141) and returns
 * `error_class: "reauth_required"` when its session is unrecoverable.
 *
 * `displayName` is user-visible — it appears verbatim in the messages returned
 * by `saveCredentials`.
 *
 * `failureMessage` is for a login the marketplace processed and refused; it
 * points the user at their credentials. `transientMessage` (NEO-281) is for a
 * login the marketplace never answered — see `isTransientLoginFailure` for the
 * exact classes — where Convex writes nothing about the user's session, so the
 * copy must not blame the user. `pausedMessage` (NEO-287) is for a login the
 * operator has switched off with `NEONBINDER_PAUSED_PLATFORMS`: the browser
 * service is never called, nothing is written, and the copy says so.
 * `siteMessage` (NEO-288) is for a login the marketplace answered by turning
 * US away — see `isSiteSideLoginFailure` for the exact classes — where, again,
 * nothing about the user's credentials was learned and nothing is written, so
 * the copy must say the refusal was the site's, not the password's.
 */
const SITE_LOGIN: Record<
  string,
  {
    path: string;
    displayName: string;
    /** PostHog `platform` property (NEO-43). Must stay stable. */
    platform: CredentialTestProperties["platform"];
    failureMessage: string;
    transientMessage: string;
    pausedMessage: string;
    siteMessage: string;
    successMessage: string;
  }
> = {
  buysportscards: {
    path: "/login/bsc",
    displayName: "BuySportsCards",
    platform: "buysportscards",
    failureMessage: "BSC login failed. Please check your credentials and try again.",
    transientMessage: "BSC didn't answer. Nothing changed — try again in a minute.",
    pausedMessage:
      "BuySportsCards sign-ins are on pause right now. Nothing was changed — your saved session is safe.",
    // NEO-288 copy: pending Jason sign-off
    siteMessage:
      "BSC wouldn't let us in the door — that's on them, not your password. Nothing changed on your end. Give it another go in a bit.",
    successMessage: "BSC account authenticated successfully! Token stored.",
  },
  sportlots: {
    path: "/login/sportlots",
    displayName: "SportLots",
    platform: "sportlots",
    failureMessage: "SportLots login failed. Please check your credentials and try again.",
    transientMessage: "SportLots didn't answer. Nothing changed — try again in a minute.",
    pausedMessage:
      "SportLots sign-ins are on pause right now. Nothing was changed — your saved session is safe.",
    // NEO-288 copy: pending Jason sign-off
    siteMessage:
      "SportLots wouldn't let us in the door — that's on them, not your password. Nothing changed on your end. Give it another go in a bit.",
    successMessage: "SportLots account authenticated successfully! Session cookie stored.",
  },
};

function siteDisplayName(site: string): string {
  return SITE_LOGIN[site]?.displayName ?? site;
}

function browserUrl() {
  return process.env.NEONBINDER_BROWSER_URL || "http://localhost:8080";
}

const BROWSER_FETCH_TIMEOUT_MS = 15_000;

/**
 * NEO-321 follow-up — a browser-service path as a log-safe route name: the
 * credential key (which embeds a user id) and any query are dropped.
 * `/credentials/<key>/token` → `/credentials/:key/token`.
 */
function browserRouteOf(path: string): string {
  return path
    .split(/[?#]/)[0]
    .replace(/^\/credentials\/(?!check(?:\/|$))[^/]+/, "/credentials/:key");
}

/**
 * NEO-321 follow-up — the browser service limits every route to 60 requests a
 * minute per credential key (and `/health` per caller IP — one bucket for all
 * of Convex), and answers 429 past it (`express-rate-limit`,
 * services/browser/src/index.ts). That is OUR limit, not a marketplace's, and
 * nothing logged it: a 429 on the token read reads as "no token" and the
 * fetch fails as "didn't answer". Log it, with the limiter's own headers.
 */
function logBrowserRateLimit(
  response: Response,
  route: string,
  waitedMs: number,
  who: { site?: string; operation?: string } = {},
): void {
  const num = (name: string): number | undefined => {
    const raw = response.headers.get(name);
    const n = raw === null ? NaN : Number(raw);
    return Number.isFinite(n) ? n : undefined;
  };
  logMarketplaceLimiter({
    limiter: "browser_service_rate_limit",
    ...(who.site ? { platform: who.site } : {}),
    ...(who.operation ? { operation: who.operation } : {}),
    route,
    waitedMs,
    outcome: "rejected_429",
    limit: num("ratelimit-limit"),
    remaining: num("ratelimit-remaining"),
    resetSec: num("ratelimit-reset"),
    retryAfterSec: num("retry-after"),
  });
}

// NEO-20: the browser service Cloud Run instance requires IAM-authenticated
// requests. The OIDC handshake itself (service-account credentials → ID token →
// Authorization header, plus the fail-closed guard on non-https non-loopback
// audiences) moved to convex/lib/cloudRunAuth.ts in NEO-170, when the
// preprocess service became a second caller of the identical logic. Nothing
// about the browser-service behavior changed: this file still resolves the
// audience with oidcAudienceFor() before handing it over.

async function buildBrowserAuthHeaders(): Promise<Record<string, string>> {
  // Send requests to browserUrl() (possibly a tagged pr-N--- preview host) but
  // mint the OIDC token against the base service URL that Cloud Run expects.
  return buildAuthHeaders(oidcAudienceFor(browserUrl()), "NEONBINDER_BROWSER_URL");
}

// ---------------------------------------------------------------------------
// NEO-143: browser-service contract guard
//
// Convex and the browser service ship from the same commit but go live at
// different moments, so every release passes through a window where one side is
// new and the other is old. release.yml now promotes the browser service to
// 100% BEFORE it pushes Convex, which makes "service is older than Convex" a
// bug rather than a routine state — but ordering alone is a process guarantee,
// and NEO-143 happened because nothing mechanical was watching.
//
// This is the mechanical check. Before any authenticated call, we confirm the
// service that will answer is new enough to understand it.
//
// What it prevents is not the loud failure — it is the SILENT one. NEO-141
// moved the marketplace password onto a transient field of the login request.
// An older service ignores that field and logs in with the stored secret
// instead, so a user changing their password sees success while the old
// password is quietly used. Detecting that after the response is useless; the
// login already happened. Hence a pre-flight probe, not a response header.
// ---------------------------------------------------------------------------

/**
 * The minimum `contractVersion` this Convex build requires from the browser
 * service. Raise this in the SAME release that starts speaking a new shape, and
 * only after a release in which the service already advertises that version.
 * See services/browser/src/contract-version.ts for the bump procedure.
 */
const REQUIRED_CONTRACT_VERSION = 1;

const CONTRACT_CACHE_TTL_MS = 60_000;
const HEALTH_TIMEOUT_MS = 10_000;

/** Thrown when the live browser service is too old for this Convex build. */
export class BrowserServiceOutdatedError extends Error {
  /**
   * What the user should actually be told. The generic "could not reach X"
   * copy the credential actions fall back to would be wrong here: the service
   * is reachable and the credentials may be perfectly good — the deploy is
   * simply mid-flight. Telling someone to re-check a correct password sends
   * them to change it for no reason.
   */
  readonly userMessage =
    "The marketplace connection service is updating right now. Nothing was changed — please try again in a moment.";

  constructor(
    readonly serviceVersion: number,
    readonly requiredVersion: number,
  ) {
    super(
      `Browser service contract v${serviceVersion} is older than the required v${requiredVersion}. ` +
        `Refusing to send a request it may silently misinterpret.`,
    );
    this.name = "BrowserServiceOutdatedError";
  }
}

/**
 * User-facing copy for a failed credential operation. Keeps the mid-deploy case
 * distinguishable from a genuine connectivity or credential problem.
 */
function credentialFailureMessage(error: unknown, site: string): string {
  if (error instanceof BrowserServiceOutdatedError) return error.userMessage;
  return `Could not reach ${siteDisplayName(site)} to verify your credentials. Nothing was saved — please try again.`;
}

let cachedContract: { url: string; version: number; checkedAt: number } | null = null;

/** Reset the cached contract probe. Exported for tests. */
export function __resetContractCache() {
  cachedContract = null;
}

async function assertBrowserContract(headers: Record<string, string>): Promise<void> {
  const url = browserUrl();
  const now = Date.now();

  // Only a SATISFIED result is cached-and-trusted. A cached "too old" is
  // re-probed every time: during a deploy the service is being replaced
  // underneath us, and making the user wait out a TTL after it is already
  // healthy would turn a 2-second window into a minute-long outage.
  if (
    cachedContract &&
    cachedContract.url === url &&
    cachedContract.version >= REQUIRED_CONTRACT_VERSION &&
    now - cachedContract.checkedAt < CONTRACT_CACHE_TTL_MS
  ) {
    return;
  }

  const healthStartedAt = Date.now();
  let response: Response;
  try {
    response = await fetch(`${url}/health`, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
  } catch (err) {
    // NEO-321 follow-up — our own 10s timer on the contract probe; a fire
    // here fails the token read it guards.
    if (isAbortTimeout(err)) {
      logMarketplaceLimiter({
        limiter: "browser_health_timeout",
        route: "/health",
        waitedMs: Date.now() - healthStartedAt,
        timeoutMs: HEALTH_TIMEOUT_MS,
        outcome: "aborted",
      });
    }
    throw err;
  }
  if (response.status === 429) {
    logBrowserRateLimit(response, "/health", Date.now() - healthStartedAt);
  }
  if (!response.ok) {
    throw new Error(
      `Browser service health check failed (${response.status}) — refusing to send a request whose shape it may not support.`,
    );
  }
  const body = (await response.json().catch(() => ({}))) as { contractVersion?: unknown };

  // A service predating NEO-143 does not report the field at all. Treat that as
  // version 0 — it is exactly the "old service" case this guard exists for, and
  // defaulting it to "probably fine" would defeat the entire mechanism.
  const version = typeof body.contractVersion === "number" ? body.contractVersion : 0;
  cachedContract = { url, version, checkedAt: now };

  if (version < REQUIRED_CONTRACT_VERSION) {
    throw new BrowserServiceOutdatedError(version, REQUIRED_CONTRACT_VERSION);
  }
}

/**
 * Auth headers for a browser-service call, gated on the contract check.
 *
 * Every outbound call funnels through here — including `loginWithRetry`, which
 * calls `fetch` directly rather than `browserFetch`. That is deliberate: the
 * login path is the one NEO-141 broke, so the guard is placed where it cannot
 * be bypassed by adding another call site.
 *
 * NEO-120: exported (with {@link browserFetch} and {@link credKey}) for
 * `convex/postage.ts` and `convex/shipping.ts`, which need the same
 * IAM-authenticated channel to the browser service for EasyPost postage without
 * inheriting the marketplace credential machinery wrapped around it. EasyPost
 * is not a marketplace, and adding it to SUPPORTED_SITES would leak it into
 * listUserSites, /credentials/check, the Credentials tab and the login flows.
 */
export async function browserAuthHeaders(): Promise<Record<string, string>> {
  const headers = await buildBrowserAuthHeaders();
  await assertBrowserContract(headers);
  return headers;
}

/** NEO-120: exported alongside {@link browserAuthHeaders}, same reasoning. */
export async function browserFetch(
  path: string,
  init: RequestInit,
): Promise<Response> {
  const startedAt = Date.now();
  try {
    return await fetch(`${browserUrl()}${path}`, {
      ...init,
      signal: AbortSignal.timeout(BROWSER_FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      // NEO-321 follow-up — our own 15s timer on a browser-service call.
      logMarketplaceLimiter({
        limiter: "browser_fetch_timeout",
        route: browserRouteOf(path),
        waitedMs: Date.now() - startedAt,
        timeoutMs: BROWSER_FETCH_TIMEOUT_MS,
        outcome: "aborted",
      });
      throw new Error(
        `Browser service request timed out after ${BROWSER_FETCH_TIMEOUT_MS / 1000}s: ${path}`,
      );
    }
    throw err;
  }
}

/** NEO-120: exported alongside {@link browserFetch}, same reasoning. */
export function credKey(site: string, userId: string) {
  return `${site}-credentials-${userId}`;
}

function validateInputLength(value: string, fieldName: string) {
  if (value.length > MAX_INPUT_LENGTH) {
    throw new Error(`${fieldName} exceeds maximum length of ${MAX_INPUT_LENGTH} characters`);
  }
}

// Run a credential operation (store / test-login / delete) under the
// per-(user, site) lock so it can't race another credential op against the
// same key (e.g. a Clear interleaving an in-flight login → corrupted token).
// On contention (another op already in flight) returns `busyResult` WITHOUT
// running body — idiomatic "loser re-runs" (the UI also disables the action
// reactively, so a user rarely hits this). Releases in a finally so the happy
// path frees the lock immediately; a server-minted token guards release.
async function withCredentialLock<T>(
  ctx: Pick<ActionCtx, "runMutation">,
  userId: string,
  site: string,
  op: "store" | "test" | "delete",
  body: () => Promise<T>,
  busyResult: T,
): Promise<T> {
  const token = randomUUID();
  const askedAt = Date.now();
  const lock = (await ctx.runMutation(
    internal.userProfile.acquireCredentialLock,
    { userId, site, op, token },
  )) as { acquired: boolean; heldBy?: string };
  if (!lock.acquired) {
    // NEO-321 follow-up — the lock turned this op away. For a fetch-driven
    // refresh that means "use the cached token or none", which a checklist
    // fetch then fails on. No user id in the line.
    logMarketplaceLimiter({
      limiter: "credential_lock",
      platform: site,
      operation: op,
      waitedMs: Date.now() - askedAt,
      outcome: "busy",
      heldBy: lock.heldBy,
    });
    return busyResult;
  }
  const heldFrom = Date.now();
  try {
    return await body();
  } finally {
    await ctx.runMutation(internal.userProfile.releaseCredentialLock, {
      userId,
      site,
      token,
    });
    // NEO-321 follow-up — how long this op held the lock, so a "busy" above
    // can be matched to the hold that caused it (or to none: a lock left by a
    // crashed op holds until its lease runs out).
    logMarketplaceLimiter({
      limiter: "credential_lock",
      platform: site,
      operation: op,
      waitedMs: 0,
      outcome: "released",
      heldMs: Date.now() - heldFrom,
    });
  }
}

/**
 * The connect-and-store half of `saveCredentials` (NEO-141), shared with the
 * testing seed (`storeTestCredentials`). `listing` says what the stored
 * sign-in does to marketplace listing (NEO-370 Revision 5, see
 * `userProfile.updateSiteCredentialStatus`): "save" for the collector's own
 * save, "testOff" only from the testing seed.
 */
async function connectAndStore(
  ctx: ActionCtx,
  userId: string,
  site: string,
  username: string,
  password: string,
  listing: "save" | "testOff",
): Promise<{ success: boolean; message: string }> {
  return withCredentialLock(ctx, userId, site, "store", async () => {
    try {
      // NEO-141: connect-and-store. The password is handed to the login
      // route for this one request only — the browser service persists the
      // resulting session, never the password. There is therefore no
      // "store now, verify later": a login we cannot complete gives us
      // nothing worth storing.
      const outcome = await runSiteLogin(
        ctx,
        userId,
        site,
        { username, password },
        "saveCredentials",
      );

      if (!outcome.success) {
        // Store NOTHING on failure. Leaving `hasCredentials` untouched is
        // the whole point: a half-saved credential is what NEO-140 was.
        //
        // NEO-281: only send the user to their password when the
        // marketplace actually refused it. If it never answered, say so.
        // NEO-287: and if the operator paused the marketplace, the login
        // was never attempted — the paused copy goes out verbatim and is
        // never rewritten into "check your username and password".
        // NEO-288: a site-side refusal (challenge / automated_access)
        // arrives here as `transient` with the per-site `siteMessage`
        // already in `message`, so it too goes out verbatim.
        return {
          success: false,
          message: outcome.paused || outcome.transient
            ? outcome.message
            : `Could not sign in to ${siteDisplayName(site)}. Nothing was saved — check your username and password and try again.`,
        };
      }

      await ctx.runMutation(internal.userProfile.updateSiteCredentialStatus, {
        userId,
        site: site,
        hasCredentials: true,
        // A successful login is proof no re-auth is pending.
        needsReauth: false,
        listing,
      });

      return {
        success: true,
        message: `Connected to ${siteDisplayName(site)} successfully. Your password was not stored — only the session it created.`,
      };
    } catch (error) {
      const detail = error instanceof Error
        ? `${error.name}: ${error.message}${error.cause ? ` (cause: ${String(error.cause)})` : ""}`
        : String(error);
      console.error(
        `[saveCredentials] store site=${site} url=${browserUrl()} threw: ${detail}`,
      );
      return {
        success: false,
        message: credentialFailureMessage(error, site),
      };
    }
  }, {
    success: false,
    message: "Another credential operation is in progress — try again.",
  });
}

/**
 * Save (or clear) credentials for a site — the single client-facing entry
 * point for both operations (NEO-89: previously two separate public actions,
 * `storeSiteCredentials` and `deleteSiteCredentials`, each paired with its
 * own separate client-triggered Convex flag update — a non-atomic pair that
 * could drift apart if the client was interrupted between them).
 *
 * - `username`+`password` both provided → CONNECT-AND-STORE (NEO-141). The
 *   password is sent transiently to the site's login route and is never
 *   persisted anywhere; the browser service stores only
 *   `{username, token, expiresAt, refreshToken?}`. On success we atomically
 *   mark `hasCredentials: true` and clear `needsReauth`.
 *
 *   NEO-141 removed the old `PUT /credentials/:key` write. Two reasons: (a) we
 *   must stop storing passwords at all, and (b) that PUT wrote a
 *   username/password-only secret version which WIPED any cached token — so
 *   the very next `getSiteToken` saw "no token" and, pre-NEO-140, deleted the
 *   `hasCredentials: true` this action had just set. Saving triggered the bug
 *   it was meant to fix.
 *
 *   Consequence for callers: saving now either FULLY succeeds (credentials
 *   verified against the marketplace and a session stored) or FULLY fails
 *   (nothing stored at all). The old "credentials were saved, but
 *   authentication failed" middle state no longer exists.
 *
 * - Both omitted/blank → delete from the browser service (DELETE) — a
 *   genuinely distinct GCP operation, not a blank overwrite. DELETE removes
 *   the whole secret; a "store with empty strings" would only add a blank
 *   version to a secret that still exists. (NEO-115 note: `updateCredentials`
 *   now also prunes prior versions, so a blank overwrite would in fact destroy
 *   the old material — but it would still leave an empty secret behind and
 *   `credentialsExist` would still report true, so DELETE remains the correct
 *   operation here.) Then atomically clear `hasCredentials`.
 *
 * Either way the Convex flag write happens server-side, inside this same
 * action, immediately after the browser-service call succeeds — no second
 * client round-trip that can be interrupted.
 */
export const saveCredentials = action({
  args: {
    site: v.string(),
    username: v.optional(v.string()),
    password: v.optional(v.string()),
  },
  returns: v.object({
    success: v.boolean(),
    message: v.string(),
  }),
  handler: async (ctx, args) => {
    const userId = await getCurrentUserId(ctx);
    if (!userId) {
      throw new Error("Not authenticated");
    }
    // NEO-415: eBay never takes a username and password. It connects through
    // eBay's own consent page (`ebayConnect.beginConnect` / `completeConnect`)
    // and disconnects there too.
    if (args.site === "ebay") {
      return { success: false, message: "eBay connects under Profile → Credentials → eBay, not with a password." };
    }
    if (!isSupportedSite(args.site)) {
      return { success: false, message: `Unsupported site: ${args.site}` };
    }

    const hasUsername = !!args.username;
    const hasPassword = !!args.password;

    if (hasUsername !== hasPassword) {
      return {
        success: false,
        message: "Provide both username and password, or neither (to clear credentials).",
      };
    }

    if (hasUsername && hasPassword) {
      const username = args.username!;
      const password = args.password!;
      validateInputLength(username, "Username");
      validateInputLength(password, "Password");

      // NEO-370 Revision 5: the collector's own save starts listing on a
      // listing platform's site (and clears an E2E test marker).
      return connectAndStore(ctx, userId, args.site, username, password, "save");
    }

    // Clear branch — both username and password omitted/blank.
    return withCredentialLock(ctx, userId, args.site, "delete", async () => {
      try {
        const key = credKey(args.site, userId);
        const response = await browserFetch(`/credentials/${key}`, {
          method: "DELETE",
          headers: await browserAuthHeaders(),
        });

        if (!response.ok) {
          return {
            success: false,
            message: "Failed to delete credentials",
          };
        }

        await ctx.runMutation(internal.userProfile.removeSiteCredentialStatus, {
          userId,
          site: args.site,
        });

        return {
          success: true,
          message: `Credentials deleted successfully for ${args.site}`,
        };
      } catch (error) {
        console.error(`[saveCredentials] delete site=${args.site} threw:`, error);
        return {
          success: false,
          message: "Failed to delete credentials",
        };
      }
    }, {
      success: false,
      message: "Another credential operation is in progress — try again.",
    });
  },
});

/**
 * NEO-370 Revision 5 — the testing seed's connect-and-store
 * (`testing.seedMyTestCredentials`): `saveCredentials`' store path for the
 * seeded user, where the seed decides whether the stored sign-in lists
 * (`listing` true: as a collector's own save) or not (false: the E2E test
 * marker, `marketplaceListingStates.testListingOff`). Internal, and fails
 * closed where the testing flag is unset (production), so no product path
 * can reach the marker.
 */
export const storeTestCredentials = internalAction({
  args: {
    userId: v.string(),
    site: v.string(),
    username: v.string(),
    password: v.string(),
    listing: v.boolean(),
  },
  returns: v.object({ success: v.boolean(), message: v.string() }),
  handler: async (ctx, args) => {
    if (!process.env.TESTING_RESET_SECRET) {
      throw new Error("Test credential seeding is not enabled on this deployment");
    }
    if (!isSupportedSite(args.site)) {
      return { success: false, message: `Unsupported site: ${args.site}` };
    }
    validateInputLength(args.username, "Username");
    validateInputLength(args.password, "Password");
    return connectAndStore(ctx, args.userId, args.site, args.username, args.password, args.listing ? "save" : "testOff");
  },
});

/**
 * NEO-445 — the other half of the testing seed's store, for a sign-in that
 * belongs to no collector (`testingSellerCleanup`): deletes the stored session
 * (`DELETE /credentials/<key>`; a 404 is already gone) and clears the saved
 * sign-in, under the credential lock. Internal, and fails closed where the
 * testing flag is unset (production).
 */
export const removeTestCredentials = internalAction({
  args: { userId: v.string(), site: v.union(v.literal("buysportscards"), v.literal("ebay")) },
  returns: v.object({ ok: v.boolean() }),
  handler: async (ctx, args): Promise<{ ok: boolean }> => {
    if (!process.env.TESTING_RESET_SECRET) {
      throw new Error("Test credential seeding is not enabled on this deployment");
    }
    return await withCredentialLock<{ ok: boolean }>(
      ctx,
      args.userId,
      args.site,
      "delete",
      async () => {
        try {
          const response = await browserFetch(`/credentials/${credKey(args.site, args.userId)}`, {
            method: "DELETE",
            headers: await browserAuthHeaders(),
          });
          if (!response.ok && response.status !== 404) return { ok: false };
        } catch {
          return { ok: false };
        }
        await ctx.runMutation(internal.userProfile.removeSiteCredentialStatus, { userId: args.userId, site: args.site });
        return { ok: true };
      },
      { ok: false },
    );
  },
});

/**
 * Get credential metadata for a site (no secrets — safe for frontend use).
 */
export const getSiteCredentials = action({
  args: {
    site: v.string(),
  },
  returns: v.union(
    v.object({
      username: v.string(),
      site: v.string(),
      hasToken: v.boolean(),
      expiresAt: v.optional(v.float64()),
      // NEO-141: whether the stored session can still be renewed WITHOUT the
      // user. `hasToken` alone no longer answers that — a BSC access token
      // lasts an hour, but the refresh token behind it lasts 24h and is what
      // actually determines whether we can carry on unattended.
      hasRefreshToken: v.boolean(),
      refreshExpiresAt: v.optional(v.float64()),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const userId = await getCurrentUserId(ctx);
    if (!userId) {
      throw new Error("Not authenticated");
    }
    if (!isSupportedSite(args.site)) {
      return null;
    }

    try {
      const key = credKey(args.site, userId);
      const response = await browserFetch(`/credentials/${key}/metadata`, {
        method: "GET",
        headers: await browserAuthHeaders(),
      });

      if (response.status === 404) return null;
      if (!response.ok) return null;

      const data = await response.json() as {
        username?: string;
        hasToken?: boolean;
        expiresAt?: number;
        hasRefreshToken?: boolean;
        refreshExpiresAt?: number;
      };

      return {
        username: data.username || "",
        site: args.site,
        hasToken: !!data.hasToken,
        ...(data.expiresAt && { expiresAt: data.expiresAt }),
        // Absent on a browser revision predating NEO-141, which coerces to
        // false — i.e. "assume the session is NOT renewable". That is the safe
        // direction: it costs a redundant sign-in, never a wrong skip.
        hasRefreshToken: !!data.hasRefreshToken,
        ...(data.refreshExpiresAt && { refreshExpiresAt: data.refreshExpiresAt }),
      };
    } catch (error) {
      console.error(`Failed to retrieve credential metadata for ${args.site}`);
      return null;
    }
  },
});

/**
 * How close to expiry we treat a token as stale and force a refresh
 * before handing it back. 5 minutes accounts for clock skew + the
 * couple of seconds a downstream fetch might take to reach the
 * marketplace. Without this buffer, getSiteToken happily returns a
 * token that expires mid-request and produces a confusing 401.
 */
const TOKEN_REFRESH_LEEWAY_MS = 5 * 60 * 1000;

/**
 * Read the raw token + expiresAt from the browser service's secret store.
 * Internal helper for getSiteToken — does NOT trigger refresh.
 *
 * Three outcomes, and keeping them distinct is the entire fix for NEO-140:
 *
 *   - `{token, expiresAt?}` — 200, a token is cached.
 *   - `null`               — "no token right now" for ANY recoverable reason:
 *                            the secret exists but nothing is cached yet
 *                            (204), or a transient non-OK response. Caller
 *                            falls through to the mint/re-auth path.
 *   - `"not_found"`        — the secret genuinely does not exist. ONLY this
 *                            licenses `getSiteToken` to self-heal a stale
 *                            `hasCredentials` flag (NEO-89 "ghost
 *                            credentials").
 *
 * NEO-140 root cause: the browser service used to answer 404 for BOTH "no
 * token cached" (a completely normal state) and "no such secret", separable
 * only by the response body. This function read the status alone, collapsed
 * both into `"not_found"`, and so deleted live users' credential status while
 * their secrets sat ENABLED in Secret Manager. The service now answers 204 for
 * the benign case.
 *
 * ⚠️ DO NOT DELETE THE BODY CHECK ON 404. It is permanent, not a migration
 * shim. Convex/Vercel and Cloud Run deploy on independent schedules, so "new
 * Convex + old browser service" is a real, recurring rollout window in which a
 * bare `404 {"error":"No token available"}` still arrives — and treating that
 * as absence is exactly the destructive bug. Every `.json()` here is guarded:
 * a 204 has no body at all, and a malformed body must never be able to throw
 * its way into the destructive branch.
 */
async function readCachedToken(
  site: string,
  userId: string,
): Promise<{ token: string; expiresAt?: number } | null | "not_found"> {
  const key = credKey(site, userId);
  const readStartedAt = Date.now();
  const response = await browserFetch(`/credentials/${key}/token`, {
    method: "GET",
    headers: await browserAuthHeaders(),
  });

  // NEO-321 follow-up — a 429 here is the browser service's own limiter, and
  // every other non-OK status (404 aside, handled below) is silently "no
  // token" to the caller. Say which it was.
  if (response.status === 429) {
    logBrowserRateLimit(
      response,
      "/credentials/:key/token",
      Date.now() - readStartedAt,
      { site, operation: "readCachedToken" },
    );
  } else if (!response.ok && response.status !== 404) {
    console.warn(
      JSON.stringify({
        msg: "site_token_read_failed",
        site,
        status: response.status,
        elapsedMs: Date.now() - readStartedAt,
      }),
    );
  }

  // Current contract: secret exists, nothing cached. Recoverable — mint one.
  if (response.status === 204) return null;

  if (response.status === 404) {
    const body = (await response
      .json()
      .catch(() => null)) as { error?: string } | null;
    const error = typeof body?.error === "string" ? body.error : "";
    // Self-heal ONLY on a POSITIVELY identified absence. The browser service
    // always answers a genuine absence with a well-formed
    // `{"error":"Credentials not found"}` (or "No active version"), so
    // requiring that match costs us nothing real. The legacy deploy-skew body
    // "No token available" falls through to `null` below, as it must.
    //
    // Everything else on a 404 is recoverable, and the asymmetry is
    // deliberate. A 404 we cannot parse is AMBIGUOUS, not evidence: an HTML
    // error page from Cloud Run or a load balancer, a request that landed on a
    // revision without this route, a truncated body. Deleting a user's
    // credentials on an ambiguous signal is precisely the bug NEO-140 was, and
    // routing an unrecognised body into the destructive branch would rebuild
    // that bug behind a different door.
    //
    // The two failure modes are not symmetric, so choose the recoverable one:
    //   - wrongly "not_found" → we destroy a live credential, and NOTHING on
    //     any success path re-asserts the flag; the user must re-authenticate.
    //   - wrongly `null`      → a stale flag survives a little longer, and the
    //     next genuine absence (which parses fine) heals it anyway.
    if (/credentials not found|no active version/i.test(error)) {
      return "not_found";
    }
    return null;
  }

  if (!response.ok) return null;

  const data = (await response
    .json()
    .catch(() => null)) as { token?: string; expiresAt?: number } | null;
  if (!data || typeof data.token !== "string" || data.token.length === 0) {
    // 200 with no usable token is not absence either — fall through to mint.
    return null;
  }
  return typeof data.expiresAt === "number"
    ? { token: data.token, expiresAt: data.expiresAt }
    : { token: data.token };
}

/**
 * Get site token, transparently refreshing if the cached token has
 * expired (or is within `TOKEN_REFRESH_LEEWAY_MS` of expiry).
 *
 * This is the single entry point Convex adapters should use to obtain
 * a marketplace token. The architecture intent: a user signs into
 * BSC/SportLots once via Profile → Site Credentials, and from then on
 * fetches "just work" without having to re-click "Test Credentials"
 * every hour. When the token goes stale, this helper invokes the
 * site's authenticate action (which calls the browser service's
 * cached-or-fresh login flow), then re-reads the token. The browser
 * service's existing logic — validate cached token via the
 * marketplace's profile endpoint, fall through to Puppeteer on 401 —
 * means refresh is fast (~300ms) when the token is genuinely fresh
 * but stored with a wrong expiresAt, and only slow (~10s) on a real
 * re-auth.
 *
 * Returns only the token, never username/password.
 *
 * NEO-140 — what this function is and is NOT allowed to destroy:
 *   - Genuine absence (`readCachedToken` → `"not_found"`) is the ONLY signal
 *     that may clear `hasCredentials`, and only while no credential op holds
 *     the lock.
 *   - A dead-but-present session surfaces as `error_class: "reauth_required"`
 *     from the login route. That FLAGS `needsReauth` (set inside the
 *     authenticate* actions this function refreshes through) and never
 *     deletes: the secret and username are still there, only the session
 *     expired, and since NEO-141 we hold no password to renew it silently.
 *
 * NEO-278 — once `needsReauth` is flagged, the refresh is NOT re-run on every
 * call: `refreshSiteToken` skips it while the last `reauth_required` outcome
 * is younger than `REAUTH_RETRY_INTERVAL_MS`, and this function falls back to
 * the cached token (stale path) or null (mint path) exactly as it does for a
 * failed refresh. After the interval one attempt is made again.
 *
 * NEO-20: internalAction (not action). Tokens must never be reachable
 * via Convex RPC from a frontend client — only other Convex backend
 * code (adapters) may call this.
 */
export const getSiteToken = internalAction({
  args: {
    site: v.string(),
  },
  returns: v.union(
    v.object({
      token: v.string(),
      expiresAt: v.optional(v.float64()),
    }),
    v.null(),
  ),
  handler: async (ctx, args): Promise<{ token: string; expiresAt?: number } | null> => {
    const userId = await getCurrentUserId(ctx);
    if (!userId) {
      throw new Error("Not authenticated");
    }
    return await siteTokenFor(ctx, userId, args.site);
  },
});

/**
 * NEO-370 — the user an identity-less entry acts for. `explicitUserId` is the
 * owner the scheduler passed; a caller that DOES carry an identity may only
 * name itself. Both present and different is a bug or an attack, never a
 * fallback: it throws. Neither present throws "Not authenticated".
 */
export async function actingUserId(
  ctx: Pick<ActionCtx, "auth">,
  explicitUserId: string | undefined,
): Promise<string> {
  const identity = await getCurrentUserId(ctx);
  if (explicitUserId !== undefined && identity && identity !== explicitUserId) {
    throw new Error("A signed-in caller can only act for itself");
  }
  const userId = explicitUserId ?? identity;
  if (!userId) throw new Error("Not authenticated");
  return userId;
}

/**
 * NEO-370 — `getSiteToken` for work that runs with NO caller identity: a
 * scheduled listing drain or the order poll acts for the collector it was
 * scheduled for, and the identity a user-driven call would carry is absent.
 * The same body as `getSiteToken` (pause, the NEO-140 self-heal rules, the
 * NEO-278 backoff, the credential lock), keyed on the `userId` the scheduler
 * passed instead of on `ctx.auth`.
 *
 * Internal only, like `getSiteToken`: never reachable over RPC, and a caller
 * must only ever pass the owner of the row it is working on.
 */
export const getSiteTokenForUser = internalAction({
  args: {
    site: v.union(v.literal("buysportscards"), v.literal("sportlots"), v.literal("ebay")),
    userId: v.string(),
  },
  returns: v.union(
    v.object({
      token: v.string(),
      expiresAt: v.optional(v.float64()),
    }),
    v.null(),
  ),
  handler: async (ctx, args): Promise<{ token: string; expiresAt?: number } | null> => {
    const userId = await actingUserId(ctx, args.userId);
    return await siteTokenFor(ctx, userId, args.site, { explicitUserId: true });
  },
});

/**
 * NEO-370 — `refreshSiteTokenAfterRejection` for identity-less work (see
 * `getSiteTokenForUser`). Same guards: the pause, the NEO-278 backoff and the
 * credential lock. Answers `{ refreshed: false }` for any of them or a failed
 * login; never throws for a refresh failure.
 */
export const refreshSiteTokenForUser = internalAction({
  args: {
    site: v.union(v.literal("buysportscards"), v.literal("sportlots"), v.literal("ebay")),
    userId: v.string(),
  },
  returns: v.object({ refreshed: v.boolean() }),
  handler: async (ctx, args): Promise<{ refreshed: boolean }> => {
    const userId = await actingUserId(ctx, args.userId);
    if (isPlatformPaused(args.site)) return { refreshed: false };
    return {
      refreshed: await refreshSiteToken(ctx, userId, args.site, { explicitUserId: true }),
    };
  },
});

/**
 * The body of `getSiteToken` / `getSiteTokenForUser`. `explicitUserId` makes a
 * refresh name the user to the login action rather than leave it to the
 * caller's identity (which identity-less work does not have).
 */
async function siteTokenFor(
  ctx: ActionCtx,
  userId: string,
  site: string,
  opts: { explicitUserId?: boolean } = {},
): Promise<{ token: string; expiresAt?: number } | null> {
  // `args.site` keeps the body as it was in `getSiteToken`.
  const args = { site };
  // NEO-287: a paused marketplace is not contacted at all — not even to
  // read the cached token, because a cached-but-stale token would lead
  // straight into `refreshSiteToken` and a stored-session login. Returning
  // null here means the adapters take their `no_credentials` exit, which
  // writes nothing (no `needsReauth`, no NEO-278 stamp, no self-heal), so
  // the stored session and every flag come out of the pause exactly as they
  // went in. The adapters guard this earlier still (before asking for the
  // token); this is the backstop for any caller that does not.
  if (isPlatformPaused(args.site)) {
    console.log(
      JSON.stringify({ msg: "marketplace_token_paused", site: args.site, op: "getSiteToken" }),
    );
    return null;
  }
  // NEO-415: a deployment not wired to eBay never asks the service for an
  // eBay token (and never self-heals a flag on its answer).
  if (args.site === "ebay" && !ebayConfigured()) return null;

  try {
    const cached = await readCachedToken(args.site, userId);

    if (cached === "not_found") {
      // The secret doesn't exist at all — not "stale," genuinely absent.
      // Self-heal the Convex flag rather than wasting a doomed re-auth
      // attempt (there's nothing to log in with). This is the fix for
      // NEO-89: whatever caused the drift (an interrupted delete, a
      // deleted-out-from-under-us secret), the UI now corrects itself the
      // next time anyone hits this path instead of staying wrong forever.
      //
      // NEO-140 narrowed what reaches here. `readCachedToken` used to return
      // "not_found" for a plain "no token cached yet" 404 too, so this
      // destructive branch fired on a perfectly healthy account — the single
      // most damaging line in the credential flow. It is now reachable only
      // when the browser service says the SECRET is missing.
      //
      // Guard: skip if a saveCredentials store/delete is actively holding
      // the lock right now — a 404 mid-write is an expected transient, not
      // proof of absence, and self-healing here would both race the flag
      // the in-flight op is about to set and clobber the lock entry it's
      // holding (security-auditor finding, NEO-89 review).
      const locked = await ctx.runQuery(internal.userProfile.hasLiveCredentialLock, {
        userId,
        site: args.site,
      });
      if (!locked) {
        // TOCTOU: the lock check races the store it is meant to defer to.
        // A store can hold the lock while we read the secret mid-write (404),
        // then set `hasCredentials: true` and RELEASE before the check above
        // runs — so the guard reads "unlocked" and we delete the flag that
        // store just wrote. The window is small but the loss is total, since
        // nothing on any success path re-asserts the flag.
        //
        // Confirm before destroying. A second read costs one round trip on a
        // path that has already conceded a re-auth, and it collapses the race:
        // if the store finished, the secret now exists and this read no longer
        // says "not_found". Never delete on a single observation — that is the
        // whole lesson of NEO-140.
        const confirmed = await readCachedToken(args.site, userId);
        if (confirmed === "not_found") {
          await ctx.runMutation(internal.userProfile.removeSiteCredentialStatus, {
            userId,
            site: args.site,
          });
        }
      }
      return null;
    }

    if (!cached) {
      // No cached token, but the secret itself exists. Mint a fresh token
      // via re-auth before giving up — otherwise the caller fails with
      // `no_credentials` even though credentials exist. Confirmed E2E root
      // cause: a worker's token was evicted ~18min after warm, so a later
      // sport/year fetch got a null token and the column came up empty (no
      // Football, etc.).
      //
      // NEO-140: this branch was written for the seeded-but-never-warmed
      // case, but was UNREACHABLE for it — that case produced a 404, which
      // the old `readCachedToken` collapsed into "not_found", so it took the
      // destructive branch above instead of landing here. Now that 204 (and
      // a legacy "No token available" 404) map to `null`, the branch finally
      // does the job it was written for. This restores intended behaviour
      // rather than adding new behaviour.
      //
      // If the re-auth fails because the session is unrecoverable, the
      // authenticate* action flags `needsReauth` on its way out; we return
      // null and never delete.
      const minted = await refreshSiteToken(ctx, userId, args.site, opts);
      if (!minted) return null;
      const afterMint = await readCachedToken(args.site, userId);
      return afterMint === "not_found" ? null : afterMint;
    }

    const isFresh =
      typeof cached.expiresAt === "number" &&
      cached.expiresAt > Date.now() + TOKEN_REFRESH_LEEWAY_MS;
    if (isFresh) return cached;

    // Stale (or unknown expiry) — kick off a re-auth via the site's
    // own authenticate action. Each site has its own action because
    // the login flow + post-login bookkeeping (e.g. BSC sellerId
    // capture) differs per marketplace.
    const refreshed = await refreshSiteToken(ctx, userId, args.site, opts);
    if (!refreshed) {
      // Refresh failed (or was skipped by the NEO-278 re-auth backoff);
      // fall back to the (likely stale) cached token rather than null —
      // let the caller's 401 path surface a clear "please re-login" error
      // if the cache really is dead.
      return cached;
    }

    const fresh = await readCachedToken(args.site, userId);
    return fresh === "not_found" ? null : (fresh ?? cached);
  } catch (error) {
    console.error(`Failed to retrieve token for ${args.site}`);
    // NEO-321 follow-up — why, scrubbed (the error can name a browser
    // route with the credential key in it). The caller sees only "no
    // token", so this line is the only place the reason survives.
    const detail =
      error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    console.error(
      JSON.stringify({
        msg: "site_token_failed",
        site: args.site,
        errorClass: classifyAdapterError(detail),
        error: scrubLogText(detail),
      }),
    );
    return null;
  }
}

/**
 * NEO-278: how long `getSiteToken` waits after a `reauth_required` outcome
 * before letting a fetch-driven refresh try the stored-session login again.
 *
 * Since NEO-141 the browser service holds no password, so once a session has
 * lapsed that login is doomed until the user signs in again — every attempt
 * answers `reauth_required` in ~100ms. Before this backoff `getSiteToken`
 * re-ran it on EVERY selector/checklist fetch (token GET + lock + action +
 * login POST + PostHog failure event + flag write + unlock, ~1s per platform),
 * which on 2026-09-14 meant ~1,500 pointless logins in a day and a NEO-43
 * alert that never cleared.
 *
 * The retry is deliberately kept, not removed: the browser service may grow a
 * silent re-auth (the other half of NEO-278), and a user who signs in again
 * clears the flag anyway. 15 minutes bounds the noise at ~4 attempts an hour
 * per platform per user while still picking up a recovered session promptly.
 */
const REAUTH_RETRY_INTERVAL_MS = 15 * 60 * 1000;

/**
 * NEO-278: true while a fetch-driven refresh should be skipped because the last
 * stored-session login for this (user, site) already answered `reauth_required`
 * less than `REAUTH_RETRY_INTERVAL_MS` ago. A flag with no `reauthObservedAt`
 * (a row flagged before the field existed, or by `testing.markSiteNeedsReauth`)
 * is NOT in backoff: it retries once, and that outcome stamps it.
 *
 * Read-only: nothing here writes credential status, and a successful login
 * anywhere (`applyLoginOutcome`, `saveCredentials`) clears the flag and the
 * stamp together, so the backoff cannot outlive the condition it tracks.
 */
async function inReauthBackoff(
  ctx: { runQuery: (ref: any, args: any) => Promise<any> },
  userId: string,
  site: string,
): Promise<boolean> {
  const state = (await ctx.runQuery(internal.userProfile.getSiteReauthState, {
    userId,
    site,
  })) as { needsReauth: boolean; reauthObservedAt?: number };
  if (!state.needsReauth || typeof state.reauthObservedAt !== "number") return false;
  const sinceMs = Date.now() - state.reauthObservedAt;
  if (sinceMs >= REAUTH_RETRY_INTERVAL_MS) return false;
  console.log(
    `[getSiteToken] platform=${site} op=refresh skipped: re-auth pending, observed ${Math.round(sinceMs / 1000)}s ago (retry after ${REAUTH_RETRY_INTERVAL_MS / 60_000}m)`,
  );
  // NEO-321 follow-up — the same fact as a limiter line: a stale token is
  // handed back unrefreshed (or none), and the fetch fails on it.
  logMarketplaceLimiter({
    limiter: "reauth_backoff",
    platform: site,
    operation: "refreshSiteToken",
    waitedMs: 0,
    outcome: "refresh_skipped",
    sinceMs,
    retryAfterMs: REAUTH_RETRY_INTERVAL_MS - sinceMs,
  });
  return true;
}

/**
 * Internal helper — invoke the site's authenticate action to refresh
 * its token. Returns true on success, false on any failure. Does not
 * throw. Site list is intentionally explicit (no dynamic dispatch) so
 * adding a new marketplace requires explicit wiring here — which is
 * the right place to confirm the new site's auth flow handles cached
 * tokens properly.
 *
 * Two callers, both fetch-driven: `getSiteToken`, and
 * `refreshSiteTokenAfterRejection` (an adapter whose request the marketplace
 * refused with a token the cache still called fresh). The user-initiated
 * paths (`testSiteCredentials`, `saveCredentials`) run their own login
 * directly and are never subject to the NEO-278 backoff below — a user who
 * clicks "Test" or signs in again must always get a real attempt.
 */
async function refreshSiteToken(
  ctx: {
    runQuery: (ref: any, args: any) => Promise<any>;
    runAction: (ref: any, args: any) => Promise<unknown>;
    runMutation: (ref: any, args: any) => Promise<any>;
  },
  userId: string,
  site: string,
  opts: { explicitUserId?: boolean } = {},
): Promise<boolean> {
  // NEO-370: identity-less work names the user to the login action; a
  // user-driven call leaves it to the identity it carries (its args stay
  // `{}`, exactly as before).
  const loginArgs = opts.explicitUserId ? { userId } : {};
  // NEO-278: checked BEFORE contending for the lock, so a suppressed refresh
  // costs one indexed query rather than a lock round-trip. Returning false
  // here lands on the same fallbacks a failed refresh does — the cached token
  // on the stale path, null on the mint path — both of which are safe and
  // neither of which writes anything.
  if (await inReauthBackoff(ctx, userId, site)) return false;

  // Contend for the per-(user, site) credential lock: a background refresh runs
  // the same login that writes a token to Secret Manager, so without this a
  // fetch-driven re-auth could re-mint a token right after a user Clear (the
  // same corruption class). On contention treat as refresh-failed (false) —
  // getSiteToken then falls back to the cached token or null, both safe.
  return withCredentialLock(ctx, userId, site, "test", async () => {
    try {
      if (site === "buysportscards") {
        const result = (await ctx.runAction(internal.credentials.authenticateBsc, loginArgs)) as {
          success: boolean;
        };
        return result.success;
      }
      if (site === "sportlots") {
        const result = (await ctx.runAction(internal.credentials.authenticateSportlots, loginArgs)) as {
          success: boolean;
        };
        return result.success;
      }
      if (site === "ebay") {
        // NEO-415: no login. The browser service renews the access token
        // with the stored refresh token (eBay's refresh grant) and stores
        // it; the caller re-reads the cached token. Already under the lock.
        return await refreshEbayToken(ctx, userId);
      }
      console.warn(`[refreshSiteToken] no refresh handler for site: ${site}`);
      return false;
    } catch (error) {
      console.error(`[refreshSiteToken] ${site} refresh threw:`, error);
      return false;
    }
  }, false);
}

/**
 * NEO-325 security follow-up — the ONLY way an adapter may force a re-auth
 * after the marketplace refused a request (BSC's 401 with a token our cache
 * still called fresh). It is `refreshSiteToken`, so the refresh inherits both
 * of that function's guards:
 *
 *   - the NEO-278 `inReauthBackoff` check: a session whose stored-session
 *     login answered `reauth_required` under 15 minutes ago is not logged in
 *     again, and
 *   - the per-(user, site) `withCredentialLock`: a refresh never runs beside
 *     another credential op (a Clear, a store, or a second refresh), which
 *     could otherwise interleave two Secret Manager writes for one key.
 *
 * Calling `authenticateBsc` / `authenticateSportlots` directly from an adapter
 * skipped both; a batch with two calls in flight then ran concurrent unlocked
 * logins. Answers `{ refreshed: false }` for a backoff skip, a busy lock, a
 * failed login or a paused marketplace alike (the caller fails its request
 * either way); `refreshed: true` means a login succeeded and the caller should
 * re-read the token. Never throws for a refresh failure.
 *
 * Writes credential status only, through the login it runs (`needsReauth`,
 * the NEO-278 stamp, the lock). Logs carry the platform and the outcome,
 * never a credential.
 */
export const refreshSiteTokenAfterRejection = internalAction({
  args: {
    site: v.union(v.literal("buysportscards"), v.literal("sportlots")),
  },
  returns: v.object({ refreshed: v.boolean() }),
  handler: async (ctx, args): Promise<{ refreshed: boolean }> => {
    const userId = await getCurrentUserId(ctx);
    if (!userId) {
      throw new Error("Not authenticated");
    }
    // NEO-287 — a paused marketplace is never logged in to.
    if (isPlatformPaused(args.site)) return { refreshed: false };
    return { refreshed: await refreshSiteToken(ctx, userId, args.site) };
  },
});

/**
 * List all sites with stored credentials for the current user.
 */
export const listUserSites = action({
  args: {},
  returns: v.array(
    v.object({
      site: v.string(),
      hasCredentials: v.boolean(),
    }),
  ),
  handler: async (ctx): Promise<Array<{ site: string; hasCredentials: boolean }>> => {
    const userId = await getCurrentUserId(ctx);
    if (!userId) return [];

    try {
      const keys = SUPPORTED_SITES.map((site) => credKey(site, userId));
      const response = await browserFetch(`/credentials/check`, {
        method: "POST",
        headers: await browserAuthHeaders(),
        body: JSON.stringify({ keys }),
      });

      if (!response.ok) return [];

      const data = await response.json() as { results: Record<string, boolean> };

      return SUPPORTED_SITES.map((site) => ({
        site,
        hasCredentials: data.results[credKey(site, userId)] || false,
      }));
    } catch (error) {
      console.error("Failed to list user credentials");
      return [];
    }
  },
});

/**
 * Test credentials for a site — dispatches to adapter test functions.
 */
export const testSiteCredentials = action({
  args: {
    site: v.string(),
  },
  returns: v.object({
    success: v.boolean(),
    message: v.string(),
    details: v.optional(v.string()),
  }),
  handler: async (ctx, args): Promise<{ success: boolean; message: string; details?: string }> => {
    console.log(`[testSiteCredentials] Starting credential test for site: ${args.site}`);
    const userId = await getCurrentUserId(ctx);
    if (!userId) {
      throw new Error("Not authenticated");
    }

    // Hold the per-(user, site) lock across the whole login round-trip (the
    // inner authenticate action, up to ~60s/attempt). The inner authenticate*
    // actions do NOT re-acquire — the lock is non-reentrant on the same key.
    return withCredentialLock(ctx, userId, args.site, "test", async () => {
      try {
        switch (args.site) {
          case "buysportscards": {
            console.log("[testSiteCredentials] Dispatching to authenticateBsc");
            const result = await ctx.runAction(
              internal.credentials.authenticateBsc,
              {},
            );
            console.log(`[testSiteCredentials] authenticateBsc returned: success=${result.success}`);
            return result;
          }

          case "sportlots": {
            console.log("[testSiteCredentials] Dispatching to authenticateSportlots");
            const result = await ctx.runAction(
              internal.credentials.authenticateSportlots,
              {},
            );
            console.log(`[testSiteCredentials] authenticateSportlots returned: success=${result.success}`);
            return result;
          }

          default:
            console.log(`[testSiteCredentials] Unsupported site: ${args.site}`);
            return {
              success: false,
              message: `Unsupported site: ${args.site}`,
            };
        }
      } catch (error) {
        console.error(`[testSiteCredentials] Error testing credentials for ${args.site}:`, error);
        return {
          success: false,
          message: "Authentication test failed. Please check your credentials and try again.",
        };
      }
    }, {
      success: false,
      message: "Another credential operation is in progress — try again.",
    });
  },
});

// Shared login retry for the marketplace authenticate actions. Marketplace
// logins (BSC, SportLots) can transiently fail or be delayed — a dropped
// request, a slow page, a 503 while the browser service serializes Puppeteer
// logins, or a collision when concurrent workers log into the shared test
// account. Rather than surface the first failure (which fails the whole E2E
// flow), retry a few times with backoff spread across a wider window so a
// transient miss gets another shot. Returns the parsed success payload, or a
// failure with the last error detail after all attempts are exhausted.
// Sanitized login-failure diagnostics returned by the browser service (NEO-29
// observability). Never contains credentials/tokens — the browser service
// redacts them before returning. Forwarded to PostHog so we can spot long-term
// failure patterns (e.g. a CAPTCHA/challenge page served to the CI context).
type LoginDiagnostic = {
  url?: string;
  title?: string;
  challengeDetected?: boolean;
  snippet?: string;
};

async function loginWithRetry(
  loginUrl: string,
  key: string,
  label: string,
  // NEO-141: transient credentials for a connect-and-store. When present the
  // browser service logs in with THESE and persists only the resulting session
  // — the password is never written to Secret Manager and never leaves this
  // request. When absent the service falls back to the stored secret.
  transient?: { username: string; password: string },
): Promise<{ success: boolean; data: { success: boolean; message?: string; storeName?: string; sellerId?: string } | null; detail: string; diagnostic?: LoginDiagnostic; errorClass?: string }> {
  // Retry ONLY on 503 (browser service busy serializing Puppeteer logins) —
  // back off and wait our turn. Do NOT retry an actual login failure: a real
  // marketplace login takes ~30s, and retrying it just fires another login at
  // the same shared account. With 3 workers warming at once, retrying turned a
  // single hiccup into a sustained ~6-min burst of serialized BSC logins that
  // tripped BSC's bot protection (NEO-29 run 26610313677: 6 straight 500s, then
  // recovery) — the retry caused the failures it was meant to fix. So on any
  // non-503 failure we return immediately (with the diagnostic) — matching the
  // pre-NEO-29 behavior that ran green.
  const maxAttempts = 4;
  let detail = "no attempt made";
  let diagnostic: LoginDiagnostic | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const attemptStartedAt = Date.now();
    try {
      const response = await fetch(loginUrl, {
        method: "POST",
        headers: await browserAuthHeaders(),
        body: JSON.stringify(transient ? { key, ...transient } : { key }),
        signal: AbortSignal.timeout(60_000),
      });
      if (response.status === 429) {
        // NEO-321 follow-up — the browser service's limiter, not a login.
        logBrowserRateLimit(response, "/login", Date.now() - attemptStartedAt, {
          operation: label,
        });
      }
      if (response.ok) {
        const data = (await response.json().catch(() => ({ success: false }))) as {
          success: boolean;
          message?: string;
          storeName?: string;
          sellerId?: string;
          diagnostic?: LoginDiagnostic;
        };
        if (data.success) {
          return { success: true, data, detail: "ok" };
        }
        // Login ran and failed — do NOT retry (avoids hammering the account).
        if (data.diagnostic) diagnostic = data.diagnostic;
        return {
          success: false,
          data: null,
          detail: data.message || "login reported success=false",
          diagnostic,
        };
      }
      if (response.status === 503) {
        detail = "browser service busy (503)";
        console.log(`[${label}] 503 (attempt ${attempt}/${maxAttempts}) — backing off`);
        // NEO-321 follow-up — a wait WE add (5s, 10s, 15s), then give up.
        logMarketplaceLimiter({
          limiter: "browser_login_503_backoff",
          operation: label,
          waitedMs: attempt < maxAttempts ? 5_000 * attempt : 0,
          outcome: attempt < maxAttempts ? "retrying" : "gave_up",
          attempt,
          maxAttempts,
        });
        if (attempt < maxAttempts) {
          await new Promise((r) => setTimeout(r, 5_000 * attempt));
          continue;
        }
        return { success: false, data: null, detail, diagnostic };
      }
      // Any other non-OK (e.g. 500 from a failed/timed-out login) — capture the
      // diagnostic and return immediately, no retry.
      const err = (await response.json().catch(() => ({ error: response.statusText }))) as {
        error?: string;
        diagnostic?: LoginDiagnostic;
        // NEO-43: stable tag classified by the browser service at the true
        // point of failure, using the same vocabulary as its browser_login_call
        // log line. Preferred over re-deriving one here — BSC's caller-facing
        // error is the deliberately generic "Authentication failed", which
        // classifyAdapterError can only bucket as "other".
        error_class?: string;
      };
      if (err.diagnostic) diagnostic = err.diagnostic;
      detail = err.error || response.statusText;
      console.log(
        `[${label}] login failed: ${detail}` +
          (diagnostic?.challengeDetected ? " [challenge page detected]" : ""),
      );
      return { success: false, data: null, detail, diagnostic, errorClass: err.error_class };
    } catch (e) {
      // NEO-143: a contract-guard refusal is NOT a login failure and must not
      // be flattened into one. Returning success:false here would report "check
      // your username and password" for a request we deliberately never sent —
      // sending the user to change a password that is perfectly good, which is
      // precisely the kind of quiet misattribution the guard exists to remove.
      // Let it propagate to the action's catch, which renders the deploy-aware
      // message.
      if (e instanceof BrowserServiceOutdatedError) throw e;
      // Network/timeout to the browser service — do not retry (avoid hammering).
      if (isAbortTimeout(e)) {
        // NEO-321 follow-up — our own 60s timer on the login call.
        logMarketplaceLimiter({
          limiter: "browser_login_timeout",
          operation: label,
          waitedMs: Date.now() - attemptStartedAt,
          timeoutMs: 60_000,
          outcome: "aborted",
        });
      }
      detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      console.log(`[${label}] login request threw: ${detail}`);
      return { success: false, data: null, detail, diagnostic };
    }
  }
  return { success: false, data: null, detail, diagnostic };
}

/**
 * NEO-43 stable tag meaning "this session is dead and cannot be renewed from
 * what we hold — the user must sign in again". Emitted by the browser service
 * at the true point of failure (a BSC refresh grant rejected, or a SportLots
 * session dead with no transient password supplied). This is the authoritative
 * re-auth signal; do not try to re-derive it from message text.
 */
const REAUTH_REQUIRED = "reauth_required";

/**
 * NEO-281: "the marketplace didn't answer" — nothing is known about the user's
 * credentials, so the copy must not send them to their password.
 *
 * - `"other"`: the browser service's catch-all. It only ever arrives on a 5xx
 *   — every 422 is forced to `reauth_required` or `invalid_credentials` and
 *   every 400 to `bad_key_format` / `missing_key` / `invalid_credentials`
 *   (`loginFailureOutcome` in services/browser) — so on a login route it means
 *   "we could not complete the exchange and could not name why": the
 *   marketplace 5xx'd, rate-limited or timed out on every probe.
 * - `"timeout"`: the marketplace exchange timed out inside the service.
 * - `undefined`: the service never classified anything — the request to it
 *   threw (network, our 60s abort), or it stayed 503-busy through every retry.
 *
 * Every other class is a verdict the copy already handles: `reauth_required`
 * and `invalid_credentials` are about the credentials; `challenge` and
 * `automated_access` are the site turning us away (`SITE_SIDE_ERROR_CLASSES`,
 * NEO-288); `oom` / `bad_key_format` / `missing_key` keep their existing copy
 * deliberately. `applyLoginOutcome` writes nothing for any of the transient
 * cases.
 */
const TRANSIENT_ERROR_CLASSES: ReadonlySet<string | undefined> = new Set([
  "other",
  "timeout",
  undefined,
]);

function isTransientLoginFailure(errorClass: string | undefined): boolean {
  return TRANSIENT_ERROR_CLASSES.has(errorClass);
}

/**
 * NEO-288: "the marketplace turned US away" — it answered, but the refusal is
 * about NeonBinder's access, not about the user's password, so the copy must
 * not send them to their credentials either.
 *
 * - `"challenge"`: the site interposed a bot check or refused the login as a
 *   non-human request. For SportLots this now includes the refusal bodies it
 *   returns to automated sign-ins (`Invalid login request.`, `Security
 *   verification failed…`): the service's login diagnostic detects them as a
 *   challenge page and `loginFailureOutcome` then FORCES `error_class:
 *   "challenge"` whatever the adapter's error string was — the password was
 *   never evaluated.
 * - `"automated_access"`: the browser service's owner-issued automated-access
 *   key was refused or is missing on its side (a 502 on the login route). The
 *   user's credentials never reached the marketplace.
 *
 * Both are the site's decision about us, and both can clear without the user
 * doing anything. Nothing about the user's stored credentials is changed:
 * `hasCredentials` and `needsReauth` are left exactly as they were, and the
 * stored session, if any, stays put. The outcome rides the NEO-281 `transient`
 * path so every caller takes its existing "nothing changed" branch with the
 * per-site `siteMessage` in place of `transientMessage`. Additive: the service
 * already returned `error_class` as a free string, so no contract bump.
 */
const SITE_SIDE_ERROR_CLASSES: ReadonlySet<string> = new Set([
  "challenge",
  "automated_access",
]);

function isSiteSideLoginFailure(errorClass: string | undefined): boolean {
  return errorClass !== undefined && SITE_SIDE_ERROR_CLASSES.has(errorClass);
}

type SiteLoginOutcome = {
  success: boolean;
  message: string;
  details?: string;
  /** The browser service says only a fresh password can fix this. */
  reauthRequired: boolean;
  /**
   * NEO-281: the marketplace never answered; nothing is known about the
   * credentials and nothing was written. `message` already carries the
   * per-site `transientMessage`; callers that rewrite the failure copy must
   * keep it rather than blaming the user's password.
   *
   * NEO-288: also set when the marketplace answered by turning US away
   * (`isSiteSideLoginFailure`) — same "nothing is known, nothing was written"
   * contract, with `message` carrying the per-site `siteMessage` instead.
   */
  transient: boolean;
  /**
   * NEO-287: the operator has paused this marketplace. No login was attempted,
   * the browser service was never called, nothing was written and no PostHog
   * `credential_test_failed` was recorded — a pause is not a failure. `message`
   * carries the per-site `pausedMessage`; callers must return it verbatim.
   */
  paused: boolean;
};

/**
 * Run a marketplace login and record its NEO-43 instrumentation. Shared by
 * `saveCredentials` (with transient credentials — connect-and-store) and the
 * per-site authenticate* actions (without — the stored session path), so the
 * two can never drift apart on error classification, PostHog properties or
 * sellerId capture.
 *
 * Does NOT touch the credential lock: every caller already holds it.
 * Does NOT write credential status — see `applyLoginOutcome`, which callers
 * invoke separately so `saveCredentials` can decline to write anything at all
 * on failure.
 */
async function runSiteLogin(
  ctx: ActionCtx,
  userId: string,
  site: string,
  transient: { username: string; password: string } | undefined,
  label: string,
): Promise<SiteLoginOutcome> {
  const cfg = SITE_LOGIN[site];
  if (!cfg) {
    return {
      success: false,
      message: `Unsupported site: ${site}`,
      reauthRequired: false,
      transient: false,
      paused: false,
    };
  }

  // NEO-287: every login path — `saveCredentials`, `testSiteCredentials` →
  // authenticate*, `refreshSiteToken` from `getSiteToken`, and the SportLots
  // adapter's forced re-auth — funnels through here, so this one check is the
  // whole "no fresh sign-ins while paused" guarantee. Checked before the
  // browser service is contacted and before any instrumentation: a paused
  // login is an operator decision, not a credential failure, so it must not
  // feed the NEO-43 failure rate. `applyLoginOutcome` writes nothing for it
  // (neither `success` nor `reauthRequired`), so `needsReauth` and the stored
  // session are untouched.
  if (isPlatformPaused(site)) {
    console.log(JSON.stringify({ msg: "marketplace_login_paused", site, op: label }));
    return {
      success: false,
      message: cfg.pausedMessage,
      reauthRequired: false,
      transient: false,
      paused: true,
    };
  }

  const key = credKey(site, userId);
  const startedAt = Date.now();
  const result = await loginWithRetry(`${browserUrl()}${cfg.path}`, key, label, transient);
  const durationMs = Date.now() - startedAt;

  if (!result.success || !result.data) {
    await recordCredentialTest(ctx, userId, false, {
      platform: cfg.platform,
      reason: result.detail,
      // Prefer the browser service's own tag; fall back to local
      // classification for failures it never got to answer — notably the
      // 60s AbortSignal timeout, which is the HANG case. A true hang
      // produces no browser_login_call log line at all, so this event is
      // the only record of it.
      error_class: result.errorClass ?? classifyAdapterError(result.detail),
      duration_ms: durationMs,
      ...sanitizeLoginDiagnostic(result.diagnostic),
    });
    // NEO-281: a marketplace that did not answer is not a user who typed the
    // wrong password. Same misattribution the ticket exists to remove.
    // NEO-288: neither is a marketplace that answered by turning US away
    // (challenge / automated_access). Both ride `transient: true` so callers
    // keep the copy as-is and write no credential status; only the message
    // differs — "didn't answer" versus "wouldn't let us in".
    const siteSideFailure = isSiteSideLoginFailure(result.errorClass);
    const transientFailure = siteSideFailure || isTransientLoginFailure(result.errorClass);
    return {
      success: false,
      message: siteSideFailure
        ? cfg.siteMessage
        : transientFailure
          ? cfg.transientMessage
          : cfg.failureMessage,
      reauthRequired: result.errorClass === REAUTH_REQUIRED,
      transient: transientFailure,
      paused: false,
    };
  }

  const loginResult = result.data;

  // Persist the BSC seller id, read live from BSC's profile inside this
  // login, on the user's profile. It is never taken from env or config. This
  // runs before the caller writes the credential status (connectAndStore's
  // `updateSiteCredentialStatus`, which starts listing), so a save that
  // returns the id has it saved before listing turns on. The read is
  // best-effort: a login can succeed without an id (a stalled or reshaped
  // profile read), and then nothing is written here; listing still starts,
  // and the drain reads the id live from BSC (and saves it) when it needs it.
  if (site === "buysportscards" && loginResult.sellerId) {
    await ctx.runMutation(internal.userProfile.setMarketplaceAccountIdInternal, {
      userId,
      site: "buysportscards",
      accountId: loginResult.sellerId,
    });
  }

  // NEO-43: the success counterpart. Without it only an absolute failure
  // count is computable, never a rate.
  await recordCredentialTest(ctx, userId, true, {
    platform: cfg.platform,
    duration_ms: durationMs,
  });

  return {
    success: true,
    message: cfg.successMessage,
    details: loginResult.storeName ? `Store: ${loginResult.storeName}` : undefined,
    reauthRequired: false,
    transient: false,
    paused: false,
  };
}

/**
 * Reflect a login outcome onto the user's credential status.
 *
 * - Success → `hasCredentials: true` AND `needsReauth` cleared. This is the
 *   NEO-140 self-recovery requirement: a user whose flag was wrongly wiped
 *   used to be able to authenticate successfully and STILL see "no
 *   credentials", because neither authenticate* action ever wrote the flag
 *   back. Now any successful login re-asserts it.
 * - `reauth_required` → FLAG, never delete. The secret is still there.
 * - Any other failure → write nothing. A transient marketplace hiccup is not
 *   evidence about what we have stored.
 */
async function applyLoginOutcome(
  ctx: Pick<ActionCtx, "runMutation">,
  userId: string,
  site: string,
  outcome: SiteLoginOutcome,
): Promise<void> {
  if (outcome.success) {
    await ctx.runMutation(internal.userProfile.updateSiteCredentialStatus, {
      userId,
      site,
      hasCredentials: true,
      needsReauth: false,
    });
    return;
  }
  if (outcome.reauthRequired) {
    await ctx.runMutation(internal.userProfile.setSiteReauthState, {
      userId,
      site,
      needsReauth: true,
    });
  }
}

/**
 * Re-authenticate BSC from the STORED session via the browser service, which
 * renews (BSC refresh grant) or re-logs-in and writes the new token back to
 * Secret Manager. No password is involved — NEO-141 stopped storing one; a
 * session that cannot be renewed comes back as `error_class: "reauth_required"`
 * and flags `needsReauth` instead of destroying credential status (NEO-140).
 *
 * On success this re-asserts `hasCredentials: true` and clears `needsReauth`,
 * so a user whose flag was wrongly wiped recovers just by authenticating.
 *
 * NEO-20: internalAction. Frontend triggers a re-auth via the public
 * testSiteCredentials wrapper, never directly. Direct invocation would
 * expose the success/sellerId metadata to unauthorized callers.
 */
export const authenticateBsc = internalAction({
  // NEO-370 — `userId` is passed only by identity-less work (a scheduled
  // listing drain or order poll, through `refreshSiteTokenForUser`); a
  // user-driven call sends `{}` and is the caller's identity, as before.
  args: { userId: v.optional(v.string()) },
  returns: v.object({
    success: v.boolean(),
    message: v.string(),
    details: v.optional(v.string()),
  }),
  handler: async (ctx, args): Promise<{ success: boolean; message: string; details?: string }> => {
    console.log("[authenticateBsc] Starting BSC authentication");
    // Throws for no user at all, and for an identity naming another user.
    const userId = await actingUserId(ctx, args.userId);

    try {
      console.log(
        `[authenticateBsc] Using browser URL: ${browserUrl()}, calling POST /login/bsc`,
      );

      // Log in via the browser service using the STORED session (no transient
      // credentials — this action is the re-auth/verify path, not a connect).
      const outcome = await runSiteLogin(
        ctx,
        userId,
        "buysportscards",
        undefined,
        "authenticateBsc",
      );
      await applyLoginOutcome(ctx, userId, "buysportscards", outcome);

      return {
        success: outcome.success,
        message: outcome.message,
        details: outcome.details,
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unknown error";
      await recordCredentialTest(ctx, userId, false, {
        platform: "buysportscards",
        reason: detail,
        error_class: classifyAdapterError(detail),
      });
      console.error("Failed to authenticate BSC");
      return {
        success: false,
        message: "BSC authentication failed. Please try again.",
      };
    }
  },
});

/**
 * Re-authenticate SportLots from the STORED session via the browser service,
 * which revalidates (or re-establishes) the session cookie and stores it back
 * in Secret Manager. See authenticateBsc for the NEO-140/NEO-141 semantics —
 * same self-recovery on success, same flag-don't-delete on reauth_required.
 *
 * NEO-20: internalAction. Triggered indirectly by the frontend through
 * testSiteCredentials; never invoked over Convex RPC.
 */
export const authenticateSportlots = internalAction({
  // NEO-370 — see `authenticateBsc`.
  args: { userId: v.optional(v.string()) },
  returns: v.object({
    success: v.boolean(),
    message: v.string(),
    details: v.optional(v.string()),
  }),
  handler: async (ctx, args): Promise<{ success: boolean; message: string; details?: string }> => {
    // Throws for no user at all, and for an identity naming another user.
    const userId = await actingUserId(ctx, args.userId);

    try {
      // Stored-session path — see authenticateBsc.
      const outcome = await runSiteLogin(
        ctx,
        userId,
        "sportlots",
        undefined,
        "authenticateSportlots",
      );
      await applyLoginOutcome(ctx, userId, "sportlots", outcome);

      return {
        success: outcome.success,
        message: outcome.message,
        details: outcome.details,
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unknown error";
      await recordCredentialTest(ctx, userId, false, {
        platform: "sportlots",
        reason: detail,
        error_class: classifyAdapterError(detail),
      });
      console.error("Failed to authenticate SportLots");
      return {
        success: false,
        message: "SportLots authentication failed. Please try again.",
      };
    }
  },
});

// ─── NEO-415: eBay (OAuth, no password) ──────────────────────────────────────
//
// eBay signs in through eBay's own consent page, never with a username and
// password, so it has no SITE_LOGIN row. The browser service holds the client
// secret and the refresh token and does every token exchange:
//   POST /oauth/ebay/connect  {key, code | refreshToken, expectEbayUserId?}
//                             → 200 {username, ebayUserId, environment, expiresAt}
//                             | 409 account_mismatch (expectEbayUserId differs; nothing stored)
//   POST /oauth/ebay/refresh  {key}                      → {token, expiresAt}
//   POST /webhooks/ebay/verify {signatureHeader, body}   → 200 {valid}
//                             | 502 ebay_unavailable | 503 ebay_not_configured
// Reading the token is the existing `GET /credentials/<key>/token`, and
// disconnect is the existing `DELETE /credentials/<key>`. Every one runs under
// the per-(user, "ebay") credential lock. Errors are `{error_class}` from a
// closed set; a 404 whose body is not that JSON is an older service without
// the route ("service not ready"), never absence. A 500 `internal` is the
// service's own store fault: transient, never a reason to ask for a fresh
// connection.

/** What an eBay connect can come back with (NB-side words, never eBay's). */
export type EbayConnectError =
  | "busy"
  | "notConfigured"
  | "consentRefused"
  | "unavailable"
  | "serviceNotReady"
  | "badRequest"
  | "internal"
  /** A different eBay seller than the one NB's listings sit on. */
  | "accountSwitch"
  /** The service's eBay environment is not this deployment's. */
  | "environmentMismatch";

const ebayConnectErrorValidator = v.union(
  v.literal("accountSwitch"),
  v.literal("environmentMismatch"),
  v.literal("busy"),
  v.literal("notConfigured"),
  v.literal("consentRefused"),
  v.literal("unavailable"),
  v.literal("serviceNotReady"),
  v.literal("badRequest"),
  v.literal("internal"),
);

/** The browser service's `error_class`, or null when the body is not that JSON. */
async function serviceErrorClass(response: Response): Promise<string | null> {
  const body = (await response.json().catch(() => null)) as { error_class?: unknown } | null;
  return body && typeof body.error_class === "string" ? body.error_class.slice(0, 40) : null;
}

function logEbayCredentialCall(operation: string, startedAt: number, outcome: string, httpStatus?: number): void {
  console.log(
    JSON.stringify({
      msg: "ebay_credential_call",
      platform: "ebay",
      operation,
      outcome,
      ...(httpStatus !== undefined ? { httpStatus } : {}),
      durationMs: Date.now() - startedAt,
    }),
  );
}

/** Account id shape `userProfile.setMarketplaceAccountIdInternal` accepts for eBay. */
const EBAY_USER_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

type EbayConnectResult = { ok: true; username: string; ebayUserId: string } | { ok: false; error: EbayConnectError };

/** Pages of stale link rows a connect clears before listing starts (200 rows a page). */
const MAX_STALE_LINK_PAGES = 100;

/**
 * Best effort: a session the service stored but NB refused (`DELETE
 * /credentials/<key>`; already under the lock), and the saved sign-in with
 * it, so no flag claims a session that is gone. Logged; never throws.
 */
async function discardEbaySession(ctx: Pick<ActionCtx, "runMutation">, userId: string, reason: string): Promise<void> {
  const startedAt = Date.now();
  try {
    const response = await browserFetch(`/credentials/${credKey("ebay", userId)}`, {
      method: "DELETE",
      headers: await browserAuthHeaders(),
    });
    logEbayCredentialCall(`discard_${reason}`, startedAt, response.ok ? "ok" : "http_error", response.status);
    if (!response.ok && response.status !== 404) return;
  } catch {
    logEbayCredentialCall(`discard_${reason}`, startedAt, "network");
    return;
  }
  await ctx.runMutation(internal.userProfile.removeSiteCredentialStatus, { userId, site: "ebay" });
}

/**
 * Exchanges a consent `code` (or, sandbox testing deployments only, a
 * refresh token minted out of band) for a stored eBay session, then records
 * the connection: the seller's immutable eBay user id
 * (`marketplaceAccountIds.ebayUserId`, the seller-conflict key), the display
 * username, and the saved sign-in, which starts listing
 * (`updateSiteCredentialStatus` → `listingSync.setUpListing`, or the E2E
 * marker for `listing: "testOff"`).
 *
 * Account switches: while NB's link rows sit on the profile's account, the
 * service is told to accept only that seller (`expectEbayUserId`; `409
 * account_mismatch` stores nothing), and `ebayConnect.recordEbayConnection`
 * checks again before writing the id. Any refusal AFTER the service stored a
 * session (no usable user id, an environment that is not this deployment's,
 * the record refusing or throwing) discards that session.
 */
export const connectEbay = internalAction({
  args: {
    userId: v.string(),
    code: v.optional(v.string()),
    refreshToken: v.optional(v.string()),
    listing: v.union(v.literal("save"), v.literal("testOff")),
  },
  returns: v.union(
    v.object({ ok: v.literal(true), username: v.string(), ebayUserId: v.string() }),
    v.object({ ok: v.literal(false), error: ebayConnectErrorValidator }),
  ),
  handler: async (ctx, args): Promise<EbayConnectResult> => {
    if ((args.code === undefined) === (args.refreshToken === undefined)) {
      return { ok: false, error: "badRequest" };
    }
    if (args.refreshToken !== undefined && !process.env.TESTING_RESET_SECRET) {
      throw new Error("Seeding an eBay connection is not enabled on this deployment");
    }
    if (args.refreshToken !== undefined && ebayConfig()?.environment !== "sandbox") {
      throw new Error("Seeding an eBay connection needs the eBay sandbox");
    }
    const config = ebayConfig();
    if (!config || !ebayConfigured()) return { ok: false, error: "notConfigured" };
    const grant = args.code !== undefined ? { code: args.code } : { refreshToken: args.refreshToken as string };
    if ((grant.code ?? grant.refreshToken ?? "").length > 4096) return { ok: false, error: "badRequest" };
    return await withCredentialLock<EbayConnectResult>(
      ctx,
      args.userId,
      "ebay",
      "store",
      async () => {
        const startedAt = Date.now();
        const guard: { expectEbayUserId: string | null } = await ctx.runQuery(internal.ebayConnect.connectGuard, {
          ownerId: args.userId,
        });
        let response: Response;
        try {
          response = await browserFetch("/oauth/ebay/connect", {
            method: "POST",
            headers: { ...(await browserAuthHeaders()), "Content-Type": "application/json" },
            body: JSON.stringify({
              key: credKey("ebay", args.userId),
              ...grant,
              ...(guard.expectEbayUserId !== null ? { expectEbayUserId: guard.expectEbayUserId } : {}),
            }),
          });
        } catch {
          logEbayCredentialCall("connect", startedAt, "network");
          return { ok: false, error: "unavailable" };
        }
        if (!response.ok) {
          const errorClass = await serviceErrorClass(response);
          logEbayCredentialCall("connect", startedAt, errorClass ?? "unreadable", response.status);
          if (response.status === 404 && errorClass === null) return { ok: false, error: "serviceNotReady" };
          if (response.status === 409 && errorClass === "account_mismatch") return { ok: false, error: "accountSwitch" };
          if (errorClass === "consent_refused") return { ok: false, error: "consentRefused" };
          if (errorClass === "ebay_not_configured") return { ok: false, error: "notConfigured" };
          if (errorClass === "bad_request") return { ok: false, error: "badRequest" };
          if (errorClass === "internal") return { ok: false, error: "internal" };
          return { ok: false, error: "unavailable" };
        }
        // From here the service has stored a session: every refusal discards it.
        const body = (await response.json().catch(() => null)) as
          | { username?: unknown; ebayUserId?: unknown; environment?: unknown }
          | null;
        const username = typeof body?.username === "string" ? body.username.trim().slice(0, 64) : "";
        const ebayUserId = typeof body?.ebayUserId === "string" ? body.ebayUserId.trim() : "";
        if (!EBAY_USER_ID_RE.test(ebayUserId)) {
          // NB cannot tell whose session it is, so it cannot check
          // one-owner-per-account: refuse to keep it.
          logEbayCredentialCall("connect", startedAt, "no_user_id", response.status);
          await discardEbaySession(ctx, args.userId, "no_user_id");
          return { ok: false, error: "unavailable" };
        }
        if (body?.environment !== config.environment) {
          // A session from the other eBay (sandbox vs production) than the
          // one this deployment lists on: its ids mean nothing here.
          logEbayCredentialCall("connect", startedAt, "environment_mismatch", response.status);
          await discardEbaySession(ctx, args.userId, "environment_mismatch");
          return { ok: false, error: "environmentMismatch" };
        }
        const displayName = username.length > 0 ? username : ebayUserId;
        let recorded: { kind: "accountSwitch" } | { kind: "recorded"; staleLinks: boolean };
        try {
          recorded = await ctx.runMutation(internal.ebayConnect.recordEbayConnection, {
            ownerId: args.userId,
            ebayUserId,
            ebayUsername: displayName,
          });
        } catch {
          logEbayCredentialCall("connect", startedAt, "record_failed", response.status);
          await discardEbaySession(ctx, args.userId, "record_failed");
          return { ok: false, error: "internal" };
        }
        if (recorded.kind === "accountSwitch") {
          logEbayCredentialCall("connect", startedAt, "account_switch", response.status);
          await discardEbaySession(ctx, args.userId, "account_switch");
          return { ok: false, error: "accountSwitch" };
        }
        if (recorded.staleLinks) {
          // Link rows left from the account a Disconnect could not fully
          // end: their offer ids mean nothing on this account, so they are
          // deleted (accepted in security review: those listings stay up on
          // the old account, and Disconnect told the collector how many).
          let pages = 0;
          for (let cursor: string | null = null; pages < MAX_STALE_LINK_PAGES; pages += 1) {
            const page: { cursor: string; isDone: boolean } = await ctx.runMutation(
              internal.ebayConnect.purgeEbayLinksPage,
              { ownerId: args.userId, keepLive: false, cursor },
            );
            if (page.isDone) break;
            cursor = page.cursor;
          }
          logEbayCredentialCall("connect_stale_links", startedAt, "cleared");
        }
        logEbayCredentialCall("connect", startedAt, "ok", response.status);
        await ctx.runMutation(internal.userProfile.updateSiteCredentialStatus, {
          userId: args.userId,
          site: "ebay",
          hasCredentials: true,
          needsReauth: false,
          listing: args.listing,
        });
        return { ok: true, username: displayName, ebayUserId };
      },
      { ok: false, error: "busy" },
    );
  },
});

/**
 * Deletes the stored eBay session (`DELETE /credentials/<key>`; a 404 is
 * already gone) and clears the saved sign-in, which stops listing there
 * (`removeSiteCredentialStatus` → `listingOutbox.stopListingForSite`). What
 * eBay lists is left as it is. Under the credential lock.
 */
export const disconnectEbay = internalAction({
  args: { userId: v.string() },
  returns: v.object({ ok: v.boolean() }),
  handler: async (ctx, args): Promise<{ ok: boolean }> => {
    return await withCredentialLock(
      ctx,
      args.userId,
      "ebay",
      "delete",
      async () => {
        const startedAt = Date.now();
        try {
          const response = await browserFetch(`/credentials/${credKey("ebay", args.userId)}`, {
            method: "DELETE",
            headers: await browserAuthHeaders(),
          });
          logEbayCredentialCall("disconnect", startedAt, response.ok ? "ok" : "http_error", response.status);
          if (!response.ok && response.status !== 404) return { ok: false };
        } catch {
          logEbayCredentialCall("disconnect", startedAt, "network");
          return { ok: false };
        }
        await ctx.runMutation(internal.userProfile.removeSiteCredentialStatus, { userId: args.userId, site: "ebay" });
        return { ok: true };
      },
      { ok: false },
    );
  },
});

/** Time Disconnect spends taking listings down under the lock (the lock's lease is 5 minutes). */
const EBAY_WITHDRAW_BUDGET_MS = 3 * 60 * 1000;
/** A cached eBay access token closer than this to expiring is renewed before Disconnect uses it. */
const EBAY_TOKEN_MIN_LIFE_MS = 5 * 60 * 1000;

/**
 * An eBay access token for work that already holds the owner's credential
 * lock (Disconnect): the cached one, renewed first (`refreshEbayToken`, no
 * second lock) when it is missing or about to lapse. Null when there is
 * none to be had.
 */
async function ebayTokenUnderLock(ctx: Pick<ActionCtx, "runMutation">, userId: string): Promise<string | null> {
  const cached = await readCachedToken("ebay", userId).catch(() => null);
  if (cached === "not_found") return null;
  const fresh =
    cached !== null && (cached.expiresAt === undefined || cached.expiresAt - Date.now() > EBAY_TOKEN_MIN_LIFE_MS);
  if (fresh) return cached.token;
  if (!(await refreshEbayToken(ctx, userId))) return cached?.token ?? null;
  const renewed = await readCachedToken("ebay", userId).catch(() => null);
  return renewed !== null && renewed !== "not_found" ? renewed.token : null;
}

/**
 * Withdraws every live NB listing on the owner's eBay account and marks each
 * link ended, a page at a time (`ebayConnect.liveEbayLinksPage`,
 * `ebayConnect.markEbayLinksEnded`). `session` null (eBay paused, not wired,
 * no token): nothing is sent and every live listing counts as not ended.
 * Returns how many were ended and how many are still live.
 */
async function withdrawLiveEbayListings(
  ctx: Pick<ActionCtx, "runQuery" | "runMutation" | "runAction">,
  userId: string,
  session: EbaySellerSession | null,
): Promise<{ ended: number; notEnded: number }> {
  const startedAt = Date.now();
  let ended = 0;
  let notEnded = 0;
  for (let cursor: string | null = null; ; ) {
    const page: { offers: Array<{ sku: string; offerId: string }>; cursor: string; isDone: boolean } =
      await ctx.runQuery(internal.ebayConnect.liveEbayLinksPage, { ownerId: userId, cursor });
    const endedSkus: string[] = [];
    for (const offer of page.offers) {
      if (!session || session.dead || Date.now() - startedAt > EBAY_WITHDRAW_BUDGET_MS) {
        notEnded += 1;
        continue;
      }
      const r = await withdrawOffer(ctx, session, offer.offerId);
      // 404: eBay no longer has it live.
      if (r.ok || r.failure.httpStatus === 404) endedSkus.push(offer.sku);
      else notEnded += 1;
    }
    if (endedSkus.length > 0) {
      await ctx.runMutation(internal.ebayConnect.markEbayLinksEnded, { ownerId: userId, skus: endedSkus });
      ended += endedSkus.length;
    }
    if (page.isDone) break;
    cursor = page.cursor;
  }
  return { ended, notEnded };
}

/**
 * Disconnect, all under the owner's eBay credential lock (`delete`), so no
 * publish's token refresh or second connect runs beside it: every live NB
 * listing is withdrawn on eBay and marked ended, the stored session goes
 * (`DELETE /credentials/<key>`; 404 is already gone) with the saved sign-in,
 * the link rows go except any still live, and the settings and the profile's
 * eBay user id go (`ebayConnect.forgetEbayConnection`). The caller stopped
 * listing first. A session that will not delete changes nothing more:
 * `ok: false`. `notEnded`: listings still live on eBay.
 */
export const disconnectEbayAndWithdraw = internalAction({
  args: { userId: v.string() },
  returns: v.object({ ok: v.boolean(), notEnded: v.number() }),
  handler: async (ctx, args): Promise<{ ok: boolean; notEnded: number }> => {
    return await withCredentialLock<{ ok: boolean; notEnded: number }>(
      ctx,
      args.userId,
      "ebay",
      "delete",
      async () => {
        const startedAt = Date.now();
        const config = ebayConfig();
        let session: EbaySellerSession | null = null;
        if (config && !isPlatformPaused("ebay")) {
          const token = await ebayTokenUnderLock(ctx, args.userId);
          // Renewed just now (or fresh): a 401 is final, never a second refresh under this lock.
          if (token) session = { ownerId: args.userId, token, config, reauthAttempted: true, dead: false };
        }
        const withdrawn = await withdrawLiveEbayListings(ctx, args.userId, session);
        logEbayCredentialCall("disconnect_withdraw", startedAt, session ? "ok" : "no_session");
        try {
          const response = await browserFetch(`/credentials/${credKey("ebay", args.userId)}`, {
            method: "DELETE",
            headers: await browserAuthHeaders(),
          });
          logEbayCredentialCall("disconnect", startedAt, response.ok ? "ok" : "http_error", response.status);
          if (!response.ok && response.status !== 404) return { ok: false, notEnded: withdrawn.notEnded };
        } catch {
          logEbayCredentialCall("disconnect", startedAt, "network");
          return { ok: false, notEnded: withdrawn.notEnded };
        }
        await ctx.runMutation(internal.userProfile.removeSiteCredentialStatus, { userId: args.userId, site: "ebay" });
        let keptLive = 0;
        for (let cursor: string | null = null; ; ) {
          const page: { cursor: string; isDone: boolean; keptLive: number } = await ctx.runMutation(
            internal.ebayConnect.purgeEbayLinksPage,
            { ownerId: args.userId, keepLive: true, cursor },
          );
          keptLive += page.keptLive;
          if (page.isDone) break;
          cursor = page.cursor;
        }
        await ctx.runMutation(internal.ebayConnect.forgetEbayConnection, { ownerId: args.userId });
        return { ok: true, notEnded: keptLive };
      },
      { ok: false, notEnded: 0 },
    );
  },
});

/**
 * NEO-415: asks the browser service whether an eBay Notification API push
 * is really from eBay (`POST /webhooks/ebay/verify`; the service holds the
 * app credentials eBay's public key needs). `body` is the raw request text
 * as Convex received it. `unavailable` covers the service or eBay being
 * down, an older service, and an answer NB cannot read: the caller answers
 * eBay with a 500 so eBay retries.
 */
export const verifyEbayNotification = internalAction({
  args: { signatureHeader: v.string(), body: v.string() },
  returns: v.union(v.literal("valid"), v.literal("invalid"), v.literal("unavailable"), v.literal("notConfigured")),
  handler: async (_ctx, args): Promise<"valid" | "invalid" | "unavailable" | "notConfigured"> => {
    const startedAt = Date.now();
    let response: Response;
    try {
      response = await browserFetch("/webhooks/ebay/verify", {
        method: "POST",
        headers: { ...(await browserAuthHeaders()), "Content-Type": "application/json" },
        body: JSON.stringify({ signatureHeader: args.signatureHeader, body: args.body }),
      });
    } catch {
      logEbayCredentialCall("verify_notification", startedAt, "network");
      return "unavailable";
    }
    if (response.ok) {
      const body = (await response.json().catch(() => null)) as { valid?: unknown } | null;
      const verdict = body?.valid === true ? "valid" : body?.valid === false ? "invalid" : "unavailable";
      logEbayCredentialCall("verify_notification", startedAt, verdict, response.status);
      return verdict;
    }
    const errorClass = await serviceErrorClass(response);
    logEbayCredentialCall("verify_notification", startedAt, errorClass ?? "unreadable", response.status);
    if (response.status === 503 && errorClass === "ebay_not_configured") return "notConfigured";
    // 400 means NB sent a shape the service refuses (a bug on our side, not
    // a verdict on the notice); 502 is eBay unreachable.
    return "unavailable";
  },
});

/**
 * The eBay branch of `refreshSiteToken` (already under the credential lock):
 * asks the browser service to renew the access token. True when it did; a
 * `reauth_required` answer (eBay refused the refresh token, or none is
 * stored) flags `needsReauth`; anything else (not configured, eBay or the
 * store down, an older service) is a failed refresh that writes nothing.
 */
async function refreshEbayToken(
  ctx: Pick<ActionCtx, "runMutation">,
  userId: string,
): Promise<boolean> {
  if (!ebayConfigured()) return false;
  const startedAt = Date.now();
  let response: Response;
  try {
    response = await browserFetch("/oauth/ebay/refresh", {
      method: "POST",
      headers: { ...(await browserAuthHeaders()), "Content-Type": "application/json" },
      body: JSON.stringify({ key: credKey("ebay", userId) }),
    });
  } catch {
    logEbayCredentialCall("refresh", startedAt, "network");
    return false;
  }
  if (response.ok) {
    await response.text().catch(() => "");
    logEbayCredentialCall("refresh", startedAt, "ok", response.status);
    await ctx.runMutation(internal.userProfile.setSiteReauthState, { userId, site: "ebay", needsReauth: false });
    return true;
  }
  const errorClass = await serviceErrorClass(response);
  logEbayCredentialCall("refresh", startedAt, errorClass ?? "unreadable", response.status);
  if (response.status === 401 && errorClass === "reauth_required") {
    await ctx.runMutation(internal.userProfile.setSiteReauthState, { userId, site: "ebay", needsReauth: true });
  }
  return false;
}
