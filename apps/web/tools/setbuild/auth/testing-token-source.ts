/**
 * NEO-339 — a token source built on the E2E testing endpoint.
 *
 * The chain, the same one `app/testing/sign-in/page.tsx` runs in a browser:
 *
 *   1. `POST {appUrl}/api/auth/testing` (header `x-testing-auth`, plus
 *      `x-vercel-protection-bypass` on a protected preview), body
 *      `{ account, worker }` → `{ signInToken, testingToken }`.
 *   2. Redeem `signInToken` as a ticket at Clerk's Frontend API (with the
 *      dev-browser retry) → session id + native client JWT.
 *   3. Mint the `convex` template JWT for that session.
 *
 * The session is kept and re-minted from until Clerk refuses it (401/403/404
 * from the mint), at which point the whole chain re-runs with a fresh ticket.
 * Transient failures (429/5xx/unreachable) re-run it too. At most
 * `maxChainAttempts` (3) per `getToken()`.
 *
 * Only works where the testing endpoint does: local Vite (dev middleware) and
 * Vercel preview/development deployments. Production 404s it by design, and
 * this source refuses production by construction too:
 *
 * - a `pk_live_` publishable key (a production Clerk instance) is refused
 *   before any call;
 * - every minted token's `iss` must be the FAPI host the `pk_test_` key
 *   encodes, so a token from any other Clerk instance is never used;
 * - the app URL must be https (plain http only on loopback), and the Vercel
 *   bypass secret is sent only to an https origin.
 */

import { isLocalHost } from "../client/target";
import {
  CONVEX_JWT_TEMPLATE,
  fapiOriginFromPublishableKey,
  isTransient,
  mintTemplateToken,
  redeemTicket,
  type FapiContext,
  type FapiSession,
} from "./clerk-fapi";
import {
  SetbuildAuthError,
  TRANSIENT_STATUSES,
  audienceIncludes,
  cachingTokenSource,
  decodeJwtClaims,
  defaultFetch,
  defaultSleep,
  hostOf,
  redact,
  type TokenSource,
} from "./token-source";

export interface TestingTokenSourceOptions {
  /** Origin of the SPA serving `/api/auth/testing` (local Vite or a preview). */
  appUrl: string;
  /** `TESTING_ENDPOINT_SECRET`. */
  testingSecret: string;
  /** `VERCEL_AUTOMATION_BYPASS_SECRET`, for a protected preview. */
  bypassSecret?: string;
  /** Per-worker test account index (`TEST_EMAIL_<worker>`). */
  worker: number;
  account?: "main";
  /** `VITE_CLERK_PUBLISHABLE_KEY`; the FAPI origin is derived from it. */
  publishableKey: string;
  fetchFn?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  maxChainAttempts?: number;
  template?: string;
}

/** Backoff before chain attempt 2, 3, … (ms). */
const CHAIN_BACKOFF_MS = [500, 1500, 3000];

/** The host of a JWT `iss` claim, or undefined when it is missing or not a URL. */
function issuerHost(iss: unknown): string | undefined {
  if (typeof iss !== "string") return undefined;
  try {
    return new URL(iss).host;
  } catch {
    return undefined;
  }
}

/** Mint statuses that mean "this session/client is no longer good". */
const SESSION_GONE = new Set([401, 403, 404]);

