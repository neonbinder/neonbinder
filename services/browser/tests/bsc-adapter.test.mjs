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
      // Shaped like the real B2C response, probed live 2026-08-11: an hour of
      // access token and a DAY of refresh token, the latter rotating on use.
      return makeResponse({
        status: 200,
        json: {
          access_token: "fresh-access-token",
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: "fresh-refresh-token",
          refresh_token_expires_in: 86400,
        },
      });
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

/**
 * A fetch router for the REFRESH grant.
 *
 * Records the refresh token presented on each call (so a test can prove the
 * chain advanced) and mints a fresh, distinct one each time — which is what
 * BSC's B2C tenant actually does: the grant ROTATES, invalidating the token
 * presented. Anything other than /token or the profile endpoint throws, so a
 * test that accidentally falls back to a password sign-in fails loudly instead
 * of quietly passing.
 *
 * SECURITY NOTE for anyone extending this: the values below are fixtures with
 * no relationship to any real token. Never paste a captured token into a test.
 */
function makeRefreshRouter({ tokenResponse } = {}) {
  const presented = [];
  let minted = 0;
  const handler = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes("/oauth2/v2.0/token")) {
      const body = new URLSearchParams(String(opts.body ?? ""));
      assert.equal(body.get("grant_type"), "refresh_token", "must use the refresh grant");
      presented.push(body.get("refresh_token"));
      if (tokenResponse) return tokenResponse(body, presented.length);
      minted++;
      return makeResponse({
        status: 200,
        json: {
          access_token: `access-token-${minted}`,
          expires_in: 3600,
          refresh_token: `refresh-token-${minted}`,
          refresh_token_expires_in: 86400,
        },
      });
    }
    if (u.includes("api-prod.buysportscards.com/marketplace/user/profile")) {
      return makeResponse({
        status: 200,
        json: { sellerProfile: { sellerStoreName: "Acme Cards", sellerId: "seller-1" } },
      });
    }
    throw new Error(`unexpected fetch in refresh test (password sign-in attempted?): ${u}`);
  };
  handler.presented = presented;
  return handler;
}

/**
 * A stateful stand-in for a Secret Manager secret.
 *
 * `updateCredentials` REPLACES the payload wholesale (Secret Manager stores a
 * new version, it does not merge), and `getCredentials` hands back a copy with
 * the access token forced expired — modelling the ordinary hourly cadence
 * where the 1h access token has lapsed but the 24h refresh token has not.
 * That is what makes a second call take the refresh path rather than a cache
 * hit, which is the whole point of the rotation test below.
 */
