/**
 * NEO-216 — a marketplace that does not SERVE a level is never reported as one
 * that FAILED.
 *
 * Jason found this on PR #225's preview and it was true in prod: the
 * Manufacturers column showed "BuySportsCards could not be reached, so nothing
 * from BuySportsCards was changed…" after every Sync Manufacturers. BSC was
 * fine. BSC simply has no manufacturer level — NB's Manufacturer rows come from
 * SportLots' brand list, and BSC's sets are bucketed under them afterwards by
 * name prefix — so the adapter answered "no aggregation for this level" and the
 * aggregator filed it under `platformErrors`.
 *
 * These tests drive the REAL aggregator against stubbed marketplace HTTP (the
 * harness from adapterPhase.test.ts) so they pin the behaviour end to end:
 *
 *   1. a non-serving side is not fetched AT ALL — not even its credential
 *      round-trip, which the old late check still paid for;
 *   2. it is absent from `failedPlatforms`, so no notice is raised;
 *   3. it is absent from `coveredSides`, so the NEO-211 unlink pass cannot
 *      detach its links — proved against a live unlink on the OTHER side;
 *   4. a side that serves the level and genuinely errors is still reported
 *      exactly as before.
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
  subject: "admin_user_neo216_001",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_user_neo216_001",
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

/** Every URL the code under test asked for, in order. */
let fetched: string[] = [];

function stubFetch(handler: FetchStub) {
  vi.stubGlobal("fetch", (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    const href = String(url);
    if (href.endsWith("/health")) {
      return jsonResponse({
        status: "ok",
        environment: "test",
        contractVersion: 1,
      });
    }
    fetched.push(href);
    return handler(url, init);
  }) as FetchStub);
}

/**
 * The browser service's credential endpoint, per site.
 *
 * The path carries a per-user secret NAME (`<site>-credentials-<userId>`), not
 * a bare site slug, so a `/credentials/<site>/token` match silently never fires
 * — which reads in a test as "the marketplace was never contacted".
 */
function isTokenUrl(href: string, site: "buysportscards" | "sportlots") {
  return (
    href.includes("/credentials/") &&
    href.includes(site) &&
    href.endsWith("/token")
  );
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
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.POSTHOG_API_KEY;
  delete process.env.NEONBINDER_BROWSER_URL;
});

/** sport → year, both carrying BSC and SportLots ids. */
async function seedSportAndYear(t: ReturnType<typeof convexTest>) {
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
    return { sportId, yearId };
  });
}

// ===========================================================================
// The bug itself: manufacturer level
// ===========================================================================

describe("fetchAggregatedOptions at the manufacturer level (NEO-216)", () => {
  test("BSC is never contacted, never fails, and raises no notice", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN);
    const { yearId } = await seedSportAndYear(t);

    stubFetch(async (url) => {
      const href = String(url);
      // Any BSC traffic at all — including the CREDENTIAL round-trip the old
      // late check still paid for — fails the test.
      if (href.includes("buysportscards")) {
        throw new Error(`BSC must not be contacted at the manufacturer level: ${href}`);
      }
      if (isTokenUrl(href, "sportlots")) {
        return jsonResponse({
          token: "SLSESSION=stub",
          expiresAt: Date.now() + 86_400_000,
        });
      }
      if (href.includes("newinven.tpl")) {
        return htmlResponse(slBrandHtml([["1", "Topps"]]));
      }
      throw new Error(`unexpected fetch: ${href}`);
    });

    const result = await asAdmin.action(
      api.selectorOptions.fetchAggregatedOptions,
      {
        level: "manufacturer",
        parentId: yearId,
        parentFilters: { sport: "Baseball", year: "2024" },
      },
    );

    expect(result.success).toBe(true);
    // The whole ticket in one assertion.
    expect(result.failedPlatforms).toEqual([]);
    // …and no warning suffix either, which is the other place the adapter's
    // "no such level" text used to surface.
    expect(result.message).not.toMatch(/Warnings/);
    expect(result.optionsCount).toBeGreaterThan(0);
    expect(fetched.some((u) => u.includes("buysportscards"))).toBe(false);

    const stored = await t.run(async (ctx) =>
      ctx.db
        .query("selectorOptions")
        .withIndex("by_level_and_parent", (q) =>
          q.eq("level", "manufacturer").eq("parentId", yearId),
        )
        .collect(),
    );
    expect(stored.map((r) => r.value)).toEqual(["Topps"]);
  });

  test("a BSC link on an existing row survives, while a stale SportLots link is unlinked", async () => {
    // The NEO-211 pin. `coveredSides` is the positive evidence that licenses an
    // unlink; BSC must not be in it at a level it does not serve. Proved
    // against a LIVE unlink on the SportLots side in the same run, so a version
    // that simply never unlinks anything cannot pass this.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN);
    const { yearId } = await seedSportAndYear(t);

    const staleId = await t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "manufacturer",
        value: "Upper Deck",
        platformData: { bsc: { b0: "upper-deck" }, sportlots: { s0: "99" } },
        platformSlotSeq: { bsc: 1, sportlots: 1 },
        primaryPlatformId: { bsc: "b0", sportlots: "s0" },
        parentId: yearId,
        children: [],
        lastUpdated: Date.now(),
      }),
    );

    stubFetch(async (url) => {
      const href = String(url);
      if (href.includes("buysportscards")) {
        throw new Error(`BSC must not be contacted: ${href}`);
      }
      if (isTokenUrl(href, "sportlots")) {
        return jsonResponse({
          token: "SLSESSION=stub",
          expiresAt: Date.now() + 86_400_000,
        });
      }
      if (href.includes("newinven.tpl")) {
        // SportLots no longer lists brand 99 (Upper Deck).
        return htmlResponse(slBrandHtml([["1", "Topps"]]));
      }
      throw new Error(`unexpected fetch: ${href}`);
    });

    const result = await asAdmin.action(
      api.selectorOptions.fetchAggregatedOptions,
      {
        level: "manufacturer",
        parentId: yearId,
        parentFilters: { sport: "Baseball", year: "2024" },
      },
    );

    expect(result.failedPlatforms).toEqual([]);
    // SportLots WAS reached and did not list it, so its link is detached and
    // reported — the feature working normally.
    expect(result.unlinked.map((u) => u.side)).toEqual(["sportlots"]);

    const row = await t.run(async (ctx) =>
      ctx.db.get(staleId as Id<"selectorOptions">),
    );
    // The row and its whole BSC mapping are untouched: BSC never spoke, so
    // nothing it did not say can be read as a delisting.
    expect(row!.platformData.bsc).toEqual({ b0: "upper-deck" });
    expect(row!.platformData.sportlots ?? {}).toEqual({});
  });
});

