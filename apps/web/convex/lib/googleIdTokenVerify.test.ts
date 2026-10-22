/**
 * NEO-355 — unit tests for the Google id-token verifier.
 *
 * `verifyGoogleIdToken` is pure apart from the injected `fetchImpl`, so these
 * tests hand it a recording stub and assert on both the verdict and on what was
 * (or was not) sent to tokeninfo. The adversarial cases try to reach
 * `{ ok: true }` without a genuinely valid identity: wrong issuer, audience
 * prefix and suffix tricks, email case / whitespace / allowlist-hole tricks,
 * and header shapes that carry no token.
 *
 * Fixtures are well-formed JWTs (`makeJwt`) whose UNVERIFIED payload already
 * names our audience and caller, because anything else is refused before
 * tokeninfo is asked. Most claim-check cases therefore pair a "right" unverified
 * payload with a "wrong" tokeninfo answer, which is exactly the property that
 * matters: the unverified decode can refuse, but it never grants.
 *
 * The token must never appear in a verdict. It legitimately appears in exactly
 * one place: the tokeninfo POST body (never a URL).
 */

import { describe, expect, test, vi } from "vitest";
import {
  GOOGLE_TOKENINFO_URL,
  verifyGoogleIdToken,
  type VerifyGoogleIdTokenOptions,
} from "./googleIdTokenVerify";

const AUDIENCE = "https://happy-animal-123.convex.site";
const CALLER = "browser-runtime@example-project.iam.gserviceaccount.com";

type Claims = Record<string, unknown>;

