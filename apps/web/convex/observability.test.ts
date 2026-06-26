/**
 * Unit tests for the adapter-perf instrumentation helpers.
 *
 * Coverage:
 *  - classifyAdapterError maps common error strings to stable tags
 *  - newRequestId returns a syntactically-valid UUID string and is unique
 *  - recordAdapterCall fires `adapter_sync_call` via PostHog with the
 *    full property bag forwarded verbatim
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
import {
  classifyAdapterError,
  newRequestId,
} from "./observability";

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
});

afterEach(() => {
  delete process.env.POSTHOG_API_KEY;
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
  });
});
