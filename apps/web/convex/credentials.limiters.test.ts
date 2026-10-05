/**
 * NEO-321 follow-up — every self-imposed limiter on the token path logs a
 * `marketplace_limiter` line when it fires, and none of those lines carries
 * the user id, the credential key, the browser-service URL or a token.
 *
 * The token path is where a checklist fetch gets its BSC token / SportLots
 * cookie (`getSiteToken`). Before this, a refusal here (the browser service's
 * own 60-a-minute limiter, a busy credential lock, the NEO-278 re-auth
 * backoff, our 15s/10s timers) reached the fetch only as "no token", and the
 * build said "didn't answer".
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import { __resetContractCache } from "./credentials";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const USER_A = "user_limiter_aaaa1111";
const SITE = "buysportscards";
const BROWSER_URL = "http://localhost:9999";
const SECRET_TOKEN = "tok-secret-0123456789abcdef";

type FetchStub = (url: string, init?: RequestInit) => Promise<Response>;

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

/** What express-rate-limit (standardHeaders: true) answers past its budget. */
function rateLimited(): Response {
  return jsonResponse({ error: "Too many requests" }, 429, {
    "RateLimit-Limit": "60",
    "RateLimit-Remaining": "0",
    "RateLimit-Reset": "37",
    "Retry-After": "37",
  });
}

function timeoutError(): Error {
  return new DOMException("The operation was aborted due to timeout", "TimeoutError");
}

/** `/health` answers healthy unless `health` is given; the rest go to `handler`. */
function stubFetch(handler: FetchStub, health?: () => Promise<Response>) {
  vi.stubGlobal("fetch", (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/health")) {
      return health ? health() : jsonResponse({ status: "ok", contractVersion: 1 });
    }
    return handler(u, init);
  }) as unknown as typeof fetch);
}

type LogLine = Record<string, unknown> & { msg: string };
let lines: LogLine[] = [];

beforeEach(() => {
  process.env.NEONBINDER_BROWSER_URL = BROWSER_URL;
  __resetContractCache();
  lines = [];
  const capture = (...args: unknown[]) => {
    const text = args.map(String).join(" ");
    try {
      const parsed = JSON.parse(text) as LogLine;
      if (parsed && typeof parsed.msg === "string") lines.push(parsed);
    } catch {
      // not a JSON line
    }
  };
  vi.spyOn(console, "log").mockImplementation(capture);
  vi.spyOn(console, "warn").mockImplementation(capture);
  vi.spyOn(console, "error").mockImplementation(capture);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.NEONBINDER_BROWSER_URL;
});

const limiter = (name: string) =>
  lines.filter((l) => l.msg === "marketplace_limiter" && l.limiter === name);

/** No limiter or token-failure line names the user, the key, the host or a token. */
function noIdentifiersLogged() {
  const logged = lines
    .filter((l) => l.msg === "marketplace_limiter" || l.msg.startsWith("site_token"))
    .map((l) => JSON.stringify(l));
  expect(logged.length).toBeGreaterThan(0);
  for (const text of logged) {
    expect(text).not.toContain(USER_A);
    expect(text).not.toContain(`${SITE}-credentials-`);
    expect(text).not.toContain("localhost:9999");
    expect(text).not.toContain(SECRET_TOKEN);
  }
}

async function getToken(t: ReturnType<typeof convexTest>) {
  return t
    .withIdentity({ subject: USER_A })
    .action(internal.credentials.getSiteToken, { site: SITE });
}

describe("the browser service's own rate limit (60/min per key, /health per IP)", () => {
  test("a 429 on the token read and on the login is logged with the limiter's headers", async () => {
    const t = convexTest(schema, modules);
    stubFetch(async (url) => {
      if (url.includes("/token")) return rateLimited();
      if (url.includes("/login/bsc")) return rateLimited();
      throw new Error(`unexpected fetch: ${url}`);
    });

    const token = await getToken(t);

    expect(token).toBeNull();
    const fired = limiter("browser_service_rate_limit");
    const tokenRead = fired.find((l) => l.route === "/credentials/:key/token");
    expect(tokenRead).toMatchObject({
      platform: SITE,
      operation: "readCachedToken",
      outcome: "rejected_429",
      limit: 60,
      remaining: 0,
      resetSec: 37,
      retryAfterSec: 37,
    });
    expect(fired.find((l) => l.route === "/login")).toMatchObject({
      outcome: "rejected_429",
    });
    noIdentifiersLogged();
  });

  test("a 429 on /health fails the token read; both the limit and the reason are logged", async () => {
    const t = convexTest(schema, modules);
    stubFetch(
      async (url) => {
        throw new Error(`unexpected fetch: ${url}`);
      },
      async () => rateLimited(),
    );

    const token = await getToken(t);

    expect(token).toBeNull();
    expect(limiter("browser_service_rate_limit")[0]).toMatchObject({
      route: "/health",
      outcome: "rejected_429",
    });
    const failed = lines.find((l) => l.msg === "site_token_failed");
    expect(failed).toMatchObject({ site: SITE, errorClass: "rate_limited" });
    noIdentifiersLogged();
  });
});