// ===========================================================================
// The control: a side that DOES serve the level and really failed
// ===========================================================================

describe("fetchAggregatedOptions still reports a real outage (NEO-211)", () => {
  test("BSC failing at the year level — which it does serve — is a partial failure", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN);
    const { sportId } = await seedSportAndYear(t);

    stubFetch(async (url) => {
      const href = String(url);
      if (isTokenUrl(href, "buysportscards")) {
        return jsonResponse({ token: "bsc-stub" });
      }
      if (href.includes("api-prod.buysportscards.com")) {
        // A real BSC outage.
        return jsonResponse({ error: "upstream" }, 500);
      }
      if (isTokenUrl(href, "sportlots")) {
        return jsonResponse({
          token: "SLSESSION=stub",
          expiresAt: Date.now() + 86_400_000,
        });
      }
      if (href.includes("newinven.tpl")) {
        return htmlResponse(
          `<html><body><form><select name="yr"><Option value="2024">2024</Option></select></form></body></html>`,
        );
      }
      throw new Error(`unexpected fetch: ${href}`);
    });

    const result = await asAdmin.action(
      api.selectorOptions.fetchAggregatedOptions,
      {
        level: "year",
        parentId: sportId,
        parentFilters: { sport: "Baseball" },
      },
    );

    // Unchanged behaviour: BSC serves `year`, so a BSC failure there is exactly
    // the thing the NEO-211 notice exists to say.
    expect(result.failedPlatforms).toEqual(["bsc"]);
    expect(fetched.some((u) => u.includes("api-prod.buysportscards.com"))).toBe(
      true,
    );
  });
});

// ===========================================================================
// The mirror case: SportLots at a level it does not serve
// ===========================================================================

describe("fetchAggregatedOptions at the variantType level (NEO-216)", () => {
  test("SportLots is never contacted and never reported", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN);
    const { sportId, yearId } = await seedSportAndYear(t);

    const setNameId = await t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "setName",
        value: "Topps",
        platformData: { bsc: { b0: "topps" } },
        platformSlotSeq: { bsc: 1 },
        parentId: yearId,
        children: [],
        lastUpdated: Date.now(),
      }),
    );
    expect(sportId).toBeTruthy();

    stubFetch(async (url) => {
      const href = String(url);
      if (href.includes("sportlots") || href.includes("newinven.tpl")) {
        throw new Error(
          `SportLots must not be contacted at the variantType level: ${href}`,
        );
      }
      if (isTokenUrl(href, "buysportscards")) {
        return jsonResponse({ token: "bsc-stub" });
      }
      if (href.includes("api-prod.buysportscards.com")) {
        // BSC's bulk-upload/filters shape: aggregations keyed by FACET
        // ("variant" is the facet behind NB's variantType level).
        return jsonResponse({
          aggregations: {
            variant: [{ label: "Base", slug: "base", count: 12, active: true }],
          },
        });
      }
      throw new Error(`unexpected fetch: ${href}`);
    });

    const result = await asAdmin.action(
      api.selectorOptions.fetchAggregatedOptions,
      {
        level: "variantType",
        parentId: setNameId as Id<"selectorOptions">,
        parentFilters: { sport: "Baseball", year: "2024", setName: "Topps" },
      },
    );

    expect(result.failedPlatforms).toEqual([]);
    expect(result.success).toBe(true);
    expect(fetched.some((u) => u.includes("sportlots"))).toBe(false);

    const stored = await t.run(async (ctx) =>
      ctx.db
        .query("selectorOptions")
        .withIndex("by_level_and_parent", (q) =>
          q.eq("level", "variantType").eq("parentId", setNameId),
        )
        .collect(),
    );
    expect(stored.map((r) => r.value)).toEqual(["Base"]);
  });
});

