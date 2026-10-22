/**
 * NEO-355 — `GET /internal/marketplace-pause`, driven through `t.fetch` so the
 * route registration in convex/http.ts is under test with the handler.
 *
 * Google's tokeninfo is intercepted with `vi.stubGlobal("fetch", …)` (the
 * `machineAuth.test.ts` convention); the stub records every call so the
 * "refused before asking Google" cases assert on what was NOT sent. Env is
 * isolated per test by the runner's setup (NEO-239).
 *
 * Properties that get more attention than their line count suggests:
 *  - **No oracle.** Every refusal body is one of three fixed words, so a
 *    stolen-but-wrong token learns nothing about which check refused it.
 *  - **No token anywhere.** Not in a body, a header, or any console channel,
 *    whole or in part.
 *  - **Fail closed.** Unset audience or allowlist never yields a 200.
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { BROWSER_RUNTIME_SA_ENV } from "./marketplacePause";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const SITE_URL = "https://happy-animal-123.convex.site";
const CALLER = "browser-runtime@example-project.iam.gserviceaccount.com";
const TOKEN = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjMifQ.sig-do-not-leak-0123456789";
const PATH = "/internal/marketplace-pause";

const TOKEN_FRAGMENTS = [
  TOKEN,
  TOKEN.split(".")[0],
  TOKEN.split(".")[1],
  TOKEN.split(".")[2],
  TOKEN.slice(0, 12),
];

type Claims = Record<string, unknown>;

function goodClaims(overrides: Claims = {}): Claims {
  return {
    iss: "https://accounts.google.com",
    aud: SITE_URL,
    email: CALLER,
    email_verified: "true",
    ...overrides,
  };
}

type Upstream = { status: number; body?: unknown; raw?: string } | "throw";

/** Stub the global fetch as Google's tokeninfo; returns the recorded URLs. */
function stubTokeninfo(reply: Upstream = { status: 200, body: goodClaims() }) {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      urls.push(String(input));
      if (reply === "throw") throw new Error(`socket hang up ${TOKEN}`);
      return new Response(reply.raw ?? JSON.stringify(reply.body ?? {}), {
        status: reply.status,
      });
    }),
  );
  return urls;
}

function captureConsole() {
  const lines: string[] = [];
  const collect = (...args: unknown[]) => {
    lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  const spies = (["log", "warn", "error", "info", "debug"] as const).map((c) =>
    vi.spyOn(console, c).mockImplementation(collect),
  );
  return { lines, restore: () => spies.forEach((s) => s.mockRestore()) };
}

function request(authorization?: string, method = "GET") {
  const t = convexTest(schema, modules);
  const headers: Record<string, string> = {};
  if (authorization !== undefined) headers.authorization = authorization;
  return t.fetch(PATH, { method, headers });
}

const asCaller = () => request(`Bearer ${TOKEN}`);

beforeEach(() => {
  process.env.CONVEX_SITE_URL = SITE_URL;
  process.env[BROWSER_RUNTIME_SA_ENV] = CALLER;
  delete process.env.NEONBINDER_PAUSED_PLATFORMS;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GET /internal/marketplace-pause: served", () => {
  test("a valid caller gets the sorted paused list as JSON", async () => {
    process.env.NEONBINDER_PAUSED_PLATFORMS = "sportlots, buysportscards";
    stubTokeninfo();
    const res = await asCaller();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ paused: ["buysportscards", "sportlots"] });
  });

  test("nothing paused is an empty list, not an error", async () => {
    stubTokeninfo();
    const res = await asCaller();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ paused: [] });
  });

  test("an empty pause variable is an empty list", async () => {
    process.env.NEONBINDER_PAUSED_PLATFORMS = "";
    stubTokeninfo();
    expect(await (await asCaller()).json()).toEqual({ paused: [] });
  });

  test("the pause is read on each call, so flipping it takes effect without a deploy", async () => {
    stubTokeninfo();
    expect(await (await asCaller()).json()).toEqual({ paused: [] });
    process.env.NEONBINDER_PAUSED_PLATFORMS = "sportlots";
    expect(await (await asCaller()).json()).toEqual({ paused: ["sportlots"] });
  });

  test("an unknown site key in the variable is dropped from the answer", async () => {
    process.env.NEONBINDER_PAUSED_PLATFORMS = "sportlots,nonsense";
    stubTokeninfo();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await (await asCaller()).json()).toEqual({ paused: ["sportlots"] });
    } finally {
      warn.mockRestore();
    }
  });

  test("every answer is Cache-Control: no-store, served or refused", async () => {
    stubTokeninfo();
    expect((await asCaller()).headers.get("cache-control")).toBe("no-store");
    expect((await request()).headers.get("cache-control")).toBe("no-store");
  });

  test("Google is asked about the caller's token, and only Google", async () => {
    const urls = stubTokeninfo();
    await asCaller();
    expect(urls).toHaveLength(1);
    const url = new URL(urls[0]);
    expect(url.origin).toBe("https://oauth2.googleapis.com");
    expect(url.searchParams.get("id_token")).toBe(TOKEN);
  });

  test("allowlist entries are trimmed and lowercased, so a padded mixed-case entry admits the caller", async () => {
    process.env[BROWSER_RUNTIME_SA_ENV] = `  other@example.com ,  ${CALLER.toUpperCase()} `;
    stubTokeninfo({ status: 200, body: goodClaims({ email: ` ${CALLER.toUpperCase()} ` }) });
    expect((await asCaller()).status).toBe(200);
  });

  test("a trailing slash on CONVEX_SITE_URL does not lock the caller out", async () => {
    process.env.CONVEX_SITE_URL = `${SITE_URL}/`;
    stubTokeninfo();
    expect((await asCaller()).status).toBe(200);
  });
});

