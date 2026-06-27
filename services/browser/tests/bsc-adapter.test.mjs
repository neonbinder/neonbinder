/**
 * Unit tests for BSCAdapter.login — browser-free Azure AD B2C flow.
 *
 * The BSC adapter no longer uses Puppeteer for login. It replays the B2C
 * custom-policy sign-in (B2C_1A_signin) entirely over fetch:
 *
 *   1. GET  /authorize          → self-asserted HTML embedding
 *                                 `var SETTINGS = {csrf, transId, api}`
 *                                 + Set-Cookie: x-ms-cpim-*
 *   2. POST /SelfAsserted       → {"status":"200"} accept / {"status":"400"} reject
 *   3. GET  /api/<api>/confirmed → 302 Location: redirectUri#code=...
 *   4. POST /token              → { access_token }
 *   5. GET  /marketplace/user/profile → { sellerProfile }
 *
 * Strategy: patch SecretsManagerService in the require cache and stub global
 * fetch with a router keyed on URL. No real network, no Chromium. Tests focus
 * on: the cached-token short-circuit, the full happy-path B2C exchange, each
 * failure branch returning a structured (non-throwing) response with a
 * sanitized diagnostic, the cleanup() no-op invariant (no browser is ever
 * launched), and credential non-leakage.
 *
 * Token storage convention: Secret Manager stores the BSC token *without* the
 * "Bearer " prefix; the adapter prepends "Bearer " on the profile request.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Module loading / mocking helpers
// ---------------------------------------------------------------------------

/**
 * Patch SecretsManagerService in the require cache, then reload bsc-adapter
 * and base-adapter fresh so they pick up the new mock.
 */
function loadBSCAdapter({ credentials, updateCredentials }) {
  delete require.cache[require.resolve("../dist/adapters/base-adapter")];
  delete require.cache[require.resolve("../dist/adapters/bsc-adapter")];

  const smPath = require.resolve("../dist/services/secrets-manager");
  const smMod = require(smPath);
  smMod.SecretsManagerService = class MockSecretsManagerService {
    async getCredentials(_key) {
      if (typeof credentials === "function") return credentials();
      return credentials;
    }
    async updateCredentials(key, creds) {
      if (updateCredentials) updateCredentials(key, creds);
    }
    async deleteCredentials(_key) {}
    async credentialsExist(_key) { return true; }
  };

  const { BSCAdapter } = require("../dist/adapters/bsc-adapter");
  return BSCAdapter;
}

/** Install a global fetch stub for one test. Returns a restore function. */
function stubFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return () => { globalThis.fetch = original; };
}

/** A minimal fetch Response-like with a working getSetCookie(). */
function makeResponse({ status = 200, ok, body = "", json, location, setCookies = [] } = {}) {
  const headers = {
    get: (name) => {
      const n = name.toLowerCase();
      if (n === "location") return location ?? null;
      return null;
    },
    getSetCookie: () => setCookies,
  };
  return {
    status,
    ok: ok ?? (status >= 200 && status < 300),
    headers,
    text: async () => body,
    json: async () => (json !== undefined ? json : JSON.parse(body)),
  };
}

const SETTINGS_HTML = (overrides = {}) => {
  const s = { csrf: "csrf-tok-abc", transId: "tx-123", api: "SelfAsserted", ...overrides };
  return `<!doctype html><html><body><div id="api"></div><script>var SETTINGS = ${JSON.stringify(s)};</script></body></html>`;
};

/**
 * Build a fetch router that drives the full happy-path B2C exchange. Each call
 * is recorded so tests can assert on what was sent (including header/body
 * leak checks). Per-step overrides let a test fail one step while leaving the
 * rest healthy.
 */
