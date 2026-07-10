"use node";

import { action, internalAction } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { v } from "convex/values";
import { getCurrentUserId } from "./auth";
import { GoogleAuth, IdTokenClient } from "google-auth-library";
import { randomUUID } from "crypto";
import { oidcAudienceFor } from "./browserAudience";

const MAX_INPUT_LENGTH = 256;
const SUPPORTED_SITES = ["buysportscards", "sportlots"];

function isSupportedSite(site: string): boolean {
  return (SUPPORTED_SITES as readonly string[]).includes(site);
}

function browserUrl() {
  return process.env.NEONBINDER_BROWSER_URL || "http://localhost:8080";
}

const BROWSER_FETCH_TIMEOUT_MS = 15_000;

// NEO-20: the browser service Cloud Run instance requires IAM-authenticated
// requests. Convex calls it as the neonbinder-convex service account
// (credentials decoded from GOOGLE_APPLICATION_CREDENTIALS_B64) and mints a
// Google OIDC ID token whose audience is the Cloud Run service URL. The
// google-auth-library client caches and auto-refreshes the token, so we just
// keep one client per audience for the life of this module.
let cachedIdTokenClient: { audience: string; client: IdTokenClient } | null = null;

// Loopback hosts allowed to bypass OIDC (local-dev browser service). Anything
// else over plain http:// is treated as misconfiguration and throws — we do
// NOT want to silently fall back to unauthenticated requests against a
// real-but-misconfigured endpoint.
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

async function getIdTokenClient(audience: string): Promise<IdTokenClient | null> {
  if (!audience.startsWith("https://")) {
    let host = "";
    try {
      host = new URL(audience).hostname;
    } catch {
      throw new Error(
        `NEONBINDER_BROWSER_URL is not a valid URL: ${audience}`,
      );
    }
    if (LOOPBACK_HOSTS.has(host)) {
      // Local dev — browser service runs on the developer machine without
      // Cloud Run IAM. Skip OIDC entirely.
      return null;
    }
    throw new Error(
      `NEONBINDER_BROWSER_URL must use https:// for non-loopback hosts; got ${audience}. Refusing to send unauthenticated requests to a remote browser service.`,
    );
  }

  if (cachedIdTokenClient && cachedIdTokenClient.audience === audience) {
    return cachedIdTokenClient.client;
  }

  const b64 = process.env.GOOGLE_APPLICATION_CREDENTIALS_B64;
  if (!b64) {
    throw new Error(
      "GOOGLE_APPLICATION_CREDENTIALS_B64 not set — required to authenticate to the browser service",
    );
  }
  const credentials = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
  const auth = new GoogleAuth({ credentials });
  const client = await auth.getIdTokenClient(audience);
  cachedIdTokenClient = { audience, client };
  return client;
}

async function browserAuthHeaders(): Promise<Record<string, string>> {
  // Send requests to browserUrl() (possibly a tagged pr-N--- preview host) but
  // mint the OIDC token against the base service URL that Cloud Run expects.
  const client = await getIdTokenClient(oidcAudienceFor(browserUrl()));
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (!client) return headers;
  const authHeaders = await client.getRequestHeaders();
  // google-auth-library v10 returns a web-standard Headers object (v9 returned a
  // plain object); iterate its entries (keys lowercased, values strings) to copy
  // Authorization (and sometimes x-goog-user-project) across. Object.entries()
  // would yield [] on a Headers instance and silently drop the auth header.
  authHeaders.forEach((value, key) => {
    headers[key] = value;
  });
  return headers;
}