describe("GET /internal/marketplace-pause: refused", () => {
  test.each([
    ["no Authorization header", undefined],
    ["an empty header", ""],
    ["Bearer with an empty token", "Bearer "],
    ["Bearer with whitespace for a token", "Bearer    "],
    ["a non-Bearer scheme", `Basic ${TOKEN}`],
    ["a raw token with no scheme", TOKEN],
  ])("%s is 401 and Google is never asked", async (_n, header) => {
    process.env.NEONBINDER_PAUSED_PLATFORMS = "sportlots";
    const urls = stubTokeninfo();
    const res = await request(header);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(urls).toHaveLength(0);
  });

  const withoutEmail = goodClaims();
  delete withoutEmail.email;

  test.each([
    ["tokeninfo rejects the token", { status: 400, body: { error: "invalid_token" } }, 401],
    ["wrong issuer", { status: 200, body: goodClaims({ iss: "https://evil.example.com" }) }, 401],
    ["issuer lookalike host", { status: 200, body: goodClaims({ iss: "https://accounts.google.com.evil.com" }) }, 401],
    ["audience is another deployment", { status: 200, body: goodClaims({ aud: "https://other-999.convex.site" }) }, 401],
    ["audience extends ours with a suffix", { status: 200, body: goodClaims({ aud: `${SITE_URL}.evil.com` }) }, 401],
    ["audience extends ours with a path", { status: 200, body: goodClaims({ aud: `${SITE_URL}/x` }) }, 401],
    ["audience extends ours with userinfo", { status: 200, body: goodClaims({ aud: `${SITE_URL}@evil.com` }) }, 401],
    ["tokeninfo body is not JSON", { status: 200, raw: "<html>" }, 401],
    ["email unverified", { status: 200, body: goodClaims({ email_verified: "false" }) }, 403],
    ["email_verified is a boolean", { status: 200, body: goodClaims({ email_verified: true }) }, 403],
    ["email not allowlisted", { status: 200, body: goodClaims({ email: "attacker@example.com" }) }, 403],
    ["email is the caller plus a suffix", { status: 200, body: goodClaims({ email: `${CALLER}.evil.com` }) }, 403],
    ["email absent", { status: 200, body: withoutEmail }, 403],
    ["tokeninfo 500", { status: 500, body: {} }, 503],
    ["tokeninfo 503", { status: 503, body: {} }, 503],
    ["tokeninfo unreachable", "throw", 503],
  ] as Array<[string, Upstream, 401 | 403 | 503]>)("%s", async (_n, reply, status) => {
    process.env.NEONBINDER_PAUSED_PLATFORMS = "sportlots";
    stubTokeninfo(reply);
    const res = await asCaller();
    expect(res.status).toBe(status);
    const body = await res.json();
    expect(body).toEqual({
      error: { 401: "unauthorized", 403: "forbidden", 503: "unavailable" }[status],
    });
    expect(body).not.toHaveProperty("paused");
  });

  test("allowlist env unset is 403 and Google is never asked", async () => {
    delete process.env[BROWSER_RUNTIME_SA_ENV];
    const urls = stubTokeninfo();
    expect((await asCaller()).status).toBe(403);
    expect(urls).toHaveLength(0);
  });

  test.each(["", " , ,, "])("allowlist env %j is 403 even for a perfect token", async (value) => {
    process.env[BROWSER_RUNTIME_SA_ENV] = value;
    const urls = stubTokeninfo();
    expect((await asCaller()).status).toBe(403);
    expect(urls).toHaveLength(0);
  });

  test("an allowlist with blank entries does not admit a token with an empty email", async () => {
    process.env[BROWSER_RUNTIME_SA_ENV] = `,${CALLER},`;
    stubTokeninfo({ status: 200, body: goodClaims({ email: "" }) });
    expect((await asCaller()).status).toBe(403);
  });

  test("CONVEX_SITE_URL unset is 401 and Google is never asked", async () => {
    delete process.env.CONVEX_SITE_URL;
    const urls = stubTokeninfo({ status: 200, body: goodClaims({ aud: "" }) });
    expect((await asCaller()).status).toBe(401);
    expect(urls).toHaveLength(0);
  });

  test("CONVEX_SITE_URL empty never matches a token with an empty audience", async () => {
    process.env.CONVEX_SITE_URL = "";
    stubTokeninfo({ status: 200, body: goodClaims({ aud: "" }) });
    expect((await asCaller()).status).toBe(401);
  });

  test("refusal bodies are byte-identical across different causes with the same status", async () => {
    const bodies: string[] = [];
    for (const reply of [
      { status: 400, body: {} },
      { status: 200, body: goodClaims({ iss: "x" }) },
      { status: 200, body: goodClaims({ aud: "x" }) },
    ] as Upstream[]) {
      stubTokeninfo(reply);
      const res = await asCaller();
      expect(res.status).toBe(401);
      bodies.push(await res.text());
    }
    expect(new Set(bodies).size).toBe(1);
  });

  test("a refusal never reveals the paused list", async () => {
    process.env.NEONBINDER_PAUSED_PLATFORMS = "sportlots";
    stubTokeninfo({ status: 200, body: goodClaims({ email: "attacker@example.com" }) });
    expect(await (await asCaller()).text()).not.toContain("sportlots");
  });
});