function makeB2CRouter(overrides = {}) {
  const calls = [];
  const handler = async (url, opts = {}) => {
    const u = String(url);
    calls.push({ url: u, opts });

    if (u.includes("/oauth2/v2.0/authorize")) {
      if (overrides.authorize) return overrides.authorize(u, opts);
      return makeResponse({
        status: 200,
        body: SETTINGS_HTML(overrides.settings),
        setCookies: [
          "x-ms-cpim-csrf=cookieval1; path=/; secure; httponly",
          "x-ms-cpim-trans=cookieval2; path=/; secure; httponly",
        ],
      });
    }
    // NB: the confirmed endpoint is /api/<api>/confirmed where <api> is itself
    // "SelfAsserted", so match /confirmed FIRST to avoid the /SelfAsserted
    // branch swallowing it.
    if (u.includes("/confirmed")) {
      if (overrides.confirmed) return overrides.confirmed(u, opts);
      return makeResponse({
        status: 302,
        location: "https://www.buysportscards.com/#code=auth-code-xyz&state=st",
      });
    }
    if (u.includes("/SelfAsserted")) {
      if (overrides.selfAsserted) return overrides.selfAsserted(u, opts);
      return makeResponse({ status: 200, body: JSON.stringify({ status: "200" }) });
    }
    if (u.includes("/oauth2/v2.0/token")) {
      if (overrides.token) return overrides.token(u, opts);
      return makeResponse({ status: 200, json: { access_token: "fresh-access-token", token_type: "Bearer", expires_in: 3600 } });
    }
    if (u.includes("api-prod.buysportscards.com/marketplace/user/profile")) {
      if (overrides.profile) return overrides.profile(u, opts);
      return makeResponse({ status: 200, json: { sellerProfile: { sellerStoreName: "Fresh Store", sellerId: "fresh-login-seller" } } });
    }
    throw new Error(`unexpected fetch in test: ${u}`);
  };
  handler.calls = calls;
  return handler;
}

// ---------------------------------------------------------------------------
// Cache-hit path
// ---------------------------------------------------------------------------

describe("BSCAdapter.login — cache-hit path", () => {
  it("returns success with storeName/sellerId when the cached token passes profile validation, without any B2C calls", async () => {
    const updates = [];
    const BSCAdapter = loadBSCAdapter({
      credentials: {
        username: "seller@example.com",
        password: "secret",
        token: "bare-token-abc123",
        expiresAt: Date.now() + 60 * 60 * 1000,
      },
      updateCredentials: (key, creds) => updates.push({ key, creds }),
    });

    const calls = [];
    const restore = stubFetch(async (url, opts) => {
      calls.push(String(url));
      assert.equal(new URL(url).hostname, "api-prod.buysportscards.com", "cache-hit should only hit the profile API");
      return makeResponse({ status: 200, json: { sellerProfile: { sellerStoreName: "Acme Cards", sellerId: "abcd1234efgh" } } });
    });

    const adapter = new BSCAdapter(undefined);
    const result = await adapter.login("buysportscards-credentials-seller1");
    restore();

    assert.equal(result.success, true);
    assert.equal(result.storeName, "Acme Cards");
    assert.equal(result.sellerId, "abcd1234efgh", "should surface sellerId from profile so Convex can persist it");
    assert.ok(result.expiresAt > Date.now());
    assert.match(result.message, /cached token/);
    assert.equal(updates.length, 0, "must NOT mutate the secret on a clean cache hit");
    assert.equal(calls.length, 1, "exactly one fetch (the profile validation); no B2C exchange");
  });

  it("prepends 'Bearer ' to the bare cached token on the profile validation request (regression: bare-token 401)", async () => {
    let authHeader;
    const BSCAdapter = loadBSCAdapter({
      credentials: {
        username: "seller@example.com",
        password: "secret",
        token: "raw-jwt-token-value",
        expiresAt: Date.now() + 60 * 60 * 1000,
      },
      updateCredentials: null,
    });

    const restore = stubFetch(async (_url, opts) => {
      authHeader = (opts?.headers ?? {})["Authorization"];
      return makeResponse({ status: 200, json: { sellerProfile: { sellerStoreName: "Test Store" } } });
    });

    const adapter = new BSCAdapter(undefined);
    await adapter.login("buysportscards-credentials-seller1");
    restore();

    assert.equal(authHeader, "Bearer raw-jwt-token-value", "must prepend 'Bearer ' to the bare cached token");
  });
});

// ---------------------------------------------------------------------------
// Cache-invalid → fresh B2C login
// ---------------------------------------------------------------------------

