/**
 * Route tests for POST /webhooks/ebay/verify (NEO-415).
 *
 * Real cryptography, stubbed eBay: each run generates a P-256 key pair,
 * serves the public half from a fake Notification API `getPublicKey` in the
 * one-line PEM form eBay returns, and signs notification bodies the way eBay
 * does (ECDSA over SHA-1, base64 DER, wrapped in a base64 JSON
 * X-EBAY-SIGNATURE header). Nothing touches the network.
 *
 * SECURITY: the client secret and tokens are placeholders carrying a
 * SENTINEL marker, and every test's console output is scanned for them.
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { generateKeyPairSync, createSign } from "node:crypto";

const require = createRequire(import.meta.url);
const { createEbayOAuthRouter } = require("../dist/routes/ebay-oauth");
const { credentialRateLimitKey } = require("../dist/rate-limit");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CLIENT_ID = "NeonBind-test-SBX-0000000000-00000000";
const CLIENT_SECRET = "SBX-CLIENTSECRET-SENTINEL-0002";
const APP_TOKEN = "v^1.1#i^1#APPTOKEN-SENTINEL-0001";
const APP_TOKEN_2 = "v^1.1#i^1#APPTOKEN-SENTINEL-0002";
const SENTINELS = [CLIENT_SECRET, APP_TOKEN, APP_TOKEN_2, "SENTINEL"];
const KID = "99345d39-2fa4-4a6f-8e1e-0c4b3a7b1c2d";
const KID_2 = "1ab2c3d4-0000-4000-8000-00000000beef";
const T0 = Date.parse("2026-11-01T12:00:00Z");

const SANDBOX_ENV = {
  EBAY_ENVIRONMENT: "sandbox",
  EBAY_CLIENT_ID: CLIENT_ID,
  EBAY_CLIENT_SECRET: CLIENT_SECRET,
  EBAY_RU_NAME: "Neon_Binder-test-runame",
};

/** An account-deletion push, compact as eBay sends it. */
const NOTIFICATION = JSON.stringify({
  metadata: {
    topic: "MARKETPLACE_ACCOUNT_DELETION",
    schemaVersion: "1.0",
    deprecated: false,
  },
  notification: {
    notificationId: "49feeaeb-4982-42d9-a377-9645b8479411_33f7e043-fed8-442b-9d44-791923bd9a6d",
    eventDate: "2026-11-01T11:59:00.000Z",
    publishDate: "2026-11-01T11:59:01.000Z",
    publishAttemptCount: 1,
    data: { username: "deleted_seller", userId: "ma8vp1jySJC", eiasToken: "nY+sHZ2PrBmdj6wVnY+sEZ2PrA2dj6wJnY+gAZGEpwmdj6x9nY+seQ==" },
  },
});

function makeKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  // eBay's getPublicKey returns the PEM on ONE line, markers included.
  const onLine = publicKey.export({ type: "spki", format: "pem" }).replace(/\n/g, "");
  return { privateKey, ebayKeyString: onLine };
}

function sign(privateKey, text) {
  return createSign("sha1").update(Buffer.from(text, "utf8")).sign(privateKey, "base64");
}

function header(fields) {
  return Buffer.from(JSON.stringify(fields), "utf8").toString("base64");
}

function signedHeader(privateKey, text, kid = KID, extra = {}) {
  return header({ alg: "ecdsa", kid, signature: sign(privateKey, text), digest: "SHA1", ...extra });
}

