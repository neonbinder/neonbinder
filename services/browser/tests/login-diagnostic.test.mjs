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
const SL_URL = "https://www.sportlots.com/cust/custbin/signin.tpl";
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

  it("detects the SportLots 'Not a valid Email Address' signal as a REJECTION, not a challenge", () => {
    // NEO-98 moved this tell out of CHALLENGE_PATTERNS. It is still detected —
    // just under the flag that means what it actually is.
    //
    // Why the split matters: NEO-43 repurposed challengeDetected as an
    // ALERTING discriminator ("the marketplace is blocking us" → page, vs
    // "the seller mistyped" → do nothing). With the typo tell inside the
    // challenge list, an ordinary mistyped email reported "we are being
    // blocked" — the precise inversion of the distinction the flag exists to
    // draw, and it would have paged on seller error.
    const diag = buildLoginDiagnostic(
      { url: "https://www.sportlots.com/cust/custbin/signin.tpl", rawText: "Not a valid Email Address" },
      { email: EMAIL, password: PASSWORD },
    );
    assert.equal(diag.credentialRejectionDetected, true, "must be flagged as a credential rejection");
    assert.equal(diag.challengeDetected, false, "must NOT be reported as a bot challenge");
  });

  it("detects SportLots' real ?message= refusal envelopes (captured live 2026-07-27)", () => {
    // Verbatim from the live endpoint — the entire response is ~115 bytes.
    const bodies = {
      "Not a valid Email Address": `<html><head> </head> <body onload='window.location = "\\?message=Not a valid Email Address";'> </body> </html>`,
      "Invalid email address supplied": `<html><head> </head> <body onload='window.location = "\\?message=Invalid email address supplied";'> </body> </html>`,
    };
    for (const [msg, rawText] of Object.entries(bodies)) {
      const diag = buildLoginDiagnostic({ url: SL_URL, rawText }, { email: EMAIL, password: PASSWORD });
      assert.equal(diag.credentialRejectionDetected, true, `should detect: ${msg}`);
      assert.equal(diag.challengeDetected, false, `should not be a challenge: ${msg}`);
    }
  });

  it("does NOT treat an unrecognised ?message= as a credential rejection", () => {
    // The safe default. An unknown message means SportLots changed something,
    // which should surface as a 502 and page — not be filed as user error.
    const rawText = `<html><head> </head> <body onload='window.location = "\\?message=Scheduled maintenance in progress";'> </body> </html>`;
    const diag = buildLoginDiagnostic({ url: SL_URL, rawText }, { email: EMAIL, password: PASSWORD });
    assert.equal(diag.credentialRejectionDetected, false);
  });

  it("when the envelope is present, ignores rejection words in surrounding boilerplate", () => {
    // Narrowing to the extracted message is what buys this. A maintenance page
    // whose footer says "forgot your password?" must not read as a rejection.
    const rawText =
      `<html><body onload='window.location = "\\?message=Scheduled maintenance in progress";'>` +
      `<footer>Trouble signing in? Incorrect password? Contact support.</footer></body></html>`;
    const diag = buildLoginDiagnostic({ url: SL_URL, rawText }, { email: EMAIL, password: PASSWORD });
    assert.equal(diag.credentialRejectionDetected, false, "the envelope is authoritative, not the boilerplate");
  });

  it("percent-decodes the message before matching", () => {
    const rawText = `<html><body onload='window.location = "\\?message=Invalid%20email%20address%20supplied";'></body></html>`;
    const diag = buildLoginDiagnostic({ url: SL_URL, rawText }, { email: EMAIL, password: PASSWORD });
    assert.equal(diag.credentialRejectionDetected, true);
  });

  it("keeps genuine block signals out of the credential-rejection flag", () => {
    // The other direction of the same split: a Cloudflare interstitial is our
    // problem and must stay pageable, never be excused as a seller typo.
    for (const text of [
      "Attention Required! | Cloudflare",
      "Please complete the CAPTCHA",
      "Unusual activity detected",
    ]) {
      const diag = buildLoginDiagnostic({ rawText: text }, {});
      assert.equal(diag.challengeDetected, true, `${text} should be a challenge`);
      assert.equal(
        diag.credentialRejectionDetected,
        false,
        `${text} must not read as a credential rejection`,
      );
    }
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

// ---------------------------------------------------------------------------
// NEO-141 — the new credential fields must be redactable by exact value
// ---------------------------------------------------------------------------
//
// Exact-value redaction is the only defence that does not require a secret to
// LOOK like a secret. The structural patterns catch Bearer/JWT/cookie shapes,
// but a session token is free to be an opaque string matching none of them —
// and a marketplace is free to echo it back in a page body. DiagnosticSecrets
// grew `token` and `refreshToken` so the adapters can pass what they hold.

describe("buildLoginDiagnostic — token and refreshToken redaction (NEO-141)", () => {
  // Deliberately shapeless: no dots, no "session=" prefix, no Bearer. If these
  // were caught by a structural pattern the test would prove nothing about the
  // exact-value path, so the values match NO pattern in redactSecrets.
  const OPAQUE_TOKEN = "AAAABBBBCCCCDDDD1111";
  const OPAQUE_REFRESH = "ZZZZYYYYXXXXWWWW9999";

  it("redacts an opaque session token echoed back in the page body", () => {
    const diag = buildLoginDiagnostic(
      { rawText: `Your session ${OPAQUE_TOKEN} is no longer valid` },
      { email: EMAIL, password: PASSWORD, token: OPAQUE_TOKEN },
    );
    assert.ok(!diag.snippet.includes(OPAQUE_TOKEN), "the token value must not survive");
    assert.ok(diag.snippet.includes("[REDACTED]"));
  });

  it("redacts an opaque refresh token echoed back in the page body", () => {
    const diag = buildLoginDiagnostic(
      { rawText: `refresh ${OPAQUE_REFRESH} rejected` },
      { email: EMAIL, password: PASSWORD, refreshToken: OPAQUE_REFRESH },
    );
    assert.ok(!diag.snippet.includes(OPAQUE_REFRESH), "the refresh token value must not survive");
  });

  it("sanity: those same values DO survive when not passed as secrets", () => {
    // Proves the two assertions above are exercising exact-value redaction
    // rather than being masked by a structural pattern that would have caught
    // the value anyway.
    const diag = buildLoginDiagnostic(
      { rawText: `Your session ${OPAQUE_TOKEN} is no longer valid` },
      { email: EMAIL, password: PASSWORD },
    );
    assert.ok(
      diag.snippet.includes(OPAQUE_TOKEN),
      "if this fails the redaction tests above prove nothing — pick a more opaque fixture",
    );
  });

  it("redacts a BARE cookie value echoed without its name= prefix", () => {
    // The gap this closes. The SL adapter holds a JOINED cookie string, so
    // exact-value redaction only ever matched that whole string, and the
    // generic cookie pattern only matches a `name=value` shape. A page echoing
    // just the session id — no name attached — escaped both and rode into the
    // snippet, which leaves the service for PostHog.
    //
    // The value is deliberately shapeless (no dots, no "session" prefix, no
    // Bearer), so only the decomposition can catch it.
    const COOKIE = "slsess=QQQQRRRRSSSSTTTT7777; slid=MMMMNNNNOOOOPPPP8888";
    const BARE = "QQQQRRRRSSSSTTTT7777";
    const diag = buildLoginDiagnostic(
      { rawText: `Session ${BARE} was not recognised` },
      { email: EMAIL, password: PASSWORD, token: COOKIE },
    );
    assert.ok(
      !diag.snippet.includes(BARE),
      "a bare echoed cookie value must not survive into the snippet",
    );
    assert.ok(diag.snippet.includes("[REDACTED]"));
  });

  it("does NOT redact trivially short cookie values (snippet stays readable)", () => {
    // Bare values are redacted without their name, so a short one is
    // indistinguishable from ordinary page text. Blanking every "1" would
    // shred the diagnostic while protecting nothing.
    const diag = buildLoginDiagnostic(
      { rawText: "There is 1 problem with your account" },
      { email: EMAIL, password: PASSWORD, token: "debug=1; slsess=LONGENOUGHVALUE123" },
    );
    assert.ok(
      diag.snippet.includes("1 problem"),
      "a 1-char cookie value must not be redacted out of unrelated prose",
    );
  });

  it("redacts a whole SportLots-style cookie string passed as `token`", () => {
    // What the SL adapter actually holds: the joined name=value pairs it
    // persists. Passing the whole string means every pair inside it goes.
    const COOKIE = "slsess=OPAQUEVALUE1; slid=OPAQUEVALUE2";
    const diag = buildLoginDiagnostic(
      { rawText: `Set by ${COOKIE} — session ended` },
      { email: EMAIL, password: PASSWORD, token: COOKIE },
    );
    assert.ok(!diag.snippet.includes("OPAQUEVALUE1"));
    assert.ok(!diag.snippet.includes("OPAQUEVALUE2"));
  });

  it("still works when the new fields are omitted (every pre-existing call site)", () => {
    const diag = buildLoginDiagnostic(
      { rawText: `?message=Not a valid Email Address for ${EMAIL}` },
      { email: EMAIL, password: PASSWORD },
    );
    assert.ok(!diag.snippet.includes(EMAIL));
    assert.equal(diag.credentialRejectionDetected, true, "detection must be unaffected");
  });

  it("does not let a token value mask the challenge signal", () => {
    // Detection runs on the PRE-redaction text, so a token that happened to
    // contain a signal word cannot erase the flag.
    const diag = buildLoginDiagnostic(
      { rawText: "Attention Required! Cloudflare" },
      { email: EMAIL, password: PASSWORD, token: "Attention" },
    );
    assert.equal(diag.challengeDetected, true);
  });
});
