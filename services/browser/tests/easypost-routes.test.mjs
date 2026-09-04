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

const {
  createEasypostRouter,
  validateWebhookUrl,
  isValidWebhookSecret,
} = require("../dist/routes/easypost");

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

  // Mirrors SecretsManagerService.deleteCredentials, including the part that
  // matters: a secret that is already gone is a SUCCESS, not a miss. The real
  // store swallows Secret Manager's NOT_FOUND for exactly that reason, so a
  // clear is idempotent end to end.
  async deleteCredentials(key) {
    this._validateKey(key);
    if (this.failNextWrite) {
      this.failNextWrite = false;
      throw new Error("Secret Manager unavailable");
    }
    this._store.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Fake EasyPost client — captures the apiKey the router hands it, so the tests
// can assert the stored secret is what reaches EasyPost, without printing it.
// ---------------------------------------------------------------------------

let clientCalls;
let createWebhookCalls;
let deleteWebhookCalls;

/**
 * A normalised tracker as services/easypost.ts produces one — the four real
 * USPS scans from the production letter NEO-121 was verified against, already
 * in ms and with the null locations dropped.
 */
const TRACKER_SNAPSHOT = {
  trackerId: "trk_92253672884048",
  status: "out_for_delivery",
  statusDetail: "out_for_delivery",
  updatedAt: Date.parse("2026-08-29T00:06:00Z"),
  lastScanAt: Date.parse("2026-08-29T00:06:00Z"),
  estDeliveryAt: Date.parse("2026-08-28T00:00:00Z"),
  publicTrackingUrl: "https://track.easypost.com/djE6dHJrX2ZpeHR1cmVfMDAx",
  scans: [
    {
      at: Date.parse("2026-08-25T17:52:00Z"),
      status: "in_transit",
      message: "Origin Processing Cancellation of Postage",
      city: "MADISON",
      state: "WI",
      zip: "53714",
    },
    {
      at: Date.parse("2026-08-29T00:06:00Z"),
      status: "out_for_delivery",
      message: "Delivery",
    },
  ],
};

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
    async retrieveTracker({ shipmentId }) {
      // The ordinary early state of a letter: bought, not yet scanned.
      if (shipmentId === "shp_notracker") {
        throw Object.assign(
          new Error("USPS has not scanned this label yet, so there is nothing to show."),
          { kind: "no_tracker" },
        );
      }
      return TRACKER_SNAPSHOT;
    },
    async listWebhooks() {
      return [
        {
          webhookId: "hook_abc123",
          url: "https://acme-123.convex.site/webhooks/easypost/Ab3xTOKENxYz",
          mode: "production",
          disabledAt: null,
        },
      ];
    },
    async createWebhook({ url, secret }) {
      createWebhookCalls.push({ url, secret });
      // EasyPost quotes the URL it rejected — and that URL carries the bearer
      // token. This is the shape the router must never pass through raw.
      if (url.includes("/reject-me")) {
        throw Object.assign(
          new Error(`Webhook URL ${url} could not be verified`),
          { kind: "unknown" },
        );
      }
      if (url.includes("/blow-up")) {
        // No kind at all — the generic 502 path, which is the one that logs.
        throw new Error(`Registration exploded for ${url}`);
      }
      return { webhookId: "hook_abc123", mode: "production" };
    },
    async deleteWebhook({ webhookId }) {
      deleteWebhookCalls.push(webhookId);
    },
    async retrieveLabel({ shipmentId }) {
      // "not found" in the message on purpose: the router must NOT turn an
      // EasyPost-side miss into the 404 that means "no key saved".
      if (shipmentId === "shp_missing") {
        throw Object.assign(new Error("The requested shipment was not found"), {
          kind: "unknown",
        });
      }
      return {
        shipmentId,
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
  createWebhookCalls = [];
  deleteWebhookCalls = [];
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

describe("GET /easypost/:key/label/:shipmentId", () => {
  it("retrieves with the stored key and returns only label fields", async () => {
    store.set(easypostKey, { username: "user_2abc", password: placeholderApiKey });
    const res = await fetch(`${baseUrl}/easypost/${easypostKey}/label/shp_test`);

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, {
      shipmentId: "shp_test",
      trackingCode: "9400100000000000000000",
      labelUrl: "https://example.test/label.png",
    });
    // The response carries business data only — never the stored key.
    assert.equal(JSON.stringify(body).includes(placeholderApiKey), false);
    assert.equal(clientCalls[0].apiKey, placeholderApiKey);
  });

  it("refuses a marketplace key without reading it", async () => {
    store.set(marketplaceKey, {
      username: "seller@example.com",
      password: "canary-placeholder",
    });
    const res = await fetch(`${baseUrl}/easypost/${marketplaceKey}/label/shp_test`);

    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "Invalid credential key format" });
    // The canary's password never reached the EasyPost client.
    assert.equal(clientCalls.length, 0);
  });

  // Well-formed but absurdly long: this is the length cap on its own, not the
  // format check picking it up by accident.
  it("400s on a shipment id longer than any real one", async () => {
    store.set(easypostKey, { username: "user_2abc", password: placeholderApiKey });
    const res = await fetch(
      `${baseUrl}/easypost/${easypostKey}/label/shp_${"x".repeat(101)}`,
    );

    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "Invalid shipmentId" });
    // Rejected before the stored key was ever read.
    assert.equal(clientCalls.length, 0);
  });

  // The shipment id is stored via a client-reachable path, so it comes back to
  // this route caller-authored. Every one of these is a shape EasyPost could
  // never have issued, and none of them may reach the seller's stored key.
  for (const [label, rawId] of [
    ["a whitespace-only shipment id", "  "],
    ["an id with no shp_ prefix", "not-a-shipment"],
    ["a traversal attempt", "shp_../.."],
    ["an encoded traversal attempt", "shp_%2e%2e%2f"],
    ["an id carrying a query string", "shp_test?foo=bar"],
    ["an id with a wrong-case prefix", "SHP_test"],
    ["the bare prefix with no id", "shp_"],
  ]) {
    it(`400s on ${label}`, async () => {
      store.set(easypostKey, { username: "user_2abc", password: placeholderApiKey });
      const res = await fetch(
        `${baseUrl}/easypost/${easypostKey}/label/${encodeURIComponent(rawId)}`,
      );

      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { error: "Invalid shipmentId" });
      // Rejected before the stored key was ever read.
      assert.equal(clientCalls.length, 0);
    });
  }

  it("404s when no key is saved", async () => {
    const res = await fetch(`${baseUrl}/easypost/${easypostKey}/label/shp_test`);

    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "No EasyPost key saved for this user" });
  });

  // The contract this route exists to keep: 404 means "add your EasyPost key",
  // so a shipment EasyPost itself cannot find must NOT borrow that status —
  // even though its message says "not found".
  it("502s (not 404s) when EasyPost cannot find the shipment", async () => {
    store.set(easypostKey, { username: "user_2abc", password: placeholderApiKey });
    const res = await fetch(`${baseUrl}/easypost/${easypostKey}/label/shp_missing`);

    assert.equal(res.status, 502);
    assert.deepEqual(await res.json(), {
      error: "The requested shipment was not found",
      kind: "unknown",
    });
  });
});

