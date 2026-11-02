/**
 * NEO-422 — the eBay OAuth return parser: which origins each RuName's page
 * forwards to, which it refuses, and that eBay's query string reaches
 * /profile/ebay byte for byte.
 *
 * The production page forwards only to production (and its own origin); the
 * sandbox page adds local dev and Vercel hash previews.
 */

import { describe, expect, it } from "vitest";
import {
  EBAY_RETURN_DESTINATION,
  ebayReturnTarget,
  encodeEbayReturnState,
  type EbayReturnMode,
} from "./ebay-oauth-return";

const HERE = "https://www.neonbinder.io";
const NONCE = "9f86d081884c7d659a2feaa0c55ad015";
const MODES: EbayReturnMode[] = ["production", "sandbox"];

/** base64url of `text`, with or without padding. */
function b64url(text: string, pad = false): string {
  const encoded = Buffer.from(text, "utf8").toString("base64url");
  return pad ? encoded + "=".repeat((4 - (encoded.length % 4)) % 4) : encoded;
}

function searchFor(state: string, rest = "&code=v%5E1.1%23abc&expires_in=299"): string {
  return `?state=${state}${rest}`;
}

const PRODUCTION = ["https://www.neonbinder.io", "https://neonbinder.io"];

const SANDBOX_ONLY = [
  "http://localhost",
  "http://localhost:3000",
  "http://localhost:1",
  "http://localhost:65535",
  "http://127.0.0.1",
  "http://127.0.0.1:5173",
  "https://neonbinder-a1b2c3d4e-neon-binder.vercel.app",
  "https://neonbinder-abcdefghi-neon-binder.vercel.app",
  "https://neonbinder-123456789-neon-binder.vercel.app",
];

/** Refused by BOTH pages. */
const REFUSED = [
  "https://neonbinder-abcdefghi-evil-neon-binder.vercel.app",
  "https://neonbinder-git-foo-neon-binder.vercel.app",
  "https://neonbinder-abcdefgh-neon-binder.vercel.app", // 8, not 9
  "https://neonbinder-abcdefghij-neon-binder.vercel.app", // 10
  "https://neonbinder-ABCDEFGHI-neon-binder.vercel.app",
  "http://neonbinder-abcdefghi-neon-binder.vercel.app",
  "https://www.neonbinder.io.evil.com",
  "https://evil.com",
  "https:\\\\evil.com",
  "https://www.neonbinder.io@evil.com",
  "https://www.néonbinder.io",
  "https://www.xn--nonbinder-d4a.io",
  "https://neonbinder-abcdefghi-neon-binder.vercel.app.",
  "https://www.neonbinder.io:443",
  "https://www.neonbinder.io.",
  "https://www.neon\tbinder.io",
  "https://www.neonbinder.io\n",
  "https://www.neon\nbinder.io",
  "\thttps://www.neonbinder.io",
  "javascript:alert(1)",
  "data:text/html,hi",
  "https://www.neonbinder.io/path",
  "https://www.neonbinder.io/",
  "https://www.neonbinder.io?x=1",
  "https://www.neonbinder.io#frag",
  "https://user@www.neonbinder.io",
  "https://user:pw@www.neonbinder.io",
  "http://www.neonbinder.io",
  "https://www.neonbinder.io:8443",
  "HTTPS://WWW.NEONBINDER.IO",
  "https://localhost:3000",
  "http://localhost:0",
  "http://localhost:65536",
  "http://localhost:80",
  "http://localhost.:3000",
  "http://localhost.evil.com",
  "http://127.0.0.2:3000",
  "http://[::1]:3000",
  " https://www.neonbinder.io",
  "",
];