function statefulSecret(initial) {
  const state = { payload: { ...initial }, writes: [] };
  return {
    state,
    credentials: () => ({ ...state.payload, expiresAt: Date.now() - 1 }),
    updateCredentials: (_key, creds) => {
      state.writes.push({ ...creds });
      state.payload = { ...creds };
    },
  };
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
  it("runs the browser-free B2C exchange and persists the fresh token with a SINGLE secret write", async () => {
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

    assert.equal(result.success, true, "fresh login should succeed after the stale token is rejected");
    assert.equal(result.sellerId, "fresh-seller-id");
    assert.match(result.message, /Successfully logged into/, "message should reflect fresh login, not cached");

    // NEO-115: exactly ONE write. The old code wrote a token-cleared version
    // first and then immediately overwrote it with the fresh token — two
    // billed Secret Manager versions per hourly TTL expiry, to blank a field
    // the second write set anyway. That intermediate write is gone; if it
    // ever comes back, this assertion fails.
    assert.equal(updates.length, 1, "stale-token path must write the secret exactly once");
    const [persist] = updates;
    assert.equal(persist.creds.token, "fresh-access-token", "should persist the BARE access token (no 'Bearer ' prefix)");
    assert.ok(persist.creds.expiresAt > Date.now());
    assert.equal(persist.creds.username, "seller@example.com", "write-back must preserve username");
    // NEO-141: the write-back used to be `{...credentials, token, expiresAt}`,
    // and that spread re-persisted the seller's password on EVERY hourly token
    // refresh — the secret could never shed it no matter what the intake path
    // did. It is now an explicit field list with no password in it.
    assert.equal(
      persist.creds.password,
      undefined,
      "write-back must NOT persist the password for a user key",
    );
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
// NEO-141 — the refresh grant, and the rotation chain
// ---------------------------------------------------------------------------
//
// This is what replaced storing the user's password. BSC's B2C tenant issues a
// 24h refresh token on every sign-in (proven live 2026-08-11 — `offline_access`
// is not even required), and the refresh grant ROTATES it: each call returns a
// new refresh token and invalidates the one presented.
//
// That rotation is what makes persistence non-negotiable. Miss one write and
// the chain is severed: the token we hold is already dead, and the user is back
// to typing a password we deliberately no longer store.

describe("BSCAdapter.login — NEO-141 refresh grant", () => {
  const LIVE_REFRESH = {
    username: "seller@example.com",
    token: "stale-access-token",
    refreshToken: "refresh-token-0",
    refreshExpiresAt: Date.now() + 24 * 60 * 60 * 1000,
  };

  it("uses the refresh grant instead of a password sign-in when the access token is expired", async () => {
    const secret = statefulSecret(LIVE_REFRESH);
    const BSCAdapter = loadBSCAdapter(secret);
    // makeRefreshRouter throws on any B2C sign-in URL, so reaching /authorize
    // fails this test rather than silently passing on the old code path.
    const router = makeRefreshRouter();
    const restore = stubFetch(router);

    const result = await new BSCAdapter(undefined).login("buysportscards-credentials-seller1");
    restore();

    assert.equal(result.success, true);
    assert.match(result.message, /Refreshed token/);
    assert.deepEqual(router.presented, ["refresh-token-0"], "should present the stored refresh token");
  });

  it("ACCEPTANCE: two refreshes in a row — the second presents the token minted by the first", async () => {
    // The NEO-141 acceptance criterion. A single refresh proves nothing: the
    // failure mode is a rotated token that is fetched, used, and then dropped,
    // which looks perfect exactly once and then locks the user out forever.
    const secret = statefulSecret(LIVE_REFRESH);
    const BSCAdapter = loadBSCAdapter(secret);
    const router = makeRefreshRouter();
    const restore = stubFetch(router);

    const first = await new BSCAdapter(undefined).login("buysportscards-credentials-seller1");
    const second = await new BSCAdapter(undefined).login("buysportscards-credentials-seller1");
    restore();

    assert.equal(first.success, true);
    assert.equal(second.success, true);

    assert.equal(router.presented.length, 2, "both calls must have used the refresh grant");
    assert.equal(router.presented[0], "refresh-token-0", "first refresh presents the seed token");
    assert.equal(
      router.presented[1],
      "refresh-token-1",
      "second refresh MUST present the token minted by the first — a rotated token is single-use",
    );
    assert.notEqual(
      router.presented[1],
      router.presented[0],
      "re-presenting the original token means the rotation was never persisted",
    );

    // And the chain is left in a usable state for a third call.
    assert.equal(
      secret.state.payload.refreshToken,
      "refresh-token-2",
      "the newest rotated token must be what is left in the secret",
    );
    assert.equal(secret.state.writes.length, 2, "every refresh persists, exactly once each");
  });

  it("persists the rotated refresh token and its expiry, and never the password", async () => {
    const secret = statefulSecret({ ...LIVE_REFRESH, password: "legacy-placeholder-value" });
    const BSCAdapter = loadBSCAdapter(secret);
    const restore = stubFetch(makeRefreshRouter());

    const before = Date.now();
    await new BSCAdapter(undefined).login("buysportscards-credentials-seller1");
    restore();

    const [write] = secret.state.writes;
    assert.deepEqual(
      Object.keys(write).sort(),
      ["expiresAt", "refreshExpiresAt", "refreshToken", "token", "username"],
      "the persisted payload must be exactly the session fields — no password, nothing extra",
    );
    assert.equal(write.password, undefined, "a legacy stored password must be SHED, not carried forward");
    assert.equal(write.refreshToken, "refresh-token-1");
    assert.ok(write.refreshExpiresAt > before + 23 * 60 * 60 * 1000, "~24h refresh expiry");
    assert.ok(write.expiresAt > before, "access-token expiry must be in the future");
  });

  it("does NOT return success when persisting the rotated token fails", async () => {
    // The token we presented is already dead by the time B2C answers. Reporting
    // success here would hand the caller an access token with no way to renew
    // it — a silent one-hour fuse. It must fail, and as a pageable fault (the
    // write failing is our infrastructure, not the user's session).
    const BSCAdapter = loadBSCAdapter({
      credentials: () => ({ ...LIVE_REFRESH, expiresAt: Date.now() - 1 }),
      updateCredentials: () => {
        throw new Error("Failed to update credentials");
      },
    });
    const restore = stubFetch(makeRefreshRouter());

    const result = await new BSCAdapter(undefined).login("buysportscards-credentials-seller1");
    restore();

    assert.equal(result.success, false, "a dropped rotation must never be reported as success");
    assert.equal(result.error, "Authentication failed");
    assert.notEqual(result.reauthRequired, true, "a failed WRITE is our fault and must stay pageable");
  });

  it("reports reauthRequired when the refresh grant is refused (invalid_grant)", async () => {
    const BSCAdapter = loadBSCAdapter({
      credentials: () => ({ ...LIVE_REFRESH, expiresAt: Date.now() - 1 }),
      updateCredentials: () => assert.fail("nothing should be persisted after a refused grant"),
    });
    const restore = stubFetch(
      makeRefreshRouter({
        tokenResponse: () =>
          makeResponse({ status: 400, ok: false, json: { error: "invalid_grant" } }),
      }),
    );

    const result = await new BSCAdapter(undefined).login("buysportscards-credentials-seller1");
    restore();

    assert.equal(result.success, false);
    assert.equal(result.reauthRequired, true, "a refused grant is the user's cue to sign in again");
    assert.equal(result.error, "Re-authentication required");
  });

  it("does NOT report reauthRequired when the token endpoint 5xxs (a BSC outage must page)", async () => {
    // The expensive mistake in the other direction: a BSC outage presenting to
    // every user as "your session expired" while paging nobody.
    const BSCAdapter = loadBSCAdapter({
      credentials: () => ({ ...LIVE_REFRESH, expiresAt: Date.now() - 1 }),
      updateCredentials: null,
    });
    const restore = stubFetch(
      makeRefreshRouter({
        tokenResponse: () => makeResponse({ status: 503, ok: false, json: { error: "unavailable" } }),
      }),
    );

    const result = await new BSCAdapter(undefined).login("buysportscards-credentials-seller1");
    restore();

    assert.equal(result.success, false);
    assert.notEqual(result.reauthRequired, true, "an unreachable token endpoint must stay a 502");
    assert.equal(result.error, "Authentication failed");
  });

  it("falls back to a password sign-in when the grant is refused BUT a password is still stored", async () => {
    // Legacy un-migrated secrets and the canary keys still carry one. They must
    // keep working rather than being told to re-auth.
    const updates = [];
    const BSCAdapter = loadBSCAdapter({
      credentials: () => ({
        ...LIVE_REFRESH,
        password: "legacy-placeholder-value",
        expiresAt: Date.now() - 1,
      }),
      updateCredentials: (key, creds) => updates.push(creds),
    });
    let refreshCalls = 0;
    const router = makeB2CRouter({
      token: (_u, opts) => {
        const body = new URLSearchParams(String(opts.body ?? ""));
        if (body.get("grant_type") === "refresh_token") {
          refreshCalls++;
          return makeResponse({ status: 400, ok: false, json: { error: "invalid_grant" } });
        }
        return makeResponse({
          status: 200,
          json: { access_token: "fresh-access-token", expires_in: 3600, refresh_token: "new-rt", refresh_token_expires_in: 86400 },
        });
      },
    });
    const restore = stubFetch(router);

    const result = await new BSCAdapter(undefined).login("buysportscards-credentials-seller1");
    restore();

    assert.equal(refreshCalls, 1, "the refresh grant should be tried first");
    assert.equal(result.success, true, "and a stored password should rescue the login");
    assert.ok(
      router.calls.some((c) => c.url.includes("/SelfAsserted")),
      "the fallback must be a real B2C sign-in",
    );
    assert.equal(updates.length, 1);
    assert.equal(updates[0].password, undefined, "even the rescue write sheds the password");
  });

  it("skips the refresh grant entirely once the refresh token has expired", async () => {
    const BSCAdapter = loadBSCAdapter({
      credentials: () => ({
        username: "seller@example.com",
        refreshToken: "refresh-token-0",
        refreshExpiresAt: Date.now() - 1000, // dead
      }),
      updateCredentials: null,
    });
    const restore = stubFetch(async (u) => {
      throw new Error(`no request should be made with a dead refresh token: ${u}`);
    });

    const result = await new BSCAdapter(undefined).login("buysportscards-credentials-seller1");
    restore();

    assert.equal(result.success, false);
    assert.equal(result.reauthRequired, true);
  });

  it("captures the refresh token on a fresh password sign-in, using B2C's real expires_in", async () => {
    const updates = [];
    const BSCAdapter = loadBSCAdapter({
      credentials: { username: "seller@example.com", password: "placeholder-value" },
      updateCredentials: (key, creds) => updates.push(creds),
    });
    const router = makeB2CRouter();
    const restore = stubFetch(router);

    const before = Date.now();
    const result = await new BSCAdapter(undefined).login("buysportscards-credentials-seller1");
    restore();

    assert.equal(result.success, true);
    const [persisted] = updates;
    assert.equal(
      persisted.refreshToken,
      "fresh-refresh-token",
      "a sign-in must bank the refresh token — throwing it away is what forced password storage",
    );
    assert.ok(persisted.refreshExpiresAt > before + 23 * 60 * 60 * 1000, "~24h from refresh_token_expires_in");
    // expires_in=3600 from the response, not a hardcoded constant.
    assert.ok(persisted.expiresAt >= before + 3600 * 1000 - 5000);
    assert.ok(persisted.expiresAt <= Date.now() + 3600 * 1000 + 5000);
  });

  it("requests offline_access on /authorize (intent made legible)", async () => {
    const BSCAdapter = loadBSCAdapter({
      credentials: { username: "seller@example.com", password: "placeholder-value" },
      updateCredentials: null,
    });
    const router = makeB2CRouter();
    const restore = stubFetch(router);
    await new BSCAdapter(undefined).login("buysportscards-credentials-seller1");
    restore();

    const authorize = router.calls.find((c) => c.url.includes("/authorize"));
    const scope = new URL(authorize.url).searchParams.get("scope");
    assert.match(scope, /offline_access/);
    assert.match(scope, /api\/read/, "the api/read resource scope must not be lost");
  });

  it("survives a token response with no refresh_token at all", async () => {
    // Defensive: if BSC ever stops issuing one, a login must still succeed —
    // it just costs a full sign-in at the next expiry instead of a refresh.
    const updates = [];
    const BSCAdapter = loadBSCAdapter({
      credentials: { username: "seller@example.com", password: "placeholder-value" },
      updateCredentials: (key, creds) => updates.push(creds),
    });
    const restore = stubFetch(
      makeB2CRouter({
        token: () => makeResponse({ status: 200, json: { access_token: "only-access", expires_in: 3600 } }),
      }),
    );

    const result = await new BSCAdapter(undefined).login("buysportscards-credentials-seller1");
    restore();

    assert.equal(result.success, true);
    assert.equal(updates[0].refreshToken, undefined);
    assert.equal(updates[0].token, "only-access");
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
    // NEO-98: the ONE branch of the B2C exchange that is a real rejection —
    // B2C parsed our submission and answered with its own non-200 envelope.
    // This is what earns HTTP 422 (and therefore never pages).
    assert.equal(result.credentialRejected, true, "a B2C {\"status\":\"400\"} IS a credential rejection");
  });

  it("does NOT flag a credential rejection when the SelfAsserted body is unparseable", async () => {
    // NEO-98: an unparseable body means B2C returned something that is not its
    // envelope at all — an error page, a redirect, a WAF interstitial. That is
    // an integration fault (502, pages), not the seller mistyping a password.
    // Getting this wrong is the expensive direction: it would classify a BSC
    // outage as user error and Cloud Monitoring would go blind to it.
    const BSCAdapter = loadBSCAdapter({
      credentials: { username: "seller@example.com", password: "hunter2" },
      updateCredentials: null,
    });
    const router = makeB2CRouter({
      selfAsserted: () => makeResponse({ status: 200, body: "<html>502 Bad Gateway</html>" }),
    });
    const restore = stubFetch(router);

    const adapter = new BSCAdapter(undefined);
    const result = await adapter.login("buysportscards-credentials-seller1");
    restore();

    assert.equal(result.success, false);
    assert.notEqual(result.credentialRejected, true, "unparseable B2C body must stay pageable");
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
    // NEO-98: BSC never saw the password — we could not even get the form.
    // Unambiguously our-side/upstream, so it must stay pageable (502).
    assert.notEqual(result.credentialRejected, true, "no sign-in form is an outage, not a typo");
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
    // NEO-98: B2C already ACCEPTED the credentials by this point (SelfAsserted
    // returned 200 and /confirmed handed back a code). A failure here is our
    // token exchange breaking, so it must page.
    assert.notEqual(result.credentialRejected, true, "token-exchange failure is not a credential rejection");
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

  it("reports reauthRequired (not a generic failure) when the secret has no token, no refresh token and no password", async () => {
    // NEO-141: this is the steady state of a fully-lapsed USER secret, not a
    // corrupt one — user secrets no longer store a password at all. It must
    // therefore come back as its own thing, so Convex prompts a sign-in
    // instead of inferring absence from a status code.
    const BSCAdapter = loadBSCAdapter({
      credentials: { username: "seller@example.com" },
      updateCredentials: null,
    });
    // No fetch should ever be made — there is nothing to authenticate with.
    const restore = stubFetch(async (u) => { throw new Error(`unexpected fetch: ${u}`); });

    const adapter = new BSCAdapter(undefined);
    const result = await adapter.login("buysportscards-credentials-seller1");
    restore();

    assert.equal(result.success, false);
    assert.equal(result.reauthRequired, true, "must be the reauth signal, not a generic fault");
    assert.equal(result.error, "Re-authentication required");
    assert.notEqual(
      result.credentialRejected,
      true,
      "nothing was rejected — no credentials were ever submitted",
    );
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

// ---------------------------------------------------------------------------
// NEO-43 — synthetic canary mode
// ---------------------------------------------------------------------------

describe("BSCAdapter.login — NEO-43 canary mode", () => {
  it("BYPASSES a still-valid cached token and runs the full B2C exchange", async () => {
    // The whole point of the canary: a cache hit costs ~1.1s and proves only
    // that an old token is still accepted. It does NOT exercise the B2C
    // exchange, which is the part that actually breaks.
    const BSCAdapter = loadBSCAdapter({
      credentials: {
        username: "seller@example.com",
        password: "secret",
        token: "bare-token-abc123",
        expiresAt: Date.now() + 60 * 60 * 1000, // comfortably valid
      },
    });

    const router = makeB2CRouter();
    const restore = stubFetch(router);
    const adapter = new BSCAdapter(undefined);
    const result = await adapter.login("bsc-credentials-canary", { canary: true });
    restore();

    assert.equal(result.success, true);
    const urls = router.calls.map((c) => c.url);
    assert.ok(
      urls.some((u) => u.includes("/oauth2/v2.0/authorize")),
      "canary must run the real B2C authorize step even with a valid cached token",
    );
    assert.ok(urls.some((u) => u.includes("/oauth2/v2.0/token")), "canary must run the token exchange");
  });

  it("does NOT write the fresh token back to Secret Manager", async () => {
    // Every write-back adds a new, permanently-enabled Secret Manager version
    // at $0.06/version/month. At canary cadence that dwarfs the rest of this
    // infrastructure. It also keeps the canary key permanently cache-free.
    const updates = [];
    const BSCAdapter = loadBSCAdapter({
      credentials: { username: "seller@example.com", password: "secret" },
      updateCredentials: (key, creds) => updates.push({ key, creds }),
    });

    const restore = stubFetch(makeB2CRouter());
    const adapter = new BSCAdapter(undefined);
    const result = await adapter.login("bsc-credentials-canary", { canary: true });
    restore();

    assert.equal(result.success, true);
    assert.deepEqual(updates, [], "canary must never call updateCredentials");
  });

  it("without the flag, behaviour is unchanged: cache is honoured and the token IS stored", async () => {
    // Regression guard — the flag must be purely additive.
    const cacheUpdates = [];
    const CachedAdapter = loadBSCAdapter({
      credentials: {
        username: "seller@example.com",
        password: "secret",
        token: "bare-token-abc123",
        expiresAt: Date.now() + 60 * 60 * 1000,
      },
      updateCredentials: (key, creds) => cacheUpdates.push({ key, creds }),
    });
    const cacheCalls = [];
    let restore = stubFetch(async (url) => {
      cacheCalls.push(String(url));
      return makeResponse({ status: 200, json: { sellerProfile: { sellerStoreName: "S", sellerId: "sid1" } } });
    });
    const cached = await new CachedAdapter(undefined).login("bsc-credentials-user1");
    restore();
    assert.equal(cached.success, true);
    assert.ok(
      cacheCalls.every((u) => u.includes("api-prod.buysportscards.com")),
      "non-canary login with a valid token must short-circuit to the profile check only",
    );

    const freshUpdates = [];
    const FreshAdapter = loadBSCAdapter({
      credentials: { username: "seller@example.com", password: "secret" },
      updateCredentials: (key, creds) => freshUpdates.push({ key, creds }),
    });
    restore = stubFetch(makeB2CRouter());
    const fresh = await new FreshAdapter(undefined).login("bsc-credentials-user1");
    restore();
    assert.equal(fresh.success, true);
    assert.equal(freshUpdates.length, 1, "non-canary fresh login must still store the token");
    assert.equal(freshUpdates[0].creds.token, "fresh-access-token");
  });

  it("NEO-141 regression: still performs a REAL PASSWORD LOGIN, ignoring a live refresh token", async () => {
    // Two live Cloud Scheduler jobs POST {key, canary:true} every 30 minutes,
    // and the alerting they feed is only meaningful if the probe exercises the
    // full B2C sign-in. A canary that took the cheap refresh grant would go
    // green straight through a broken authorize/SelfAsserted flow — the exact
    // blindness NEO-43 exists to prevent. The refresh path must be skipped on
    // the flag alone, even when a usable refresh token is sitting right there.
    const updates = [];
    const BSCAdapter = loadBSCAdapter({
      credentials: {
        username: "seller@example.com",
        password: "canary-placeholder-value",
        token: "cached-access-token",
        expiresAt: Date.now() + 60 * 60 * 1000, // valid cache
        refreshToken: "refresh-token-0", // and a usable refresh token
        refreshExpiresAt: Date.now() + 24 * 60 * 60 * 1000,
      },
      updateCredentials: (key, creds) => updates.push({ key, creds }),
    });

    const router = makeB2CRouter();
    const restore = stubFetch(router);
    const result = await new BSCAdapter(undefined).login("bsc-credentials-canary", { canary: true });
    restore();

    assert.equal(result.success, true);
    const tokenCalls = router.calls.filter((c) => c.url.includes("/oauth2/v2.0/token"));
    assert.equal(tokenCalls.length, 1, "exactly one token call");
    assert.ok(
      new URLSearchParams(String(tokenCalls[0].opts.body)).get("grant_type") ===
        "authorization_code",
      "the canary must use the auth-code grant (a real login), never the refresh grant",
    );
    assert.ok(
      router.calls.some((c) => c.url.includes("/SelfAsserted")),
      "the canary must actually submit the password to B2C",
    );
    assert.deepEqual(updates, [], "and must still never write back");
  });
});

// ---------------------------------------------------------------------------
// NEO-140/NEO-141 — transient credentials supplied in the request body
// ---------------------------------------------------------------------------

describe("BSCAdapter.login — transient request-body credentials", () => {
  it("signs in with the supplied credentials WITHOUT reading the stored secret", async () => {
    // This is the bootstrap path: the secret may not exist yet, so touching it
    // first would fail a first-time sign-in outright.
    const updates = [];
    const BSCAdapter = loadBSCAdapter({
      credentials: () => {
        throw new Error("Credentials not found for key: buysportscards-credentials-new");
      },
      updateCredentials: (key, creds) => updates.push({ key, creds }),
    });
    const router = makeB2CRouter();
    const restore = stubFetch(router);

    const result = await new BSCAdapter(undefined).login("buysportscards-credentials-new", {
      transientCredentials: { username: "new@example.com", password: "placeholder-value" },
    });
    restore();

    assert.equal(result.success, true);
    const selfAsserted = router.calls.find((c) => c.url.includes("/SelfAsserted"));
    assert.ok(
      selfAsserted.opts.body.includes("signInName=new%40example.com"),
      "the SUPPLIED username must be the one submitted, not a stored one",
    );
  });

  it("persists only the session fields — the supplied password is never written", async () => {
    const updates = [];
    const BSCAdapter = loadBSCAdapter({
      credentials: () => {
        throw new Error("Credentials not found for key: buysportscards-credentials-new");
      },
      updateCredentials: (key, creds) => updates.push({ key, creds }),
    });
    const restore = stubFetch(makeB2CRouter());

    await new BSCAdapter(undefined).login("buysportscards-credentials-new", {
      transientCredentials: { username: "new@example.com", password: "placeholder-value" },
    });
    restore();

    assert.equal(updates.length, 1);
    const written = updates[0].creds;
    assert.deepEqual(
      Object.keys(written).sort(),
      ["expiresAt", "refreshExpiresAt", "refreshToken", "token", "username"],
      "the intake write must contain exactly the session fields",
    );
    assert.equal(written.username, "new@example.com");
    assert.equal(
      JSON.stringify(written).includes("placeholder-value"),
      false,
      "the transient password must not survive anywhere in the persisted payload",
    );
  });

  it("supplied credentials override a still-valid cached token (explicit re-auth)", async () => {
    // A user re-entering their password is saying "use these", not "check
    // whether my old session still works".
    const BSCAdapter = loadBSCAdapter({
      credentials: {
        username: "old@example.com",
        token: "cached-access-token",
        expiresAt: Date.now() + 60 * 60 * 1000,
      },
      updateCredentials: null,
    });
    const router = makeB2CRouter();
    const restore = stubFetch(router);

    await new BSCAdapter(undefined).login("buysportscards-credentials-seller1", {
      transientCredentials: { username: "new@example.com", password: "placeholder-value" },
    });
    restore();

    assert.ok(
      router.calls.some((c) => c.url.includes("/SelfAsserted")),
      "a supplied password must force a fresh sign-in, not a cache hit",
    );
  });

  it("keeps the sanitized-diagnostic guarantee for a supplied password", async () => {
    const BSCAdapter = loadBSCAdapter({
      credentials: () => {
        throw new Error("Credentials not found");
      },
      updateCredentials: null,
    });
    const restore = stubFetch(
      makeB2CRouter({
        selfAsserted: () =>
          makeResponse({
            status: 200,
            body: JSON.stringify({
              status: "400",
              message: "Rejected: new@example.com / transient-placeholder",
            }),
          }),
      }),
    );

    const result = await new BSCAdapter(undefined).login("buysportscards-credentials-new", {
      transientCredentials: { username: "new@example.com", password: "transient-placeholder" },
    });
    restore();

    assert.equal(result.success, false);
    const blob = JSON.stringify(result.diagnostic);
    assert.doesNotMatch(blob, /new@example\.com/, "diagnostic must redact the supplied email");
    assert.doesNotMatch(blob, /transient-placeholder/, "diagnostic must redact the supplied password");
  });
});

// ---------------------------------------------------------------------------
// NEO-141 hardening — canary protection keys off the KEY, not the flag
// ---------------------------------------------------------------------------
//
// The canary secrets are the only ones in the platform that still store a
// password, and persistTokens writes an explicit field list with no `password`
// in it while updateCredentials prunes to a single version. So ONE write-back
// against a canary key destroys that password unrecoverably.
//
// Flag-based protection made that the caller's responsibility. A terraform edit
// dropping `canary = true` from a scheduler body is enough: the request takes
// the ordinary password path, succeeds, writes back, and every later run
// answers 422 `reauth_required` — a class the alert policies deliberately
// exclude as a caller error. The synthetic login canary would go permanently
// and silently dead while the job kept running and logging.
//
// Pre-NEO-141 this self-healed by accident, because the write-back spread the
// credentials it had just read and carried the password through.

describe("BSCAdapter — canary-key write-back protection", () => {
  it("never writes back to a canary key even WITHOUT canary:true on the request", async () => {
    const updates = [];
    const BSCAdapter = loadBSCAdapter({
      credentials: {
        username: "seller@example.com",
        password: "canary-placeholder-value",
      },
      updateCredentials: (key, creds) => updates.push({ key, creds }),
    });
    const restore = stubFetch(makeB2CRouter());

    // No opts at all — the terraform-drops-the-flag scenario.
    const result = await new BSCAdapter(undefined).login("bsc-credentials-canary");
    restore();

    assert.equal(result.success, true, "the login itself must still succeed");
    assert.deepEqual(
      updates,
      [],
      "a canary key must never be written back, flag or no flag",
    );
  });

  it("does not write back on the REFRESH path either", async () => {
    // The other call site of persistTokens. A canary key should never hold a
    // refresh token (it is never written back), but if one ever got there the
    // rotated-token write must still not land on the canary secret — that
    // write is the one the adapter treats as fatal-if-it-fails, so it must be
    // skipped rather than attempted.
    const updates = [];
    const BSCAdapter = loadBSCAdapter({
      credentials: {
        username: "seller@example.com",
        password: "canary-placeholder-value",
        refreshToken: "refresh-token-0",
        refreshExpiresAt: Date.now() + 24 * 60 * 60 * 1000,
      },
      updateCredentials: (key, creds) => updates.push({ key, creds }),
    });
    const restore = stubFetch(makeB2CRouter());

    const result = await new BSCAdapter(undefined).login("bsc-credentials-canary");
    restore();

    assert.equal(result.success, true);
    assert.deepEqual(updates, [], "the rotated token must not overwrite the canary secret");
  });

  it("a NON-canary key is unaffected — the guard is purely additive", async () => {
    const updates = [];
    const BSCAdapter = loadBSCAdapter({
      credentials: { username: "seller@example.com", password: "secret" },
      updateCredentials: (key, creds) => updates.push({ key, creds }),
    });
    const restore = stubFetch(makeB2CRouter());

    const result = await new BSCAdapter(undefined).login("bsc-credentials-user_canary_fan");
    restore();

    assert.equal(result.success, true);
    assert.equal(
      updates.length,
      1,
      "a user key whose id merely CONTAINS 'canary' must still be written back",
    );
  });
});
