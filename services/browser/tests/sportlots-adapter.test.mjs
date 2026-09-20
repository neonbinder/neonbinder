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
 *   - On token + valid revalidation → reuse, no signin POST
 *   - On token + failed revalidation → full login (or reauth_required when
 *     there is no password)
 *   - On no token → full login (legacy behavior)
 *   - Fresh login persists token *with* expiresAt
 *
 * NEO-278: our `expiresAt` is bookkeeping, not SL's verdict. A stored cookie
 * is validated against SL regardless of it, and a hit whose expiresAt is
 * missing / past / within 7 days renews it with a single write-back.
 *
 * NEO-281: validation is a three-way verdict. Only SL serving (or redirecting
 * to) the login form is DEAD → reauth_required. 5xx / 429 / thrown fetch /
 * timeout / other non-200 is INDETERMINATE → up to 3 attempts, then a
 * TRANSIENT failure with no reauthRequired (see the last describe block).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// Short-circuit setTimeout so the test suite doesn't actually sleep
// ~7.5s per "give up after 5 attempts" test. jitter math still runs.
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, _ms) => realSetTimeout(fn, 0);

// NEO-288: the automated-access credential every test hands the adapter
// unless it overrides it. Placeholders, never real values — and the
// "never logged" tests grep the captured console for exactly these strings.
const AA_KEY_ID = "key-test";
const AA_SECRET = "secret-test";
const AA_AUTH_ID = "auth-test";

/**
 * Patch SecretsManagerService and the NEO-288 automated-access reader, then
 * load the adapter from dist.
 *
 * @param credentials       — initial value returned by getCredentials. May be a
 *                            function (called with key) for tests that need the
 *                            value to evolve across calls (e.g. cache cleared
 *                            after a stale-cookie miss).
 * @param updateCredentials — optional spy invoked on every updateCredentials.
 * @param automatedAccess   — NEO-288: what getAutomatedAccessCredential
 *                            resolves to; a function is called per read (throw
 *                            from it to simulate a missing secret). Defaults
 *                            to {keyId: AA_KEY_ID, secret: AA_SECRET}.
 * @param onInvalidate      — NEO-288: spy invoked when the adapter calls
 *                            invalidateAutomatedAccessCredential.
 */
function loadSportlotsAdapter({
  credentials = null,
  updateCredentials = null,
  automatedAccess = null,
  onInvalidate = null,
} = {}) {
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

  // The adapter reaches these through the module's exports object at call
  // time (CJS `mod.fn()`), so overwriting the properties is enough — the
  // real reader, and with it Secret Manager, is never invoked here.
  const aaMod = require("../dist/services/sportlots-automated-access");
  aaMod.getAutomatedAccessCredential = async () => {
    if (typeof automatedAccess === "function") return automatedAccess();
    return automatedAccess ?? { keyId: AA_KEY_ID, secret: AA_SECRET };
  };
  aaMod.invalidateAutomatedAccessCredential = () => {
    if (onInvalidate) onInvalidate();
  };

  const { SportlotsAdapter } = require("../dist/adapters/sportlots-adapter");
  return SportlotsAdapter;
}