describe("ebayReturnTarget: production page", () => {
  for (const origin of PRODUCTION) {
    it(`forwards to ${origin}`, () => {
      const search = searchFor(`${NONCE}.${b64url(origin)}`);
      expect(ebayReturnTarget(search, HERE, "production")).toEqual({
        ok: true,
        url: `${origin}${EBAY_RETURN_DESTINATION}${search}`,
      });
    });
  }

  for (const origin of SANDBOX_ONLY) {
    it(`refuses the sandbox-only origin ${origin}`, () => {
      const search = searchFor(`${NONCE}.${b64url(origin)}`);
      expect(ebayReturnTarget(search, HERE, "production")).toEqual({ ok: false });
    });
  }

  it("refuses a preview even when served from a different preview", () => {
    const other = "https://neonbinder-zzzzzzzzz-neon-binder.vercel.app";
    const search = searchFor(`${NONCE}.${b64url("https://neonbinder-a1b2c3d4e-neon-binder.vercel.app")}`);
    expect(ebayReturnTarget(search, other, "production")).toEqual({ ok: false });
  });
});

describe("ebayReturnTarget: sandbox page", () => {
  for (const origin of [...PRODUCTION, ...SANDBOX_ONLY]) {
    it(`forwards to ${origin}`, () => {
      const search = searchFor(`${NONCE}.${b64url(origin)}`);
      expect(ebayReturnTarget(search, HERE, "sandbox")).toEqual({
        ok: true,
        url: `${origin}${EBAY_RETURN_DESTINATION}${search}`,
      });
    });
  }
});

describe("ebayReturnTarget: both pages", () => {
  for (const mode of MODES) {
    describe(mode, () => {
      it("a nonce with no dot returns to the page's own origin", () => {
        const search = searchFor(NONCE);
        expect(ebayReturnTarget(search, "http://localhost:3001", mode)).toEqual({
          ok: true,
          url: `http://localhost:3001/profile/ebay${search}`,
        });
      });

      it("always allows the page's own origin, even one off the list", () => {
        const own = "https://staging.example.test";
        const search = searchFor(`${NONCE}.${b64url(own)}`);
        expect(ebayReturnTarget(search, own, mode)).toEqual({ ok: true, url: `${own}/profile/ebay${search}` });
      });

      it("tolerates base64 padding on the origin", () => {
        // "https://www.neonbinder.io" is 25 bytes, so its base64 carries "==".
        const padded = b64url("https://www.neonbinder.io", true);
        expect(padded.endsWith("==")).toBe(true);
        const search = searchFor(`${NONCE}.${padded}`);
        expect(ebayReturnTarget(search, "http://localhost:3000", mode)).toEqual({
          ok: true,
          url: `https://www.neonbinder.io/profile/ebay${search}`,
        });
      });

      it("reads a percent-encoded padding '=' in the state", () => {
        const padded = b64url("https://www.neonbinder.io", true).replace(/=/g, "%3D");
        expect(padded.endsWith("%3D%3D")).toBe(true);
        expect(ebayReturnTarget(searchFor(`${NONCE}.${padded}`), "http://localhost:3000", mode).ok).toBe(true);
      });

      for (const origin of REFUSED) {
        it(`refuses ${JSON.stringify(origin)}`, () => {
          expect(ebayReturnTarget(searchFor(`${NONCE}.${b64url(origin)}`), HERE, mode)).toEqual({ ok: false });
        });
      }

      it("refuses a missing state", () => {
        expect(ebayReturnTarget("?code=abc&expires_in=299", HERE, mode)).toEqual({ ok: false });
      });

      it("refuses an empty state", () => {
        expect(ebayReturnTarget("?state=&code=abc", HERE, mode)).toEqual({ ok: false });
      });

      it("refuses an empty query string", () => {
        expect(ebayReturnTarget("", HERE, mode)).toEqual({ ok: false });
      });

      it("refuses an empty nonce before the dot", () => {
        expect(ebayReturnTarget(searchFor(`.${b64url(HERE)}`), HERE, mode)).toEqual({ ok: false });
      });

      it("refuses an empty origin after the dot", () => {
        expect(ebayReturnTarget(searchFor(`${NONCE}.`), HERE, mode)).toEqual({ ok: false });
      });

      for (const bad of ["!!!", "aGVsbG8*", "a", "aGVsbG8===", "aGV sbG8", "aGVs+bG8", "aGVs/bG8"]) {
        it(`refuses bad base64 ${JSON.stringify(bad)}`, () => {
          expect(ebayReturnTarget(searchFor(`${NONCE}.${bad}`), HERE, mode)).toEqual({ ok: false });
        });
      }

      it("refuses base64 that is not UTF-8", () => {
        const notUtf8 = Buffer.from([0xff, 0xfe, 0xfd]).toString("base64url");
        expect(ebayReturnTarget(searchFor(`${NONCE}.${notUtf8}`), HERE, mode)).toEqual({ ok: false });
      });

      it("splits on the LAST dot: a dotted prefix is all nonce", () => {
        const search = searchFor(`a.b.c.${b64url("https://neonbinder.io")}`);
        expect(ebayReturnTarget(search, HERE, mode)).toEqual({
          ok: true,
          url: `https://neonbinder.io/profile/ebay${search}`,
        });
      });

      it("a trusted origin smuggled before the last dot does not win", () => {
        const search = searchFor(`${NONCE}.${b64url(HERE)}.${b64url("https://evil.com")}`);
        expect(ebayReturnTarget(search, HERE, mode)).toEqual({ ok: false });
      });

      it("keeps '+', '%2F' and every other byte of the code exactly", () => {
        const state = `${NONCE}.${b64url("https://neonbinder.io")}`;
        const search = `?state=${state}&code=v%5E1.1%23i%5E1%23f%5E0%23p%5E3%23r%5E1%23I%5E3%23t%5EUl41Xz+abc%2Fdef%3D%3D&expires_in=299`;
        const result = ebayReturnTarget(search, HERE, mode);
        expect(result).toEqual({ ok: true, url: `https://neonbinder.io/profile/ebay${search}` });
        if (result.ok) expect(result.url.endsWith(search)).toBe(true);
      });

      it("passes eBay's decline params through", () => {
        const search = `?error=access_denied&error_description=User+declined%2C+sorry&state=${NONCE}`;
        expect(ebayReturnTarget(search, HERE, mode)).toEqual({ ok: true, url: `${HERE}/profile/ebay${search}` });
      });

      it("accepts a search string without its leading '?'", () => {
        const query = `state=${NONCE}&code=a+b%2Fc`;
        expect(ebayReturnTarget(query, HERE, mode)).toEqual({ ok: true, url: `${HERE}/profile/ebay?${query}` });
      });
    });
  }

  it("refuses an unknown mode outright", () => {
    const search = searchFor(NONCE);
    expect(ebayReturnTarget(search, HERE, "staging" as EbayReturnMode)).toEqual({ ok: false });
  });
});

