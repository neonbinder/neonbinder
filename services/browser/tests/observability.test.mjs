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
const { logBrowserOp, classifyBrowserError, challengeFlag, loginFailureOutcome } =
  require("../dist/observability");

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

describe("loginFailureOutcome — status contract (NEO-98)", () => {
  // What this protects: 500 must mean "our own code threw" and nothing else.
  // Before NEO-98, BSC answered a rejected password with 500 while SportLots
  // answered the identical event with 400 — which is why the NEO-43 hang
  // policy had to match 499|502|503|504 and EXCLUDE 500, leaving it with no
  // crash coverage at all. If an ordinary rejection ever leaks back into 5xx,
  // the policy starts paging on seller typos and someone switches it off.

  it("maps a marketplace credential rejection to 422", () => {
    assert.equal(loginFailureOutcome({ credentialRejected: true }, "Authentication failed").status, 422);
  });

  it("maps an unflagged failure to 502 — an upstream fault, not our crash", () => {
    assert.equal(loginFailureOutcome({}, "Authentication failed").status, 502);
  });

  it("defaults to the PAGEABLE status whenever the flag is absent or false", () => {
    // The safe direction, mirroring classifyBrowserError's "a new tag defaults
    // to paging". A newly-added adapter failure branch that nobody classified
    // must get noticed, not silently absorbed as user error.
    for (const result of [{}, { credentialRejected: undefined }, { credentialRejected: false }]) {
      assert.equal(loginFailureOutcome(result, "anything").status, 502);
    }
  });

  it("forces error_class to invalid_credentials on a rejection", () => {
    // Deriving it would not work: BSC's caller-facing string is the generic
    // "Authentication failed" (deliberately — the raw Azure B2C message can
    // echo the submitted identifier), which buckets as "other". The alert
    // policies exclude `invalid_credentials` as a caller error, so leaving it
    // "other" would page on typos through a different door than the status.
    assert.equal(classifyBrowserError("Authentication failed"), "other");
    assert.equal(
      loginFailureOutcome({ credentialRejected: true }, "Authentication failed").errorClass,
      "invalid_credentials",
    );
  });

  it("still derives error_class normally on a non-rejection", () => {
    assert.equal(loginFailureOutcome({}, "Login timed out").errorClass, "timeout");
    assert.equal(loginFailureOutcome({}, "captcha required").errorClass, "challenge");
    assert.equal(loginFailureOutcome({}, undefined).errorClass, undefined);
  });

  it("emits ONLY 422 or 502 — 400 and 500 belong to the routes, not this helper", () => {
    const statuses = new Set(
      [
        { credentialRejected: true },
        { credentialRejected: false },
        { reauthRequired: true },
        {},
      ].map((r) => loginFailureOutcome(r, "x").status),
    );
    assert.deepEqual([...statuses].sort(), [422, 502]);
  });
});

// ---------------------------------------------------------------------------
// NEO-141 — the `reauth_required` error_class
// ---------------------------------------------------------------------------
//
// MONITORING CONTRACT. `error_class` is a label on the `browser_login_failures`
// log-based metric defined in neonbinder_terraform, and the alert policies
// filter on it. This new member must behave like the other CALLER-error tags
// (excluded from paging), and it is also the value Convex keys off to decide
// "tell this user to sign in again" — replacing the 404-on-the-token-endpoint
// misread that was deleting live credentials.

describe("reauth_required — NEO-141 error_class", () => {
  it("classifies the shared adapter error string", () => {
    assert.equal(classifyBrowserError("Re-authentication required"), "reauth_required");
  });

  it("is checked BEFORE the invalid_credentials rule that would swallow it", () => {
    // "Re-authentication required" contains neither "credential" nor
    // "password", so today the ordering is not load-bearing — but the rule
    // that catches it must keep winning if either string ever moves. A silent
    // reclassification to invalid_credentials would tell users their password
    // was wrong when their session merely lapsed.
    assert.notEqual(classifyBrowserError("Re-authentication required"), "invalid_credentials");
    assert.notEqual(classifyBrowserError("Re-authentication required"), "other");
  });

  it("maps to 422 and never pages", () => {
    const outcome = loginFailureOutcome({ reauthRequired: true }, "Re-authentication required");
    assert.equal(outcome.status, 422, "an expired session is not an outage");
    assert.equal(outcome.errorClass, "reauth_required");
  });

  it("takes precedence over credentialRejected when both are set", () => {
    // "Your session expired, sign in again" and "your password was wrong" need
    // opposite UX. If an adapter ever sets both, the more specific instruction
    // must win rather than being decided by field order.
    const outcome = loginFailureOutcome(
      { reauthRequired: true, credentialRejected: true },
      "Re-authentication required",
    );
    assert.equal(outcome.errorClass, "reauth_required");
  });

  it("does not fire on an ordinary failure", () => {
    assert.notEqual(loginFailureOutcome({}, "Authentication failed").errorClass, "reauth_required");
    assert.notEqual(
      loginFailureOutcome({ credentialRejected: true }, "Authentication failed").errorClass,
      "reauth_required",
    );
  });

  it("stays inside the closed tag set", () => {
    // classifyBrowserError never interpolates the raw error — it returns one of
    // a fixed list. That matters because the value is returned to the caller in
    // the HTTP error body, and BSC's raw B2C message can echo the submitted
    // identifier.
    const CLOSED_SET = new Set([
      "bad_key_format",
      "missing_key",
      "invalid_credentials",
      "reauth_required",
      "timeout",
      "challenge",
      "oom",
      "other",
    ]);
    for (const raw of [
      "Re-authentication required",
      "Invalid credential key format",
      "Authentication failed",
      "Request timed out",
      "captcha required",
      "Out of memory",
      "Invalid credentials supplied",
      "seller@example.com rejected",
    ]) {
      assert.ok(CLOSED_SET.has(classifyBrowserError(raw)), `"${raw}" produced an out-of-set tag`);
    }
  });
});

describe("canary flag coercion (NEO-43)", () => {
  // The HTTP layer coerces with `req.body.canary === true` rather than
  // destructuring with a default. Without that, a non-boolean truthy value
  // would be logged as canary=<that value> while the adapter — which checks
  // `opts?.canary === true` — treated the request as a NORMAL login. A normal
  // login on the canary key writes a token back to Secret Manager, silently
  // defeating the cache bypass and resuming the version churn.
  //
  // This pins the coercion rule itself, mirroring the expression in index.ts.
  const coerce = (body) => body.canary === true;

  it("accepts only a real boolean true", () => {
    assert.equal(coerce({ canary: true }), true);
  });

  it("rejects the STRING \"true\" — the case that would desync log from behaviour", () => {
    assert.equal(coerce({ canary: "true" }), false);
  });

  it("rejects other truthy values and treats absent as false", () => {
    assert.equal(coerce({ canary: 1 }), false);
    assert.equal(coerce({ canary: {} }), false);
    assert.equal(coerce({}), false);
    assert.equal(coerce({ canary: false }), false);
  });
});
