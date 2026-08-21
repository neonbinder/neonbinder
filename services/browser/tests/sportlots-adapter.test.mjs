/**
 * Unit tests for SportlotsAdapter.login retry loop AND token cache.
 *
 * Strategy: patch SecretsManagerService and the global fetch before loading
 * the adapter from compiled CJS dist, mirroring bsc-adapter.test.mjs.
 *
 * The retry loop:
 *   - Up to 5 attempts total (initial + 4 retries)
 *   - Retries on: 429, 5xx, "no cookies parsed", network throw
 *   - Does NOT retry on: 4xx non-429, validation-sees-login-page,
 *     invalid-credentials-format
 *
 * The cache short-circuit (added with the per-user token cache):
 *   - On unexpired token + valid revalidation → reuse, no signin POST
 *   - On unexpired token + failed revalidation → clear cache, full login
 *   - On expired token → skip validation, full login
 *   - On no token → full login (legacy behavior)
 *   - Fresh login persists token *with* expiresAt
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// Short-circuit setTimeout so the test suite doesn't actually sleep
// ~7.5s per "give up after 5 attempts" test. jitter math still runs.
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, _ms) => realSetTimeout(fn, 0);

/**
 * Patch SecretsManagerService and load the adapter from dist.
 *
 * @param credentials       — initial value returned by getCredentials. May be a
 *                            function (called with key) for tests that need the
 *                            value to evolve across calls (e.g. cache cleared
 *                            after a stale-cookie miss).
 * @param updateCredentials — optional spy invoked on every updateCredentials.
 */
function loadSportlotsAdapter({ credentials = null, updateCredentials = null } = {}) {
  delete require.cache[require.resolve("../dist/adapters/base-adapter")];
  delete require.cache[require.resolve("../dist/adapters/sportlots-adapter")];

  const smPath = require.resolve("../dist/services/secrets-manager");
  const smMod = require(smPath);
  smMod.SecretsManagerService = class MockSecretsManagerService {
    async getCredentials(key) {
      if (typeof credentials === "function") return credentials(key);
      return credentials ?? { username: "user@example.com", password: "pw" };
    }
    async updateCredentials(key, creds) {
      if (updateCredentials) updateCredentials(key, creds);
    }
    async deleteCredentials(_key) {}
    async credentialsExist(_key) { return true; }
  };

  const { SportlotsAdapter } = require("../dist/adapters/sportlots-adapter");
  return SportlotsAdapter;
}

function stubFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return () => { globalThis.fetch = original; };
}

// SportLots returns cookies inline in JS. A single-cookie body that our
// regex /document\.cookie\s*=\s*"([^"]+)"/g matches.
const OK_LOGIN_BODY = `<html><body><script>document.cookie = "sl_session=abc123; path=/";</script></body></html>`;
// Validation fetch: body must NOT contain "login.tpl" or "signin.tpl".
const OK_VALIDATE_BODY = `<html>dashboard</html>`;

function response({ status = 200, body = "" }) {
  return { status, text: async () => body };
}

/**
 * Build a fetch stub that returns different responses for the login POST
 * and validation GET, tracking how many login calls were made.
 */
function scriptedLoginFetch(loginResponses, validateResponse = response({ body: OK_VALIDATE_BODY })) {
  let loginCalls = 0;
  const stub = async (url, _opts) => {
    const u = String(url);
    if (u.includes("/cust/custbin/signin.tpl")) {
      const r = loginResponses[loginCalls] ?? loginResponses[loginResponses.length - 1];
      loginCalls++;
      if (r instanceof Error) throw r;
      return r;
    }
    if (u.includes("/inven/dealbin/newinven.tpl")) {
      return validateResponse;
    }
    throw new Error(`unexpected fetch url: ${u}`);
  };
  stub.loginCalls = () => loginCalls;
  return stub;
}