describe("BSCAdapter.login — cache-invalid → fresh B2C login", () => {
  it("clears the stale token, runs the browser-free B2C exchange, and persists the fresh token", async () => {
    const updates = [];
    const baseCreds = {
      username: "seller@example.com",
      password: "secret",
      token: "stale-bare-token",
      expiresAt: Date.now() + 60 * 60 * 1000,
    };
    const BSCAdapter = loadBSCAdapter({
      credentials: () => (updates.length === 0 ? baseCreds : { username: baseCreds.username, password: baseCreds.password }),
      updateCredentials: (key, creds) => updates.push({ key, creds }),
    });

    // First profile call (stale-token validation) → 401; later profile calls → 200.
    let profileCalls = 0;
    const router = makeB2CRouter({
      profile: () => {
        profileCalls++;
        if (profileCalls === 1) return makeResponse({ status: 401, ok: false, json: { error: "Unauthorized" } });
        return makeResponse({ status: 200, json: { sellerProfile: { sellerStoreName: "Acme Cards", sellerId: "fresh-seller-id" } } });
      },
    });
    const restore = stubFetch(router);

    const adapter = new BSCAdapter(undefined);
    const result = await adapter.login("buysportscards-credentials-seller1");
    restore();

    assert.equal(result.success, true, "fresh login should succeed after stale-cache clear");
    assert.equal(result.sellerId, "fresh-seller-id");
    assert.match(result.message, /Successfully logged into/, "message should reflect fresh login, not cached");

    // First update clears the stale token; second persists the new one.
    assert.equal(updates.length, 2, "should clear stale cache, then persist fresh token");
    const [clear, persist] = updates;
    assert.equal(clear.creds.token, undefined, "stale-clear update should remove token");
    assert.equal(clear.creds.expiresAt, undefined);
    assert.equal(clear.creds.username, "seller@example.com", "stale-clear must preserve username");
    assert.equal(clear.creds.password, "secret", "stale-clear must preserve password");
    assert.equal(persist.creds.token, "fresh-access-token", "should persist the BARE access token (no 'Bearer ' prefix)");
    assert.ok(persist.creds.expiresAt > Date.now());
  });
});

// ---------------------------------------------------------------------------
// Fresh login (no cached token)
// ---------------------------------------------------------------------------

describe("BSCAdapter.login — fresh B2C login (no cached token)", () => {
  it("runs the full /authorize→/SelfAsserted→/confirmed→/token exchange and persists the bare token + ~1h expiry", async () => {
    const updates = [];
    const BSCAdapter = loadBSCAdapter({
      credentials: { username: "seller@example.com", password: "secret" },
      updateCredentials: (key, creds) => updates.push({ key, creds }),
    });

    const router = makeB2CRouter();
    const restore = stubFetch(router);

    const before = Date.now();
    const adapter = new BSCAdapter(undefined);
    const result = await adapter.login("buysportscards-credentials-seller1");
    const after = Date.now();
    restore();

    assert.equal(result.success, true);
    assert.equal(result.storeName, "Fresh Store");
    assert.equal(result.sellerId, "fresh-login-seller");

    // The four B2C endpoints were all hit, in order, plus the profile fetch.
    const hosts = router.calls.map((c) => c.url);
    assert.ok(hosts.some((u) => u.includes("/oauth2/v2.0/authorize")), "should GET /authorize");
    assert.ok(hosts.some((u) => u.includes("/SelfAsserted")), "should POST /SelfAsserted");
    assert.ok(hosts.some((u) => u.includes("/confirmed")), "should GET /confirmed");
    assert.ok(hosts.some((u) => u.includes("/oauth2/v2.0/token")), "should POST /token");

    assert.equal(updates.length, 1, "should persist the extracted token exactly once");
    const persisted = updates[0].creds;
    assert.equal(persisted.token, "fresh-access-token");
    const oneHour = 60 * 60 * 1000;
    assert.ok(persisted.expiresAt >= before + oneHour - 5000 && persisted.expiresAt <= after + oneHour + 5000, "expiresAt ~1h ahead");
    assert.equal(result.expiresAt, persisted.expiresAt, "response.expiresAt should match persisted");
  });

  it("sends PKCE + the credentials to the right B2C endpoints (code_challenge on /authorize, signInName/password to /SelfAsserted, code_verifier to /token)", async () => {
    const BSCAdapter = loadBSCAdapter({
      credentials: { username: "seller@example.com", password: "secret" },
      updateCredentials: null,
    });
    const router = makeB2CRouter();
    const restore = stubFetch(router);

    const adapter = new BSCAdapter(undefined);
    await adapter.login("buysportscards-credentials-seller1");
    restore();

    const authorize = router.calls.find((c) => c.url.includes("/authorize"));
    assert.ok(authorize.url.includes("code_challenge=") && authorize.url.includes("code_challenge_method=S256"), "/authorize must carry an S256 PKCE challenge");
    assert.ok(authorize.url.includes("client_id=9b4d7d82-6b2b-4c9e-9542-d94ee43bcac1"), "/authorize must carry the BSC client_id");

    const selfAsserted = router.calls.find((c) => c.url.includes("/SelfAsserted"));
    assert.equal(selfAsserted.opts.method, "POST");
    assert.ok(selfAsserted.opts.body.includes("signInName=seller%40example.com"), "credentials go in the SelfAsserted body");
    assert.equal(selfAsserted.opts.headers["X-CSRF-TOKEN"], "csrf-tok-abc", "must echo the SETTINGS csrf token");
    assert.ok(selfAsserted.opts.headers["Cookie"].includes("x-ms-cpim-csrf="), "must echo the x-ms-cpim cookies");

    const token = router.calls.find((c) => c.url.includes("/oauth2/v2.0/token"));
    assert.ok(token.opts.body.includes("code_verifier="), "/token must include the PKCE verifier");
    assert.ok(token.opts.body.includes("grant_type=authorization_code"), "/token must use the auth-code grant");
  });
});