// ---------------------------------------------------------------------------
// NEO-121 — scan visibility routes
// ---------------------------------------------------------------------------

const goodWebhookUrl =
  "https://acme-123.convex.site/webhooks/easypost/Ab3xTOKENxYz";
/** 43 chars — base64url of 32 random bytes, what Convex actually mints. */
const goodSecret = "kJ8vQ2mR7pL4nX1wZ6yT3bC9dF5gH0sA2eU8iO4kM7Q";

describe("validateWebhookUrl (the host allowlist)", () => {
  // THE finding this function exists to close. Without the suffix check this
  // router is a primitive for pointing any seller's EasyPost account at any
  // endpoint on the internet — a registration that outlives NeonBinder,
  // because clearing the key here does not unregister it there.
  it("accepts a convex.site https url", () => {
    assert.equal(validateWebhookUrl(goodWebhookUrl), goodWebhookUrl);
    assert.equal(
      validateWebhookUrl("https://x.convex.site/webhooks/easypost/T"),
      "https://x.convex.site/webhooks/easypost/T",
    );
  });

  it("trims surrounding whitespace", () => {
    assert.equal(validateWebhookUrl(`  ${goodWebhookUrl}\n`), goodWebhookUrl);
  });

  for (const [label, url] of [
    // The suffix-in-the-middle attack: a substring test on the whole URL
    // passes this, a parsed-hostname test does not.
    ["a lookalike host with the suffix in the middle", "https://x.convex.site.evil.com/webhooks/easypost/T"],
    ["the suffix only in the path", "https://evil.com/x.convex.site/webhooks/easypost/T"],
    ["the suffix only in a query string", "https://evil.com/?to=.convex.site"],
    ["the suffix only in a fragment", "https://evil.com/#.convex.site"],
    ["a host that merely ends in convex.site with no dot", "https://notconvex.site/x"],
    ["the bare apex", "https://convex.site/x"],
    ["http", "http://x.convex.site/webhooks/easypost/T"],
    ["a protocol-relative url", "//x.convex.site/webhooks/easypost/T"],
    ["no scheme at all", "x.convex.site/webhooks/easypost/T"],
    ["javascript:", "javascript:alert(1)"],
    ["data:", "data:text/html,<script>"],
    ["file:", "file:///etc/passwd"],
    // Parses with hostname x.convex.site, so a naive host check lets it
    // through while handing EasyPost userinfo we never meant it to send.
    ["userinfo smuggling", "https://evil.com@x.convex.site/webhooks/easypost/T"],
    ["not a url at all", "definitely not a url"],
    ["an empty string", ""],
    ["whitespace only", "   "],
    ["a number", 42],
    ["null", null],
    ["undefined", undefined],
    ["an object", { url: "https://x.convex.site/" }],
  ]) {
    it(`rejects ${label}`, () => {
      assert.equal(validateWebhookUrl(url), undefined);
    });
  }

  it("rejects a url longer than any real one", () => {
    assert.equal(
      validateWebhookUrl(`https://x.convex.site/webhooks/easypost/${"t".repeat(600)}`),
      undefined,
    );
  });

  // A Convex site host is lowercased by URL parsing, so case cannot be used
  // to slip past the suffix comparison.
  it("is case-insensitive about the host", () => {
    const mixed = "https://Acme-123.CONVEX.SITE/webhooks/easypost/T";
    assert.equal(validateWebhookUrl(mixed), mixed);
  });

  // A punycode-encoded host is just an ordinary ASCII hostname to `URL` — it
  // gets no special treatment, so one that does not end in ".convex.site"
  // (encoded or not) is refused exactly like any other bad host.
  it("rejects an IDN/punycode host that is not a convex.site subdomain", () => {
    assert.equal(
      validateWebhookUrl("https://xn--80ak6aa92e.com/webhooks/easypost/T"),
      undefined,
    );
  });

  // `URL` applies IDNA/UTS46 mapping to a Unicode hostname before this
  // function ever sees `parsed.hostname` — a fullwidth homograph of "x" here
  // maps down to plain ASCII "x" (NOT to a "xn--" punycode label), so the
  // result IS the literal `x.convex.site` this control means to allow. This
  // is not a bypass: the string the check approves and the string returned
  // both round-trip to the exact same host under any spec-compliant URL
  // parser (e.g. inside `fetch`), so nothing downstream can be pointed
  // somewhere this check did not already sign off on.
  it("accepts a fullwidth-Unicode homograph that normalises to a real convex.site host", () => {
    const homograph = "https://ｘ.convex.site/webhooks/easypost/T"; // fullwidth "x"
    assert.equal(new URL(homograph).hostname, "x.convex.site");
    assert.equal(validateWebhookUrl(homograph), homograph);
  });

  // The same normalisation can also collapse a homograph down to the bare
  // apex — and the apex rule (no subdomain) still refuses it. The control
  // does not get fooled into treating a decorated apex as a subdomain.
  it("still rejects the bare apex reached via a fullwidth-Unicode homograph", () => {
    const homographApex = "https://ｃonvex.site/x"; // fullwidth "c" + "onvex.site"
    assert.equal(new URL(homographApex).hostname, "convex.site");
    assert.equal(validateWebhookUrl(homographApex), undefined);
  });

  // `URL#hostname` never includes the port, so an explicit port rides through
  // the suffix check untouched. Pinned deliberately: the allowlist's job is
  // the HOST (the control that stops this being an arbitrary-endpoint
  // primitive), not the port, and a Convex site URL never legitimately
  // carries one — this documents the current behaviour rather than a gap
  // this function claims to close.
  it("does not reject a convex.site url carrying an explicit port", () => {
    const withPort = "https://x.convex.site:8080/webhooks/easypost/T";
    assert.equal(validateWebhookUrl(withPort), withPort);
  });

  // A trailing dot is the DNS root label, and `URL` preserves it verbatim in
  // `hostname`. ".convex.site." does not end with ".convex.site", so this is
  // refused — over-strict is the safe direction for a control whose only job
  // is keeping bad hosts out.
  it("rejects a convex.site host with a trailing dot", () => {
    assert.equal(
      validateWebhookUrl("https://x.convex.site./webhooks/easypost/T"),
      undefined,
    );
  });
});

