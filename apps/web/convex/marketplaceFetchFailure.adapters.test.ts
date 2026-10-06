/**
 * NEO-321 follow-up — the REAL checklist adapters report why they failed.
 *
 * `fetchBscChecklist` and `fetchSportLotsChecklist` now return a structured
 * `failure` beside `success: false` (kind, HTTP status, our timer, the
 * SportLots page), and log a `marketplace_limiter` line when one of OUR
 * limits fires (the 30s abort timers, the BSC re-auth wait). These tests stub
 * `fetch` (the `fetchBscChecklist.fanOut` / `sportlots.test` pattern) so the
 * adapters' own code paths run.
 *
 * Lives at the convex/ ROOT for the import.meta.glob reason in
 * `sportlots.test.ts`.
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN = {
  subject: "admin_fetch_failure",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_fetch_failure",
  role: "admin",
};

const SECRET_BSC_TOKEN = "bsc-secret-token-value-0123456789abcdef";
const SECRET_SL_COOKIE = "PHPSESSID=sl-secret-cookie-value";

const credState = vi.hoisted(() => ({
  hasToken: true,
  reauthSucceeds: true,
}));

/** The credentials layer is not under test — hand the adapters a session. */
vi.mock("./credentials", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./credentials")>();
  const { internalAction } = await import("./_generated/server");
  const { v } = await import("convex/values");
  return {
    ...actual,
    getSiteToken: internalAction({
      args: { site: v.string() },
      returns: v.any(),
      handler: async (_ctx, args) =>
        credState.hasToken
          ? {
              token:
                args.site === "sportlots"
                  ? "PHPSESSID=sl-secret-cookie-value"
                  : "bsc-secret-token-value-0123456789abcdef",
            }
          : null,
    }),
    authenticateBsc: internalAction({
      args: {},
      returns: v.any(),
      handler: async () =>
        credState.reauthSucceeds
          ? { success: true }
          : { success: false, message: "login failed" },
    }),
    authenticateSportlots: internalAction({
      args: {},
      returns: v.any(),
      handler: async () => ({ success: true }),
    }),
  };
});

const SCOPE = {
  sport: ["baseball"],
  year: ["2024"],
  setName: ["topps-chrome"],
  variant: ["parallel"],
  variantName: ["gold-refractor"],
};

function timeoutError(): Error {
  // What `AbortSignal.timeout` rejects fetch with.
  return new DOMException("The operation was aborted due to timeout", "TimeoutError");
}

type LogLine = Record<string, unknown> & { msg: string };
let lines: LogLine[] = [];
let raw: string[] = [];

