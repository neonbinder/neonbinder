/**
 * Unit tests for the machine-auth token exchange (NEO-172).
 *
 * Driven end-to-end through `t.fetch("/machine/token", …)`, so the HTTP router
 * registration in convex/http.ts is under test alongside the handler — a route
 * that was never wired up would fail every test here rather than passing them
 * all against a directly-imported function.
 *
 * The upstream calls are intercepted with `vi.stubGlobal("fetch", …)`, following
 * the same discipline as the adapter tests (convex/testing.test.ts's
 * `seedMyTestCredentials` convention): one stub, configured per test, recording
 * every request so the assertions can be about what we SENT upstream and not
 * only about what we returned. That matters most for the ownership check —
 * "never mints for another user's session" is a claim about the URL of the mint
 * call, which is invisible from the response.
 *
 * There are SIX upstream calls in play, across two different Clerk APIs, and the
 * split is load-bearing rather than incidental:
 *
 *   Backend API  (api.clerk.com, our secret key)
 *     POST /api_keys/verify              — is this key good?
 *     GET  /sessions/{id}                — session reuse + ownership
 *     POST /sign_in_tokens               — mint a one-time ticket
 *     POST /sessions/{id}/tokens/convex  — mint the JWT
 *   Frontend API ({CLERK_FRONTEND_API_URL}, NO secret)
 *     POST /v1/client/sign_ins           — redeem the ticket
 *     POST /v1/dev_browser               — development instances only
 *
 * Three properties get more attention than their line count suggests:
 *
 *  - **No oracle.** Every credential rejection must be byte-identical. The
 *    tests compare the actual bodies and statuses of the different failure
 *    modes against each other rather than each against a literal, so a future
 *    "helpful" error message fails the comparison instead of quietly adding a
 *    way to classify keys.
 *  - **No secret in the logs.** Asserted over everything the handler printed, on
 *    every console channel, for the api key, the deployment secret, the minted
 *    JWT, the sign-in ticket and the dev-browser token — and for PREFIXES of
 *    each, because a redactor that keeps a few characters "for correlation"
 *    passes a whole-string check while still leaking usable material. One
 *    assertion, run once per distinct logging call site.
 *  - **`POST /sessions` is never called.** It is testing-only on production
 *    instances, so its absence is a release-blocking property rather than a
 *    style preference. The stub throws if anything reaches it, so a regression
 *    fails loudly instead of passing on a development instance and breaking on
 *    release day — which is the exact failure this path exists to prevent.
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "./schema";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const SECRET_KEY = "sk_test_deployment_secret_do_not_log";
const FAPI_URL = "https://clerk.neonbinder.test";
// The api key's PUBLIC id and its SECRET are deliberately unrelated strings.
// An earlier fixture made the secret `${KEY_ID}_secret_value`, which was both
// unrealistic and quietly fatal to the partial-secret assertions below: every
// prefix of the secret was also a prefix of the id we legitimately log, so
// "no fragment of the secret reaches the output" could not have failed.
const KEY_ID = "ak_3beecc9c60adb5f9b850e91a8ee1e992";
const MACHINE_KEY = "ak_live_5d41402abc4b2a76b9719d911017c592";
const SUBJECT = "user_2xhFjEI5X2qWRvtV13BzSj8H6Dk";
const OTHER_SUBJECT = "user_9zzZZZI5X2qWRvtV13BzSj8H6Dk";
const OWN_SESSION = "sess_2ownedbythecaller00000000000";
const OTHER_SESSION = "sess_2belongstosomeoneelse000000";
const CREATED_SESSION = "sess_2freshlycreatedbyclerk00000";
const JWT = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyXzIifQ.signature-do-not-log";
const TICKET = "sit_one_time_ticket_secret_do_not_log";
const DEV_BROWSER_TOKEN = "dvb_dev_browser_token_secret_do_not_log";

const SIGN_IN_URL = `${FAPI_URL}/v1/client/sign_ins?_is_native=1`;
const SIGN_IN_URL_WITH_DB = `${SIGN_IN_URL}&__clerk_db_jwt=${DEV_BROWSER_TOKEN}`;

/**
 * Every value that must never reach a log, whole OR in part.
 *
 * The partial fragments are the point. "Never log the secret" is easy to satisfy
 * accidentally — a truncating logger, a redactor that keeps a prefix "for
 * correlation", a `slice(0, 8)` added to make a log line readable — all of those
 * pass a whole-string check and still put attacker-usable material on disk. The
 * repo rule is never-even-partially, so the test checks prefixes too, and the
 * JWT is checked by its header and signature segments rather than as one blob.
 */
const SECRET_FRAGMENTS: ReadonlyArray<readonly [string, string]> = [
  ["machine key", MACHINE_KEY],
  ["machine key prefix", MACHINE_KEY.slice(0, 12)],
  ["deployment secret", SECRET_KEY],
  ["deployment secret prefix", SECRET_KEY.slice(0, 12)],
  ["jwt", JWT],
  ["jwt header segment", JWT.split(".")[0]],
  ["jwt signature segment", JWT.split(".")[2]],
  ["sign-in ticket", TICKET],
  ["sign-in ticket prefix", TICKET.slice(0, 8)],
  ["dev-browser token", DEV_BROWSER_TOKEN],
  ["dev-browser token prefix", DEV_BROWSER_TOKEN.slice(0, 8)],
];

/** One intercepted upstream request. */
type ClerkCall = {
  url: string;
  method: string;
  authorization: string | null;
  contentType: string | null;
  /** Parsed from JSON or from a form body, whichever the request used. */
  body: Record<string, unknown> | null;
};