// ===========================================================================
// fetchRawOptions: inserts and sub-variants
// ===========================================================================

describe("setReconciliation.fetchRawOptions honours the same table (NEO-216)", () => {
  test("at the parallel level NEITHER platform is contacted or blamed", async () => {
    // Neither marketplace has a sub-variant axis: BSC never had a facet for it
    // and SportLots has no such concept. Before this fix BOTH adapters answered
    // "unsupported level", both landed in `errors`, and ParallelForm rendered
    // "BuySportsCards and SportLots failed, nothing was changed" on a healthy
    // run — the same defect as the Manufacturers column, one level down.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN);
    const { yearId } = await seedSportAndYear(t);

    const insertId = await t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "insert",
        value: "Chrome Refractors",
        platformData: {},
        parentId: yearId,
        children: [],
        lastUpdated: Date.now(),
      }),
    );

    stubFetch(async (url) => {
      throw new Error(`no marketplace call is allowed at the parallel level: ${url}`);
    });

    const result = await asAdmin.action(api.setReconciliation.fetchRawOptions, {
      level: "parallel",
      parentId: insertId as Id<"selectorOptions">,
      parentFilters: { sport: "Baseball", year: "2024" },
    });

    expect(result.success).toBe(true);
    // No error entry means the forms raise no alert and
    // `coveredSidesFromErrors` is never consulted on a store that never happens.
    expect(result.errors).toEqual([]);
    expect(result.bscOptions).toEqual([]);
    expect(result.slOptions).toEqual([]);
    expect(fetched).toEqual([]);
  });
});

// ===========================================================================
// syncSetsAcrossManufacturers: two-sided since NEO-237
// ===========================================================================

/** SportLots' dealsets.tpl body: one radio per set. */
function slSetListHtml(sets: Array<[string, string]>): string {
  return sets
    .map(
      ([id, label], i) =>
        `<input type="radio" Name="selset" Value="${id}"></td> <td>${i + 1}  ${label}</td>`,
    )
    .join("");
}

/** BSC's setName aggregation body. */
function bscSetListJson(sets: Array<[string, string]>) {
  return {
    aggregations: {
      setName: sets.map(([slug, label]) => ({
        label,
        slug,
        count: 400,
        active: true,
      })),
    },
  };
}