/** The default automated-access grant SportLots answers with in these tests. */
function automatedAccessGrant() {
  return response({ status: 200, body: JSON.stringify({ success: true, authId: AA_AUTH_ID }) });
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
function scriptedLoginFetch(
  loginResponses,
  validateResponse = response({ body: OK_VALIDATE_BODY }),
  { onAutomatedAccess } = {},
) {
  let loginCalls = 0;
  let automatedAccessCalls = 0;
  const stub = async (url, opts) => {
    const u = String(url);
    if (u.includes("/u/node/automated-access")) {
      automatedAccessCalls++;
      return onAutomatedAccess ? onAutomatedAccess(opts) : automatedAccessGrant();
    }
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
  stub.automatedAccessCalls = () => automatedAccessCalls;
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
 * @param onValidate        — handler for GET /inven/dealbin/newinven.tpl
 * @param onSignin          — handler for POST /cust/custbin/signin.tpl
 * @param onAutomatedAccess — NEO-288: handler for POST /u/node/automated-access
 *                            (defaults to a grant of AA_AUTH_ID)
 */
function cacheAwareFetch({ onValidate, onSignin, onAutomatedAccess } = {}) {
  let validateCalls = 0;
  let signinCalls = 0;
  let automatedAccessCalls = 0;
  const stub = async (url, opts) => {
    const u = String(url);
    if (u.includes("/u/node/automated-access")) {
      automatedAccessCalls++;
      return onAutomatedAccess ? onAutomatedAccess(opts) : automatedAccessGrant();
    }
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
  stub.automatedAccessCalls = () => automatedAccessCalls;
  return stub;
}

// ---------------------------------------------------------------------------
// NEO-288 — SportLots "Automated Access" handshake.
//
// On 2026-09-17 SportLots put Cloudflare Turnstile in front of signin.tpl.
// The SportLots owner issued us a keyId/secret pair: POST it to
// /u/node/automated-access, get a short-lived SINGLE-USE authId, and carry
// that on the signin POST as `turnstile_auth_id`. (The earlier `login_check`
// form field from the closed PR #263 / NEO-286 is superseded and must NOT be
// sent.)
//
// The pair is OUR credential, not the seller's: a handshake failure is an
// `automated_access` fault (502, pages) and never credentialRejected. And the
// pair, the authId and the handshake response body never reach a log line.
// ---------------------------------------------------------------------------

describe("SportlotsAdapter.login — NEO-288 automated-access handshake", () => {
  const { classifyBrowserError, loginFailureOutcome } = require("../dist/observability");

  it("POSTs {keyId, secret} as JSON to the automated-access endpoint, and nothing else", async () => {
    const SportlotsAdapter = loadSportlotsAdapter();
    const seen = [];
    const stub = cacheAwareFetch({
      onAutomatedAccess: (opts) => {
        seen.push(opts);
        return automatedAccessGrant();
      },
    });
    let urls = [];
    const inner = stub;
    const restore = stubFetch(async (url, opts) => {
      urls.push(String(url));
      return inner(url, opts);
    });
    try {
      const result = await new SportlotsAdapter(null).login("sportlots-credentials-user_test");
      assert.equal(result.success, true);
      assert.equal(seen.length, 1, "exactly one handshake for one signin attempt");
      const [opts] = seen;
      assert.equal(
        urls[0],
        "https://www.sportlots.com/u/node/automated-access",
        "the handshake is the FIRST request and hits the exact endpoint",
      );
      assert.equal(opts.method, "POST");
      assert.equal(opts.headers["Content-Type"], "application/json");
      assert.equal(opts.redirect, "manual");
      assert.ok(opts.signal, "the handshake carries an AbortSignal (timeout bound)");
      assert.deepEqual(
        JSON.parse(opts.body),
        { keyId: AA_KEY_ID, secret: AA_SECRET },
        "the body is exactly the pair — no extra keys smuggled from the secret",
      );
      // The secret travels ONLY in the POST body: never in the URL.
      assert.ok(!urls.some((u) => u.includes(AA_SECRET) || u.includes(AA_KEY_ID)));
    } finally {
      restore();
    }
  });

  it("signin form carries email_val, psswd and turnstile_auth_id — and NO login_check", async () => {
    const SportlotsAdapter = loadSportlotsAdapter();
    let signinBody = null;
    let signinOpts = null;
    const stub = cacheAwareFetch({
      onSignin: (opts) => {
        signinOpts = opts;
        signinBody = new URLSearchParams(opts.body);
        return response({ status: 200, body: OK_LOGIN_BODY });
      },
    });
    const restore = stubFetch(stub);
    try {
      const result = await new SportlotsAdapter(null).login("sportlots-credentials-user_test");
      assert.equal(result.success, true);
      assert.equal(result.automatedAccess, true, "the response reports the handshake succeeded");
      assert.equal(stub.automatedAccessCalls(), 1);
      assert.equal(stub.signinCalls(), 1);
      assert.ok(signinBody, "signin POST body should be captured");
      assert.equal(signinOpts.headers["Content-Type"], "application/x-www-form-urlencoded");
      assert.equal(signinBody.get("email_val"), "user@example.com");
      assert.equal(signinBody.get("psswd"), "pw");
      assert.equal(signinBody.get("turnstile_auth_id"), AA_AUTH_ID);
      assert.equal(signinBody.has("login_check"), false, "NEO-286's login_check is superseded");
      assert.deepEqual(
        [...signinBody.keys()].sort(),
        ["email_val", "psswd", "turnstile_auth_id"],
        "the whole form is pinned so a refactor cannot silently add or drop a field",
      );
    } finally {
      restore();
    }
  });

  it("a signin 5xx retry mints a FRESH authId for every attempt (authId is single-use)", async () => {
    const SportlotsAdapter = loadSportlotsAdapter();
    let minted = 0;
    const carried = [];
    const stub = scriptedLoginFetch(
      [response({ status: 500 }), response({ status: 503 }), response({ status: 200, body: OK_LOGIN_BODY })],
      undefined,
      {
        onAutomatedAccess: () => {
          minted++;
          return response({
            status: 200,
            body: JSON.stringify({ success: true, authId: `auth-${minted}` }),
          });
        },
      },
    );
    const restore = stubFetch(async (url, opts) => {
      if (String(url).includes("signin.tpl")) {
        carried.push(new URLSearchParams(opts.body).get("turnstile_auth_id"));
      }
      return stub(url, opts);
    });
    try {
      const result = await new SportlotsAdapter(null).login("sportlots-credentials-user_test");
      assert.equal(result.success, true);
      assert.equal(stub.loginCalls(), 3);
      assert.equal(
        stub.automatedAccessCalls(),
        stub.loginCalls(),
        "one handshake per signin attempt across the retry loop",
      );
      assert.deepEqual(carried, ["auth-1", "auth-2", "auth-3"], "each signin carries its own fresh authId");
    } finally {
      restore();
    }
  });

  it("a signin NETWORK THROW (not just a status) also mints a fresh authId per retry, never replaying the first", async () => {
    // Same guarantee as the 5xx case above, but for the OTHER retryable
    // signin failure shape: a thrown fetch (ECONNRESET-style) rather than an
    // HTTP status. A reused authId is refused by SportLots, so every retry —
    // regardless of why the previous attempt failed — must mint its own.
    let minted = 0;
    const carried = [];
    const stub = scriptedLoginFetch(
      [new Error("ECONNRESET"), new Error("ECONNRESET"), response({ status: 200, body: OK_LOGIN_BODY })],
      undefined,
      {
        onAutomatedAccess: () => {
          minted++;
          return response({
            status: 200,
            body: JSON.stringify({ success: true, authId: `auth-${minted}` }),
          });
        },
      },
    );
    const SportlotsAdapter = loadSportlotsAdapter();
    const restore = stubFetch(async (url, opts) => {
      if (String(url).includes("signin.tpl")) {
        carried.push(new URLSearchParams(opts.body).get("turnstile_auth_id"));
      }
      return stub(url, opts);
    });
    try {
      const result = await new SportlotsAdapter(null).login("sportlots-credentials-user_test");
      assert.equal(result.success, true);
      assert.equal(stub.loginCalls(), 3);
      assert.equal(
        stub.automatedAccessCalls(),
        3,
        "one handshake per attempt, including the two that threw on signin",
      );
      assert.deepEqual(
        new Set(carried).size,
        3,
        "all three carried authIds are distinct — none reused across the network-throw retries",
      );
      assert.deepEqual(carried, ["auth-1", "auth-2", "auth-3"]);
    } finally {
      restore();
    }
  });

  it("transient (bootstrap) credentials still run the handshake exactly once per attempt", async () => {
    // NEO-141 bootstrap path: no stored secret exists yet, so getCredentials
    // throws and the request-body {username, password} drives the sign-in
    // directly. NEO-288's handshake must still run on this path — it is not
    // conditioned on a stored secret existing.
    const SportlotsAdapter = loadSportlotsAdapter({
      credentials: () => {
        throw new Error("Credentials not found for key: sportlots-credentials-new");
      },
    });
    let signinBody = null;
    const stub = cacheAwareFetch({
      onSignin: (opts) => {
        signinBody = new URLSearchParams(opts.body);
        return response({ status: 200, body: OK_LOGIN_BODY });
      },
    });
    const restore = stubFetch(stub);
    try {
      const result = await new SportlotsAdapter(null).login("sportlots-credentials-new", {
        transientCredentials: { username: "new@example.com", password: "placeholder-value" },
      });
      assert.equal(result.success, true);
      assert.equal(stub.automatedAccessCalls(), 1, "the bootstrap path handshakes exactly once");
      assert.equal(stub.signinCalls(), 1);
      assert.equal(signinBody.get("turnstile_auth_id"), AA_AUTH_ID);
    } finally {
      restore();
    }
  });

  it("the canary's handshake failure retries CANARY_MAX_ATTEMPTS (2), not the full MAX_ATTEMPTS (5)", async () => {
    // The reduced canary budget (NEO-43) must hold even when the failure is
    // at the NEO-288 handshake stage, not only at signin — a canary run must
    // still surface a real, repeated marketplace fault quickly rather than
    // masking it behind five retries.
    const SportlotsAdapter = loadSportlotsAdapter({
      credentials: { username: "canary@example.com", password: "canary-placeholder-value" },
    });
    const stub = cacheAwareFetch({
      onAutomatedAccess: () => response({ status: 503, body: "upstream" }),
    });
    const restore = stubFetch(stub);
    try {
      const result = await new SportlotsAdapter(null).login("sportlots-credentials-canary", {
        canary: true,
      });
      assert.equal(result.success, false);
      assert.equal(result.retryable, true);
      assert.equal(stub.automatedAccessCalls(), 2, "canary budget (2), not MAX_ATTEMPTS (5)");
      assert.equal(stub.signinCalls(), 0);
    } finally {
      restore();
    }
  });

  it("a valid cached cookie makes ZERO handshake calls (re-auth path is untouched)", async () => {
    const SportlotsAdapter = loadSportlotsAdapter({
      credentials: {
        username: "user@example.com",
        token: "sl_session=cached",
        expiresAt: Date.now() + 20 * 24 * 60 * 60 * 1000,
      },
    });
    const stub = cacheAwareFetch({
      onAutomatedAccess: () => {
        throw new Error("the handshake must not run for a cached-cookie validation");
      },
    });
    const restore = stubFetch(stub);
    try {
      const result = await new SportlotsAdapter(null).login("sportlots-credentials-user_test");
      assert.equal(result.success, true);
      assert.equal(stub.validateCalls(), 1);
      assert.equal(stub.signinCalls(), 0);
      assert.equal(stub.automatedAccessCalls(), 0);
      assert.equal(
        result.automatedAccess,
        undefined,
        "omitted, not false: the handshake never ran, so the log line must not claim it failed",
      );
    } finally {
      restore();
    }
  });

  it("handshake 503 → retryable, exhausts MAX_ATTEMPTS, never signs in, classifies automated_access", async () => {
    let invalidated = 0;
    const SportlotsAdapter = loadSportlotsAdapter({ onInvalidate: () => invalidated++ });
    const stub = cacheAwareFetch({
      onAutomatedAccess: () => response({ status: 503, body: "upstream" }),
    });
    const restore = stubFetch(stub);
    try {
      const result = await new SportlotsAdapter(null).login("sportlots-credentials-user_test");
      assert.equal(result.success, false);
      assert.equal(result.retryable, true);
      assert.equal(stub.automatedAccessCalls(), 5, "5 attempts (MAX_ATTEMPTS), all at the handshake");
      assert.equal(stub.signinCalls(), 0, "no signin without an authId");
      assert.equal(result.credentialRejected, undefined, "our key, not the seller's password");
      assert.equal(result.reauthRequired, undefined);
      assert.equal(result.automatedAccess, false);
      assert.equal(result.error, "SportLots automated access did not answer (HTTP 503). Please try again later.");
      assert.equal(classifyBrowserError(result.error), "automated_access");
      const outcome = loginFailureOutcome(result, result.error);
      assert.equal(outcome.status, 502, "an unanswered handshake is our outage — pages");
      assert.equal(outcome.errorClass, "automated_access");
      assert.equal(invalidated, 0, "a non-answer says nothing about the key; keep the cache");
    } finally {
      restore();
    }
  });

  it("handshake 429 and a thrown fetch are retryable too", async () => {
    for (const answer of [
      () => response({ status: 429, body: "" }),
      () => { throw new Error("fetch failed: ECONNRESET"); },
    ]) {
      const SportlotsAdapter = loadSportlotsAdapter();
      const stub = cacheAwareFetch({ onAutomatedAccess: answer });
      const restore = stubFetch(stub);
      try {
        const result = await new SportlotsAdapter(null).login("sportlots-credentials-user_test");
        assert.equal(result.success, false);
        assert.equal(result.retryable, true);
        assert.equal(stub.automatedAccessCalls(), 5);
        assert.equal(stub.signinCalls(), 0);
        assert.equal(result.credentialRejected, undefined);
        assert.equal(classifyBrowserError(result.error), "automated_access");
      } finally {
        restore();
      }
    }
  });

  it("handshake hang → aborted by the timeout, retryable 'did not answer in time'", async () => {
    // The suite's setTimeout shim fires the abort timer immediately, so a
    // stub that only settles on the signal proves the AbortController is wired
    // (without it this test would hang).
    const SportlotsAdapter = loadSportlotsAdapter();
    let signals = 0;
    const stub = cacheAwareFetch({
      onAutomatedAccess: (opts) =>
        new Promise((_resolve, reject) => {
          assert.ok(opts?.signal, "handshake fetch must carry an AbortSignal");
          signals++;
          opts.signal.addEventListener("abort", () => {
            const e = new Error("This operation was aborted");
            e.name = "AbortError";
            reject(e);
          });
        }),
    });
    const restore = stubFetch(stub);
    try {
      const result = await new SportlotsAdapter(null).login("sportlots-credentials-user_test");
      assert.equal(result.success, false);
      assert.equal(result.retryable, true);
      assert.equal(signals, 5);
      assert.equal(stub.signinCalls(), 0);
      assert.equal(
        result.error,
        "SportLots automated access did not answer in time. Please try again later.",
      );
      // Deliberately NOT "timeout": that class is the hang detector's signal
      // for a wedged marketplace login, and this is a distinct failure.
      assert.equal(classifyBrowserError(result.error), "automated_access");
    } finally {
      restore();
    }
  });

  it("handshake 403 → NOT retryable, one signin-less attempt, cache invalidated, never credentialRejected", async () => {
    let invalidated = 0;
    const SportlotsAdapter = loadSportlotsAdapter({ onInvalidate: () => invalidated++ });
    const stub = cacheAwareFetch({
      onAutomatedAccess: () => response({ status: 403, body: JSON.stringify({ success: false }) }),
    });
    const restore = stubFetch(stub);
    try {
      const result = await new SportlotsAdapter(null).login("sportlots-credentials-user_test");
      assert.equal(result.success, false);
      assert.equal(result.retryable, false, "replaying a refused key is four more refusals");
      assert.equal(stub.automatedAccessCalls(), 1, "exactly one attempt");
      assert.equal(stub.signinCalls(), 0, "no signin was POSTed");
      assert.equal(result.credentialRejected, undefined, "NEVER the seller's fault");
      assert.equal(result.reauthRequired, undefined);
      assert.equal(result.automatedAccess, false);
      assert.equal(result.error, "SportLots automated access was refused (HTTP 403).");
      assert.equal(classifyBrowserError(result.error), "automated_access");
      assert.equal(loginFailureOutcome(result, result.error).status, 502);
      assert.equal(invalidated, 1, "a refusal drops the cached credential so a rotated key is re-read");
    } finally {
      restore();
    }
  });

  it("401 and any other 4xx are refusals too", async () => {
    for (const status of [401, 400, 404]) {
      let invalidated = 0;
      const SportlotsAdapter = loadSportlotsAdapter({ onInvalidate: () => invalidated++ });
      const stub = cacheAwareFetch({ onAutomatedAccess: () => response({ status, body: "" }) });
      const restore = stubFetch(stub);
      try {
        const result = await new SportlotsAdapter(null).login("sportlots-credentials-user_test");
        assert.equal(result.success, false, `HTTP ${status}`);
        assert.equal(result.retryable, false, `HTTP ${status}`);
        assert.equal(stub.automatedAccessCalls(), 1, `HTTP ${status}`);
        assert.equal(stub.signinCalls(), 0, `HTTP ${status}`);
        assert.equal(result.credentialRejected, undefined, `HTTP ${status}`);
        assert.equal(result.error, `SportLots automated access was refused (HTTP ${status}).`);
        assert.equal(invalidated, 1, `HTTP ${status}`);
      } finally {
        restore();
      }
    }
  });

  it("a 200 whose body is not a grant is a refusal: success:false, missing/empty/non-string authId, junk", async () => {
    for (const body of [
      JSON.stringify({ success: false, authId: "nope" }),
      JSON.stringify({ success: "true", authId: "auth-x" }),
      JSON.stringify({ success: true }),
      JSON.stringify({ success: true, authId: "" }),
      JSON.stringify({ success: true, authId: 42 }),
      JSON.stringify([{ success: true, authId: "auth-x" }]),
      "null",
      "<html>Attention Required! | Cloudflare</html>",
      "",
    ]) {
      let invalidated = 0;
      const SportlotsAdapter = loadSportlotsAdapter({ onInvalidate: () => invalidated++ });
      const stub = cacheAwareFetch({ onAutomatedAccess: () => response({ status: 200, body }) });
      const restore = stubFetch(stub);
      try {
        const result = await new SportlotsAdapter(null).login("sportlots-credentials-user_test");
        assert.equal(result.success, false, body);
        assert.equal(result.retryable, false, body);
        assert.equal(stub.automatedAccessCalls(), 1, body);
        assert.equal(stub.signinCalls(), 0, body);
        assert.equal(result.credentialRejected, undefined, body);
        assert.equal(result.error, "SportLots automated access was refused (HTTP 200).", body);
        assert.equal(result.diagnostic, undefined, "the handshake body is never turned into a diagnostic");
        assert.equal(invalidated, 1, body);
      } finally {
        restore();
      }
    }
  });

  it("credential reader throws → the fixed error, no handshake POST, no signin, not retryable", async () => {
    const SportlotsAdapter = loadSportlotsAdapter({
      automatedAccess: () => {
        throw new Error("SportLots automated access credential is not configured");
      },
    });
    const stub = cacheAwareFetch({
      onAutomatedAccess: () => {
        throw new Error("the endpoint must not be POSTed without a credential");
      },
    });
    const restore = stubFetch(stub);
    try {
      const result = await new SportlotsAdapter(null).login("sportlots-credentials-user_test");
      assert.equal(result.success, false);
      assert.equal(result.retryable, false, "a missing secret does not fix itself in 7.5s");
      assert.equal(result.error, "SportLots automated access credential is not configured");
      assert.equal(stub.automatedAccessCalls(), 0);
      assert.equal(stub.signinCalls(), 0);
      assert.equal(result.credentialRejected, undefined);
      assert.equal(result.reauthRequired, undefined);
      assert.equal(result.automatedAccess, false);
      assert.equal(classifyBrowserError(result.error), "automated_access");
      assert.equal(loginFailureOutcome(result, result.error).status, 502, "fails LOUDLY — never skips the handshake");
    } finally {
      restore();
    }
  });

  it("a reader that throws something else still reports only the fixed error", async () => {
    // The reader's contract is the one constant. If a client-library error
    // ever escaped it, its message could quote the request — so the adapter
    // reports the constant regardless of what was thrown.
    const SportlotsAdapter = loadSportlotsAdapter({
      automatedAccess: () => {
        throw new Error(`PERMISSION_DENIED on projects/x/secrets/sportlots-automated-access payload ${AA_SECRET}`);
      },
    });
    const restore = stubFetch(cacheAwareFetch());
    try {
      let result;
      const logged = await captureConsole(async () => {
        result = await new SportlotsAdapter(null).login("sportlots-credentials-user_test");
      });
      assert.equal(result.error, "SportLots automated access credential is not configured");
      assert.ok(!logged.includes(AA_SECRET));
      assert.ok(!JSON.stringify(result).includes(AA_SECRET));
    } finally {
      restore();
    }
  });

  it("the canary runs the handshake too (it performs a real signin)", async () => {
    const SportlotsAdapter = loadSportlotsAdapter({
      credentials: { username: "canary@example.com", password: "canary-placeholder-value" },
    });
    const stub = cacheAwareFetch();
    const restore = stubFetch(stub);
    try {
      const result = await new SportlotsAdapter(null).login("sportlots-credentials-canary", { canary: true });
      assert.equal(result.success, true);
      assert.equal(stub.automatedAccessCalls(), 1);
      assert.equal(stub.signinCalls(), 1);
    } finally {
      restore();
    }
  });

  it("SECURITY: keyId, secret and authId never reach the console or the response on ANY path", async () => {
    const scenarios = {
      success: { onAutomatedAccess: undefined },
      "handshake 503": { onAutomatedAccess: () => response({ status: 503, body: `denied ${AA_KEY_ID}` }) },
      "handshake 403 echoing the request": {
        onAutomatedAccess: () =>
          response({
            status: 403,
            body: JSON.stringify({ success: false, keyId: AA_KEY_ID, secret: AA_SECRET }),
          }),
      },
      "junk 200 echoing everything": {
        onAutomatedAccess: () =>
          response({ status: 200, body: `keyId=${AA_KEY_ID} secret=${AA_SECRET} authId=${AA_AUTH_ID} <html>` }),
      },
      "fetch throws quoting the body": {
        onAutomatedAccess: () => {
          throw new TypeError(`Headers.append: "${AA_SECRET}" is an invalid header value`);
        },
      },
      "signin reflects the authId (no cookies)": {
        onSignin: () => response({ status: 200, body: `<html>turnstile_auth_id=${AA_AUTH_ID} rejected</html>` }),
      },
      "validation reflects the authId": {
        onValidate: () =>
          response({ status: 200, body: `<html>${AA_AUTH_ID} not accepted, <a href="signin.tpl">sign in</a></html>` }),
      },
    };
    for (const [name, handlers] of Object.entries(scenarios)) {
      const SportlotsAdapter = loadSportlotsAdapter();
      const restore = stubFetch(cacheAwareFetch(handlers));
      try {
        let result;
        const logged = await captureConsole(async () => {
          result = await new SportlotsAdapter(null).login("sportlots-credentials-user_test", {
            transientCredentials: { username: "probe@example.com", password: "placeholder-value" },
          });
        });
        assert.ok(logged.length > 0, `${name}: the path does log`);
        for (const needle of [AA_KEY_ID, AA_SECRET, AA_AUTH_ID]) {
          assert.ok(!logged.includes(needle), `${name}: "${needle}" must never appear in console output`);
          assert.ok(
            !JSON.stringify(result).includes(needle),
            `${name}: "${needle}" must never appear in the adapter response (incl. diagnostic)`,
          );
        }
      } finally {
        restore();
      }
    }
  });

  it("the reader-throws path never logs the secret either", async () => {
    // Belt and braces for the one path the scenario table above cannot reach
    // through fetch: the reader's own failure.
    const SportlotsAdapter = loadSportlotsAdapter({
      automatedAccess: () => {
        throw new Error("SportLots automated access credential is not configured");
      },
    });
    const restore = stubFetch(cacheAwareFetch());
    try {
      const logged = await captureConsole(async () => {
        await new SportlotsAdapter(null).login("sportlots-credentials-user_test");
      });
      assert.ok(logged.includes("automated access credential unavailable"));
      assert.ok(!logged.includes(AA_KEY_ID) && !logged.includes(AA_SECRET) && !logged.includes(AA_AUTH_ID));
    } finally {
      restore();
    }
  });

  it("handshake failure strings carry no substring that would classify as a caller error", () => {
    // classifyBrowserError checks "automated access" first, but the strings
    // must stay clean so a reordering cannot silently turn our outage into
    // a seller typo (invalid_credentials, excluded from paging) or a hang.
    const strings = [
      "SportLots automated access did not answer (HTTP 503). Please try again later.",
      "SportLots automated access did not answer in time. Please try again later.",
      "SportLots automated access did not answer. Please try again later.",
      "SportLots automated access was refused (HTTP 403).",
      "SportLots automated access credential is not configured",
    ];
    for (const s of strings) {
      const lower = s.toLowerCase();
      for (const banned of ["invalid", "password", "re-authentication", "timed out", "timeout", "captcha", "challenge"]) {
        assert.ok(!lower.includes(banned), `"${s}" must not contain "${banned}"`);
      }
      assert.ok(lower.includes("automated access"));
    }
  });
});

describe("SportlotsAdapter.login token cache", () => {
  it("returns success without hitting signin when cached cookie is unexpired and valid", async () => {
    const updates = [];
    const SportlotsAdapter = loadSportlotsAdapter({
      credentials: {
        username: "user@example.com",
        password: "pw",
        token: "sl_session=valid123",
        // NEO-278: comfortably OUTSIDE the 7-day renewal window, so this
        // pins "a fresh cookie is a read-only hit". The 1h fixture it used
        // to carry now sits inside the window and would (correctly) renew.
        expiresAt: Date.now() + 20 * 24 * 60 * 60 * 1000,
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

  it("NEO-278: a cookie past OUR TTL is still validated, and a hit renews expiresAt with one write", async () => {
    // The prod failure: SL sessions never lapse on their own, but the old
    // cache-hit branch was gated on `expiresAt > now` and never renewed it,
    // so 30 days after sign-in the adapter stopped asking SL and answered
    // reauth_required for a cookie that still worked.
    const updates = [];
    const SportlotsAdapter = loadSportlotsAdapter({
      credentials: {
        username: "user@example.com", // no password: the NEO-141 user steady state
        token: "sl_session=still-good",
        expiresAt: Date.now() - 3 * 24 * 60 * 60 * 1000, // lapsed 3 days ago
      },
      updateCredentials: (key, creds) => updates.push({ key, creds }),
    });

    const stub = cacheAwareFetch();
    const restore = stubFetch(stub);
    const beforeMs = Date.now();
    try {
      const adapter = new SportlotsAdapter(null);
      const result = await adapter.login("sportlots-credentials-user_test");
      assert.equal(result.success, true, "a cookie SL still accepts is a live session");
      assert.notEqual(result.reauthRequired, true);
      assert.match(result.message, /cached token/i);
      assert.equal(stub.validateCalls(), 1, "must ask SL whether the cookie works");
      assert.equal(stub.signinCalls(), 0, "must NOT POST signin — there is no password to POST");

      assert.equal(updates.length, 1, "a lapsed expiresAt is renewed with exactly one write");
      const persisted = updates[0].creds;
      assert.equal(persisted.username, "user@example.com");
      assert.equal(persisted.token, "sl_session=still-good", "the validated cookie is kept verbatim");
      assert.equal(persisted.password, undefined, "never a password");
      const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
      assert.ok(
        persisted.expiresAt >= beforeMs + thirtyDaysMs - 5000 &&
          persisted.expiresAt <= Date.now() + thirtyDaysMs + 5000,
        "renewed expiresAt is ~30d out",
      );
      assert.equal(result.expiresAt, persisted.expiresAt, "the response carries the RENEWED expiresAt");
    } finally {
      restore();
    }
  });

  it("NEO-278: a cookie past OUR TTL that FAILS validation with no password is reauth_required, with no write", async () => {
    const updates = [];
    const SportlotsAdapter = loadSportlotsAdapter({
      credentials: {
        username: "user@example.com",
        token: "sl_session=dead",
        expiresAt: Date.now() - 3 * 24 * 60 * 60 * 1000,
      },
      updateCredentials: (key, creds) => updates.push({ key, creds }),
    });

    const stub = cacheAwareFetch({
      onValidate: () => response({ status: 200, body: "<html>please login.tpl</html>" }),
    });
    const restore = stubFetch(stub);
    try {
      const adapter = new SportlotsAdapter(null);
      const result = await adapter.login("sportlots-credentials-user_test");
      assert.equal(result.success, false);
      assert.equal(result.reauthRequired, true, "SL said no and there is nothing left to try");
      assert.equal(result.error, "Re-authentication required");
      assert.equal(stub.validateCalls(), 1);
      assert.equal(stub.signinCalls(), 0);
      assert.equal(updates.length, 0, "nothing to renew — the cookie is dead");
    } finally {
      restore();
    }
  });

  it("NEO-278: a missing expiresAt is validated and, on a hit, written", async () => {
    const updates = [];
    const SportlotsAdapter = loadSportlotsAdapter({
      credentials: { username: "user@example.com", token: "sl_session=no-expiry" },
      updateCredentials: (key, creds) => updates.push({ key, creds }),
    });
    const stub = cacheAwareFetch();
    const restore = stubFetch(stub);
    try {
      const result = await new SportlotsAdapter(null).login("sportlots-credentials-user_test");
      assert.equal(result.success, true);
      assert.equal(stub.validateCalls(), 1);
      assert.equal(stub.signinCalls(), 0);
      assert.equal(updates.length, 1);
      assert.ok(updates[0].creds.expiresAt > Date.now(), "a future expiresAt is now stored");
    } finally {
      restore();
    }
  });

  it("NEO-278: an expiresAt inside the 7-day renewal window is renewed on a hit", async () => {
    const updates = [];
    const SportlotsAdapter = loadSportlotsAdapter({
      credentials: {
        username: "user@example.com",
        token: "sl_session=nearly",
        expiresAt: Date.now() + 2 * 24 * 60 * 60 * 1000, // 2 days left
      },
      updateCredentials: (key, creds) => updates.push({ key, creds }),
    });
    const stub = cacheAwareFetch();
    const restore = stubFetch(stub);
    try {
      const result = await new SportlotsAdapter(null).login("sportlots-credentials-user_test");
      assert.equal(result.success, true);
      assert.equal(updates.length, 1, "renewed before it lapses, so Convex never sees a stale expiry");
      assert.ok(updates[0].creds.expiresAt > Date.now() + 20 * 24 * 60 * 60 * 1000);
    } finally {
      restore();
    }
  });

  it("NEO-278: an expiresAt EXACTLY 7 days out is renewed (the boundary is inclusive)", async () => {
    const updates = [];
    const SportlotsAdapter = loadSportlotsAdapter({
      credentials: {
        username: "user@example.com",
        token: "sl_session=boundary",
        expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      },
      updateCredentials: (key, creds) => updates.push({ key, creds }),
    });
    const stub = cacheAwareFetch();
    const restore = stubFetch(stub);
    try {
      const result = await new SportlotsAdapter(null).login("sportlots-credentials-user_test");
      assert.equal(result.success, true);
      assert.equal(updates.length, 1, "stored <= now + RENEW_WITHIN_MS is due at exact equality");
    } finally {
      restore();
    }
  });

  it("NEO-278: a non-number expiresAt in the secret does not throw, and login still succeeds off the validated cookie (KNOWN GAP: it never self-heals)", async () => {
    // Not reachable via this adapter's own writes today (renewExpiryIfDue and
    // the fresh-login write-back both always write a number) — this is
    // defensive coverage for a hand-edited or otherwise corrupted secret.
    //
    // `stored <= now + RENEW_WITHIN_MS` coerces a non-numeric string via
    // ToNumber; the result is NaN, and every NaN comparison is false. So
    // `due` is false, no renewal write happens, and the corrupt value is
    // reported back and left in the secret indefinitely — unlike a missing
    // or past expiresAt, which DO self-heal on the next hit. Documented
    // rather than fixed: it requires a secret to already be corrupt by some
    // other means, which is outside this adapter's own write paths.
    const updates = [];
    const SportlotsAdapter = loadSportlotsAdapter({
      credentials: {
        username: "user@example.com",
        token: "sl_session=corrupt-expiry",
        expiresAt: "not-a-number",
      },
      updateCredentials: (key, creds) => updates.push({ key, creds }),
    });
    const stub = cacheAwareFetch();
    const restore = stubFetch(stub);
    try {
      const result = await new SportlotsAdapter(null).login("sportlots-credentials-user_test");
      assert.equal(result.success, true, "a corrupt expiresAt must not fail a login SL accepted");
      assert.equal(updates.length, 0, "current behaviour: NaN comparison means 'due' is false — no self-heal");
      assert.equal(result.expiresAt, "not-a-number", "the corrupt value is reported back unchanged");
    } finally {
      restore();
    }
  });

  it("NEO-278: cache validation body containing 'login.tpl' inside an unrelated link is still treated as invalid (existing heuristic; renewal must NOT happen)", async () => {
    const updates = [];
    const SportlotsAdapter = loadSportlotsAdapter({
      credentials: {
        username: "user@example.com",
        token: "sl_session=false-positive",
        expiresAt: Date.now() + 60 * 24 * 60 * 60 * 1000, // far from due
      },
      updateCredentials: (key, creds) => updates.push({ key, creds }),
    });
    // A real dashboard page that happens to link to the login/logout page —
    // the substring heuristic cannot tell this apart from an actual bounce
    // to the login form.
    const stub = cacheAwareFetch({
      onValidate: () =>
        response({
          status: 200,
          body: `<html><body><div>My Inventory</div><a href="/cust/custbin/login.tpl?logout=1">Sign out</a></body></html>`,
        }),
    });
    const restore = stubFetch(stub);
    try {
      const result = await new SportlotsAdapter(null).login("sportlots-credentials-user_test");
      assert.notEqual(result.success, true, "the substring match fires even inside an unrelated link");
      assert.equal(updates.length, 0, "no renewal write on a validation treated as invalid");
      assert.equal(stub.validateCalls(), 1);
    } finally {
      restore();
    }
  });

  it("NEO-278: a failed renewal write does NOT fail a login SL just accepted", async () => {
    // Best-effort: nothing was invalidated by validating, so a Secret Manager
    // blip must not turn a working session into a 502. The stored (lapsed)
    // expiresAt is reported honestly; the next hit retries the write.
    const lapsed = Date.now() - 60 * 1000;
    const SportlotsAdapter = loadSportlotsAdapter({
      credentials: { username: "user@example.com", token: "sl_session=ok", expiresAt: lapsed },
      updateCredentials: () => { throw new Error("RESOURCE_EXHAUSTED: quota"); },
    });
    const stub = cacheAwareFetch();
    const restore = stubFetch(stub);
    try {
      const result = await new SportlotsAdapter(null).login("sportlots-credentials-user_test");
      assert.equal(result.success, true, "the cookie validated; the write is bookkeeping");
      assert.notEqual(result.reauthRequired, true);
      assert.equal(result.expiresAt, lapsed, "reports what is actually stored, not the failed renewal");
      assert.equal(stub.signinCalls(), 0, "must not fall through to a signin it has no password for");
    } finally {
      restore();
    }
  });

  it("NEO-278: a canary KEY never gets a renewal write-back, even without canary:true", async () => {
    // The flag makes the canary skip the cache path entirely; the KEY guard
    // is the structural backstop (isCanaryKey). A renewal write would replace
    // the canary's password-bearing payload with {username, token, expiresAt}
    // and keep-1 pruning would destroy the password for good.
    const updates = [];
    const SportlotsAdapter = loadSportlotsAdapter({
      credentials: {
        username: "canary@example.com",
        password: "canary-placeholder-value",
        token: "sl_session=canary",
        expiresAt: Date.now() - 60 * 1000,
      },
      updateCredentials: (key, creds) => updates.push({ key, creds }),
    });
    const stub = cacheAwareFetch();
    const restore = stubFetch(stub);
    try {
      const result = await new SportlotsAdapter(null).login("sportlots-credentials-canary");
      assert.equal(result.success, true);
      assert.deepEqual(updates, [], "canary key: no write-back, ever");
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
    // attemptLogin: automated-access POST (NEO-288), signin POST, then
    // validation GET. All must succeed.
    const original = globalThis.fetch;
    globalThis.fetch = async (url, _opts) => {
      const u = String(url);
      if (u.includes("/u/node/automated-access")) return automatedAccessGrant();
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

// ---------------------------------------------------------------------------
// NEO-281 — a SportLots hiccup while validating a stored cookie is NOT a dead
// session. Validation is a three-way verdict (valid / dead / indeterminate);
// only DEAD may become reauth_required, and INDETERMINATE retries (3 attempts)
// and then fails TRANSIENT with no reauthRequired.
//
// Background: NEO-278 made every user fetch validate the stored cookie, and
// validateCachedCookie collapsed "SL didn't answer" into "cookie is dead".
// With no stored password (NEO-141) that went straight to reauth_required →
// Convex set needsReauth → "your session expired" for an SL 503. On
// 2026-09-15 one E2E run flagged all 8 worker accounts within minutes.
// ---------------------------------------------------------------------------

describe("SportlotsAdapter — NEO-281 stored-cookie validation verdicts", () => {
  // A password-less user secret with a fresh expiresAt (outside the 7-day
  // renewal window, so a valid verdict is a read-only hit). This is the
  // steady state of every real user secret since NEO-141: the ONLY thing
  // standing between "SL hiccuped" and "reauth_required" is the verdict.
  const passwordlessSecret = () => ({
    username: "user@example.com",
    token: "sl_session=stored",
    expiresAt: Date.now() + 20 * 24 * 60 * 60 * 1000,
  });

  const TRANSIENT_ERROR =
    "SportLots did not respond while validating the stored session; try again";

  /**
   * A stubbed Response carrying real Headers, for the 3xx branch, plus a
   * body whose cancel() is counted — the early returns must release the
   * socket (undici holds it until the body is consumed or cancelled).
   */
  function redirect(status, location, cancels = { n: 0 }) {
    return {
      status,
      headers: new Headers(location === undefined ? {} : { location }),
      body: { cancel: async () => { cancels.n++; } },
      text: async () => "",
    };
  }

  /**
   * Validation stub that plays `scripted` in order (an Error entry throws)
   * and repeats the last entry once exhausted. signin is never expected.
   */
  function scriptedValidate(scripted) {
    let idx = 0;
    return cacheAwareFetch({
      onValidate: () => {
        const r = scripted[Math.min(idx, scripted.length - 1)];
        idx++;
        if (r instanceof Error) throw r;
        return r;
      },
      onSignin: () => {
        throw new Error("signin must not be POSTed while validating a stored cookie");
      },
    });
  }

  it("200 with a clean body → valid, exactly one probe, no retry", async () => {
    const updates = [];
    const SportlotsAdapter = loadSportlotsAdapter({
      credentials: passwordlessSecret(),
      updateCredentials: (key, creds) => updates.push({ key, creds }),
    });
    const stub = scriptedValidate([response({ status: 200, body: OK_VALIDATE_BODY })]);
    const restore = stubFetch(stub);
    try {
      const result = await new SportlotsAdapter(null).login("sportlots-credentials-user_test");
      assert.equal(result.success, true);
      assert.match(result.message, /cached token/i);
      assert.equal(stub.validateCalls(), 1, "a valid verdict never retries");
      assert.equal(stub.signinCalls(), 0);
      assert.equal(updates.length, 0, "fresh expiresAt → read-only hit");
    } finally {
      restore();
    }
  });

  it("200 whose body carries login.tpl → dead → reauthRequired, exactly one probe", async () => {
    const SportlotsAdapter = loadSportlotsAdapter({ credentials: passwordlessSecret() });
    const stub = scriptedValidate([
      response({ status: 200, body: "<html>please visit login.tpl</html>" }),
    ]);
    const restore = stubFetch(stub);
    try {
      const result = await new SportlotsAdapter(null).login("sportlots-credentials-user_test");
      assert.equal(result.success, false);
      assert.equal(result.reauthRequired, true, "SL positively served the login form");
      assert.equal(result.error, "Re-authentication required");
      assert.equal(stub.validateCalls(), 1, "a dead verdict never retries");
      assert.equal(stub.signinCalls(), 0);
    } finally {
      restore();
    }
  });

  it("302 whose Location is the login page → dead → reauthRequired", async () => {
    const SportlotsAdapter = loadSportlotsAdapter({ credentials: passwordlessSecret() });
    const stub = scriptedValidate([redirect(302, "/cust/custbin/login.tpl")]);
    const restore = stubFetch(stub);
    try {
      const result = await new SportlotsAdapter(null).login("sportlots-credentials-user_test");
      assert.equal(result.success, false);
      assert.equal(result.reauthRequired, true, "a redirect TO login is SL saying no");
      assert.equal(stub.validateCalls(), 1);
    } finally {
      restore();
    }
  });

  it("302 → /login.tpl (root-relative) → dead", async () => {
    const SportlotsAdapter = loadSportlotsAdapter({ credentials: passwordlessSecret() });
    const stub = scriptedValidate([redirect(302, "/login.tpl")]);
    const restore = stubFetch(stub);
    try {
      const result = await new SportlotsAdapter(null).login("sportlots-credentials-user_test");
      assert.equal(result.reauthRequired, true);
      assert.equal(stub.validateCalls(), 1);
    } finally {
      restore();
    }
  });

  it("302 → same page with ?msg=login → indeterminate, NOT dead (substring in the query is not the login page)", async () => {
    const SportlotsAdapter = loadSportlotsAdapter({ credentials: passwordlessSecret() });
    const stub = scriptedValidate([redirect(302, "/inven/dealbin/newinven.tpl?msg=login")]);
    const restore = stubFetch(stub);
    try {
      const result = await new SportlotsAdapter(null).login("sportlots-credentials-user_test");
      assert.equal(result.success, false);
      assert.notEqual(result.reauthRequired, true, "a query string mentioning login is not SL's login page");
      assert.equal(result.retryable, true);
      assert.equal(stub.validateCalls(), 3);
    } finally {
      restore();
    }
  });

  it("302 → https://evil.example/login.tpl (off-origin) → indeterminate, NOT dead", async () => {
    const SportlotsAdapter = loadSportlotsAdapter({ credentials: passwordlessSecret() });
    const stub = scriptedValidate([redirect(302, "https://evil.example/login.tpl")]);
    const restore = stubFetch(stub);
    try {
      const result = await new SportlotsAdapter(null).login("sportlots-credentials-user_test");
      assert.equal(result.success, false);
      assert.notEqual(result.reauthRequired, true, "only SportLots' own login page is a verdict");
      assert.equal(result.retryable, true);
      assert.equal(stub.validateCalls(), 3);
    } finally {
      restore();
    }
  });

  it("isSportlotsLoginRedirect: origin-pinned, path-anchored, unparsable → false", () => {
    const { isSportlotsLoginRedirect } = require("../dist/adapters/sportlots-adapter");
    // dead
    assert.equal(isSportlotsLoginRedirect("/login.tpl"), true);
    assert.equal(isSportlotsLoginRedirect("/cust/custbin/signin.tpl"), true);
    assert.equal(isSportlotsLoginRedirect("https://www.sportlots.com/cust/custbin/login.tpl?ret=x"), true);
    assert.equal(isSportlotsLoginRedirect("https://sportlots.com/login.tpl"), true);
    assert.equal(isSportlotsLoginRedirect("/LOGIN.TPL"), true, "case-insensitive like the body check");
    // not a verdict
    assert.equal(isSportlotsLoginRedirect("/inven/dealbin/newinven.tpl?return=login"), false);
    assert.equal(isSportlotsLoginRedirect("/loginhelp"), false);
    assert.equal(isSportlotsLoginRedirect("/login.tpl/extra"), false, "path must END at the tpl");
    assert.equal(isSportlotsLoginRedirect("https://evil.example/login.tpl"), false);
    assert.equal(isSportlotsLoginRedirect("https://notsportlots.com/login.tpl"), false, "suffix match must be on a dot boundary");
    assert.equal(isSportlotsLoginRedirect("https://sportlots.com.evil.example/login.tpl"), false);
    assert.equal(isSportlotsLoginRedirect(""), false);
    assert.equal(isSportlotsLoginRedirect(null), false);
    assert.equal(isSportlotsLoginRedirect(undefined), false);
    assert.equal(isSportlotsLoginRedirect("http://[bad/login.tpl"), false, "unparsable → indeterminate");
  });

  it("3xx and non-200 early returns cancel the unread body so the socket is released", async () => {
    const SportlotsAdapter = loadSportlotsAdapter({ credentials: passwordlessSecret() });
    const cancels = { n: 0 };
    const stub = scriptedValidate([
      redirect(302, "/maintenance.tpl", cancels),
      { status: 503, body: { cancel: async () => { cancels.n++; } }, text: async () => "" },
      redirect(302, "/login.tpl", cancels),
    ]);
    const restore = stubFetch(stub);
    try {
      const result = await new SportlotsAdapter(null).login("sportlots-credentials-user_test");
      assert.equal(result.reauthRequired, true, "third probe was a real login redirect");
      assert.equal(stub.validateCalls(), 3);
      assert.equal(cancels.n, 3, "every early return must cancel its body");
    } finally {
      restore();
    }
  });

  it("a body.cancel() that throws (or a missing body) does not change the verdict", async () => {
    const SportlotsAdapter = loadSportlotsAdapter({ credentials: passwordlessSecret() });
    const stub = scriptedValidate([
      { status: 503, body: { cancel: async () => { throw new TypeError("locked"); } }, text: async () => "" },
      response({ status: 503 }), // no body property at all
      response({ status: 200, body: OK_VALIDATE_BODY }),
    ]);
    const restore = stubFetch(stub);
    try {
      const result = await new SportlotsAdapter(null).login("sportlots-credentials-user_test");
      assert.equal(result.success, true);
      assert.equal(stub.validateCalls(), 3);
    } finally {
      restore();
    }
  });

  it("worst-case validation budget stays under Convex's 60s login ceiling", () => {
    // Convex loginWithRetry aborts /login/sportlots at AbortSignal.timeout(60_000)
    // (apps/web/convex/credentials.ts). If validation alone could run longer,
    // Convex would time out first and the transient verdict would never be
    // delivered. Computed from the exported constants so a bump to either the
    // timeout or the attempt count has to come back through here.
    const {
      VALIDATE_MAX_ATTEMPTS,
      VALIDATE_BACKOFFS_MS,
      DEFAULT_VALIDATE_TIMEOUT_MS,
      JITTER_MAX_FACTOR,
    } = require("../dist/adapters/sportlots-adapter");
    assert.equal(VALIDATE_MAX_ATTEMPTS, 3, "2 retries = 3 attempts (NEO-281 spec)");
    assert.equal(VALIDATE_BACKOFFS_MS.length, VALIDATE_MAX_ATTEMPTS - 1, "one backoff between each pair of attempts");
    const backoffs = VALIDATE_BACKOFFS_MS.reduce((a, b) => a + b, 0) * JITTER_MAX_FACTOR;
    const worstCaseMs = VALIDATE_MAX_ATTEMPTS * DEFAULT_VALIDATE_TIMEOUT_MS + backoffs;
    assert.ok(
      worstCaseMs < 55_000,
      `worst case ${worstCaseMs}ms must stay under 55s (Convex aborts at 60s)`,
    );
  });

  it("worst-case fresh-login handshake budget stays under Convex's 60s login ceiling (NEO-288)", () => {
    // Every attempt can spend the full handshake timeout (a hung
    // /u/node/automated-access is retryable), so the bounded part of the
    // fresh-login path is MAX_ATTEMPTS × AUTOMATED_ACCESS_TIMEOUT_MS plus the
    // jittered backoffs: 5 × 8s + 7.5s × 1.3 = 49.75s. At the previous 15s it
    // was 84.75s — Convex would have aborted first and recorded `timeout`
    // while the service later logged `automated_access`, two records for one
    // failure. The signin POST and post-login validation GET are unbounded
    // (pre-existing) and are outside this arithmetic.
    const {
      MAX_ATTEMPTS,
      BACKOFFS_MS,
      AUTOMATED_ACCESS_TIMEOUT_MS,
      JITTER_MAX_FACTOR,
    } = require("../dist/adapters/sportlots-adapter");
    assert.equal(MAX_ATTEMPTS, 5);
    assert.equal(BACKOFFS_MS.length, MAX_ATTEMPTS - 1, "one backoff between each pair of attempts");
    const backoffs = BACKOFFS_MS.reduce((a, b) => a + b, 0) * JITTER_MAX_FACTOR;
    const worstCaseMs = MAX_ATTEMPTS * AUTOMATED_ACCESS_TIMEOUT_MS + backoffs;
    assert.ok(
      worstCaseMs < 55_000,
      `worst case ${worstCaseMs}ms must stay under 55s (Convex aborts at 60s)`,
    );
  });

  it("302 to somewhere that is NOT login → indeterminate (retried, then transient)", async () => {
    // A redirect we cannot read as a verdict must not be read as "dead".
    const SportlotsAdapter = loadSportlotsAdapter({ credentials: passwordlessSecret() });
    const stub = scriptedValidate([redirect(302, "/maintenance.tpl")]);
    const restore = stubFetch(stub);
    try {
      const result = await new SportlotsAdapter(null).login("sportlots-credentials-user_test");
      assert.equal(result.success, false);
      assert.notEqual(result.reauthRequired, true);
      assert.equal(result.retryable, true);
      assert.equal(stub.validateCalls(), 3);
    } finally {
      restore();
    }
  });

  it("503 then 200 → valid after one retry", async () => {
    const SportlotsAdapter = loadSportlotsAdapter({ credentials: passwordlessSecret() });
    const stub = scriptedValidate([
      response({ status: 503 }),
      response({ status: 200, body: OK_VALIDATE_BODY }),
    ]);
    const restore = stubFetch(stub);
    try {
      const result = await new SportlotsAdapter(null).login("sportlots-credentials-user_test");
      assert.equal(result.success, true, "one SL hiccup must not fail the login");
      assert.equal(stub.validateCalls(), 2, "503 → one retry → 200");
      assert.equal(stub.signinCalls(), 0);
    } finally {
      restore();
    }
  });

  it("429, 429, 200 → valid after two retries", async () => {
    const SportlotsAdapter = loadSportlotsAdapter({ credentials: passwordlessSecret() });
    const stub = scriptedValidate([
      response({ status: 429 }),
      response({ status: 429 }),
      response({ status: 200, body: OK_VALIDATE_BODY }),
    ]);
    const restore = stubFetch(stub);
    try {
      const result = await new SportlotsAdapter(null).login("sportlots-credentials-user_test");
      assert.equal(result.success, true);
      assert.equal(stub.validateCalls(), 3, "the budget is 3 attempts; the third one lands");
      assert.equal(stub.signinCalls(), 0);
    } finally {
      restore();
    }
  });

  it("503 ×3 → TRANSIENT failure: retryable, NOT reauthRequired, exactly 3 attempts, no write", async () => {
    // THE bug. Before NEO-281 this returned reauthRequired: true and Convex
    // flagged the user's session as expired for an SL outage.
    const updates = [];
    const SportlotsAdapter = loadSportlotsAdapter({
      credentials: passwordlessSecret(),
      updateCredentials: (key, creds) => updates.push({ key, creds }),
    });
    const stub = scriptedValidate([response({ status: 503 })]);
    const restore = stubFetch(stub);
    try {
      const result = await new SportlotsAdapter(null).login("sportlots-credentials-user_test");
      assert.equal(result.success, false);
      assert.equal(result.reauthRequired, undefined, "an SL outage is not a verdict on the session");
      assert.notEqual(result.credentialRejected, true, "nothing was submitted, nothing was rejected");
      assert.equal(result.retryable, true);
      assert.equal(result.error, TRANSIENT_ERROR);
      assert.equal(stub.validateCalls(), 3, "2 retries = 3 attempts, then give up");
      assert.equal(stub.signinCalls(), 0, "no password to sign in with, and SL is down anyway");
      assert.equal(updates.length, 0, "the stored cookie is left exactly as it was");
    } finally {
      restore();
    }
  });

  it("a non-429 4xx (403) is conservatively indeterminate, never dead", async () => {
    // We have never seen SL answer a cookie with 401/403 — its refusal is the
    // login form at 200. A false "dead" is the expensive error, so an
    // unexplained 4xx is retried and then fails transient.
    const SportlotsAdapter = loadSportlotsAdapter({ credentials: passwordlessSecret() });
    const stub = scriptedValidate([response({ status: 403 })]);
    const restore = stubFetch(stub);
    try {
      const result = await new SportlotsAdapter(null).login("sportlots-credentials-user_test");
      assert.equal(result.success, false);
      assert.notEqual(result.reauthRequired, true);
      assert.equal(result.retryable, true);
      assert.equal(stub.validateCalls(), 3);
    } finally {
      restore();
    }
  });

  it("fetch throwing ECONNRESET ×3 → transient, not reauth", async () => {
    const SportlotsAdapter = loadSportlotsAdapter({ credentials: passwordlessSecret() });
    const stub = scriptedValidate([new Error("ECONNRESET")]);
    const restore = stubFetch(stub);
    try {
      const result = await new SportlotsAdapter(null).login("sportlots-credentials-user_test");
      assert.equal(result.success, false);
      assert.equal(result.reauthRequired, undefined);
      assert.equal(result.retryable, true);
      assert.equal(result.error, TRANSIENT_ERROR);
      assert.equal(stub.validateCalls(), 3);
    } finally {
      restore();
    }
  });

  it("fetch throwing AbortError ×3 → transient, not reauth", async () => {
    const SportlotsAdapter = loadSportlotsAdapter({ credentials: passwordlessSecret() });
    const abortErr = () => {
      const e = new Error("This operation was aborted");
      e.name = "AbortError";
      return e;
    };
    const stub = scriptedValidate([abortErr(), abortErr(), abortErr()]);
    const restore = stubFetch(stub);
    try {
      const result = await new SportlotsAdapter(null).login("sportlots-credentials-user_test");
      assert.equal(result.success, false);
      assert.equal(result.reauthRequired, undefined);
      assert.equal(result.retryable, true);
      assert.equal(stub.validateCalls(), 3);
    } finally {
      restore();
    }
  });

  it("a fetch that never resolves is aborted by the validation timeout and counted as indeterminate", async () => {
    // The stub never resolves on its own; it only settles when the adapter's
    // AbortController fires. If the adapter passed no signal (or never armed
    // the timer) this test would hang, so a pass proves both. The timeout is
    // injected small; the suite's setTimeout shim fires it immediately anyway.
    const SportlotsAdapter = loadSportlotsAdapter({ credentials: passwordlessSecret() });
    let signals = 0;
    const stub = cacheAwareFetch({
      onValidate: (opts) =>
        new Promise((_resolve, reject) => {
          assert.ok(opts?.signal, "validation fetch must carry an AbortSignal");
          signals++;
          opts.signal.addEventListener("abort", () => {
            const e = new Error("This operation was aborted");
            e.name = "AbortError";
            reject(e);
          });
        }),
      onSignin: () => {
        throw new Error("signin must not be POSTed");
      },
    });
    const restore = stubFetch(stub);
    try {
      const adapter = new SportlotsAdapter(null, { validateTimeoutMs: 20 });
      const result = await adapter.login("sportlots-credentials-user_test");
      assert.equal(result.success, false);
      assert.equal(result.reauthRequired, undefined, "a hang is not a verdict on the session");
      assert.equal(result.retryable, true);
      assert.equal(result.error, TRANSIENT_ERROR);
      assert.equal(stub.validateCalls(), 3, "each hung probe is one indeterminate attempt");
      assert.equal(signals, 3);
    } finally {
      restore();
    }
  });

  it("a hang followed by a 200 → valid (the abort is per-attempt, not per-login)", async () => {
    const SportlotsAdapter = loadSportlotsAdapter({ credentials: passwordlessSecret() });
    let calls = 0;
    const stub = cacheAwareFetch({
      onValidate: (opts) => {
        calls++;
        if (calls === 1) {
          return new Promise((_resolve, reject) => {
            opts.signal.addEventListener("abort", () => {
              const e = new Error("aborted");
              e.name = "AbortError";
              reject(e);
            });
          });
        }
        return response({ status: 200, body: OK_VALIDATE_BODY });
      },
    });
    const restore = stubFetch(stub);
    try {
      const adapter = new SportlotsAdapter(null, { validateTimeoutMs: 20 });
      const result = await adapter.login("sportlots-credentials-user_test");
      assert.equal(result.success, true);
      assert.equal(stub.validateCalls(), 2);
    } finally {
      restore();
    }
  });

  it("the transient error maps to 502 / error_class 'other' at the route, never 422", async () => {
    // loginFailureOutcome is what the /login/sportlots route calls. A
    // transient validation failure must be an upstream fault (502) with a
    // class Convex does not read as reauth_required, so applyLoginOutcome —
    // which acts only on success or reauth_required — writes nothing.
    const { loginFailureOutcome } = require("../dist/observability");
    const outcome = loginFailureOutcome({ success: false, retryable: true }, TRANSIENT_ERROR);
    assert.equal(outcome.status, 502);
    assert.equal(outcome.errorClass, "other");
    assert.notEqual(outcome.errorClass, "reauth_required");
    assert.notEqual(outcome.errorClass, "invalid_credentials");
  });

  it("the transient path never logs the stored cookie", async () => {
    const SportlotsAdapter = loadSportlotsAdapter({ credentials: passwordlessSecret() });
    const stub = scriptedValidate([
      new Error('request to https://www.sportlots.com failed, reason: cookie "sl_session=stored" rejected'),
    ]);
    const restore = stubFetch(stub);
    const logged = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (...a) => logged.push(a.map(String).join(" "));
    console.error = (...a) => logged.push(a.map(String).join(" "));
    try {
      await new SportlotsAdapter(null).login("sportlots-credentials-user_test");
    } finally {
      console.log = origLog;
      console.error = origErr;
      restore();
    }
    const joined = logged.join("\n");
    assert.ok(logged.length > 0, "the path does log");
    assert.doesNotMatch(joined, /sl_session=stored/, "the cookie value must never reach the log");
  });
});
