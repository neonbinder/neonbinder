/**
 * Route tests for eBay connect and refresh (NEO-415).
 *
 * Mounts the REAL router (src/routes/ebay-oauth.ts, compiled to dist/) over an
 * in-memory store and a stubbed `fetch` standing in for eBay's token endpoint
 * and the Commerce Identity API. Nothing here touches the network.
 *
 * The load-bearing assertions are the leak ones: the refresh token never
 * appears in a response body, the access token appears only in the /refresh
 * body, and no token, code or client secret reaches a log line. Every
 * credential-shaped fixture carries a SENTINEL marker so the leak checks can
 * search raw text rather than trust field names.
 *
 * SECURITY: fixtures are placeholders, never real eBay values.
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";

const require = createRequire(import.meta.url);
const { createEbayOAuthRouter } = require("../dist/routes/ebay-oauth");
const { EBAY_SCOPES } = require("../dist/services/ebay-oauth");
const { credentialRateLimitKey } = require("../dist/rate-limit");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const KEY = "ebay-credentials-user_test123";
const CLIENT_ID = "NeonBind-test-SBX-0000000000-00000000";
const CLIENT_SECRET = "SBX-CLIENTSECRET-SENTINEL-0001";
const RU_NAME = "Neon_Binder-NeonBind-test-SBX-runame";
const CODE = "v^1.1#i^1#CODE-SENTINEL-0001#r^1";
const ACCESS = "v^1.1#i^1#ACCESS-SENTINEL-0001#t^Ul4x";
const ACCESS_2 = "v^1.1#i^1#ACCESS-SENTINEL-0002#t^Ul4x";
const REFRESH = "v^1.1#i^1#REFRESH-SENTINEL-0001#r^1";
const SEED_REFRESH = "v^1.1#i^1#REFRESH-SENTINEL-SEED#r^1";
const SENTINELS = [CLIENT_SECRET, CODE, ACCESS, ACCESS_2, REFRESH, SEED_REFRESH, "SENTINEL"];

const NOW = Date.parse("2026-11-01T12:00:00Z");
const ACCESS_TTL_S = 7200;
const REFRESH_TTL_S = 47304000;

const SANDBOX_ENV = {
  EBAY_ENVIRONMENT: "sandbox",
  EBAY_CLIENT_ID: CLIENT_ID,
  EBAY_CLIENT_SECRET: CLIENT_SECRET,
  EBAY_RU_NAME: RU_NAME,
};

// ---------------------------------------------------------------------------
// In-memory store (mirrors SecretsManagerService's key guard and the fixed
// error strings the handlers match on)
// ---------------------------------------------------------------------------

const KEY_PATTERN = /^[a-z0-9]+-credentials-[a-zA-Z0-9_-]+$/;

class InMemoryStore {
  constructor() {
    this.map = new Map();
    this.failRead = false;
    this.failWrite = false;
    this.writes = 0;
  }
  _check(key) {
    if (!KEY_PATTERN.test(key)) throw new Error("Invalid credential key format");
  }
  async getCredentials(key) {
    this._check(key);
    if (this.failRead) throw new Error("Failed to retrieve credentials");
    const value = this.map.get(key);
    if (!value) throw new Error("Credentials not found");
    return { ...value };
  }
  async updateCredentials(key, credentials) {
    this._check(key);
    if (this.failWrite) throw new Error("Failed to update credentials");
    this.writes++;
    this.map.set(key, { ...credentials });
  }
  async credentialsExist(key) {
    this._check(key);
    return this.map.has(key);
  }
}

// ---------------------------------------------------------------------------
// Stub eBay. Each test sets `ebay.token` / `ebay.identity` to a responder;
// every call is recorded with its URL, headers and parsed form body.
// ---------------------------------------------------------------------------

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const ebay = {
  calls: [],
  token: null,
  identity: null,
  reset() {
    this.calls = [];
    this.token = () =>
      json(200, {
        access_token: ACCESS,
        expires_in: ACCESS_TTL_S,
        refresh_token: REFRESH,
        refresh_token_expires_in: REFRESH_TTL_S,
        token_type: "User Access Token",
      });
    this.identity = () => json(200, { userId: "abc123immutable", username: "neon_seller_1" });
  },
};

async function fakeFetch(url, init = {}) {
  const headers = new Headers(init.headers);
  const call = {
    url: String(url),
    method: init.method,
    authorization: headers.get("authorization"),
    form: typeof init.body === "string" ? new URLSearchParams(init.body) : null,
  };
  ebay.calls.push(call);
  if (call.url.endsWith("/identity/v1/oauth2/token")) return ebay.token(call);
  if (call.url.endsWith("/commerce/identity/v1/user/")) return ebay.identity(call);
  return json(404, {});
}

// ---------------------------------------------------------------------------
// Log capture — every console line written while a test runs
// ---------------------------------------------------------------------------

const logs = [];
const original = { log: console.log, error: console.error, warn: console.warn };

function captureConsole() {
  for (const level of ["log", "error", "warn"]) {
    console[level] = (...args) => logs.push(args.map(String).join(" "));
  }
}
function restoreConsole() {
  Object.assign(console, original);
}

function assertNoSecretsIn(text, where) {
  for (const s of SENTINELS) {
    assert.ok(!text.includes(s), `${where} must not contain credential material`);
  }
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

let server;
let baseUrl;
let store;
let env;

before(async () => {
  const express = require("express");
  const app = express();
  app.use(express.json({ limit: "10kb" }));
  app.use(
    createEbayOAuthRouter({
      createStore: () => store,
      fetchImpl: fakeFetch,
      env: () => env,
      now: () => NOW,
    }),
  );
  server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  restoreConsole();
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  store = new InMemoryStore();
  env = { ...SANDBOX_ENV };
  ebay.reset();
  logs.length = 0;
  captureConsole();
});

afterEach(() => {
  restoreConsole();
  // Every test's log output is checked, not only the ones about logging.
  assertNoSecretsIn(logs.join("\n"), "log output");
});

async function post(path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text, body: text ? JSON.parse(text) : null };
}

function ebayLogLines() {
  return logs
    .filter((l) => l.startsWith("{"))
    .map((l) => JSON.parse(l))
    .filter((l) => l.msg === "ebay_oauth_call");
}

function seedConnected(extra = {}) {
  store.map.set(KEY, {
    username: "neon_seller_1",
    ebayUserId: "abc123immutable",
    token: ACCESS,
    expiresAt: NOW - 1000,
    refreshToken: REFRESH,
    refreshExpiresAt: NOW + REFRESH_TTL_S * 1000,
    ...extra,
  });
}

// ---------------------------------------------------------------------------
// POST /oauth/ebay/connect
// ---------------------------------------------------------------------------

describe("POST /oauth/ebay/connect — code grant", () => {
  it("exchanges the code, reads the username, stores the session and returns only {username, expiresAt}", async () => {
    const res = await post("/oauth/ebay/connect", { key: KEY, code: CODE });

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, {
      username: "neon_seller_1",
      ebayUserId: "abc123immutable",
      expiresAt: NOW + ACCESS_TTL_S * 1000,
    });
    assertNoSecretsIn(res.text, "connect response");

    assert.deepEqual(store.map.get(KEY), {
      username: "neon_seller_1",
      ebayUserId: "abc123immutable",
      token: ACCESS,
      expiresAt: NOW + ACCESS_TTL_S * 1000,
      refreshToken: REFRESH,
      refreshExpiresAt: NOW + REFRESH_TTL_S * 1000,
    });

    const [tokenCall, identityCall] = ebay.calls;
    assert.equal(tokenCall.url, "https://api.sandbox.ebay.com/identity/v1/oauth2/token");
    assert.equal(tokenCall.method, "POST");
    assert.equal(
      tokenCall.authorization,
      `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`,
    );
    assert.equal(tokenCall.form.get("grant_type"), "authorization_code");
    assert.equal(tokenCall.form.get("code"), CODE, "the code round-trips through form encoding intact");
    assert.equal(tokenCall.form.get("redirect_uri"), RU_NAME);

    assert.equal(identityCall.url, "https://apiz.sandbox.ebay.com/commerce/identity/v1/user/");
    assert.equal(identityCall.method, "GET");
    assert.equal(identityCall.authorization, `Bearer ${ACCESS}`);
    assert.equal(ebay.calls.length, 2);

    const [line] = ebayLogLines();
    assert.equal(line.operation, "connect");
    assert.equal(line.grant, "code");
    assert.equal(line.environment, "sandbox");
    assert.equal(line.success, true);
    assert.equal(line.status_code, 200);
  });

  it("uses the production hosts when EBAY_ENVIRONMENT=production", async () => {
    env.EBAY_ENVIRONMENT = "production";
    const res = await post("/oauth/ebay/connect", { key: KEY, code: CODE });
    assert.equal(res.status, 200);
    assert.equal(ebay.calls[0].url, "https://api.ebay.com/identity/v1/oauth2/token");
    assert.equal(ebay.calls[1].url, "https://apiz.ebay.com/commerce/identity/v1/user/");
  });

  it("replaces a previous session wholesale", async () => {
    seedConnected({ username: "someone_else", password: "legacy-SENTINEL" });
    const res = await post("/oauth/ebay/connect", { key: KEY, code: CODE });
    assert.equal(res.status, 200);
    const stored = store.map.get(KEY);
    assert.equal(stored.username, "neon_seller_1");
    assert.equal(stored.ebayUserId, "abc123immutable");
    assert.equal("password" in stored, false);
  });

  it("refuses a code grant that comes back without a refresh token (502, nothing stored)", async () => {
    ebay.token = () => json(200, { access_token: ACCESS, expires_in: ACCESS_TTL_S });
    const res = await post("/oauth/ebay/connect", { key: KEY, code: CODE });
    assert.equal(res.status, 502);
    assert.deepEqual(res.body, { error_class: "ebay_unavailable" });
    assert.equal(store.map.has(KEY), false);
  });
});

describe("POST /oauth/ebay/connect — refresh-token seed", () => {
  it("runs a refresh grant with the NB scopes and stores the presented refresh token", async () => {
    ebay.token = () => json(200, { access_token: ACCESS, expires_in: ACCESS_TTL_S });
    const res = await post("/oauth/ebay/connect", { key: KEY, refreshToken: SEED_REFRESH });

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, {
      username: "neon_seller_1",
      ebayUserId: "abc123immutable",
      expiresAt: NOW + ACCESS_TTL_S * 1000,
    });
    assertNoSecretsIn(res.text, "seed connect response");

    const form = ebay.calls[0].form;
    assert.equal(form.get("grant_type"), "refresh_token");
    assert.equal(form.get("refresh_token"), SEED_REFRESH);
    assert.equal(form.get("scope"), EBAY_SCOPES.join(" "));
    assert.equal(form.has("redirect_uri"), false);

    assert.deepEqual(store.map.get(KEY), {
      username: "neon_seller_1",
      ebayUserId: "abc123immutable",
      token: ACCESS,
      expiresAt: NOW + ACCESS_TTL_S * 1000,
      refreshToken: SEED_REFRESH,
    });
    assert.equal(ebayLogLines()[0].grant, "refresh_token");
  });
});

describe("POST /oauth/ebay/connect — failures", () => {
  for (const code of ["invalid_grant", "invalid_scope", "access_denied"]) {
    it(`eBay ${code} → 401 consent_refused, nothing stored`, async () => {
      ebay.token = () =>
        json(400, { error: code, error_description: `echo ${CODE} SENTINEL` });
      const res = await post("/oauth/ebay/connect", { key: KEY, code: CODE });
      assert.equal(res.status, 401);
      assert.deepEqual(res.body, { error_class: "consent_refused" });
      assert.equal(store.map.has(KEY), false);
      assert.equal(ebayLogLines()[0].ebay_error, code);
    });
  }

  it("eBay invalid_grant on the seed form → 401 consent_refused", async () => {
    ebay.token = () => json(400, { error: "invalid_grant" });
    const res = await post("/oauth/ebay/connect", { key: KEY, refreshToken: SEED_REFRESH });
    assert.equal(res.status, 401);
    assert.deepEqual(res.body, { error_class: "consent_refused" });
  });

  it("identity 401 (consent lacks the identity scope) → 401 consent_refused", async () => {
    ebay.identity = () => json(401, {});
    const res = await post("/oauth/ebay/connect", { key: KEY, code: CODE });
    assert.equal(res.status, 401);
    assert.deepEqual(res.body, { error_class: "consent_refused" });
    assert.equal(store.map.has(KEY), false);
  });

  for (const status of [500, 503, 429]) {
    it(`eBay token endpoint ${status} → 502 ebay_unavailable`, async () => {
      ebay.token = () => json(status, { error: "server_error" });
      const res = await post("/oauth/ebay/connect", { key: KEY, code: CODE });
      assert.equal(res.status, 502);
      assert.deepEqual(res.body, { error_class: "ebay_unavailable" });
      assert.equal(store.map.has(KEY), false);
      assert.equal(ebayLogLines()[0].ebay_status, status);
    });
  }

  it("eBay invalid_client (our app credentials) → 502, logged as a client fault", async () => {
    ebay.token = () => json(401, { error: "invalid_client" });
    const res = await post("/oauth/ebay/connect", { key: KEY, code: CODE });
    assert.equal(res.status, 502);
    assert.deepEqual(res.body, { error_class: "ebay_unavailable" });
    assert.equal(ebayLogLines()[0].error_class, "ebay_client");
  });

  it("an unrecognised eBay error code is not echoed into the log", async () => {
    ebay.token = () => json(400, { error: `weird ${CODE}` });
    const res = await post("/oauth/ebay/connect", { key: KEY, code: CODE });
    assert.equal(res.status, 502);
    assert.equal(ebayLogLines()[0].ebay_error, undefined);
  });

  it("network failure → 502 ebay_unavailable", async () => {
    ebay.token = () => {
      throw new TypeError(`fetch failed for body ${CODE}`);
    };
    const res = await post("/oauth/ebay/connect", { key: KEY, code: CODE });
    assert.equal(res.status, 502);
    assert.deepEqual(res.body, { error_class: "ebay_unavailable" });
  });

  it("identity 5xx → 502, and the fresh tokens are NOT stored", async () => {
    ebay.identity = () => json(503, {});
    const res = await post("/oauth/ebay/connect", { key: KEY, code: CODE });
    assert.equal(res.status, 502);
    assert.equal(store.map.has(KEY), false);
  });

  for (const [name, identity] of [
    ["no userId", { username: "neon_seller_1" }],
    ["no username", { userId: "abc123immutable" }],
    ["blank userId", { userId: "  ", username: "neon_seller_1" }],
  ]) {
    it(`identity 200 with ${name} → 502, nothing stored`, async () => {
      ebay.identity = () => json(200, identity);
      const res = await post("/oauth/ebay/connect", { key: KEY, code: CODE });
      assert.equal(res.status, 502);
      assert.deepEqual(res.body, { error_class: "ebay_unavailable" });
      assert.equal(store.map.has(KEY), false);
    });
  }

  it("a 200 with no access_token → 502", async () => {
    ebay.token = () => json(200, { expires_in: ACCESS_TTL_S });
    const res = await post("/oauth/ebay/connect", { key: KEY, code: CODE });
    assert.equal(res.status, 502);
  });

  it("Secret Manager write failure → 500 internal", async () => {
    store.failWrite = true;
    const res = await post("/oauth/ebay/connect", { key: KEY, code: CODE });
    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { error_class: "internal" });
    assertNoSecretsIn(res.text, "connect 500 response");
  });
});

describe("POST /oauth/ebay/connect — request validation (400, eBay never called)", () => {
  const cases = [
    ["neither code nor refreshToken", { key: KEY }],
    ["both code and refreshToken", { key: KEY, code: CODE, refreshToken: SEED_REFRESH }],
    ["empty code", { key: KEY, code: "" }],
    ["non-string code", { key: KEY, code: 42 }],
    ["oversized code", { key: KEY, code: "x".repeat(4097) }],
    ["missing key", { code: CODE }],
    ["a BSC key", { key: "buysportscards-credentials-user_test123", code: CODE }],
    ["a key with path characters", { key: "ebay-credentials-../x", code: CODE }],
    ["a non-string key", { key: ["ebay-credentials-user_test123"], code: CODE }],
  ];
  for (const [name, body] of cases) {
    it(name, async () => {
      const res = await post("/oauth/ebay/connect", body);
      assert.equal(res.status, 400);
      assert.deepEqual(res.body, { error_class: "bad_request" });
      assert.equal(ebay.calls.length, 0);
      assert.equal(store.writes, 0);
    });
  }
});

// ---------------------------------------------------------------------------
// POST /oauth/ebay/refresh
// ---------------------------------------------------------------------------

describe("POST /oauth/ebay/refresh", () => {
  it("refreshes, stores the new access token, keeps the refresh token, returns {token, expiresAt}", async () => {
    seedConnected();
    ebay.token = () => json(200, { access_token: ACCESS_2, expires_in: ACCESS_TTL_S });

    const res = await post("/oauth/ebay/refresh", { key: KEY });

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { token: ACCESS_2, expiresAt: NOW + ACCESS_TTL_S * 1000 });
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.ok(!res.text.includes(REFRESH), "refresh token never in the body");
    assert.ok(!/refresh/i.test(Object.keys(res.body).join(",")));

    assert.deepEqual(store.map.get(KEY), {
      username: "neon_seller_1",
      ebayUserId: "abc123immutable",
      token: ACCESS_2,
      expiresAt: NOW + ACCESS_TTL_S * 1000,
      refreshToken: REFRESH,
      refreshExpiresAt: NOW + REFRESH_TTL_S * 1000,
    });

    assert.equal(ebay.calls.length, 1, "refresh never calls identity");
    const form = ebay.calls[0].form;
    assert.equal(form.get("grant_type"), "refresh_token");
    assert.equal(form.get("refresh_token"), REFRESH);
    assert.equal(form.get("scope"), EBAY_SCOPES.join(" "));
  });

  it("stores a refresh token if eBay ever rotates one", async () => {
    seedConnected();
    ebay.token = () =>
      json(200, {
        access_token: ACCESS_2,
        expires_in: ACCESS_TTL_S,
        refresh_token: SEED_REFRESH,
        refresh_token_expires_in: 100,
      });
    const res = await post("/oauth/ebay/refresh", { key: KEY });
    assert.equal(res.status, 200);
    assert.ok(!res.text.includes(SEED_REFRESH));
    assert.equal(store.map.get(KEY).refreshToken, SEED_REFRESH);
    assert.equal(store.map.get(KEY).refreshExpiresAt, NOW + 100_000);
  });

  it("eBay invalid_grant → 401 reauth_required, the stored secret untouched", async () => {
    seedConnected();
    const before = { ...store.map.get(KEY) };
    ebay.token = () => json(400, { error: "invalid_grant" });
    const res = await post("/oauth/ebay/refresh", { key: KEY });
    assert.equal(res.status, 401);
    assert.deepEqual(res.body, { error_class: "reauth_required" });
    assert.deepEqual(store.map.get(KEY), before);
    assert.equal(store.writes, 0);
  });

  it("no secret stored → 401 reauth_required without calling eBay", async () => {
    const res = await post("/oauth/ebay/refresh", { key: KEY });
    assert.equal(res.status, 401);
    assert.deepEqual(res.body, { error_class: "reauth_required" });
    assert.equal(ebay.calls.length, 0);
  });

  it("a secret with no refresh token → 401 reauth_required without calling eBay", async () => {
    store.map.set(KEY, { username: "neon_seller_1", token: ACCESS });
    const res = await post("/oauth/ebay/refresh", { key: KEY });
    assert.equal(res.status, 401);
    assert.equal(ebay.calls.length, 0);
  });

  for (const status of [500, 503, 429]) {
    it(`eBay ${status} → 502 ebay_unavailable, nothing written`, async () => {
      seedConnected();
      ebay.token = () => json(status, {});
      const res = await post("/oauth/ebay/refresh", { key: KEY });
      assert.equal(res.status, 502);
      assert.deepEqual(res.body, { error_class: "ebay_unavailable" });
      assert.equal(store.writes, 0);
    });
  }

  it("a Secret Manager read fault is 500, never 401 (a healthy account must not be flagged)", async () => {
    seedConnected();
    store.failRead = true;
    const res = await post("/oauth/ebay/refresh", { key: KEY });
    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { error_class: "internal" });
  });

  it("a disconnect landing mid-refresh is not undone by the write", async () => {
    seedConnected();
    ebay.token = () => {
      store.map.delete(KEY); // DELETE /credentials/:key while eBay answers
      return json(200, { access_token: ACCESS_2, expires_in: ACCESS_TTL_S });
    };
    const res = await post("/oauth/ebay/refresh", { key: KEY });
    assert.equal(res.status, 401);
    assert.deepEqual(res.body, { error_class: "reauth_required" });
    assert.equal(store.map.has(KEY), false);
    assert.ok(!res.text.includes(ACCESS_2));
  });

  it("a write failure → 500, and the unpersisted token is not returned", async () => {
    seedConnected();
    store.failWrite = true;
    ebay.token = () => json(200, { access_token: ACCESS_2, expires_in: ACCESS_TTL_S });
    const res = await post("/oauth/ebay/refresh", { key: KEY });
    assert.equal(res.status, 500);
    assert.ok(!res.text.includes(ACCESS_2));
  });

  it("refuses a non-eBay key (400) without reading it", async () => {
    store.map.set("buysportscards-credentials-user_test123", {
      username: "x",
      refreshToken: REFRESH,
    });
    const res = await post("/oauth/ebay/refresh", {
      key: "buysportscards-credentials-user_test123",
    });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error_class: "bad_request" });
    assert.equal(ebay.calls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

describe("unset or invalid eBay configuration → 503 ebay_not_configured", () => {
  const variants = [
    ["EBAY_CLIENT_ID unset", { EBAY_CLIENT_ID: undefined }],
    ["EBAY_CLIENT_SECRET unset", { EBAY_CLIENT_SECRET: undefined }],
    ["EBAY_RU_NAME unset", { EBAY_RU_NAME: undefined }],
    ["EBAY_ENVIRONMENT unset", { EBAY_ENVIRONMENT: undefined }],
    ["EBAY_ENVIRONMENT not a known name", { EBAY_ENVIRONMENT: "prod" }],
    ["EBAY_CLIENT_SECRET blank", { EBAY_CLIENT_SECRET: "  " }],
  ];
  for (const [name, patch] of variants) {
    for (const path of ["/oauth/ebay/connect", "/oauth/ebay/refresh"]) {
      it(`${name}: ${path}`, async () => {
        env = { ...SANDBOX_ENV, ...patch };
        for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
        seedConnected();
        const res = await post(path, { key: KEY, code: CODE });
        assert.equal(res.status, 503);
        assert.deepEqual(res.body, { error_class: "ebay_not_configured" });
        assert.equal(ebay.calls.length, 0);
      });
    }
  }
});

// ---------------------------------------------------------------------------
// Logging and rate limiting
// ---------------------------------------------------------------------------

describe("logging", () => {
  it("writes ebay_oauth_call lines, never browser_login_call (which feeds the login alerts)", async () => {
    await post("/oauth/ebay/connect", { key: KEY, code: CODE });
    seedConnected();
    await post("/oauth/ebay/refresh", { key: KEY });
    ebay.token = () => json(400, { error: "invalid_grant" });
    await post("/oauth/ebay/refresh", { key: KEY });

    const lines = ebayLogLines();
    assert.equal(lines.length, 3);
    assert.deepEqual(
      lines.map((l) => [l.operation, l.status_code]),
      [
        ["connect", 200],
        ["refresh", 200],
        ["refresh", 401],
      ],
    );
    assert.ok(!logs.some((l) => l.includes("browser_login_call")));
    assert.ok(!logs.some((l) => l.includes(KEY)), "the credential key is not logged");
  });
});

describe("rate limiting", () => {
  it("both routes land in the per-credential-key bucket, not the shared IP bucket", () => {
    for (const path of ["/oauth/ebay/connect", "/oauth/ebay/refresh"]) {
      assert.equal(
        credentialRateLimitKey({ path, params: {}, body: { key: KEY }, ip: "10.0.0.1" }),
        `cred:${KEY}`,
      );
    }
  });
});
