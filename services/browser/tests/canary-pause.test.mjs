/**
 * Unit tests for the canary pause gate (NEO-355).
 *
 * THE INVARIANT under test is fail-open: shouldSkipCanary resolves true ONLY
 * when Convex answered 200 with a `paused` array containing this platform's
 * exact site key. Every other input (a dead token minter, a slow or broken
 * Convex, a malformed body, a misspelt key) must resolve false so the canary
 * signs in for real, and it must never reject. A wrong "true" silences the
 * canary; a rejection would 500 the canary route. Both are tested from many
 * angles below.
 *
 * No network, no metadata server: fetch, mintIdToken and log are injected.
 * The compiled CJS dist is imported via createRequire like the other tests.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  PLATFORM_TO_SITE,
  CANARY_PAUSE_LOOKUP_TIMEOUT_MS,
  CANARY_PAUSE_PATH,
  CONVEX_SITE_URL_ENV,
  shouldSkipCanary,
  canaryGate,
} = require("../dist/canary-pause");
const { logCanaryPauseLookupFailed } = require("../dist/observability");

const SITE_URL = "https://example-deployment.convex.site";
const TOKEN = "TOKEN-SECRET-VALUE-do-not-log-0123456789";
const BODY_MARKER = "BODY-MARKER-do-not-log";

/** A Response-like for a 200 JSON body. */
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Spy harness: records fetch calls, mint calls and log lines. */
function harness({ response, fetchImpl, mint, timeoutMs = 200, siteUrl = SITE_URL } = {}) {
  const h = { fetchCalls: [], mintCalls: [], lines: [] };
  h.deps = {
    siteUrl,
    timeoutMs,
    log: (line) => h.lines.push(line),
    mintIdToken:
      mint ??
      (async (aud) => {
        h.mintCalls.push(aud);
        return TOKEN;
      }),
    fetch:
      fetchImpl ??
      (async (url, init) => {
        h.fetchCalls.push({ url, init });
        return typeof response === "function" ? response() : response;
      }),
  };
  if (mint) {
    const inner = mint;
    h.deps.mintIdToken = async (aud) => {
      h.mintCalls.push(aud);
      return inner(aud);
    };
  }
  if (fetchImpl) {
    const inner = fetchImpl;
    h.deps.fetch = async (url, init) => {
      h.fetchCalls.push({ url, init });
      return inner(url, init);
    };
  }
  return h;
}

/** Every logged line must be the closed {msg, platform, reason} shape and carry no secret. */
function assertCleanLines(h) {
  for (const line of h.lines) {
    assert.deepEqual(Object.keys(line).sort(), ["msg", "platform", "reason"]);
    assert.equal(line.msg, "canary_pause_lookup_failed");
    const s = JSON.stringify(line);
    assert.ok(!s.includes(TOKEN), "token must never reach a log line");
    assert.ok(!s.includes(BODY_MARKER), "response body must never reach a log line");
    assert.ok(!s.includes("Bearer"), "auth header must never reach a log line");
  }
}

let savedEnv;
beforeEach(() => {
  savedEnv = process.env[CONVEX_SITE_URL_ENV];
  delete process.env[CONVEX_SITE_URL_ENV];
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env[CONVEX_SITE_URL_ENV];
  else process.env[CONVEX_SITE_URL_ENV] = savedEnv;
});

describe("canary-pause constants", () => {
  it("PLATFORM_TO_SITE maps slugs to Convex site keys and is frozen", () => {
    assert.deepEqual({ ...PLATFORM_TO_SITE }, { bsc: "buysportscards", sportlots: "sportlots" });
    assert.ok(Object.isFrozen(PLATFORM_TO_SITE));
  });

  it("the lookup budget, path and env name are pinned", () => {
    assert.equal(CANARY_PAUSE_LOOKUP_TIMEOUT_MS, 5000);
    assert.equal(CANARY_PAUSE_PATH, "/internal/marketplace-pause");
    assert.equal(CONVEX_SITE_URL_ENV, "NEONBINDER_CONVEX_SITE_URL");
  });
});

