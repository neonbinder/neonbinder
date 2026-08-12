/**
 * Unit tests for parseTransientCredentials (NEO-140/NEO-141).
 *
 * This guard sits on the ONLY inbound path a user's marketplace password takes
 * through this service. Two properties matter more than the rest:
 *
 *  1. An EMPTY body must parse as "no credentials", not as an error. That is
 *     the NEO-43 canary's request shape (`{key, canary:true}` and nothing
 *     else), and two live Cloud Scheduler jobs POST it every 30 minutes. A
 *     stricter reading here would take down the login alerting.
 *  2. HALF a pair must be rejected. Silently ignoring a username with no
 *     password would present a caller bug as an inexplicable re-auth loop
 *     against the stored secret, which is a far worse thing to debug than a
 *     400 at the door.
 *
 * SECURITY: values below are placeholders. No test prints a parsed password.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { parseTransientCredentials } = require("../dist/transient-credentials");

describe("parseTransientCredentials — the canary path (no body credentials)", () => {
  it("accepts a canary-shaped body with no credentials at all", () => {
    const result = parseTransientCredentials({ key: "bsc-credentials-canary", canary: true });
    assert.equal(result.ok, true);
    assert.equal(result.credentials, undefined, "absent credentials must mean 'use the stored secret'");
  });

  it("accepts an empty object and a missing body", () => {
    for (const body of [{}, undefined, null]) {
      const result = parseTransientCredentials(body);
      assert.equal(result.ok, true);
      assert.equal(result.credentials, undefined);
    }
  });
});

describe("parseTransientCredentials — a complete pair", () => {
  it("returns both fields when they are non-empty strings", () => {
    const result = parseTransientCredentials({
      key: "bsc-credentials-user1",
      username: "seller@example.com",
      password: "placeholder-value",
    });
    assert.equal(result.ok, true);
    assert.equal(result.credentials.username, "seller@example.com");
    assert.equal(typeof result.credentials.password, "string");
  });

  it("ignores unrelated body fields rather than dragging them along", () => {
    const result = parseTransientCredentials({
      key: "bsc-credentials-user1",
      canary: true,
      username: "seller@example.com",
      password: "placeholder-value",
      extra: { nested: true },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(
      Object.keys(result.credentials).sort(),
      ["password", "username"],
      "only the two credential fields may survive the parse",
    );
  });
});

describe("parseTransientCredentials — rejections", () => {
  it("rejects half a pair in either direction", () => {
    for (const body of [
      { username: "seller@example.com" },
      { password: "placeholder-value" },
    ]) {
      const result = parseTransientCredentials(body);
      assert.equal(result.ok, false, "half a pair is a caller bug, not a fallback");
      assert.match(result.error, /together/);
    }
  });

  it("rejects empty strings — an empty password is not 'no password'", () => {
    // The distinction the `undefined` check above cannot make: a form that
    // submitted a blank field must not silently fall back to the stored
    // secret and appear to work.
    let result = parseTransientCredentials({ username: "seller@example.com", password: "" });
    assert.equal(result.ok, false);
    assert.match(result.error, /password/);

    result = parseTransientCredentials({ username: "", password: "placeholder-value" });
    assert.equal(result.ok, false);
    assert.match(result.error, /username/);
  });

  it("rejects non-string types", () => {
    for (const body of [
      { username: 42, password: "placeholder-value" },
      { username: "seller@example.com", password: { toString: () => "x" } },
      { username: ["a"], password: "placeholder-value" },
      { username: "seller@example.com", password: true },
    ]) {
      assert.equal(parseTransientCredentials(body).ok, false);
    }
  });

  it("rejects a field longer than the 512-character bound", () => {
    // The service must not depend on its caller for input bounds. Convex caps
    // both fields at 256 before it ever calls us, but Cloud Run IAM is the
    // single control standing between this endpoint and the internet, and
    // "the caller validates" stacks all of input safety onto that one control.
    // express.json({limit:"10kb"}) bounds the BODY, not a field.
    const tooLong = "x".repeat(513);

    let result = parseTransientCredentials({ username: tooLong, password: "placeholder-value" });
    assert.equal(result.ok, false);
    assert.equal(result.error, "Invalid field: username");

    result = parseTransientCredentials({ username: "seller@example.com", password: tooLong });
    assert.equal(result.ok, false);
    assert.equal(result.error, "Invalid field: password");
  });

  it("accepts a field exactly at the bound (the check is not off by one)", () => {
    const atLimit = "x".repeat(512);
    const result = parseTransientCredentials({ username: atLimit, password: atLimit });
    assert.equal(result.ok, true);
    assert.equal(result.credentials.username.length, 512);
  });

  it("reuses the existing fixed error strings for an over-long field", () => {
    // Deliberately NOT a distinct "too long" message: that would confirm the
    // length of the submitted value back to the caller, and these strings are
    // already free of anything received.
    const result = parseTransientCredentials({
      username: "seller@example.com",
      password: "y".repeat(10_000),
    });
    assert.equal(result.ok, false);
    assert.ok(!/\d/.test(result.error), "the error must not disclose any length");
    assert.ok(!result.error.includes("y"), "and must not quote the submitted value");
  });

  it("never echoes a submitted value in the error string", () => {
    // The error crosses the wire in a 400 body. It may name the FIELD; it may
    // never quote what was sent.
    const result = parseTransientCredentials({
      username: "seller@example.com",
      password: "",
    });
    assert.equal(result.ok, false);
    assert.ok(
      !result.error.includes("seller@example.com"),
      "a validation error must not reflect a submitted identifier back to the caller",
    );
  });
});