/** UTF-8 text → unpadded base64url, as a JWT encoder writes each segment. */
function b64url(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * A well-formed (unsigned-for-real) JWT carrying `payload`. Only Google's
 * tokeninfo stub decides whether it is genuine; the verifier reads the
 * payload unverified, and only to refuse early.
 */
function makeJwt(payload: unknown, signature = "sig-do-not-leak-0123456789"): string {
  const header = b64url(JSON.stringify({ alg: "RS256", kid: "test-kid", typ: "JWT" }));
  return `${header}.${b64url(JSON.stringify(payload))}.${signature}`;
}

/** The unverified payload a genuine token for our caller would carry. */
function unverifiedClaims(overrides: Claims = {}): Claims {
  return {
    iss: "https://accounts.google.com",
    aud: AUDIENCE,
    email: CALLER,
    email_verified: true,
    exp: 9_999_999_999,
    ...overrides,
  };
}

const TOKEN = makeJwt(unverifiedClaims());

function goodClaims(overrides: Claims = {}): Claims {
  return {
    iss: "https://accounts.google.com",
    aud: AUDIENCE,
    email: CALLER,
    email_verified: "true",
    exp: "9999999999",
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A fetch stub that answers every call with `respond()` and records the URLs. */
function stubFetch(respond: () => Response | Promise<Response>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = vi.fn(async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return respond();
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function verify(
  authorization: string | null | undefined,
  fetchImpl: typeof fetch,
  overrides: Partial<VerifyGoogleIdTokenOptions> = {},
) {
  return verifyGoogleIdToken(authorization, {
    audience: AUDIENCE,
    allowedEmails: CALLER,
    fetchImpl,
    ...overrides,
  });
}

const bearer = (token = TOKEN) => `Bearer ${token}`;

describe("verifyGoogleIdToken: accepts", () => {
  test("a Google token for our audience from an allowlisted caller is ok and names the caller", async () => {
    const { fetchImpl, calls } = stubFetch(() => jsonResponse(200, goodClaims()));
    expect(await verify(bearer(), fetchImpl)).toEqual({ ok: true, email: CALLER });
    expect(calls).toHaveLength(1);
  });

  test("the token goes to tokeninfo as a POST form body, never in the URL", async () => {
    const { fetchImpl, calls } = stubFetch(() => jsonResponse(200, goodClaims()));
    await verify(bearer(), fetchImpl);
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0];
    expect(url).toBe(GOOGLE_TOKENINFO_URL);
    expect(new URL(url).search).toBe("");
    for (const fragment of TOKEN.split(".")) expect(url).not.toContain(fragment);
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("content-type")).toBe(
      "application/x-www-form-urlencoded",
    );
    expect(typeof init?.body).toBe("string");
    const form = new URLSearchParams(init?.body as string);
    expect([...form.keys()]).toEqual(["id_token"]);
    expect(form.get("id_token")).toBe(TOKEN);
  });

  test("the verdict's email is Google's, not the unverified payload's", async () => {
    const OTHER = "other-runtime@example-project.iam.gserviceaccount.com";
    const { fetchImpl } = stubFetch(() => jsonResponse(200, goodClaims({ email: OTHER })));
    const result = await verify(bearer(), fetchImpl, { allowedEmails: [CALLER, OTHER] });
    expect(result).toEqual({ ok: true, email: OTHER });
  });

  test.each(["accounts.google.com", "https://accounts.google.com"])(
    "issuer spelled %s is accepted",
    async (iss) => {
      const { fetchImpl } = stubFetch(() => jsonResponse(200, goodClaims({ iss })));
      expect((await verify(bearer(), fetchImpl)).ok).toBe(true);
    },
  );

  test("a trailing slash on either audience is not a different audience", async () => {
    const a = stubFetch(() => jsonResponse(200, goodClaims({ aud: `${AUDIENCE}/` })));
    expect((await verify(bearer(), a.fetchImpl)).ok).toBe(true);
    const b = stubFetch(() => jsonResponse(200, goodClaims()));
    expect((await verify(bearer(), b.fetchImpl, { audience: `${AUDIENCE}//` })).ok).toBe(true);
  });

  test("the caller email is matched case-insensitively and returned lowercased", async () => {
    const { fetchImpl } = stubFetch(() =>
      jsonResponse(200, goodClaims({ email: CALLER.toUpperCase() })),
    );
    expect(await verify(bearer(), fetchImpl)).toEqual({ ok: true, email: CALLER });
  });

  test("allowlist entries are trimmed and lowercased; blank entries are ignored", async () => {
    const { fetchImpl } = stubFetch(() => jsonResponse(200, goodClaims()));
    const allowed = ` , Other@Example.com ,  ${CALLER.toUpperCase()} ,, `;
    expect((await verify(bearer(), fetchImpl, { allowedEmails: allowed })).ok).toBe(true);
  });

  test("an already-split allowlist array works", async () => {
    const { fetchImpl } = stubFetch(() => jsonResponse(200, goodClaims()));
    expect((await verify(bearer(), fetchImpl, { allowedEmails: ["x@y.z", CALLER] })).ok).toBe(true);
  });

  test("the scheme word is case-insensitive", async () => {
    const { fetchImpl } = stubFetch(() => jsonResponse(200, goodClaims()));
    expect((await verify(`bearer ${TOKEN}`, fetchImpl)).ok).toBe(true);
  });
});

describe("verifyGoogleIdToken: no usable token (401, tokeninfo never asked)", () => {
  test.each([
    ["null", null, "missing_token"],
    ["undefined", undefined, "missing_token"],
    ["empty string", "", "missing_token"],
    ["whitespace only", "   ", "missing_token"],
    ["Bearer with nothing after it", "Bearer ", "malformed_authorization"],
    ["Bearer with only spaces after it", "Bearer    ", "malformed_authorization"],
    ["bare scheme word", "Bearer", "malformed_authorization"],
    ["Basic scheme", `Basic ${TOKEN}`, "malformed_authorization"],
    ["raw token with no scheme", TOKEN, "malformed_authorization"],
    ["two tokens", `Bearer ${TOKEN} ${TOKEN}`, "malformed_authorization"],
    ["token longer than any Google token", `Bearer ${"a".repeat(8_193)}`, "malformed_authorization"],
    ["Bearer garbage", "Bearer garbage", "malformed_token"],
    ["one dot", `Bearer ${TOKEN.split(".").slice(0, 2).join(".")}`, "malformed_token"],
    ["four segments", `Bearer ${TOKEN}.extra`, "malformed_token"],
    ["an empty signature segment", `Bearer ${TOKEN.split(".").slice(0, 2).join(".")}.`, "malformed_token"],
    ["an empty payload segment", `Bearer ${TOKEN.split(".")[0]}..sig`, "malformed_token"],
    ["standard base64 characters", `Bearer ${TOKEN.split(".")[0]}.ab+/.sig`, "malformed_token"],
    ["padded base64", `Bearer ${TOKEN.split(".")[0]}.${b64url("{}")}==.sig`, "malformed_token"],
    ["a payload of impossible length", "Bearer a.b.c", "malformed_token"],
    ["a payload that is not JSON", `Bearer ${makeJwt("x").split(".")[0]}.${b64url("not json")}.sig`, "malformed_token"],
    ["a payload that is not UTF-8", `Bearer ${TOKEN.split(".")[0]}._w.sig`, "malformed_token"],
    ["a payload that is JSON null", `Bearer ${makeJwt(null)}`, "malformed_token"],
    ["a payload that is a JSON array", `Bearer ${makeJwt([unverifiedClaims()])}`, "malformed_token"],
    ["a payload that is a JSON string", `Bearer ${makeJwt("ok")}`, "malformed_token"],
    ["a payload that is a JSON number", `Bearer ${makeJwt(1)}`, "malformed_token"],
  ])("%s", async (_name, header, reason) => {
    const { fetchImpl, calls } = stubFetch(() => jsonResponse(200, goodClaims()));
    expect(await verify(header, fetchImpl)).toEqual({ ok: false, status: 401, reason });
    expect(calls).toHaveLength(0);
  });
});

describe("verifyGoogleIdToken: the unverified payload refuses before the network", () => {
  test.each<[string, unknown]>([
    ["another deployment", "https://other-animal-999.convex.site"],
    ["a longer host sharing our prefix", `${AUDIENCE}.evil.com`],
    ["our URL as a path prefix", `${AUDIENCE}/evil`],
    ["different case", AUDIENCE.toUpperCase()],
    ["empty", ""],
    ["an array containing ours", [AUDIENCE]],
    ["a number", 5],
    ["null", null],
    ["absent", undefined],
  ])("unverified audience %s is audience_mismatch (401) and tokeninfo is never called", async (_n, aud) => {
    const claims = unverifiedClaims();
    if (aud === undefined) delete claims.aud;
    else claims.aud = aud;
    const { fetchImpl, calls } = stubFetch(() => jsonResponse(200, goodClaims()));
    expect(await verify(bearer(makeJwt(claims)), fetchImpl)).toEqual({
      ok: false,
      status: 401,
      reason: "audience_mismatch",
    });
    expect(calls).toHaveLength(0);
  });

  test.each<[string, unknown]>([
    ["a different account", "attacker@example.com"],
    ["our caller with a trailing domain label", `${CALLER}.evil.com`],
    ["our caller plus-addressed", CALLER.replace("@", "+x@")],
    ["empty", ""],
    ["an array containing ours", [CALLER]],
    ["a number", 7],
    ["null", null],
    ["absent", undefined],
  ])("unverified email %s is email_not_allowed (403) and tokeninfo is never called", async (_n, email) => {
    const claims = unverifiedClaims();
    if (email === undefined) delete claims.email;
    else claims.email = email;
    const { fetchImpl, calls } = stubFetch(() => jsonResponse(200, goodClaims()));
    expect(await verify(bearer(makeJwt(claims)), fetchImpl)).toEqual({
      ok: false,
      status: 403,
      reason: "email_not_allowed",
    });
    expect(calls).toHaveLength(0);
  });

  test("the audience is checked before the email: both wrong is still 401", async () => {
    const token = makeJwt(unverifiedClaims({ aud: "https://x.example", email: "a@b.c" }));
    const { fetchImpl, calls } = stubFetch(() => jsonResponse(200, goodClaims()));
    expect(await verify(bearer(token), fetchImpl)).toMatchObject({ ok: false, status: 401 });
    expect(calls).toHaveLength(0);
  });

  test("the unverified checks normalise like the verified ones (slash, case, padding)", async () => {
    const token = makeJwt(
      unverifiedClaims({ aud: `${AUDIENCE}/`, email: ` ${CALLER.toUpperCase()} ` }),
    );
    const { fetchImpl, calls } = stubFetch(() => jsonResponse(200, goodClaims()));
    expect(await verify(bearer(token), fetchImpl)).toEqual({ ok: true, email: CALLER });
    expect(calls).toHaveLength(1);
  });
});

describe("verifyGoogleIdToken: the unverified payload never grants", () => {
  test.each<[string, () => Response, { status: number; reason: string }]>([
    ["tokeninfo rejects the token", () => jsonResponse(400, { error: "invalid_token" }), { status: 401, reason: "token_rejected" }],
    ["tokeninfo names another issuer", () => jsonResponse(200, goodClaims({ iss: "https://evil.example.com" })), { status: 401, reason: "issuer_mismatch" }],
    ["tokeninfo names another audience", () => jsonResponse(200, goodClaims({ aud: "https://other-animal-999.convex.site" })), { status: 401, reason: "audience_mismatch" }],
    ["tokeninfo omits the audience", () => jsonResponse(200, goodClaims({ aud: undefined })), { status: 401, reason: "audience_mismatch" }],
    ["tokeninfo says the email is unverified", () => jsonResponse(200, goodClaims({ email_verified: "false" })), { status: 403, reason: "email_unverified" }],
    ["tokeninfo names another email", () => jsonResponse(200, goodClaims({ email: "attacker@example.com" })), { status: 403, reason: "email_not_allowed" }],
    ["tokeninfo omits the email", () => jsonResponse(200, goodClaims({ email: undefined })), { status: 403, reason: "email_not_allowed" }],
    ["tokeninfo returns an empty object", () => jsonResponse(200, {}), { status: 401, reason: "issuer_mismatch" }],
  ])("a perfect unverified payload is still refused when %s", async (_n, respond, expected) => {
    const { fetchImpl, calls } = stubFetch(respond);
    expect(await verify(bearer(), fetchImpl)).toEqual({ ok: false, ...expected });
    expect(calls).toHaveLength(1);
  });
});

describe("verifyGoogleIdToken: configuration fails closed before the network", () => {
  test.each([undefined, "", "   ", "/", " / "])(
    "audience %j is audience_unset (401) and tokeninfo is never called",
    async (audience) => {
      const { fetchImpl, calls } = stubFetch(() => jsonResponse(200, goodClaims({ aud: "" })));
      expect(await verify(bearer(), fetchImpl, { audience })).toEqual({
        ok: false,
        status: 401,
        reason: "audience_unset",
      });
      expect(calls).toHaveLength(0);
    },
  );

  test.each<[string, string | readonly string[] | undefined]>([
    ["undefined", undefined],
    ["empty string", ""],
    ["only commas and spaces", " , ,, "],
    ["empty array", []],
    ["array of blanks", ["", "  "]],
  ])("allowlist %s is allowlist_unset (403) and tokeninfo is never called", async (_n, allowedEmails) => {
    const { fetchImpl, calls } = stubFetch(() => jsonResponse(200, goodClaims({ email: "" })));
    expect(await verify(bearer(), fetchImpl, { allowedEmails })).toEqual({
      ok: false,
      status: 403,
      reason: "allowlist_unset",
    });
    expect(calls).toHaveLength(0);
  });

  test("an allowlist with blank entries does not admit a token whose email is empty", async () => {
    const { fetchImpl } = stubFetch(() => jsonResponse(200, goodClaims({ email: "" })));
    const result = await verify(bearer(), fetchImpl, { allowedEmails: `,,${CALLER},` });
    expect(result).toEqual({ ok: false, status: 403, reason: "email_not_allowed" });
  });
});

describe("verifyGoogleIdToken: Google's answer", () => {
  test.each([400, 401, 403, 404])("tokeninfo %i is token_rejected (401)", async (status) => {
    const { fetchImpl } = stubFetch(() => jsonResponse(status, { error: "invalid_token" }));
    expect(await verify(bearer(), fetchImpl)).toEqual({
      ok: false,
      status: 401,
      reason: "token_rejected",
    });
  });

  test.each([429, 500, 502, 503, 504])("tokeninfo %i is tokeninfo_unreachable (503)", async (status) => {
    const { fetchImpl } = stubFetch(() => jsonResponse(status, {}));
    expect(await verify(bearer(), fetchImpl)).toEqual({
      ok: false,
      status: 503,
      reason: "tokeninfo_unreachable",
    });
  });

  test("a 2xx other than 200 is not trusted", async () => {
    const { fetchImpl } = stubFetch(() => jsonResponse(203, goodClaims()));
    expect(await verify(bearer(), fetchImpl)).toMatchObject({ ok: false, status: 401 });
  });

  test("a rejected fetch is tokeninfo_unreachable (503)", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error(`connect ECONNREFUSED while sending ${TOKEN}`);
    }) as unknown as typeof fetch;
    const result = await verify(bearer(), fetchImpl);
    expect(result).toEqual({ ok: false, status: 503, reason: "tokeninfo_unreachable" });
  });

  test("the request carries an abort signal so a hung tokeninfo cannot stall the caller", async () => {
    const { fetchImpl, calls } = stubFetch(() => jsonResponse(200, goodClaims()));
    await verify(bearer(), fetchImpl);
    expect(calls[0].init?.signal).toBeInstanceOf(AbortSignal);
  });

  test("a tokeninfo that never answers is aborted and reported as 503", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(
        (_url: unknown, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      ) as unknown as typeof fetch;
      const pending = verify(bearer(), fetchImpl);
      await vi.advanceTimersByTimeAsync(3_500);
      expect(await pending).toEqual({ ok: false, status: 503, reason: "tokeninfo_unreachable" });
    } finally {
      vi.useRealTimers();
    }
  });

  test.each([
    ["not JSON", () => new Response("<html>nope</html>", { status: 200 })],
    ["JSON null", () => jsonResponse(200, null)],
    ["JSON array", () => jsonResponse(200, [goodClaims()])],
    ["JSON string", () => jsonResponse(200, "ok")],
  ])("a 200 whose body is %s is bad_tokeninfo_body (401)", async (_n, respond) => {
    const { fetchImpl } = stubFetch(respond);
    expect(await verify(bearer(), fetchImpl)).toEqual({
      ok: false,
      status: 401,
      reason: "bad_tokeninfo_body",
    });
  });
});