describe("SportlotsAdapter.login retry loop", () => {
  it("retries on transient 500 then succeeds", async () => {
    const SportlotsAdapter = loadSportlotsAdapter();
    const stub = scriptedLoginFetch([
      response({ status: 500 }),
      response({ status: 500 }),
      response({ status: 200, body: OK_LOGIN_BODY }),
    ]);
    const restore = stubFetch(stub);
    try {
      const adapter = new SportlotsAdapter(null);
      const result = await adapter.login("sportlots-credentials-user_test");
      assert.equal(result.success, true, "should succeed after retries");
      assert.equal(stub.loginCalls(), 3, "should have made exactly 3 login attempts");
    } finally {
      restore();
    }
  });

  it("does NOT retry on 400 non-429 (treated as permanent)", async () => {
    const SportlotsAdapter = loadSportlotsAdapter();
    const stub = scriptedLoginFetch([response({ status: 400 })]);
    const restore = stubFetch(stub);
    try {
      const adapter = new SportlotsAdapter(null);
      const result = await adapter.login("sportlots-credentials-user_test");
      assert.equal(result.success, false, "should fail");
      assert.equal(stub.loginCalls(), 1, "should give up after first attempt (400 is not retryable)");
      assert.match(result.error, /HTTP 400/);
    } finally {
      restore();
    }
  });

  it("gives up after 5 attempts when 500 is persistent", async () => {
    const SportlotsAdapter = loadSportlotsAdapter();
    const stub = scriptedLoginFetch([response({ status: 500 })]);
    const restore = stubFetch(stub);
    try {
      const adapter = new SportlotsAdapter(null);
      const result = await adapter.login("sportlots-credentials-user_test");
      assert.equal(result.success, false, "should fail");
      assert.equal(stub.loginCalls(), 5, "should exhaust all 5 attempts");
      assert.match(result.error, /SportLots is unavailable/);
    } finally {
      restore();
    }
  });

  it("retries on fetch throw then succeeds", async () => {
    const SportlotsAdapter = loadSportlotsAdapter();
    const stub = scriptedLoginFetch([
      new Error("ECONNRESET"),
      new Error("ECONNRESET"),
      response({ status: 200, body: OK_LOGIN_BODY }),
    ]);
    const restore = stubFetch(stub);
    try {
      const adapter = new SportlotsAdapter(null);
      const result = await adapter.login("sportlots-credentials-user_test");
      assert.equal(result.success, true, "should succeed after network-error retries");
      assert.equal(stub.loginCalls(), 3, "should have made exactly 3 login attempts");
    } finally {
      restore();
    }
  });

  it("retries on empty body (no cookies parsed)", async () => {
    const SportlotsAdapter = loadSportlotsAdapter();
    const stub = scriptedLoginFetch([
      response({ status: 200, body: "<html>nothing</html>" }),
      response({ status: 200, body: OK_LOGIN_BODY }),
    ]);
    const restore = stubFetch(stub);
    try {
      const adapter = new SportlotsAdapter(null);
      const result = await adapter.login("sportlots-credentials-user_test");
      assert.equal(result.success, true, "should succeed after empty-body retry");
      assert.equal(stub.loginCalls(), 2);
    } finally {
      restore();
    }
  });

  it("does NOT retry when validation sees login page (bad credentials)", async () => {
    const SportlotsAdapter = loadSportlotsAdapter();
    const stub = scriptedLoginFetch(
      [response({ status: 200, body: OK_LOGIN_BODY })],
      response({ status: 200, body: `<html>please visit login.tpl</html>` }),
    );
    const restore = stubFetch(stub);
    try {
      const adapter = new SportlotsAdapter(null);
      const result = await adapter.login("sportlots-credentials-user_test");
      assert.equal(result.success, false);
      assert.equal(stub.loginCalls(), 1, "should give up after one attempt — validation failure is permanent");
      assert.match(result.error, /login validation failed/);
      // NEO-98: SL handed us cookies and then bounced them straight back to
      // the login form — it processed the sign-in and declined a session.
      // A rejection (422), not an outage.
      assert.equal(result.credentialRejected, true);
    } finally {
      restore();
    }
  });

  it("reports reauthRequired when there is no cached session and no password", async () => {
    // NEO-141: the steady state of a lapsed USER secret. SL user secrets no
    // longer store a password, so once the cookie dies there is nothing left
    // to sign in with — and that is normal, not a fault. It must surface as
    // the reauth signal (422, never pages) and must not touch the network.
    const SportlotsAdapter = loadSportlotsAdapter({
      credentials: { username: "user@example.com" },
    });
    // No fetch should happen; use a stub that would throw if called.
    const restore = stubFetch(async () => {
      throw new Error("fetch should not be called when there is nothing to authenticate with");
    });
    try {
      const adapter = new SportlotsAdapter(null);
      const result = await adapter.login("sportlots-credentials-user_test");
      assert.equal(result.success, false);
      assert.equal(result.reauthRequired, true);
      assert.equal(result.error, "Re-authentication required");
      assert.notEqual(
        result.credentialRejected,
        true,
        "nothing was submitted, so nothing was rejected",
      );
    } finally {
      restore();
    }
  });
});

