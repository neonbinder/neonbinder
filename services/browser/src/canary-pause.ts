import { GoogleAuth } from "google-auth-library";
import {
  logBrowserOp,
  logCanaryPauseLookupFailed,
  type CanaryPauseLookupFailedLine,
  type CanaryPauseLookupFailureReason,
} from "./observability";

/**
 * NEO-355: let an operator pause the prod login canary for one marketplace
 * from the Convex flag NEONBINDER_PAUSED_PLATFORMS, with no deploy and no
 * Terraform apply.
 *
 * Before a canary request (Cloud Scheduler, `{key, canary: true}`) signs in,
 * the route asks Convex `GET /internal/marketplace-pause` which platforms are
 * paused. When this platform is paused the route answers 200 without a
 * sign-in and logs a heartbeat line with `outcome: "skipped_paused"`.
 *
 * THE INVARIANT: FAIL OPEN. Every failure of the lookup (no token, Convex
 * down, slow, a non-200, a body we cannot read) means "not paused": the
 * canary signs in for real, exactly as it did before this module existed. A
 * broken lookup can therefore never silence the canary; the worst it can do
 * is page for a platform an operator meant to pause. `shouldSkipCanary`
 * returns true ONLY when Convex answered 200 with a `paused` array naming
 * this platform's site key.
 *
 * Non-canary traffic (every request Convex sends on a user's behalf) never
 * consults the flag: `canaryGate` returns before any lookup. Convex already
 * refuses to call a paused platform on a user's behalf; this module is only
 * about the synthetic probe.
 *
 * Auth: this service's runtime service account mints a Google OIDC id token
 * from the metadata server, audience = the Convex site origin, and Convex
 * verifies it against an allowlist. No shared secret. The token is sent in
 * one Authorization header and is never logged, returned, or put in an error.
 *
 * Configuration: NEONBINDER_CONVEX_SITE_URL, set only on the prod deploy.
 * Unset (dev, PR previews, local) means the gate is off: no token is minted,
 * no request is made, and no line is logged.
 *
 * Pure apart from its injected dependencies, so tests/canary-pause.test.mjs
 * can drive every branch without a network or a metadata server. Kept out of
 * index.ts because that file calls app.listen() at import time.
 */

/**
 * Browser-service platform slug → the site key Convex uses in
 * NEONBINDER_PAUSED_PLATFORMS and in the endpoint's `paused` array. Read by
 * id-like slug only, never by a display name.
 */
export const PLATFORM_TO_SITE = Object.freeze({
  bsc: "buysportscards",
  sportlots: "sportlots",
} as const);

export type CanaryPlatform = keyof typeof PLATFORM_TO_SITE;

/**
 * Overall budget for one lookup, token mint and HTTP round trip together.
 * When it passes the canary proceeds with a real sign-in.
 */
export const CANARY_PAUSE_LOOKUP_TIMEOUT_MS = 5000;

/** The Convex HTTP action this module calls (apps/web/convex/http.ts). */
export const CANARY_PAUSE_PATH = "/internal/marketplace-pause";

/** Env var naming the Convex site URL. Unset = gate off. */
export const CONVEX_SITE_URL_ENV = "NEONBINDER_CONVEX_SITE_URL";

export interface CanaryPauseDeps {
  /** HTTP client. Default: global fetch. */
  fetch?: typeof fetch;
  /**
   * Mint a Google OIDC id token for `audience`. Default: the metadata server
   * via google-auth-library. Must resolve to the bare token (no "Bearer ").
   */
  mintIdToken?: (audience: string) => Promise<string>;
  /**
   * Convex site URL. Default: process.env.NEONBINDER_CONVEX_SITE_URL, read at
   * call time. `undefined` falls back to the env var; an empty or blank
   * string means "not configured" (gate off).
   */
  siteUrl?: string;
  /** Failure-line writer. Default: logCanaryPauseLookupFailed (stdout JSON). */
  log?: (line: CanaryPauseLookupFailedLine) => void;
  /** Lookup budget in ms. Default: CANARY_PAUSE_LOOKUP_TIMEOUT_MS. */
  timeoutMs?: number;
}

let googleAuth: GoogleAuth | undefined;

/**
 * Default token minter. On Cloud Run this resolves to the Compute client,
 * which asks the metadata server for `identity?format=full&audience=…`, so
 * the token carries the `email` claim Convex's allowlist checks.
 */