/** A canned upstream reply. `raw` sends a non-JSON body instead. */
type Reply = { status: number; body?: unknown; raw?: string } | "throw";

type ClerkConfig = {
  verify?: Reply;
  getSession?: Reply;
  signInToken?: Reply;
  /** An array is consumed one entry per attempt (first try, then the retry). */
  fapiSignIn?: Reply | Reply[];
  devBrowser?: Reply;
  mint?: Reply;
};

/** The api_key object `/api_keys/verify` returns for a good user-scoped key. */
function validApiKey(overrides: Record<string, unknown> = {}) {
  return {
    object: "api_key",
    id: KEY_ID,
    type: "api_key",
    subject: SUBJECT,
    name: "SCANNER_CLI",
    revoked: false,
    expired: false,
    ...overrides,
  };
}

function session(id: string, userId: string, status = "active") {
  return { object: "session", id, user_id: userId, status };
}

/** The Frontend API's error shape, as the dev-browser branch has to read it. */
function fapiError(code: string, message: string) {
  return { errors: [{ code, message, long_message: "internal detail" }] };
}

function toResponse(reply: Reply): Response {
  if (reply === "throw") throw new TypeError("network down");
  if (reply.raw !== undefined) return new Response(reply.raw, { status: reply.status });
  return new Response(JSON.stringify(reply.body ?? {}), {
    status: reply.status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Intercept both Clerk APIs. Returns the live call log.
 *
 * Routes by URL in the order the handler would hit them; `/tokens/` has to be
 * checked before the plain `/sessions/` ones, since the mint URL contains both.
 */
function stubClerk(config: ClerkConfig): ClerkCall[] {
  const calls: ClerkCall[] = [];
  let signInAttempt = 0;

  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const contentType = headers["content-type"] ?? null;

    // The two APIs speak different body formats, and asserting on the parsed
    // form body is how the ticket redemption gets checked at all.
    let body: Record<string, unknown> | null = null;
    if (typeof init?.body === "string") {
      if (contentType === "application/x-www-form-urlencoded") {
        body = Object.fromEntries(new URLSearchParams(init.body));
      } else {
        try {
          body = JSON.parse(init.body) as Record<string, unknown>;
        } catch {
          body = null;
        }
      }
    }
    calls.push({ url, method, authorization: headers.authorization ?? null, contentType, body });

    if (url.includes("/api_keys/verify")) {
      return toResponse(config.verify ?? { status: 200, body: validApiKey() });
    }
    if (url.includes("/sign_in_tokens")) {
      return toResponse(
        config.signInToken ?? {
          status: 200,
          body: {
            object: "sign_in_token",
            id: "sit_2abc",
            status: "pending",
            user_id: SUBJECT,
            token: TICKET,
          },
        },
      );
    }
    if (url.includes("/v1/dev_browser")) {
      return toResponse(config.devBrowser ?? { status: 200, body: { token: DEV_BROWSER_TOKEN } });
    }
    if (url.includes("/client/sign_ins")) {
      const configured = config.fapiSignIn ?? {
        status: 200,
        body: { response: { created_session_id: CREATED_SESSION } },
      };
      const reply = Array.isArray(configured)
        ? (configured[signInAttempt] ?? configured[configured.length - 1])
        : configured;
      signInAttempt += 1;
      return toResponse(reply);
    }
    if (url.includes("/tokens/")) {
      return toResponse(config.mint ?? { status: 200, body: { object: "token", jwt: JWT } });
    }
    if (method === "GET" && url.includes("/sessions/")) {
      return toResponse(config.getSession ?? { status: 404, body: {} });
    }
    // `POST /sessions` is testing-only on production Clerk instances. Reaching
    // it is the release-blocking regression this whole path exists to avoid, so
    // it fails the test rather than being quietly answered.
    if (method === "POST" && url.endsWith("/sessions")) {
      throw new Error("POST /sessions is testing-only and must never be called");
    }
    throw new Error(`unexpected upstream call: ${method} ${url}`);
  });
  return calls;
}

/** POST the exchange endpoint. */
async function exchange(
  t: ReturnType<typeof convexTest>,
  opts: { body?: unknown; bearer?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.bearer !== undefined) headers.authorization = `Bearer ${opts.bearer}`;
  return t.fetch("/machine/token", {
    method: "POST",
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
}

/**
 * Capture everything the handler prints.
 *
 * Both channels, because the success line goes to `console.log` and the failure
 * lines to `console.warn`, and "no secret anywhere" has to mean both. Neither
 * mock throws — an unconditional throwing console mock takes the shared vitest
 * worker down roughly one run in seven (see the note in
 * placeholderPipeline.test.ts).
 */
function captureLogs() {
  const lines: string[] = [];
  const collect = (...args: unknown[]) => {
    lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  // EVERY console channel, not just the two this file happens to use today. The
  // assertion these feed is "no code path reaches a console with a secret", and
  // a spy that watches two of five channels cannot make that claim — a
  // `console.error(err)` added while debugging would sail straight past it,
  // which is exactly the change most likely to print a raw upstream error.
  const spies = (["log", "warn", "error", "info", "debug"] as const).map((channel) =>
    vi.spyOn(console, channel).mockImplementation(collect),
  );
  return {
    lines,
    restore: () => spies.forEach((spy) => spy.mockRestore()),
  };
}

/** The parsed `machine_token_exchange*` lines, ignoring any other file's output. */
function exchangeLines(lines: string[]): Array<Record<string, unknown>> {
  return lines
    .filter((l) => l.includes("machine_token_exchange"))
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

beforeEach(() => {
  process.env.CLERK_SECRET_KEY = SECRET_KEY;
  process.env.CLERK_FRONTEND_API_URL = FAPI_URL;
});

afterEach(() => {
  delete process.env.CLERK_SECRET_KEY;
  delete process.env.CLERK_FRONTEND_API_URL;
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Success — creating a session the production-legal way
// ---------------------------------------------------------------------------

describe("success — create a session via sign-in ticket", () => {
  test("verifies the key, redeems a ticket on the Frontend API, and mints from the convex template", async () => {
    const t = convexTest(schema, modules);
    const calls = stubClerk({});

    const res = await exchange(t, { body: { key: MACHINE_KEY } });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      token: JWT,
      sessionId: CREATED_SESSION,
    });
    expect(res.headers.get("cache-control")).toBe("no-store");

    // Four calls, and NOT `POST /sessions` — which the stub would have thrown
    // on. The order is the whole design: verify, ticket, redeem, mint.
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "POST https://api.clerk.com/v1/api_keys/verify",
      "POST https://api.clerk.com/v1/sign_in_tokens",
      `POST ${SIGN_IN_URL}`,
      `POST https://api.clerk.com/v1/sessions/${CREATED_SESSION}/tokens/convex`,
    ]);

    expect(calls[0].body).toEqual({ secret: MACHINE_KEY });
    // Short-lived on purpose: the ticket is redeemed by the very next call.
    expect(calls[1].body).toEqual({ user_id: SUBJECT, expires_in_seconds: 60 });
    // The redemption is form-encoded and carries the ticket as `strategy=ticket`.
    expect(calls[2].contentType).toBe("application/x-www-form-urlencoded");
    expect(calls[2].body).toEqual({ strategy: "ticket", ticket: TICKET });
  });

  test("the deployment secret goes to the Backend API and NEVER to the Frontend API", async () => {
    // The Frontend API is the public, browser-facing surface — it is authorized
    // by the ticket in the body. Sending a backend credential there would put it
    // on a public endpoint for no benefit at all.
    const t = convexTest(schema, modules);
    const calls = stubClerk({});

    await exchange(t, { body: { key: MACHINE_KEY } });

    const backend = calls.filter((c) => c.url.startsWith("https://api.clerk.com"));
    const frontend = calls.filter((c) => c.url.startsWith(FAPI_URL));
    expect(backend).toHaveLength(3);
    expect(frontend).toHaveLength(1);
    expect(backend.every((c) => c.authorization === `Bearer ${SECRET_KEY}`)).toBe(true);
    expect(frontend.every((c) => c.authorization === null)).toBe(true);
    // And the machine key never leaves the verify call.
    expect(calls.slice(1).every((c) => !JSON.stringify(c.body).includes(MACHINE_KEY))).toBe(
      true,
    );
  });

  test("reads created_session_id from a flat response as well as an enveloped one", async () => {
    // The Frontend API wraps its payload in `{client, response}` on some
    // endpoints and returns it flat on others. Guessing one shape surfaces as
    // "no session id" on an otherwise-successful sign-in.
    const t = convexTest(schema, modules);
    stubClerk({
      fapiSignIn: { status: 200, body: { created_session_id: CREATED_SESSION } },
    });

    const res = await exchange(t, { body: { key: MACHINE_KEY } });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ token: JWT, sessionId: CREATED_SESSION });
  });

  test.each([
    ["a trailing slash", `${FAPI_URL}/`],
    ["no scheme", FAPI_URL.replace("https://", "")],
    ["surrounding whitespace", `  ${FAPI_URL}  `],
  ])("normalises CLERK_FRONTEND_API_URL with %s", async (_label, configured) => {
    // A trailing slash would produce `//v1/client/sign_ins`; a missing scheme
    // would make `fetch` reject the URL outright.
    process.env.CLERK_FRONTEND_API_URL = configured;
    const t = convexTest(schema, modules);
    const calls = stubClerk({});

    const res = await exchange(t, { body: { key: MACHINE_KEY } });

    expect(res.status).toBe(200);
    expect(calls.find((c) => c.url.includes("sign_ins"))?.url).toBe(SIGN_IN_URL);
  });

  test("accepts the key as an Authorization: Bearer header", async () => {
    const t = convexTest(schema, modules);
    const calls = stubClerk({});

    const res = await exchange(t, { bearer: MACHINE_KEY });

    expect(res.status).toBe(200);
    expect(calls[0].body).toEqual({ secret: MACHINE_KEY });
  });

  test("the body wins when the key arrives both ways", async () => {
    // Arbitrary, but FIXED: a client that accidentally sends two different keys
    // must get a deterministic answer rather than one that depends on our
    // parsing order.
    const t = convexTest(schema, modules);
    const calls = stubClerk({});

    await exchange(t, { body: { key: MACHINE_KEY }, bearer: "ak_a_different_key" });

    expect(calls[0].body).toEqual({ secret: MACHINE_KEY });
  });
});

// ---------------------------------------------------------------------------
// The dev-browser branch
// ---------------------------------------------------------------------------

describe("dev-browser retry", () => {
  test("fetches a dev-browser token and retries the sign-in once", async () => {
    // Development instances can refuse a sign-in that arrives without a
    // dev-browser context.
    const t = convexTest(schema, modules);
    const calls = stubClerk({
      fapiSignIn: [
        { status: 401, body: fapiError("dev_browser_unauthenticated", "dev browser required") },
        { status: 200, body: { response: { created_session_id: CREATED_SESSION } } },
      ],
    });

    const res = await exchange(t, { body: { key: MACHINE_KEY } });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ token: JWT, sessionId: CREATED_SESSION });

    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "POST https://api.clerk.com/v1/api_keys/verify",
      "POST https://api.clerk.com/v1/sign_in_tokens",
      `POST ${SIGN_IN_URL}`,
      `POST ${FAPI_URL}/v1/dev_browser`,
      `POST ${SIGN_IN_URL_WITH_DB}`,
      `POST https://api.clerk.com/v1/sessions/${CREATED_SESSION}/tokens/convex`,
    ]);
    // The SAME ticket is replayed — it is single-use, so minting a second one
    // would leave the first accepted and unusable.
    expect(calls[4].body).toEqual({ strategy: "ticket", ticket: TICKET });
  });

  test.each([
    ["dev_browser_unauthenticated", "requires a dev browser"],
    ["some_other_code", "dev browser missing"],
    ["devbrowser_required", "nope"],
  ])("recognises the hint in code %s", async (code, message) => {
    // Matched on what the error says, in any of Clerk's spellings.
    const t = convexTest(schema, modules);
    const calls = stubClerk({
      fapiSignIn: [
        { status: 401, body: fapiError(code, message) },
        { status: 200, body: { response: { created_session_id: CREATED_SESSION } } },
      ],
    });

    const res = await exchange(t, { body: { key: MACHINE_KEY } });
    expect(res.status).toBe(200);
    expect(calls.some((c) => c.url.includes("/v1/dev_browser"))).toBe(true);
  });

  test("NEVER calls /v1/dev_browser for an unrelated failure", async () => {
    // That route does not exist on production instances, so calling it
    // speculatively turns one clean failure into two. The branch is gated on the
    // error's wording, not on the hostname.
    const t = convexTest(schema, modules);
    const calls = stubClerk({
      fapiSignIn: { status: 422, body: fapiError("ticket_invalid", "that ticket is expired") },
    });

    const res = await exchange(t, { body: { key: MACHINE_KEY } });

    expect(res.status).toBe(502);
    expect(calls.some((c) => c.url.includes("/v1/dev_browser"))).toBe(false);
    // One attempt only — no blind retry either.
    expect(calls.filter((c) => c.url.includes("sign_ins"))).toHaveLength(1);
  });

  test("a failed dev-browser fetch is 502, and does not retry the sign-in", async () => {
    const t = convexTest(schema, modules);
    const calls = stubClerk({
      fapiSignIn: { status: 401, body: fapiError("dev_browser_unauthenticated", "nope") },
      devBrowser: { status: 500, body: {} },
    });

    const res = await exchange(t, { body: { key: MACHINE_KEY } });

    expect(res.status).toBe(502);
    expect(calls.filter((c) => c.url.includes("sign_ins"))).toHaveLength(1);
  });

  test("a retry that still fails is 502, not an endless loop", async () => {
    const t = convexTest(schema, modules);
    const calls = stubClerk({
      fapiSignIn: [
        { status: 401, body: fapiError("dev_browser_unauthenticated", "nope") },
        { status: 401, body: fapiError("dev_browser_unauthenticated", "still nope") },
      ],
    });

    const res = await exchange(t, { body: { key: MACHINE_KEY } });

    expect(res.status).toBe(502);
    // Exactly two attempts, and exactly one dev-browser fetch.
    expect(calls.filter((c) => c.url.includes("sign_ins"))).toHaveLength(2);
    expect(calls.filter((c) => c.url.includes("/v1/dev_browser"))).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Session reuse
// ---------------------------------------------------------------------------

describe("success — reuse the caller's session", () => {
  test("honours a sessionId the caller owns and that is active", async () => {
    const t = convexTest(schema, modules);
    const calls = stubClerk({
      getSession: { status: 200, body: session(OWN_SESSION, SUBJECT, "active") },
    });

    const res = await exchange(t, { body: { key: MACHINE_KEY, sessionId: OWN_SESSION } });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ token: JWT, sessionId: OWN_SESSION });

    // No ticket, no Frontend API hop. This is the cache doing its job — it is
    // what keeps the browser-shaped call on the rare path.
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "POST https://api.clerk.com/v1/api_keys/verify",
      `GET https://api.clerk.com/v1/sessions/${OWN_SESSION}`,
      `POST https://api.clerk.com/v1/sessions/${OWN_SESSION}/tokens/convex`,
    ]);
    expect(calls.some((c) => c.url.includes("sign_in_tokens"))).toBe(false);
  });

  test.each([
    ["revoked", "revoked"],
    ["expired", "expired"],
    ["pending", "pending"],
  ])("ignores an owned but %s session and creates a fresh one", async (_label, status) => {
    // Ownership alone is not enough: minting against a session Clerk has already
    // ended would hand out a token backed by nothing.
    const t = convexTest(schema, modules);
    const calls = stubClerk({
      getSession: { status: 200, body: session(OWN_SESSION, SUBJECT, status) },
    });

    const res = await exchange(t, { body: { key: MACHINE_KEY, sessionId: OWN_SESSION } });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ token: JWT, sessionId: CREATED_SESSION });
    expect(calls.some((c) => c.url.includes("sign_in_tokens"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The ownership check — the load-bearing one
// ---------------------------------------------------------------------------

describe("session ownership", () => {
  test("a sessionId belonging to someone else NEVER produces a token for them", async () => {
    // The mint endpoint issues a token for whatever session id it is given, with
    // no reference to the key we verified. Without this check the endpoint would
    // be a token oracle: any caller with a valid key of their own could name
    // another user's session and be handed a JWT for that user.
    const t = convexTest(schema, modules);
    const calls = stubClerk({
      getSession: { status: 200, body: session(OTHER_SESSION, OTHER_SUBJECT, "active") },
    });

    const res = await exchange(t, { body: { key: MACHINE_KEY, sessionId: OTHER_SESSION } });

    // Still a success — the caller's own key is fine, they just do not get to
    // choose whose session it is. A distinct error would tell them whether the
    // session id they guessed exists.
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ token: JWT, sessionId: CREATED_SESSION });

    // The claim that matters: the foreign session id reached the lookup and
    // stopped there. It is in no other upstream URL, and above all not the
    // mint's.
    const mint = calls.find((c) => c.url.includes("/tokens/"));
    expect(mint?.url).toBe(
      `https://api.clerk.com/v1/sessions/${CREATED_SESSION}/tokens/convex`,
    );
    expect(mint?.url).not.toContain(OTHER_SESSION);
    // A ticket WAS minted, for the verified subject and nobody else.
    const ticket = calls.find((c) => c.url.includes("sign_in_tokens"));
    expect(ticket?.body).toEqual({ user_id: SUBJECT, expires_in_seconds: 60 });
  });

  test("a session id that is not shaped like one never reaches an upstream URL", async () => {
    // `sessionId` is the only client value interpolated into an upstream PATH.
    // Unchecked, a `../` in it would aim the GET at a different Clerk resource.
    const t = convexTest(schema, modules);
    const calls = stubClerk({});

    const res = await exchange(t, {
      body: { key: MACHINE_KEY, sessionId: "../users/user_victim" },
    });

    expect(res.status).toBe(200);
    expect(calls.some((c) => c.method === "GET")).toBe(false);
    expect(calls.every((c) => !c.url.includes(".."))).toBe(true);
    expect(calls.every((c) => !c.url.includes("user_victim"))).toBe(true);
  });

  test("a session id CLERK returns that is not shaped like one is refused too", async () => {
    // The created id goes into the mint URL's path. It comes from Clerk rather
    // than a client, but the rule that no unvalidated string becomes a path
    // segment does not get an exception for a trusted source.
    const t = convexTest(schema, modules);
    const calls = stubClerk({
      fapiSignIn: {
        status: 200,
        body: { response: { created_session_id: "../../users/user_victim" } },
      },
    });

    const res = await exchange(t, { body: { key: MACHINE_KEY } });

    expect(res.status).toBe(502);
    expect(calls.some((c) => c.url.includes("/tokens/"))).toBe(false);
    expect(calls.every((c) => !c.url.includes("user_victim"))).toBe(true);
  });

  test("a 404 on the session lookup falls through to creating one", async () => {
    const t = convexTest(schema, modules);
    const calls = stubClerk({ getSession: { status: 404, body: {} } });

    const res = await exchange(t, { body: { key: MACHINE_KEY, sessionId: OWN_SESSION } });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ token: JWT, sessionId: CREATED_SESSION });
    expect(calls.some((c) => c.url.includes("sign_in_tokens"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Rejections — one shape for all of them
// ---------------------------------------------------------------------------

describe("credential rejections are indistinguishable", () => {
  /**
   * Run one rejection scenario and return everything a caller can observe.
   *
   * Headers included, not just status and body. A response that differed only by
   * a header — a `x-clerk-status`, a varying `cache-control`, a length that
   * tracked the upstream message — would be exactly as good an oracle as a
   * different body, and would sail past a status+body comparison.
   */
  async function reject(config: ClerkConfig, body: unknown) {
    const t = convexTest(schema, modules);
    stubClerk(config);
    const res = await exchange(t, { body });
    return {
      status: res.status,
      text: await res.text(),
      headers: [...res.headers.entries()].sort(),
    };
  }

  test("every credential rejection is byte-identical, headers included", async () => {
    const revoked = await reject(
      { verify: { status: 200, body: validApiKey({ revoked: true }) } },
      { key: MACHINE_KEY },
    );
    const unknown = await reject(
      { verify: { status: 404, body: { errors: [{ message: "not found" }] } } },
      { key: MACHINE_KEY },
    );
    const expired = await reject(
      { verify: { status: 200, body: validApiKey({ expired: true }) } },
      { key: MACHINE_KEY },
    );
    const orgScoped = await reject(
      { verify: { status: 200, body: validApiKey({ subject: "org_2xhFjEI5X2qWRvt" }) } },
      { key: MACHINE_KEY },
    );
    const machineScoped = await reject(
      { verify: { status: 200, body: validApiKey({ subject: "mch_2xhFjEI5X2qWRvt" }) } },
      { key: MACHINE_KEY },
    );
    const missing = await reject({}, {});
    // An over-length key is refused before it is ever sent upstream, and it must
    // be just another indistinguishable rejection rather than a new class.
    const overLong = await reject({}, { key: "a".repeat(513) });

    // Compared against EACH OTHER, not against a literal: a future "helpful"
    // message fails this comparison instead of quietly becoming a way to
    // classify keys.
    for (const outcome of [unknown, expired, orgScoped, machineScoped, missing, overLong]) {
      expect(outcome).toEqual(revoked);
    }
    expect(revoked.status).toBe(401);
    expect(revoked.text).toBe('{"error":"invalid machine key"}');
  });

  test("a rate-limited verify is grouped with the upstream failures, NOT the rejections", async () => {
    // The load-bearing one. Clerk rate-limits `/api_keys/verify` per INSTANCE,
    // so a 429 is shared-resource contention — and contention an attacker can
    // induce by spraying junk keys. If it answered 401, anyone able to exhaust
    // the instance's verify budget could make every legitimate client believe
    // its key had been revoked and discard it, turning a transient denial of
    // service into a persistent one carried out by the victims.
    const rateLimited = await reject({ verify: { status: 429, body: {} } }, { key: MACHINE_KEY });
    const timedOut = await reject({ verify: { status: 408, body: {} } }, { key: MACHINE_KEY });
    const serverError = await reject({ verify: { status: 500, body: {} } }, { key: MACHINE_KEY });
    const unreachable = await reject({ verify: "throw" }, { key: MACHINE_KEY });
    const rejected = await reject({ verify: { status: 401, body: {} } }, { key: MACHINE_KEY });

    // Indistinguishable from the other upstream failures…
    for (const outcome of [timedOut, serverError, unreachable]) {
      expect(outcome).toEqual(rateLimited);
    }
    expect(rateLimited.status).toBe(502);
    expect(rateLimited.text).toBe('{"error":"auth upstream unavailable"}');
    // …and emphatically NOT the same answer a bad key gets.
    expect(rateLimited).not.toEqual(rejected);
    expect(rejected.status).toBe(401);
  });

  test("a 400 from verify is a 401 too, and never leaks Clerk's body", async () => {
    const outcome = await reject(
      {
        verify: {
          status: 400,
          body: { errors: [{ message: "malformed secret", long_message: "internal detail" }] },
        },
      },
      { key: "not-a-key" },
    );
    expect(outcome.status).toBe(401);
    expect(outcome.text).toBe('{"error":"invalid machine key"}');
    expect(outcome.text).not.toContain("malformed");
    expect(outcome.text).not.toContain("internal detail");
  });
});

// ---------------------------------------------------------------------------
// Upstream and configuration failures
// ---------------------------------------------------------------------------

describe("fails closed and upstream", () => {
  test.each([["CLERK_SECRET_KEY"], ["CLERK_FRONTEND_API_URL"]])(
    "answers 503 without calling Clerk when %s is unset",
    async (name) => {
      // The Frontend API URL is checked up front even though only the create
      // path needs it: a deployment missing it would otherwise serve every reuse
      // request happily and fail hours later, on a different request, when some
      // client's session expired.
      delete process.env[name];
      const t = convexTest(schema, modules);
      const calls = stubClerk({});

      const res = await exchange(t, { body: { key: MACHINE_KEY } });

      expect(res.status).toBe(503);
      await expect(res.text()).resolves.toBe('{"error":"machine auth is not configured"}');
      expect(calls).toHaveLength(0);
    },
  );

  test.each([
    ["an explicit http:// origin", "http://clerk.neonbinder.test"],
    ["a value that is not a URL", "   "],
    ["a scheme with no host", "https://"],
    ["a non-http scheme", "ftp://clerk.neonbinder.test"],
  ])("answers 503 for %s, without calling Clerk", async (_label, configured) => {
    // http:// is REFUSED rather than upgraded. The sign-in ticket is a bearer
    // credential that signs its holder in as the subject and it travels in this
    // request body; cleartext is never an acceptable transport for it, and
    // silently rewriting the scheme would teach an operator that their next
    // genuine mistake would also be quietly fixed.
    //
    // The other three used to pass the truthiness check and then throw an
    // unhandled TypeError inside `new URL()` at request time — a fourth response
    // shape from an endpoint whose whole contract is three constant bodies, and
    // one whose message could echo the configured origin.
    process.env.CLERK_FRONTEND_API_URL = configured;
    const t = convexTest(schema, modules);
    const calls = stubClerk({});

    const res = await exchange(t, { body: { key: MACHINE_KEY } });

    expect(res.status).toBe(503);
    await expect(res.text()).resolves.toBe('{"error":"machine auth is not configured"}');
    expect(calls).toHaveLength(0);
  });

  test("a misconfigured origin is never echoed back or logged", async () => {
    process.env.CLERK_FRONTEND_API_URL = "http://sneaky-internal-host.corp";
    const t = convexTest(schema, modules);
    const logs = captureLogs();
    let body: string;
    try {
      stubClerk({});
      const res = await exchange(t, { body: { key: MACHINE_KEY } });
      body = await res.text();
    } finally {
      logs.restore();
    }

    expect(body).not.toContain("sneaky-internal-host");
    expect(logs.lines.join("\n")).not.toContain("sneaky-internal-host");
    // The stage still distinguishes "unset" from "unusable" for an operator.
    expect(exchangeLines(logs.lines)[0]).toEqual({
      msg: "machine_token_exchange_failed",
      stage: "unconfigured_fapi_invalid",
    });
  });

  test("an over-length key is refused BEFORE it is forwarded upstream", async () => {
    // The amplification bound. Everything up to the verify call is
    // unauthenticated, and the presented key used to be copied verbatim into a
    // request body sent to api.clerk.com carrying CLERK_SECRET_KEY — so an
    // anonymous caller could size our authenticated outbound traffic.
    const t = convexTest(schema, modules);
    const calls = stubClerk({});

    const res = await exchange(t, { body: { key: "a".repeat(513) } });

    expect(res.status).toBe(401);
    await expect(res.text()).resolves.toBe('{"error":"invalid machine key"}');
    // Nothing left the deployment at all.
    expect(calls).toHaveLength(0);
  });

  test("a key exactly at the limit is still forwarded", async () => {
    // Guards the bound against being off by one in the strict direction, which
    // would reject legitimate keys if Clerk's secret format ever grew.
    const t = convexTest(schema, modules);
    const calls = stubClerk({ verify: { status: 401, body: {} } });

    const res = await exchange(t, { body: { key: "a".repeat(512) } });

    expect(res.status).toBe(401);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/api_keys/verify");
  });

  test("an over-length sessionId is ignored like any other malformed id", async () => {
    // Not a credential failure, so it falls through to creating a session — and
    // it never reaches an upstream URL, which is the amplification half.
    const t = convexTest(schema, modules);
    const calls = stubClerk({});
    const huge = `sess_${"a".repeat(500)}`;

    const res = await exchange(t, { body: { key: MACHINE_KEY, sessionId: huge } });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ token: JWT, sessionId: CREATED_SESSION });
    expect(calls.some((c) => c.method === "GET")).toBe(false);
    expect(calls.every((c) => !c.url.includes("aaaaaaaaaa"))).toBe(true);
  });

  test("a sessionId at the length limit is still honoured", async () => {
    const t = convexTest(schema, modules);
    const atLimit = `sess_${"a".repeat(120)}`;
    const calls = stubClerk({
      getSession: { status: 200, body: session(atLimit, SUBJECT, "active") },
    });

    const res = await exchange(t, { body: { key: MACHINE_KEY, sessionId: atLimit } });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ token: JWT, sessionId: atLimit });
    expect(calls.some((c) => c.method === "GET")).toBe(true);
  });

  test("a Clerk 500 on verify is 502, not 401", async () => {
    // A 401 here would tell a client with a perfectly good key to throw it away.
    const t = convexTest(schema, modules);
    stubClerk({ verify: { status: 500, body: {} } });

    const res = await exchange(t, { body: { key: MACHINE_KEY } });

    expect(res.status).toBe(502);
    await expect(res.text()).resolves.toBe('{"error":"auth upstream unavailable"}');
  });

  test("a network failure on verify is 502", async () => {
    const t = convexTest(schema, modules);
    stubClerk({ verify: "throw" });

    const res = await exchange(t, { body: { key: MACHINE_KEY } });
    expect(res.status).toBe(502);
  });

  test("a non-JSON 200 from verify is 502, not a silent success", async () => {
    const t = convexTest(schema, modules);
    stubClerk({ verify: { status: 200, raw: "<html>gateway</html>" } });

    const res = await exchange(t, { body: { key: MACHINE_KEY } });
    expect(res.status).toBe(502);
  });

  test.each([
    // Verify-stage transients. These are the only 502s where the key has NOT
    // been verified, and they are here rather than with the 401s because a
    // rate-limited or timed-out verify says nothing about the credential — see
    // VERIFY_TRANSIENT_STATUSES.
    ["a rate-limited verify (429)", { verify: { status: 429, body: {} } }],
    ["a timed-out verify (408)", { verify: { status: 408, body: {} } }],
    ["a refused sign-in token", { signInToken: { status: 403, body: {} } }],
    [
      "a sign-in token with no token field",
      { signInToken: { status: 200, body: { id: "sit_1", status: "pending" } } },
    ],
    ["an unreachable sign-in token endpoint", { signInToken: "throw" as const }],
    ["a Frontend API 4xx", { fapiSignIn: { status: 422, body: fapiError("x", "y") } }],
    ["a Frontend API 5xx", { fapiSignIn: { status: 503, body: {} } }],
    ["an unreachable Frontend API", { fapiSignIn: "throw" as const }],
    ["a sign-in with no created_session_id", { fapiSignIn: { status: 200, body: {} } }],
    ["a failed mint", { mint: { status: 404, body: {} } }],
    ["a mint with no jwt", { mint: { status: 200, body: { object: "token" } } }],
  ] as Array<[string, ClerkConfig]>)(
    "%s answers 502 rather than 401",
    async (_label, config) => {
      const t = convexTest(schema, modules);
      stubClerk(config);

      const res = await exchange(t, { body: { key: MACHINE_KEY } });

      expect(res.status).toBe(502);
      await expect(res.text()).resolves.toBe('{"error":"auth upstream unavailable"}');
    },
  );

  test("a Frontend API failure is logged with its stage and status, and no body", async () => {
    const t = convexTest(schema, modules);
    const logs = captureLogs();
    try {
      stubClerk({
        fapiSignIn: {
          status: 422,
          body: fapiError("ticket_expired", "internal-host-9f2c.clerk.internal"),
        },
      });
      const res = await exchange(t, { body: { key: MACHINE_KEY } });
      expect(res.status).toBe(502);
    } finally {
      logs.restore();
    }

    const failures = exchangeLines(logs.lines);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toEqual({
      msg: "machine_token_exchange_failed",
      stage: "fapi_sign_in",
      status: 422,
      keyId: KEY_ID,
    });
    expect(logs.lines.join("\n")).not.toContain("clerk.internal");
  });

  test("a Clerk 500 on the session lookup is 502, not a quiet fall-through", async () => {
    // Creating a session while Clerk is misbehaving would hide the outage behind
    // a slow path.
    const t = convexTest(schema, modules);
    const calls = stubClerk({ getSession: { status: 503, body: {} } });

    const res = await exchange(t, { body: { key: MACHINE_KEY, sessionId: OWN_SESSION } });

    expect(res.status).toBe(502);
    expect(calls.some((c) => c.url.includes("sign_in_tokens"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Log hygiene
// ---------------------------------------------------------------------------

describe("logging never carries anything secret", () => {
  test("the success line names the public key id and the subject, and nothing else", async () => {
    const t = convexTest(schema, modules);
    const logs = captureLogs();
    try {
      stubClerk({});
      const res = await exchange(t, { body: { key: MACHINE_KEY } });
      expect(res.status).toBe(200);
    } finally {
      logs.restore();
    }

    const lines = exchangeLines(logs.lines);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({
      msg: "machine_token_exchange",
      keyId: KEY_ID,
      subject: SUBJECT,
      reusedSession: false,
    });
  });

  test("reusedSession distinguishes the two paths", async () => {
    const t = convexTest(schema, modules);
    const logs = captureLogs();
    try {
      stubClerk({
        getSession: { status: 200, body: session(OWN_SESSION, SUBJECT, "active") },
      });
      await exchange(t, { body: { key: MACHINE_KEY, sessionId: OWN_SESSION } });
    } finally {
      logs.restore();
    }

    expect(exchangeLines(logs.lines)[0]).toMatchObject({ reusedSession: true });
  });

  // One case per DISTINCT logging call site, not per interesting-sounding
  // scenario. The rejected-key case in particular exists because the 4xx branch
  // of verify is its own `logFailure` call — the branch physically closest to
  // the presented secret, and the one a "let's log what they sent" change would
  // land in first. The ticket and dev-browser cases are the same argument for
  // the two bearer credentials this file gained with the sign-in-token path.
  test.each([
    ["success", {} as ClerkConfig],
    ["rejected key (verify 4xx)", { verify: { status: 401, body: {} } }],
    ["revoked key (verify 200)", { verify: { status: 200, body: validApiKey({ revoked: true }) } }],
    ["bad subject", { verify: { status: 200, body: validApiKey({ subject: "org_2xhF" }) } }],
    ["unparseable verify", { verify: { status: 200, raw: "<html>" } }],
    ["upstream 500", { verify: { status: 500, body: {} } }],
    ["rate-limited verify", { verify: { status: 429, body: {} } }],
    ["network failure", { verify: "throw" as const }],
    ["session lookup 500", { getSession: { status: 500, body: {} } }],
    ["refused sign-in token", { signInToken: { status: 403, body: {} } }],
    ["unreachable sign-in token", { signInToken: "throw" as const }],
    ["failed FAPI sign-in", { fapiSignIn: { status: 422, body: fapiError("x", "y") } }],
    ["unreachable FAPI", { fapiSignIn: "throw" as const }],
    [
      "dev-browser retry",
      {
        fapiSignIn: [
          { status: 401, body: fapiError("dev_browser_unauthenticated", "nope") },
          { status: 200, body: { response: { created_session_id: CREATED_SESSION } } },
        ],
      },
    ],
    [
      "failed dev-browser",
      {
        fapiSignIn: { status: 401, body: fapiError("dev_browser_unauthenticated", "nope") },
        devBrowser: "throw" as const,
      },
    ],
    ["failed mint", { mint: { status: 500, body: {} } }],
  ] as Array<[string, ClerkConfig]>)(
    "no output contains any secret, whole or partial — %s path",
    async (_label, config) => {
      const t = convexTest(schema, modules);
      const logs = captureLogs();
      try {
        stubClerk(config);
        await exchange(t, { body: { key: MACHINE_KEY, sessionId: OWN_SESSION } });
      } finally {
        logs.restore();
      }

      // Asserted over EVERYTHING printed, on every console channel, not a
      // hand-picked line: the point is that no code path anywhere reaches a
      // console with these values. The ticket and the dev-browser token are
      // bearer credentials exactly like the api key and the JWT — a ticket signs
      // its holder in as the subject, and the dev-browser token rides in a query
      // string, which is the classic way a secret reaches a log via a URL.
      //
      // Fragments as well as whole values: a redactor that keeps a prefix "for
      // correlation" is the realistic regression, and it passes a whole-string
      // check while still leaking usable material.
      const all = logs.lines.join("\n");
      for (const [label, fragment] of SECRET_FRAGMENTS) {
        expect(all, `leaked ${label}`).not.toContain(fragment);
      }
      // Non-vacuity: the public key id is the ONE `ak_…` value that may be
      // logged, and it must share no prefix with the secret — otherwise every
      // assertion above would be unfalsifiable on the success path, which is
      // precisely the trap the previous fixture fell into.
      expect(KEY_ID).not.toContain(MACHINE_KEY.slice(0, 12));
      expect(MACHINE_KEY).not.toContain(KEY_ID);
    },
  );

  test("a Clerk error body is never echoed into the log", async () => {
    const t = convexTest(schema, modules);
    const logs = captureLogs();
    try {
      stubClerk({
        verify: {
          status: 422,
          body: {
            errors: [
              { message: "unprocessable", long_message: "internal-host-9f2c.clerk.internal" },
            ],
          },
        },
      });
      await exchange(t, { body: { key: MACHINE_KEY } });
    } finally {
      logs.restore();
    }

    const all = logs.lines.join("\n");
    expect(all).not.toContain("clerk.internal");
    expect(all).not.toContain("unprocessable");
    // The status still survives — that is the part an operator can act on.
    expect(exchangeLines(logs.lines)[0]).toMatchObject({ stage: "verify", status: 422 });
  });

  test("a failure before verification names no key id at all", async () => {
    // There is no public id to name yet, and deriving one from the presented
    // secret is exactly the mistake this file is arranged to avoid.
    const t = convexTest(schema, modules);
    const logs = captureLogs();
    try {
      stubClerk({ verify: { status: 401, body: {} } });
      await exchange(t, { body: { key: MACHINE_KEY } });
    } finally {
      logs.restore();
    }

    const line = exchangeLines(logs.lines)[0];
    expect(line).toEqual({
      msg: "machine_token_exchange_failed",
      stage: "verify",
      status: 401,
    });
    expect(line).not.toHaveProperty("keyId");
  });
});
