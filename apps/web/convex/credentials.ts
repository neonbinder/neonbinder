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
 */
const SITE_LOGIN: Record<
  string,
  {
    path: string;
    displayName: string;
    /** PostHog `platform` property (NEO-43). Must stay stable. */
    platform: CredentialTestProperties["platform"];
    failureMessage: string;
    successMessage: string;
  }
> = {
  buysportscards: {
    path: "/login/bsc",
    displayName: "BuySportsCards",
    platform: "buysportscards",
    failureMessage: "BSC login failed. Please check your credentials and try again.",
    successMessage: "BSC account authenticated successfully! Token stored.",
  },
  sportlots: {
    path: "/login/sportlots",
    displayName: "SportLots",
    platform: "sportlots",
    failureMessage: "SportLots login failed. Please check your credentials and try again.",
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

  const response = await fetch(`${url}/health`, {
    method: "GET",
    headers,
    signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
  });
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
  try {
    return await fetch(`${browserUrl()}${path}`, {
      ...init,
      signal: AbortSignal.timeout(BROWSER_FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
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
  ctx: { runMutation: (ref: any, args: any) => Promise<any> },
  userId: string,
  site: string,
  op: "store" | "test" | "delete",
  body: () => Promise<T>,
  busyResult: T,
): Promise<T> {
  const token = randomUUID();
  const lock = (await ctx.runMutation(
    internal.userProfile.acquireCredentialLock,
    { userId, site, op, token },
  )) as { acquired: boolean };
  if (!lock.acquired) return busyResult;
  try {
    return await body();
  } finally {
    await ctx.runMutation(internal.userProfile.releaseCredentialLock, {
      userId,
      site,
      token,
    });
  }
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

      return withCredentialLock(ctx, userId, args.site, "store", async () => {
        try {
          // NEO-141: connect-and-store. The password is handed to the login
          // route for this one request only — the browser service persists the
          // resulting session, never the password. There is therefore no
          // "store now, verify later": a login we cannot complete gives us
          // nothing worth storing.
          const outcome = await runSiteLogin(
            ctx,
            userId,
            args.site,
            { username, password },
            "saveCredentials",
          );

          if (!outcome.success) {
            // Store NOTHING on failure. Leaving `hasCredentials` untouched is
            // the whole point: a half-saved credential is what NEO-140 was.
            return {
              success: false,
              message: `Could not sign in to ${siteDisplayName(args.site)}. Nothing was saved — check your username and password and try again.`,
            };
          }

          await ctx.runMutation(internal.userProfile.updateSiteCredentialStatus, {
            userId,
            site: args.site,
            hasCredentials: true,
            // A successful login is proof no re-auth is pending.
            needsReauth: false,
          });

          return {
            success: true,
            message: `Connected to ${siteDisplayName(args.site)} successfully. Your password was not stored — only the session it created.`,
          };
        } catch (error) {
          const detail = error instanceof Error
            ? `${error.name}: ${error.message}${error.cause ? ` (cause: ${String(error.cause)})` : ""}`
            : String(error);
          console.error(
            `[saveCredentials] store site=${args.site} url=${browserUrl()} threw: ${detail}`,
          );
          return {
            success: false,
            message: credentialFailureMessage(error, args.site),
          };
        }
      }, {
        success: false,
        message: "Another credential operation is in progress — try again.",
      });
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
  const response = await browserFetch(`/credentials/${key}/token`, {
    method: "GET",
    headers: await browserAuthHeaders(),
  });

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
        const minted = await refreshSiteToken(ctx, userId, args.site);
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
      const refreshed = await refreshSiteToken(ctx, userId, args.site);
      if (!refreshed) {
        // Refresh failed; fall back to the (likely stale) cached
        // token rather than null — let the caller's 401 path surface
        // a clear "please re-login" error if the cache really is dead.
        return cached;
      }

      const fresh = await readCachedToken(args.site, userId);
      return fresh === "not_found" ? null : (fresh ?? cached);
    } catch (error) {
      console.error(`Failed to retrieve token for ${args.site}`);
      return null;
    }
  },
});

/**
 * Internal helper — invoke the site's authenticate action to refresh
 * its token. Returns true on success, false on any failure. Does not
 * throw. Site list is intentionally explicit (no dynamic dispatch) so
 * adding a new marketplace requires explicit wiring here — which is
 * the right place to confirm the new site's auth flow handles cached
 * tokens properly.
 */
async function refreshSiteToken(
  ctx: {
    runAction: (ref: any, args: any) => Promise<unknown>;
    runMutation: (ref: any, args: any) => Promise<any>;
  },
  userId: string,
  site: string,
): Promise<boolean> {
  // Contend for the per-(user, site) credential lock: a background refresh runs
  // the same login that writes a token to Secret Manager, so without this a
  // fetch-driven re-auth could re-mint a token right after a user Clear (the
  // same corruption class). On contention treat as refresh-failed (false) —
  // getSiteToken then falls back to the cached token or null, both safe.
  return withCredentialLock(ctx, userId, site, "test", async () => {
    try {
      if (site === "buysportscards") {
        const result = (await ctx.runAction(internal.credentials.authenticateBsc, {})) as {
          success: boolean;
        };
        return result.success;
      }
      if (site === "sportlots") {
        const result = (await ctx.runAction(internal.credentials.authenticateSportlots, {})) as {
          success: boolean;
        };
        return result.success;
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

          case "ebay": {
            console.log("[testSiteCredentials] Dispatching to ebay.testCredentials");
            const result = await ctx.runAction(api.adapters.ebay.testCredentials, {});
            console.log(`[testSiteCredentials] ebay.testCredentials returned: success=${result.success}`);
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
    try {
      const response = await fetch(loginUrl, {
        method: "POST",
        headers: await browserAuthHeaders(),
        body: JSON.stringify(transient ? { key, ...transient } : { key }),
        signal: AbortSignal.timeout(60_000),
      });
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

type SiteLoginOutcome = {
  success: boolean;
  message: string;
  details?: string;
  /** The browser service says only a fresh password can fix this. */
  reauthRequired: boolean;
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
    return { success: false, message: `Unsupported site: ${site}`, reauthRequired: false };
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
    return {
      success: false,
      message: cfg.failureMessage,
      reauthRequired: result.errorClass === REAUTH_REQUIRED,
    };
  }

  const loginResult = result.data;

  // Persist BSC sellerId on the user's profile so subsequent
  // fetchBscChecklist calls don't have to re-derive it. The browser
  // service may legitimately return success without sellerId if BSC's
  // /marketplace/user/profile shape changes — in that case we skip the
  // upsert and fall back to env-var seller in fetchBscChecklist.
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
  ctx: { runMutation: (ref: any, args: any) => Promise<any> },
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
  args: {},
  returns: v.object({
    success: v.boolean(),
    message: v.string(),
    details: v.optional(v.string()),
  }),
  handler: async (ctx): Promise<{ success: boolean; message: string; details?: string }> => {
    console.log("[authenticateBsc] Starting BSC authentication");
    const userId = await getCurrentUserId(ctx);
    if (!userId) {
      console.log("[authenticateBsc] Not authenticated - no userId");
      throw new Error("Not authenticated");
    }

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
  args: {},
  returns: v.object({
    success: v.boolean(),
    message: v.string(),
    details: v.optional(v.string()),
  }),
  handler: async (ctx): Promise<{ success: boolean; message: string; details?: string }> => {
    const userId = await getCurrentUserId(ctx);
    if (!userId) {
      throw new Error("Not authenticated");
    }

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