describe("isValidWebhookSecret", () => {
  it("accepts the 43-char base64url secret Convex mints", () => {
    assert.equal(isValidWebhookSecret(goodSecret), true);
    assert.equal(isValidWebhookSecret("x".repeat(32)), true);
    assert.equal(isValidWebhookSecret("x".repeat(256)), true);
  });

  for (const [label, secret] of [
    ["31 chars", "x".repeat(31)],
    ["257 chars", "x".repeat(257)],
    ["an empty string", ""],
    ["a number", 12345678901234567890],
    ["null", null],
    ["undefined", undefined],
    ["an array of chars", Array(40).fill("x")],
  ]) {
    it(`rejects ${label}`, () => {
      assert.equal(isValidWebhookSecret(secret), false);
    });
  }
});

describe("GET /easypost/:key/tracker/:shipmentId", () => {
  it("returns the normalised tracker and never the stored key", async () => {
    store.set(easypostKey, { username: "user_2abc", password: placeholderApiKey });
    const res = await fetch(`${baseUrl}/easypost/${easypostKey}/tracker/shp_letter`);

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.trackerId, "trk_92253672884048");
    assert.equal(body.status, "out_for_delivery");
    assert.equal(body.scans.length, 2);
    assert.equal(JSON.stringify(body).includes(placeholderApiKey), false);
    assert.equal(clientCalls[0].apiKey, placeholderApiKey);
  });

  it("refuses a marketplace key without reading it", async () => {
    store.set(marketplaceKey, { username: "seller@example.com", password: "canary-placeholder" });
    const res = await fetch(`${baseUrl}/easypost/${marketplaceKey}/tracker/shp_letter`);

    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "Invalid credential key format" });
    assert.equal(clientCalls.length, 0);
  });

  // Same untrusted-input guards as the label route, and for the same reason:
  // the id reaches this route caller-authored.
  for (const [label, rawId] of [
    ["a whitespace-only shipment id", "  "],
    ["an id with no shp_ prefix", "not-a-shipment"],
    ["a traversal attempt", "shp_../.."],
    ["an encoded traversal attempt", "shp_%2e%2e%2f"],
    ["an id with a wrong-case prefix", "SHP_test"],
    ["the bare prefix with no id", "shp_"],
  ]) {
    it(`400s on ${label}`, async () => {
      store.set(easypostKey, { username: "user_2abc", password: placeholderApiKey });
      const res = await fetch(
        `${baseUrl}/easypost/${easypostKey}/tracker/${encodeURIComponent(rawId)}`,
      );
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { error: "Invalid shipmentId" });
      assert.equal(clientCalls.length, 0);
    });
  }

  it("400s on a shipment id longer than any real one", async () => {
    store.set(easypostKey, { username: "user_2abc", password: placeholderApiKey });
    const res = await fetch(
      `${baseUrl}/easypost/${easypostKey}/tracker/shp_${"x".repeat(101)}`,
    );
    assert.equal(res.status, 400);
    assert.equal(clientCalls.length, 0);
  });

  it("404s when no key is saved", async () => {
    const res = await fetch(`${baseUrl}/easypost/${easypostKey}/tracker/shp_letter`);
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "No EasyPost key saved for this user" });
  });

  // 409, not 404: 404 out of this router means "add your EasyPost key", and a
  // letter that USPS has simply not scanned yet must not send a seller off to
  // re-enter a key that is perfectly fine.
  it("409s (not 404s) when the shipment has no tracker yet", async () => {
    store.set(easypostKey, { username: "user_2abc", password: placeholderApiKey });
    const res = await fetch(`${baseUrl}/easypost/${easypostKey}/tracker/shp_notracker`);

    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.kind, "no_tracker");
    assert.match(body.error, /has not scanned/);
  });
});