// ---------------------------------------------------------------------------
// Failure branches — must be structured (never throw), with sanitized output
// ---------------------------------------------------------------------------

describe("BSCAdapter.login — failure branches", () => {
  it("returns a structured failure with a sanitized diagnostic when SelfAsserted rejects the credentials", async () => {
    const updates = [];
    const BSCAdapter = loadBSCAdapter({
      credentials: { username: "seller@example.com", password: "hunter2" },
      updateCredentials: (key, creds) => updates.push({ key, creds }),
    });
    const router = makeB2CRouter({
      selfAsserted: () =>
        makeResponse({ status: 200, body: JSON.stringify({ status: "400", message: "Your password is incorrect: seller@example.com / hunter2" }) }),
    });
    const restore = stubFetch(router);

    const adapter = new BSCAdapter(undefined);
    const result = await adapter.login("buysportscards-credentials-seller1");
    restore();

    assert.equal(result.success, false);
    assert.equal(result.error, "Authentication failed", "caller-facing error must be generic, never the raw B2C message");
    assert.ok(result.diagnostic, "should attach a sanitized diagnostic");
    // Diagnostic must not leak the typed email/password that the B2C message echoed back.
    const blob = JSON.stringify(result.diagnostic);
    assert.doesNotMatch(blob, /seller@example\.com/, "diagnostic must redact the email");
    assert.doesNotMatch(blob, /hunter2/, "diagnostic must redact the password");
    assert.equal(updates.length, 0, "must NOT persist any token on an auth failure");
    assert.ok(!router.calls.some((c) => c.url.includes("/token")), "must not reach the token endpoint after a credential rejection");
  });

  it("returns a structured failure when /authorize yields no sign-in form (missing SETTINGS)", async () => {
    const BSCAdapter = loadBSCAdapter({
      credentials: { username: "seller@example.com", password: "secret" },
      updateCredentials: null,
    });
    const router = makeB2CRouter({
      authorize: () => makeResponse({ status: 200, body: "<html><body>maintenance</body></html>" }),
    });
    const restore = stubFetch(router);

    const adapter = new BSCAdapter(undefined);
    const result = await adapter.login("buysportscards-credentials-seller1");
    restore();

    assert.equal(result.success, false);
    assert.equal(result.error, "Authentication failed");
    assert.ok(result.diagnostic, "should attach a diagnostic from the unexpected /authorize page");
    assert.ok(!router.calls.some((c) => c.url.includes("/SelfAsserted")), "must not POST credentials when there is no form");
  });

  it("returns a generic failure when the token exchange fails", async () => {
    const updates = [];
    const BSCAdapter = loadBSCAdapter({
      credentials: { username: "seller@example.com", password: "secret" },
      updateCredentials: (key, creds) => updates.push({ key, creds }),
    });
    const router = makeB2CRouter({
      token: () => makeResponse({ status: 400, ok: false, json: { error: "invalid_grant", error_description: "AADB2C90080 trace 1234" } }),
    });
    const restore = stubFetch(router);

    const adapter = new BSCAdapter(undefined);
    const result = await adapter.login("buysportscards-credentials-seller1");
    restore();

    assert.equal(result.success, false);
    assert.equal(result.error, "Authentication failed", "must not surface the raw B2C error_description");
    assert.equal(updates.length, 0, "no token to persist when exchange fails");
  });

  it("returns a structured failure (not a throw) when /confirmed returns no auth code", async () => {
    const BSCAdapter = loadBSCAdapter({
      credentials: { username: "seller@example.com", password: "secret" },
      updateCredentials: null,
    });
    const router = makeB2CRouter({
      confirmed: () => makeResponse({ status: 302, location: "https://www.buysportscards.com/#error=access_denied" }),
    });
    const restore = stubFetch(router);

    const adapter = new BSCAdapter(undefined);
    const result = await adapter.login("buysportscards-credentials-seller1");
    restore();

    assert.equal(result.success, false);
    assert.equal(result.error, "Authentication failed");
    assert.ok(!router.calls.some((c) => c.url.includes("/token")), "must not exchange when there is no code");
  });

  it("returns a generic failure (not a throw) on a network error mid-exchange", async () => {
    const BSCAdapter = loadBSCAdapter({
      credentials: { username: "seller@example.com", password: "secret" },
      updateCredentials: null,
    });
    const restore = stubFetch(async () => { throw new Error("ECONNRESET https://identity.buysportscards.com/...?client_id=9b4d..."); });

    const adapter = new BSCAdapter(undefined);
    const result = await adapter.login("buysportscards-credentials-seller1");
    restore();

    assert.equal(result.success, false);
    assert.equal(result.error, "Authentication failed", "network errors must not leak request URLs/params to the caller");
  });

  it("returns a structured 'Missing credentials' failure when username/password are absent", async () => {
    const BSCAdapter = loadBSCAdapter({
      credentials: { username: "", password: "" },
      updateCredentials: null,
    });
    // No fetch should ever be made.
    const restore = stubFetch(async (u) => { throw new Error(`unexpected fetch: ${u}`); });

    const adapter = new BSCAdapter(undefined);
    const result = await adapter.login("buysportscards-credentials-seller1");
    restore();

    assert.equal(result.success, false);
    assert.match(result.error, /Missing credentials/);
  });
});

