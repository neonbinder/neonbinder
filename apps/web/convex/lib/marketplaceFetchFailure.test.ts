/**
 * NEO-321 follow-up — the pure half of the per-side fetch diagnostics: the
 * scrubber every logged adapter message goes through, and the fallback that
 * reads a failure class off a message when no structured `failure` arrived.
 */

import { describe, expect, test } from "vitest";
import {
  LOG_MESSAGE_MAX,
  failureFromMessage,
  isAbortTimeout,
  scrubLogText,
} from "./marketplaceFetchFailure";

describe("scrubLogText — nothing secret or addressable reaches a log", () => {
  test("a URL is dropped whole, query and all", () => {
    const out = scrubLogText(
      "SportLots request timed out after 30s: https://www.sportlots.com/inven/dealbin/listcards.tpl?selset=309098&sid=abc123",
    );
    expect(out).toBe("SportLots request timed out after 30s: <url>");
    expect(out).not.toMatch(/sportlots\.com|selset|sid=|abc123/);
  });

  test("bearer tokens, JWTs and key=value secrets are redacted", () => {
    const jwt =
      "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.c2lnbmF0dXJlLXZhbHVlLWhlcmU";
    const out = scrubLogText(
      `Bearer abc.def.ghi failed; id=${jwt}; cookie=PHPSESSID%3Dxyz; token: t0k3n; password=hunter2`,
    )!;
    expect(out).not.toContain("abc.def.ghi");
    expect(out).not.toContain(jwt);
    expect(out).not.toContain("PHPSESSID%3Dxyz");
    expect(out).not.toContain("t0k3n");
    expect(out).not.toContain("hunter2");
    expect(out).toContain("Bearer <redacted>");
  });

  test("a credential-key path and a long opaque run are redacted", () => {
    const out = scrubLogText(
      "Browser service request timed out after 15s: /credentials/buysportscards-credentials-user_2abcDEF/token " +
        "and A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8",
    )!;
    expect(out).toContain("/credentials/<key>/token");
    expect(out).not.toContain("user_2abcDEF");
    expect(out).not.toContain("A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8");
  });

  test("plain operator-safe text is kept; long text is truncated", () => {
    expect(scrubLogText("BSC API error: 503")).toBe("BSC API error: 503");
    expect(scrubLogText("SportLots session expired. Re-authenticate from Profile.")).toBe(
      "SportLots session expired. Re-authenticate from Profile.",
    );
    const long = scrubLogText("word ".repeat(200))!;
    expect(long.length).toBe(LOG_MESSAGE_MAX);
    expect(long.endsWith("…")).toBe(true);
    expect(scrubLogText(undefined)).toBeUndefined();
  });
});

describe("failureFromMessage — the adapters' own wording, classified", () => {
  test.each([
    ["BSC API request timed out after 30s", "timeout", undefined, true],
    ["SportLots error: SportLots request timed out after 30s: <url>", "timeout", undefined, true],
    ["TimeoutError: The operation was aborted due to timeout", "timeout", undefined, true],
    ["BSC API error: 503", "http_error", 503, false],
    ["SportLots HTTP error: 500", "http_error", 500, false],
    ["BSC API 401 and re-auth failed", "signed_out", undefined, false],
    ["SportLots session expired. Re-authenticate from Profile.", "signed_out", undefined, false],
    ["No BSC token available. Connect your BSC account first.", "no_sign_in", undefined, false],
    ["No SportLots session cookie. Re-authenticate from Profile.", "no_sign_in", undefined, false],
    ["BSC API request failed: fetch failed", "network", undefined, false],
    ["Something nobody predicted", "unknown", undefined, false],
  ] as const)("%s → %s", (message, kind, httpStatus, timedOut) => {
    const failure = failureFromMessage(message);
    expect(failure.kind).toBe(kind);
    expect(failure.httpStatus).toBe(httpStatus);
    expect(failure.timedOut).toBe(timedOut);
  });

  test("no message at all is unknown, not a guess", () => {
    expect(failureFromMessage(undefined)).toEqual({ kind: "unknown", timedOut: false });
  });
});

describe("isAbortTimeout", () => {
  test("fetch's abort-timer error, by name or by its message", () => {
    const named = new Error("x");
    named.name = "TimeoutError";
    expect(isAbortTimeout(named)).toBe(true);
    expect(isAbortTimeout(new Error("The operation was aborted due to timeout"))).toBe(true);
    expect(isAbortTimeout(new Error("fetch failed"))).toBe(false);
    expect(isAbortTimeout("TimeoutError")).toBe(false);
  });
});
