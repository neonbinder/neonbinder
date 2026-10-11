/**
 * NEO-339 — a token source built on the NEO-172 machine-token exchange.
 *
 * `POST {convexSite}/machine/token` with `{ key, sessionId? }` returns
 * `{ token, sessionId }`: an ordinary `convex` template JWT for the user the
 * Clerk API key belongs to (see convex/machineAuth.ts for the trust model). The
 * session id is cached and presented on every refresh so the endpoint reuses
 * the session rather than creating one per exchange.
 *
 * Status contract of that endpoint: 401 is the key (never retried), 502/503
 * are upstream (retried with backoff). The key never appears in an error.
 */

import {
  SetbuildAuthError,
  TRANSIENT_STATUSES,
  cachingTokenSource,
  defaultFetch,
  defaultSleep,
  hostOf,
  type TokenSource,
} from "./token-source";

export interface MachineTokenSourceOptions {
  /** `https://<deployment>.convex.site` — the HTTP-actions origin. */
  convexSite: string;
  /** `NB_SETBUILD_API_KEY`: a Clerk API key scoped to an admin user. */
  apiKey: string;
  fetchFn?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
}

const BACKOFF_MS = [500, 1500, 3000];
const SESSION_ID_RE = /^sess_[A-Za-z0-9]{1,64}$/;

export function machineTokenSource(o: MachineTokenSourceOptions): TokenSource {
  if (!o.apiKey) {
    throw new SetbuildAuthError("config", "NB_SETBUILD_API_KEY is not set.");
  }
  const site = (() => {
    try {
      return new URL(o.convexSite).origin;
    } catch {
      throw new SetbuildAuthError("config", "The Convex site URL is not a URL.");
    }
  })();
  const fetchFn = o.fetchFn ?? defaultFetch();
  const sleep = o.sleep ?? defaultSleep;
  const maxAttempts = o.maxAttempts ?? 3;
  let sessionId: string | undefined;

  async function exchangeOnce(): Promise<string> {
    let res: Response;
    try {
      res = await fetchFn(`${site}/machine/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(sessionId ? { key: o.apiKey, sessionId } : { key: o.apiKey }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new SetbuildAuthError(
        "machine_token_unreachable",
        `${hostOf(site)}/machine/token did not answer (${err instanceof Error ? err.name : "fetch failed"}).`,
      );
    }
    let body: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = JSON.parse(await res.text());
      body = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
    } catch {
      body = null;
    }
    if (res.status === 401) {
      throw new SetbuildAuthError(
        "machine_key_refused",
        "The machine-token endpoint refused NB_SETBUILD_API_KEY (unknown, revoked, or not scoped to a user).",
        { status: 401 },
      );
    }
    if (!res.ok) {
      throw new SetbuildAuthError(
        "machine_token",
        `${hostOf(site)}/machine/token failed (HTTP ${res.status}).`,
        { status: res.status },
      );
    }
    const token = body?.token;
    if (typeof token !== "string" || token.length === 0) {
      throw new SetbuildAuthError(
        "machine_token_unparseable",
        `${hostOf(site)}/machine/token answered without a token.`,
        { status: res.status },
      );
    }
    const returnedSession = body?.sessionId;
    sessionId =
      typeof returnedSession === "string" && SESSION_ID_RE.test(returnedSession)
        ? returnedSession
        : undefined;
    return token;
  }

  async function mint(): Promise<string> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (attempt > 1) await sleep(BACKOFF_MS[Math.min(attempt - 2, BACKOFF_MS.length - 1)]);
      try {
        return await exchangeOnce();
      } catch (err) {
        lastErr = err;
        const transient =
          err instanceof SetbuildAuthError &&
          (err.stage === "machine_token_unreachable" ||
            (err.status !== undefined && TRANSIENT_STATUSES.has(err.status)));
        if (!transient) throw err;
      }
    }
    throw lastErr;
  }

  return cachingTokenSource({
    mint,
    now: o.now,
    describe: () => `machine API key via ${hostOf(site)}/machine/token`,
  });
}
