import { describe, expect, test } from "vitest";
import { isRunClosedError, siteUrlFor } from "./neonbinder.js";

describe("siteUrlFor", () => {
  test("derives the HTTP actions origin", () => {
    expect(siteUrlFor("https://happy-otter-123.convex.cloud")).toBe("https://happy-otter-123.convex.site");
  });
  test("refuses a URL it can't derive from", () => {
    expect(() => siteUrlFor("https://example.com")).toThrow(/convex\.cloud/);
  });
  test("an override must be https, or loopback http", () => {
    expect(siteUrlFor("x", "http://localhost:3211/")).toBe("http://localhost:3211");
    expect(() => siteUrlFor("x", "http://evil.example")).toThrow(/https/);
  });
});

describe("isRunClosedError", () => {
  test("spots the stream refusing more images", () => {
    expect(isRunClosedError(new Error("[CONVEX] Uncaught Error: job is pairing, not collecting"))).toBe(true);
    expect(isRunClosedError(new Error("Upload failed (HTTP 500)."))).toBe(false);
  });
});