describe("GET /internal/marketplace-pause: route", () => {
  test.each(["POST", "PUT", "DELETE", "PATCH"])("%s with a valid token is not served", async (method) => {
    process.env.NEONBINDER_PAUSED_PLATFORMS = "sportlots";
    stubTokeninfo();
    const res = await request(`Bearer ${TOKEN}`, method);
    expect([404, 405]).toContain(res.status);
    expect(await res.text()).not.toContain("sportlots");
  });
});

describe("GET /internal/marketplace-pause: logging", () => {
  const scenarios: Array<[string, Upstream, string]> = [
    ["served", { status: 200, body: goodClaims() }, `Bearer ${TOKEN}`],
    ["tokeninfo rejected", { status: 400, body: { error: TOKEN } }, `Bearer ${TOKEN}`],
    ["tokeninfo unreachable", "throw", `Bearer ${TOKEN}`],
    ["tokeninfo 500", { status: 500, body: { error: TOKEN } }, `Bearer ${TOKEN}`],
    ["wrong audience echoing the token", { status: 200, body: goodClaims({ aud: TOKEN }) }, `Bearer ${TOKEN}`],
    ["wrong issuer echoing the token", { status: 200, body: goodClaims({ iss: TOKEN }) }, `Bearer ${TOKEN}`],
    ["email not allowed echoing the token", { status: 200, body: goodClaims({ email: TOKEN }) }, `Bearer ${TOKEN}`],
    ["malformed header", { status: 200, body: goodClaims() }, `Basic ${TOKEN}`],
  ];

  test.each(scenarios)("%s: no fragment of the token reaches any console channel, body or header", async (_n, reply, header) => {
    stubTokeninfo(reply);
    const cap = captureConsole();
    try {
      const res = await request(header);
      const headers = JSON.stringify([...res.headers.entries()]);
      const text = await res.text();
      const everything = [...cap.lines, headers, text].join("\n");
      for (const fragment of TOKEN_FRAGMENTS) expect(everything).not.toContain(fragment);
    } finally {
      cap.restore();
    }
  });

  test("a refusal logs one warn line with the status and a closed-set reason, and no claim value", async () => {
    stubTokeninfo({ status: 200, body: goodClaims({ aud: "https://elsewhere.example" }) });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await asCaller();
      const lines = warn.mock.calls
        .map((c) => String(c[0]))
        .filter((l) => l.includes("marketplace_pause_lookup_refused"));
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0])).toMatchObject({ status: 401, reason: "audience_mismatch" });
      expect(lines[0]).not.toContain("elsewhere.example");
    } finally {
      warn.mockRestore();
    }
  });
});