describe("GET /easypost/:key/webhooks", () => {
  it("lists the account's webhooks", async () => {
    store.set(easypostKey, { username: "user_2abc", password: placeholderApiKey });
    const res = await fetch(`${baseUrl}/easypost/${easypostKey}/webhooks`);

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.webhooks.length, 1);
    assert.equal(body.webhooks[0].webhookId, "hook_abc123");
    assert.equal(JSON.stringify(body).includes(placeholderApiKey), false);
  });

  it("refuses a marketplace key without reading it", async () => {
    store.set(marketplaceKey, { username: "seller@example.com", password: "canary-placeholder" });
    const res = await fetch(`${baseUrl}/easypost/${marketplaceKey}/webhooks`);
    assert.equal(res.status, 400);
    assert.equal(clientCalls.length, 0);
  });

  it("404s when no key is saved", async () => {
    const res = await fetch(`${baseUrl}/easypost/${easypostKey}/webhooks`);
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "No EasyPost key saved for this user" });
  });
});

describe("POST /easypost/:key/webhooks", () => {
  const post = (key, body) =>
    fetch(`${baseUrl}/easypost/${key}/webhooks`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify(body),
    });

  it("registers a convex.site url and returns only the hook id and mode", async () => {
    store.set(easypostKey, { username: "user_2abc", password: placeholderApiKey });
    const res = await post(easypostKey, { url: goodWebhookUrl, secret: goodSecret });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { webhookId: "hook_abc123", mode: "production" });
    // The secret went out in the request and comes back in nothing.
    assert.equal(JSON.stringify(body).includes(goodSecret), false);
    assert.equal(createWebhookCalls[0].url, goodWebhookUrl);
    assert.equal(createWebhookCalls[0].secret, goodSecret);
  });

  it("refuses a marketplace key without reading it", async () => {
    store.set(marketplaceKey, { username: "seller@example.com", password: "canary-placeholder" });
    const res = await post(marketplaceKey, { url: goodWebhookUrl, secret: goodSecret });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "Invalid credential key format" });
    assert.equal(clientCalls.length, 0);
  });

  // The finding, at the route: an arbitrary host must never be registerable,
  // and validation must happen BEFORE the seller's key is read.
  for (const [label, url] of [
    ["a lookalike host", "https://acme.convex.site.evil.com/webhooks/easypost/T"],
    ["an arbitrary https host", "https://attacker.example.com/collect"],
    ["http", "http://acme.convex.site/webhooks/easypost/T"],
    ["a non-url", "not a url"],
    ["a missing url", undefined],
    ["a non-string url", 42],
  ]) {
    it(`400s on ${label}, before the key is read`, async () => {
      store.set(easypostKey, { username: "user_2abc", password: placeholderApiKey });
      const res = await post(easypostKey, { url, secret: goodSecret });

      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { error: "Invalid webhook url" });
      // Neither the key nor EasyPost was touched.
      assert.equal(clientCalls.length, 0);
      assert.equal(createWebhookCalls.length, 0);
    });
  }

  // The URL under test carries a bearer token, so a rejection says what was
  // wrong in general terms and never quotes the input back.
  it("does not echo the rejected url into the 400 body", async () => {
    const res = await post(easypostKey, {
      url: "http://acme.convex.site/webhooks/easypost/Ab3xTOKENxYz",
      secret: goodSecret,
    });
    const text = await res.text();
    assert.equal(text.includes("Ab3xTOKENxYz"), false);
  });

  for (const [label, secret] of [
    ["a secret below the 32-char floor", "x".repeat(31)],
    ["a secret above the 256-char ceiling", "x".repeat(257)],
    ["an empty secret", ""],
    ["a missing secret", undefined],
    ["a non-string secret", 12345],
  ]) {
    it(`400s on ${label}, before the key is read`, async () => {
      store.set(easypostKey, { username: "user_2abc", password: placeholderApiKey });
      const res = await post(easypostKey, { url: goodWebhookUrl, secret });

      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { error: "Invalid webhook secret" });
      assert.equal(clientCalls.length, 0);
      assert.equal(createWebhookCalls.length, 0);
    });
  }

  it("never echoes the rejected secret", async () => {
    const tooShort = "shortsecret-Ab3xTOKENxYz";
    const res = await post(easypostKey, { url: goodWebhookUrl, secret: tooShort });
    assert.equal((await res.text()).includes(tooShort), false);
  });

  it("404s when no key is saved", async () => {
    const res = await post(easypostKey, { url: goodWebhookUrl, secret: goodSecret });
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "No EasyPost key saved for this user" });
  });

  // EasyPost quotes the URL it rejected, and that URL is a credential. The
  // body Convex receives must already be scrubbed — forwarding an EasyPost
  // message is deliberate (they are seller-actionable), so the scrubbing has
  // to happen rather than the forwarding being dropped.
  it("redacts the webhook token out of the forwarded error body", async () => {
    store.set(easypostKey, { username: "user_2abc", password: placeholderApiKey });
    const res = await post(easypostKey, {
      url: "https://acme-123.convex.site/webhooks/easypost/reject-me",
      secret: goodSecret,
    });

    assert.equal(res.status, 502);
    const text = await res.text();
    assert.equal(text.includes("/webhooks/easypost/reject-me"), false);
    assert.match(text, /webhooks\/easypost\/<token>/);
  });

  // The generic 502 path is the one that writes to console. A token reaching
  // Cloud Logging is a credential in a log retained for 30 days.
  it("redacts the token out of the log line, and logs no error object", async () => {
    store.set(easypostKey, { username: "user_2abc", password: placeholderApiKey });
    const original = console.error;
    const logged = [];
    console.error = (...args) => logged.push(args);
    try {
      const res = await post(easypostKey, {
        url: "https://acme-123.convex.site/webhooks/easypost/blow-up",
        secret: goodSecret,
      });
      assert.equal(res.status, 502);
      // Generic body — the seller gets nothing to act on from an unclassified
      // failure, so nothing is forwarded.
      assert.deepEqual(await res.json(), { error: "EasyPost request failed" });
    } finally {
      console.error = original;
    }

    const flat = logged.map((args) => args.join(" ")).join("\n");
    assert.equal(flat.includes("blow-up"), false);
    assert.ok(flat.includes("/webhooks/easypost/<token>"));
    // The message, not the Error — a stack or `cause` can still carry the URL.
    assert.equal(logged[0].some((a) => a instanceof Error), false);
  });
});