describe("shouldSkipCanary: the paused answer", () => {
  it("returns true when the paused list names this platform's site key", async () => {
    const h = harness({ response: jsonResponse({ paused: ["buysportscards"] }) });
    assert.equal(await shouldSkipCanary("bsc", h.deps), true);
    assert.deepEqual(h.lines, []);
  });

  it("returns true for sportlots when it is listed alongside others", async () => {
    const h = harness({ response: jsonResponse({ paused: ["buysportscards", "sportlots"] }) });
    assert.equal(await shouldSkipCanary("sportlots", h.deps), true);
  });

  it("sends GET to site URL + path with Authorization: Bearer <minted token>", async () => {
    const h = harness({ response: jsonResponse({ paused: ["sportlots"] }) });
    await shouldSkipCanary("sportlots", h.deps);
    assert.equal(h.fetchCalls.length, 1);
    const { url, init } = h.fetchCalls[0];
    assert.equal(url, `${SITE_URL}${CANARY_PAUSE_PATH}`);
    assert.equal(init.method, "GET");
    assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(init.redirect, "manual", "the bearer token must never follow a redirect");
    assert.ok(init.signal, "an abort signal bounds the request");
  });

  it("mints the token with the URL origin as audience, trailing slash stripped", async () => {
    const h = harness({ response: jsonResponse({ paused: [] }), siteUrl: `${SITE_URL}/` });
    await shouldSkipCanary("bsc", h.deps);
    assert.deepEqual(h.mintCalls, [SITE_URL]);
    assert.equal(h.fetchCalls[0].url, `${SITE_URL}${CANARY_PAUSE_PATH}`);
  });

  it("strips a stray path from the site URL so the audience is a bare origin", async () => {
    const h = harness({ response: jsonResponse({ paused: [] }), siteUrl: `${SITE_URL}/some/path?x=1` });
    await shouldSkipCanary("bsc", h.deps);
    assert.deepEqual(h.mintCalls, [SITE_URL]);
    assert.equal(h.fetchCalls[0].url, `${SITE_URL}${CANARY_PAUSE_PATH}`);
  });

  it("returns false when only the other platform is paused", async () => {
    const h = harness({ response: jsonResponse({ paused: ["sportlots"] }) });
    assert.equal(await shouldSkipCanary("bsc", h.deps), false);
    assert.deepEqual(h.lines, [], "a clean not-paused answer logs nothing");
  });

  it("returns false for an empty paused list", async () => {
    const h = harness({ response: jsonResponse({ paused: [] }) });
    assert.equal(await shouldSkipCanary("bsc", h.deps), false);
    assert.deepEqual(h.lines, []);
  });

  it("falls back to the env var when siteUrl is not injected", async () => {
    process.env[CONVEX_SITE_URL_ENV] = SITE_URL;
    const h = harness({ response: jsonResponse({ paused: ["buysportscards"] }) });
    delete h.deps.siteUrl;
    assert.equal(await shouldSkipCanary("bsc", h.deps), true);
    assert.equal(h.fetchCalls[0].url, `${SITE_URL}${CANARY_PAUSE_PATH}`);
  });
});

describe("shouldSkipCanary: gate off (no site URL configured)", () => {
  for (const [label, siteUrl] of [
    ["unset", undefined],
    ["empty", ""],
    ["blank", "   \t "],
  ]) {
    it(`${label} env: no mint, no fetch, no log, false`, async () => {
      const h = harness({ response: jsonResponse({ paused: ["buysportscards"] }) });
      h.deps.siteUrl = siteUrl;
      assert.equal(await shouldSkipCanary("bsc", h.deps), false);
      assert.equal(h.mintCalls.length, 0);
      assert.equal(h.fetchCalls.length, 0);
      assert.deepEqual(h.lines, []);
    });
  }
});