describe("verifyGoogleIdToken: claim checks cannot be bypassed", () => {
  test.each<[string, unknown]>([
    ["a lookalike host", "https://accounts.google.com.evil.com"],
    ["a different issuer", "https://evil.example.com"],
    ["http scheme", "http://accounts.google.com"],
    ["trailing slash", "https://accounts.google.com/"],
    ["mixed case", "Accounts.Google.com"],
    ["empty", ""],
    ["a number", 1],
    ["an array containing a valid issuer", ["https://accounts.google.com"]],
    ["null", null],
    ["absent", undefined],
  ])("issuer %s is issuer_mismatch (401)", async (_n, iss) => {
    const claims = goodClaims();
    if (iss === undefined) delete claims.iss;
    else claims.iss = iss;
    const { fetchImpl } = stubFetch(() => jsonResponse(200, claims));
    expect(await verify(bearer(), fetchImpl)).toEqual({
      ok: false,
      status: 401,
      reason: "issuer_mismatch",
    });
  });

  test.each<[string, unknown]>([
    ["a longer host sharing our prefix", `${AUDIENCE}.evil.com`],
    ["our URL as a path prefix", `${AUDIENCE}/evil`],
    ["our URL with a userinfo trick", `${AUDIENCE}@evil.com`],
    ["our URL with a suffix char", `${AUDIENCE}x`],
    ["our host as a subdomain of another", "https://happy-animal-123.convex.site.evil.com"],
    ["a different deployment", "https://other-animal-999.convex.site"],
    ["different scheme", "http://happy-animal-123.convex.site"],
    ["different case", AUDIENCE.toUpperCase()],
    ["empty", ""],
    ["an array containing ours", [AUDIENCE]],
    ["a number", 5],
    ["null", null],
    ["absent", undefined],
  ])("audience %s is audience_mismatch (401)", async (_n, aud) => {
    const claims = goodClaims();
    if (aud === undefined) delete claims.aud;
    else claims.aud = aud;
    const { fetchImpl } = stubFetch(() => jsonResponse(200, claims));
    expect(await verify(bearer(), fetchImpl)).toEqual({
      ok: false,
      status: 401,
      reason: "audience_mismatch",
    });
  });

  test("a token minted for our audience cannot be replayed when the deployment audience is a prefix of it", async () => {
    const { fetchImpl } = stubFetch(() =>
      jsonResponse(200, goodClaims({ aud: `${AUDIENCE}.evil.com` })),
    );
    // Configured audience is the SHORT one; token audience extends it.
    const result = await verify(bearer(), fetchImpl, { audience: AUDIENCE });
    expect(result).toMatchObject({ ok: false, reason: "audience_mismatch" });
  });

  test.each<[string, unknown]>([
    ["boolean true", true],
    ["the word True", "True"],
    ["the word TRUE", "TRUE"],
    ["padded true", " true"],
    ["false string", "false"],
    ["number 1", 1],
    ["absent", undefined],
  ])("email_verified %s is email_unverified (403)", async (_n, value) => {
    const claims = goodClaims();
    if (value === undefined) delete claims.email_verified;
    else claims.email_verified = value;
    const { fetchImpl } = stubFetch(() => jsonResponse(200, claims));
    expect(await verify(bearer(), fetchImpl)).toEqual({
      ok: false,
      status: 403,
      reason: "email_unverified",
    });
  });

  test.each<[string, unknown]>([
    ["a different account", "attacker@example.com"],
    ["our caller as a suffix of a longer local part", `evil${CALLER}`],
    ["our caller with a trailing domain label", `${CALLER}.evil.com`],
    ["our caller plus-addressed", CALLER.replace("@", "+x@")],
    ["empty", ""],
    ["whitespace", "   "],
    ["a number", 7],
    ["an array containing ours", [CALLER]],
    ["null", null],
    ["absent", undefined],
  ])("email %s is refused (403)", async (_n, email) => {
    const claims = goodClaims();
    if (email === undefined) delete claims.email;
    else claims.email = email;
    const { fetchImpl } = stubFetch(() => jsonResponse(200, claims));
    expect(await verify(bearer(), fetchImpl)).toMatchObject({
      ok: false,
      status: 403,
      reason: "email_not_allowed",
    });
  });

  test("an email that matches the allowlist only as a substring is refused", async () => {
    const { fetchImpl } = stubFetch(() => jsonResponse(200, goodClaims({ email: "browser" })));
    expect(await verify(bearer(), fetchImpl)).toMatchObject({ ok: false, reason: "email_not_allowed" });
  });

  test("a comma-joined email claim does not match a two-entry allowlist", async () => {
    const { fetchImpl } = stubFetch(() =>
      jsonResponse(200, goodClaims({ email: `a@b.c,${CALLER}` })),
    );
    const result = await verify(bearer(), fetchImpl, { allowedEmails: `a@b.c,${CALLER}` });
    expect(result).toMatchObject({ ok: false, reason: "email_not_allowed" });
  });

  test("the issuer is checked before the email: a wrong issuer with an allowlisted email is still 401", async () => {
    const { fetchImpl } = stubFetch(() =>
      jsonResponse(200, goodClaims({ iss: "https://evil.example.com" })),
    );
    expect(await verify(bearer(), fetchImpl)).toMatchObject({ ok: false, status: 401 });
  });
});