// ---------------------------------------------------------------------------
// Diagnostic sanitization: script/style stripping (CodeQL js/bad-tag-filter)
// ---------------------------------------------------------------------------
//
// When /authorize returns a page with no sign-in form, the adapter strips the
// HTML (stripTags) and feeds the visible-text approximation to
// buildLoginDiagnostic for the snippet. stripTags MUST remove <script>/<style>
// block CONTENT so inline token material never reaches the diagnostic — even
// when the end tag uses a non-canonical spelling (trailing whitespace/newline,
// bogus attributes, or an unterminated block running to EOF). A naive
// `</script>` filter misses `</script >` / `</style\n>` (the bypass CodeQL's
// js/bad-tag-filter flags), letting the script body slip through.
//
// We exercise the real stripTags via the public login() "no form" branch and
// assert the secret CONTENT does not survive in result.diagnostic.
//
// CRITICAL test-design note: buildLoginDiagnostic ALSO value-redacts the typed
// email/password (case-insensitively) from the snippet. If a marker shared a
// substring with the mock credentials, that redaction — not stripTags — could
// mask it and give a false pass (an early draft of this test used the literal
// "SECRET..." with a "secret" password and passed against the OLD vulnerable
// regex for exactly that reason). So the markers below ("LEAKCANARY*") share NO
// substring with the credentials, and the credentials themselves contain no
// "leak"/"canary" fragment. Their absence therefore proves stripTags removed
// the whole <script>/<style> block, not that value-redaction masked the leak.

