/**
 * NEO-43 — credential-test instrumentation.
 *
 * These events are what the PostHog side of the login alerting reads:
 *   - `credential_test_failed`     (pre-existing)
 *   - `credential_test_succeeded`  (added by NEO-43 so a failure RATE is
 *                                   computable, not just an absolute count)
 *
 * The single most valuable case here is the TIMEOUT one. A login that hangs
 * long enough for Convex's 60s AbortSignal to fire produces NO
 * `browser_login_call` log line at all — the browser service writes that line
 * only when its handler returns. So `error_class: "timeout"` on this PostHog
 * event is the only event-level record of the hang that prompted this ticket.
 *
 * This is a SEPARATE file from credentials.test.ts on purpose: `vi.mock` is
 * file-scoped, and credentials.test.ts deliberately runs with POSTHOG_API_KEY
 * unset so its captures no-op. The FakePostHog harness below is copied from
 * observability.test.ts.
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { internal } from "./_generated/api";
import { sanitizeLoginDiagnostic } from "./observability";

const captureCalls: Array<{
  distinctId: string;
  event: string;
  properties: Record<string, unknown>;
}> = [];

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

const USER = "user_neo43_instr_001";

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

/** The one capture of the given event name; asserts exactly one was emitted. */
function only(event: string) {
  const found = captureCalls.filter((c) => c.event === event);
  expect(found, `expected exactly one "${event}" capture`).toHaveLength(1);
  return found[0];
}

beforeEach(() => {
  captureCalls.length = 0;
  // Loopback browser URL → getIdTokenClient short-circuits (no OIDC / no GCP creds).
  process.env.NEONBINDER_BROWSER_URL = "http://localhost:9999";
  // PostHog client short-circuits when no key is set. Force one so the mocked
  // client actually gets invoked.
  process.env.POSTHOG_API_KEY = "test-posthog-key";
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.NEONBINDER_BROWSER_URL;
  delete process.env.POSTHOG_API_KEY;
});

