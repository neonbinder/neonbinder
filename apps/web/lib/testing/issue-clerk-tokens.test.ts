// Unit tests for `issueClerkTestingTokens` — focuses on retry behavior +
// upstream error surfacing. The wrapper used to mistranslate any Clerk
// 4xx/5xx into "No Clerk user found" or "Failed to create sign-in token"
// because it never inspected `res.ok`. We now retry transient failures
// and emit a `clerk_api_error` with detail.status / detail.body so the
// audit log captures what Clerk actually returned.
//
// `fetch` is injected via the `IssueEnv.fetchFn` test hook so we never
// touch the network. Sleep is replaced with a no-op so retry tests don't
// pay the real 200/600/1500 ms backoff budget.

import { describe, expect, test, vi } from "vitest";
import { issueClerkTestingTokens } from "./issue-clerk-tokens";

const ENV = {
  clerkSecretKey: "sk_test_fake",
  testEmail: "dev+e2e-1@neonbinder.io",
  sleep: async () => {
    /* no-op for tests */
  },
};

function mkRes(status: number, body: unknown): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Response(text, {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("issueClerkTestingTokens", () => {
  test("happy path: returns sign-in + testing tokens", async () => {
    const fetchFn = vi.fn(async (url: string | URL) => {
      const u = url.toString();
      if (u.includes("/v1/users")) {
        return mkRes(200, { data: [{ id: "user_x" }] });
      }
      if (u.includes("/v1/sign_in_tokens")) {
        return mkRes(200, { token: "st_x" });
      }
      if (u.includes("/v1/testing_tokens")) {
        return mkRes(200, { token: "tt_x" });
      }
      throw new Error(`unexpected url ${u}`);
    });

    const result = await issueClerkTestingTokens({
      ...ENV,
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(result).toEqual({
      ok: true,
      signInToken: "st_x",
      testingToken: "tt_x",
      clerkUserId: "user_x",
    });
    // 3 calls: /users + parallel /sign_in_tokens + /testing_tokens
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  test("truly missing user: Clerk 200 with empty data returns 404", async () => {
    const fetchFn = vi.fn(async () => mkRes(200, { data: [] }));

    const result = await issueClerkTestingTokens({
      ...ENV,
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(404);
    expect(result.error).toContain("No Clerk user found");
    // No retry attempts for an empty-200 — it's deterministic, not transient.
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  test("transient 429 on /v1/users: retries until success", async () => {
    let attempt = 0;
    const fetchFn = vi.fn(async (url: string | URL) => {
      const u = url.toString();
      if (u.includes("/v1/users")) {
        attempt++;
        if (attempt < 3) return mkRes(429, { errors: [{ code: "rate_limited" }] });
        return mkRes(200, { data: [{ id: "user_x" }] });
      }
      if (u.includes("/v1/sign_in_tokens")) return mkRes(200, { token: "st_x" });
      if (u.includes("/v1/testing_tokens")) return mkRes(200, { token: "tt_x" });
      throw new Error(`unexpected url ${u}`);
    });

    const result = await issueClerkTestingTokens({
      ...ENV,
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.signInToken).toBe("st_x");
    // 3 attempts on /users + 1 sign_in + 1 testing = 5
    expect(fetchFn).toHaveBeenCalledTimes(5);
  });

  test("5xx exhausted on /v1/users: returns clerk_api_error with real status + body", async () => {
    const fetchFn = vi.fn(async () =>
      mkRes(503, { errors: [{ message: "service unavailable" }] }),
    );

    const result = await issueClerkTestingTokens({
      ...ENV,
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(503);
    expect(result.error).toBe("clerk_api_error");
    expect(result.detail).toMatchObject({
      stage: "users",
      status: 503,
    });
    expect((result.detail as { body: string }).body).toContain("service unavailable");
    // 4 attempts (1 + 3 retries) — backoff budget exhausted.
    expect(fetchFn).toHaveBeenCalledTimes(4);
  });

  test("non-retryable 4xx on /v1/sign_in_tokens: no retries, surfaces real status", async () => {
    let calls = 0;
    const fetchFn = vi.fn(async (url: string | URL) => {
      const u = url.toString();
      if (u.includes("/v1/users")) {
        return mkRes(200, { data: [{ id: "user_x" }] });
      }
      if (u.includes("/v1/sign_in_tokens")) {
        calls++;
        return mkRes(401, { errors: [{ message: "invalid api key" }] });
      }
      if (u.includes("/v1/testing_tokens")) return mkRes(200, { token: "tt_x" });
      throw new Error(`unexpected url ${u}`);
    });

    const result = await issueClerkTestingTokens({
      ...ENV,
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(401);
    expect(result.error).toBe("clerk_api_error");
    expect(result.detail).toMatchObject({
      stage: "sign_in_token",
      status: 401,
    });
    // Exactly one call to /sign_in_tokens — 401 is not retryable.
    expect(calls).toBe(1);
  });

  test("network error then success: retries the throw", async () => {
    let attempt = 0;
    const fetchFn = vi.fn(async (url: string | URL) => {
      const u = url.toString();
      if (u.includes("/v1/users")) {
        attempt++;
        if (attempt === 1) throw new TypeError("fetch failed");
        return mkRes(200, { data: [{ id: "user_x" }] });
      }
      if (u.includes("/v1/sign_in_tokens")) return mkRes(200, { token: "st_x" });
      if (u.includes("/v1/testing_tokens")) return mkRes(200, { token: "tt_x" });
      throw new Error(`unexpected url ${u}`);
    });

    const result = await issueClerkTestingTokens({
      ...ENV,
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.signInToken).toBe("st_x");
    // 2 attempts on /users + 1 sign_in + 1 testing = 4
    expect(fetchFn).toHaveBeenCalledTimes(4);
  });

  test("testing_tokens 500: sign-in still succeeds with undefined testingToken", async () => {
    const fetchFn = vi.fn(async (url: string | URL) => {
      const u = url.toString();
      if (u.includes("/v1/users")) {
        return mkRes(200, { data: [{ id: "user_x" }] });
      }
      if (u.includes("/v1/sign_in_tokens")) return mkRes(200, { token: "st_x" });
      if (u.includes("/v1/testing_tokens")) {
        return mkRes(503, { errors: [{ message: "unavailable" }] });
      }
      throw new Error(`unexpected url ${u}`);
    });

    const result = await issueClerkTestingTokens({
      ...ENV,
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.signInToken).toBe("st_x");
    expect(result.testingToken).toBeUndefined();
  });

  test("oversized error body is truncated to 500 chars in detail.body", async () => {
    const huge = "x".repeat(2000);
    const fetchFn = vi.fn(async () =>
      mkRes(500, { errors: [{ message: huge }] }),
    );

    const result = await issueClerkTestingTokens({
      ...ENV,
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const body = (result.detail as { body: string }).body;
    expect(body.length).toBe(500);
  });

  test("/v1/users 200 with unexpected shape: clerk_api_error (not silent 404)", async () => {
    // Some hypothetical Clerk API anomaly — 200 with neither bare array
    // nor { data: [...] }. The wrapper must NOT misread this as "user
    // not found"; it should surface a clerk_api_error so the audit log
    // shows what we got.
    const fetchFn = vi.fn(async () =>
      mkRes(200, { unexpected: "shape", count: 1 }),
    );

    const result = await issueClerkTestingTokens({
      ...ENV,
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("clerk_api_error");
    expect((result.detail as { stage: string }).stage).toBe("users");
    expect((result.detail as { body: string }).body).toContain("unexpected");
  });

  test("missing env: short-circuits without hitting fetch", async () => {
    const fetchFn = vi.fn();
    const result = await issueClerkTestingTokens({
      clerkSecretKey: undefined,
      testEmail: "x@y.z",
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(500);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
