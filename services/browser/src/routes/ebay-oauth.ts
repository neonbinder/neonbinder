import { Request, Response, Router } from "express";
import { Credentials, SecretsManagerService } from "../services/secrets-manager";
import {
  EBAY_USER_ID_PATTERN,
  EbayOAuthConfig,
  EbayOAuthError,
  EbayTokenResult,
  exchangeAuthorizationCode,
  EbayIdentity,
  fetchEbayIdentity,
  readEbayOAuthConfig,
  refreshAccessToken,
} from "../services/ebay-oauth";
import { EbayNotificationVerifier } from "../services/ebay-notification";
import { EbayOAuthLine, logEbayOAuthOp } from "../observability";

/**
 * NEO-415 — eBay connect and refresh.
 *
 *   POST /oauth/ebay/connect  { key, code, expectEbayUserId? }
 *                           | { key, refreshToken, expectEbayUserId? }  (not in production)
 *     → 200 { username, ebayUserId, environment, expiresAt }
 *   POST /oauth/ebay/refresh  { key }
 *     → 200 { token, expiresAt }
 *   POST /webhooks/ebay/verify  { signatureHeader, body }
 *     → 200 { valid }
 *
 * Both are reached the way every other route is: Cloud Run IAM in front (only
 * the Convex service account may invoke), the global per-credential-key rate
 * limiter (src/rate-limit.ts reads `body.key`), no app-layer auth.
 *
 * WHAT IS STORED
 *
 * One secret per seller, `ebay-credentials-<userId>`, through the same
 * SecretsManagerService every login uses:
 *
 *   { username, ebayUserId, token, expiresAt, refreshToken, refreshExpiresAt }
 *
 * `username` is the seller's eBay username and `ebayUserId` their immutable
 * eBay user id, both from Commerce Identity getUser. The username can change
 * on eBay; the id cannot, so seller-conflict detection and the Marketplace
 * Account Deletion notification key on `ebayUserId`.
 * `token`/`expiresAt` are the two-hour access token, so the existing
 * GET /credentials/:key/token serves it to Convex unchanged; metadata and
 * DELETE work unchanged too.
 *
 * WHAT LEAVES THE SERVICE
 *
 * The refresh token never does, in any response or log line. The access
 * token leaves only in the /refresh response body, which is the point of
 * that route (and what GET /credentials/:key/token already returns). Error
 * bodies are `{ error_class }` from a closed set and nothing else.
 *
 * Key scope: both routes refuse any key that is not an eBay secret. /connect
 * REPLACES the payload, and pointed at a BSC secret it would wipe that
 * seller's rotating refresh token (the NEO-141 hazard; see routes/credentials.ts).
 */

/** Every route here is scoped to eBay secrets. See the header. */
const EBAY_KEY_PATTERN = /^ebay-credentials-[a-zA-Z0-9_-]+$/;
const MAX_KEY_LENGTH = 256;
/**
 * eBay's authorization codes and refresh tokens are a few hundred characters.
 * The cap bounds what we forward upstream; it is not a format check.
 */
const MAX_GRANT_LENGTH = 4096;

/** The error classes a caller can see. Closed set; see plan.md (NEO-415). */
export type EbayOAuthErrorClass =
  | "bad_request"
  | "consent_refused"
  | "reauth_required"
  | "ebay_unavailable"
  | "ebay_not_configured"
  | "account_mismatch"
  | "internal";

/** The slice of SecretsManagerService these routes use; injectable for tests. */
export interface EbayCredentialsStore {
  getCredentials(key: string): Promise<Credentials>;
  updateCredentials(key: string, credentials: Credentials): Promise<void>;
  credentialsExist(key: string): Promise<boolean>;
}

export interface EbayOAuthRouterDeps {
  /** Built per request, like the other routers, so a bad client cannot poison the process. */
  createStore?: () => EbayCredentialsStore;
  fetchImpl?: typeof fetch;
  /** Read per request, so a test can flip configuration without a reload. */
  env?: () => NodeJS.ProcessEnv;
  now?: () => number;
}

