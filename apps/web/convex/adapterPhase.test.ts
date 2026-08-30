/**
 * NEO-198 — `adapter_phase` breadcrumbs: attributing a child the aggregator
 * threw away.
 *
 * `fetchAggregatedOptions` races each child action against a hard deadline. A
 * deadline that wins gets NO return value, so the aggregator never sees the
 * child's `token_ms` / `filters_call_ms` and genuinely cannot say whether the
 * budget went into resolving a session token (the credential path — 15s browser
 * fetches and a 4 × 60s `loginWithRetry`, which NEO-198 deliberately does not
 * bound) or into the marketplace fetch. The old timeout message asserted the
 * latter and was guessing.
 *
 * The only thing that can answer it is a signal the child publishes BEFORE it
 * can hang. That is `recordAdapterPhase`, and the property these tests exist to
 * pin is not "an event is emitted" but "it is emitted, synchronously, on the
 * far side of the token and the near side of the fetch" — a breadcrumb that
 * lands after the hang would tell us nothing.
 *
 * Harness (FakePostHog + loopback browser URL + /health stub) is the one from
 * credentials.instrumentation.test.ts.
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { __resetContractCache } from "./credentials";
import { api } from "./_generated/api";
import { recordAdapterPhase } from "./observability";
import type { ActionCtx } from "./_generated/server";

const captureCalls: Array<{
  distinctId: string;
  event: string;
  properties: Record<string, unknown>;
}> = [];

vi.mock("posthog-node", () => {
  class FakePostHog {
    capture(args: {
      distinctId: string;
      event: string;
      properties: Record<string, unknown>;
    }) {
      captureCalls.push(args);
    }
    async shutdown() {
      // no-op
    }
  }
  return { PostHog: FakePostHog };
});

const modules = (
  import.meta as unknown as {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("./**/*.*s");

const ADMIN = {
  subject: "admin_user_neo198_001",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_user_neo198_001",
  name: "Admin User",
  role: "admin",
};

type FetchStub = (
  url: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function stubFetch(handler: FetchStub) {
  vi.stubGlobal("fetch", (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    if (String(url).endsWith("/health")) {
      return jsonResponse({
        status: "ok",
        environment: "test",
        contractVersion: 1,
      });
    }
    return handler(url, init);
  }) as FetchStub);
}

/** A SportLots newinven.tpl body that parses to one sport option. */
const SL_SPORT_HTML = `<html><body><form>
  <select name="sprt"><Option value="BB">Baseball</Option></select>
</form></body></html>`;

/** Console lines this suite cares about, in emission order. */
let consoleLines: string[] = [];

beforeEach(() => {
  captureCalls.length = 0;
  consoleLines = [];
  process.env.POSTHOG_API_KEY = "test-posthog-key";
  // Loopback → getIdTokenClient short-circuits, so no GCP creds are needed.
  process.env.NEONBINDER_BROWSER_URL = "http://localhost:9999";
  __resetContractCache();
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    consoleLines.push(args.map(String).join(" "));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.POSTHOG_API_KEY;
  delete process.env.NEONBINDER_BROWSER_URL;
});

