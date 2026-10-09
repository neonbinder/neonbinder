/**
 * NEO-325 — Sync Sets (`syncSetsAcrossManufacturers`), BSC phase, and BSC
 * NAME TWINS.
 *
 * Two or more BSC sets sharing a name in the year's list are the operator's
 * to reconcile, never the sync's: a twin NO NB row holds by id is left out
 * before routing (no set, no brand row, no Unknown row), a twin an NB row
 * already holds matches that row by id, and the left-out ones come back as
 * `twinsLeft` for the column that asked (a brand, the Unknown row, or the All
 * Brands view). Companion to `platformLevelSupport.test.ts`, whose harness
 * (stubbed BSC aggregation JSON, no adapter mock) this reuses. The brands here
 * carry no SportLots id, so the SportLots phase is skipped and never fetched.
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { __resetContractCache } from "./credentials";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

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
  subject: "admin_user_neo325_sync_sets_twins",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_user_neo325_sync_sets_twins",
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

function stubFetch(handler: FetchStub) {
  vi.stubGlobal("fetch", (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    const href = String(url);
    if (href.endsWith("/health")) {
      return jsonResponse({ status: "ok", environment: "test", contractVersion: 1 });
    }
    return handler(url, init);
  }) as FetchStub);
}

function isTokenUrl(href: string, site: "buysportscards" | "sportlots") {
  return href.includes("/credentials/") && href.includes(site) && href.endsWith("/token");
}

/** Stub BSC's setName aggregation; SportLots must never be contacted. */
function stubBscSets(sets: Array<[string, string]>) {
  stubFetch(async (url) => {
    const href = String(url);
    if (href.includes("sportlots.com") || isTokenUrl(href, "sportlots")) {
      throw new Error(`SportLots must not be contacted: ${href}`);
    }
    if (isTokenUrl(href, "buysportscards")) return jsonResponse({ token: "bsc-stub" });
    if (href.includes("api-prod.buysportscards.com")) {
      return jsonResponse({
        aggregations: {
          setName: sets.map(([slug, label]) => ({
            label,
            slug,
            count: 400,
            active: true,
          })),
        },
      });
    }
    throw new Error(`unexpected fetch: ${href}`);
  });
}

beforeEach(() => {
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

async function seedYear(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => {
    const sportId = await ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Baseball",
      sportConfig: { skuCode: "BB", league: "MLB" },
      platformData: { bsc: { b0: "baseball" }, sportlots: { s0: "BB" } },
      platformSlotSeq: { bsc: 1, sportlots: 1 },
      children: [],
      lastUpdated: Date.now(),
    });
    const yearId = await ctx.db.insert("selectorOptions", {
      level: "year",
      value: "2024",
      platformData: { bsc: { b0: "2024" }, sportlots: { s0: "2024" } },
      platformSlotSeq: { bsc: 1, sportlots: 1 },
      parentId: sportId,
      children: [],
      lastUpdated: Date.now(),
    });
    await ctx.db.patch(sportId, { children: [yearId] });
    return yearId;
  });
}

async function brand(
  t: ReturnType<typeof convexTest>,
  yearId: Id<"selectorOptions">,
  value: string,
  opts: { prefix?: string; isBrandUnknown?: boolean } = {},
) {
  return t.run(async (ctx) =>
    ctx.db.insert("selectorOptions", {
      level: "manufacturer",
      value,
      platformData: {},
      parentId: yearId,
      children: [],
      metadata: {
        ...(opts.prefix !== undefined ? { setNamePrefix: opts.prefix } : {}),
        ...(opts.isBrandUnknown ? { isBrandUnknown: true } : {}),
      },
      lastUpdated: Date.now(),
    }),
  );
}

async function heldSet(
  t: ReturnType<typeof convexTest>,
  brandId: Id<"selectorOptions">,
  value: string,
  bscSlug: string,
) {
  return t.run(async (ctx) =>
    ctx.db.insert("selectorOptions", {
      level: "setName",
      value,
      platformData: { bsc: { b0: bscSlug } },
      platformLabels: { bsc: { b0: "Stale Label" } },
      platformSlotSeq: { bsc: 1 },
      parentId: brandId,
      children: [],
      lastUpdated: Date.now(),
    }),
  );
}

async function allRows(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => ctx.db.query("selectorOptions").collect());
}

const sync = (
  asAdmin: ReturnType<ReturnType<typeof convexTest>["withIdentity"]>,
  yearId: Id<"selectorOptions">,
  manufacturerId?: Id<"selectorOptions">,
) =>
  asAdmin.action(api.selectorOptions.syncSetsAcrossManufacturers, {
    yearId,
    ...(manufacturerId ? { manufacturerId } : {}),
  });