describe("DELETE /easypost/:key/webhooks/:webhookId", () => {
  const del = (key, id) =>
    fetch(`${baseUrl}/easypost/${key}/webhooks/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });

  it("deletes with the stored key", async () => {
    store.set(easypostKey, { username: "user_2abc", password: placeholderApiKey });
    const res = await del(easypostKey, "hook_abc123");

    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { success: true, message: "Webhook deleted" });
    assert.deepEqual(deleteWebhookCalls, ["hook_abc123"]);
    assert.equal(clientCalls[0].apiKey, placeholderApiKey);
  });

  it("refuses a marketplace key without reading it", async () => {
    store.set(marketplaceKey, { username: "seller@example.com", password: "canary-placeholder" });
    const res = await del(marketplaceKey, "hook_abc123");
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "Invalid credential key format" });
    assert.equal(clientCalls.length, 0);
  });

  for (const [label, id] of [
    ["no hook_ prefix", "abc123"],
    ["a wrong-case prefix", "HOOK_abc123"],
    ["the bare prefix", "hook_"],
    ["a traversal attempt", "hook_../.."],
    ["an encoded traversal attempt", "hook_%2e%2e%2f"],
    ["a hyphen (EasyPost mints none)", "hook_abc-123"],
    ["whitespace only", "   "],
  ]) {
    it(`400s on a webhook id with ${label}`, async () => {
      store.set(easypostKey, { username: "user_2abc", password: placeholderApiKey });
      const res = await del(easypostKey, id);

      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { error: "Invalid webhookId" });
      assert.equal(clientCalls.length, 0);
      assert.equal(deleteWebhookCalls.length, 0);
    });
  }

  it("400s on a webhook id longer than any real one", async () => {
    store.set(easypostKey, { username: "user_2abc", password: placeholderApiKey });
    const res = await del(easypostKey, `hook_${"x".repeat(101)}`);
    assert.equal(res.status, 400);
    assert.equal(clientCalls.length, 0);
  });

  it("404s when no key is saved", async () => {
    const res = await del(easypostKey, "hook_abc123");
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "No EasyPost key saved for this user" });
    assert.equal(deleteWebhookCalls.length, 0);
  });
});

describe("DELETE /easypost/:key", () => {
  // This route exists so the EasyPost key delete stops going through
  // DELETE /credentials/:key, which carries NO prefix guard: a caller meaning
  // to clear a postage key could name any secret and have it deleted.
  it("deletes the stored EasyPost key", async () => {
    store.set(easypostKey, { username: "user_2abc", password: placeholderApiKey });
    const res = await fetch(`${baseUrl}/easypost/${easypostKey}`, { method: "DELETE" });

    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { success: true, message: "EasyPost key deleted" });
    assert.equal(store.has(easypostKey), false);
  });

  it("refuses a marketplace key and deletes nothing", async () => {
    store.set(marketplaceKey, {
      username: "seller@example.com",
      token: "placeholder-token",
      refreshToken: "placeholder-refresh",
    });
    const res = await fetch(`${baseUrl}/easypost/${marketplaceKey}`, { method: "DELETE" });

    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "Invalid credential key format" });
    // The live marketplace secret survives, tokens and all.
    assert.deepEqual(store.get(marketplaceKey), {
      username: "seller@example.com",
      token: "placeholder-token",
      refreshToken: "placeholder-refresh",
    });
  });

  it("refuses a malformed key", async () => {
    const res = await fetch(
      `${baseUrl}/easypost/easypost-credentials-bad%20user`,
      { method: "DELETE" },
    );
    assert.equal(res.status, 400);
  });

  // The real Secret Manager store swallows NOT_FOUND, so clearing twice is a
  // 200 both times. Convex calls this on a path that may already have run.
  it("is idempotent — clearing an absent key succeeds", async () => {
    const res = await fetch(`${baseUrl}/easypost/${easypostKey}`, { method: "DELETE" });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { success: true, message: "EasyPost key deleted" });
  });

  it("answers a store failure with a fixed string, not the error", async () => {
    store.set(easypostKey, { username: "user_2abc", password: placeholderApiKey });
    manager.failNextWrite = true;
    const res = await fetch(`${baseUrl}/easypost/${easypostKey}`, { method: "DELETE" });

    // 500, NOT 502: no EasyPost call happens on this route, so a store failure
    // must not be reported as "EasyPost request failed".
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: "Failed to delete EasyPost key" });
    // Nothing was deleted.
    assert.equal(store.has(easypostKey), true);
  });
});
