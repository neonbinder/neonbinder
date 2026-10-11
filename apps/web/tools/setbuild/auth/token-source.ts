/**
 * NEO-339 — the one seam between "how do we get a Clerk session JWT" and
 * everything that talks to Convex.
 *
 * Two implementations sit behind it (`machine-token-source.ts`,
 * `testing-token-source.ts`). Both end in the same thing: an ordinary Clerk
 * session token minted from the `convex` JWT template, which
 * `convex/auth.config.ts` validates exactly as it validates a browser's. The
 * tool never invents an identity of its own.
 *
 * Secrets rule for this directory: no token, ticket, API key or shared secret
 * ever appears in a thrown message, a log line or `describe()`. Errors carry a
 * stage, an HTTP status and Clerk's error CODE; anything echoed from upstream
 * goes through `redact()` first.
 */

export interface TokenSource {
  /**
   * A Clerk session JWT for the `convex` template. Cached until it is within
   * the refresh skew of `exp`; `forceRefresh` mints a new one regardless (the
   * Convex client asks for that when the server rejects a token).
   */
  getToken(opts?: { forceRefresh?: boolean }): Promise<string>;
  /** A human description with every secret left out. */
  describe(): string;
}

/** Refresh when the cached token has less than this left. */
export const REFRESH_SKEW_MS = 20_000;

/**
 * An auth failure with enough structure to act on and nothing secret in it.
 * `stage` names the hop that failed; `status` is the upstream HTTP status when
 * there was one; `code` is Clerk's machine-readable error code when it sent one.
 */
export class SetbuildAuthError extends Error {
  readonly stage: string;
  readonly status: number | undefined;
  readonly code: string | undefined;

  constructor(
    stage: string,
    message: string,
    opts: { status?: number; code?: string } = {},
  ) {
    super(message);
    this.name = "SetbuildAuthError";
    this.stage = stage;
    this.status = opts.status;
    this.code = opts.code;
  }
}

/**
 * Replace every occurrence of each non-trivial secret with `[redacted]`.
 * Secrets shorter than 6 characters are ignored: redacting "a" from a message
 * would mangle it without protecting anything.
 */
export function redact(text: string, secrets: Iterable<string | undefined | null>): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret || secret.length < 6) continue;
    out = out.split(secret).join("[redacted]");
  }
  return out;
}

export interface JwtClaims {
  sub?: string;
  exp?: number;
  iat?: number;
  iss?: string;
  aud?: string | string[];
  [claim: string]: unknown;
}

/**
 * Read a JWT's payload WITHOUT verifying it. The tool only uses this for its
 * own bookkeeping (when to refresh, what to print); Convex is the verifier.
 */
export function decodeJwtClaims(jwt: string): JwtClaims {
  const parts = jwt.split(".");
  if (parts.length !== 3 || !parts[1]) {
    throw new SetbuildAuthError("jwt_unparseable", "The token Clerk returned is not a JWT.");
  }
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const json = new TextDecoder().decode(
      Uint8Array.from(atob(padded), (c) => c.charCodeAt(0)),
    );
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("payload is not an object");
    }
    return parsed as JwtClaims;
  } catch {
    throw new SetbuildAuthError("jwt_unparseable", "The token Clerk returned has an unreadable payload.");
  }
}

/** True when `aud` names `audience` (string or array form). */
export function audienceIncludes(claims: JwtClaims, audience: string): boolean {
  return Array.isArray(claims.aud) ? claims.aud.includes(audience) : claims.aud === audience;
}

/** True when the token has more than `skewMs` left before `exp`. */
export function tokenIsFresh(claims: JwtClaims, nowMs: number, skewMs = REFRESH_SKEW_MS): boolean {
  return typeof claims.exp === "number" && claims.exp * 1000 - nowMs > skewMs;
}

export type MintReason = "initial" | "expiring" | "forced";

/**
 * Wrap a `mint` function with exp-based caching and single-flight: concurrent
 * callers share one in-flight mint instead of each starting a sign-in chain.
 */
export function cachingTokenSource(o: {
  mint: (reason: MintReason) => Promise<string>;
  describe: () => string;
  now?: () => number;
  skewMs?: number;
}): TokenSource {
  const now = o.now ?? Date.now;
  const skew = o.skewMs ?? REFRESH_SKEW_MS;
  let cached: { token: string; claims: JwtClaims } | undefined;
  let inFlight: Promise<string> | undefined;

  return {
    describe: o.describe,
    async getToken(opts = {}) {
      if (!opts.forceRefresh && cached && tokenIsFresh(cached.claims, now(), skew)) {
        return cached.token;
      }
      if (inFlight) return inFlight;
      const reason: MintReason = opts.forceRefresh ? "forced" : cached ? "expiring" : "initial";
      inFlight = (async () => {
        try {
          const token = await o.mint(reason);
          cached = { token, claims: decodeJwtClaims(token) };
          return token;
        } finally {
          inFlight = undefined;
        }
      })();
      return inFlight;
    },
  };
}

/** Default `fetch`, read at call time so a test's stub (or the guard) is honoured. */
export function defaultFetch(): typeof fetch {
  return (input, init) => globalThis.fetch(input, init);
}

export function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Statuses worth one more try: rate limiting and upstream unavailability. */
export const TRANSIENT_STATUSES: ReadonlySet<number> = new Set([429, 502, 503, 504]);

/** The host of a URL for `describe()`, never its path or query. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "<invalid url>";
  }
}