// ---------------------------------------------------------------------------
// Stub eBay
// ---------------------------------------------------------------------------

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const ebay = {
  calls: [],
  keysByKid: new Map(),
  token: null,
  publicKey: null,
  tokenCount: 0,
  reset() {
    this.calls = [];
    this.keysByKid = new Map();
    this.tokenCount = 0;
    this.token = () => {
      this.tokenCount++;
      return json(200, {
        access_token: this.tokenCount === 1 ? APP_TOKEN : APP_TOKEN_2,
        expires_in: 7200,
        token_type: "Application Access Token",
      });
    };
    this.publicKey = (call) => {
      const kid = decodeURIComponent(call.url.split("/public_key/")[1]);
      const key = this.keysByKid.get(kid);
      return key
        ? json(200, { algorithm: "ECDSA", digest: "SHA1", key })
        : json(404, { errors: [{ errorId: 195000 }] });
    };
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
  if (call.url.includes("/commerce/notification/v1/public_key/")) return ebay.publicKey(call);
  return json(404, {});
}

const tokenCalls = () => ebay.calls.filter((c) => c.url.endsWith("/oauth2/token"));
const keyCalls = () => ebay.calls.filter((c) => c.url.includes("/public_key/"));

// ---------------------------------------------------------------------------
// Log capture
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

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

let server;
let baseUrl;
let env;
let clock;
let pair;

before(async () => {
  const express = require("express");
  const app = express();
  app.use(express.json({ limit: "10kb" }));
  app.use(
    createEbayOAuthRouter({
      createStore: () => {
        throw new Error("verify must never touch the credential store");
      },
      fetchImpl: fakeFetch,
      env: () => env,
      now: () => clock,
    }),
  );
  server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  pair = makeKeyPair();
});

after(async () => {
  restoreConsole();
  await new Promise((resolve) => server.close(resolve));
});

// Each test starts two minutes after the last, so no test inherits the
// previous one's uncached-key-fetch budget (5 per rolling minute).
let testSeq = 0;
beforeEach(() => {
  env = { ...SANDBOX_ENV };
  testSeq++;
  clock = T0 + testSeq * 2 * 60 * 1000;
  ebay.reset();
  ebay.keysByKid.set(KID, pair.ebayKeyString);
  logs.length = 0;
  captureConsole();
});

afterEach(() => {
  restoreConsole();
  const text = logs.join("\n");
  for (const s of SENTINELS) assert.ok(!text.includes(s), "log output must not contain credential material");
  assert.ok(!text.includes("deleted_seller"), "the notification body is not logged");
});

async function verify(signatureHeader, body) {
  const res = await fetch(`${baseUrl}/webhooks/ebay/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ signatureHeader, body }),
  });
  const text = await res.text();
  return { status: res.status, text, body: text ? JSON.parse(text) : null };
}

/**
 * The routes are mounted on a fresh router per FILE, so the caches persist
 * across tests; each test that cares about call counts uses its own kid.
 */
let kidSeq = 0;
function freshKid() {
  kidSeq++;
  const kid = `kid-${kidSeq}-${Date.now()}`;
  ebay.keysByKid.set(kid, pair.ebayKeyString);
  return kid;
}

// ---------------------------------------------------------------------------
// Valid signatures
// ---------------------------------------------------------------------------

describe("POST /webhooks/ebay/verify — genuine notifications", () => {
  it("a real ECDSA/SHA-1 signature over the raw body → {valid:true}", async () => {
    const kid = freshKid();
    const res = await verify(signedHeader(pair.privateKey, NOTIFICATION, kid), NOTIFICATION);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { valid: true });

    const [keyCall] = keyCalls();
    assert.equal(
      keyCall.url,
      `https://api.sandbox.ebay.com/commerce/notification/v1/public_key/${kid}`,
    );
    assert.equal(keyCall.method, "GET");
    assert.match(keyCall.authorization, /^Bearer v\^1\.1#i\^1#APPTOKEN-SENTINEL-000[12]$/);
  });

  it("mints the app token with the client-credentials grant and Basic auth", async () => {
    // Force a mint: advance past any token cached by earlier tests.
    clock = T0 + 10 * 24 * 3600 * 1000;
    const kid = freshKid();
    await verify(signedHeader(pair.privateKey, NOTIFICATION, kid), NOTIFICATION);
    const [tokenCall] = tokenCalls();
    assert.equal(tokenCall.url, "https://api.sandbox.ebay.com/identity/v1/oauth2/token");
    assert.equal(
      tokenCall.authorization,
      `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`,
    );
    assert.equal(tokenCall.form.get("grant_type"), "client_credentials");
    assert.equal(tokenCall.form.get("scope"), "https://api.ebay.com/oauth/api_scope");
  });

  it("uses the production host when EBAY_ENVIRONMENT=production", async () => {
    env.EBAY_ENVIRONMENT = "production";
    const kid = freshKid();
    const res = await verify(signedHeader(pair.privateKey, NOTIFICATION, kid), NOTIFICATION);
    assert.deepEqual(res.body, { valid: true });
    assert.ok(keyCalls()[0].url.startsWith("https://api.ebay.com/commerce/notification/v1/public_key/"));
    assert.ok(tokenCalls()[0].url.startsWith("https://api.ebay.com/"));
  });

  it("accepts a header without the optional alg/digest fields (eBay's SDK ignores them)", async () => {
    const kid = freshKid();
    const sig = header({ kid, signature: sign(pair.privateKey, NOTIFICATION) });
    assert.deepEqual((await verify(sig, NOTIFICATION)).body, { valid: true });
  });

  it("verifies eBay's SDK form: a body received with whitespace, signed compact", async () => {
    const kid = freshKid();
    const pretty = JSON.stringify(JSON.parse(NOTIFICATION), null, 2);
    const res = await verify(signedHeader(pair.privateKey, NOTIFICATION, kid), pretty);
    assert.deepEqual(res.body, { valid: true });
  });
});