type ConnectBody = {
  key?: unknown;
  code?: unknown;
  refreshToken?: unknown;
  expectEbayUserId?: unknown;
};
type VerifyBody = { signatureHeader?: unknown; body?: unknown };
type RefreshBody = { key?: unknown };

function validKey(key: unknown): key is string {
  return typeof key === "string" && key.length <= MAX_KEY_LENGTH && EBAY_KEY_PATTERN.test(key);
}

function grantValue(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_GRANT_LENGTH) {
    return null;
  }
  return value;
}

/** A store error message (always a fixed string) → the bucket it means. */
function storeErrorKind(err: unknown): "bad_key" | "absent" | "failed" {
  const message = err instanceof Error ? err.message : "";
  if (message.includes("Invalid credential key format")) return "bad_key";
  if (message.includes("not found") || message.includes("No active version")) return "absent";
  return "failed";
}

export function createEbayOAuthRouter(deps: EbayOAuthRouterDeps = {}): Router {
  const router = Router();
  const createStore = deps.createStore ?? (() => new SecretsManagerService());
  const readEnv = deps.env ?? (() => process.env);
  const now = deps.now ?? Date.now;
  const ebayDeps = { fetchImpl: deps.fetchImpl, now };
  // One per router: it holds the app-token and public-key caches.
  const verifier = new EbayNotificationVerifier(ebayDeps);

  function finish(
    res: Response,
    line: Omit<EbayOAuthLine, "msg" | "duration_ms" | "success" | "status_code">,
    startMs: number,
    status: number,
    body: Record<string, unknown>,
  ): void {
    logEbayOAuthOp({
      msg: "ebay_oauth_call",
      ...line,
      duration_ms: Date.now() - startMs,
      success: status === 200,
      status_code: status,
    });
    res.status(status).json(body);
  }

  function fail(
    res: Response,
    line: Omit<EbayOAuthLine, "msg" | "duration_ms" | "success" | "status_code">,
    startMs: number,
    status: number,
    errorClass: EbayOAuthErrorClass,
  ): void {
    finish(res, { error_class: errorClass, ...line }, startMs, status, { error_class: errorClass });
  }

  /** eBay error → log detail. Never the message (fixed anyway) or a body. */
  function ebayDetail(err: EbayOAuthError) {
    return { ebay_status: err.upstreamStatus, ebay_error: err.oauthError };
  }

  router.post(
    "/oauth/ebay/connect",
    async (req: Request<{}, {}, ConnectBody>, res: Response) => {
      const startMs = Date.now();
      const config: EbayOAuthConfig | null = readEbayOAuthConfig(readEnv());
      const base = { operation: "connect" as const, environment: config?.environment };
      if (!config) {
        fail(res, base, startMs, 503, "ebay_not_configured");
        return;
      }

      const body = (req.body ?? {}) as ConnectBody;
      const code = grantValue(body.code);
      const refreshToken = grantValue(body.refreshToken);
      const expectEbayUserId = body.expectEbayUserId;
      // Exactly one of the two, each a bounded non-empty string.
      if (
        !validKey(body.key) ||
        code === null ||
        refreshToken === null ||
        (code === undefined) === (refreshToken === undefined) ||
        (expectEbayUserId !== undefined &&
          (typeof expectEbayUserId !== "string" || !EBAY_USER_ID_PATTERN.test(expectEbayUserId)))
      ) {
        fail(res, base, startMs, 400, "bad_request");
        return;
      }
      // The refresh-token form exists for the testing seed only. In production
      // it would let anything holding a seller's refresh token bind that eBay
      // account to an NB user without that seller's consent on this app.
      if (refreshToken !== undefined && config.environment === "production") {
        fail(res, { ...base, grant: "refresh_token", error_class: "seed_in_production" }, startMs, 400, "bad_request");
        return;
      }
      const key = body.key;
      const grant = code !== undefined ? ("code" as const) : ("refresh_token" as const);
      const line = { ...base, grant };

      let tokens: EbayTokenResult;
      let storedRefreshToken: string;
      let identity: EbayIdentity;
      try {
        if (code !== undefined) {
          const result = await exchangeAuthorizationCode(config, code, ebayDeps);
          tokens = result;
          storedRefreshToken = result.refreshToken;
        } else {
          // The testing seed: a refresh token minted out of band, exchanged
          // once so the secret starts life exactly as a real connect leaves it.
          tokens = await refreshAccessToken(config, refreshToken as string, ebayDeps);
          storedRefreshToken = tokens.refreshToken ?? (refreshToken as string);
        }
        identity = await fetchEbayIdentity(config, tokens.accessToken, ebayDeps);
      } catch (err) {
        if (err instanceof EbayOAuthError && err.kind === "rejected") {
          fail(res, { ...line, ...ebayDetail(err) }, startMs, 401, "consent_refused");
          return;
        }
        if (err instanceof EbayOAuthError) {
          fail(
            res,
            { ...line, ...ebayDetail(err), error_class: `ebay_${err.kind}` },
            startMs,
            502,
            "ebay_unavailable",
          );
          return;
        }
        console.error("eBay connect failed:", err instanceof Error ? err.name : "unknown");
        fail(res, line, startMs, 500, "internal");
        return;
      }

      // Reconnecting must land on the same eBay account the caller already
      // has linked. A different account is refused BEFORE anything is
      // written, so the stored session (and its linkage) stays as it was.
      if (expectEbayUserId !== undefined && identity.userId !== expectEbayUserId) {
        fail(res, line, startMs, 409, "account_mismatch");
        return;
      }

      // A new consent replaces whatever was stored: it is a complete session,
      // and a previous seller's tokens must not survive into it.
      const credentials: Credentials = {
        username: identity.username,
        ebayUserId: identity.userId,
        token: tokens.accessToken,
        expiresAt: tokens.expiresAt,
        refreshToken: storedRefreshToken,
      };
      if (tokens.refreshExpiresAt !== undefined) {
        credentials.refreshExpiresAt = tokens.refreshExpiresAt;
      }
      try {
        await createStore().updateCredentials(key, credentials);
      } catch (err) {
        if (storeErrorKind(err) === "bad_key") {
          fail(res, line, startMs, 400, "bad_request");
          return;
        }
        // The store already logged its own sanitised line (describeSecretError).
        fail(res, { ...line, error_class: "store_write_failed" }, startMs, 500, "internal");
        return;
      }

      finish(res, line, startMs, 200, {
        username: identity.username,
        ebayUserId: identity.userId,
        environment: config.environment,
        expiresAt: tokens.expiresAt,
      });
    },
  );

  router.post(
    "/oauth/ebay/refresh",
    async (req: Request<{}, {}, RefreshBody>, res: Response) => {
      const startMs = Date.now();
      const config = readEbayOAuthConfig(readEnv());
      const line = { operation: "refresh" as const, environment: config?.environment };
      if (!config) {
        fail(res, line, startMs, 503, "ebay_not_configured");
        return;
      }
      const key = (req.body ?? {}).key;
      if (!validKey(key)) {
        fail(res, line, startMs, 400, "bad_request");
        return;
      }

      const store = createStore();
      let stored: Credentials;
      try {
        stored = await store.getCredentials(key);
      } catch (err) {
        const kind = storeErrorKind(err);
        if (kind === "bad_key") {
          fail(res, line, startMs, 400, "bad_request");
        } else if (kind === "absent") {
          // Nothing stored: the seller is not connected, so the only way
          // forward is a new consent.
          fail(res, { ...line, error_class: "no_credentials" }, startMs, 401, "reauth_required");
        } else {
          // A Secret Manager fault is NOT "the seller must reconnect": answering
          // 401 here would flag needsReauth on a healthy account.
          fail(res, { ...line, error_class: "store_read_failed" }, startMs, 500, "internal");
        }
        return;
      }
      if (!stored.refreshToken) {
        fail(res, { ...line, error_class: "no_refresh_token" }, startMs, 401, "reauth_required");
        return;
      }

      let tokens: EbayTokenResult;
      try {
        tokens = await refreshAccessToken(config, stored.refreshToken, ebayDeps);
      } catch (err) {
        if (err instanceof EbayOAuthError && err.kind === "rejected") {
          // The stored secret is left exactly as it was. Convex records
          // needsReauth; a disconnect, not this route, removes the secret.
          fail(res, { ...line, ...ebayDetail(err) }, startMs, 401, "reauth_required");
          return;
        }
        if (err instanceof EbayOAuthError) {
          fail(
            res,
            { ...line, ...ebayDetail(err), error_class: `ebay_${err.kind}` },
            startMs,
            502,
            "ebay_unavailable",
          );
          return;
        }
        console.error("eBay refresh failed:", err instanceof Error ? err.name : "unknown");
        fail(res, line, startMs, 500, "internal");
        return;
      }

      // updateCredentials CREATES a secret that is absent. A disconnect that
      // landed while eBay was answering must not be undone by this write, so
      // confirm the secret is still there first. This narrows the window, it
      // does not close it: Convex holds its per-(user, site) credential lock
      // around refresh and disconnect, which is what serialises the two.
      try {
        if (!(await store.credentialsExist(key))) {
          fail(res, { ...line, error_class: "disconnected" }, startMs, 401, "reauth_required");
          return;
        }
        // Rebuilt field by field from the stored record: only what an eBay
        // secret carries, with eBay's answer layered on. eBay does not rotate
        // the refresh token on this grant; if it ever returns one, keep it.
        const next: Credentials = {
          username: stored.username,
          token: tokens.accessToken,
          expiresAt: tokens.expiresAt,
          refreshToken: tokens.refreshToken ?? stored.refreshToken,
        };
        const refreshExpiresAt = tokens.refreshToken
          ? tokens.refreshExpiresAt
          : stored.refreshExpiresAt;
        if (refreshExpiresAt !== undefined) next.refreshExpiresAt = refreshExpiresAt;
        if (stored.ebayUserId) next.ebayUserId = stored.ebayUserId;
        await store.updateCredentials(key, next);
      } catch {
        // Persisting is the contract: Convex re-reads the cached token after a
        // refresh, so a token we could not store is reported as a failure.
        fail(res, { ...line, error_class: "store_write_failed" }, startMs, 500, "internal");
        return;
      }

      res.set("Cache-Control", "no-store");
      finish(res, line, startMs, 200, { token: tokens.accessToken, expiresAt: tokens.expiresAt });
    },
  );

  /**
   * Verify an eBay Notification API push (Marketplace Account Deletion).
   *
   * Convex receives the push on its public http route and asks this service
   * because the check needs an application token, which needs the client
   * secret. `body` is the notification body text exactly as received;
   * `signatureHeader` is the `X-EBAY-SIGNATURE` value as received ("" when
   * absent). Both are attacker-controlled, so every "this is not eBay's"
   * outcome is a plain `200 {valid:false}`; only failing to reach eBay is an
   * error. See services/ebay-notification.ts for the steps and their source.
   */
  router.post(
    "/webhooks/ebay/verify",
    async (req: Request<{}, {}, VerifyBody>, res: Response) => {
      const startMs = Date.now();
      const config = readEbayOAuthConfig(readEnv());
      const line = { operation: "verify" as const, environment: config?.environment };
      if (!config) {
        fail(res, line, startMs, 503, "ebay_not_configured");
        return;
      }
      const { signatureHeader, body } = (req.body ?? {}) as VerifyBody;
      // Wrong TYPES are a Convex bug, not hostile input: say so.
      if (typeof signatureHeader !== "string" || typeof body !== "string") {
        fail(res, line, startMs, 400, "bad_request");
        return;
      }
      let valid: boolean;
      try {
        valid = await verifier.verify(config, signatureHeader, body);
      } catch (err) {
        if (err instanceof EbayOAuthError) {
          fail(
            res,
            { ...line, ...ebayDetail(err), error_class: `ebay_${err.kind}` },
            startMs,
            502,
            "ebay_unavailable",
          );
          return;
        }
        console.error("eBay notification verify failed:", err instanceof Error ? err.name : "unknown");
        fail(res, line, startMs, 500, "internal");
        return;
      }
      finish(res, { ...line, valid }, startMs, 200, { valid });
    },
  );

  return router;
}
