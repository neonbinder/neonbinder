import { describe, expect, it } from "vitest";
import { scrubOAuthParams } from "./scrub-oauth-params";

describe("scrubOAuthParams (NEO-415)", () => {
  it("redacts code and state off a URL, keeping the other params and the hash", () => {
    const url = "https://neonbinder.io/profile/ebay?code=v%5E1.1%23i%5E1&state=abc123&expires_in=299#top";
    expect(scrubOAuthParams({ $current_url: url })).toEqual({
      $current_url: "https://neonbinder.io/profile/ebay?code=<redacted>&state=<redacted>&expires_in=299#top",
    });
  });

  it("finds the URL under any key, nested, as Sentry and PostHog shape it differently", () => {
    const event = {
      request: { url: "https://x.test/profile/ebay?state=n1&code=c1" },
      breadcrumbs: [{ data: { from: "/profile/ebay?code=c1&state=n1", to: "/profile/ebay" } }],
    };
    const out = scrubOAuthParams(event);
    expect(JSON.stringify(out)).not.toMatch(/c1|n1/);
    expect(out.request.url).toBe("https://x.test/profile/ebay?state=<redacted>&code=<redacted>");
    expect(out.breadcrumbs[0].data.to).toBe("/profile/ebay");
  });

  it("the landing's forward to Credentials: the landing address is redacted, the eBay tab's address is kept", () => {
    // /profile/ebay swaps itself for Profile → Credentials with eBay picked;
    // the code rides in location state, never the URL, so the forward's
    // breadcrumb carries it only on the landing side.
    const crumb = { data: { from: "/profile/ebay?code=c1&state=n1", to: "/profile/credentials?platform=ebay" } };
    const out = scrubOAuthParams(crumb);
    expect(out.data.from).toBe("/profile/ebay?code=<redacted>&state=<redacted>");
    expect(out.data.to).toBe("/profile/credentials?platform=ebay");
  });

  it("redacts the percent-encoded form inside another URL's value", () => {
    const out = scrubOAuthParams({ u: "https://a.test/?next=%2Fprofile%2Febay%3Fcode%3Dv%5E1.1%26state%3Dn9%26x%3D1" });
    expect(out.u).toBe("https://a.test/?next=%2Fprofile%2Febay%3Fcode%3D<redacted>%26state%3D<redacted>%26x%3D1");
  });

  it("redacts NEO-422's composite state (nonce, dot, base64url origin) whole, plain or percent-encoded", () => {
    const state = `${"a".repeat(48)}.aHR0cHM6Ly9uZW9uYmluZGVyLWFiYzEyM2RlZi1uZW9uLWJpbmRlci52ZXJjZWwuYXBw`;
    const out = scrubOAuthParams({
      u: `https://x.test/profile/ebay?code=c1&state=${state}&expires_in=299`,
      v: `https://a.test/?next=%2Fprofile%2Febay%3Fstate%3D${state}%26code%3Dc1`,
    });
    expect(JSON.stringify(out)).not.toContain("aHR0c");
    expect(out.u).toBe("https://x.test/profile/ebay?code=<redacted>&state=<redacted>&expires_in=299");
    expect(out.v).toBe("https://a.test/?next=%2Fprofile%2Febay%3Fstate%3D<redacted>%26code%3D<redacted>");
  });

  it("leaves look-alikes and clean payloads alone, and returns them untouched", () => {
    const clean = { u: "https://x.test/profile/ebay", note: "zip code=53703 in the form", n: 1 };
    expect(scrubOAuthParams(clean)).toBe(clean);
    expect(scrubOAuthParams({ u: "/x?barcode=1&statement=2" })).toEqual({ u: "/x?barcode=1&statement=2" });
    expect(scrubOAuthParams(null)).toBeNull();
  });
});