describe("our own timers on the token path", () => {
  test("the 15s browser-fetch timer: a limiter line, and the token failure says timeout", async () => {
    const t = convexTest(schema, modules);
    stubFetch(async (url) => {
      if (url.includes("/token")) throw timeoutError();
      throw new Error(`unexpected fetch: ${url}`);
    });

    const token = await getToken(t);

    expect(token).toBeNull();
    expect(limiter("browser_fetch_timeout")[0]).toMatchObject({
      route: "/credentials/:key/token",
      timeoutMs: 15_000,
      outcome: "aborted",
    });
    expect(lines.find((l) => l.msg === "site_token_failed")).toMatchObject({
      errorClass: "timeout",
    });
    noIdentifiersLogged();
  });

  test("the 10s /health timer", async () => {
    const t = convexTest(schema, modules);
    stubFetch(
      async (url) => {
        throw new Error(`unexpected fetch: ${url}`);
      },
      async () => {
        throw timeoutError();
      },
    );

    expect(await getToken(t)).toBeNull();
    expect(limiter("browser_health_timeout")[0]).toMatchObject({
      route: "/health",
      timeoutMs: 10_000,
      outcome: "aborted",
    });
  });
});

describe("the credential lock and the re-auth backoff", () => {
  test("a live lock turns the refresh away: busy, with who holds it", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("userProfiles", {
        userId: USER_A,
        siteCredentials: [
          {
            site: SITE,
            hasCredentials: true,
            lockedAt: Date.now(),
            lockedOp: "store",
            lockToken: "tok-held",
          },
        ],
      });
    });
    // 204: secret exists, nothing cached → the mint path → refresh → lock.
    stubFetch(async (url) => {
      if (url.includes("/token")) return new Response(null, { status: 204 });
      throw new Error(`unexpected fetch: ${url}`);
    });

    expect(await getToken(t)).toBeNull();
    expect(limiter("credential_lock")[0]).toMatchObject({
      platform: SITE,
      operation: "test",
      outcome: "busy",
      heldBy: "store",
    });
    noIdentifiersLogged();
  });

  test("a refresh that takes the lock logs how long it held it", async () => {
    const t = convexTest(schema, modules);
    let tokenReads = 0;
    stubFetch(async (url) => {
      if (url.includes("/token")) {
        tokenReads++;
        return tokenReads === 1
          ? new Response(null, { status: 204 })
          : jsonResponse({ token: SECRET_TOKEN, expiresAt: Date.now() + 3_600_000 });
      }
      if (url.includes("/login/bsc")) return jsonResponse({ success: true });
      throw new Error(`unexpected fetch: ${url}`);
    });

    const token = await getToken(t);

    expect(token?.token).toBe(SECRET_TOKEN);
    const released = limiter("credential_lock").find((l) => l.outcome === "released");
    expect(released).toMatchObject({ platform: SITE, operation: "test" });
    expect(typeof released?.heldMs).toBe("number");
    noIdentifiersLogged();
  });

  test("the NEO-278 backoff skips the refresh: logged with how long until it retries", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("userProfiles", {
        userId: USER_A,
        siteCredentials: [
          {
            site: SITE,
            hasCredentials: true,
            needsReauth: true,
            needsReauthSince: Date.now() - 60_000,
            reauthObservedAt: Date.now() - 60_000,
          },
        ],
      });
    });
    stubFetch(async (url) => {
      if (url.includes("/token")) {
        return jsonResponse({ token: SECRET_TOKEN, expiresAt: Date.now() - 60_000 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const token = await getToken(t);

    expect(token?.token).toBe(SECRET_TOKEN);
    const fired = limiter("reauth_backoff")[0];
    expect(fired).toMatchObject({ platform: SITE, outcome: "refresh_skipped" });
    expect(fired.sinceMs as number).toBeGreaterThanOrEqual(60_000);
    expect(fired.retryAfterMs as number).toBeLessThanOrEqual(14 * 60_000);
    noIdentifiersLogged();
  });
});