describe("shouldSkipCanary: every failure fails open with one clean log line", () => {
  async function expectFailOpen(platform, h, reason) {
    assert.equal(await shouldSkipCanary(platform, h.deps), false);
    assert.deepEqual(h.lines, [{ msg: "canary_pause_lookup_failed", platform, reason }]);
    assertCleanLines(h);
  }

  it("mint throws: token_mint_failed, and fetch is never called", async () => {
    const h = harness({
      mint: async () => {
        throw new Error(`metadata exploded ${TOKEN}`);
      },
      response: jsonResponse({ paused: ["buysportscards"] }),
    });
    await expectFailOpen("bsc", h, "token_mint_failed");
    assert.equal(h.fetchCalls.length, 0);
  });

  it("mint throws synchronously: token_mint_failed", async () => {
    const h = harness({ response: jsonResponse({ paused: ["buysportscards"] }) });
    h.deps.mintIdToken = () => {
      throw new Error("sync boom");
    };
    await expectFailOpen("bsc", h, "token_mint_failed");
    assert.equal(h.fetchCalls.length, 0);
  });

  for (const [label, value] of [
    ["empty", ""],
    ["undefined", undefined],
    ["null", null],
    ["non-string", 12345],
  ]) {
    it(`mint resolves ${label}: token_mint_failed, no fetch`, async () => {
      const h = harness({ mint: async () => value, response: jsonResponse({ paused: ["sportlots"] }) });
      await expectFailOpen("sportlots", h, "token_mint_failed");
      assert.equal(h.fetchCalls.length, 0);
    });
  }

  it("a mint that never resolves hits the deadline: timeout", async () => {
    const h = harness({ mint: () => new Promise(() => {}), timeoutMs: 30, response: jsonResponse({ paused: [] }) });
    await expectFailOpen("bsc", h, "timeout");
    assert.equal(h.fetchCalls.length, 0);
  });

  it("a fetch that never resolves (and ignores abort) hits the deadline: timeout", async () => {
    const h = harness({ fetchImpl: () => new Promise(() => {}), timeoutMs: 30 });
    await expectFailOpen("bsc", h, "timeout");
  });

  it("a fetch that rejects when the signal aborts: timeout", async () => {
    const h = harness({
      timeoutMs: 30,
      fetchImpl: (_url, init) =>
        new Promise((_res, rej) => {
          init.signal.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")));
        }),
    });
    await expectFailOpen("sportlots", h, "timeout");
  });

  it("a fetch rejecting with an AbortError on its own: timeout", async () => {
    const h = harness({
      fetchImpl: async () => {
        throw new DOMException("aborted", "AbortError");
      },
    });
    await expectFailOpen("bsc", h, "timeout");
  });

  it("a fetch rejecting with a non-abort error: network_error, message not logged", async () => {
    const h = harness({
      fetchImpl: async () => {
        throw new TypeError(`fetch failed ECONNREFUSED ${TOKEN}`);
      },
    });
    await expectFailOpen("bsc", h, "network_error");
  });

  it("a fetch rejecting with a non-Error value: network_error", async () => {
    const h = harness({
      fetchImpl: async () => {
        throw "plain string";
      },
    });
    await expectFailOpen("bsc", h, "network_error");
  });

  for (const status of [301, 302, 307, 401, 403, 404, 429, 500, 503]) {
    it(`status ${status}: http_${status}, even if the body says paused`, async () => {
      const h = harness({
        response: new Response(JSON.stringify({ paused: ["buysportscards"], note: BODY_MARKER }), { status }),
      });
      await expectFailOpen("bsc", h, `http_${status}`);
    });
  }

  it("a 204 is a non-200: http_204", async () => {
    const h = harness({ response: new Response(null, { status: 204 }) });
    await expectFailOpen("bsc", h, "http_204");
  });

  it("invalid JSON on a 200: bad_body, body not logged", async () => {
    const h = harness({ response: new Response(`not json ${BODY_MARKER}`, { status: 200 }) });
    await expectFailOpen("bsc", h, "bad_body");
  });

  it("an empty 200 body: bad_body", async () => {
    const h = harness({ response: new Response("", { status: 200 }) });
    await expectFailOpen("bsc", h, "bad_body");
  });

  for (const [label, body] of [
    ["null", null],
    ["a string", `"${BODY_MARKER}"`],
    ["a number", 7],
    ["an array", ["buysportscards"]],
    ["an object without paused", { other: ["buysportscards"] }],
    ["paused as a string", { paused: "buysportscards" }],
    ["paused as an object", { paused: { buysportscards: true } }],
    ["paused null", { paused: null }],
    ["paused as a number", { paused: 1 }],
  ]) {
    it(`body shape ${label}: bad_body, false`, async () => {
      const h = harness({ response: new Response(JSON.stringify(body), { status: 200 }) });
      await expectFailOpen("bsc", h, "bad_body");
    });
  }

  for (const [label, siteUrl] of [
    ["unparsable", "not a url"],
    ["http", "http://example-deployment.convex.site"],
    ["ftp", "ftp://example-deployment.convex.site"],
    ["scheme-less host", "example-deployment.convex.site"],
    ["javascript scheme", "javascript:alert(1)"],
  ]) {
    it(`site URL ${label}: bad_site_url, no mint (a token is never sent over plain HTTP)`, async () => {
      const h = harness({ response: jsonResponse({ paused: ["buysportscards"] }), siteUrl });
      await expectFailOpen("bsc", h, "bad_site_url");
      assert.equal(h.mintCalls.length, 0);
      assert.equal(h.fetchCalls.length, 0);
    });
  }

  it("a response whose json() hangs past the deadline resolves false, not hung", async () => {
    const h = harness({
      timeoutMs: 30,
      response: { status: 200, json: () => new Promise(() => {}), body: null },
    });
    await expectFailOpen("bsc", h, "timeout");
  });

  it("the failure line for the second platform names that platform", async () => {
    const h = harness({ response: new Response("", { status: 500 }) });
    await expectFailOpen("sportlots", h, "http_500");
  });
});

