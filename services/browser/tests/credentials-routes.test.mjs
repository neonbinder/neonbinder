/**
 * Route tests for the credential CRUD HTTP endpoints.
 *
 * ## What changed here, and why it is the point of the file (NEO-141)
 *
 * This suite used to RE-IMPLEMENT every route handler in-process (a local
 * `buildApp` that copy-pasted the bodies of index.ts's handlers) because
 * src/index.ts calls app.listen() at import time and therefore cannot be
 * required from a test. That made the suite structurally incapable of catching
 * route drift: it asserted against a copy, not the shipped code. The cost was
 * concrete — GET /credentials/:key/token had NO test at all, and shipped for
 * months answering 404 to two unrelated conditions, one of which is a normal
 * state. Convex read only the status code and deleted users' credentials on it.
 *
 * The handlers now live in src/routes/credentials.ts as a mountable Router, and
 * this file mounts the REAL one over an in-memory store. There is no second
 * copy of a handler anywhere in this file. Keep it that way: if a test needs a
 * behaviour the router does not expose, change the router.
 *
 * NEO-20: app-layer auth was removed in favour of Cloud Run IAM, so these tests
 * do not exercise an Authorization check — Cloud Run runs in front of Express
 * and is out of scope for an in-process test.
 *
 * SECURITY: fixtures below use placeholder values that are never real
 * credentials, and no assertion prints a token or password value.
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";

const require = createRequire(import.meta.url);

const { createCredentialsRouter } = require("../dist/routes/credentials");

// ---------------------------------------------------------------------------
// In-memory credentials store (mirrors real SecretsManagerService semantics)
// ---------------------------------------------------------------------------

const KEY_PATTERN = /^[a-z0-9]+-credentials-[a-zA-Z0-9_-]+$/;

/**
 * Mirrors the REAL SecretsManagerService's externally-visible behaviour: the
 * key-format guard, and the exact error strings the route handlers pattern-match
 * on to choose a status code. If those strings drift in the service, these
 * tests must drift with them — that coupling is deliberate and is why the
 * messages are spelled out rather than paraphrased.
 */
class InMemorySecretsManager {
  constructor(store) {
    this._store = store;
  }

  _validateKey(key) {
    if (!KEY_PATTERN.test(key)) {
      throw new Error("Invalid credential key format");
    }
  }

  async getCredentials(key) {
    this._validateKey(key);
    const creds = this._store.get(key);
    if (!creds) {
      throw new Error(`Credentials not found for key: ${key}`);
    }
    return { ...creds };
  }

  async updateCredentials(key, credentials) {
    this._validateKey(key);
    this._store.set(key, { ...credentials });
  }

  async deleteCredentials(key) {
    this._validateKey(key);
    this._store.delete(key);
  }

  async credentialsExist(key) {
    this._validateKey(key);
    return this._store.has(key);
  }
}

// ---------------------------------------------------------------------------
// Test server lifecycle — the real router, mounted over the in-memory store
// ---------------------------------------------------------------------------

let server;
let baseUrl;
let store;

before(async () => {
  const express = require("express");
  store = new Map();
  const app = express();
  app.use(express.json({ limit: "10kb" }));
  app.use(createCredentialsRouter(() => new InMemorySecretsManager(store)));
  server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve()))
  );
});