async function mintIdTokenFromMetadata(audience: string): Promise<string> {
  googleAuth ??= new GoogleAuth();
  const client = await googleAuth.getIdTokenClient(audience);
  return client.idTokenProvider.fetchIdToken(audience);
}

/** Either the site keys Convex reported as paused, or why we could not tell. */
type LookupResult = { pausedSites: string[] } | { failure: CanaryPauseLookupFailureReason };

/**
 * Ask Convex whether `platform` is paused. Resolves true only on a definite
 * "paused"; false on "not paused", on "not configured", and on every failure.
 * Never throws, never rejects.
 */
export async function shouldSkipCanary(
  platform: CanaryPlatform,
  deps: CanaryPauseDeps = {},
): Promise<boolean> {
  const log = deps.log ?? logCanaryPauseLookupFailed;
  const fail = (reason: CanaryPauseLookupFailureReason): false => {
    try {
      log({ msg: "canary_pause_lookup_failed", platform, reason });
    } catch {
      // A broken logger must not turn fail-open into a crash.
    }
    return false;
  };

  try {
    const site: string | undefined = PLATFORM_TO_SITE[platform];
    if (!site) return false;

    const rawSiteUrl = (deps.siteUrl ?? process.env[CONVEX_SITE_URL_ENV] ?? "").trim();
    // Not configured: dev, previews, local. Silent by design.
    if (!rawSiteUrl) return false;

    let origin: string;
    try {
      const parsed = new URL(rawSiteUrl);
      // Never send an id token over plain HTTP.
      if (parsed.protocol !== "https:") return fail("bad_site_url");
      // The audience must equal Convex's CONVEX_SITE_URL, which is a bare
      // origin; a trailing slash or stray path would be an aud mismatch.
      origin = parsed.origin;
    } catch {
      return fail("bad_site_url");
    }

    const result = await lookupWithDeadline(origin, deps);
    if ("failure" in result) return fail(result.failure);
    // Exact match on the site key: the one way to answer "skip".
    return result.pausedSites.includes(site);
  } catch {
    // Unreachable by construction; fail open anyway, silently, because there
    // is no reason in the closed set that would be true.
    return false;
  }
}