async function insertManufacturer(
  t: ReturnType<typeof convexTest>,
  yearId: Id<"selectorOptions">,
  value: string,
  opts: { slId?: string; prefix?: string; isBrandUnknown?: boolean } = {},
) {
  return t.run(async (ctx) =>
    ctx.db.insert("selectorOptions", {
      level: "manufacturer",
      value,
      platformData: opts.slId ? { sportlots: { s0: opts.slId } } : {},
      ...(opts.slId ? { platformSlotSeq: { sportlots: 1 } } : {}),
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

async function setsUnder(
  t: ReturnType<typeof convexTest>,
  parentId: Id<"selectorOptions">,
) {
  return t.run(async (ctx) =>
    ctx.db
      .query("selectorOptions")
      .withIndex("by_level_and_parent", (q) =>
        q.eq("level", "setName").eq("parentId", parentId),
      )
      .collect(),
  );
}

/** The variantType rows under one set — where a SportLots-minted Base lives. */
async function variantsUnder(
  t: ReturnType<typeof convexTest>,
  setId: Id<"selectorOptions">,
) {
  return t.run(async (ctx) =>
    ctx.db
      .query("selectorOptions")
      .withIndex("by_level_and_parent", (q) =>
        q.eq("level", "variantType").eq("parentId", setId),
      )
      .collect(),
  );
}

describe("syncSetsAcrossManufacturers reports each side for what it was (NEO-216, NEO-237)", () => {
  test("BSC failing is reported as bsc alone; with no brand to scope SportLots, SportLots is skipped, not failed", async () => {
    // BSC has no manufacturer axis, so its flat set list is fetched year-wide
    // and filed under NB's manufacturer rows. The SportLots phase is scoped
    // PER BRAND (sport + year + the brand's own SportLots id) — a year with
    // no manufacturer rows has nothing to scope it with, so SportLots is not
    // asked, not failed, and reported as skipped.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN);
    const { yearId } = await seedSportAndYear(t);

    stubFetch(async (url) => {
      const href = String(url);
      if (href.includes("sportlots.com") || isTokenUrl(href, "sportlots")) {
        throw new Error(`SportLots must not be contacted: ${href}`);
      }
      if (isTokenUrl(href, "buysportscards")) {
        return jsonResponse({ token: "bsc-stub" });
      }
      if (href.includes("api-prod.buysportscards.com")) {
        return jsonResponse({ error: "upstream" }, 500);
      }
      throw new Error(`unexpected fetch: ${href}`);
    });

    const result = await asAdmin.action(
      api.selectorOptions.syncSetsAcrossManufacturers,
      { yearId },
    );

    expect(result.success).toBe(false);
    expect(result.failedPlatforms).toEqual(["bsc"]);
    expect(result.skippedSides).toEqual(["sportlots"]);
    expect(result.pausedSides).toEqual([]);
    expect(fetched.some((u) => u.includes("sportlots"))).toBe(false);
  });

  test("a brand with its own SportLots id runs the SportLots phase: BSC sets filed by prefix, SportLots-only names go to the review, and a saved one is a set with a Base carrying the SportLots id", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN);
    const { yearId } = await seedSportAndYear(t);
    const topps = await insertManufacturer(t, yearId, "Topps", {
      slId: "1",
      prefix: "Topps",
    });

    stubFetch(async (url) => {
      const href = String(url);
      if (isTokenUrl(href, "sportlots")) {
        return jsonResponse({
          token: "SLSESSION=stub",
          expiresAt: Date.now() + 86_400_000,
        });
      }
      if (href.includes("dealsets.tpl")) {
        // "Topps Series 1" is the set BSC just filed under Topps (its
        // stripped label re-prefixed with Topps' own prefix equals the NB
        // name, so it is a variant of a known set, not a new one). "Topps
        // Heritage" and "Topps Heritage Minors" are SportLots-only: each is
        // a review entry (NEO-306), and nothing is minted by the sync.
        return htmlResponse(
          slSetListHtml([
            ["501", "Topps Series 1"],
            ["502", "Topps Heritage"],
            ["503", "Topps Heritage Minors"],
          ]),
        );
      }
      if (isTokenUrl(href, "buysportscards")) {
        return jsonResponse({ token: "bsc-stub" });
      }
      if (href.includes("api-prod.buysportscards.com")) {
        return jsonResponse(bscSetListJson([["topps-series-1", "Topps Series 1"]]));
      }
      throw new Error(`unexpected fetch: ${href}`);
    });

    const result = await asAdmin.action(
      api.selectorOptions.syncSetsAcrossManufacturers,
      { yearId },
    );

    expect(result.success).toBe(true);
    expect(result.failedPlatforms).toEqual([]);
    expect(result.skippedSides).toEqual([]);
    // Both marketplaces were asked — the SportLots list through its own
    // brand id, never by name.
    expect(fetched.some((u) => u.includes("dealsets.tpl"))).toBe(true);

    // BSC's set is filed under Topps by prefix; the SportLots-only names
    // wait in Topps' review — the sync mints nothing.
    expect((await setsUnder(t, topps)).map((r) => r.value)).toEqual([
      "Topps Series 1",
    ]);
    expect(await reviewLabels(t, topps)).toEqual([
      "502:Heritage",
      "503:Heritage Minors",
    ]);
    expect(result.message).toContain("2 SportLots sets to sort");
    expect(result.slPendingReview).toBe(2);

    // The operator saves "Heritage" as its own set: it is filed beside BSC's
    // under the brand's prefix + the stripped label.
    const saved = await saveReviewAsSets(t, topps, ["502"]);
    expect(saved.sets).toBe(1);
    expect(saved.remaining).toBe(1);
    const toppsSets = await setsUnder(t, topps);
    expect(toppsSets.map((r) => r.value).sort()).toEqual([
      "Topps Heritage",
      "Topps Series 1",
    ]);
    const series1 = toppsSets.find((r) => r.value === "Topps Series 1")!;
    expect(series1.platformData.bsc).toEqual({ b0: "topps-series-1" });
    expect(series1.platformData.sportlots).toBeUndefined();

    // The set row is NB's (no marketplace ids); the link sits on its Base,
    // exactly where the Base picker would put it.
    const heritage = toppsSets.find((r) => r.value === "Topps Heritage")!;
    expect(heritage.platformData).toEqual({});
    expect(heritage.createdByUserId).toBe(ADMIN.subject);
    const heritageVariants = await variantsUnder(t, heritage._id);
    expect(heritageVariants).toHaveLength(1);
    expect(heritageVariants[0].value).toBe("Base");
    expect(heritageVariants[0].metadata?.isBase).toBe(true);
    expect(heritageVariants[0].platformData.sportlots).toEqual({ s0: "502" });
    expect(heritage.children).toEqual([heritageVariants[0]._id]);

    // No row was minted for a brand NB has not identified: every BSC set
    // matched a brand, so the year has no Unknown row.
    const manufacturers = await t.run(async (ctx) =>
      ctx.db
        .query("selectorOptions")
        .withIndex("by_level_and_parent", (q) =>
          q.eq("level", "manufacturer").eq("parentId", yearId),
        )
        .collect(),
    );
    expect(manufacturers.map((m) => m.value)).toEqual(["Topps"]);
  });

  test("a year with no BSC id still runs the SportLots phase; the BSC skip is a phase skip, not a return", async () => {
    // Before NEO-237 this action returned at the BSC gate, so a year that
    // SportLots serves and BSC does not never had its SportLots-only sets
    // found at all.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN);
    const yearId = await t.run(async (ctx) => {
      const sportId = await ctx.db.insert("selectorOptions", {
        level: "sport",
        value: "Hockey",
        platformData: { sportlots: { s0: "HK" } },
        platformSlotSeq: { sportlots: 1 },
        children: [],
        lastUpdated: Date.now(),
      });
      return ctx.db.insert("selectorOptions", {
        level: "year",
        value: "1997",
        platformData: { sportlots: { s0: "1997" } },
        platformSlotSeq: { sportlots: 1 },
        parentId: sportId,
        children: [],
        lastUpdated: Date.now(),
      });
    });
    const score = await insertManufacturer(t, yearId, "Score", {
      slId: "7",
      prefix: "Score",
    });

    stubFetch(async (url) => {
      const href = String(url);
      if (href.includes("buysportscards")) {
        throw new Error(`BSC must not be contacted on a path with no BSC ids: ${href}`);
      }
      if (isTokenUrl(href, "sportlots")) {
        return jsonResponse({
          token: "SLSESSION=stub",
          expiresAt: Date.now() + 86_400_000,
        });
      }
      if (href.includes("dealsets.tpl")) {
        return htmlResponse(slSetListHtml([["701", "Score Board"]]));
      }
      throw new Error(`unexpected fetch: ${href}`);
    });

    const result = await asAdmin.action(
      api.selectorOptions.syncSetsAcrossManufacturers,
      { yearId, manufacturerId: score },
    );

    expect(result.success).toBe(true);
    expect(result.failedPlatforms).toEqual([]);
    expect(result.skippedSides).toEqual(["bsc"]);
    expect(result.pausedSides).toEqual([]);
    expect(fetched.some((u) => u.includes("buysportscards"))).toBe(false);
    expect(fetched.some((u) => u.includes("dealsets.tpl"))).toBe(true);

    // The SportLots-only name waits in the review; saved, it is a set under
    // the brand's prefix + label.
    expect(await setsUnder(t, score)).toEqual([]);
    expect(await reviewLabels(t, score)).toEqual(["701:Board"]);
    await saveReviewAsSets(t, score);
    const scoreSets = await setsUnder(t, score);
    expect(scoreSets.map((r) => r.value)).toEqual(["Score Board"]);
    const [base] = await variantsUnder(t, scoreSets[0]._id);
    expect(base.value).toBe("Base");
    expect(base.platformData.sportlots).toEqual({ s0: "701" });
  });

  test("brands linked through All Brands share one fetch of the all-brands list, narrowed per brand; Unknown gets the whole list", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN);
    const { yearId } = await seedSportAndYear(t);
    // The Unknown row and a via-All-Brands brand both hold SportLots'
    // all-brands option id in their SportLots slot (NEO-137 M:1).
    const unknown = await insertManufacturer(t, yearId, "Unknown", {
      slId: "All Brands",
      isBrandUnknown: true,
    });
    const bandai = await insertManufacturer(t, yearId, "Bandai", {
      slId: "All Brands",
      prefix: "Bandai",
    });

    stubFetch(async (url) => {
      const href = String(url);
      if (isTokenUrl(href, "sportlots")) {
        return jsonResponse({
          token: "SLSESSION=stub",
          expiresAt: Date.now() + 86_400_000,
        });
      }
      if (href.includes("dealsets.tpl")) {
        return htmlResponse(
          slSetListHtml([
            ["801", "Bandai Carddass"],
            ["802", "Bandaids Promo"],
            ["803", "Roanoke Express ECHL"],
          ]),
        );
      }
      if (isTokenUrl(href, "buysportscards")) {
        return jsonResponse({ token: "bsc-stub" });
      }
      if (href.includes("api-prod.buysportscards.com")) {
        return jsonResponse(bscSetListJson([]));
      }
      throw new Error(`unexpected fetch: ${href}`);
    });

    const result = await asAdmin.action(
      api.selectorOptions.syncSetsAcrossManufacturers,
      { yearId },
    );

    // BSC returned nothing, which this action has always read as a BSC
    // failure; the SportLots phase ran regardless and stored fine.
    expect(result.failedPlatforms).toEqual(["bsc"]);
    expect(result.success).toBe(true);
    // ONE all-brands POST for both holders — not one per brand.
    expect(fetched.filter((u) => u.includes("dealsets.tpl"))).toHaveLength(1);

    // Bandai sees only its prefix's sets, stripped, by whole word: "Bandaids"
    // is not "Bandai " and stays out. Unknown sees the rest, unstripped.
    // Each brand's names wait in its OWN review (one doc per brand).
    expect(await reviewLabels(t, bandai)).toEqual(["801:Carddass"]);
    expect(await reviewLabels(t, unknown)).toEqual([
      "802:Bandaids Promo",
      "803:Roanoke Express ECHL",
    ]);
    expect(result.message).toContain("3 SportLots sets to sort");
    await saveReviewAsSets(t, bandai);
    await saveReviewAsSets(t, unknown);

    // Saved, the set is filed as prefix + label ("Bandai Carddass") with its
    // Base carrying the SportLots id.
    const bandaiSets = await setsUnder(t, bandai);
    expect(bandaiSets.map((r) => r.value)).toEqual(["Bandai Carddass"]);
    const [bandaiBase] = await variantsUnder(t, bandaiSets[0]._id);
    expect(bandaiBase.platformData.sportlots).toEqual({ s0: "801" });
    // Unknown sees the rest of the list, unstripped: what no brand's prefix
    // claims — the same rule the BSC phase files by. No prefix, so the
    // labels stand as the set names.
    const unknownSets = await setsUnder(t, unknown);
    expect(unknownSets.map((r) => r.value).sort()).toEqual([
      "Bandaids Promo",
      "Roanoke Express ECHL",
    ]);
    const unknownSlIds = await Promise.all(
      unknownSets.map(async (row) => {
        const [base] = await variantsUnder(t, row._id);
        return base.platformData.sportlots?.s0;
      }),
    );
    expect(unknownSlIds.sort()).toEqual(["802", "803"]);
  });

  test("a second sync over the same SportLots list offers nothing: the ids on the saved Bases are covered", async () => {
    // Idempotency at the action door. Sync 1 writes the review; the save
    // mints the set + Base; sync 2 reads the SportLots id off that Base
    // (`listBrandSubtreeSlIds`) and `routeSlSets` files the entry as covered.
    // Its longer sibling is a variant of the set that now exists, so the
    // review empties and its doc goes.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN);
    const { yearId } = await seedSportAndYear(t);
    const topps = await insertManufacturer(t, yearId, "Topps", {
      slId: "1",
      prefix: "Topps",
    });

    stubFetch(async (url) => {
      const href = String(url);
      if (isTokenUrl(href, "sportlots")) {
        return jsonResponse({
          token: "SLSESSION=stub",
          expiresAt: Date.now() + 86_400_000,
        });
      }
      if (href.includes("dealsets.tpl")) {
        return htmlResponse(
          slSetListHtml([
            ["502", "Topps Heritage"],
            ["503", "Topps Heritage Minors"],
          ]),
        );
      }
      if (isTokenUrl(href, "buysportscards")) {
        return jsonResponse({ token: "bsc-stub" });
      }
      if (href.includes("api-prod.buysportscards.com")) {
        return jsonResponse(bscSetListJson([["topps-series-1", "Topps Series 1"]]));
      }
      throw new Error(`unexpected fetch: ${href}`);
    });

    const first = await asAdmin.action(
      api.selectorOptions.syncSetsAcrossManufacturers,
      { yearId, manufacturerId: topps },
    );
    expect(first.success).toBe(true);
    expect(first.message).toContain("2 SportLots sets to sort");
    await saveReviewAsSets(t, topps, ["502"]);
    const afterFirst = await t.run(async (ctx) =>
      (await ctx.db.query("selectorOptions").collect()).length,
    );

    const second = await asAdmin.action(
      api.selectorOptions.syncSetsAcrossManufacturers,
      { yearId, manufacturerId: topps },
    );
    expect(second.success).toBe(true);
    expect(second.failedPlatforms).toEqual([]);
    expect(second.message).toContain("0 SportLots sets to sort");
    expect(await reviewLabels(t, topps)).toEqual([]);
    expect(
      await t.run(async (ctx) => ctx.db.query("slSetReviews").collect()),
    ).toEqual([]);
    const afterSecond = await t.run(async (ctx) =>
      (await ctx.db.query("selectorOptions").collect()).length,
    );
    expect(afterSecond).toBe(afterFirst);
    expect((await setsUnder(t, topps)).map((r) => r.value).sort()).toEqual([
      "Topps Heritage",
      "Topps Series 1",
    ]);
  });
});