beforeEach(() => {
  store.clear();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Credential CRUD routes", () => {
  const validKey = "bsc-credentials-testuser1";
  const jsonHeaders = { "Content-Type": "application/json" };

  // -------------------------------------------------------------------------
  // PUT /credentials/:key is GONE, and the router must not answer it.
  //
  // The route had no production callers left after NEO-141 (Convex's
  // saveCredentials stopped issuing it, and a Convex test asserts that), while
  // its blast radius grew: updateCredentials replaces the whole payload and
  // prunes to one version, so a PUT against a live key wiped the user's token
  // and rotating refresh token — unrepairable now that no password is stored.
  // -------------------------------------------------------------------------

  describe("PUT /credentials/:key (removed)", () => {
    it("is not routed, and writes nothing", async () => {
      const res = await fetch(`${baseUrl}/credentials/${validKey}`, {
        method: "PUT",
        headers: jsonHeaders,
        body: JSON.stringify({
          username: "seller@example.com",
          password: "placeholder-not-a-real-password",
        }),
      });

      assert.equal(res.status, 404, "the router must no longer handle PUT");
      assert.equal(
        store.has(validKey),
        false,
        "a removed route must not reach the credential store",
      );
    });
  });

  // -------------------------------------------------------------------------
  // GET /credentials/:key/token — FIRST route test for this endpoint.
  //
  // The whole NEO-141 bug lived here: 404 meant both "no token cached yet"
  // (normal) and "no such secret" (not normal), and the caller could only tell
  // them apart by string-matching the body — which it did not do. The four
  // cases below pin the contract Convex now depends on.
  // -------------------------------------------------------------------------

  describe("GET /credentials/:key/token", () => {
    it("returns 204 with an empty body when the secret exists but has no cached token", async () => {
      store.set(validKey, { username: "seller@example.com" });

      const res = await fetch(`${baseUrl}/credentials/${validKey}/token`);

      assert.equal(
        res.status,
        204,
        "a token-less secret is a NORMAL state and must not look like absence",
      );
      const text = await res.text();
      assert.equal(text, "", "204 must carry no body — a body invites string-matching again");
    });

    it("returns 204 (not 500) for a secret that holds a token-less, PASSWORD-LESS payload", async () => {
      // Collateral fix: getCredentials used to require a `password` field, so
      // the now-normal `{username}` payload threw and surfaced as a 500.
      store.set(validKey, { username: "seller@example.com", expiresAt: 123 });

      const res = await fetch(`${baseUrl}/credentials/${validKey}/token`);

      assert.equal(res.status, 204);
    });

    it("returns 404 'Credentials not found' when the secret genuinely does not exist", async () => {
      const res = await fetch(`${baseUrl}/credentials/${validKey}/token`);

      assert.equal(res.status, 404);
      const body = await res.json();
      assert.equal(body.error, "Credentials not found");
    });

    it("distinguishes 'no token' from 'no secret' BY STATUS CODE, not by body text", async () => {
      // The single assertion this endpoint exists to satisfy. Convex reads the
      // status code; if these two ever collapse back to the same code it will
      // resume deleting live credentials.
      const absent = await fetch(`${baseUrl}/credentials/${validKey}/token`);
      store.set(validKey, { username: "seller@example.com" });
      const tokenless = await fetch(`${baseUrl}/credentials/${validKey}/token`);

      assert.notEqual(
        absent.status,
        tokenless.status,
        "'secret missing' and 'no token cached' MUST NOT share a status code",
      );
      assert.equal(absent.status, 404);
      assert.equal(tokenless.status, 204);
    });

    it("returns 200 with the token and expiry when one is cached", async () => {
      store.set(validKey, {
        username: "seller@example.com",
        token: "placeholder-token-value",
        expiresAt: 9999999999,
      });

      const res = await fetch(`${baseUrl}/credentials/${validKey}/token`);

      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.token, "placeholder-token-value");
      assert.equal(body.expiresAt, 9999999999);
      assert.equal(body.username, undefined, "must not echo the username here");
      assert.equal(body.password, undefined, "must never echo a password");
      assert.equal(body.refreshToken, undefined, "the refresh token must NEVER leave the service");
    });

    it("does not leak the refresh token even when one is stored", async () => {
      store.set(validKey, {
        username: "seller@example.com",
        token: "placeholder-token-value",
        expiresAt: 9999999999,
        refreshToken: "placeholder-refresh-value",
        refreshExpiresAt: 9999999999,
      });

      const res = await fetch(`${baseUrl}/credentials/${validKey}/token`);
      const raw = await res.text();

      assert.equal(res.status, 200);
      assert.ok(
        !raw.includes("placeholder-refresh-value"),
        "the rotating refresh token is the keys to the kingdom; it must never be served",
      );
    });

    it("returns 400 for an invalid key format", async () => {
      const res = await fetch(`${baseUrl}/credentials/INVALID_FORMAT/token`);

      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.error, "Invalid credential key format");
    });
  });

  describe("GET /credentials/:key/metadata", () => {
    it("returns metadata for an existing credential without exposing secrets", async () => {
      store.set(validKey, {
        username: "seller@example.com",
        token: "placeholder-token-value",
        expiresAt: 9999999999,
        refreshToken: "placeholder-refresh-value",
        refreshExpiresAt: 8888888888,
      });

      const res = await fetch(`${baseUrl}/credentials/${validKey}/metadata`);

      assert.equal(res.status, 200);
      const raw = await res.text();
      const body = JSON.parse(raw);
      assert.equal(body.username, "seller@example.com");
      assert.equal(body.hasToken, true);
      assert.equal(body.expiresAt, 9999999999);
      assert.equal(body.hasRefreshToken, true, "booleans let the caller reason about renewability");
      assert.equal(body.refreshExpiresAt, 8888888888);
      assert.equal(body.password, undefined, "must NOT expose the password");
      assert.equal(body.token, undefined, "must NOT expose the raw token");
      assert.ok(
        !raw.includes("placeholder-token-value") && !raw.includes("placeholder-refresh-value"),
        "no credential VALUE may appear anywhere in the metadata response",
      );
    });

    it("reports hasToken/hasRefreshToken false for a bare username-only secret", async () => {
      store.set(validKey, { username: "seller@example.com" });

      const res = await fetch(`${baseUrl}/credentials/${validKey}/metadata`);

      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.hasToken, false);
      assert.equal(body.hasRefreshToken, false);
    });

    it("returns 404 for a key that does not exist", async () => {
      const res = await fetch(`${baseUrl}/credentials/${validKey}/metadata`);

      assert.equal(res.status, 404);
      const body = await res.json();
      assert.equal(body.error, "Credentials not found");
    });

    it("returns 400 for an invalid key format", async () => {
      const res = await fetch(`${baseUrl}/credentials/INVALID_FORMAT/metadata`);

      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.error, "Invalid credential key format");
    });
  });

  describe("DELETE /credentials/:key", () => {
    it("deletes credentials and returns 200", async () => {
      store.set(validKey, { username: "seller@example.com" });

      const res = await fetch(`${baseUrl}/credentials/${validKey}`, { method: "DELETE" });

      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.success, true);
      assert.equal(body.message, "Credentials deleted");
      assert.equal(store.has(validKey), false);
    });

    it("returns 200 even when deleting a non-existent key (idempotent)", async () => {
      const res = await fetch(`${baseUrl}/credentials/${validKey}`, { method: "DELETE" });
      assert.equal(res.status, 200);
    });

    it("returns 400 for an invalid key format", async () => {
      const res = await fetch(`${baseUrl}/credentials/INVALID_FORMAT`, { method: "DELETE" });

      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.error, "Invalid credential key format");
    });
  });

  describe("POST /credentials/check", () => {
    it("reports existence per key without revealing anything about contents", async () => {
      store.set("bsc-credentials-present", { username: "seller@example.com" });

      const res = await fetch(`${baseUrl}/credentials/check`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ keys: ["bsc-credentials-present", "bsc-credentials-absent"] }),
      });

      assert.equal(res.status, 200);
      const body = await res.json();
      assert.deepEqual(body.results, {
        "bsc-credentials-present": true,
        "bsc-credentials-absent": false,
      });
    });

    it("returns 400 when keys is not an array of strings", async () => {
      const res = await fetch(`${baseUrl}/credentials/check`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ keys: ["ok", 7] }),
      });

      assert.equal(res.status, 400);
    });

    it("does not mistake the literal 'check' segment for a credential key", async () => {
      // Guard on the routing itself: POST /credentials/check must not fall
      // through to a :key handler.
      const res = await fetch(`${baseUrl}/credentials/check`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ keys: [] }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.deepEqual(body.results, {});
    });
  });
});

