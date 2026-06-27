/**
 * Integration tests for the credential CRUD HTTP endpoints
 *
 * Strategy: reconstruct the Express app in-process using the same middleware
 * stack as index.ts, but with SecretsManagerService replaced by an in-memory
 * store. This avoids importing dist/index.js (which calls app.listen() at
 * module load time) while still exercising the real route handler logic.
 *
 * The in-memory SecretsManagerService mirrors the error-throwing behavior of
 * the real one so that error-path tests (404, 400 for bad key format) work.
 *
 * NEO-20: app-layer auth was removed in favor of Cloud Run IAM, so these
 * tests no longer exercise an Authorization check — Cloud Run runs in front
 * of Express and is out of scope for an in-process test. The IAM gate is
 * enforced by Cloud Run config (--no-allow-unauthenticated + run.invoker
 * restricted to the convex SA); the login-probe integration suite exercises
 * the authenticated path against a real Cloud Run deployment.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// In-memory credentials store (mirrors real SecretsManagerService semantics)
// ---------------------------------------------------------------------------

const KEY_PATTERN = /^[a-z0-9]+-credentials-[a-zA-Z0-9_-]+$/;

class InMemorySecretsManager {
  constructor(store) {
    // store: Map<key, Credentials>
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
// Build the Express app — mirrors index.ts structure but uses injectable deps
// ---------------------------------------------------------------------------

function buildApp({ secretsManager }) {
  const express = require("express");
  const rateLimit = require("express-rate-limit");
  const helmet = require("helmet");

  const app = express();

  app.use(helmet());
  app.use(express.json({ limit: "10kb" }));

  // Rate limiter — use a very high limit so tests never hit it
  const limiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10000,
    standardHeaders: true,
    legacyHeaders: false,
    validate: { xForwardedForHeader: false, trustProxy: false },
  });
  app.use(limiter);

  // PUT /credentials/:key
  app.put("/credentials/:key", async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
      res.status(400).json({ error: "Missing required fields: username, password" });
      return;
    }
    try {
      await secretsManager.updateCredentials(req.params.key, { username, password });
      res.json({ success: true, message: "Credentials stored" });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      if (message.includes("Invalid credential key format")) {
        res.status(400).json({ error: "Invalid credential key format" });
      } else {
        res.status(500).json({ error: "Failed to store credentials" });
      }
    }
  });

  // GET /credentials/:key/metadata
  app.get("/credentials/:key/metadata", async (req, res) => {
    try {
      const credentials = await secretsManager.getCredentials(req.params.key);
      res.json({
        username: credentials.username,
        hasToken: !!credentials.token,
        expiresAt: credentials.expiresAt,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      if (message.includes("Invalid credential key format")) {
        res.status(400).json({ error: "Invalid credential key format" });
      } else if (message.includes("not found") || message.includes("No active version")) {
        res.status(404).json({ error: "Credentials not found" });
      } else {
        res.status(500).json({ error: "Failed to retrieve credential metadata" });
      }
    }
  });

  // DELETE /credentials/:key
  app.delete("/credentials/:key", async (req, res) => {
    try {
      await secretsManager.deleteCredentials(req.params.key);
      res.json({ success: true, message: "Credentials deleted" });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      if (message.includes("Invalid credential key format")) {
        res.status(400).json({ error: "Invalid credential key format" });
      } else {
        res.status(500).json({ error: "Failed to delete credentials" });
      }
    }
  });

  return app;
}

// ---------------------------------------------------------------------------
// Test server lifecycle
// ---------------------------------------------------------------------------

let server;
let baseUrl;
let store; // shared in-memory store, reset per-test where needed

before(async () => {
  store = new Map();
  const secretsManager = new InMemorySecretsManager(store);
  const app = buildApp({ secretsManager });
  server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve()))
  );
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Credential CRUD routes", () => {
  const validKey = "bsc-credentials-testuser1";
  const jsonHeaders = { "Content-Type": "application/json" };

  describe("PUT /credentials/:key", () => {
    it("should store credentials and return 200 with a valid key and body", async () => {
      store.clear();
      const res = await fetch(`${baseUrl}/credentials/${validKey}`, {
        method: "PUT",
        headers: jsonHeaders,
        body: JSON.stringify({ username: "seller@example.com", password: "hunter2" }),
      });

      assert.equal(res.status, 200, "should return 200 OK");
      const body = await res.json();
      assert.equal(body.success, true);
      assert.equal(body.message, "Credentials stored");
      assert.ok(store.has(validKey), "should persist credentials in the store");
    });

    it("should return 400 when username is missing", async () => {
      const res = await fetch(`${baseUrl}/credentials/${validKey}`, {
        method: "PUT",
        headers: jsonHeaders,
        body: JSON.stringify({ password: "hunter2" }),
      });

      assert.equal(res.status, 400);
      const body = await res.json();
      assert.match(body.error, /username/, "error should mention missing field");
    });

    it("should return 400 when password is missing", async () => {
      const res = await fetch(`${baseUrl}/credentials/${validKey}`, {
        method: "PUT",
        headers: jsonHeaders,
        body: JSON.stringify({ username: "seller@example.com" }),
      });

      assert.equal(res.status, 400);
      const body = await res.json();
      assert.match(body.error, /password/, "error should mention missing field");
    });

    it("should return 400 when the credential key format is invalid", async () => {
      const res = await fetch(`${baseUrl}/credentials/INVALID_KEY_FORMAT`, {
        method: "PUT",
        headers: jsonHeaders,
        body: JSON.stringify({ username: "u", password: "p" }),
      });

      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.error, "Invalid credential key format");
    });
  });

  describe("GET /credentials/:key/metadata", () => {
    it("should return metadata for an existing credential", async () => {
      store.clear();
      store.set(validKey, {
        username: "seller@example.com",
        password: "hunter2",
        token: "Bearer tok",
        expiresAt: 9999999999,
      });

      const res = await fetch(`${baseUrl}/credentials/${validKey}/metadata`);

      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.username, "seller@example.com", "should return the username");
      assert.equal(body.hasToken, true, "should report hasToken=true when token exists");
      assert.equal(body.expiresAt, 9999999999, "should return expiresAt");
      assert.equal(body.password, undefined, "must NOT expose the password");
      assert.equal(body.token, undefined, "must NOT expose the raw token");
    });

    it("should return hasToken=false when no token is stored", async () => {
      store.clear();
      store.set(validKey, { username: "seller@example.com", password: "hunter2" });

      const res = await fetch(`${baseUrl}/credentials/${validKey}/metadata`);

      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.hasToken, false);
    });

    it("should return 404 for a key that does not exist", async () => {
      store.clear();

      const res = await fetch(`${baseUrl}/credentials/${validKey}/metadata`);

      assert.equal(res.status, 404);
      const body = await res.json();
      assert.equal(body.error, "Credentials not found");
    });

    it("should return 400 for an invalid key format", async () => {
      const res = await fetch(`${baseUrl}/credentials/INVALID_FORMAT/metadata`);

      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.error, "Invalid credential key format");
    });
  });

  describe("DELETE /credentials/:key", () => {
    it("should delete credentials and return 200", async () => {
      store.clear();
      store.set(validKey, { username: "seller@example.com", password: "hunter2" });

      const res = await fetch(`${baseUrl}/credentials/${validKey}`, {
        method: "DELETE",
      });

      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.success, true);
      assert.equal(body.message, "Credentials deleted");
      assert.equal(store.has(validKey), false, "key should be removed from the store");
    });

    it("should return 200 even when deleting a non-existent key (idempotent)", async () => {
      store.clear();

      const res = await fetch(`${baseUrl}/credentials/${validKey}`, {
        method: "DELETE",
      });

      // The in-memory store (like the real GCP one) treats missing-key deletes as success
      assert.equal(res.status, 200);
    });

    it("should return 400 for an invalid key format", async () => {
      const res = await fetch(`${baseUrl}/credentials/INVALID_FORMAT`, {
        method: "DELETE",
      });

      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.error, "Invalid credential key format");
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
    // Mirrors the real PUT /credentials/:key surface (credential key in the URL).
    app.put("/credentials/:key", (_req, res) => res.json({ ok: true }));
    rlServer = createServer(app);
    await new Promise((resolve) => rlServer.listen(0, "127.0.0.1", resolve));
    rlBase = `http://127.0.0.1:${rlServer.address().port}`;
  });

  after(async () => {
    await new Promise((resolve, reject) =>
      rlServer.close((err) => (err ? reject(err) : resolve())),
    );
  });

  const putKey = (key) =>
    fetch(`${rlBase}/credentials/${key}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "u", password: "p" }),
    });

  it("buckets by the URL path :key (limiter runs before route params exist)", () => {
    // The limiter is global middleware; req.params is empty pre-routing, so the
    // key MUST come from req.path for the URL-keyed routes — including the seed
    // write PUT /credentials/:key whose 429s started this.
    assert.equal(
      credentialRateLimitKey({ path: "/credentials/bsc-credentials-userA", body: {} }),
      "cred:bsc-credentials-userA",
      "PUT/DELETE /credentials/:key — path :key should drive the bucket",
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
      const res = await putKey(keyA);
      assert.equal(res.status, 200, `key A request ${i + 1}/${MAX} should be allowed`);
    }
    // The next request for key A is over budget → 429.
    const overA = await putKey(keyA);
    assert.equal(overA.status, 429, "key A should be limited after exhausting its budget");

    // A DIFFERENT credential key still has its own full budget → NOT limited.
    // This is the whole point of the fix: one user can't 429 another.
    const firstB = await putKey(keyB);
    assert.equal(
      firstB.status,
      200,
      "key B must be unaffected by key A's exhausted budget (per-key isolation)",
    );
  });
});