describe("SportlotsAdapter — NEO-98/NEO-100 rejection vs upstream fault", () => {
  // The no-cookies branch is two different events wearing one error string,
  // and it matters more here than anywhere else: SportLots answers a refused
  // login with HTTP 200, never a status code, so this branch IS the real
  // seller-typo path.
  //
  // The bodies below are VERBATIM captures from the live SportLots endpoint
  // (2026-07-27), not invented fixtures. That matters: the whole response is
  // ~115 bytes and carries the reason in a `?message=` JS redirect, which is
  // nothing like the "re-served login page" one would reasonably assume.

  // Malformed email.
  const SL_REJECT_MALFORMED =
    `<html><head> </head> <body onload='window.location = "\\?message=Not a valid Email Address";'> </body> </html>`;
  // Well-formed but unknown account — and also what an incorrect/empty
  // password returns. SportLots does not distinguish the two (no account
  // enumeration), which is why one pattern covers both.
  const SL_REJECT_UNKNOWN =
    `<html><head> </head> <body onload='window.location = "\\?message=Invalid email address supplied";'> </body> </html>`;

  it("flags a rejection on SportLots' real refusal envelopes", async () => {
    for (const body of [SL_REJECT_MALFORMED, SL_REJECT_UNKNOWN]) {
      const SportlotsAdapter = loadSportlotsAdapter();
      const stub = scriptedLoginFetch([response({ status: 200, body })]);
      const restore = stubFetch(stub);
      try {
        const adapter = new SportlotsAdapter(null);
        const result = await adapter.login("sportlots-credentials-user_test");
        assert.equal(result.success, false);
        assert.equal(result.credentialRejected, true, `should be a rejection → 422: ${body.slice(0, 60)}`);
      } finally {
        restore();
      }
    }
  });

  it("does NOT retry a rejection SportLots already stated explicitly", async () => {
    // NEO-100: replaying a login SportLots has explicitly refused just spends
    // four more round trips to reach the same answer, and puts four more
    // failed attempts on the seller's account.
    const SportlotsAdapter = loadSportlotsAdapter();
    const stub = scriptedLoginFetch([response({ status: 200, body: SL_REJECT_UNKNOWN })]);
    const restore = stubFetch(stub);
    try {
      const adapter = new SportlotsAdapter(null);
      const result = await adapter.login("sportlots-credentials-user_test");
      assert.equal(result.success, false);
      assert.equal(stub.loginCalls(), 1, "a confirmed rejection must not be retried");
    } finally {
      restore();
    }
  });

  it("does NOT flag a rejection when SL returned an empty body", async () => {
    // The blank/slow response this branch's retry exists for. Must stay
    // pageable (502) — this is the direction that matters, because silently
    // calling an SL outage 'user error' is exactly the blindness NEO-98 is
    // meant to remove.
    const SportlotsAdapter = loadSportlotsAdapter();
    const stub = scriptedLoginFetch([response({ status: 200, body: "   " })]);
    const restore = stubFetch(stub);
    try {
      const adapter = new SportlotsAdapter(null);
      const result = await adapter.login("sportlots-credentials-user_test");
      assert.equal(result.success, false);
      assert.notEqual(result.credentialRejected, true, "empty body is an upstream fault → 502");
    } finally {
      restore();
    }
  });

  it("does NOT flag a rejection on an UNRECOGNISED message, and still retries it", async () => {
    // NEO-100's key safety property. If SportLots changes its login flow and
    // starts emitting a message we don't know, that must surface as a 502 and
    // page — never be absorbed as a wave of seller typos, which is precisely
    // how a broken integration would hide. Under the old body-emptiness
    // heuristic this exact response was classified as a rejection.
    const SportlotsAdapter = loadSportlotsAdapter();
    const body = `<html><head> </head> <body onload='window.location = "\\?message=Scheduled maintenance in progress";'> </body> </html>`;
    const stub = scriptedLoginFetch([response({ status: 200, body })]);
    const restore = stubFetch(stub);
    try {
      const adapter = new SportlotsAdapter(null);
      const result = await adapter.login("sportlots-credentials-user_test");
      assert.equal(result.success, false);
      assert.notEqual(result.credentialRejected, true, "unknown message must stay pageable → 502");
      assert.ok(stub.loginCalls() > 1, "and must still be retried, since it may be transient");
    } finally {
      restore();
    }
  });

  it("a challenge page VETOES the rejection flag even though a page was served", async () => {
    // The invariant documented on AdapterResponse.credentialRejected: being
    // bot-blocked is our problem. A Cloudflare interstitial is a non-empty
    // body with no cookies, so without the veto it would look exactly like a
    // typo and quietly stop paging — the failure mode NEO-98 exists to close.
    const SportlotsAdapter = loadSportlotsAdapter();
    const stub = scriptedLoginFetch([
      response({ status: 200, body: "<html><body>Attention Required! Cloudflare</body></html>" }),
    ]);
    const restore = stubFetch(stub);
    try {
      const adapter = new SportlotsAdapter(null);
      const result = await adapter.login("sportlots-credentials-user_test");
      assert.equal(result.success, false);
      assert.equal(result.diagnostic.challengeDetected, true, "sanity: should read as a challenge");
      assert.notEqual(result.credentialRejected, true, "a block page must stay pageable → 502");
    } finally {
      restore();
    }
  });

  it("does NOT flag a rejection on upstream 5xx or rate limiting", async () => {
    for (const status of [500, 503, 429]) {
      const SportlotsAdapter = loadSportlotsAdapter();
      const stub = scriptedLoginFetch([response({ status })]);
      const restore = stubFetch(stub);
      try {
        const adapter = new SportlotsAdapter(null);
        const result = await adapter.login("sportlots-credentials-user_test");
        assert.equal(result.success, false);
        assert.notEqual(
          result.credentialRejected,
          true,
          `HTTP ${status} from SportLots is an outage, not a typo`,
        );
      } finally {
        restore();
      }
    }
  });
});

/**
 * Build a fetch stub that distinguishes the validation GET from the signin
 * POST. Tracks call counts on each so tests can assert the right path ran.
 *
 * @param onValidate — handler for GET /inven/dealbin/newinven.tpl
 * @param onSignin   — handler for POST /cust/custbin/signin.tpl
 */
function cacheAwareFetch({ onValidate, onSignin } = {}) {
  let validateCalls = 0;
  let signinCalls = 0;
  const stub = async (url, opts) => {
    const u = String(url);
    if (u.includes("/inven/dealbin/newinven.tpl")) {
      validateCalls++;
      return onValidate ? onValidate(opts) : response({ status: 200, body: OK_VALIDATE_BODY });
    }
    if (u.includes("/cust/custbin/signin.tpl")) {
      signinCalls++;
      return onSignin ? onSignin(opts) : response({ status: 200, body: OK_LOGIN_BODY });
    }
    throw new Error(`unexpected fetch url: ${u}`);
  };
  stub.validateCalls = () => validateCalls;
  stub.signinCalls = () => signinCalls;
  return stub;
}