// ---------------------------------------------------------------------------
// Rate limiting — per credential key (isolation)
// ---------------------------------------------------------------------------
//
// Regression guard for the NEO-47 fix. The limiter must bucket by CREDENTIAL
// KEY, not by IP: every request reaches the service from Convex's single egress
// IP (Cloud Run IAM is the auth gate), so an IP-keyed limit was ONE global
// budget that parallel users / E2E workers 429'd each other on — silently
// dropping credential seeds. This exercises the REAL keyGenerator shipped in
// dist/rate-limit, so a regression back to IP-keying fails the suite (a mirror
// copied into this test would not catch that).

describe("Rate limiting — per credential key (isolation)", () => {
  const { credentialRateLimitKey } = require("../dist/rate-limit");
  const MAX = 3; // tiny budget so we can exhaust a single key cheaply
  let rlServer;
  let rlBase;

  before(async () => {
    const express = require("express");
    const rateLimit = require("express-rate-limit");
    const app = express();
    app.use(express.json({ limit: "10kb" }));
    app.use(
      rateLimit({
        windowMs: 60 * 1000,
        max: MAX,
        standardHeaders: true,
        legacyHeaders: false,
        keyGenerator: credentialRateLimitKey, // the real, shipped key function
        validate: { xForwardedForHeader: false, trustProxy: false },
      }),
    );
    // Mirrors a real URL-keyed credential route (credential key in the path).
    // DELETE, not PUT: PUT /credentials/:key no longer exists, and a stub for a
    // deleted route would quietly rot.
    app.delete("/credentials/:key", (_req, res) => res.json({ ok: true }));
    rlServer = createServer(app);
    await new Promise((resolve) => rlServer.listen(0, "127.0.0.1", resolve));
    rlBase = `http://127.0.0.1:${rlServer.address().port}`;
  });

  after(async () => {
    await new Promise((resolve, reject) =>
      rlServer.close((err) => (err ? reject(err) : resolve())),
    );
  });

  const hitKey = (key) =>
    fetch(`${rlBase}/credentials/${key}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
    });

  it("buckets by the URL path :key (limiter runs before route params exist)", () => {
    // The limiter is global middleware; req.params is empty pre-routing, so the
    // key MUST come from req.path for the URL-keyed routes — which is what the
    // credential-seed 429s that started this were hitting.
    assert.equal(
      credentialRateLimitKey({ path: "/credentials/bsc-credentials-userA", body: {} }),
      "cred:bsc-credentials-userA",
      "DELETE /credentials/:key — path :key should drive the bucket",
    );
    assert.equal(
      credentialRateLimitKey({ path: "/credentials/bsc-credentials-userA/metadata", body: {} }),
      "cred:bsc-credentials-userA",
      "GET /credentials/:key/metadata — trailing sub-resource must not change the bucket",
    );
    assert.equal(
      credentialRateLimitKey({ path: "/credentials/bsc-credentials-userA/token", body: {} }),
      "cred:bsc-credentials-userA",
      "GET /credentials/:key/token — same per-key bucket",
    );
  });

  it("buckets by the request body for the body-keyed routes", () => {
    assert.equal(
      credentialRateLimitKey({ path: "/login/sportlots", body: { key: "sportlots-credentials-userB" } }),
      "cred:sportlots-credentials-userB",
      "POST /login/* — body.key should drive the bucket",
    );
    // /credentials/check is the one /credentials/* route that is body-keyed:
    // the literal "check" segment must NOT be mistaken for a credential key.
    assert.equal(
      credentialRateLimitKey({ path: "/credentials/check", body: { keys: ["bsc-credentials-userC"] } }),
      "cred:bsc-credentials-userC",
      "POST /credentials/check — body.keys[0], never the 'check' path segment",
    );
  });

  it("distinct credential keys map to distinct buckets (the isolation invariant)", () => {
    assert.notEqual(
      credentialRateLimitKey({ path: "/credentials/bsc-credentials-userA", body: {} }),
      credentialRateLimitKey({ path: "/credentials/bsc-credentials-userB", body: {} }),
      "two users must not share a rate-limit budget",
    );
  });

  it("falls back to a normalized IP only when no credential key is present", () => {
    const k = credentialRateLimitKey({ path: "/health", body: {}, ip: "203.0.113.7" });
    assert.equal(typeof k, "string");
    assert.ok(!k.startsWith("cred:"), "keyless requests must NOT use a cred: bucket");
    assert.ok(k.length > 0, "keyless requests must still produce a bucket (the IP)");
  });

  it("exhausting one credential key's budget does NOT 429 a different key", async () => {
    const keyA = "bsc-credentials-userA";
    const keyB = "bsc-credentials-userB";

    // Drain key A's entire budget — all MAX requests are under the limit.
    for (let i = 0; i < MAX; i++) {
      const res = await hitKey(keyA);
      assert.equal(res.status, 200, `key A request ${i + 1}/${MAX} should be allowed`);
    }
    // The next request for key A is over budget → 429.
    const overA = await hitKey(keyA);
    assert.equal(overA.status, 429, "key A should be limited after exhausting its budget");

    // A DIFFERENT credential key still has its own full budget → NOT limited.
    // This is the whole point of the fix: one user can't 429 another.
    const firstB = await hitKey(keyB);
    assert.equal(
      firstB.status,
      200,
      "key B must be unaffected by key A's exhausted budget (per-key isolation)",
    );
  });
});