describe("shouldSkipCanary: tries to break fail-open", () => {
  async function answer(platform, body) {
    const h = harness({ response: new Response(JSON.stringify(body), { status: 200 }) });
    const out = await shouldSkipCanary(platform, h.deps);
    return { out, h };
  }

  it("'bsc' in the paused list does not pause bsc: only the site key matches", async () => {
    assert.equal((await answer("bsc", { paused: ["bsc"] })).out, false);
  });

  it("'BuySportsCards' / ' buysportscards' / 'buysportscards ' do not match (exact match only)", async () => {
    for (const v of ["BuySportsCards", "BUYSPORTSCARDS", " buysportscards", "buysportscards ", "buysportscards\n"]) {
      assert.equal((await answer("bsc", { paused: [v] })).out, false, JSON.stringify(v));
    }
  });

  it("'Sportlots' casing and 'sportlots.com' do not match", async () => {
    for (const v of ["SportLots", "SPORTLOTS", "sportlots.com", "sport lots"]) {
      assert.equal((await answer("sportlots", { paused: [v] })).out, false, v);
    }
  });

  it("non-string entries are ignored and never coerced to a match", async () => {
    const entries = [null, undefined, 1, true, {}, ["buysportscards"], { toString: () => "buysportscards" }];
    const { out } = await answer("bsc", { paused: entries });
    assert.equal(out, false);
  });

  it("a string entry still wins when it sits among junk entries", async () => {
    assert.equal((await answer("bsc", { paused: [null, 5, {}, "buysportscards"] })).out, true);
  });

  it("extra top-level keys and a 'paused' key in a nested object do not confuse it", async () => {
    assert.equal((await answer("bsc", { paused: [], nested: { paused: ["buysportscards"] } })).out, false);
  });

  it("prototype-pollution-looking bodies do not pause anything", async () => {
    const h = harness({
      response: new Response('{"__proto__":{"paused":["buysportscards"]},"constructor":{"paused":["buysportscards"]}}', {
        status: 200,
      }),
    });
    assert.equal(await shouldSkipCanary("bsc", h.deps), false);
    assert.equal(h.lines[0].reason, "bad_body");
  });

  it("a huge paused list without our key stays false and resolves", async () => {
    const paused = Array.from({ length: 200_000 }, (_, i) => `site-${i}`);
    assert.equal((await answer("bsc", { paused })).out, false);
  });

  it("a huge paused list ending in our key is true", async () => {
    const paused = Array.from({ length: 200_000 }, (_, i) => `site-${i}`);
    paused.push("sportlots");
    assert.equal((await answer("sportlots", { paused })).out, true);
  });

  it("a multi-megabyte junk body fails open without rejecting", async () => {
    const h = harness({ response: new Response("x".repeat(5_000_000), { status: 200 }) });
    assert.equal(await shouldSkipCanary("bsc", h.deps), false);
    assert.equal(h.lines[0].reason, "bad_body");
  });

  it("an unknown platform slug returns false without a mint or a fetch", async () => {
    const h = harness({ response: jsonResponse({ paused: ["buysportscards", "undefined"] }) });
    for (const slug of ["ebay", "BSC", "", undefined, null]) {
      assert.equal(await shouldSkipCanary(slug, h.deps), false, String(slug));
    }
    assert.equal(h.mintCalls.length, 0);
    assert.equal(h.fetchCalls.length, 0);
  });

  it("inherited Object.prototype names as a slug can never skip the canary", async () => {
    // PLATFORM_TO_SITE["constructor"] is truthy, so the lookup runs; the
    // answer must still be false (a function never equals a site string).
    const h = harness({ response: jsonResponse({ paused: ["buysportscards", "sportlots", "constructor", "toString"] }) });
    for (const slug of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      assert.equal(await shouldSkipCanary(slug, h.deps), false, slug);
    }
  });

  it("a fetch that resolves undefined / null / a non-Response fails open and never rejects", async () => {
    for (const value of [undefined, null, 42, "str", {}]) {
      const h = harness({ fetchImpl: async () => value });
      assert.equal(await shouldSkipCanary("bsc", h.deps), false, String(value));
    }
  });

  it("a response getter that throws fails open and never rejects", async () => {
    const res = {
      get status() {
        throw new Error("boom");
      },
    };
    const h = harness({ fetchImpl: async () => res });
    assert.equal(await shouldSkipCanary("bsc", h.deps), false);
  });

  it("a throwing logger cannot turn a failure into a rejection", async () => {
    const h = harness({ response: new Response("", { status: 500 }) });
    h.deps.log = () => {
      throw new Error("logger down");
    };
    assert.equal(await shouldSkipCanary("bsc", h.deps), false);
  });

  it("a hostile 'deps' (null fetch/mint fields) falls back to defaults or fails open, never rejects", async () => {
    // siteUrl is blank, so nothing runs even with garbage in the other fields.
    assert.equal(
      await shouldSkipCanary("bsc", { siteUrl: "", fetch: null, mintIdToken: null, log: null, timeoutMs: NaN }),
      false,
    );
  });

  it("a non-numeric timeoutMs still resolves (does not hang the canary)", async () => {
    const h = harness({ response: jsonResponse({ paused: ["bsc-not-it"] }) });
    h.deps.timeoutMs = "soon";
    assert.equal(await shouldSkipCanary("bsc", h.deps), false);
  });

  it("is not stateful: a paused answer then a failing one yields true then false", async () => {
    let n = 0;
    const h = harness({
      fetchImpl: async () => (n++ === 0 ? jsonResponse({ paused: ["buysportscards"] }) : new Response("", { status: 503 })),
    });
    assert.equal(await shouldSkipCanary("bsc", h.deps), true);
    assert.equal(await shouldSkipCanary("bsc", h.deps), false);
    assert.equal(h.lines.length, 1);
  });

  it("the default log writer emits the same closed shape on stdout", async () => {
    const lines = [];
    const real = console.log;
    console.log = (...a) => lines.push(a.join(" "));
    try {
      const h = harness({ response: new Response(BODY_MARKER, { status: 502 }) });
      delete h.deps.log;
      assert.equal(await shouldSkipCanary("bsc", h.deps), false);
    } finally {
      console.log = real;
    }
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0]), {
      msg: "canary_pause_lookup_failed",
      platform: "bsc",
      reason: "http_502",
    });
    assert.ok(!lines[0].includes(TOKEN) && !lines[0].includes(BODY_MARKER));
  });
});

