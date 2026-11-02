/**
 * NEO-415 — eBay OAuth for listing: the user-token exchange and the identity
 * lookup, as plain HTTP. Launches no browser.
 *
 * WHY THIS LIVES IN THE BROWSER SERVICE
 *
 * eBay's user consent yields an access token (about two hours) and a refresh
 * token (about eighteen months). The refresh token, and the app's client
 * secret that every token call presents, are long-lived credentials. This is
 * the one component that holds per-user credential material (NEO-20), so the
 * secret stays here, the refresh token goes straight into Secret Manager, and
 * Convex only ever sees the short-lived access token (through the existing
 * GET /credentials/:key/token, or the /oauth/ebay/refresh response).
 *
 * SECURITY: nothing in this module may put a token, the client secret, an
 * authorization code or an eBay response body into an Error message or a log
 * line. Failures are a closed set of `EbayOAuthError` kinds plus eBay's
 * OAuth `error` code when it is one we recognise (`knownOAuthError`), never
 * eBay's free-text `error_description`.
 */

/** eBay's two environments. Anything else in EBAY_ENVIRONMENT is "not configured". */
export type EbayEnvironment = "sandbox" | "production";

export interface EbayOAuthConfig {
  environment: EbayEnvironment;
  clientId: string;
  clientSecret: string;
  /** eBay's RuName: the value eBay wants as `redirect_uri` on the code grant. */
  ruName: string;
}

/**
 * Hosts per environment. Fixed here, never read from the environment or a
 * request: these calls carry the client secret in an Authorization header,
 * so a configurable host would be a way to post that secret anywhere.
 *
 *   api   — OAuth token endpoint (`/identity/v1/oauth2/token`)
 *   apiz  — Commerce Identity API (`/commerce/identity/v1/user/`); eBay serves
 *           this one API from the `apiz` host, not `api`.
 */
export const EBAY_HOSTS: Record<EbayEnvironment, { api: string; apiz: string }> = {
  production: { api: "https://api.ebay.com", apiz: "https://apiz.ebay.com" },
  sandbox: { api: "https://api.sandbox.ebay.com", apiz: "https://apiz.sandbox.ebay.com" },
};

const TOKEN_PATH = "/identity/v1/oauth2/token";
const IDENTITY_USER_PATH = "/commerce/identity/v1/user/";

/**
 * The scopes NB asks for at consent. Convex builds the consent URL from the
 * same list (plan.md, NEO-415); the refresh grant repeats it, because eBay
 * wants the refresh request's scopes to be the consented set or a subset.
 * Changing this list means every stored refresh token minted with the old list
 * must re-consent if the new list is a superset — keep the two in lockstep.
 */
export const EBAY_SCOPES: readonly string[] = [
  "https://api.ebay.com/oauth/api_scope",
  "https://api.ebay.com/oauth/api_scope/sell.inventory",
  "https://api.ebay.com/oauth/api_scope/sell.account",
  "https://api.ebay.com/oauth/api_scope/sell.fulfillment",
  "https://api.ebay.com/oauth/api_scope/commerce.identity.readonly",
];

/** Per-call budget. eBay's token endpoint answers in well under a second. */
export const EBAY_REQUEST_TIMEOUT_MS = 10_000;

/** No real eBay username or user id comes near this; it bounds what we store and return. */
const MAX_USERNAME_LENGTH = 128;

/**
 * Read the eBay app configuration from the environment.
 *
 * @returns the config, or null when any of the four values is missing or
 *   EBAY_ENVIRONMENT is not exactly `sandbox` or `production`. A typo in the
 *   environment name is refused rather than defaulted, because defaulting to
 *   production would point a dev or preview deployment at real sellers.
 */
export function readEbayOAuthConfig(
  env: NodeJS.ProcessEnv = process.env,
): EbayOAuthConfig | null {
  const environment = env.EBAY_ENVIRONMENT?.trim();
  const clientId = env.EBAY_CLIENT_ID?.trim();
  const clientSecret = env.EBAY_CLIENT_SECRET?.trim();
  const ruName = env.EBAY_RU_NAME?.trim();
  if (environment !== "sandbox" && environment !== "production") return null;
  if (!clientId || !clientSecret || !ruName) return null;
  return { environment, clientId, clientSecret, ruName };
}