describe("encodeEbayReturnState", () => {
  it("round-trips the production origins through the production page", () => {
    for (const origin of PRODUCTION) {
      const state = encodeEbayReturnState(NONCE, origin);
      const search = `?code=xyz&state=${state}`;
      expect(ebayReturnTarget(search, "https://neonbinder.io", "production")).toEqual({
        ok: true,
        url: `${origin}/profile/ebay${search}`,
      });
    }
  });

  for (const origin of [...PRODUCTION, ...SANDBOX_ONLY]) {
    it(`round-trips ${origin} through the sandbox page`, () => {
      const state = encodeEbayReturnState(NONCE, origin);
      expect(state.startsWith(`${NONCE}.`)).toBe(true);
      expect(state).not.toMatch(/[+/=]/);
      const search = `?code=xyz&state=${state}`;
      expect(ebayReturnTarget(search, "http://localhost:9999", "sandbox")).toEqual({
        ok: true,
        url: `${origin}/profile/ebay${search}`,
      });
    });
  }

  it("matches Node's base64url encoding", () => {
    expect(encodeEbayReturnState("n", "https://neonbinder.io")).toBe(`n.${b64url("https://neonbinder.io")}`);
  });

  it("refuses a nonce with a dot", () => {
    expect(() => encodeEbayReturnState("a.b", HERE)).toThrow();
  });

  it("refuses an empty nonce", () => {
    expect(() => encodeEbayReturnState("", HERE)).toThrow();
  });

  it("refuses an origin with a path", () => {
    expect(() => encodeEbayReturnState(NONCE, "https://www.neonbinder.io/profile")).toThrow();
  });

  it("refuses something that is not a URL", () => {
    expect(() => encodeEbayReturnState(NONCE, "neonbinder.io")).toThrow();
  });
});
