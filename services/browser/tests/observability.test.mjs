/**
 * Unit tests for the browser service's structured-log helpers (NEO-43).
 *
 * These log lines are the substrate for the production alert policies in
 * neonbinder_terraform: log-based metrics filter on `jsonPayload.msg`,
 * `jsonPayload.success` and `jsonPayload.canary`, and extract `platform` /
 * `error_class` / `challenge_detected` as metric labels. A silent change to
 * any field name or value shape zeroes a metric — Cloud Monitoring raises no
 * error, the series just stops and the alert never fires again. So the shape
 * is pinned here.
 *
 * The security assertion (no page-derived text ever reaches the log line) is
 * the most important test in this file: `snippet` can carry up to 1500 chars
 * of marketplace HTML, and Cloud Logging is a far wider audience than the
 * login response body.
 *
 * Strategy: import the compiled CJS dist via createRequire (matches the other
 * tests) and capture console.log. logBrowserOp/classifyBrowserError are pure
 * apart from that write, so no other mocking is needed.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { logBrowserOp, classifyBrowserError, challengeFlag } = require("../dist/observability");

let captured = [];
const realLog = console.log;

beforeEach(() => {
  captured = [];
  console.log = (...args) => {
    captured.push(args.join(" "));
  };
});

afterEach(() => {
  console.log = realLog;
});

/** Parse the single JSON line logBrowserOp emitted. */
function emitted() {
  assert.equal(captured.length, 1, `expected exactly one log line, got ${captured.length}`);
  return JSON.parse(captured[0]);
}

const BASE = {
  msg: "browser_login_call",
  operation: "login_bsc",
  platform: "bsc",
  duration_ms: 4400,
  success: false,
  status_code: 500,
  canary: false,
};

describe("logBrowserOp — monitoring contract", () => {
  it("emits a single line of valid JSON with the expected field names", () => {
    logBrowserOp({ ...BASE, error_class: "challenge" });
    const line = emitted();
    assert.equal(line.msg, "browser_login_call");
    assert.equal(line.operation, "login_bsc");
    assert.equal(line.platform, "bsc");
    assert.equal(line.duration_ms, 4400);
    assert.equal(line.success, false);
    assert.equal(line.status_code, 500);
    assert.equal(line.error_class, "challenge");
  });

  it("always emits `canary` so the metric label is never an empty string", () => {
    logBrowserOp({ ...BASE, canary: false });
    assert.equal(emitted().canary, false);

    captured = [];
    logBrowserOp({ ...BASE, canary: true });
    assert.equal(emitted().canary, true);
  });

  it("includes challenge_detected: true when the marketplace served a challenge", () => {
    logBrowserOp({ ...BASE, challenge_detected: true });
    assert.equal(emitted().challenge_detected, true);
  });

  it("includes challenge_detected: false when a diagnostic was captured and saw no challenge", () => {
    logBrowserOp({ ...BASE, challenge_detected: false });
    assert.equal(emitted().challenge_detected, false);
  });

  it("OMITS challenge_detected entirely when undefined, so absent != false", () => {
    // "we looked and saw no challenge" and "we never looked" are different
    // findings; the alert policy relies on being able to tell them apart.
    logBrowserOp({ ...BASE, challenge_detected: undefined });
    const line = emitted();
    assert.equal("challenge_detected" in line, false);
  });

  it("SECURITY: never emits page-derived text (snippet / title / url)", () => {
    // Regression guard. The diagnostic's snippet can be 1500 chars of
    // marketplace HTML; only the challengeDetected boolean may cross into
    // Cloud Logging. If someone widens challengeFlag() or spreads a whole
    // diagnostic into the log call, this fails.
    logBrowserOp({
      ...BASE,
      error_class: "challenge",
      challenge_detected: true,
    });
    const line = emitted();
    for (const forbidden of ["snippet", "title", "url", "diagnostic"]) {
      assert.equal(
        forbidden in line,
        false,
        `${forbidden} must never appear in a browser_login_call log line`,
      );
    }
  });

  it("falls back to a plain line instead of throwing when JSON.stringify fails", () => {
    const circular = { ...BASE };
    circular.self = circular;
    assert.doesNotThrow(() => logBrowserOp(circular));
    assert.equal(captured.length, 1);
    assert.match(captured[0], /\[browser_login_call\] bsc login_bsc/);
    assert.match(captured[0], /duration_ms=4400/);
    assert.match(captured[0], /success=false/);
  });
});

describe("classifyBrowserError — closed tag set", () => {
  it("returns undefined for empty input", () => {
    assert.equal(classifyBrowserError(undefined), undefined);
    assert.equal(classifyBrowserError(""), undefined);
  });

  it("maps known failure modes to their stable tags", () => {
    assert.equal(classifyBrowserError("Invalid credential key format"), "bad_key_format");
    assert.equal(classifyBrowserError("Request timed out"), "timeout");
    assert.equal(classifyBrowserError("TimeoutError: aborted due to timeout"), "timeout");
    assert.equal(classifyBrowserError("Invalid credentials supplied"), "invalid_credentials");
    assert.equal(classifyBrowserError("captcha required"), "challenge");
    assert.equal(classifyBrowserError("Out of memory"), "oom");
  });

  it("buckets anything unrecognised as 'other' rather than undefined", () => {
    // "other" is NOT excluded by the failure-burst alert policy, so an
    // unclassifiable error still pages. Fail-open is the safe direction.
    assert.equal(classifyBrowserError("Authentication failed"), "other");
  });

  it("never interpolates the raw error into its return value", () => {
    // BSC's caller-facing error is deliberately generic so the raw Azure B2C
    // message (which can echo the submitted identifier) never leaves the
    // service. error_class must not reintroduce that leak.
    const secretish = "login failed for dev@neonbinder.io with password hunter2";
    const tag = classifyBrowserError(secretish);
    assert.equal(tag.includes("neonbinder.io"), false);
    assert.equal(tag.includes("hunter2"), false);
  });
});

describe("challengeFlag", () => {
  it("returns undefined when no diagnostic was captured", () => {
    assert.equal(challengeFlag(undefined), undefined);
  });

  it("returns the boolean when a diagnostic was captured", () => {
    assert.equal(challengeFlag({ challengeDetected: true }), true);
    assert.equal(challengeFlag({ challengeDetected: false }), false);
  });

  it("coerces a missing/non-boolean challengeDetected to false, never to a truthy string", () => {
    assert.equal(challengeFlag({}), false);
    assert.equal(challengeFlag({ challengeDetected: "yes" }), false);
  });
});
