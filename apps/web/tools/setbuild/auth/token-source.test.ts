import { describe, expect, test } from "vitest";
import { fapiOriginFromPublishableKey } from "./clerk-fapi";
import {
  SetbuildAuthError,
  audienceIncludes,
  cachingTokenSource,
  decodeJwtClaims,
  redact,
  tokenIsFresh,
} from "./token-source";
import { fakeJwt, publishableKeyFor } from "./test-helpers";

describe("redact", () => {
  test("replaces every occurrence of each secret", () => {
    expect(redact("a SECRET123 b SECRET123 c tok456789", ["SECRET123", "tok456789"])).toBe(
      "a [redacted] b [redacted] c [redacted]",
    );
  });
  test("ignores empty and very short values", () => {
    expect(redact("abc def", ["", undefined, null, "abc"])).toBe("abc def");
  });
});

describe("decodeJwtClaims", () => {
  test("reads the payload, including non-ASCII", () => {
    const claims = decodeJwtClaims(fakeJwt({ sub: "user_1", name: "Ichirō" }));
    expect(claims).toMatchObject({ sub: "user_1" });
  });
  test("throws a typed error, without the token, on garbage", () => {
    for (const bad of ["", "a.b", "a.%%%.c", `x.${btoa("[1]")}.y`]) {
      let caught: unknown;
      try {
        decodeJwtClaims(bad);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(SetbuildAuthError);
      if (bad) expect((caught as Error).message).not.toContain(bad);
    }
  });
});

describe("audienceIncludes / tokenIsFresh", () => {
  test("string and array audiences", () => {
    expect(audienceIncludes({ aud: "convex" }, "convex")).toBe(true);
    expect(audienceIncludes({ aud: ["x", "convex"] }, "convex")).toBe(true);
    expect(audienceIncludes({ aud: "x" }, "convex")).toBe(false);
    expect(audienceIncludes({}, "convex")).toBe(false);
  });
  test("freshness honours the skew and a missing exp", () => {
    expect(tokenIsFresh({ exp: 100 }, 79_000, 20_000)).toBe(true);
    expect(tokenIsFresh({ exp: 100 }, 80_000, 20_000)).toBe(false);
    expect(tokenIsFresh({}, 0)).toBe(false);
  });
});

describe("cachingTokenSource", () => {
  test("mints once, then serves from cache; forceRefresh and expiry re-mint", async () => {
    let now = 1_000_000;
    const reasons: string[] = [];
    const ts = cachingTokenSource({
      now: () => now,
      describe: () => "fake",
      mint: async (reason) => {
        reasons.push(reason);
        return fakeJwt({ exp: now / 1000 + 60, i: reasons.length });
      },
    });
    const a = await ts.getToken();
    expect(await ts.getToken()).toBe(a);
    await ts.getToken({ forceRefresh: true });
    now += 50_000;
    await ts.getToken();
    expect(reasons).toEqual(["initial", "forced", "expiring"]);
  });
  test("a failed mint is not cached", async () => {
    let fail = true;
    const ts = cachingTokenSource({
      describe: () => "fake",
      mint: async () => {
        if (fail) throw new Error("nope");
        return fakeJwt({ exp: Date.now() / 1000 + 600 });
      },
    });
    await expect(ts.getToken()).rejects.toThrow("nope");
    fail = false;
    await expect(ts.getToken()).resolves.toBeTypeOf("string");
  });
});

describe("fapiOriginFromPublishableKey", () => {
  test("decodes test and live keys", () => {
    expect(fapiOriginFromPublishableKey(publishableKeyFor("foo-bar-1.clerk.accounts.dev"))).toBe(
      "https://foo-bar-1.clerk.accounts.dev",
    );
    expect(fapiOriginFromPublishableKey(`pk_live_${btoa("clerk.example.com$")}`)).toBe(
      "https://clerk.example.com",
    );
  });
  test("refuses anything that is not a publishable key, without echoing it", () => {
    for (const bad of ["sk_test_abcdef", "pk_test_!!", `pk_test_${btoa("not a host$")}`, "nonsense"]) {
      let caught: unknown;
      try {
        fapiOriginFromPublishableKey(bad);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(SetbuildAuthError);
      expect((caught as Error).message).not.toContain(bad);
    }
  });
});