describe("SportlotsAdapter.login token cache", () => {
  it("returns success without hitting signin when cached cookie is unexpired and valid", async () => {
    const updates = [];
    const SportlotsAdapter = loadSportlotsAdapter({
      credentials: {
        username: "user@example.com",
        password: "pw",
        token: "sl_session=valid123",
        expiresAt: Date.now() + 60 * 60 * 1000, // 1h from now
      },
      updateCredentials: (key, creds) => updates.push({ key, creds }),
    });

    let cookieHeader = null;
    const stub = cacheAwareFetch({
      onValidate: (opts) => {
        cookieHeader = opts?.headers?.Cookie;
        return response({ status: 200, body: OK_VALIDATE_BODY });
      },
    });
    const restore = stubFetch(stub);
    try {
      const adapter = new SportlotsAdapter(null);
      const result = await adapter.login("sportlots-credentials-user_test");
      assert.equal(result.success, true, "should succeed via cached path");
      assert.match(result.message, /cached token/i, "message should reference cached token");
      assert.equal(stub.signinCalls(), 0, "must NOT POST to signin.tpl on cache hit");
      assert.equal(stub.validateCalls(), 1, "must validate cached cookie exactly once");
      assert.equal(cookieHeader, "sl_session=valid123", "validation should reuse the stored cookie");
      assert.equal(updates.length, 0, "must NOT mutate the secret on a clean cache hit");
    } finally {
      restore();
    }
  });

  it("falls through to fresh login when validation fails, writing the secret exactly once", async () => {
    const updates = [];
    const SportlotsAdapter = loadSportlotsAdapter({
      credentials: {
        username: "user@example.com",
        password: "pw",
        token: "sl_session=stale",
        expiresAt: Date.now() + 60 * 60 * 1000,
      },
      updateCredentials: (key, creds) => updates.push({ key, creds }),
    });

    // Validate sequence: 1st call (cache check) returns the login page (stale);
    // 2nd call (post-fresh-login) returns the dashboard (success). signin POST
    // succeeds normally.
    let validateCallIdx = 0;
    const stub = cacheAwareFetch({
      onValidate: () => {
        validateCallIdx++;
        if (validateCallIdx === 1) {
          return response({ status: 200, body: "<html>please login.tpl</html>" });
        }
        return response({ status: 200, body: OK_VALIDATE_BODY });
      },
      onSignin: () => response({ status: 200, body: OK_LOGIN_BODY }),
    });
    const restore = stubFetch(stub);
    try {
      const adapter = new SportlotsAdapter(null);
      const result = await adapter.login("sportlots-credentials-user_test");
      assert.equal(result.success, true, "should succeed via fresh-login fallback");
      assert.equal(stub.signinCalls(), 1, "should POST to signin.tpl after the stale cookie is rejected");
      // 1 validation from cache check + 1 from post-fresh-login validation = 2
      assert.equal(stub.validateCalls(), 2, "should validate twice (cache check + post-fresh-login)");
      // NEO-115: exactly ONE write. The old code wrote a token-cleared version
      // first and then immediately overwrote it with the fresh cookie — two
      // billed Secret Manager versions, to blank a field the second write set
      // anyway. That intermediate write is gone; if it comes back this fails.
      assert.equal(updates.length, 1, "stale-cookie path must write the secret exactly once");
      const [persist] = updates;
      assert.ok(persist.creds.token, "fresh login should persist a new token");
      assert.ok(persist.creds.expiresAt > Date.now(), "fresh login must persist a future expiresAt");
      assert.equal(persist.creds.username, "user@example.com", "write-back must preserve username");
      // NEO-141: the write-back used to re-list `password:` explicitly, so a
      // seller's SportLots password was rewritten on every successful login
      // and could never leave the secret.
      assert.equal(
        persist.creds.password,
        undefined,
        "write-back must NOT persist the password for a user key",
      );
    } finally {
      restore();
    }
  });

  it("skips validation entirely when cached token is expired", async () => {
    const updates = [];
    const SportlotsAdapter = loadSportlotsAdapter({
      credentials: {
        username: "user@example.com",
        password: "pw",
        token: "sl_session=expired",
        expiresAt: Date.now() - 60 * 1000, // 1 min in the past
      },
      updateCredentials: (key, creds) => updates.push({ key, creds }),
    });

    const stub = cacheAwareFetch();
    const restore = stubFetch(stub);
    try {
      const adapter = new SportlotsAdapter(null);
      const result = await adapter.login("sportlots-credentials-user_test");
      assert.equal(result.success, true, "should fresh-login successfully");
      assert.equal(stub.signinCalls(), 1, "must POST to signin.tpl when token expired");
      // Only 1 validation: post-fresh-login. The cache check is gated on
      // unexpired expiresAt and never runs the GET for an expired token.
      assert.equal(stub.validateCalls(), 1, "must NOT pre-validate an already-expired cookie");
      // Single update from the fresh login (no clear-cache step needed —
      // the expired branch falls straight through without clearing).
      assert.equal(updates.length, 1, "should persist exactly once (the fresh cookie)");
      assert.ok(updates[0].creds.expiresAt > Date.now(), "should set a future expiresAt");
    } finally {
      restore();
    }
  });

  it("falls through to fresh login when no cached token is present", async () => {
    const updates = [];
    const SportlotsAdapter = loadSportlotsAdapter({
      credentials: { username: "user@example.com", password: "pw" }, // no token
      updateCredentials: (key, creds) => updates.push({ key, creds }),
    });

    const stub = cacheAwareFetch();
    const restore = stubFetch(stub);
    try {
      const adapter = new SportlotsAdapter(null);
      const result = await adapter.login("sportlots-credentials-user_test");
      assert.equal(result.success, true, "should fresh-login successfully");
      assert.equal(stub.signinCalls(), 1, "should POST signin once");
      assert.equal(stub.validateCalls(), 1, "should validate once (post-fresh-login)");
      assert.equal(updates.length, 1, "should persist the fresh cookie once");
    } finally {
      restore();
    }
  });

  it("persists the fresh cookie with a future expiresAt (~30d TTL)", async () => {
    const updates = [];
    const SportlotsAdapter = loadSportlotsAdapter({
      credentials: { username: "user@example.com", password: "pw" },
      updateCredentials: (key, creds) => updates.push({ key, creds }),
    });

    const stub = cacheAwareFetch();
    const restore = stubFetch(stub);
    const beforeMs = Date.now();
    try {
      const adapter = new SportlotsAdapter(null);
      const result = await adapter.login("sportlots-credentials-user_test");
      const afterMs = Date.now();
      assert.equal(result.success, true);
      assert.equal(updates.length, 1, "exactly one persisted cookie");
      const persisted = updates[0].creds;
      assert.ok(persisted.token, "persisted cookie must have token field");
      assert.ok(typeof persisted.expiresAt === "number", "expiresAt must be a number");
      const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
      // Allow a small ±5s window for slow test runners. Lower bound: at least
      // 30d after the call started; upper bound: at most 30d after the call ended.
      assert.ok(
        persisted.expiresAt >= beforeMs + thirtyDaysMs - 5000,
        `expiresAt should be ~30d in the future (got ${persisted.expiresAt - beforeMs}ms ahead of start)`,
      );
      assert.ok(
        persisted.expiresAt <= afterMs + thirtyDaysMs + 5000,
        `expiresAt should be ~30d in the future (got ${persisted.expiresAt - afterMs}ms ahead of end)`,
      );
      assert.equal(
        result.expiresAt,
        persisted.expiresAt,
        "AdapterResponse.expiresAt should match what was persisted",
      );
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// Cleanup invariant — pure-HTTP adapter must still be cleanup()-safe
// ---------------------------------------------------------------------------
//
// SportLots is currently pure HTTP — it never calls launchPage/loginWithBrowser
// in production. But /login/sportlots wraps adapter.login() in try/finally with
// adapter.cleanup() to keep the invariant uniform across routes. If a future
// SportLots refactor ever needs Puppeteer (e.g. to handle a Cloudflare
// challenge), the invariant is already in place. Lock it in: cleanup() must
// be a safe no-op for the current SportLots flow, and it must not throw even
// when called repeatedly.
describe("SportlotsAdapter.cleanup — pure-HTTP no-op safety", () => {
  it("cleanup() is a no-op after a successful HTTP login (no browser was launched)", async () => {
    const SportlotsAdapter = loadSportlotsAdapter({
      credentials: { username: "user@example.com", password: "pw" },
    });

    // Stub fetch to drive a successful login flow. Order of the calls in
    // attemptLogin: signin POST, then validation GET. Both must succeed.
    const original = globalThis.fetch;
    globalThis.fetch = async (url, _opts) => {
      const u = String(url);
      if (u.includes("signin.tpl")) {
        return {
          status: 200,
          text: async () => 'document.cookie = "session=abc; path=/";',
        };
      }
      // validation
      return { status: 200, text: async () => "<html>Dealer Inventory</html>" };
    };

    try {
      const adapter = new SportlotsAdapter(undefined);
      const result = await adapter.login("sportlots-credentials-user1");
      assert.equal(result.success, true, "fresh SL login should succeed");
      // Pure HTTP — nothing to clean up. Must not throw.
      await assert.doesNotReject(adapter.cleanup(), "SL cleanup must be a safe no-op");
      // And idempotent — calling twice is fine.
      await assert.doesNotReject(adapter.cleanup(), "SL cleanup must be idempotent");
    } finally {
      globalThis.fetch = original;
    }
  });
});

// ---------------------------------------------------------------------------
// NEO-43 — synthetic canary mode
// ---------------------------------------------------------------------------

describe("SportlotsAdapter.login — NEO-43 canary mode", () => {
  it("BYPASSES a still-valid cached cookie and POSTs the real signin form", async () => {
    // CACHED_TOKEN_TTL_MS is 30 DAYS. A canary that honoured the cache would
    // exercise the real SportLots login roughly once a month — blind to
    // exactly the login hang this ticket exists to detect.
    const SportlotsAdapter = loadSportlotsAdapter({
      credentials: {
        username: "user@example.com",
        password: "pw",
        token: "sl_session=cached; path=/",
        expiresAt: Date.now() + 29 * 24 * 60 * 60 * 1000, // comfortably valid
      },
    });
    const stub = scriptedLoginFetch([response({ status: 200, body: OK_LOGIN_BODY })]);
    const restore = stubFetch(stub);
    try {
      const adapter = new SportlotsAdapter(null);
      const result = await adapter.login("sportlots-credentials-canary", { canary: true });
      assert.equal(result.success, true);
      assert.equal(
        stub.loginCalls(),
        1,
        "canary must POST the real signin form even with a valid cached cookie",
      );
    } finally {
      restore();
    }
  });

  it("does NOT write the fresh cookie back to Secret Manager", async () => {
    const updates = [];
    const SportlotsAdapter = loadSportlotsAdapter({
      credentials: { username: "user@example.com", password: "pw" },
      updateCredentials: (key, creds) => updates.push({ key, creds }),
    });
    const restore = stubFetch(scriptedLoginFetch([response({ status: 200, body: OK_LOGIN_BODY })]));
    try {
      const adapter = new SportlotsAdapter(null);
      const result = await adapter.login("sportlots-credentials-canary", { canary: true });
      assert.equal(result.success, true);
      assert.deepEqual(updates, [], "canary must never call updateCredentials");
    } finally {
      restore();
    }
  });

  it("caps retries at 2 attempts instead of 5 so a scheduled probe can't burst", async () => {
    // NEO-29: a burst of serialized marketplace logins is what tripped bot
    // protection. A canary firing on a schedule with the full 5-attempt
    // budget would recreate that shape automatically, forever.
    const SportlotsAdapter = loadSportlotsAdapter();
    const stub = scriptedLoginFetch([response({ status: 500 })]);
    const restore = stubFetch(stub);
    try {
      const adapter = new SportlotsAdapter(null);
      const result = await adapter.login("sportlots-credentials-canary", { canary: true });
      assert.equal(result.success, false);
      assert.equal(stub.loginCalls(), 2, "canary retry budget must be 2, not MAX_ATTEMPTS (5)");
    } finally {
      restore();
    }
  });

  it("without the flag, behaviour is unchanged: full 5-attempt budget and the cookie IS stored", async () => {
    // Regression guard — the flag must be purely additive.
    const burstStub = scriptedLoginFetch([response({ status: 500 })]);
    let restore = stubFetch(burstStub);
    try {
      const A = loadSportlotsAdapter();
      const r = await new A(null).login("sportlots-credentials-user_test");
      assert.equal(r.success, false);
      assert.equal(burstStub.loginCalls(), 5, "non-canary must retain the full 5-attempt budget");
    } finally {
      restore();
    }

    const updates = [];
    const B = loadSportlotsAdapter({
      credentials: { username: "user@example.com", password: "pw" },
      updateCredentials: (key, creds) => updates.push({ key, creds }),
    });
    restore = stubFetch(scriptedLoginFetch([response({ status: 200, body: OK_LOGIN_BODY })]));
    try {
      const r = await new B(null).login("sportlots-credentials-user_test");
      assert.equal(r.success, true);
      assert.equal(updates.length, 1, "non-canary success must still store the cookie");
      assert.ok(updates[0].creds.token.includes("sl_session=abc123"));
    } finally {
      restore();
    }
  });

  it("NEO-141 regression: a canary key still logs in BY PASSWORD from its stored secret", async () => {
    // The canary secrets are the one place a password is still stored, and
    // deliberately so: a live Cloud Scheduler job POSTs {key, canary:true}
    // every 30 minutes and the login alerting is only meaningful if that
    // performs a real sign-in. The NEO-141 "no password → re-auth required"
    // short-circuit must therefore NOT fire for them.
    const updates = [];
    const SportlotsAdapter = loadSportlotsAdapter({
      credentials: {
        username: "canary@example.com",
        password: "canary-placeholder-value",
        token: "sl_session=cached; path=/",
        expiresAt: Date.now() + 29 * 24 * 60 * 60 * 1000,
      },
      updateCredentials: (key, creds) => updates.push({ key, creds }),
    });
    const stub = scriptedLoginFetch([response({ status: 200, body: OK_LOGIN_BODY })]);
    const restore = stubFetch(stub);
    try {
      const result = await new SportlotsAdapter(null).login("sportlots-credentials-canary", {
        canary: true,
      });
      assert.equal(result.success, true);
      assert.notEqual(result.reauthRequired, true, "the canary must never report reauth_required");
      assert.equal(stub.loginCalls(), 1, "it must POST the real signin form (cache bypassed)");
      assert.deepEqual(updates, [], "and must still skip the write-back");
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// NEO-140/NEO-141 — transient credentials supplied in the request body
// ---------------------------------------------------------------------------

describe("SportlotsAdapter.login — transient request-body credentials", () => {
  it("signs in with the supplied credentials without reading the stored secret", async () => {
    // Bootstrap path: the secret may not exist yet.
    const updates = [];
    const SportlotsAdapter = loadSportlotsAdapter({
      credentials: () => {
        throw new Error("Credentials not found for key: sportlots-credentials-new");
      },
      updateCredentials: (key, creds) => updates.push({ key, creds }),
    });
    let submitted = null;
    const stub = cacheAwareFetch({
      onSignin: (opts) => {
        submitted = new URLSearchParams(String(opts.body));
        return response({ status: 200, body: OK_LOGIN_BODY });
      },
    });
    const restore = stubFetch(stub);
    try {
      const result = await new SportlotsAdapter(null).login("sportlots-credentials-new", {
        transientCredentials: { username: "new@example.com", password: "placeholder-value" },
      });
      assert.equal(result.success, true);
      assert.equal(stub.signinCalls(), 1);
      assert.equal(
        submitted.get("email_val"),
        "new@example.com",
        "the SUPPLIED username must be the one submitted",
      );
    } finally {
      restore();
    }
  });

  it("persists only {username, token, expiresAt} — never the supplied password", async () => {
    const updates = [];
    const SportlotsAdapter = loadSportlotsAdapter({
      credentials: () => {
        throw new Error("Credentials not found for key: sportlots-credentials-new");
      },
      updateCredentials: (key, creds) => updates.push({ key, creds }),
    });
    const restore = stubFetch(cacheAwareFetch());
    try {
      await new SportlotsAdapter(null).login("sportlots-credentials-new", {
        transientCredentials: { username: "new@example.com", password: "placeholder-value" },
      });
      assert.equal(updates.length, 1);
      const written = updates[0].creds;
      assert.deepEqual(
        Object.keys(written).sort(),
        ["expiresAt", "token", "username"],
        "the intake write must be exactly the session fields",
      );
      assert.equal(
        JSON.stringify(written).includes("placeholder-value"),
        false,
        "the transient password must not survive anywhere in the persisted payload",
      );
    } finally {
      restore();
    }
  });

  it("supplied credentials bypass a still-valid cached cookie (explicit re-auth)", async () => {
    const SportlotsAdapter = loadSportlotsAdapter({
      credentials: {
        username: "old@example.com",
        token: "sl_session=cached; path=/",
        expiresAt: Date.now() + 29 * 24 * 60 * 60 * 1000,
      },
      updateCredentials: null,
    });
    const stub = cacheAwareFetch();
    const restore = stubFetch(stub);
    try {
      const result = await new SportlotsAdapter(null).login("sportlots-credentials-user_test", {
        transientCredentials: { username: "new@example.com", password: "placeholder-value" },
      });
      assert.equal(result.success, true);
      assert.equal(stub.signinCalls(), 1, "a supplied password must force a fresh sign-in");
      assert.equal(stub.validateCalls(), 1, "and must not spend a call revalidating the old cookie");
    } finally {
      restore();
    }
  });

  it("a rejected supplied password is a rejection, NOT a re-auth prompt", async () => {
    // The user just typed a password and SportLots refused it. Telling them
    // "your session expired, sign in again" would be a loop; they need to know
    // the credentials were wrong.
    const SportlotsAdapter = loadSportlotsAdapter({
      credentials: () => {
        throw new Error("Credentials not found");
      },
      updateCredentials: null,
    });
    const body = `<html><head> </head> <body onload='window.location = "\\?message=Invalid email address supplied";'> </body> </html>`;
    const restore = stubFetch(scriptedLoginFetch([response({ status: 200, body })]));
    try {
      const result = await new SportlotsAdapter(null).login("sportlots-credentials-new", {
        transientCredentials: { username: "new@example.com", password: "placeholder-value" },
      });
      assert.equal(result.success, false);
      assert.equal(result.credentialRejected, true);
      assert.notEqual(result.reauthRequired, true);
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// NEO-141 — the stored cookie must carry no credential material
// ---------------------------------------------------------------------------

describe("SportlotsAdapter — stored session cookie hygiene", () => {
  it("persists the cookie string verbatim and it contains neither username nor password", async () => {
    // The ticket's 30-second check, pinned as a test. SportLots hands back an
    // opaque session id in a `document.cookie =` assignment; what we persist as
    // `token` is exactly those name=value pairs joined. This asserts the
    // property we actually depend on — that the persisted blob is a session
    // handle, not a credential in disguise — so a future SL change that starts
    // echoing the login back in a cookie fails here instead of silently
    // reintroducing password-at-rest through the side door.
    const updates = [];
    const SportlotsAdapter = loadSportlotsAdapter({
      credentials: () => {
        throw new Error("Credentials not found");
      },
      updateCredentials: (key, creds) => updates.push({ key, creds }),
    });
    const USERNAME = "hygiene-probe@example.com";
    const PASSWORD = "hygiene-placeholder-value";
    const restore = stubFetch(
      cacheAwareFetch({
        onSignin: () =>
          response({
            status: 200,
            body:
              `<html><body><script>document.cookie = "sl_session=OPAQUE1; path=/";` +
              `document.cookie = "sl_user=OPAQUE2; path=/";</script></body></html>`,
          }),
      }),
    );
    try {
      await new SportlotsAdapter(null).login("sportlots-credentials-new", {
        transientCredentials: { username: USERNAME, password: PASSWORD },
      });
      const { token } = updates[0].creds;
      assert.ok(!token.includes(PASSWORD), "the stored cookie must not contain the password");
      assert.ok(!token.includes(USERNAME), "the stored cookie must not contain the username");
      // Cookie NAMES are safe to assert on; values are not, so nothing here
      // prints or matches a value beyond the fixture's own placeholders.
      assert.ok(token.includes("sl_session="), "the session cookie should be what is kept");
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// SECURITY — no raw SportLots response body may ever reach the log
// ---------------------------------------------------------------------------
//
// The adapter used to `console.log` the first 200 characters of a response body
// on two failure branches. SportLots sets its session cookies via inline
// `document.cookie="…"` IN THE BODY — the very construct this adapter parses —
// so those previews could put a live session cookie into Cloud Logging, where
// it is readable for ~30 days by anyone holding logging.viewer. An SL session
// cookie is account takeover for that seller and we control no revocation path.
// Ordinary login failures reach both branches, so no attacker action is needed.
//
// The sanitized diagnostic still travels to PostHog on the HTTP response; that
// is the intended channel for page-derived text.

/** Run `fn` with console.log/console.error captured. Always restores. */
async function captureConsole(fn) {
  const lines = [];
  const realLog = console.log;
  const realError = console.error;
  console.log = (...args) => lines.push(args.map(String).join(" "));
  console.error = (...args) => lines.push(args.map(String).join(" "));
  try {
    await fn();
  } finally {
    console.log = realLog;
    console.error = realError;
  }
  return lines.join("\n");
}

describe("SportlotsAdapter — response bodies never reach the log", () => {
  // A fixture cookie value that is unmistakable in a haystack. It is a
  // placeholder, never a real session id.
  const COOKIE_VALUE = "SLSESSIONFIXTUREVALUE0123456789";

  it("does not log the session cookie when validation bounces to the login form", async () => {
    // The exact leak the audit blocked on: SL rejects the cookie it just
    // issued and echoes the session id back in the body it serves.
    const SportlotsAdapter = loadSportlotsAdapter({
      credentials: () => {
        throw new Error("Credentials not found");
      },
    });
    const restore = stubFetch(
      cacheAwareFetch({
        onSignin: () =>
          response({
            status: 200,
            body: `<html><body><script>document.cookie = "sl_session=${COOKIE_VALUE}; path=/";</script></body></html>`,
          }),
        // Validation fails AND echoes the cookie straight back — the property
        // the adapter's own comment asserts about this branch, and the reason
        // the cookie string is handed to buildLoginDiagnostic for exact-value
        // redaction. The echo is inside the first 200 characters, i.e. exactly
        // what the removed preview would have logged.
        onValidate: () =>
          response({
            status: 200,
            body:
              `<html><body>sl_session=${COOKIE_VALUE} was not recognised. ` +
              `Please <a href="/cust/custbin/signin.tpl">sign in</a>.</body></html>`,
          }),
      }),
    );
    let result;
    try {
      const logged = await captureConsole(async () => {
        result = await new SportlotsAdapter(null).login("sportlots-credentials-user_test", {
          transientCredentials: { username: "probe@example.com", password: "placeholder-value" },
        });
      });

      assert.equal(result.success, false, "the fixture should fail validation");
      assert.ok(
        !logged.includes(COOKIE_VALUE),
        "a session cookie value must NEVER appear in logged output",
      );
      // The redacted diagnostic still leaves over HTTPS — that is the channel
      // this material is allowed to use.
      assert.ok(result.diagnostic, "the sanitized diagnostic must still be produced");
      assert.ok(
        !JSON.stringify(result.diagnostic).includes(COOKIE_VALUE),
        "and the diagnostic itself must be redacted of the cookie value",
      );
    } finally {
      restore();
    }
  });

  it("does not log the raw body when no cookies are parsed", async () => {
    // The other former preview site. A body with no `document.cookie=` match
    // can still carry credential material — here, the submitted password.
    const PASSWORD = "no-cookie-branch-placeholder";
    const SportlotsAdapter = loadSportlotsAdapter({
      credentials: () => {
        throw new Error("Credentials not found");
      },
    });
    const restore = stubFetch(
      scriptedLoginFetch([
        response({
          status: 200,
          body: `<html><body>psswd=${PASSWORD} Session ${COOKIE_VALUE} rejected.</body></html>`,
        }),
      ]),
    );
    try {
      const logged = await captureConsole(async () => {
        await new SportlotsAdapter(null).login("sportlots-credentials-user_test", {
          transientCredentials: { username: "probe@example.com", password: PASSWORD },
        });
      });

      assert.ok(!logged.includes(PASSWORD), "the submitted password must never be logged");
      assert.ok(!logged.includes(COOKIE_VALUE), "no raw body material may be logged");
      assert.ok(
        logged.includes("challengeDetected="),
        "the booleans derived from the body are still logged — only the text is gone",
      );
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// NEO-141 hardening — canary protection keys off the KEY, not the flag
// ---------------------------------------------------------------------------

describe("SportlotsAdapter — canary-key write-back protection", () => {
  it("never writes back to a canary key even WITHOUT canary:true on the request", async () => {
    // The canary secrets are the only ones that still store a password, and a
    // write-back persists no password + prunes to one version — so a single
    // flag-less request against the canary key would destroy that password for
    // good. Every subsequent run then answers 422 reauth_required, which the
    // alert policies exclude as a caller error: the login canary goes silently
    // dead while the scheduler keeps running green.
    const updates = [];
    const SportlotsAdapter = loadSportlotsAdapter({
      credentials: {
        username: "canary@example.com",
        password: "canary-placeholder-value",
      },
      updateCredentials: (key, creds) => updates.push({ key, creds }),
    });
    const restore = stubFetch(scriptedLoginFetch([response({ status: 200, body: OK_LOGIN_BODY })]));
    try {
      // No opts at all — this is the terraform-drops-the-flag scenario.
      const result = await new SportlotsAdapter(null).login("sportlots-credentials-canary");
      assert.equal(result.success, true, "the login itself must still succeed");
      assert.deepEqual(
        updates,
        [],
        "a canary key must never be written back, flag or no flag",
      );
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// NEO-141 — a password-less secret must report reauth, never "bad credentials"
// ---------------------------------------------------------------------------

describe("SportlotsAdapter — password-less secret after a transient read failure", () => {
  it("still reports reauthRequired when the FIRST getCredentials throws", async () => {
    // login()'s reauth guard is skipped when the cache-lookup read threw
    // (`stored` stays undefined so a Secret Manager blip keeps its old
    // fall-through behaviour). attemptLogin then re-reads, succeeds, and finds
    // a username with no password. Reported as "Invalid credentials format" it
    // becomes 422 invalid_credentials — the user is told to check credentials
    // they were never asked for, needsReauth is never set, and the amber
    // "sign in again" card never renders.
    let reads = 0;
    const SportlotsAdapter = loadSportlotsAdapter({
      credentials: () => {
        reads++;
        if (reads === 1) throw new Error("RESOURCE_EXHAUSTED: quota");
        return { username: "user@example.com" };
      },
    });
    const restore = stubFetch(async () => {
      throw new Error("fetch must not be called when there is nothing to authenticate with");
    });
    try {
      const result = await new SportlotsAdapter(null).login("sportlots-credentials-user_test");
      assert.equal(reads, 2, "the transient failure must still fall through to the re-read");
      assert.equal(result.success, false);
      assert.equal(result.reauthRequired, true);
      assert.equal(result.error, "Re-authentication required");
      assert.notEqual(
        result.credentialRejected,
        true,
        "nothing was submitted to SportLots, so nothing was rejected",
      );
    } finally {
      restore();
    }
  });

  it("a supplied username with no password is still a caller-data error", async () => {
    // The transient path is unchanged: if a REQUEST carried half a pair, that
    // is the caller's bug, not a lapsed session. (parseTransientCredentials
    // rejects it at the door; this pins the adapter's own behaviour.)
    const SportlotsAdapter = loadSportlotsAdapter();
    const restore = stubFetch(async () => {
      throw new Error("fetch must not be called");
    });
    try {
      const result = await new SportlotsAdapter(null).login("sportlots-credentials-user_test", {
        transientCredentials: { username: "user@example.com", password: "" },
      });
      assert.equal(result.success, false);
      assert.equal(result.credentialRejected, true);
      assert.notEqual(result.reauthRequired, true);
    } finally {
      restore();
    }
  });
});