describe("syncSetsAcrossManufacturers — BSC name twins are not filed (NEO-325)", () => {
  test("two unheld BSC sets sharing a name that a brand's prefix claims create no set row", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN);
    const yearId = await seedYear(t);
    await brand(t, yearId, "Topps", { prefix: "Topps" });
    stubBscSets([["tc-1", "Topps Chrome"], ["tc-2", "Topps Chrome"]]);

    const result = await sync(asAdmin, yearId);

    expect(result.success).toBe(true);
    const sets = (await allRows(t)).filter((r) => r.level === "setName");
    expect(sets).toEqual([]);
  });

  test("unheld twins that match no brand mint no Unknown row and no brand row", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN);
    const yearId = await seedYear(t);
    await brand(t, yearId, "Topps", { prefix: "Topps" });
    const before = (await allRows(t)).length;
    // "Fleer Ultra" would mint a known-brand row, "Mystery Set" an Unknown row.
    stubBscSets([
      ["fu-1", "Fleer Ultra"],
      ["fu-2", "Fleer Ultra"],
      ["ms-1", "Mystery Set"],
      ["ms-2", "Mystery Set"],
    ]);

    await sync(asAdmin, yearId);

    const rows = await allRows(t);
    expect(rows).toHaveLength(before);
    expect(rows.filter((r) => r.level === "manufacturer").map((r) => r.value)).toEqual([
      "Topps",
    ]);
  });

  test("a twin an NB row holds by id matches that row; its unheld twin is not filed; no second row appears", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN);
    const yearId = await seedYear(t);
    const topps = await brand(t, yearId, "Topps", { prefix: "Topps" });
    const heldId = await heldSet(t, topps, "Topps Chrome", "tc-1");
    stubBscSets([["tc-1", "Topps Chrome"], ["tc-2", "Topps Chrome"]]);

    await sync(asAdmin, yearId);

    const sets = (await allRows(t)).filter((r) => r.level === "setName");
    expect(sets.map((r) => r._id)).toEqual([heldId]);
    expect(sets[0].platformData.bsc).toEqual({ b0: "tc-1" });
    expect(sets[0].value).toBe("Topps Chrome");
    // It was MATCHED by id (the store refreshed the label the marketplace
    // lists), not merely left alone.
    expect(sets[0].platformLabels?.bsc).toEqual({ b0: "Topps Chrome" });
  });

  test("a unique set beside twins is filed under its brand as before", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN);
    const yearId = await seedYear(t);
    const topps = await brand(t, yearId, "Topps", { prefix: "Topps" });
    stubBscSets([
      ["tc-1", "Topps Chrome"],
      ["tc-2", "Topps Chrome"],
      ["ts-1", "Topps Series 1"],
    ]);

    await sync(asAdmin, yearId);

    const sets = (await allRows(t)).filter((r) => r.level === "setName");
    expect(sets.map((r) => [r.value, r.parentId])).toEqual([["Topps Series 1", topps]]);
  });

  test("twins are caught year-wide even when a brand prefix would split them across brands", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN);
    const yearId = await seedYear(t);
    await brand(t, yearId, "Topps", { prefix: "Topps" });
    await brand(t, yearId, "Bowman", { prefix: "Bowman" });
    // Same folded name, listed twice; held by neither brand.
    stubBscSets([["x-1", "Topps Bowman"], ["x-2", "topps bowman"]]);

    await sync(asAdmin, yearId);

    expect((await allRows(t)).filter((r) => r.level === "setName")).toEqual([]);
  });
});

describe("syncSetsAcrossManufacturers — twinsLeft per column (NEO-325)", () => {
  async function seeded() {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN);
    const yearId = await seedYear(t);
    const topps = await brand(t, yearId, "Topps", { prefix: "Topps" });
    const bowman = await brand(t, yearId, "Bowman", { prefix: "Bowman" });
    const unknown = await brand(t, yearId, "Unknown", { isBrandUnknown: true });
    stubBscSets([
      ["t-1", "Topps Chrome"],
      ["t-2", "Topps Chrome"],
      ["b-1", "Bowman Draft"],
      ["b-2", "Bowman Draft"],
      ["u-1", "Mystery Set"],
      ["u-2", "Mystery Set"],
    ]);
    return { t, asAdmin, yearId, topps, bowman, unknown };
  }

  test("a brand's Sets column hears only about its own twins", async () => {
    const { asAdmin, yearId, topps } = await seeded();

    const result = await sync(asAdmin, yearId, topps);

    expect(result.twinsLeftTotal).toBe(1);
    expect(result.twinsLeft).toEqual([
      { name: "Topps Chrome", bsc: ["t-1", "t-2"], sportlots: [] },
    ]);
  });

  test("the Unknown row's column hears about the twins that match no brand", async () => {
    const { asAdmin, yearId, unknown } = await seeded();

    const result = await sync(asAdmin, yearId, unknown);

    expect(result.twinsLeft).toEqual([
      { name: "Mystery Set", bsc: ["u-1", "u-2"], sportlots: [] },
    ]);
    expect(result.twinsLeftTotal).toBe(1);
  });

  test("the All Brands view (no manufacturerId) hears about every twin, sorted by name", async () => {
    const { asAdmin, yearId } = await seeded();

    const result = await sync(asAdmin, yearId);

    expect(result.twinsLeft.map((e) => e.name)).toEqual([
      "Bowman Draft",
      "Mystery Set",
      "Topps Chrome",
    ]);
    expect(result.twinsLeftTotal).toBe(3);
  });

  test("a held twin id is not reported: only the ids no row holds are left", async () => {
    const { t, asAdmin, yearId, topps } = await seeded();
    await heldSet(t, topps, "Topps Chrome", "t-1");

    const result = await sync(asAdmin, yearId, topps);

    expect(result.twinsLeft).toEqual([
      { name: "Topps Chrome", bsc: ["t-2"], sportlots: [] },
    ]);
  });

  test("a sync with no twins reports none", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN);
    const yearId = await seedYear(t);
    await brand(t, yearId, "Topps", { prefix: "Topps" });
    stubBscSets([["ts-1", "Topps Series 1"], ["ts-2", "Topps Series 2"]]);

    const result = await sync(asAdmin, yearId);

    expect(result.twinsLeft).toEqual([]);
    expect(result.twinsLeftTotal).toBe(0);
  });
});