export function testingTokenSource(o: TestingTokenSourceOptions): TokenSource {
  if (!Number.isInteger(o.worker) || o.worker < 0 || o.worker > 31) {
    throw new SetbuildAuthError("config", "--worker must be an integer from 0 to 31.");
  }
  if (!o.testingSecret) {
    throw new SetbuildAuthError("config", "TESTING_ENDPOINT_SECRET is not set.");
  }
  const appUrl = (() => {
    try {
      return new URL(o.appUrl);
    } catch {
      throw new SetbuildAuthError("config", "The app URL is not a URL.");
    }
  })();
  if (appUrl.protocol !== "https:" && !(appUrl.protocol === "http:" && isLocalHost(appUrl.hostname))) {
    throw new SetbuildAuthError(
      "config",
      "The app URL must be https:// (plain http is allowed only for localhost): the testing secret is sent to it.",
    );
  }
  const appOrigin = appUrl.origin;
  // The Vercel bypass secret only ever means something to a Vercel deployment,
  // which is https; it is never sent in the clear.
  const sendBypass = !!o.bypassSecret && appUrl.protocol === "https:";
  if (/^\s*pk_live_/.test(o.publishableKey)) {
    throw new SetbuildAuthError(
      "config",
      "--auth testing refuses a production Clerk instance (pk_live_ publishable key). " +
        "Testing sign-in is for previews and local runs; production uses --auth machine.",
    );
  }
  const fapiOrigin = fapiOriginFromPublishableKey(o.publishableKey);
  const fapiHost = new URL(fapiOrigin).host;
  const fetchFn = o.fetchFn ?? defaultFetch();
  const sleep = o.sleep ?? defaultSleep;
  const maxAttempts = o.maxChainAttempts ?? 3;
  const template = o.template ?? CONVEX_JWT_TEMPLATE;
  const account = o.account ?? "main";
  const fixedSecrets = [o.testingSecret, o.bypassSecret];
  // Every secret this source has handled, for the final scrub of any error it
  // throws: the endpoint secret, the bypass secret, and each ticket, testing
  // token, client JWT and dev-browser JWT the chain has seen.
  const seen = new Set<string>(fixedSecrets.filter((s): s is string => !!s));
  const remember = (...values: Array<string | undefined>) => {
    for (const v of values) if (v) seen.add(v);
  };
  const scrub = (err: unknown): unknown =>
    err instanceof SetbuildAuthError
      ? new SetbuildAuthError(err.stage, redact(err.message, seen), {
          status: err.status,
          code: err.code,
        })
      : err instanceof Error
        ? new Error(redact(err.message, seen))
        : err;

  let session: (FapiSession & { testingToken?: string }) | undefined;

  async function requestTicket(): Promise<{ signInToken: string; testingToken?: string }> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-testing-auth": o.testingSecret,
    };
    if (sendBypass) headers["x-vercel-protection-bypass"] = o.bypassSecret!;
    let res: Response;
    try {
      res = await fetchFn(`${appOrigin}/api/auth/testing`, {
        method: "POST",
        headers,
        body: JSON.stringify({ account, worker: o.worker }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new SetbuildAuthError(
        "testing_endpoint_unreachable",
        `${appOrigin}/api/auth/testing did not answer (${err instanceof Error ? err.name : "fetch failed"}).`,
      );
    }
    const text = await res.text();
    let body: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = JSON.parse(text);
      body = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
    } catch {
      body = null;
    }
    if (!res.ok) {
      const said = typeof body?.error === "string" ? redact(body.error, fixedSecrets).slice(0, 200) : "";
      const hint =
        res.status === 401
          ? " TESTING_ENDPOINT_SECRET does not match the app's."
          : res.status === 404
            ? " The testing endpoint is disabled here (production, or CLERK_TESTING_ENABLED is not true)."
            : "";
      throw new SetbuildAuthError(
        "testing_endpoint",
        `${appOrigin}/api/auth/testing refused (HTTP ${res.status}${said ? `: ${said}` : ""}).${hint}`,
        { status: res.status },
      );
    }
    const signInToken = body?.signInToken;
    if (typeof signInToken !== "string" || signInToken.length === 0) {
      throw new SetbuildAuthError(
        "testing_endpoint_unparseable",
        `${appOrigin}/api/auth/testing answered without a sign-in token.`,
        { status: res.status },
      );
    }
    const testingToken = typeof body?.testingToken === "string" ? body.testingToken : undefined;
    return { signInToken, ...(testingToken ? { testingToken } : {}) };
  }

  function fapi(testingToken: string | undefined): FapiContext {
    return { origin: fapiOrigin, fetchFn, ...(testingToken ? { testingToken } : {}) };
  }

  async function mintOnce(): Promise<string> {
    if (!session) {
      const { signInToken, testingToken } = await requestTicket();
      remember(signInToken, testingToken);
      const redeemed = await redeemTicket(fapi(testingToken), signInToken);
      remember(redeemed.clientJwt, redeemed.devBrowserJwt);
      session = { ...redeemed, ...(testingToken ? { testingToken } : {}) };
    }
    const jwt = await mintTemplateToken(fapi(session.testingToken), session, template);
    remember(session.clientJwt);
    const claims = decodeJwtClaims(jwt);
    if (issuerHost(claims.iss) !== fapiHost) {
      throw new SetbuildAuthError(
        "jwt_issuer",
        `The "${template}" token was not issued by ${fapiHost}, the Clerk instance the publishable key names; refusing it.`,
      );
    }
    if (!audienceIncludes(claims, "convex")) {
      throw new SetbuildAuthError(
        "jwt_audience",
        `The "${template}" template's token is not for audience "convex"; Convex will reject it.`,
      );
    }
    return jwt;
  }

  async function mint(): Promise<string> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (attempt > 1) {
        await sleep(CHAIN_BACKOFF_MS[Math.min(attempt - 2, CHAIN_BACKOFF_MS.length - 1)]);
      }
      try {
        return await mintOnce();
      } catch (err) {
        lastErr = err;
        const sessionGone =
          err instanceof SetbuildAuthError &&
          err.stage === "fapi_mint" &&
          err.status !== undefined &&
          SESSION_GONE.has(err.status);
        const endpointTransient =
          err instanceof SetbuildAuthError &&
          err.stage.startsWith("testing_endpoint") &&
          (err.status === undefined || TRANSIENT_STATUSES.has(err.status));
        if (sessionGone || isTransient(err) || endpointTransient) {
          // A refused or half-built session is never reused: the next attempt
          // starts again from a fresh ticket.
          if (sessionGone || (err instanceof SetbuildAuthError && err.stage.startsWith("fapi_sign_in"))) {
            session = undefined;
          }
          continue;
        }
        throw scrub(err);
      }
    }
    if (lastErr instanceof SetbuildAuthError) {
      throw scrub(
        new SetbuildAuthError(
          lastErr.stage,
          `${lastErr.message} Gave up after ${maxAttempts} attempts.`,
          { status: lastErr.status, code: lastErr.code },
        ),
      );
    }
    throw scrub(lastErr);
  }

  return cachingTokenSource({
    mint,
    now: o.now,
    describe: () =>
      `testing sign-in via ${hostOf(appOrigin)}/api/auth/testing (account ${account}, worker ${o.worker}) → Clerk ${hostOf(fapiOrigin)} template "${template}"`,
  });
}
