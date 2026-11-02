/**
 * NEO-287 — the operator switch that pauses a marketplace deployment-wide.
 *
 * `parsePausedPlatforms` is on the hot path of every login and sync (read via
 * `pausedPlatforms()`/`isPlatformPaused()`/`pausedSides()` in
 * `convex/marketplacePause.ts`), so a typo in the operator-set env var must
 * degrade to "nothing paused" plus one log line — never a throw. These tests
 * pin the parse rules directly (the pure half lives in `convex/lib/
 * marketplacePause.ts`) and the query's sorted, signed-in-gated wire shape.
 *
 * Auth on `getPausedPlatforms` (anonymous rejected, signed-in non-admin
 * allowed) is already pinned in `publicFunctionAuth.test.ts` and
 * `publicFunctionAuthGuards.test.ts` — not repeated here.
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import {
  KNOWN_SITES,
  SITE_TO_SIDE,
  isKnownSite,
  parsePausedPlatforms,
  sidesOfSites,
} from "./lib/marketplacePause";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const SIGNED_IN = {
  subject: "user_marketplace_pause_001",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|user_marketplace_pause_001",
};

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.NEONBINDER_PAUSED_PLATFORMS;
});

describe("parsePausedPlatforms", () => {
  test("unset is nothing paused", () => {
    expect(parsePausedPlatforms(undefined)).toEqual(new Set());
  });

  test("empty string is nothing paused", () => {
    expect(parsePausedPlatforms("")).toEqual(new Set());
  });

  test("a single known site", () => {
    expect(parsePausedPlatforms("sportlots")).toEqual(new Set(["sportlots"]));
  });

  test("comma-separated, mixed case and whitespace, both known sites", () => {
    expect(parsePausedPlatforms(" SportLots , buysportscards")).toEqual(
      new Set(["sportlots", "buysportscards"]),
    );
  });

  test("an unknown key is dropped and warned about by name, never thrown", () => {
    expect(() => parsePausedPlatforms("sportlots,carddealerplus")).not.toThrow();
    const result = parsePausedPlatforms("sportlots,carddealerplus");
    expect(result).toEqual(new Set(["sportlots"]));
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('"carddealerplus"'),
    );
  });

  test("empty entries from stray commas are ignored, not treated as unknown", () => {
    const result = parsePausedPlatforms("SPORTLOTS ,");
    expect(result).toEqual(new Set(["sportlots"]));
    expect(console.warn).not.toHaveBeenCalled();
  });
});

describe("isKnownSite", () => {
  test("recognises exactly the three credential site keys", () => {
    expect(isKnownSite("sportlots")).toBe(true);
    expect(isKnownSite("buysportscards")).toBe(true);
    // NEO-415: eBay is a listing platform the operator can pause too.
    expect(isKnownSite("ebay")).toBe(true);
    expect(isKnownSite("mercari")).toBe(false);
    expect(isKnownSite("")).toBe(false);
  });
});

describe("sidesOfSites / SITE_TO_SIDE", () => {
  test("maps each site key to its slot side", () => {
    expect(SITE_TO_SIDE.sportlots).toBe("sportlots");
    expect(SITE_TO_SIDE.buysportscards).toBe("bsc");
    // eBay has no checklist side: pausing it never touches a fetch.
    expect(SITE_TO_SIDE.ebay).toBeUndefined();
  });

  test("sidesOfSites converts a site set to a side set", () => {
    expect(sidesOfSites(new Set(["sportlots"]))).toEqual(new Set(["sportlots"]));
    expect(sidesOfSites(new Set(["buysportscards"]))).toEqual(new Set(["bsc"]));
    expect(
      sidesOfSites(new Set(["sportlots", "buysportscards"] as const)),
    ).toEqual(new Set(["sportlots", "bsc"]));
    expect(sidesOfSites(new Set())).toEqual(new Set());
    expect(sidesOfSites(new Set(["ebay", "sportlots"] as const))).toEqual(new Set(["sportlots"]));
  });
});

describe("KNOWN_SITES", () => {
  test("is exactly the three credential site keys, in a fixed order", () => {
    expect(KNOWN_SITES).toEqual(["buysportscards", "sportlots", "ebay"]);
  });
});

describe("getPausedPlatforms — the wire shape", () => {
  test("nothing paused reads back as an empty, sorted array", async () => {
    const t = convexTest(schema, modules);
    const result = await t
      .withIdentity(SIGNED_IN)
      .query(api.marketplacePause.getPausedPlatforms, {});
    expect(result).toEqual([]);
  });

  test("reflects the env var, sorted regardless of the order it was set in", async () => {
    process.env.NEONBINDER_PAUSED_PLATFORMS = " SportLots , buysportscards";
    const t = convexTest(schema, modules);
    const result = await t
      .withIdentity(SIGNED_IN)
      .query(api.marketplacePause.getPausedPlatforms, {});
    expect(result).toEqual(["buysportscards", "sportlots"]);
  });

  test("an unknown key in the env var never reaches the wire", async () => {
    process.env.NEONBINDER_PAUSED_PLATFORMS = "sportlots,mercari";
    const t = convexTest(schema, modules);
    const result = await t
      .withIdentity(SIGNED_IN)
      .query(api.marketplacePause.getPausedPlatforms, {});
    expect(result).toEqual(["sportlots"]);
  });
});