/**
 * Why an eBay call failed, as a closed set.
 *
 *   rejected     — eBay refused the grant: the code or refresh token is bad,
 *                  expired, revoked, or its scopes no longer fit. The user has
 *                  to consent again; retrying cannot help.
 *   client       — eBay refused OUR app credentials (invalid_client). A
 *                  configuration fault, not the user's.
 *   unavailable  — eBay answered 5xx/429, an unexpected 4xx, or not at all
 *                  (network error, timeout).
 *   malformed    — eBay answered 200 with a body we cannot use.
 */
export type EbayOAuthErrorKind = "rejected" | "client" | "unavailable" | "malformed";

export class EbayOAuthError extends Error {
  readonly kind: EbayOAuthErrorKind;
  /** eBay's HTTP status, when there was one. */
  readonly upstreamStatus?: number;
  /** eBay's OAuth `error` code, only when it is in KNOWN_OAUTH_ERRORS. */
  readonly oauthError?: string;

  constructor(
    kind: EbayOAuthErrorKind,
    opts: { upstreamStatus?: number; oauthError?: string } = {},
  ) {
    // Fixed text only: see the module header.
    super(`eBay OAuth ${kind}`);
    this.name = "EbayOAuthError";
    this.kind = kind;
    this.upstreamStatus = opts.upstreamStatus;
    this.oauthError = opts.oauthError;
  }
}

/**
 * The RFC 6749 error codes, which are the only ones eBay's token endpoint
 * documents. Anything else is reported as absent rather than echoed, so an
 * eBay body can never put arbitrary text into our logs.
 */
const KNOWN_OAUTH_ERRORS = new Set([
  "invalid_request",
  "invalid_client",
  "invalid_grant",
  "unauthorized_client",
  "unsupported_grant_type",
  "invalid_scope",
  "access_denied",
  "server_error",
  "temporarily_unavailable",
]);

/**
 * Codes that mean "this grant is dead; the user must consent again". A
 * refresh token past its ~18 months, a revoked consent, a used or expired
 * authorization code, and a scope set the consent no longer covers all land
 * here.
 */
const REJECTED_GRANT_ERRORS = new Set([
  "invalid_grant",
  "invalid_scope",
  "access_denied",
  "unauthorized_client",
]);

/** The parts of a token response the routes use. */
export interface EbayTokenResult {
  accessToken: string;
  /** Epoch ms. */
  expiresAt: number;
  /** Present on the code grant; eBay's refresh grant does not return one. */
  refreshToken?: string;
  /** Epoch ms. Present only alongside `refreshToken`. */
  refreshExpiresAt?: number;
}

export interface EbayOAuthDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

function basicAuth(config: EbayOAuthConfig): string {
  return `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`;
}

/**
 * POST to eBay with a deadline. A network error or timeout becomes
 * `unavailable`; the underlying error is dropped, never re-thrown, because
 * undici attaches the request it failed on to `cause`.
 */
