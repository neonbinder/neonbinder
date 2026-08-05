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

  it("does NOT retry when credentials are missing", async () => {
    const SportlotsAdapter = loadSportlotsAdapter({
      credentials: { username: "", password: "" },
    });
    // No fetch should happen; use a stub that would throw if called.
    const restore = stubFetch(async () => {
      throw new Error("fetch should not be called when credentials are missing");
    });
    try {
      const adapter = new SportlotsAdapter(null);
      const result = await adapter.login("sportlots-credentials-user_test");
      assert.equal(result.success, false);
      assert.match(result.error, /Invalid credentials format/);
      // NEO-98: SportLots never gets asked — the stored secret is incomplete.
      // Caller-data problem, so 422 and no page.
      assert.equal(result.credentialRejected, true);
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
      assert.equal(persist.creds.password, "pw", "write-back must preserve password");
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
});
