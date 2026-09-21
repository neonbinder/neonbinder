/**
 * NEO-237 (D6) — `fetchAggregatedOptions` at the manufacturer level ROUTES
 * SportLots' all-brands option to `ensureBrandUnknownRow` instead of storing
 * it as a manufacturer row.
 *
 * Drives the REAL action against a stubbed SportLots brand-list fetch (the
 * `platformLevelSupport.test.ts` harness — `newinven.tpl` HTML, not a mocked
 * adapter module), extending its "manufacturer level" family with the
 * all-brands option present in the upstream list. Pins: the Unknown row is
 * minted carrying the sentinel id and the flag; no row is ever stored named
 * "All Brands"; the sentinel id still appears in the unlink universe
 * (`returnedIds.sportlots`); and the NEO-211 unlink pass keeps EVERY holder —
 * the Unknown row and a via-All-Brands brand alike — because the id is still
 * being returned. Extends `selectorSyncAdditive.test.ts:366`'s bucketed-sync
 * pattern to this specific routing.
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { __resetContractCache } from "./credentials";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";

vi.mock("posthog-node", () => {
  class FakePostHog {
    capture() {
      /* no-op */
    }
    async shutdown() {
      /* no-op */
    }
  }
  return { PostHog: FakePostHog };
});

const modules = (
  import.meta as unknown as {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("./**/*.*s");

const ADMIN = {
  subject: "admin_user_neo237_all_brands",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_user_neo237_all_brands",
  name: "Admin User",
  role: "admin",
};

type FetchStub = (
  url: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function htmlResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/html" },
  });
}

let fetched: string[] = [];

function stubFetch(handler: FetchStub) {
  vi.stubGlobal("fetch", (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    const href = String(url);
    if (href.endsWith("/health")) {
      return jsonResponse({ status: "ok", environment: "test", contractVersion: 1 });
    }
    fetched.push(href);
    return handler(url, init);
  }) as FetchStub);
}

function isTokenUrl(href: string, site: "buysportscards" | "sportlots") {
  return href.includes("/credentials/") && href.includes(site) && href.endsWith("/token");
}

/** SportLots' newinven.tpl body, with the brand (`brd`) select populated. */
function slBrandHtml(brands: Array<[string, string]>): string {
  const opts = brands
    .map(([id, label]) => `<Option value="${id}">${label}</Option>`)
    .join("");
  return `<html><body><form><select name="brd">${opts}</select></form></body></html>`;
}

beforeEach(() => {
  fetched = [];
  process.env.POSTHOG_API_KEY = "test-posthog-key";
  process.env.NEONBINDER_BROWSER_URL = "http://localhost:9999";
  __resetContractCache();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.POSTHOG_API_KEY;
  delete process.env.NEONBINDER_BROWSER_URL;
});

async function seedSportAndYear(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => {
    const sportId = await ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Hockey",
      sportConfig: { skuCode: "HK", league: "NHL" },
      platformData: { bsc: { b0: "hockey" }, sportlots: { s0: "HK" } },
      platformSlotSeq: { bsc: 1, sportlots: 1 },
      children: [],
      lastUpdated: Date.now(),
    });
    const yearId = await ctx.db.insert("selectorOptions", {
      level: "year",
      value: "1997",
      platformData: { bsc: { b0: "1997" }, sportlots: { s0: "1997" } },
      platformSlotSeq: { bsc: 1, sportlots: 1 },
      parentId: sportId,
      children: [],
      lastUpdated: Date.now(),
    });
    await ctx.db.patch(sportId, { children: [yearId] });
    return { sportId, yearId };
  });
}

function stubSlBrandsOnly(brands: Array<[string, string]>) {
  stubFetch(async (url) => {
    const href = String(url);
    if (href.includes("buysportscards")) {
      throw new Error(`BSC must not be contacted at the manufacturer level: ${href}`);
    }
    if (isTokenUrl(href, "sportlots")) {
      return jsonResponse({ token: "SLSESSION=stub", expiresAt: Date.now() + 86_400_000 });
    }
    if (href.includes("newinven.tpl")) {
      return htmlResponse(slBrandHtml(brands));
    }
    throw new Error(`unexpected fetch: ${href}`);
  });
}