describe("BSCAdapter — diagnostic script/style stripping (CodeQL js/bad-tag-filter)", () => {
  const CREDS = { username: "vendor99@example.com", password: "p@ssw0rd-9z!" };

  async function diagnosticForAuthorizeBody(body) {
    const BSCAdapter = loadBSCAdapter({ credentials: CREDS, updateCredentials: null });
    // Authorize returns a page with NO SETTINGS form → adapter strips HTML and
    // builds a diagnostic from the result; no further B2C calls should happen.
    const router = makeB2CRouter({
      authorize: () => makeResponse({ status: 200, body }),
    });
    const restore = stubFetch(router);
    const adapter = new BSCAdapter(undefined);
    const result = await adapter.login("buysportscards-credentials-seller1");
    restore();
    assert.equal(result.success, false);
    assert.ok(result.diagnostic, "no-form branch must attach a diagnostic");
    assert.ok(
      !router.calls.some((c) => c.url.includes("/SelfAsserted")),
      "must not POST credentials when there is no sign-in form",
    );
    return result.diagnostic;
  }

  /** Guard: a marker must not be redactable by credential value (else a pass is meaningless). */
  function assertNotCredentialDerived(marker) {
    const lc = marker.toLowerCase();
    for (const v of [CREDS.username, CREDS.password]) {
      assert.ok(
        !lc.includes(v.toLowerCase()),
        `marker "${marker}" must not contain a credential value, or value-redaction (not stripTags) could mask it`,
      );
    }
  }

  it("drops <script> content even when the end tag has trailing whitespace (</script >)", async () => {
    const MARKER = "LEAKCANARY_TRAILING_SPACE";
    assertNotCredentialDerived(MARKER);
    const diagnostic = await diagnosticForAuthorizeBody(
      `<html><body>down for maintenance<script>var t='${MARKER}';</script ></body></html>`,
    );
    assert.doesNotMatch(
      JSON.stringify(diagnostic),
      new RegExp(MARKER),
      "script body must not survive a '</script >' end tag",
    );
  });

  it("drops <script> content when the end tag has a newline before '>' (</script\\n>)", async () => {
    const MARKER = "LEAKCANARY_NEWLINE";
    assertNotCredentialDerived(MARKER);
    const diagnostic = await diagnosticForAuthorizeBody(
      `<html><body>maintenance<script>var t='${MARKER}';</script\n></body></html>`,
    );
    assert.doesNotMatch(
      JSON.stringify(diagnostic),
      new RegExp(MARKER),
      "script body must not survive a '</script\\n>' end tag",
    );
  });

  it("drops <script> content when the end tag carries bogus attributes (</script foo>)", async () => {
    const MARKER = "LEAKCANARY_BOGUS_ATTR";
    assertNotCredentialDerived(MARKER);
    const diagnostic = await diagnosticForAuthorizeBody(
      `<html><body>maintenance<script>var t='${MARKER}';</script foo="bar"></body></html>`,
    );
    assert.doesNotMatch(
      JSON.stringify(diagnostic),
      new RegExp(MARKER),
      "script body must not survive a '</script foo>' end tag",
    );
  });

  it("drops <style> content when the end tag has a newline before '>' (</style\\n>)", async () => {
    const MARKER = "LEAKCANARY_STYLE_NEWLINE";
    assertNotCredentialDerived(MARKER);
    const diagnostic = await diagnosticForAuthorizeBody(
      `<html><head><style>.x{background:url(${MARKER})}</style\n></head><body>maintenance</body></html>`,
    );
    assert.doesNotMatch(
      JSON.stringify(diagnostic),
      new RegExp(MARKER),
      "style body must not survive a '</style\\n>' end tag",
    );
  });

  it("drops an unterminated <script> block that runs to end-of-input", async () => {
    const MARKER = "LEAKCANARY_EOF";
    assertNotCredentialDerived(MARKER);
    const diagnostic = await diagnosticForAuthorizeBody(
      `<html><body>maintenance<script>var t='${MARKER}';`,
    );
    assert.doesNotMatch(
      JSON.stringify(diagnostic),
      new RegExp(MARKER),
      "an unterminated script block must be dropped, not left in the snippet",
    );
  });

  it("preserves surrounding visible text while stripping the script block", async () => {
    const MARKER = "LEAKCANARY_KEEP_TEXT";
    assertNotCredentialDerived(MARKER);
    const diagnostic = await diagnosticForAuthorizeBody(
      `<html><body>VISIBLE_MAINTENANCE_TEXT<script>var t='${MARKER}';</script ></body></html>`,
    );
    const blob = JSON.stringify(diagnostic);
    assert.doesNotMatch(blob, new RegExp(MARKER), "script body must be removed");
    assert.match(
      blob,
      /VISIBLE_MAINTENANCE_TEXT/,
      "visible page text should still reach the diagnostic snippet",
    );
  });
});