describe("POST /webhooks/ebay/verify — forgeries and tampering → {valid:false}", () => {
  it("a body changed after signing", async () => {
    const kid = freshKid();
    const tampered = NOTIFICATION.replace("deleted_seller", "victim_seller");
    const res = await verify(signedHeader(pair.privateKey, NOTIFICATION, kid), tampered);
    assert.deepEqual(res.body, { valid: false });
  });

  it("a signature made with a key eBay did not publish", async () => {
    const kid = freshKid();
    const attacker = makeKeyPair();
    const res = await verify(signedHeader(attacker.privateKey, NOTIFICATION, kid), NOTIFICATION);
    assert.deepEqual(res.body, { valid: false });
  });

  it("a kid eBay does not know (404) — and the miss is not cached as a key", async () => {
    const res = await verify(signedHeader(pair.privateKey, NOTIFICATION, "unknown-kid-1"), NOTIFICATION);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { valid: false });
  });

  it("a key eBay labels as a non-ECDSA algorithm", async () => {
    const kid = freshKid();
    ebay.publicKey = () => json(200, { algorithm: "RSA", digest: "SHA1", key: pair.ebayKeyString });
    const res = await verify(signedHeader(pair.privateKey, NOTIFICATION, kid), NOTIFICATION);
    assert.deepEqual(res.body, { valid: false });
  });

  it("a body over the size cap, without calling eBay", async () => {
    const big = JSON.stringify({ pad: "x".repeat(9000) });
    const res = await verify(signedHeader(pair.privateKey, big, freshKid()), big);
    assert.deepEqual(res.body, { valid: false });
    assert.equal(keyCalls().length, 0);
  });

  const malformed = [
    ["an empty header (absent on the request)", ""],
    ["not base64", "%%%not-base64%%%"],
    ["base64 of non-JSON", Buffer.from("hello").toString("base64")],
    ["base64 of a JSON array", header([KID, "sig"])],
    ["no kid", header({ alg: "ecdsa", signature: "MEUCIQ==", digest: "SHA1" })],
    ["a kid with a slash", header({ kid: "../../oauth2/token", signature: "MEUCIQ==" })],
    ["a kid with a query", header({ kid: "abc?x=1", signature: "MEUCIQ==" })],
    ["a 129-char kid", header({ kid: "k".repeat(129), signature: "MEUCIQ==" })],
    ["a non-string kid", header({ kid: 7, signature: "MEUCIQ==" })],
    ["alg rsa", header({ alg: "rsa", kid: KID, signature: "MEUCIQ==", digest: "SHA1" })],
    ["digest SHA256", header({ alg: "ecdsa", kid: KID, signature: "MEUCIQ==", digest: "SHA256" })],
    ["no signature", header({ alg: "ecdsa", kid: KID, digest: "SHA1" })],
    ["a non-base64 signature", header({ kid: KID, signature: "not base64!" })],
    ["an oversized header", "A".repeat(5000)],
  ];
  for (const [name, sig] of malformed) {
    it(`malformed header: ${name} → 200 {valid:false}, eBay never called`, async () => {
      const res = await verify(sig, NOTIFICATION);
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { valid: false });
      assert.equal(ebay.calls.length, 0);
    });
  }

  it("a signature that is not valid DER does not throw", async () => {
    const kid = freshKid();
    const res = await verify(header({ kid, signature: "AAAA" }), NOTIFICATION);
    assert.deepEqual(res.body, { valid: false });
  });
});