beforeEach(() => {
  credState.hasToken = true;
  credState.reauthSucceeds = true;
  lines = [];
  raw = [];
  const capture = (...args: unknown[]) => {
    const text = args.map((a) => (a instanceof Error ? a.message : String(a))).join(" ");
    raw.push(text);
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
});

const limiterLines = (limiter: string) =>
  lines.filter((l) => l.msg === "marketplace_limiter" && l.limiter === limiter);

function noSecretsLogged() {
  for (const line of raw) {
    expect(line).not.toContain(SECRET_BSC_TOKEN);
    expect(line).not.toContain("sl-secret-cookie-value");
  }
}

async function bsc() {
  const t = convexTest(schema, modules);
  return t.withIdentity(ADMIN).action(api.adapters.buysportscards.fetchBscChecklist, {
    parentFilters: {},
    facetFilters: SCOPE,
    sourceFacet: "variantName",
  });
}

describe("fetchBscChecklist — a structured failure per class", () => {
  test("our 30s timer fires: timeout, and a limiter line with the wait", async () => {
    vi.stubGlobal("fetch", (async () => {
      throw timeoutError();
    }) as unknown as typeof fetch);

    const result = await bsc();

    expect(result.success).toBe(false);
    expect(result.failure).toEqual({
      kind: "timeout",
      timedOut: true,
      timeoutMs: 30_000,
      requests: 1,
      requestsOk: 0,
    });
    const fired = limiterLines("bsc_checklist_timeout");
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({
      platform: "bsc",
      operation: "fetchBscChecklist",
      timeoutMs: 30_000,
      outcome: "aborted",
      retry: false,
    });
    expect(typeof fired[0].waitedMs).toBe("number");
    noSecretsLogged();
  });

  test("a network throw is network, not a timeout", async () => {
    vi.stubGlobal("fetch", (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch);

    const result = await bsc();

    expect(result.failure).toMatchObject({ kind: "network", timedOut: false });
    expect(limiterLines("bsc_checklist_timeout")).toHaveLength(0);
  });

  test("a non-2xx answer carries its status", async () => {
    vi.stubGlobal("fetch", (async () => new Response("busy", { status: 503 })) as unknown as typeof fetch);

    const result = await bsc();

    expect(result.failure).toMatchObject({ kind: "http_error", httpStatus: 503, timedOut: false });
    expect(result.message).toContain("BSC API error: 503");
  });

  test("a 401 the re-auth cannot fix: signed out, re-auth attempted, and the wait logged", async () => {
    credState.reauthSucceeds = false;
    vi.stubGlobal("fetch", (async () => new Response("no", { status: 401 })) as unknown as typeof fetch);

    const result = await bsc();

    expect(result.failure).toMatchObject({
      kind: "signed_out",
      httpStatus: 401,
      reauthAttempted: true,
    });
    expect(limiterLines("bsc_token_reauth")[0]).toMatchObject({ outcome: "reauth_failed" });
    noSecretsLogged();
  });

  test("a 401 after a re-auth that worked is still signed out", async () => {
    vi.stubGlobal("fetch", (async () => new Response("no", { status: 401 })) as unknown as typeof fetch);

    const result = await bsc();

    expect(result.failure).toMatchObject({
      kind: "signed_out",
      httpStatus: 401,
      reauthAttempted: true,
    });
    expect(limiterLines("bsc_token_reauth")[0]).toMatchObject({ outcome: "ok" });
  });

  test("no token at all: no_sign_in, nothing sent", async () => {
    credState.hasToken = false;
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy as unknown as typeof fetch);

    const result = await bsc();

    expect(result.failure).toEqual({ kind: "no_sign_in", timedOut: false });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("a 200 whose body is not JSON is bad_response", async () => {
    vi.stubGlobal("fetch", (async () => new Response("<html>oops</html>", { status: 200 })) as unknown as typeof fetch);

    const result = await bsc();

    expect(result.failure).toMatchObject({ kind: "bad_response", httpStatus: 200 });
  });

  test("success reports its pages and slowest request", async () => {
    vi.stubGlobal("fetch", (async () =>
      new Response(JSON.stringify([{ id: "c1", cardNo: "1", players: "Someone", setName: "topps-chrome" }]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch);

    const result = await bsc();

    expect(result.success).toBe(true);
    expect(result.pages).toBe(1);
    expect(typeof result.slowestPageMs).toBe("number");
    expect(result.failure).toBeUndefined();
  });
});

function listcardsHtml(from: number, count: number): string {
  let rows = "";
  for (let i = 0; i < count; i++) {
    const n = from + i;
    rows += `<td class="smallleft">${n}</td><td class="smallleft">Player ${n}</td>`;
  }
  return `<html><table>${rows}</table></html>`;
}

/** Serves SportLots pages by `start`; `failAt` answers that page with `fail`. */
function slPages(opts: {
  failAt?: number;
  fail?: () => Promise<Response>;
  pages: Record<number, string>;
}): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const start = Number(new URLSearchParams(String(init?.body ?? "")).get("start") ?? "1");
    if (opts.failAt === start && opts.fail) return opts.fail();
    return new Response(opts.pages[start] ?? listcardsHtml(0, 0), {
      status: 200,
      headers: { "Content-Type": "text/html" },
    });
  }) as unknown as typeof fetch;
}

async function sl() {
  const t = convexTest(schema, modules);
  return t.withIdentity(ADMIN).action(api.adapters.sportlots.fetchSportLotsChecklist, {
    parentFilters: {},
    platformFilters: { parallel: "309098" },
  });
}

describe("fetchSportLotsChecklist — which page failed, and why", () => {
  test("our 30s timer on page two: timeout at start=101 after one good page", async () => {
    vi.stubGlobal(
      "fetch",
      slPages({
        pages: { 1: listcardsHtml(1, 88) },
        failAt: 101,
        fail: async () => {
          throw timeoutError();
        },
      }),
    );

    const result = await sl();

    expect(result.success).toBe(false);
    expect(result.failure).toEqual({
      kind: "timeout",
      timedOut: true,
      timeoutMs: 30_000,
      pageStart: 101,
      pagesOk: 1,
    });
    const fired = limiterLines("sl_fetch_timeout");
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({
      platform: "sportlots",
      operation: "listcards",
      timeoutMs: 30_000,
      outcome: "aborted",
    });
    // The limiter line names the page, never the URL.
    expect(JSON.stringify(fired[0])).not.toContain("sportlots.com");
    noSecretsLogged();
  });

  test("a non-OK page carries its status and position", async () => {
    vi.stubGlobal(
      "fetch",
      slPages({
        pages: { 1: listcardsHtml(1, 88), 101: listcardsHtml(89, 92) },
        failAt: 201,
        fail: async () => new Response("bad gateway", { status: 502 }),
      }),
    );

    const result = await sl();

    expect(result.failure).toEqual({
      kind: "http_error",
      httpStatus: 502,
      timedOut: false,
      pageStart: 201,
      pagesOk: 2,
    });
  });

  test("the sign-in page served back: signed out on page one", async () => {
    vi.stubGlobal(
      "fetch",
      slPages({
        pages: {},
        failAt: 1,
        fail: async () => new Response(`<a href="/login.tpl">sign in</a>`, { status: 200 }),
      }),
    );

    const result = await sl();

    expect(result.failure).toMatchObject({
      kind: "signed_out",
      pageStart: 1,
      pagesOk: 0,
    });
  });

  test("a network throw mid-walk is network, with its page", async () => {
    vi.stubGlobal(
      "fetch",
      slPages({
        pages: { 1: listcardsHtml(1, 88) },
        failAt: 101,
        fail: async () => {
          throw new TypeError("fetch failed");
        },
      }),
    );

    const result = await sl();

    expect(result.failure).toEqual({
      kind: "network",
      timedOut: false,
      pageStart: 101,
      pagesOk: 1,
    });
    expect(limiterLines("sl_fetch_timeout")).toHaveLength(0);
  });

  test("no cookie: no_sign_in", async () => {
    credState.hasToken = false;
    const result = await sl();
    expect(result.failure).toEqual({ kind: "no_sign_in", timedOut: false });
  });

  test("success reports the pages read (the empty end page included)", async () => {
    vi.stubGlobal(
      "fetch",
      slPages({ pages: { 1: listcardsHtml(1, 88), 101: listcardsHtml(89, 12) } }),
    );

    const result = await sl();

    expect(result.success).toBe(true);
    expect(result.cards).toHaveLength(100);
    expect(result.pages).toBe(3);
    expect(typeof result.slowestPageMs).toBe("number");
  });
});