describe("fetchAggregatedOptions at manufacturer level routes the All-Brands option (NEO-237 D6)", () => {
  test("mints Unknown carrying the sentinel id + flag, and never stores a row named 'All Brands'", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN);
    const { yearId } = await seedSportAndYear(t);

    stubSlBrandsOnly([
      ["1", "Topps"],
      ["All Brands", "All Brands"],
    ]);

    const result = await asAdmin.action(api.selectorOptions.fetchAggregatedOptions, {
      level: "manufacturer",
      parentId: yearId,
      parentFilters: { sport: "Hockey", year: "1997" },
    });
    expect(result.success).toBe(true);
    expect(result.failedPlatforms).toEqual([]);

    const stored = await t.run(async (ctx) =>
      ctx.db
        .query("selectorOptions")
        .withIndex("by_level_and_parent", (q) =>
          q.eq("level", "manufacturer").eq("parentId", yearId),
        )
        .collect(),
    );
    // Exactly Topps + the minted Unknown row — no row named "All Brands".
    expect(stored.map((r) => r.value).sort()).toEqual(["Topps", "Unknown"]);

    const unknown = stored.find((r) => r.metadata?.isBrandUnknown === true);
    expect(unknown).toBeDefined();
    expect(unknown!.platformData.sportlots?.["s0"]).toBe("All Brands");
  });

  test("returnedIds.sportlots still carries the sentinel — the unlink pass keeps EVERY holder", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN);
    const { yearId } = await seedSportAndYear(t);

    // A via-All-Brands brand created earlier, already holding the sentinel.
    const viaAllBrandsId = await t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "manufacturer",
        value: "Bandai",
        metadata: { setNamePrefix: "Bandai" },
        platformData: { sportlots: { s0: "All Brands" } },
        platformLabels: { sportlots: { s0: "All Brands" } },
        primaryPlatformId: { sportlots: "s0" },
        platformSlotSeq: { sportlots: 1 },
        parentId: yearId,
        children: [],
        lastUpdated: Date.now(),
      }),
    );

    stubSlBrandsOnly([
      ["1", "Topps"],
      ["All Brands", "All Brands"],
    ]);

    const result = await asAdmin.action(api.selectorOptions.fetchAggregatedOptions, {
      level: "manufacturer",
      parentId: yearId,
      parentFilters: { sport: "Hockey", year: "1997" },
    });

    // Nothing was unlinked — every holder (Unknown, minted fresh, and the
    // pre-existing via-All-Brands brand) is still named by the fetch.
    expect(result.unlinked).toEqual([]);

    const bandai = await t.run((ctx) => ctx.db.get(viaAllBrandsId as Id<"selectorOptions">));
    expect(bandai?.platformData.sportlots?.["s0"]).toBe("All Brands");
    expect(bandai?.value).toBe("Bandai"); // untouched, never renamed
  });

  test("if SportLots stops listing the option, every holder is unlinked and reported (invariant 5)", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN);
    const { yearId } = await seedSportAndYear(t);

    const unknownId = await t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "manufacturer",
        value: "Unknown",
        metadata: { isBrandUnknown: true },
        platformData: { sportlots: { s0: "All Brands" } },
        platformLabels: { sportlots: { s0: "All Brands" } },
        primaryPlatformId: { sportlots: "s0" },
        platformSlotSeq: { sportlots: 1 },
        parentId: yearId,
        children: [],
        lastUpdated: Date.now(),
      }),
    );
    const bandaiId = await t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "manufacturer",
        value: "Bandai",
        metadata: { setNamePrefix: "Bandai" },
        platformData: { sportlots: { s0: "All Brands" } },
        platformLabels: { sportlots: { s0: "All Brands" } },
        primaryPlatformId: { sportlots: "s0" },
        platformSlotSeq: { sportlots: 1 },
        parentId: yearId,
        children: [],
        lastUpdated: Date.now(),
      }),
    );

    // Upstream no longer lists the all-brands option at all.
    stubSlBrandsOnly([["1", "Topps"]]);

    const result = await asAdmin.action(api.selectorOptions.fetchAggregatedOptions, {
      level: "manufacturer",
      parentId: yearId,
      parentFilters: { sport: "Hockey", year: "1997" },
    });

    expect(result.unlinked.map((u) => u.side)).toEqual(["sportlots", "sportlots"]);

    const [unknown, bandai] = await t.run(async (ctx) => [
      await ctx.db.get(unknownId as Id<"selectorOptions">),
      await ctx.db.get(bandaiId as Id<"selectorOptions">),
    ]);
    expect(unknown?.platformData.sportlots ?? {}).toEqual({});
    expect(bandai?.platformData.sportlots ?? {}).toEqual({});
    // Neither row was renamed or deleted — only the link was removed.
    expect(unknown?.value).toBe("Unknown");
    expect(bandai?.value).toBe("Bandai");
  });
});
