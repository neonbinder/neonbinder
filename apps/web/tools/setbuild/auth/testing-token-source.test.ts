import { describe, expect, test } from "vitest";
import { testingTokenSource } from "./testing-token-source";
import { SetbuildAuthError, decodeJwtClaims } from "./token-source";
import { fakeJwt, json, publishableKeyFor, routedFetch, type RecordedCall } from "./test-helpers";

const FAPI_HOST = "example-instance-12.clerk.accounts.dev";
const SECRET = "testing-endpoint-secret-value-0123";
const BYPASS = "vercel-bypass-secret-value-4567";
const TICKET = "sign-in-ticket-value-89ab";
const TESTING_TOKEN = "clerk-testing-token-cdef";
const CLIENT_JWT = "client.jwt.native-value";
const DB_JWT = "dev-browser-jwt-value-1357";
const NOW = 1_800_000_000_000;

function convexJwt(n = 1, overrides: Record<string, unknown> = {}): string {
  return fakeJwt({
    sub: "user_abc",
    aud: "convex",
    role: "admin",
    exp: NOW / 1000 + 3600,
    iat: NOW / 1000,
    n,
    ...overrides,
  });
}

const endpointOk = () => json({ signInToken: TICKET, testingToken: TESTING_TOKEN, clerkUserId: "user_abc" });
const signInOk = () =>
  json(
    { response: { status: "complete", created_session_id: "sess_one" }, client: {} },
    200,
    { authorization: CLIENT_JWT },
  );

function source(fetchFn: typeof fetch, extra: { bypassSecret?: string } = {}) {
  return testingTokenSource({
    appUrl: "http://localhost:3005/some/path",
    testingSecret: SECRET,
    worker: 2,
    publishableKey: publishableKeyFor(FAPI_HOST),
    fetchFn,
    now: () => NOW,
    sleep: async () => {},
    ...extra,
  });
}

function everything(calls: RecordedCall[]): string {
  return calls.map((c) => `${c.url} ${JSON.stringify(c.headers)} ${c.body}`).join("\n");
}