// ---------------------------------------------------------------------------
// Caching
// ---------------------------------------------------------------------------

describe("POST /webhooks/ebay/verify — caches", () => {
  it("fetches a kid's key once, and reuses the app token across kids until it expires", async () => {
    clock = T0 + 20 * 24 * 3600 * 1000; // past any token earlier tests cached
    const kidA = freshKid();
    const kidB = freshKid();
    const sigA = signedHeader(pair.privateKey, NOTIFICATION, kidA);
    const sigB = signedHeader(pair.privateKey, NOTIFICATION, kidB);

    assert.deepEqual((await verify(sigA, NOTIFICATION)).body, { valid: true });
    assert.deepEqual((await verify(sigA, NOTIFICATION)).body, { valid: true });
    assert.equal(tokenCalls().length, 1);
    assert.equal(keyCalls().length, 1, "same kid → key served from cache");

    assert.deepEqual((await verify(sigB, NOTIFICATION)).body, { valid: true });
    assert.equal(tokenCalls().length, 1, "app token reused for a new kid");
    assert.equal(keyCalls().length, 2);

    // Past the token's two hours: the next key fetch mints a new one.
    clock += 3 * 3600 * 1000;
    const kidC = freshKid();
    await verify(signedHeader(pair.privateKey, NOTIFICATION, kidC), NOTIFICATION);
    assert.equal(tokenCalls().length, 2);
  });

  it("a 401 from getPublicKey drops the app token and retries once", async () => {
    clock = T0 + 30 * 24 * 3600 * 1000;
    const kid = freshKid();
    let first = true;
    const serve = ebay.publicKey;
    ebay.publicKey = (call) => {
      if (first) {
        first = false;
        return json(401, {});
      }
      return serve(call);
    };
    const res = await verify(signedHeader(pair.privateKey, NOTIFICATION, kid), NOTIFICATION);
    assert.deepEqual(res.body, { valid: true });
    assert.equal(keyCalls().length, 2);
    assert.equal(tokenCalls().length, 2, "a fresh app token for the retry");
  });

  it("a failed key fetch is not cached", async () => {
    const kid = freshKid();
    ebay.publicKey = () => json(503, {});
    assert.equal((await verify(signedHeader(pair.privateKey, NOTIFICATION, kid), NOTIFICATION)).status, 502);
    ebay.reset();
    ebay.keysByKid.set(kid, pair.ebayKeyString);
    const res = await verify(signedHeader(pair.privateKey, NOTIFICATION, kid), NOTIFICATION);
    assert.deepEqual(res.body, { valid: true });
  });
});

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