describe("verifyGoogleIdToken: the token never leaks", () => {
  const FRAGMENTS = [
    TOKEN,
    TOKEN.split(".")[0],
    TOKEN.split(".")[1],
    TOKEN.split(".")[2],
    TOKEN.slice(0, 12),
  ];

  const scenarios: Array<[string, () => Promise<unknown>]> = [
    ["success", () => verify(bearer(), stubFetch(() => jsonResponse(200, goodClaims())).fetchImpl)],
    ["tokeninfo 400", () => verify(bearer(), stubFetch(() => jsonResponse(400, { error: TOKEN })).fetchImpl)],
    ["tokeninfo 500", () => verify(bearer(), stubFetch(() => jsonResponse(500, { error: TOKEN })).fetchImpl)],
    [
      "fetch throws with the token in the message",
      () =>
        verify(
          bearer(),
          (async () => {
            throw new Error(TOKEN);
          }) as unknown as typeof fetch,
        ),
    ],
    ["bad body echoing the token", () => verify(bearer(), stubFetch(() => new Response(TOKEN, { status: 200 })).fetchImpl)],
    ["issuer mismatch", () => verify(bearer(), stubFetch(() => jsonResponse(200, goodClaims({ iss: TOKEN }))).fetchImpl)],
    ["audience mismatch", () => verify(bearer(), stubFetch(() => jsonResponse(200, goodClaims({ aud: TOKEN }))).fetchImpl)],
    ["unverified email", () => verify(bearer(), stubFetch(() => jsonResponse(200, goodClaims({ email_verified: TOKEN }))).fetchImpl)],
    ["email not allowed", () => verify(bearer(), stubFetch(() => jsonResponse(200, goodClaims({ email: TOKEN }))).fetchImpl)],
    ["audience unset", () => verify(bearer(), stubFetch(() => jsonResponse(200, {})).fetchImpl, { audience: undefined })],
    ["allowlist unset", () => verify(bearer(), stubFetch(() => jsonResponse(200, {})).fetchImpl, { allowedEmails: undefined })],
    ["oversize token", () => verify(`Bearer ${TOKEN}${"a".repeat(9_000)}`, stubFetch(() => jsonResponse(200, {})).fetchImpl)],
    ["two tokens", () => verify(`Bearer ${TOKEN} ${TOKEN}`, stubFetch(() => jsonResponse(200, {})).fetchImpl)],
    ["four segments", () => verify(`Bearer ${TOKEN}.x`, stubFetch(() => jsonResponse(200, {})).fetchImpl)],
    ["tokeninfo 429", () => verify(bearer(), stubFetch(() => jsonResponse(429, { error: TOKEN })).fetchImpl)],
  ];

  test.each(scenarios)("%s: no fragment of the token is in the verdict", async (_n, run) => {
    const serialised = JSON.stringify(await run());
    for (const fragment of FRAGMENTS) expect(serialised).not.toContain(fragment);
  });

  test.each<[string, Claims]>([
    ["unverified audience mismatch", unverifiedClaims({ aud: "https://elsewhere.example" })],
    ["unverified email not allowed", unverifiedClaims({ email: "attacker@example.com" })],
  ])("%s: no fragment of the token or its claims is in the verdict", async (_n, claims) => {
    const token = makeJwt(claims);
    const serialised = JSON.stringify(
      await verify(bearer(token), stubFetch(() => jsonResponse(200, goodClaims())).fetchImpl),
    );
    for (const fragment of [...token.split("."), token.slice(0, 12)]) {
      expect(serialised).not.toContain(fragment);
    }
    expect(serialised).not.toContain("elsewhere.example");
    expect(serialised).not.toContain("attacker@example.com");
  });

  test("a failure verdict carries only status and reason", async () => {
    const result = await verify(bearer(), stubFetch(() => jsonResponse(200, goodClaims({ aud: "x" }))).fetchImpl);
    expect(Object.keys(result).sort()).toEqual(["ok", "reason", "status"]);
  });

  test("nothing is written to the console", async () => {
    const spies = (["log", "warn", "error", "info", "debug"] as const).map((c) =>
      vi.spyOn(console, c).mockImplementation(() => {}),
    );
    try {
      await verify(bearer(), stubFetch(() => jsonResponse(400, {})).fetchImpl);
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });
});