async function browserFetch(
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

function credKey(site: string, userId: string) {
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
 * - `username`+`password` both provided → store to the browser service (PUT),
 *   then atomically mark `hasCredentials: true`.
 * - Both omitted/blank → delete from the browser service (DELETE) — a
 *   genuinely distinct GCP operation, not a blank overwrite: Secret
 *   Manager's `updateCredentials` only ever ADDS a version, it never
 *   destroys prior ones, so a "store with empty strings" could never
 *   actually purge real credential material — then atomically clear
 *   `hasCredentials`.
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
          const key = credKey(args.site, userId);

          // Store credentials without marketplace validation.
          // Use "Test Credentials" to validate against the marketplace separately.
          const response = await browserFetch(`/credentials/${key}`, {
            method: "PUT",
            headers: await browserAuthHeaders(),
            body: JSON.stringify({ username, password }),
          });

          if (!response.ok) {
            const errorData = await response.json().catch(() => ({ error: "Unknown error" }));
            return {
              success: false,
              message: (errorData as { error?: string }).error || `Failed to store credentials for ${args.site}`,
            };
          }

          await ctx.runMutation(internal.userProfile.updateSiteCredentialStatus, {
            userId,
            site: args.site,
            hasCredentials: true,
          });

          return {
            success: true,
            message: `Credentials stored successfully for ${args.site}`,
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
            message: "Failed to store credentials securely",
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
      };

      return {
        username: data.username || "",
        site: args.site,
        hasToken: !!data.hasToken,
        ...(data.expiresAt && { expiresAt: data.expiresAt }),
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
 * Read the raw token + expiresAt from the browser service's secret
 * store. Returns `"not_found"` specifically on 404 (the secret doesn't
 * exist at all — distinct from a transient non-OK response) so
 * `getSiteToken` can self-heal a stale `hasCredentials` flag (NEO-89:
 * "ghost credentials" — the flag can say true while the underlying secret
 * was deleted out from under it, e.g. by an interrupted client operation).
 * Any other non-OK response returns null. Internal helper for
 * getSiteToken — does NOT trigger refresh.
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
  if (response.status === 404) return "not_found";
  if (!response.ok) return null;
  return (await response.json()) as { token: string; expiresAt?: number };
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
          await ctx.runMutation(internal.userProfile.removeSiteCredentialStatus, {
            userId,
            site: args.site,
          });
        }
        return null;
      }

      if (!cached) {
        // No cached token, but the secret itself exists (readCachedToken
        // didn't return "not_found"). The per-user creds may be
        // seeded-but-never-warmed (seed-credentials stores creds without
        // logging in) or the cached token was evicted by the
        // browser-service TTL mid-session. Mint a fresh token via re-auth
        // (which logs in using the stored creds) before giving up —
        // otherwise the caller fails with `no_credentials` even though
        // credentials exist. Confirmed E2E root cause: a worker's token
        // was evicted ~18min after warm, so a later sport/year fetch got a
        // null token and the column came up empty (no Football, etc.).
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

/**
 * Authenticate BSC credentials via the browser service.
 * Reads credentials from GCP, sends to browser service for Puppeteer login,
 * which extracts the bearer token and stores it back in GCP.
 *
 * NEO-20: internalAction. Frontend triggers a re-auth via the public
 * testSiteCredentials wrapper, never directly. Direct invocation would
 * expose the success/sellerId metadata to unauthorized callers.
 */
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
): Promise<{ success: boolean; data: { success: boolean; message?: string; storeName?: string; sellerId?: string } | null; detail: string; diagnostic?: LoginDiagnostic }> {
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
        body: JSON.stringify({ key }),
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
      };
      if (err.diagnostic) diagnostic = err.diagnostic;
      detail = err.error || response.statusText;
      console.log(
        `[${label}] login failed: ${detail}` +
          (diagnostic?.challengeDetected ? " [challenge page detected]" : ""),
      );
      return { success: false, data: null, detail, diagnostic };
    } catch (e) {
      // Network/timeout to the browser service — do not retry (avoid hammering).
      detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      console.log(`[${label}] login request threw: ${detail}`);
      return { success: false, data: null, detail, diagnostic };
    }
  }
  return { success: false, data: null, detail, diagnostic };
}

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
      const key = credKey("buysportscards", userId);
      const url = browserUrl();
      console.log(`[authenticateBsc] Using browser URL: ${url}, key: ${key}`);

      // Log in via the browser service (it reads credentials from Secret
      // Manager internally). Retries transient failures/delays with backoff.
      console.log("[authenticateBsc] Calling browser service POST /login/bsc");
      const result = await loginWithRetry(`${url}/login/bsc`, key, "authenticateBsc");
      if (!result.success || !result.data) {
        await ctx.runAction(internal.posthog.captureEvent, {
          distinctId: userId,
          event: "credential_test_failed",
          properties: {
            platform: "buysportscards",
            reason: result.detail,
            ...(result.diagnostic ?? {}),
          },
        }).catch(() => {});
        return {
          success: false,
          message: "BSC login failed. Please check your credentials and try again.",
        };
      }

      const loginResult = result.data;

      // Persist BSC sellerId on the user's profile so subsequent
      // fetchBscChecklist calls don't have to re-derive it. The browser
      // service may legitimately return success without sellerId if BSC's
      // /marketplace/user/profile shape changes — in that case we skip the
      // upsert and fall back to env-var seller in fetchBscChecklist.
      if (loginResult.sellerId) {
        await ctx.runMutation(internal.userProfile.setMarketplaceAccountIdInternal, {
          userId,
          site: "buysportscards",
          accountId: loginResult.sellerId,
        });
      }

      return {
        success: true,
        message: "BSC account authenticated successfully! Token stored.",
        details: loginResult.storeName ? `Store: ${loginResult.storeName}` : undefined,
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unknown error";
      await ctx.runAction(internal.posthog.captureEvent, {
        distinctId: userId,
        event: "credential_test_failed",
        properties: { platform: "buysportscards", reason: detail },
      }).catch(() => {});
      console.error("Failed to authenticate BSC");
      return {
        success: false,
        message: "BSC authentication failed. Please try again.",
      };
    }
  },
});

/**
 * Authenticate SportLots credentials via the browser service.
 * Reads credentials from GCP, sends to browser service for HTTP login,
 * which extracts JS-set cookies and stores them back in GCP as a token.
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
      const key = credKey("sportlots", userId);

      // Log in via the browser service (it reads credentials from Secret
      // Manager internally). Retries transient failures/delays with backoff.
      const result = await loginWithRetry(`${browserUrl()}/login/sportlots`, key, "authenticateSportlots");
      if (!result.success) {
        await ctx.runAction(internal.posthog.captureEvent, {
          distinctId: userId,
          event: "credential_test_failed",
          properties: {
            platform: "sportlots",
            reason: result.detail,
            ...(result.diagnostic ?? {}),
          },
        }).catch(() => {});
        return {
          success: false,
          message: "SportLots login failed. Please check your credentials and try again.",
        };
      }

      return {
        success: true,
        message: "SportLots account authenticated successfully! Session cookie stored.",
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unknown error";
      await ctx.runAction(internal.posthog.captureEvent, {
        distinctId: userId,
        event: "credential_test_failed",
        properties: { platform: "sportlots", reason: detail },
      }).catch(() => {});
      console.error("Failed to authenticate SportLots");
      return {
        success: false,
        message: "SportLots authentication failed. Please try again.",
      };
    }
  },
});