describe("POST /webhooks/ebay/verify — errors", () => {
  for (const status of [500, 503, 429]) {
    it(`getPublicKey ${status} → 502 ebay_unavailable`, async () => {
      ebay.publicKey = () => json(status, {});
      const res = await verify(signedHeader(pair.privateKey, NOTIFICATION, freshKid()), NOTIFICATION);
      assert.equal(res.status, 502);
      assert.deepEqual(res.body, { error_class: "ebay_unavailable" });
    });
  }

  it("network failure on getPublicKey → 502", async () => {
    ebay.publicKey = () => {
      throw new TypeError("fetch failed");
    };
    const res = await verify(signedHeader(pair.privateKey, NOTIFICATION, freshKid()), NOTIFICATION);
    assert.equal(res.status, 502);
  });

  it("eBay refusing our app credentials (invalid_client) → 502", async () => {
    clock = T0 + 40 * 24 * 3600 * 1000;
    ebay.token = () => json(401, { error: "invalid_client" });
    const res = await verify(signedHeader(pair.privateKey, NOTIFICATION, freshKid()), NOTIFICATION);
    assert.equal(res.status, 502);
    assert.deepEqual(res.body, { error_class: "ebay_unavailable" });
  });

  it("an unparseable key from eBay → 502", async () => {
    ebay.publicKey = () =>
      json(200, { algorithm: "ECDSA", key: "-----BEGIN PUBLIC KEY-----garbage-----END PUBLIC KEY-----" });
    const res = await verify(signedHeader(pair.privateKey, NOTIFICATION, freshKid()), NOTIFICATION);
    assert.equal(res.status, 502);
  });

  it("unconfigured → 503 ebay_not_configured, eBay not called", async () => {
    env = { ...SANDBOX_ENV, EBAY_CLIENT_SECRET: undefined };
    delete env.EBAY_CLIENT_SECRET;
    const res = await verify(signedHeader(pair.privateKey, NOTIFICATION), NOTIFICATION);
    assert.equal(res.status, 503);
    assert.deepEqual(res.body, { error_class: "ebay_not_configured" });
    assert.equal(ebay.calls.length, 0);
  });

  for (const [name, payload] of [
    ["a non-string body", { signatureHeader: "x", body: { a: 1 } }],
    ["a missing signatureHeader", { body: NOTIFICATION }],
  ]) {
    it(`${name} → 400 bad_request (a caller bug)`, async () => {
      const res = await fetch(`${baseUrl}/webhooks/ebay/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { error_class: "bad_request" });
    });
  }
});

describe("POST /webhooks/ebay/verify — kid flood protection (re-audit condition 1)", () => {
  it("a kid eBay does not know is remembered for 10 minutes", async () => {
    clock = T0 + 100 * 24 * 3600 * 1000;
    const kid = `never-issued-${Date.now()}`;
    const sig = signedHeader(pair.privateKey, NOTIFICATION, kid);

    assert.deepEqual((await verify(sig, NOTIFICATION)).body, { valid: false });
    assert.equal(keyCalls().length, 1);

    clock += 9 * 60 * 1000;
    assert.deepEqual((await verify(sig, NOTIFICATION)).body, { valid: false });
    assert.equal(keyCalls().length, 1, "answered from the negative cache");

    clock += 2 * 60 * 1000; // 11 minutes after the first miss
    assert.deepEqual((await verify(sig, NOTIFICATION)).body, { valid: false });
    assert.equal(keyCalls().length, 2, "re-asked eBay once the 10 minutes passed");
  });

  it("a kid eBay later publishes verifies once its negative entry lapses", async () => {
    clock = T0 + 110 * 24 * 3600 * 1000;
    const kid = `late-key-${Date.now()}`;
    const sig = signedHeader(pair.privateKey, NOTIFICATION, kid);
    assert.deepEqual((await verify(sig, NOTIFICATION)).body, { valid: false });
    ebay.keysByKid.set(kid, pair.ebayKeyString);
    clock += 11 * 60 * 1000;
    assert.deepEqual((await verify(sig, NOTIFICATION)).body, { valid: true });
  });

  it("caps uncached key fetches at 5 per minute and answers the 6th as an outage, never valid:false", async () => {
    clock = T0 + 120 * 24 * 3600 * 1000;
    const known = freshKid();
    const knownSig = signedHeader(pair.privateKey, NOTIFICATION, known);
    assert.deepEqual((await verify(knownSig, NOTIFICATION)).body, { valid: true }); // fetch 1

    const negative = `flood-neg-${Date.now()}`;
    const negativeSig = signedHeader(pair.privateKey, NOTIFICATION, negative);
    assert.deepEqual((await verify(negativeSig, NOTIFICATION)).body, { valid: false }); // fetch 2

    for (let i = 0; i < 3; i++) {
      // fetches 3-5: made-up kids, as a flood would send
      const res = await verify(signedHeader(pair.privateKey, NOTIFICATION, `flood-${i}-${Date.now()}`), NOTIFICATION);
      assert.deepEqual(res.body, { valid: false });
    }
    assert.equal(keyCalls().length, 5);

    // 6th uncached kid inside the minute: an outage, so Convex 500s and eBay retries.
    const genuine = freshKid();
    const genuineSig = signedHeader(pair.privateKey, NOTIFICATION, genuine);
    const over = await verify(genuineSig, NOTIFICATION);
    assert.equal(over.status, 502);
    assert.deepEqual(over.body, { error_class: "ebay_unavailable" });

    const overUnknown = await verify(
      signedHeader(pair.privateKey, NOTIFICATION, `flood-x-${Date.now()}`),
      NOTIFICATION,
    );
    assert.equal(overUnknown.status, 502, "an unknown kid over the cap is an outage too, not valid:false");
    assert.equal(keyCalls().length, 5, "nothing over the cap reached eBay");

    // Cached kids, positive and negative, still answer during the cap.
    assert.deepEqual((await verify(knownSig, NOTIFICATION)).body, { valid: true });
    assert.deepEqual((await verify(negativeSig, NOTIFICATION)).body, { valid: false });
    assert.equal(keyCalls().length, 5);

    // A minute on, eBay's retry of the genuine push goes through.
    clock += 61 * 1000;
    assert.deepEqual((await verify(genuineSig, NOTIFICATION)).body, { valid: true });
    assert.equal(keyCalls().length, 6);
  });

  it("the cap is rolling: fetches older than a minute stop counting", async () => {
    clock = T0 + 130 * 24 * 3600 * 1000;
    for (let i = 0; i < 5; i++) {
      await verify(signedHeader(pair.privateKey, NOTIFICATION, freshKid()), NOTIFICATION);
      clock += 10 * 1000; // fetches at +0s, +10s, +20s, +30s, +40s
    }
    // now +50s: all five inside the window
    assert.equal((await verify(signedHeader(pair.privateKey, NOTIFICATION, freshKid()), NOTIFICATION)).status, 502);
    clock += 15 * 1000; // +65s: the +0s fetch has aged out
    const res = await verify(signedHeader(pair.privateKey, NOTIFICATION, freshKid()), NOTIFICATION);
    assert.deepEqual(res.body, { valid: true });
  });
});

describe("POST /webhooks/ebay/verify — logging and rate limiting", () => {
  it("logs one ebay_oauth_call line with the verdict and nothing from the request", async () => {
    const kid = freshKid();
    await verify(signedHeader(pair.privateKey, NOTIFICATION, kid), NOTIFICATION);
    const lines = logs
      .filter((l) => l.startsWith("{"))
      .map((l) => JSON.parse(l))
      .filter((l) => l.msg === "ebay_oauth_call");
    assert.equal(lines.length, 1);
    assert.equal(lines[0].operation, "verify");
    assert.equal(lines[0].valid, true);
    assert.ok(!logs.join("\n").includes(kid), "the kid is not logged");
  });

  it("has a bucket of its own, not the shared IP bucket", () => {
    assert.equal(
      credentialRateLimitKey({ path: "/webhooks/ebay/verify", params: {}, body: {}, ip: "10.0.0.1" }),
      "webhook:ebay",
    );
  });
});
