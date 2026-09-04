/**
 * Unit tests for the rate-limit bucket key (NEO-47, extended in NEO-121).
 *
 * WHY THIS FILE EXISTS AT ALL: `credentialRateLimitKey` had no direct test, and
 * the gap it was carrying was invisible without one. Cloud Run IAM gates this
 * service to the single `neonbinder-convex` service account, so EVERY request
 * arrives from one egress IP — which means the IP fallback is not a per-caller
 * budget, it is ONE global 60/min budget shared by every seller on the
 * platform. A route that silently falls into it has a cross-tenant outage
 * waiting in it, and nothing about the code looks wrong.
 *
 * That is exactly what had happened to `/easypost/:key/*` since NEO-120: the
 * limiter runs as global middleware, before Express matches a route, so
 * `req.params` is empty and the key had to be parsed out of `req.path` — and
 * the parser only knew about `/credentials`. Two sellers buying postage in the
 * same minute could 429 each other off the money path.
 *
 * SECURITY: a credential key (`<site>-credentials-<userId>`) is an identifier,
 * not a secret — it is already in the URL of every request it keys. Nothing
 * here handles or asserts on a real secret value.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { credentialRateLimitKey } = require("../dist/rate-limit.js");

const easypostKey = "easypost-credentials-user_2abc";
const bscKey = "bsc-credentials-user_2abc";

/** The shape express hands the keyGenerator, pre-routing: params is EMPTY. */
function req({ path = "/", body = undefined, ip = "10.0.0.1" } = {}) {
  return { path, params: {}, body, ip };
}

describe("credentialRateLimitKey — /credentials/* (NEO-47, unchanged)", () => {
  for (const path of [
    `/credentials/${bscKey}`,
    `/credentials/${bscKey}/metadata`,
    `/credentials/${bscKey}/token`,
  ]) {
    it(`buckets ${path} by the credential key`, () => {
      assert.equal(credentialRateLimitKey(req({ path })), `cred:${bscKey}`);
    });
  }

  // The one /credentials/* route whose second segment is a ROUTE NAME, not a
  // key. Bucketing by "check" would give every caller of it one shared budget.
  it("does not bucket /credentials/check by the literal 'check'", () => {
    const key = credentialRateLimitKey(req({ path: "/credentials/check" }));
    assert.equal(key.startsWith("cred:"), false);
  });

  it("falls back to body.keys[0] for /credentials/check", () => {
    assert.equal(
      credentialRateLimitKey(req({ path: "/credentials/check", body: { keys: [bscKey] } })),
      `cred:${bscKey}`,
    );
  });

  it("buckets /login/* by body.key", () => {
    assert.equal(
      credentialRateLimitKey(req({ path: "/login/sportlots", body: { key: bscKey } })),
      `cred:${bscKey}`,
    );
  });
});

// ---------------------------------------------------------------------------
// NEO-121 — the fix
// ---------------------------------------------------------------------------

describe("credentialRateLimitKey — /easypost/* (NEO-121 fix)", () => {
  // Every one of these landed in the shared IP bucket before this branch.
  for (const [label, path] of [
    ["the key write", `/easypost/${easypostKey}`],
    ["rate", `/easypost/${easypostKey}/rate`],
    ["buy", `/easypost/${easypostKey}/buy`],
    ["label retrieve", `/easypost/${easypostKey}/label/shp_test`],
    ["tracker retrieve", `/easypost/${easypostKey}/tracker/shp_test`],
    ["webhook list/create", `/easypost/${easypostKey}/webhooks`],
    ["webhook delete", `/easypost/${easypostKey}/webhooks/hook_abc123`],
  ]) {
    it(`buckets ${label} by the seller's key`, () => {
      assert.equal(credentialRateLimitKey(req({ path })), `cred:${easypostKey}`);
    });
  }

  // The property that matters: one seller's traffic cannot consume another's
  // budget. Before the fix both of these returned the same IP bucket.
  it("gives two sellers different buckets", () => {
    const a = credentialRateLimitKey(req({ path: "/easypost/easypost-credentials-user_A/buy" }));
    const b = credentialRateLimitKey(req({ path: "/easypost/easypost-credentials-user_B/buy" }));
    assert.notEqual(a, b);
    assert.equal(a, "cred:easypost-credentials-user_A");
  });

  // Read and write share one bucket per seller, deliberately: the budget
  // bounds one seller's total pressure on their own EasyPost account.
  it("shares one bucket across a seller's read and write routes", () => {
    assert.equal(
      credentialRateLimitKey(req({ path: `/easypost/${easypostKey}/buy` })),
      credentialRateLimitKey(req({ path: `/easypost/${easypostKey}/tracker/shp_test` })),
    );
  });

  // The bucket is derived from the PATH, not req.params — the limiter runs
  // before routing, so params is empty and reading it is how the gap happened.
  it("ignores req.params, which is empty pre-routing", () => {
    const r = req({ path: `/easypost/${easypostKey}/buy` });
    r.params = { key: "some-other-key" };
    // The path wins; nothing depends on params being populated.
    assert.equal(credentialRateLimitKey(r), `cred:${easypostKey}`);
  });

  // An empty key segment is not a real seller key. `keyFromPath` returns
  // undefined for it (the falsy-candidate guard), and with no body fallback
  // either this lands on the IP bucket — the same fallback keyless routes
  // use, not a crash and not a bucket named "cred:".
  it("falls back to the IP bucket for an empty key segment", () => {
    const key = credentialRateLimitKey(req({ path: "/easypost//webhooks" }));
    assert.equal(key.startsWith("cred:"), false);
    assert.ok(key.length > 0);
  });

  // Unlike `/credentials/check` — a fixed route name in the key position that
  // `keyFromPath` explicitly excludes — no `/easypost/*` route has a fixed
  // second segment (see the function's own comment). So a seller's key that
  // happens to look like a route name (or an ordinary caller path that just
  // resembles one) is bucketed by that literal value like any other key,
  // rather than being silently swallowed into a shared bucket the way
  // `/credentials/check` is.
  it("does not special-case an /easypost/* segment that looks like a route name", () => {
    const key = credentialRateLimitKey(req({ path: "/easypost/check/rate" }));
    assert.equal(key, "cred:check");
  });
});

describe("credentialRateLimitKey — keyless requests", () => {
  for (const path of ["/health", "/sites", "/easypost", "/credentials", "/"]) {
    it(`falls back to the IP bucket for ${path}`, () => {
      const key = credentialRateLimitKey(req({ path }));
      assert.equal(key.startsWith("cred:"), false);
      assert.ok(key.length > 0);
    });
  }

  it("does not throw when ip is missing", () => {
    assert.doesNotThrow(() =>
      credentialRateLimitKey({ path: "/health", params: {}, body: undefined, ip: undefined }),
    );
  });

  it("does not throw when path is missing", () => {
    assert.doesNotThrow(() =>
      credentialRateLimitKey({ params: {}, body: undefined, ip: "10.0.0.1" }),
    );
  });

  // An unrelated top-level route must NOT be read as a key-bearing one, or
  // every caller of it would share a bucket named after its second segment.
  it("does not invent a bucket from an unrelated path", () => {
    const key = credentialRateLimitKey(req({ path: "/login/sportlots" }));
    assert.equal(key.startsWith("cred:"), false);
  });
});