async function ebayFetch(
  url: string,
  init: RequestInit,
  deps: EbayOAuthDeps,
): Promise<Response> {
  const doFetch = deps.fetchImpl ?? fetch;
  try {
    return await doFetch(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(deps.timeoutMs ?? EBAY_REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new EbayOAuthError("unavailable");
  }
}

async function readJson(res: Response): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await res.json();
    return typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Positive finite seconds → epoch ms, else undefined. */
function expiryFrom(now: number, seconds: unknown): number | undefined {
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0
    ? now + Math.floor(seconds * 1000)
    : undefined;
}

/**
 * Run one grant against eBay's token endpoint.
 *
 * Status mapping: 200 → parse; 400/401 with a grant-rejection code →
 * `rejected`; `invalid_client` → `client`; everything else non-200 →
 * `unavailable`.
 */
async function tokenGrant(
  config: EbayOAuthConfig,
  form: URLSearchParams,
  deps: EbayOAuthDeps,
): Promise<EbayTokenResult> {
  const now = (deps.now ?? Date.now)();
  const res = await ebayFetch(
    `${EBAY_HOSTS[config.environment].api}${TOKEN_PATH}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: basicAuth(config),
        Accept: "application/json",
      },
      body: form.toString(),
    },
    deps,
  );

  const body = await readJson(res);
  if (!res.ok) {
    const raw = typeof body?.error === "string" ? body.error : undefined;
    const oauthError = raw && KNOWN_OAUTH_ERRORS.has(raw) ? raw : undefined;
    const opts = { upstreamStatus: res.status, oauthError };
    if (oauthError === "invalid_client") throw new EbayOAuthError("client", opts);
    if ((res.status === 400 || res.status === 401) && oauthError && REJECTED_GRANT_ERRORS.has(oauthError)) {
      throw new EbayOAuthError("rejected", opts);
    }
    throw new EbayOAuthError("unavailable", opts);
  }

  const accessToken = body?.access_token;
  const expiresAt = expiryFrom(now, body?.expires_in);
  if (typeof accessToken !== "string" || accessToken.length === 0 || expiresAt === undefined) {
    throw new EbayOAuthError("malformed", { upstreamStatus: res.status });
  }
  const result: EbayTokenResult = { accessToken, expiresAt };
  if (typeof body?.refresh_token === "string" && body.refresh_token.length > 0) {
    result.refreshToken = body.refresh_token;
    const refreshExpiresAt = expiryFrom(now, body.refresh_token_expires_in);
    if (refreshExpiresAt !== undefined) result.refreshExpiresAt = refreshExpiresAt;
  }
  return result;
}

/**
 * Authorization-code grant. `code` is the value eBay put on the callback
 * URL, already URL-decoded (as `URLSearchParams.get` returns it); this
 * function form-encodes it again for the request body.
 *
 * The result always carries a refresh token: a code grant without one would
 * leave a session that dies in two hours with no way to renew, so it is
 * treated as `malformed` rather than stored.
 */
export async function exchangeAuthorizationCode(
  config: EbayOAuthConfig,
  code: string,
  deps: EbayOAuthDeps = {},
): Promise<EbayTokenResult & { refreshToken: string }> {
  const result = await tokenGrant(
    config,
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: config.ruName,
    }),
    deps,
  );
  if (!result.refreshToken) throw new EbayOAuthError("malformed", { upstreamStatus: 200 });
  return result as EbayTokenResult & { refreshToken: string };
}

/**
 * Refresh-token grant. eBay does not rotate the refresh token here, so the
 * result normally has no `refreshToken`; if eBay ever starts returning one,
 * the caller stores it.
 */
export async function refreshAccessToken(
  config: EbayOAuthConfig,
  refreshToken: string,
  deps: EbayOAuthDeps = {},
): Promise<EbayTokenResult> {
  return tokenGrant(
    config,
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      scope: EBAY_SCOPES.join(" "),
    }),
    deps,
  );
}

/** The seller's identity as eBay reports it. */
export interface EbayIdentity {
  /** Immutable. What seller-conflict and account-deletion key on. */
  userId: string;
  /** The seller's current eBay username; they can change it. */
  username: string;
}

/** A bounded, non-blank string, trimmed; else undefined. */
function identityField(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_USERNAME_LENGTH ? trimmed : undefined;
}

/**
 * The signed-in seller's eBay identity, from Commerce Identity `getUser`.
 * eBay documents both `userId` and `username` as always present; a response
 * missing either is `malformed`.
 *
 * A 401/403 here means the token we were just handed cannot read identity
 * (the consent lacked `commerce.identity.readonly`), which is a consent
 * problem: `rejected`. In the sandbox eBay answers with mock profile data,
 * which is still well-formed.
 */
export async function fetchEbayIdentity(
  config: EbayOAuthConfig,
  accessToken: string,
  deps: EbayOAuthDeps = {},
): Promise<EbayIdentity> {
  const res = await ebayFetch(
    `${EBAY_HOSTS[config.environment].apiz}${IDENTITY_USER_PATH}`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    },
    deps,
  );
  if (res.status === 401 || res.status === 403) {
    throw new EbayOAuthError("rejected", { upstreamStatus: res.status });
  }
  if (!res.ok) throw new EbayOAuthError("unavailable", { upstreamStatus: res.status });
  const body = await readJson(res);
  const userId = identityField(body?.userId);
  const username = identityField(body?.username);
  if (!userId || !username) {
    throw new EbayOAuthError("malformed", { upstreamStatus: res.status });
  }
  return { userId, username };
}