/** The parsed `adapter_phase` console records emitted so far. */
function phaseLines(): Array<Record<string, unknown>> {
  return consoleLines
    .filter((l) => l.includes('"msg":"adapter_phase"'))
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// recordAdapterPhase itself
// ---------------------------------------------------------------------------

describe("recordAdapterPhase", () => {
  /** Minimal ActionCtx: the helper only touches ctx.auth and ctx.runAction. */
  function fakeCtx(runAction: (...a: unknown[]) => Promise<unknown>) {
    return {
      auth: { getUserIdentity: async () => ({ subject: "user_1" }) },
      runAction,
    } as unknown as ActionCtx;
  }

  test("writes its console record SYNCHRONOUSLY, before the caller yields", () => {
    // This is the whole point. The breadcrumb has to be on disk before the
    // child enters the operation that may never return; if it were awaited
    // behind the PostHog round trip it could be lost to exactly the hang it
    // exists to explain.
    const ctx = fakeCtx(async () => null);
    recordAdapterPhase(ctx, {
      requestId: "req-sync",
      operation: "fetchSportLotsSelectorOptions",
      platform: "sportlots",
      level: "sport",
      phase: "token_ready",
      elapsed_ms: 42,
    });

    // No await between the call and this assertion.
    expect(phaseLines()).toHaveLength(1);
    expect(phaseLines()[0]).toMatchObject({
      msg: "adapter_phase",
      requestId: "req-sync",
      phase: "token_ready",
      platform: "sportlots",
      elapsed_ms: 42,
    });
  });

  test("returns void — the caller must not be able to block on PostHog", () => {
    // posthog.captureEvent's client.shutdown() carries no timeout. Awaiting one
    // inside a bounded budget would add another unbounded nested wait, which is
    // the class of bug this ticket is about.
    const ctx = fakeCtx(async () => null);
    const returned = recordAdapterPhase(ctx, {
      requestId: "req-void",
      operation: "fetchBscSelectorOptions",
      platform: "bsc",
      phase: "token_ready",
      elapsed_ms: 1,
    });
    expect(returned).toBeUndefined();
  });

  test("a hanging PostHog capture does not delay or break the caller", async () => {
    let released: (() => void) | undefined;
    const ctx = fakeCtx(
      () => new Promise<null>((resolve) => (released = () => resolve(null))),
    );

    recordAdapterPhase(ctx, {
      requestId: "req-hang",
      operation: "fetchSportLotsSelectorOptions",
      platform: "sportlots",
      phase: "token_ready",
      elapsed_ms: 7,
    });

    // The breadcrumb is already recorded even though the capture is still
    // in flight, and nothing threw.
    expect(phaseLines()).toHaveLength(1);
    released?.();
  });

  test("a rejecting PostHog capture is swallowed, never surfaced", async () => {
    const ctx = fakeCtx(async () => {
      throw new Error("posthog down");
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() =>
      recordAdapterPhase(ctx, {
        requestId: "req-reject",
        operation: "fetchBscSelectorOptions",
        platform: "bsc",
        phase: "token_ready",
        elapsed_ms: 3,
      }),
    ).not.toThrow();

    await vi.waitFor(() => expect(errSpy).toHaveBeenCalled());
  });

  test("the payload carries no credential- or PII-shaped keys", () => {
    const ctx = fakeCtx(async () => null);
    recordAdapterPhase(ctx, {
      requestId: "req-pii",
      operation: "fetchSportLotsSelectorOptions",
      platform: "sportlots",
      level: "year",
      phase: "token_ready",
      elapsed_ms: 11,
    });
    const keys = Object.keys(phaseLines()[0]);
    for (const banned of [
      "email",
      "password",
      "token",
      "cookie",
      "bearer",
      "sellerId",
      "username",
      "credential",
    ]) {
      expect(keys).not.toContain(banned);
    }
  });
});

// ---------------------------------------------------------------------------
// End-to-end: the SportLots adapter actually drops the breadcrumb, and drops it
// on the correct side of the marketplace fetch.
// ---------------------------------------------------------------------------

describe("fetchSportLotsSelectorOptions phase attribution", () => {
  test("emits token_ready AFTER the token resolves and BEFORE the marketplace fetch", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN);

    /** phaseLines() snapshot taken at the instant SL's newinven POST is made. */
    let phasesAtFetchTime: Array<Record<string, unknown>> | undefined;
    /** phaseLines() snapshot taken at the instant the token is handed over. */
    let phasesAtTokenTime: Array<Record<string, unknown>> | undefined;

    stubFetch(async (url) => {
      const href = String(url);
      if (href.includes("/credentials/") && href.endsWith("/token")) {
        // The child is still INSIDE getSiteToken here — nothing should have
        // been published yet, because nothing has succeeded yet.
        phasesAtTokenTime = phaseLines();
        return jsonResponse({
          token: "SLSESSION=stub",
          expiresAt: Date.now() + 24 * 60 * 60 * 1000,
        });
      }
      if (href.includes("newinven.tpl")) {
        phasesAtFetchTime = phaseLines();
        return new Response(SL_SPORT_HTML, {
          status: 200,
          headers: { "Content-Type": "text/html" },
        });
      }
      throw new Error(`unexpected fetch: ${href}`);
    });

    const result = await asAdmin.action(
      api.adapters.sportlots.fetchSportLotsSelectorOptions,
      { level: "sport", parentFilters: {}, requestId: "req-neo198-sl" },
    );

    expect(result.success).toBe(true);
    expect(result.options).toEqual([{ value: "Baseball", platformValue: "BB" }]);

    // Ordering is the assertion. Before the token: nothing. Before the fetch:
    // exactly the token_ready breadcrumb. A breadcrumb emitted anywhere else
    // cannot explain a hang, because a hang means the child never gets further.
    expect(phasesAtTokenTime).toEqual([]);
    expect(phasesAtFetchTime).toHaveLength(1);
    expect(phasesAtFetchTime![0]).toMatchObject({
      msg: "adapter_phase",
      requestId: "req-neo198-sl",
      operation: "fetchSportLotsSelectorOptions",
      platform: "sportlots",
      level: "sport",
      phase: "token_ready",
    });
    expect(typeof phasesAtFetchTime![0].elapsed_ms).toBe("number");
  });

  test("the breadcrumb reaches PostHog under its own event name, not adapter_sync_call", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN);

    stubFetch(async (url) => {
      const href = String(url);
      if (href.includes("/credentials/") && href.endsWith("/token")) {
        return jsonResponse({
          token: "SLSESSION=stub",
          expiresAt: Date.now() + 24 * 60 * 60 * 1000,
        });
      }
      if (href.includes("newinven.tpl")) {
        return new Response(SL_SPORT_HTML, {
          status: 200,
          headers: { "Content-Type": "text/html" },
        });
      }
      throw new Error(`unexpected fetch: ${href}`);
    });

    await asAdmin.action(api.adapters.sportlots.fetchSportLotsSelectorOptions, {
      level: "sport",
      parentFilters: {},
      requestId: "req-neo198-sl-ph",
    });

    await vi.waitFor(() => {
      expect(captureCalls.filter((c) => c.event === "adapter_phase")).toHaveLength(1);
    });

    const phase = captureCalls.find((c) => c.event === "adapter_phase")!;
    expect(phase.properties).toMatchObject({
      requestId: "req-neo198-sl-ph",
      operation: "fetchSportLotsSelectorOptions",
      platform: "sportlots",
      phase: "token_ready",
    });

    // A breadcrumb is not a call outcome. Folding it into adapter_sync_call
    // would inflate the dashboard's success counts with records that describe
    // nothing having finished.
    const syncCalls = captureCalls.filter((c) => c.event === "adapter_sync_call");
    expect(syncCalls.every((c) => c.properties.phase === undefined)).toBe(true);
    // It shares the aggregator's correlation id — that join is the whole
    // mechanism by which a fired deadline becomes attributable.
    expect(
      syncCalls.every((c) => c.properties.requestId === "req-neo198-sl-ph"),
    ).toBe(true);
  });

  test("no breadcrumb when the token never resolves — absence is the auth-stall signal", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN);

    stubFetch(async (url) => {
      const href = String(url);
      if (href.includes("/credentials/") && href.endsWith("/token")) {
        // Positively-identified absence: no secret, no token, no re-auth.
        return jsonResponse({ error: "Credentials not found" }, 404);
      }
      throw new Error(`unexpected fetch: ${href}`);
    });

    const result = await asAdmin.action(
      api.adapters.sportlots.fetchSportLotsSelectorOptions,
      { level: "sport", parentFilters: {}, requestId: "req-neo198-sl-noauth" },
    );

    expect(result.success).toBe(false);
    // Nothing was published, which is exactly what a reader should conclude
    // "the child never got past auth" from when a deadline fires.
    expect(phaseLines()).toEqual([]);
  });
});