describe("logCanaryPauseLookupFailed", () => {
  it("writes only msg, platform and reason, even when handed extra fields", () => {
    const lines = [];
    const real = console.log;
    console.log = (...a) => lines.push(a.join(" "));
    try {
      logCanaryPauseLookupFailed({
        msg: "canary_pause_lookup_failed",
        platform: "bsc",
        reason: "bad_body",
        token: TOKEN,
        body: BODY_MARKER,
      });
    } finally {
      console.log = real;
    }
    assert.deepEqual(JSON.parse(lines[0]), {
      msg: "canary_pause_lookup_failed",
      platform: "bsc",
      reason: "bad_body",
    });
  });

  it("never throws, even if console.log does", () => {
    const real = console.log;
    console.log = () => {
      throw new Error("stdout closed");
    };
    try {
      assert.doesNotThrow(() =>
        logCanaryPauseLookupFailed({ msg: "canary_pause_lookup_failed", platform: "bsc", reason: "timeout" }),
      );
    } finally {
      console.log = real;
    }
  });
});

describe("canaryGate", () => {
  it("a non-canary request proceeds and never calls the lookup", async () => {
    let calls = 0;
    const decision = await canaryGate(
      { canary: false, platform: "bsc" },
      { shouldSkipCanary: async () => (calls++, true) },
    );
    assert.equal(decision, "proceed");
    assert.equal(calls, 0);
  });

  it("non-boolean canary values (undefined, 'true', 1) are not canary and never look up", async () => {
    let calls = 0;
    const spy = async () => (calls++, true);
    for (const canary of [undefined, null, "true", 1, {}]) {
      assert.equal(await canaryGate({ canary, platform: "bsc" }, { shouldSkipCanary: spy }), "proceed");
    }
    assert.equal(calls, 0);
  });

  it("a non-canary request never touches fetch or mint through the real lookup", async () => {
    const h = harness({ response: jsonResponse({ paused: ["buysportscards"] }) });
    assert.equal(await canaryGate({ canary: false, platform: "bsc" }, h.deps), "proceed");
    assert.equal(h.fetchCalls.length, 0);
    assert.equal(h.mintCalls.length, 0);
  });

  it("a canary request on a paused platform returns skip_paused, passing platform and deps through", async () => {
    let seen;
    const decision = await canaryGate(
      { canary: true, platform: "sportlots" },
      {
        siteUrl: SITE_URL,
        shouldSkipCanary: async (platform, deps) => {
          seen = { platform, deps };
          return true;
        },
      },
    );
    assert.equal(decision, "skip_paused");
    assert.equal(seen.platform, "sportlots");
    assert.equal(seen.deps.siteUrl, SITE_URL);
  });

  it("a canary request on a not-paused platform proceeds", async () => {
    const decision = await canaryGate(
      { canary: true, platform: "bsc" },
      { shouldSkipCanary: async () => false },
    );
    assert.equal(decision, "proceed");
  });

  it("only a strict true skips: truthy non-booleans proceed", async () => {
    for (const v of ["true", 1, {}, []]) {
      const d = await canaryGate({ canary: true, platform: "bsc" }, { shouldSkipCanary: async () => v });
      assert.equal(d, "proceed", String(v));
    }
  });

  it("a lookup that rejects proceeds (never rejects)", async () => {
    const decision = await canaryGate(
      { canary: true, platform: "bsc" },
      {
        shouldSkipCanary: async () => {
          throw new Error("boom");
        },
      },
    );
    assert.equal(decision, "proceed");
  });

  it("end to end with the real lookup: paused → skip_paused, 503 → proceed", async () => {
    const paused = harness({ response: jsonResponse({ paused: ["buysportscards"] }) });
    assert.equal(await canaryGate({ canary: true, platform: "bsc" }, paused.deps), "skip_paused");
    const down = harness({ response: new Response("", { status: 503 }) });
    assert.equal(await canaryGate({ canary: true, platform: "bsc" }, down.deps), "proceed");
    assert.equal(down.lines[0].reason, "http_503");
  });

  it("with the gate off (no site URL) a canary request proceeds silently", async () => {
    const h = harness({ response: jsonResponse({ paused: ["buysportscards"] }) });
    h.deps.siteUrl = undefined;
    assert.equal(await canaryGate({ canary: true, platform: "bsc" }, h.deps), "proceed");
    assert.equal(h.fetchCalls.length, 0);
    assert.deepEqual(h.lines, []);
  });
});