describe("testingTokenSource", () => {
  test("happy path: testing endpoint → ticket redeem → convex template mint", async () => {
    let minted = 0;
    const { fetchFn, calls } = routedFetch({
      "POST /api/auth/testing": endpointOk,
      "POST /v1/client/sign_ins": signInOk,
      "POST /v1/client/sessions/{sid}/tokens/convex": () => json({ object: "token", jwt: convexJwt(++minted) }),
    });
    const token = await source(fetchFn, { bypassSecret: BYPASS }).getToken();

    expect(decodeJwtClaims(token)).toMatchObject({ sub: "user_abc", aud: "convex", n: 1 });
    expect(calls.map((c) => `${c.method} ${c.url.host}${c.url.pathname}`)).toEqual([
      "POST localhost:3005/api/auth/testing",
      `POST ${FAPI_HOST}/v1/client/sign_ins`,
      `POST ${FAPI_HOST}/v1/client/sessions/sess_one/tokens/convex`,
    ]);

    const [endpoint, signIn, mint] = calls;
    expect(endpoint.headers["x-testing-auth"]).toBe(SECRET);
    expect(endpoint.headers["x-vercel-protection-bypass"]).toBe(BYPASS);
    expect(JSON.parse(endpoint.body)).toEqual({ account: "main", worker: 2 });

    expect(signIn.url.searchParams.get("_is_native")).toBe("1");
    expect(signIn.url.searchParams.get("__clerk_testing_token")).toBe(TESTING_TOKEN);
    expect(signIn.url.searchParams.has("__clerk_db_jwt")).toBe(false);
    expect(Object.fromEntries(new URLSearchParams(signIn.body))).toEqual({ strategy: "ticket", ticket: TICKET });
    expect(signIn.headers.authorization).toBeUndefined();

    expect(mint.headers.authorization).toBe(CLIENT_JWT);
    expect(mint.url.searchParams.get("__clerk_testing_token")).toBe(TESTING_TOKEN);
  });

  test("caches by exp, re-mints from the same session on forceRefresh", async () => {
    let minted = 0;
    const { fetchFn, calls } = routedFetch({
      "POST /api/auth/testing": endpointOk,
      "POST /v1/client/sign_ins": signInOk,
      "POST /v1/client/sessions/{sid}/tokens/convex": () => json({ jwt: convexJwt(++minted) }),
    });
    const ts = source(fetchFn);
    const a = await ts.getToken();
    const b = await ts.getToken();
    const c = await ts.getToken({ forceRefresh: true });
    expect(a).toBe(b);
    expect(c).not.toBe(a);
    expect(calls.filter((x) => x.url.pathname === "/api/auth/testing")).toHaveLength(1);
    expect(calls.filter((x) => x.url.pathname.includes("/tokens/convex"))).toHaveLength(2);
  });

  test("re-mints when the cached token is inside the refresh skew", async () => {
    let now = NOW;
    let minted = 0;
    const { fetchFn } = routedFetch({
      "POST /api/auth/testing": endpointOk,
      "POST /v1/client/sign_ins": signInOk,
      "POST /v1/client/sessions/{sid}/tokens/convex": () =>
        json({ jwt: convexJwt(++minted, { exp: now / 1000 + 60 }) }),
    });
    const ts = testingTokenSource({
      appUrl: "http://localhost:3005",
      testingSecret: SECRET,
      worker: 0,
      publishableKey: publishableKeyFor(FAPI_HOST),
      fetchFn,
      now: () => now,
    });
    const first = await ts.getToken();
    now += 30_000; // 30 s left: still outside the 20 s skew
    expect(await ts.getToken()).toBe(first);
    now += 15_000; // 15 s left: inside it
    expect(await ts.getToken()).not.toBe(first);
  });

  test("concurrent callers share one chain", async () => {
    const { fetchFn, calls } = routedFetch({
      "POST /api/auth/testing": endpointOk,
      "POST /v1/client/sign_ins": signInOk,
      "POST /v1/client/sessions/{sid}/tokens/convex": () => json({ jwt: convexJwt() }),
    });
    const ts = source(fetchFn);
    const [a, b, c] = await Promise.all([ts.getToken(), ts.getToken(), ts.getToken()]);
    expect(new Set([a, b, c]).size).toBe(1);
    expect(calls).toHaveLength(3);
  });

  test("dev-browser refusal: fetches a dev-browser JWT and retries the sign-in once with it", async () => {
    const { fetchFn, calls } = routedFetch({
      "POST /api/auth/testing": endpointOk,
      "POST /v1/client/sign_ins": [
        () =>
          json(
            { errors: [{ code: "dev_browser_unauthenticated", message: "Browser unauthenticated" }] },
            401,
          ),
        signInOk,
      ],
      "POST /v1/dev_browser": () => json({ id: "db_1", token: DB_JWT }),
      "POST /v1/client/sessions/{sid}/tokens/convex": () => json({ jwt: convexJwt() }),
    });
    await source(fetchFn).getToken();

    expect(calls.map((c) => c.url.pathname)).toEqual([
      "/api/auth/testing",
      "/v1/client/sign_ins",
      "/v1/dev_browser",
      "/v1/client/sign_ins",
      "/v1/client/sessions/sess_one/tokens/convex",
    ]);
    expect(calls[3].url.searchParams.get("__clerk_db_jwt")).toBe(DB_JWT);
    // The mint carries the dev-browser context too.
    expect(calls[4].url.searchParams.get("__clerk_db_jwt")).toBe(DB_JWT);
  });

  test("a refusal that does not mention the dev browser never calls /v1/dev_browser", async () => {
    const { fetchFn, calls } = routedFetch({
      "POST /api/auth/testing": endpointOk,
      "POST /v1/client/sign_ins": () =>
        json({ errors: [{ code: "form_identifier_not_found", message: "Couldn't find your account." }] }, 422),
    });
    const err = await source(fetchFn).getToken().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SetbuildAuthError);
    expect((err as SetbuildAuthError).stage).toBe("fapi_sign_in");
    expect((err as Error).message).toContain("form_identifier_not_found");
    expect(calls.some((c) => c.url.pathname === "/v1/dev_browser")).toBe(false);
  });

  test("a 401 from the mint drops the session and re-runs the whole chain with a new ticket", async () => {
    const { fetchFn, calls } = routedFetch({
      "POST /api/auth/testing": endpointOk,
      "POST /v1/client/sign_ins": [
        signInOk,
        () =>
          json(
            { response: { status: "complete", created_session_id: "sess_two" } },
            200,
            { authorization: "client.jwt.second" },
          ),
      ],
      "POST /v1/client/sessions/{sid}/tokens/convex": [
        () => json({ errors: [{ code: "authentication_invalid", message: "Unauthorized request" }] }, 401),
        () => json({ jwt: convexJwt(2) }),
      ],
    });
    const token = await source(fetchFn).getToken();
    expect(decodeJwtClaims(token).n).toBe(2);
    expect(calls.filter((c) => c.url.pathname === "/api/auth/testing")).toHaveLength(2);
    const mints = calls.filter((c) => c.url.pathname.includes("/tokens/convex"));
    expect(mints.map((c) => c.url.pathname)).toEqual([
      "/v1/client/sessions/sess_one/tokens/convex",
      "/v1/client/sessions/sess_two/tokens/convex",
    ]);
    expect(mints[1].headers.authorization).toBe("client.jwt.second");
  });

  test("gives up after 3 chains", async () => {
    const { fetchFn, calls } = routedFetch({
      "POST /api/auth/testing": endpointOk,
      "POST /v1/client/sign_ins": signInOk,
      "POST /v1/client/sessions/{sid}/tokens/convex": () =>
        json({ errors: [{ code: "authentication_invalid" }] }, 401),
    });
    const err = await source(fetchFn).getToken().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SetbuildAuthError);
    expect((err as Error).message).toMatch(/Gave up after 3 attempts/);
    expect(calls.filter((c) => c.url.pathname === "/api/auth/testing")).toHaveLength(3);
  });

  test("a wrong testing secret fails at once with a hint, and no retry", async () => {
    const { fetchFn, calls } = routedFetch({
      "POST /api/auth/testing": () => json({ error: "Unauthorized" }, 401),
    });
    const err = await source(fetchFn).getToken().catch((e: unknown) => e);
    expect((err as SetbuildAuthError).stage).toBe("testing_endpoint");
    expect((err as Error).message).toContain("TESTING_ENDPOINT_SECRET does not match");
    expect(calls).toHaveLength(1);
  });

  test("a token for another audience is refused before Convex sees it", async () => {
    const { fetchFn } = routedFetch({
      "POST /api/auth/testing": endpointOk,
      "POST /v1/client/sign_ins": signInOk,
      "POST /v1/client/sessions/{sid}/tokens/convex": () => json({ jwt: convexJwt(1, { aud: "other" }) }),
    });
    const err = await source(fetchFn).getToken().catch((e: unknown) => e);
    expect((err as SetbuildAuthError).stage).toBe("jwt_audience");
  });

  test("no secret, ticket or token ever appears in a thrown message or describe()", async () => {
    const leaky = [SECRET, BYPASS, TICKET, TESTING_TOKEN, CLIENT_JWT, DB_JWT];
    // Each upstream echoes back every secret it could plausibly have seen.
    const echo = (...s: string[]) => s.join(" | ");
    const devBrowserRefusal = () =>
      json({ errors: [{ code: "dev_browser_unauthenticated", message: "dev browser" }] }, 401);
    const scenarios: Array<Record<string, (() => Response) | Array<() => Response>>> = [
      // The endpoint echoes the headers it was sent.
      { "POST /api/auth/testing": () => json({ error: echo(SECRET, BYPASS) }, 400) },
      // Clerk echoes the ticket and testing token in a sign-in refusal.
      {
        "POST /api/auth/testing": endpointOk,
        "POST /v1/client/sign_ins": () =>
          json({ errors: [{ code: "x", long_message: echo(TICKET, TESTING_TOKEN) }] }, 400),
      },
      // …and the dev-browser JWT in the refusal of the retry.
      {
        "POST /api/auth/testing": endpointOk,
        "POST /v1/client/sign_ins": [
          devBrowserRefusal,
          () => json({ errors: [{ code: "x", message: echo(TICKET, TESTING_TOKEN, DB_JWT) }] }, 400),
        ],
        "POST /v1/dev_browser": () => json({ token: DB_JWT }),
      },
      // …and the client JWT in a mint refusal (after a dev-browser sign-in).
      {
        "POST /api/auth/testing": endpointOk,
        "POST /v1/client/sign_ins": [devBrowserRefusal, signInOk],
        "POST /v1/dev_browser": () => json({ token: DB_JWT }),
        "POST /v1/client/sessions/{sid}/tokens/convex": () =>
          json({ errors: [{ code: "x", message: echo(...leaky) }] }, 400),
      },
      // …and in the final give-up message after three refused mints.
      {
        "POST /api/auth/testing": endpointOk,
        "POST /v1/client/sign_ins": signInOk,
        "POST /v1/client/sessions/{sid}/tokens/convex": () =>
          json({ errors: [{ code: "x", message: echo(SECRET, BYPASS, TICKET, TESTING_TOKEN, CLIENT_JWT) }] }, 401),
      },
    ];
    for (const routes of scenarios) {
      const { fetchFn } = routedFetch(routes);
      const ts = source(fetchFn, { bypassSecret: BYPASS });
      const err = await ts.getToken().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SetbuildAuthError);
      for (const secret of leaky) {
        expect((err as Error).message).not.toContain(secret);
        expect(ts.describe()).not.toContain(secret);
      }
    }
  });

  test("a network failure names the error class, never the URL (which carries tokens)", async () => {
    const { fetchFn } = routedFetch({
      "POST /api/auth/testing": endpointOk,
      "POST /v1/client/sign_ins": () => {
        throw new TypeError(`fetch failed for https://${FAPI_HOST}/?__clerk_testing_token=${TESTING_TOKEN}`);
      },
    });
    const err = await source(fetchFn).getToken().catch((e: unknown) => e);
    expect((err as SetbuildAuthError).stage).toBe("fapi_sign_in_unreachable");
    expect((err as Error).message).not.toContain(TESTING_TOKEN);
    expect((err as Error).message).toContain("TypeError");
  });

  test("rejects a bad worker index and a missing secret up front", () => {
    const base = {
      appUrl: "http://localhost:3005",
      testingSecret: SECRET,
      publishableKey: publishableKeyFor(FAPI_HOST),
      fetchFn: (async () => json({})) as typeof fetch,
    };
    expect(() => testingTokenSource({ ...base, worker: 32 })).toThrow(/worker/);
    expect(() => testingTokenSource({ ...base, worker: -1 })).toThrow(/worker/);
    expect(() => testingTokenSource({ ...base, worker: 0, testingSecret: "" })).toThrow(
      /TESTING_ENDPOINT_SECRET/,
    );
  });
});