describe("credential_test_failed — enriched properties", () => {
  test("carries the browser service's error_class, challengeDetected and duration_ms", async () => {
    const t = convexTest(schema, modules);
    const stub: FetchStub = async (url) => {
      if (String(url).includes("/login/bsc")) {
        return jsonResponse(
          {
            error: "Authentication failed",
            error_class: "challenge",
            diagnostic: {
              url: "https://login.buysportscards.com/oauth2/v2.0/authorize",
              title: "Are you a robot?",
              challengeDetected: true,
              snippet: "please complete the captcha",
            },
          },
          500,
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    };
    vi.stubGlobal("fetch", stub);

    const result = await t
      .withIdentity({ subject: USER })
      .action(internal.credentials.authenticateBsc, {});

    expect(result.success).toBe(false);
    const ev = only("credential_test_failed");
    expect(ev.distinctId).toBe(USER);
    expect(ev.properties.platform).toBe("buysportscards");
    // Prefers the service's own tag over local classification — BSC's
    // caller-facing error is the generic "Authentication failed", which
    // classifyAdapterError could only bucket as "other".
    expect(ev.properties.error_class).toBe("challenge");
    expect(ev.properties.challengeDetected).toBe(true);
    expect(typeof ev.properties.duration_ms).toBe("number");
    expect(captureCalls.filter((c) => c.event === "credential_test_succeeded")).toHaveLength(0);
  });

  test("HANG: a 60s abort is classified as error_class 'timeout'", async () => {
    // The NEO-39 failure mode. There is no browser_login_call log line for a
    // request that never returns, so this event is the only record of it.
    const t = convexTest(schema, modules);
    const stub: FetchStub = async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    };
    vi.stubGlobal("fetch", stub);

    const result = await t
      .withIdentity({ subject: USER })
      .action(internal.credentials.authenticateBsc, {});

    expect(result.success).toBe(false);
    const ev = only("credential_test_failed");
    expect(ev.properties.error_class).toBe("timeout");
    expect(ev.properties.reason).toMatch(/TimeoutError/);
  });

  test("falls back to local classification when the service omits error_class", async () => {
    // Deploy-skew safety: an older browser revision still serving during
    // rollout returns no error_class. The event must still be classified.
    const t = convexTest(schema, modules);
    const stub: FetchStub = async (url) => {
      if (String(url).includes("/login/sportlots")) {
        return jsonResponse({ error: "request timed out talking to SportLots" }, 400);
      }
      throw new Error(`unexpected fetch: ${url}`);
    };
    vi.stubGlobal("fetch", stub);

    await t.withIdentity({ subject: USER }).action(internal.credentials.authenticateSportlots, {});

    const ev = only("credential_test_failed");
    expect(ev.properties.platform).toBe("sportlots");
    expect(ev.properties.error_class).toBe("timeout");
  });
});

describe("credential_test_succeeded — the rate denominator", () => {
  test("a successful BSC login emits succeeded and no failure event", async () => {
    const t = convexTest(schema, modules);
    const stub: FetchStub = async (url) => {
      if (String(url).includes("/login/bsc")) {
        return jsonResponse({ success: true, message: "ok", storeName: "Acme Cards" });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };
    vi.stubGlobal("fetch", stub);

    const result = await t
      .withIdentity({ subject: USER })
      .action(internal.credentials.authenticateBsc, {});

    expect(result.success).toBe(true);
    const ev = only("credential_test_succeeded");
    expect(ev.properties.platform).toBe("buysportscards");
    expect(typeof ev.properties.duration_ms).toBe("number");
    expect(captureCalls.filter((c) => c.event === "credential_test_failed")).toHaveLength(0);
  });

  test("a successful SportLots login emits succeeded", async () => {
    const t = convexTest(schema, modules);
    const stub: FetchStub = async (url) => {
      if (String(url).includes("/login/sportlots")) {
        return jsonResponse({ success: true, message: "ok" });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };
    vi.stubGlobal("fetch", stub);

    const result = await t
      .withIdentity({ subject: USER })
      .action(internal.credentials.authenticateSportlots, {});

    expect(result.success).toBe(true);
    expect(only("credential_test_succeeded").properties.platform).toBe("sportlots");
  });
});

describe("sanitizeLoginDiagnostic — trust boundary", () => {
  test("clamps an oversized snippet to 1500 chars", () => {
    const out = sanitizeLoginDiagnostic({ snippet: "x".repeat(5000) });
    expect(out.snippet).toHaveLength(1500);
  });

  test("DROPS unexpected keys instead of forwarding them to PostHog", () => {
    // The previous code spread result.diagnostic unmodified, trusting a remote
    // service to have redacted. This is the guard against that.
    const out = sanitizeLoginDiagnostic({
      challengeDetected: true,
      password: "hunter2",
      cookie: "session=abc",
    } as never);
    expect(out).not.toHaveProperty("password");
    expect(out).not.toHaveProperty("cookie");
    expect(out.challengeDetected).toBe(true);
  });

  test("coerces a non-boolean challengeDetected to undefined", () => {
    const out = sanitizeLoginDiagnostic({ challengeDetected: "yes" } as never);
    expect(out.challengeDetected).toBeUndefined();
  });

  test("returns an empty object for a missing diagnostic", () => {
    expect(sanitizeLoginDiagnostic(undefined)).toEqual({});
  });

  test("clamps url and title to 200 chars", () => {
    const out = sanitizeLoginDiagnostic({
      url: "https://x.example/".padEnd(500, "a"),
      title: "t".repeat(500),
    });
    expect(out.url).toHaveLength(200);
    expect(out.title).toHaveLength(200);
  });
});

describe("recordCredentialTest — never breaks the login it observes", () => {
  test("a login still succeeds when PostHog capture throws", async () => {
    const t = convexTest(schema, modules);
    const stub: FetchStub = async (url) => {
      if (String(url).includes("/login/bsc")) {
        return jsonResponse({ success: true, message: "ok" });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };
    vi.stubGlobal("fetch", stub);
    // Force the capture path to blow up.
    delete process.env.POSTHOG_API_KEY;
    process.env.POSTHOG_API_KEY = "";

    const result = await t
      .withIdentity({ subject: USER })
      .action(internal.credentials.authenticateBsc, {});

    expect(result.success).toBe(true);
  });
});

describe("deployment tag (NEO-43) — one PostHog project serves all environments", () => {
  test("credential events carry the emitting deployment", async () => {
    // Without this, a per-PR E2E run (8 workers as 8 distinct Clerk users,
    // with credentials-lifecycle failing a login on purpose) is
    // indistinguishable from 8 real sellers failing in prod — which would
    // fire the unique-users alert on every PR.
    process.env.CONVEX_CLOUD_URL = "https://first-starfish-800.convex.cloud";
    const t = convexTest(schema, modules);
    vi.stubGlobal("fetch", (async (url: string | URL | Request) =>
      String(url).includes("/login/bsc")
        ? jsonResponse({ success: true, message: "ok" })
        : (() => { throw new Error(`unexpected fetch: ${url}`); })()) as FetchStub);

    await t.withIdentity({ subject: USER }).action(internal.credentials.authenticateBsc, {});

    expect(only("credential_test_succeeded").properties.deployment).toBe("first-starfish-800");
    delete process.env.CONVEX_CLOUD_URL;
  });

  test("deploymentName parses the slug, and degrades to undefined rather than guessing", async () => {
    const { deploymentName } = await import("./observability");

    process.env.CONVEX_CLOUD_URL = "https://first-starfish-800.convex.cloud";
    expect(deploymentName()).toBe("first-starfish-800");

    process.env.CONVEX_CLOUD_URL = "https://pr-123-abc.convex.cloud";
    expect(deploymentName()).toBe("pr-123-abc");

    delete process.env.CONVEX_CLOUD_URL;
    expect(deploymentName()).toBeUndefined();

    process.env.CONVEX_CLOUD_URL = "not-a-url";
    expect(deploymentName()).toBeUndefined();
    delete process.env.CONVEX_CLOUD_URL;
  });
});