// ===========================================================================
// NEO-294 — the known-brands list inside Sync Sets
// ===========================================================================

/** A setName row under a manufacturer, with a BSC id and optional stamps. */
async function insertSet(
  t: ReturnType<typeof convexTest>,
  parentId: Id<"selectorOptions">,
  value: string,
  opts: { bscId?: string; setByOperator?: boolean } = {},
) {
  return t.run(async (ctx) => {
    const id = await ctx.db.insert("selectorOptions", {
      level: "setName",
      value,
      platformData: opts.bscId ? { bsc: { b0: opts.bscId } } : {},
      ...(opts.bscId ? { platformSlotSeq: { bsc: 1 } } : {}),
      parentId,
      children: [],
      ...(opts.setByOperator
        ? { metadata: { brandSetByOperator: true } }
        : {}),
      lastUpdated: Date.now(),
    });
    const parent = await ctx.db.get(parentId);
    await ctx.db.patch(parentId, { children: [...(parent?.children ?? []), id] });
    return id;
  });
}

/**
 * NEO-306 — Sync Sets no longer mints SportLots-only sets: it writes them
 * into the brand's review, and the review's save files them. This reads the
 * review and saves the chosen entries (all of them by default) as their own
 * sets — what the operator does by pressing Save with every row at its
 * default. Returns the save's counts.
 */