// ---------------------------------------------------------------------------
// Browser-free invariant: cleanup() is always a no-op
// ---------------------------------------------------------------------------
//
// The login path never calls launchPage(), so this.browser is never set and
// cleanup() must be a safe no-op on every path. We assert this directly by
// confirming cleanup() resolves without touching Puppeteer (puppeteer.launch
// is replaced with a spy that throws if ever called).

describe("BSCAdapter — browser-free invariant", () => {
  function spyPuppeteerNeverLaunches() {
    const puppeteerPath = require.resolve("puppeteer");
    let launched = false;
    const launch = async () => { launched = true; throw new Error("puppeteer.launch must NOT be called by the BSC login path"); };
    require.cache[puppeteerPath] = {
      id: puppeteerPath, filename: puppeteerPath, loaded: true,
      exports: { default: { launch }, launch },
      children: [], parent: null, paths: [],
    };
    return () => launched;
  }

  beforeEach(() => {
    // Reset puppeteer cache so each test gets the spy below if it installs one.
    delete require.cache[require.resolve("puppeteer")];
  });

  it("never launches a browser on a fresh login, and cleanup() is a safe no-op", async () => {
    const wasLaunched = spyPuppeteerNeverLaunches();
    const BSCAdapter = loadBSCAdapter({
      credentials: { username: "seller@example.com", password: "secret" },
      updateCredentials: null,
    });
    const restore = stubFetch(makeB2CRouter());

    const adapter = new BSCAdapter(undefined);
    const result = await adapter.login("buysportscards-credentials-seller1");
    await assert.doesNotReject(adapter.cleanup(), "cleanup() must be a no-op when no browser was launched");
    restore();

    assert.equal(result.success, true);
    assert.equal(wasLaunched(), false, "the login path must never launch Chromium");
  });

  it("never launches a browser on the cache-invalid → fresh-login fallthrough, and cleanup() is a no-op", async () => {
    const wasLaunched = spyPuppeteerNeverLaunches();
    const updates = [];
    const BSCAdapter = loadBSCAdapter({
      credentials: () =>
        updates.length === 0
          ? { username: "seller@example.com", password: "secret", token: "stale", expiresAt: Date.now() + 3600_000 }
          : { username: "seller@example.com", password: "secret" },
      updateCredentials: (k, c) => updates.push({ k, c }),
    });
    let profileCalls = 0;
    const restore = stubFetch(makeB2CRouter({
      profile: () => {
        profileCalls++;
        return profileCalls === 1
          ? makeResponse({ status: 401, ok: false, json: { error: "Unauthorized" } })
          : makeResponse({ status: 200, json: { sellerProfile: { sellerStoreName: "S", sellerId: "id" } } });
      },
    }));

    const adapter = new BSCAdapter(undefined);
    const result = await adapter.login("buysportscards-credentials-seller1");
    await assert.doesNotReject(adapter.cleanup());
    restore();

    assert.equal(result.success, true);
    assert.equal(wasLaunched(), false, "even the stale-token fallthrough must never launch Chromium");
  });

  it("cleanup() is idempotent and never throws", async () => {
    spyPuppeteerNeverLaunches();
    const BSCAdapter = loadBSCAdapter({
      credentials: { username: "seller@example.com", password: "secret" },
      updateCredentials: null,
    });
    const restore = stubFetch(makeB2CRouter());
    const adapter = new BSCAdapter(undefined);
    await adapter.login("buysportscards-credentials-seller1");
    await adapter.cleanup();
    await assert.doesNotReject(adapter.cleanup(), "second cleanup() must be a no-op");
    restore();
  });
});