async function lookupWithDeadline(origin: string, deps: CanaryPauseDeps): Promise<LookupResult> {
  const fetchImpl = deps.fetch ?? fetch;
  const mint = deps.mintIdToken ?? mintIdTokenFromMetadata;
  const timeoutMs = deps.timeoutMs ?? CANARY_PAUSE_LOOKUP_TIMEOUT_MS;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const deadline = new Promise<LookupResult>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ failure: "timeout" });
    }, timeoutMs);
    // Deliberately NOT unref()'d: when the lookup itself is the only pending
    // work (a hung fetch under node --test), an unref'd timer lets the
    // process exit before the deadline resolves. The finally below always
    // clears it, so it never outlives the lookup.
  });

  try {
    return await Promise.race([lookup(origin, fetchImpl, mint, controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

async function lookup(
  origin: string,
  fetchImpl: typeof fetch,
  mint: (audience: string) => Promise<string>,
  signal: AbortSignal,
): Promise<LookupResult> {
  let token: string;
  try {
    token = await mint(origin);
  } catch {
    return { failure: "token_mint_failed" };
  }
  if (typeof token !== "string" || token.length === 0) {
    return { failure: "token_mint_failed" };
  }

  let res: Response;
  try {
    res = await fetchImpl(`${origin}${CANARY_PAUSE_PATH}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      // Never forward the bearer token to wherever a redirect points; a 3xx
      // surfaces as http_3xx instead.
      redirect: "manual",
      signal,
    });
  } catch (err) {
    // Aborted (our deadline, or an AbortError/TimeoutError from the client)
    // is a timeout; any other rejection is a network failure. Only the error's
    // NAME is inspected, never its message, which is not logged.
    const name = err instanceof Error ? err.name : undefined;
    const aborted = signal.aborted || name === "AbortError" || name === "TimeoutError";
    return { failure: aborted ? "timeout" : "network_error" };
  }

  if (res.status !== 200) {
    try {
      await res.body?.cancel();
    } catch {
      // Freeing the socket is best effort.
    }
    return { failure: `http_${res.status}` };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return signal.aborted ? { failure: "timeout" } : { failure: "bad_body" };
  }
  if (
    typeof body !== "object" ||
    body === null ||
    !Array.isArray((body as { paused?: unknown }).paused)
  ) {
    return { failure: "bad_body" };
  }
  const pausedSites = (body as { paused: unknown[] }).paused.filter(
    (s): s is string => typeof s === "string",
  );
  return { pausedSites };
}

export type CanaryGateDecision = "proceed" | "skip_paused";

export interface CanaryGateDeps extends CanaryPauseDeps {
  /** The lookup to run. Default: shouldSkipCanary. Injectable so a test can
   * prove a non-canary request never reaches it. */
  shouldSkipCanary?: (platform: CanaryPlatform, deps?: CanaryPauseDeps) => Promise<boolean>;
}

/**
 * The route-level gate. Non-canary requests (`canary !== true`) return
 * "proceed" without calling the lookup at all: user traffic never waits on,
 * or depends on, this flag. A canary request returns "skip_paused" only on a
 * definite "paused" answer; every other outcome is "proceed". Never rejects.
 */
export async function canaryGate(
  input: { canary: boolean; platform: CanaryPlatform },
  deps: CanaryGateDeps = {},
): Promise<CanaryGateDecision> {
  if (input.canary !== true) return "proceed";
  const { shouldSkipCanary: lookup = shouldSkipCanary, ...lookupDeps } = deps;
  try {
    return (await lookup(input.platform, lookupDeps)) === true ? "skip_paused" : "proceed";
  } catch {
    return "proceed";
  }
}

/**
 * How each platform names itself in the paused-skip message. Copy only: it is
 * keyed by the platform slug and read by no logic.
 */
const PLATFORM_LABEL: Readonly<Record<CanaryPlatform, string>> = Object.freeze({
  bsc: "BSC",
  sportlots: "SportLots",
});

/** The 200 body a paused canary gets instead of a sign-in. */
export interface CanaryPausedBody {
  success: true;
  skipped: "paused";
  message: string;
}

/** The slice of an Express Response this helper writes to. */
export interface CanaryPausedResponder {
  json(body: CanaryPausedBody): unknown;
}

export interface RespondIfCanaryPausedDeps {
  /** The gate to consult. Default: canaryGate. */
  gate?: (
    input: { canary: boolean; platform: CanaryPlatform },
    deps?: CanaryGateDeps,
  ) => Promise<CanaryGateDecision>;
  /** Deps forwarded to the gate (the lookup and its injectables). */
  gateDeps?: CanaryGateDeps;
  /** Login-line writer. Default: logBrowserOp. */
  log?: typeof logBrowserOp;
  /** Clock for duration_ms. Default: Date.now. */
  now?: () => number;
}

/**
 * The /login/<site> routes' canary pause check, in one place. Call it after
 * the key and transient-credential checks and BEFORE the adapter is
 * constructed, so a skipped run launches nothing and needs no cleanup:
 *
 *   if (await respondIfCanaryPaused({ canary, platform: "bsc", startMs }, res)) return;
 *
 * Resolves true when it has answered the request: the gate said
 * "skip_paused", so it wrote one browser_login_call heartbeat line
 * (success true, status 200, outcome "skipped_paused"; see `outcome` on
 * logBrowserOp) and sent `{success: true, skipped: "paused", message}`.
 * Resolves false, having sent and logged nothing, on every other path: a
 * non-canary request (the gate is not even consulted, so user traffic never
 * waits on the flag) and every "proceed" (fail-open, see shouldSkipCanary).
 */
export async function respondIfCanaryPaused(
  input: { canary: boolean; platform: CanaryPlatform; startMs: number },
  res: CanaryPausedResponder,
  deps: RespondIfCanaryPausedDeps = {},
): Promise<boolean> {
  const { canary, platform, startMs } = input;
  if (canary !== true) return false;
  const gate = deps.gate ?? canaryGate;
  if ((await gate({ canary, platform }, deps.gateDeps)) !== "skip_paused") return false;

  const log = deps.log ?? logBrowserOp;
  const now = deps.now ?? Date.now;
  log({
    msg: "browser_login_call",
    operation: `login_${platform}`,
    platform,
    duration_ms: now() - startMs,
    // A heartbeat, not a failure: see `outcome` on logBrowserOp.
    success: true,
    status_code: 200,
    canary,
    outcome: "skipped_paused",
  });
  res.json({
    success: true,
    skipped: "paused",
    message: `${PLATFORM_LABEL[platform]} is paused (NEONBINDER_PAUSED_PLATFORMS); canary sign-in skipped`,
  });
  return true;
}
