/**
 * Unit tests for buildLoginDiagnostic — the SECURITY-CRITICAL redaction step
 * that sanitizes login-failure diagnostics before they leave the browser
 * service for the Convex/PostHog layer.
 *
 * Strategy: import the compiled CJS dist via createRequire (matches the other
 * adapter tests). No mocking needed — buildLoginDiagnostic is a pure function.
 *
 * The contract under test:
 *   - The typed account email and password are replaced with [REDACTED].
 *   - `Bearer <token>` strings are stripped.
 *   - Set-Cookie / cookie / JWT / session-cookie patterns are stripped.
 *   - The snippet is <= 1500 chars.
 *   - challengeDetected fires for known challenge/blocked/invalid signals.
 *   - Page-read failures degrade gracefully (caller passes partial input).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { buildLoginDiagnostic } = require("../dist/services/login-diagnostic");

const EMAIL = "dev@neonbinder.io";
const PASSWORD = "sup3r-s3cret-pw!";
const BEARER_TOKEN = "eyJhbGciOiJ.someheader.SIGNATUREvalue1234";

describe("buildLoginDiagnostic redaction", () => {
  it("redacts the typed email and password from the snippet", () => {
    const rawText = [
      "Sign in to BuySportsCards",
      `Email: ${EMAIL}`,
      `Password: ${PASSWORD}`,
      "Welcome back!",
    ].join("\n");

    const diag = buildLoginDiagnostic(
      { url: "https://www.buysportscards.com", title: "Sign In", rawText },
      { email: EMAIL, password: PASSWORD },
    );

    assert.ok(diag.snippet, "snippet should be present");
    assert.ok(diag.snippet.includes("[REDACTED]"), "snippet should contain [REDACTED]");
    assert.ok(!diag.snippet.includes(EMAIL), "email must NOT appear");
    assert.ok(!diag.snippet.includes(PASSWORD), "password must NOT appear");
  });

  it("strips Bearer token strings", () => {
    const rawText = `redux state: {"secret":"Bearer ${BEARER_TOKEN}"} more text`;
    const diag = buildLoginDiagnostic(
      { rawText },
      { email: EMAIL, password: PASSWORD },
    );
    assert.ok(!diag.snippet.includes(BEARER_TOKEN), "Bearer token value must NOT appear");
    assert.ok(!diag.snippet.includes("eyJhbGciOiJ"), "JWT prefix must NOT appear");
  });

  it("strips Set-Cookie, cookie, and session-cookie patterns", () => {
    const rawText = [
      "Set-Cookie: sl_session=abc123def456; path=/; HttpOnly",
      "Cookie: auth_token=zzz999; csrf=qqq111",
      "sessionId=deadbeefcafe",
    ].join("\n");
    const diag = buildLoginDiagnostic(
      { rawText },
      { email: EMAIL, password: PASSWORD },
    );
    assert.ok(!diag.snippet.includes("abc123def456"), "cookie value must NOT appear");
    assert.ok(!diag.snippet.includes("zzz999"), "auth_token value must NOT appear");
    assert.ok(!diag.snippet.includes("qqq111"), "csrf value must NOT appear");
    assert.ok(!diag.snippet.includes("deadbeefcafe"), "sessionId value must NOT appear");
  });

  it("combined: email + password + Bearer in one page yields none of the secrets", () => {
    const rawText = [
      `Logged in as ${EMAIL}`,
      `You entered password ${PASSWORD}`,
      `Authorization: Bearer ${BEARER_TOKEN}`,
      "Are you human? Please complete the captcha.",
    ].join(" ");

    const diag = buildLoginDiagnostic(
      { url: "https://challenge.example/verify", title: "Attention Required", rawText },
      { email: EMAIL, password: PASSWORD },
    );

    assert.ok(diag.snippet.includes("[REDACTED]"));
    assert.ok(!diag.snippet.includes(EMAIL));
    assert.ok(!diag.snippet.includes(PASSWORD));
    assert.ok(!diag.snippet.includes(BEARER_TOKEN));
    assert.equal(diag.challengeDetected, true, "captcha text should trip challengeDetected");
  });

  it("truncates the snippet to <= 1500 chars", () => {
    const rawText = "x".repeat(5000);
    const diag = buildLoginDiagnostic(
      { rawText },
      { email: EMAIL, password: PASSWORD },
    );
    assert.ok(diag.snippet.length <= 1500, `snippet length was ${diag.snippet.length}`);
  });

  it("detects the SportLots 'Not a valid Email Address' signal", () => {
    const diag = buildLoginDiagnostic(
      { url: "https://www.sportlots.com/cust/custbin/signin.tpl", rawText: "Not a valid Email Address" },
      { email: EMAIL, password: PASSWORD },
    );
    assert.equal(diag.challengeDetected, true);
  });

  it("detects common challenge signals case-insensitively", () => {
    for (const text of [
      "reCAPTCHA",
      "Cloudflare Ray ID",
      "Unusual activity detected",
      "Too Many Requests",
      "rate limit exceeded",
      "Verify you are not a robot",
    ]) {
      const diag = buildLoginDiagnostic({ rawText: text }, {});
      assert.equal(diag.challengeDetected, true, `should detect: ${text}`);
    }
  });

  it("does NOT flag a normal login page as a challenge", () => {
    const diag = buildLoginDiagnostic(
      { rawText: "Sign in. Email. Password. Forgot password?" },
      { email: EMAIL, password: PASSWORD },
    );
    assert.equal(diag.challengeDetected, false);
  });

  it("degrades gracefully when only partial input is available", () => {
    // Simulates the BSC capture helper when page reads partially fail:
    // url present, no title, no rawText.
    const diag = buildLoginDiagnostic(
      { url: "https://www.buysportscards.com" },
      { email: EMAIL, password: PASSWORD },
    );
    assert.equal(diag.url, "https://www.buysportscards.com");
    assert.equal(diag.snippet, undefined);
    assert.equal(diag.challengeDetected, false);
  });

  it("redacts secrets that also appear in the page title", () => {
    const diag = buildLoginDiagnostic(
      { title: `Welcome ${EMAIL}`, rawText: "ok" },
      { email: EMAIL, password: PASSWORD },
    );
    assert.ok(!diag.title.includes(EMAIL), "email must NOT appear in title");
    assert.ok(diag.title.includes("[REDACTED]"));
  });
});