async function saveReviewAsSets(
  t: ReturnType<typeof convexTest>,
  manufacturerId: Id<"selectorOptions">,
  only?: string[],
) {
  const asAdmin = t.withIdentity(ADMIN);
  const review = await asAdmin.query(api.slSetReview.getSlSetReview, {
    manufacturerId,
  });
  const entries = (review?.entries ?? []).filter(
    (e) => !only || only.includes(e.slId),
  );
  return asAdmin.action(api.slSetReview.applySlSetReview, {
    manufacturerId,
    decisions: entries.map((e) => ({ slId: e.slId })),
  });
}

async function reviewLabels(
  t: ReturnType<typeof convexTest>,
  manufacturerId: Id<"selectorOptions">,
) {
  const review = await t
    .withIdentity(ADMIN)
    .query(api.slSetReview.getSlSetReview, { manufacturerId });
  return (review?.entries ?? []).map((e) => `${e.slId}:${e.label}`);
}

async function manufacturersOf(
  t: ReturnType<typeof convexTest>,
  yearId: Id<"selectorOptions">,
) {
  return t.run(async (ctx) =>
    ctx.db
      .query("selectorOptions")
      .withIndex("by_level_and_parent", (q) =>
        q.eq("level", "manufacturer").eq("parentId", yearId),
      )
      .collect(),
  );
}

