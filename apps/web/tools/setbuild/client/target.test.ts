import { describe, expect, test } from "vitest";
import {
  ConfirmMismatch,
  TargetError,
  assertConfirm,
  assertSiteIsTwin,
  canonicalJson,
  confirmPhrase,
  contentDigest,
  parseTarget,
} from "./target";

describe("parseTarget", () => {
  test("a Convex cloud URL yields its .convex.site twin and its host", () => {
    expect(parseTarget("https://happy-otter-123.convex.cloud/")).toEqual({
      convexUrl: "https://happy-otter-123.convex.cloud",
      convexSite: "https://happy-otter-123.convex.site",
      host: "happy-otter-123.convex.cloud",
    });
  });

  test("a local backend serves HTTP actions on the next port", () => {
    expect(parseTarget("http://127.0.0.1:3210")).toEqual({
      convexUrl: "http://127.0.0.1:3210",
      convexSite: "http://127.0.0.1:3211",
      host: "127.0.0.1:3210",
    });
  });

  test("a custom domain needs an explicit site URL", () => {
    expect(() => parseTarget("https://api.example.com")).toThrow(/--convex-site-url/);
    expect(parseTarget("https://api.example.com", { siteUrl: "https://site.example.com/x" }).convexSite).toBe(
      "https://site.example.com",
    );
  });

  test("refuses plain http off-box, a path, and non-URLs", () => {
    expect(() => parseTarget("http://happy-otter-123.convex.cloud")).toThrow(TargetError);
    expect(() => parseTarget("https://happy-otter-123.convex.cloud/api")).toThrow(/origin/);
    expect(() => parseTarget("https://happy-otter-123.convex.cloud/?x=1")).toThrow(/origin/);
    expect(() => parseTarget("happy-otter-123")).toThrow(TargetError);
  });
});

describe("confirm phrase", () => {
  const t = parseTarget("https://happy-otter-123.convex.cloud");
  const D = "0123abcd";

  test("is BUILD <host> <scope> <digest>", () => {
    expect(confirmPhrase(t, " e2e-baseline ", D)).toBe("BUILD happy-otter-123.convex.cloud e2e-baseline 0123abcd");
    expect(confirmPhrase(t, "Baseball/2024/Topps/Topps Chrome", D)).toBe(
      "BUILD happy-otter-123.convex.cloud Baseball/2024/Topps/Topps Chrome 0123abcd",
    );
    expect(() => confirmPhrase(t, "  ", D)).toThrow(TargetError);
    for (const bad of ["", "0123abc", "0123ABCD", "0123abcde", "zzzzzzzz"]) {
      expect(() => confirmPhrase(t, "e2e-baseline", bad), bad).toThrow(/digest/);
    }
  });

  test("assertConfirm accepts only the exact phrase and names the expected one", () => {
    const expected = "BUILD happy-otter-123.convex.cloud e2e-baseline 0123abcd";
    expect(() => assertConfirm(t, "e2e-baseline", D, expected)).not.toThrow();
    for (const given of [
      undefined,
      "",
      `${expected} `,
      expected.toLowerCase(),
      "BUILD happy-otter-123.convex.cloud e2e-baseline",
      "BUILD happy-otter-123.convex.cloud e2e-baseline 0123abce",
      "BUILD other-deploy-9.convex.cloud e2e-baseline 0123abcd",
    ]) {
      let caught: unknown;
      try {
        assertConfirm(t, "e2e-baseline", D, given);
      } catch (e) {
        caught = e;
      }
      expect(caught, String(given)).toBeInstanceOf(ConfirmMismatch);
      expect((caught as ConfirmMismatch).expected).toBe(expected);
      expect((caught as Error).message).toContain(expected);
    }
  });
});

describe("canonicalJson / contentDigest", () => {
  test("key order and undefined members never change the text; array order does", () => {
    const a = { b: 1, a: { d: [3, { y: 2, x: 1 }], c: "s" }, u: undefined };
    const b = { a: { c: "s", d: [3, { x: 1, y: 2 }] }, b: 1 };
    expect(canonicalJson(a)).toBe('{"a":{"c":"s","d":[3,{"x":1,"y":2}]},"b":1}');
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson({ l: [1, 2] })).not.toBe(canonicalJson({ l: [2, 1] }));
    expect(canonicalJson([undefined, null])).toBe("[null,null]");
    expect(canonicalJson({ q: 'a"b' })).toBe(JSON.stringify({ q: 'a"b' }));
  });

  test("the digest is the first 8 hex of SHA-256 over the canonical text", () => {
    // sha256('{"a":1}') = 015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862
    expect(contentDigest({ a: 1 })).toBe("015abd7f");
    expect(contentDigest({ b: 2, a: 1 })).toBe(contentDigest({ a: 1, b: 2 }));
    expect(contentDigest({ a: 1 })).not.toBe(contentDigest({ a: 2 }));
  });
});

describe("assertSiteIsTwin (machine auth's API-key destination)", () => {
  test("the derived .convex.site twin passes", () => {
    expect(() => assertSiteIsTwin(parseTarget("https://happy-otter-123.convex.cloud"))).not.toThrow();
    expect(() =>
      assertSiteIsTwin(parseTarget("https://happy-otter-123.convex.cloud", { siteUrl: "https://happy-otter-123.convex.site/" })),
    ).not.toThrow();
  });

  test("any other site is refused: another deployment, another domain, plain http, a custom domain", () => {
    for (const [convexUrl, siteUrl] of [
      ["https://happy-otter-123.convex.cloud", "https://prod-deploy-1.convex.site"],
      ["https://happy-otter-123.convex.cloud", "https://evil.example.com"],
      ["https://happy-otter-123.convex.cloud", "http://happy-otter-123.convex.site"],
      ["https://happy-otter-123.convex.cloud", "http://127.0.0.1:3211"],
      ["https://api.example.com", "https://site.example.com"],
    ]) {
      expect(() => assertSiteIsTwin(parseTarget(convexUrl, { siteUrl })), `${convexUrl} ${siteUrl}`).toThrow(TargetError);
    }
  });

  test("a local backend with a local site is the one exception", () => {
    expect(() => assertSiteIsTwin(parseTarget("http://127.0.0.1:3210"))).not.toThrow();
    expect(() => assertSiteIsTwin(parseTarget("http://localhost:3210", { siteUrl: "http://localhost:4000" }))).not.toThrow();
    expect(() => assertSiteIsTwin(parseTarget("http://localhost:3210", { siteUrl: "https://evil.example.com" }))).toThrow(
      TargetError,
    );
  });
});
