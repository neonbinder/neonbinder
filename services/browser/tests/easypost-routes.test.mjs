/**
 * Route tests for the EasyPost postage endpoints (NEO-120).
 *
 * Mounts the REAL router (src/routes/easypost.ts, compiled to dist/) over an
 * in-memory store — same discipline as tests/credentials-routes.test.mjs, and
 * for the same NEO-141 reason: src/index.ts calls app.listen() at import time,
 * so only a mountable Router is testable without re-implementing handlers.
 *
 * The load-bearing assertions here are the SCOPE ones: this router carries the
 * only HTTP-reachable credential write since NEO-141 removed
 * PUT /credentials/:key, and what keeps that from reintroducing the removed
 * hazard is that no route in this router will touch a non-easypost secret.
 *
 * SECURITY: fixtures use placeholder values that are never real credentials,
 * and no assertion prints a stored key value.
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";

const require = createRequire(import.meta.url);

const { createEasypostRouter } = require("../dist/routes/easypost");

// ---------------------------------------------------------------------------
// In-memory store (mirrors real SecretsManagerService semantics — the
// key-format guard and exact error strings the handlers pattern-match on)
// ---------------------------------------------------------------------------

const KEY_PATTERN = /^[a-z0-9]+-credentials-[a-zA-Z0-9_-]+$/;

class InMemorySecretsManager {
  constructor(store) {
    this._store = store;
    this.failNextWrite = false;
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
    if (this.failNextWrite) {
      this.failNextWrite = false;
      throw new Error("Secret Manager unavailable");
    }
    this._store.set(key, { ...credentials });
  }
}

// ---------------------------------------------------------------------------
// Fake EasyPost client — captures the apiKey the router hands it, so the tests
// can assert the stored secret is what reaches EasyPost, without printing it.
// ---------------------------------------------------------------------------

let clientCalls;

function fakeCreateClient({ apiKey }) {
  clientCalls.push({ apiKey });
  return {
    async quoteLetterRate({ to, from, weightOz }) {
      if (to && to.line1 === "throw-auth") {
        throw Object.assign(new Error("The API key is invalid"), { kind: "auth" });
      }
      return {
        shipmentId: "shp_test",
        rateId: "rate_test",
        amountCents: 80,
        verifiedTo: to,
        from,
        weightOz,
      };
    },
    async buyLabel({ shipmentId, rateId }) {
      return {
        shipmentId,
        rateId,
        trackingCode: "9400100000000000000000",
        labelUrl: "https://example.test/label.png",
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Test server lifecycle — the real router over the in-memory store
// ---------------------------------------------------------------------------

let server;
let baseUrl;
let store;
let manager;

before(async () => {
  const express = require("express");
  store = new Map();
  manager = new InMemorySecretsManager(store);
  const app = express();
  app.use(express.json({ limit: "10kb" }));
  app.use(createEasypostRouter(() => manager, fakeCreateClient));
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
  clientCalls = [];
  manager.failNextWrite = false;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const easypostKey = "easypost-credentials-user_2abc";
const marketplaceKey = "bsc-credentials-user_2abc";
const jsonHeaders = { "Content-Type": "application/json" };
const placeholderApiKey = "EZTK-placeholder-not-a-real-key";

const goodAddress = {
  name: "Jane Buyer",
  line1: "742 Evergreen Ter",
  city: "Springfield",
  state: "IL",
  postalCode: "62704",
  country: "US",
};

describe("PUT /easypost/:key", () => {
  it("stores the key and never echoes it back", async () => {
    const res = await fetch(`${baseUrl}/easypost/${easypostKey}`, {
      method: "PUT",
      headers: jsonHeaders,
      body: JSON.stringify({ apiKey: placeholderApiKey }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { success: true, message: "EasyPost key stored" });
    assert.equal(JSON.stringify(body).includes(placeholderApiKey), false);

    const stored = store.get(easypostKey);
    assert.equal(stored.password, placeholderApiKey);
    // Self-describing record: username carries the owner from the key.
    assert.equal(stored.username, "user_2abc");
  });

  it("replaces an existing key", async () => {
    store.set(easypostKey, { username: "user_2abc", password: "old-placeholder" });
    const res = await fetch(`${baseUrl}/easypost/${easypostKey}`, {
      method: "PUT",
      headers: jsonHeaders,
      body: JSON.stringify({ apiKey: placeholderApiKey }),
    });
    assert.equal(res.status, 200);
    assert.equal(store.get(easypostKey).password, placeholderApiKey);
  });

  it("trims surrounding whitespace before storing", async () => {
    const res = await fetch(`${baseUrl}/easypost/${easypostKey}`, {
      method: "PUT",
      headers: jsonHeaders,
      body: JSON.stringify({ apiKey: `  ${placeholderApiKey}\n` }),
    });
    assert.equal(res.status, 200);
    assert.equal(store.get(easypostKey).password, placeholderApiKey);
  });

  // The assertion this file exists for: the write CANNOT address a marketplace
  // secret. updateCredentials replaces the whole payload, so answering this
  // request would wipe a user's token and rotating refresh token — the exact
  // hazard NEO-141 removed the generic PUT to close.
  it("refuses a marketplace key and writes nothing", async () => {
    store.set(marketplaceKey, {
      username: "seller@example.com",
      token: "placeholder-token",
      refreshToken: "placeholder-refresh",
    });
    const res = await fetch(`${baseUrl}/easypost/${marketplaceKey}`, {
      method: "PUT",
      headers: jsonHeaders,
      body: JSON.stringify({ apiKey: placeholderApiKey }),
    });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "Invalid credential key format" });
    // The live secret is untouched — token and refresh token both survive.
    assert.deepEqual(store.get(marketplaceKey), {
      username: "seller@example.com",
      token: "placeholder-token",
      refreshToken: "placeholder-refresh",
    });
  });

  it("refuses a malformed key", async () => {
    const res = await fetch(`${baseUrl}/easypost/easypost-credentials-bad%20user`, {
      method: "PUT",
      headers: jsonHeaders,
      body: JSON.stringify({ apiKey: placeholderApiKey }),
    });
    assert.equal(res.status, 400);
    assert.equal(store.size, 0);
  });

  for (const [label, body] of [
    ["a missing apiKey", {}],
    ["an empty apiKey", { apiKey: "" }],
    ["a whitespace-only apiKey", { apiKey: "   " }],
    ["a non-string apiKey", { apiKey: 42 }],
  ]) {
    it(`rejects ${label}`, async () => {
      const res = await fetch(`${baseUrl}/easypost/${easypostKey}`, {
        method: "PUT",
        headers: jsonHeaders,
        body: JSON.stringify(body),
      });
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { error: "Missing required field: apiKey" });
      assert.equal(store.size, 0);
    });
  }

  it("rejects an apiKey longer than any real EasyPost key", async () => {
    const res = await fetch(`${baseUrl}/easypost/${easypostKey}`, {
      method: "PUT",
      headers: jsonHeaders,
      body: JSON.stringify({ apiKey: "x".repeat(257) }),
    });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "apiKey exceeds maximum length" });
    assert.equal(store.size, 0);
  });

  it("answers a store failure with a fixed string, not the error", async () => {
    manager.failNextWrite = true;
    const res = await fetch(`${baseUrl}/easypost/${easypostKey}`, {
      method: "PUT",
      headers: jsonHeaders,
      body: JSON.stringify({ apiKey: placeholderApiKey }),
    });
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: "Failed to store EasyPost key" });
  });
});

describe("POST /easypost/:key/rate", () => {
  it("rates with the STORED key — the PUT is what makes this work", async () => {
    await fetch(`${baseUrl}/easypost/${easypostKey}`, {
      method: "PUT",
      headers: jsonHeaders,
      body: JSON.stringify({ apiKey: placeholderApiKey }),
    });
    const res = await fetch(`${baseUrl}/easypost/${easypostKey}/rate`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ to: goodAddress, from: goodAddress, weightOz: 1 }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.rateId, "rate_test");
    assert.equal(clientCalls.length, 1);
    assert.equal(clientCalls[0].apiKey, placeholderApiKey);
  });

  it("refuses a marketplace key without reading it", async () => {
    store.set(marketplaceKey, {
      username: "seller@example.com",
      password: "canary-placeholder",
    });
    const res = await fetch(`${baseUrl}/easypost/${marketplaceKey}/rate`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ to: goodAddress, from: goodAddress, weightOz: 1 }),
    });
    assert.equal(res.status, 400);
    // The canary's password never reached the EasyPost client.
    assert.equal(clientCalls.length, 0);
  });

  it("404s when no key is saved", async () => {
    const res = await fetch(`${baseUrl}/easypost/${easypostKey}/rate`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ to: goodAddress, from: goodAddress, weightOz: 1 }),
    });
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "No EasyPost key saved for this user" });
  });

  it("400s on missing fields before touching the store", async () => {
    const res = await fetch(`${baseUrl}/easypost/${easypostKey}/rate`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ to: goodAddress }),
    });
    assert.equal(res.status, 400);
  });

  it("maps an EasyPost auth failure to 401 with the actionable message", async () => {
    store.set(easypostKey, { username: "user_2abc", password: placeholderApiKey });
    const res = await fetch(`${baseUrl}/easypost/${easypostKey}/rate`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({
        to: { ...goodAddress, line1: "throw-auth" },
        from: goodAddress,
        weightOz: 1,
      }),
    });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.kind, "auth");
  });
});

describe("POST /easypost/:key/buy", () => {
  it("buys with the stored key", async () => {
    store.set(easypostKey, { username: "user_2abc", password: placeholderApiKey });
    const res = await fetch(`${baseUrl}/easypost/${easypostKey}/buy`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ shipmentId: "shp_test", rateId: "rate_test" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.labelUrl, "https://example.test/label.png");
    assert.equal(clientCalls[0].apiKey, placeholderApiKey);
  });

  it("refuses a marketplace key", async () => {
    const res = await fetch(`${baseUrl}/easypost/${marketplaceKey}/buy`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ shipmentId: "shp_test", rateId: "rate_test" }),
    });
    assert.equal(res.status, 400);
    assert.equal(clientCalls.length, 0);
  });

  it("400s on missing fields", async () => {
    const res = await fetch(`${baseUrl}/easypost/${easypostKey}/buy`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ shipmentId: "shp_test" }),
    });
    assert.equal(res.status, 400);
  });
});
