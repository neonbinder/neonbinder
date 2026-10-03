/**
 * Unit tests for the adapter-perf instrumentation helpers.
 *
 * Coverage:
 *  - classifyAdapterError maps common error strings to stable tags
 *  - newRequestId returns a syntactically-valid UUID string and is unique
 *  - recordAdapterCall fires `adapter_sync_call` via PostHog with the
 *    full property bag forwarded verbatim. Since NEO-315 the capture is
 *    SCHEDULED (`runAfter(0)`), so a test that asserts on it drains the
 *    scheduler first — the event lands after the action returns, by design
 *  - recordAdapterCall never throws when auth context is unavailable
 *  - recordAdapterCall never throws when PostHog capture itself fails
 *  - fetchBscSelectorOptions records an adapter_sync_call event tagged
 *    success=false / error_class="no_credentials" when no token is
 *    available (the most common failure mode and the one we most want
 *    to dashboard on).
 *
 * Why we mock `posthog-node` directly: convex-test doesn't expose a way
 * to stub `internal.posthog.captureEvent` itself, but the captureEvent
 * action only side-effects through a `new PostHog(...).capture(...)`
 * call. Mocking the constructor lets us assert the exact payload that
 * reaches PostHog.
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { internal, api } from "./_generated/api";
import { drainScheduled } from "../lib/testing/drain-scheduled";
import {
  classifyAdapterError,
  newRequestId,
  recordAdapterCall,
} from "./observability";
import type { ActionCtx } from "./_generated/server";

// ---------------------------------------------------------------------------
// PostHog client mock — captures every `.capture()` call so tests can assert
// that the adapter pipeline emits adapter_sync_call events with the right
// shape.
// ---------------------------------------------------------------------------

const captureCalls: Array<{ distinctId: string; event: string; properties: Record<string, unknown> }> = [];

vi.mock("posthog-node", () => {
  class FakePostHog {
    capture(args: { distinctId: string; event: string; properties: Record<string, unknown> }) {
      captureCalls.push(args);
    }
    async shutdown() {
      // no-op
    }
  }
  return { PostHog: FakePostHog };
});

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN_IDENTITY = {
  subject: "admin_user_obs_001",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_user_obs_001",
  name: "Admin User",
  role: "admin",
};

beforeEach(() => {
  captureCalls.length = 0;
  // PostHog client short-circuits when no key is set. Force a value so the
  // mocked client actually gets invoked.
  process.env.POSTHOG_API_KEY = "test-posthog-key";
  // NEO-188: the BSC token path pings the browser service (localhost:8080).
  // Unstubbed, "no token is available" was really "nothing is listening on
  // 8080" — so the test passed for an environmental reason and would have
  // changed meaning on a machine running the browser service locally. Stub it
  // to a hard failure so the no-token condition is the thing under test.
  vi.stubGlobal(
    "fetch",
    (async () => {
      throw new Error("NEO-188: browser service unavailable (stubbed)");
    }) as unknown as typeof fetch,
  );
});

afterEach(() => {
  delete process.env.POSTHOG_API_KEY;
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// classifyAdapterError
// ---------------------------------------------------------------------------

describe("classifyAdapterError", () => {
  test("returns undefined for empty input", () => {
    expect(classifyAdapterError(undefined)).toBeUndefined();
    expect(classifyAdapterError("")).toBeUndefined();
  });

  test("maps timeouts to 'timeout'", () => {
    expect(classifyAdapterError("BSC API request timed out after 30s")).toBe("timeout");
    expect(classifyAdapterError("network timeout")).toBe("timeout");
  });

  test("maps auth failures to 'auth'", () => {
    expect(classifyAdapterError("HTTP 401")).toBe("auth");
    expect(classifyAdapterError("Unauthorized")).toBe("auth");
  });

  test("maps missing-credential errors to 'no_credentials'", () => {
    // "No BSC token available" matches the more specific no_credentials
    // bucket before the generic auth bucket — that's intentional, the
    // dashboard distinguishes between user-never-connected and
    // session-actually-expired so we can drive different fixups.
    expect(classifyAdapterError("No BSC token available")).toBe("no_credentials");
    expect(classifyAdapterError("No SportLots session cookie")).toBe("no_credentials");
  });

  test("maps rate limit responses to 'rate_limited'", () => {
    expect(classifyAdapterError("BSC API error: 429")).toBe("rate_limited");
    expect(classifyAdapterError("rate limit exceeded")).toBe("rate_limited");
  });

  test("maps session expiry to 'session_expired'", () => {
    expect(classifyAdapterError("SportLots session expired. Re-authenticate.")).toBe(
      "session_expired",
    );
  });

  test("falls back to 'other' for unrecognized errors", () => {
    expect(classifyAdapterError("Something weird happened")).toBe("other");
  });
});

// ---------------------------------------------------------------------------
// newRequestId
// ---------------------------------------------------------------------------

describe("newRequestId", () => {
  test("returns a UUID-shaped string", () => {
    const id = newRequestId();
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  test("returns a unique id each call", () => {
    const a = newRequestId();
    const b = newRequestId();
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// recordAdapterCall — via the captureEvent action, which is the only public
// entry point. We invoke it directly to confirm our helper composes
// correctly with the existing PostHog action.
// ---------------------------------------------------------------------------

describe("posthog.captureEvent (indirectly: recordAdapterCall)", () => {
  test("forwards the full property bag verbatim to PostHog", async () => {
    const t = convexTest(schema, modules);
    await t.action(internal.posthog.captureEvent, {
      distinctId: "user_abc",
      event: "adapter_sync_call",
      properties: {
        requestId: "req-1",
        operation: "fetchBscSelectorOptions",
        platform: "bsc",
        level: "year",
        parentSport: "Baseball",
        duration_ms: 1234,
        success: true,
        token_ms: 50,
        filters_call_ms: 1100,
        status_code: 200,
        result_count: 42,
      },
    });

    expect(captureCalls).toHaveLength(1);
    expect(captureCalls[0].distinctId).toBe("user_abc");
    expect(captureCalls[0].event).toBe("adapter_sync_call");
    expect(captureCalls[0].properties).toMatchObject({
      requestId: "req-1",
      operation: "fetchBscSelectorOptions",
      platform: "bsc",
      level: "year",
      parentSport: "Baseball",
      duration_ms: 1234,
      success: true,
      result_count: 42,
    });
  });

  test("never logs PII fields like credentials, tokens, or emails", async () => {
    const t = convexTest(schema, modules);
    await t.action(internal.posthog.captureEvent, {
      distinctId: "user_xyz",
      event: "adapter_sync_call",
      properties: {
        requestId: "req-2",
        operation: "getBscToken",
        platform: "bsc",
        duration_ms: 12,
        success: true,
      },
    });

    const props = captureCalls[0].properties;
    // Defense in depth: confirm we don't accidentally introduce fields named
    // like common PII/credential leaks. If any of these ever appear in the
    // payload it should fail this test and force a code review.
    for (const banned of [
      "email",
      "password",
      "token",
      "bearer",
      "sellerId",
      "username",
      "credential",
    ]) {
      expect(Object.keys(props)).not.toContain(banned);
    }
  });
});

// ---------------------------------------------------------------------------
// End-to-end: fetchBscSelectorOptions fires adapter_sync_call on the
// no-credentials path. This is the cheapest end-to-end check that the
// instrumentation is wired through the adapter — we don't have BSC
// credentials in the test env so the call should fail fast and emit a
// single event tagged error_class="no_credentials".
// ---------------------------------------------------------------------------

describe("fetchBscSelectorOptions instrumentation", () => {
  test("emits adapter_sync_call with success=false when no BSC token is available", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const result = await asAdmin.action(
      api.adapters.buysportscards.fetchBscSelectorOptions,
      {
        level: "sport",
        parentFilters: {},
        requestId: "req-bsc-test-1",
      },
    );

    expect(result.success).toBe(false);

    // NEO-315: the captures were scheduled, not awaited, so nothing has reached
    // PostHog when the action returns. Run the scheduled captures.
    await drainScheduled(t);

    // The adapter path emits two events on this failure mode:
    //   1. getBscToken → adapter_sync_call (platform=bsc, success=false)
    //   2. fetchBscSelectorOptions → adapter_sync_call (platform=bsc, success=false)
    // Both should share the same requestId.
    const adapterEvents = captureCalls.filter(
      (c) => c.event === "adapter_sync_call",
    );
    expect(adapterEvents.length).toBeGreaterThanOrEqual(1);

    const sameRequest = adapterEvents.filter(
      (c) => c.properties.requestId === "req-bsc-test-1",
    );
    expect(sameRequest.length).toBe(adapterEvents.length);

    const outerEvent = sameRequest.find(
      (c) => c.properties.operation === "fetchBscSelectorOptions",
    );
    expect(outerEvent).toBeDefined();
    expect(outerEvent!.properties).toMatchObject({
      platform: "bsc",
      level: "sport",
      success: false,
      error_class: "no_credentials",
    });
    expect(typeof outerEvent!.properties.duration_ms).toBe("number");
    // Resolved before scheduling: a scheduled function has no auth context,
    // so an id resolved inside the capture would always read "anonymous".
    expect(outerEvent!.distinctId).toBe(ADMIN_IDENTITY.subject);
  });

  test("the capture is scheduled, not run inline — nothing reaches PostHog until it runs", async () => {
    const t = convexTest(schema, modules);
    await t.withIdentity(ADMIN_IDENTITY).action(
      api.adapters.buysportscards.fetchBscSelectorOptions,
      { level: "sport", parentFilters: {}, requestId: "req-bsc-test-2" },
    );

    const pending = await t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect()).map((r) => r.name),
    );
    expect(pending.filter((n) => n === "posthog:captureEvent").length).toBeGreaterThanOrEqual(1);

    await drainScheduled(t);
    expect(
      captureCalls.filter((c) => c.properties.requestId === "req-bsc-test-2").length,
    ).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// recordAdapterCall — the scheduling contract (NEO-315), driven directly with a
// stub ctx so each property is pinned without a marketplace adapter around it.
// ---------------------------------------------------------------------------

describe("recordAdapterCall scheduling contract", () => {
  const PROPS = {
    requestId: "req-direct",
    operation: "fetchBscSelectorOptions",
    platform: "bsc" as const,
    duration_ms: 12,
    success: true,
  };

  type Scheduled = { delayMs: number; args: Record<string, unknown> };

  function stub(opts: {
    subject?: string;
    authThrows?: boolean;
    runAfter?: () => Promise<unknown>;
  } = {}) {
    const scheduled: Scheduled[] = [];
    let runActionCalls = 0;
    const ctx = {
      auth: {
        getUserIdentity: async () => {
          if (opts.authThrows) throw new Error("auth unavailable");
          return opts.subject ? { subject: opts.subject } : null;
        },
      },
      runAction: async () => {
        runActionCalls++;
        return null;
      },
      scheduler: {
        runAfter: async (delayMs: number, _ref: unknown, args: Record<string, unknown>) => {
          scheduled.push({ delayMs, args });
          if (opts.runAfter) return opts.runAfter();
          return "id";
        },
      },
    } as unknown as ActionCtx;
    return { ctx, scheduled, runActions: () => runActionCalls };
  }

  test("schedules the capture at delay 0 and never runs the PostHog action inline", async () => {
    const { ctx, scheduled, runActions } = stub({ subject: "user_signed_in" });
    await recordAdapterCall(ctx, PROPS);
    expect(runActions()).toBe(0);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].delayMs).toBe(0);
    expect(scheduled[0].args.event).toBe("adapter_sync_call");
  });

  test("a signed-in caller's id is resolved before scheduling", async () => {
    const { ctx, scheduled } = stub({ subject: "user_signed_in" });
    await recordAdapterCall(ctx, PROPS);
    expect(scheduled[0].args.distinctId).toBe("user_signed_in");
  });

  test("an anonymous caller is 'anonymous'", async () => {
    const { ctx, scheduled } = stub();
    await recordAdapterCall(ctx, PROPS);
    expect(scheduled[0].args.distinctId).toBe("anonymous");
  });

  test("an auth lookup that throws still schedules, as 'anonymous'", async () => {
    const { ctx, scheduled } = stub({ authThrows: true });
    await expect(recordAdapterCall(ctx, PROPS)).resolves.toBeUndefined();
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].args.distinctId).toBe("anonymous");
  });

  test("a scheduler that throws never fails the call and is logged", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { ctx } = stub({
      subject: "user_signed_in",
      runAfter: async () => {
        throw new Error("scheduler down");
      },
    });
    await expect(recordAdapterCall(ctx, PROPS)).resolves.toBeUndefined();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  test("with POSTHOG_API_KEY unset or empty nothing is scheduled, but the console line still lands", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    for (const value of [undefined, ""]) {
      if (value === undefined) delete process.env.POSTHOG_API_KEY;
      else process.env.POSTHOG_API_KEY = value;
      const { ctx, scheduled, runActions } = stub({ subject: "user_signed_in" });
      await recordAdapterCall(ctx, PROPS);
      expect(scheduled).toHaveLength(0);
      expect(runActions()).toBe(0);
    }
    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines.filter((l) => l.includes('"msg":"adapter_sync_call"'))).toHaveLength(2);
    log.mockRestore();
  });

  test("the scheduled properties carry the full bag verbatim plus the deployment tag", async () => {
    const { ctx, scheduled } = stub({ subject: "user_signed_in" });
    await recordAdapterCall(ctx, { ...PROPS, error_class: "timeout", jobId: "j", entryIndex: 4 });
    expect(scheduled[0].args.properties).toMatchObject({
      ...PROPS,
      error_class: "timeout",
      jobId: "j",
      entryIndex: 4,
    });
    expect(Object.keys(scheduled[0].args.properties as object)).toContain("deployment");
  });
});