describe("syncSetsAcrossManufacturers files a known brand's sets under it (NEO-294)", () => {
  test("a BSC set no brand claims mints its known brand — prefix, SportLots sentinel, the set under it — and a second sync changes nothing", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN);
    const { yearId } = await seedSportAndYear(t);

    stubFetch(async (url) => {
      const href = String(url);
      if (isTokenUrl(href, "sportlots")) {
        return jsonResponse({
          token: "SLSESSION=stub",
          expiresAt: Date.now() + 86_400_000,
        });
      }
      if (href.includes("dealsets.tpl")) {
        // SportLots lists the same set; once BSC has filed it, the entry is a
        // variant of a set NB already has, so the SportLots phase is quiet.
        return htmlResponse(slSetListHtml([["901", "Choice Biloxi Shuckers"]]));
      }
      if (isTokenUrl(href, "buysportscards")) {
        return jsonResponse({ token: "bsc-stub" });
      }
      if (href.includes("api-prod.buysportscards.com")) {
        return jsonResponse(
          bscSetListJson([["choice-biloxi-shuckers", "Choice Biloxi Shuckers"]]),
        );
      }
      throw new Error(`unexpected fetch: ${href}`);
    });

    const first = await asAdmin.action(
      api.selectorOptions.syncSetsAcrossManufacturers,
      { yearId },
    );
    expect(first.success).toBe(true);
    expect(first.message).toContain("1 brand added from the known list");
    expect(first.message).toContain("1 set filed under a known brand");

    // The brand row is born exactly as a hand-created one: NB's own name,
    // the prefix defaulted from it, and SportLots' all-brands sentinel
    // because the year can scope SportLots. No Unknown row was needed.
    const mfrs = await manufacturersOf(t, yearId);
    expect(mfrs.map((m) => m.value)).toEqual(["Choice"]);
    const choice = mfrs[0];
    expect(choice.metadata?.setNamePrefix).toBe("Choice");
    expect(choice.metadata?.isBrandUnknown).toBeUndefined();
    expect(choice.platformData.sportlots).toEqual({ s0: "All Brands" });

    const choiceSets = await setsUnder(t, choice._id);
    expect(choiceSets.map((r) => r.value)).toEqual(["Choice Biloxi Shuckers"]);
    expect(choiceSets[0].platformData.bsc).toEqual({
      b0: "choice-biloxi-shuckers",
    });
    expect(choice.children).toEqual([choiceSets[0]._id]);

    const afterFirst = await t.run(async (ctx) =>
      (await ctx.db.query("selectorOptions").collect()).length,
    );

    // Idempotent: the brand now claims the set by its own prefix, so the
    // known list is never consulted and nothing is created or moved.
    const second = await asAdmin.action(
      api.selectorOptions.syncSetsAcrossManufacturers,
      { yearId },
    );
    expect(second.success).toBe(true);
    expect(second.message).not.toContain("added from the known list");
    expect(second.message).not.toContain("filed under a known brand");
    const afterSecond = await t.run(async (ctx) =>
      (await ctx.db.query("selectorOptions").collect()).length,
    );
    expect(afterSecond).toBe(afterFirst);
    expect((await manufacturersOf(t, yearId)).map((m) => m.value)).toEqual([
      "Choice",
    ]);
  });

  test("a set an OPERATOR left under Unknown is not moved, and no brand is minted for it", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN);
    const { yearId } = await seedSportAndYear(t);
    const unknown = await insertManufacturer(t, yearId, "Unknown", {
      slId: "All Brands",
      isBrandUnknown: true,
    });
    const placed = await insertSet(t, unknown, "Choice Albany Polecats", {
      bscId: "choice-albany-polecats",
      setByOperator: true,
    });

    stubFetch(async (url) => {
      const href = String(url);
      if (isTokenUrl(href, "sportlots")) {
        return jsonResponse({
          token: "SLSESSION=stub",
          expiresAt: Date.now() + 86_400_000,
        });
      }
      if (href.includes("dealsets.tpl")) {
        return htmlResponse(slSetListHtml([["902", "Choice Albany Polecats"]]));
      }
      if (isTokenUrl(href, "buysportscards")) {
        return jsonResponse({ token: "bsc-stub" });
      }
      if (href.includes("api-prod.buysportscards.com")) {
        return jsonResponse(
          bscSetListJson([["choice-albany-polecats", "Choice Albany Polecats"]]),
        );
      }
      throw new Error(`unexpected fetch: ${href}`);
    });

    const result = await asAdmin.action(
      api.selectorOptions.syncSetsAcrossManufacturers,
      { yearId },
    );
    expect(result.success).toBe(true);
    // No "Choice" row: the set that would have asked for one is the
    // operator's, and their placement is not reconsidered.
    expect((await manufacturersOf(t, yearId)).map((m) => m.value)).toEqual([
      "Unknown",
    ]);
    expect(result.message).not.toContain("added from the known list");
    const row = await t.run(async (ctx) => ctx.db.get(placed));
    expect(row?.parentId).toBe(unknown);
    // And the sync still matched it by id — no second copy under Unknown.
    expect((await setsUnder(t, unknown)).map((r) => r.value)).toEqual([
      "Choice Albany Polecats",
    ]);
  });

  test("a SportLots name saved as a set from Unknown's review is created under its known brand instead", async () => {
    // A year SportLots serves and BSC does not: the SportLots review is the
    // only writer, so this pins the second half of the ticket's requirement 4.
    // NEO-306 — the split moved from the sync into the review's save; it is
    // a placement of the names filed as sets, not a role.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN);
    const yearId = await t.run(async (ctx) => {
      const sportId = await ctx.db.insert("selectorOptions", {
        level: "sport",
        value: "Hockey",
        platformData: { sportlots: { s0: "HK" } },
        platformSlotSeq: { sportlots: 1 },
        children: [],
        lastUpdated: Date.now(),
      });
      return ctx.db.insert("selectorOptions", {
        level: "year",
        value: "1997",
        platformData: { sportlots: { s0: "1997" } },
        platformSlotSeq: { sportlots: 1 },
        parentId: sportId,
        children: [],
        lastUpdated: Date.now(),
      });
    });
    const unknown = await insertManufacturer(t, yearId, "Unknown", {
      slId: "All Brands",
      isBrandUnknown: true,
    });

    stubFetch(async (url) => {
      const href = String(url);
      if (href.includes("buysportscards")) {
        throw new Error(`BSC must not be contacted: ${href}`);
      }
      if (isTokenUrl(href, "sportlots")) {
        return jsonResponse({
          token: "SLSESSION=stub",
          expiresAt: Date.now() + 86_400_000,
        });
      }
      if (href.includes("dealsets.tpl")) {
        return htmlResponse(
          slSetListHtml([
            ["901", "Pucko Swedish Elite League"],
            ["902", "Roanoke Express ECHL"],
          ]),
        );
      }
      throw new Error(`unexpected fetch: ${href}`);
    });

    const result = await asAdmin.action(
      api.selectorOptions.syncSetsAcrossManufacturers,
      { yearId, manufacturerId: unknown },
    );
    expect(result.success).toBe(true);
    expect(result.message).toContain("2 SportLots sets to sort");
    // The sync minted nothing, not even the brand.
    expect((await manufacturersOf(t, yearId)).map((m) => m.value)).toEqual([
      "Unknown",
    ]);
    const saved = await saveReviewAsSets(t, unknown);
    expect(saved.knownBrandsAdded).toBe(1);
    expect(saved.sets).toBe(2);
    expect(saved.remaining).toBe(0);

    const mfrs = await manufacturersOf(t, yearId);
    expect(mfrs.map((m) => m.value).sort()).toEqual(["Pucko", "Unknown"]);
    const pucko = mfrs.find((m) => m.value === "Pucko")!;
    expect(pucko.metadata?.setNamePrefix).toBe("Pucko");
    expect(pucko.platformData.sportlots).toEqual({ s0: "All Brands" });

    // The set keeps the label as its name (the brand prefix is already on
    // the front of it) and its Base carries the SportLots id.
    const puckoSets = await setsUnder(t, pucko._id);
    expect(puckoSets.map((r) => r.value)).toEqual(["Pucko Swedish Elite League"]);
    const [puckoBase] = await variantsUnder(t, puckoSets[0]._id);
    expect(puckoBase.value).toBe("Base");
    expect(puckoBase.platformData.sportlots).toEqual({ s0: "901" });

    // What no known brand claims still lands under Unknown.
    const unknownSets = await setsUnder(t, unknown);
    expect(unknownSets.map((r) => r.value)).toEqual(["Roanoke Express ECHL"]);
  });
});
