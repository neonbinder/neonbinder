/**
 * NEO-237 (D14) — `ensureSelectorOptions` dispatching `level: "setName"` from
 * the All Brands VIEW, where the Sets column's parent is the YEAR rather than
 * a manufacturer (no setName row is ever parented by a year itself).
 *
 * Companion to `platformLevelSupport.test.ts`'s `syncSetsAcrossManufacturers`
 * family (which this file does not repeat — the fetch/classification
 * behaviour there is unchanged) and `selectorSyncStatus.test.ts` (the general
 * status-state machine). This file pins `ensureSelectorOptions`'s OWN
 * dispatch decisions at `setName`: the "already populated" check reads
 * `yearHasAnySet` rather than "does this parent have children" when the
 * parent is a year, the sync runs WITHOUT `manufacturerId` so it covers every
 * brand under the year, the SportLots gate at `setName` uses the attach-rule
 * (sport+year, not sport+year+manufacturer) so a year with SportLots ids and
 * no BSC id still reaches the action, and a SportLots skip at `setName` is a
 * notice rather than the usual "does not serve this level" silence.
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
  subject: "admin_user_neo237_setname_view",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_user_neo237_setname_view",
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
  return new Response(body, { status: 200, headers: { "Content-Type": "text/html" } });
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

function slSetListHtml(sets: Array<[string, string]>): string {
  return sets
    .map(
      ([id, label], i) =>
        `<input type="radio" Name="selset" Value="${id}"></td> <td>${i + 1}  ${label}</td>`,
    )
    .join("");
}

function bscSetListJson(sets: Array<[string, string]>) {
  return {
    aggregations: {
      setName: sets.map(([slug, label]) => ({ label, slug, count: 400, active: true })),
    },
  };
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

async function seedSportAndYear(
  t: ReturnType<typeof convexTest>,
  opts: { bsc?: boolean; sportlots?: boolean } = { bsc: true, sportlots: true },
) {
  return t.run(async (ctx) => {
    const sportId = await ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Hockey",
      sportConfig: { skuCode: "HK", league: "NHL" },
      platformData: {
        ...(opts.bsc ? { bsc: { b0: "hockey" } } : {}),
        ...(opts.sportlots ? { sportlots: { s0: "HK" } } : {}),
      },
      platformSlotSeq: {
        ...(opts.bsc ? { bsc: 1 } : {}),
        ...(opts.sportlots ? { sportlots: 1 } : {}),
      },
      children: [],
      lastUpdated: Date.now(),
    });
    const yearId = await ctx.db.insert("selectorOptions", {
      level: "year",
      value: "1997",
      platformData: {
        ...(opts.bsc ? { bsc: { b0: "1997" } } : {}),
        ...(opts.sportlots ? { sportlots: { s0: "1997" } } : {}),
      },
      platformSlotSeq: {
        ...(opts.bsc ? { bsc: 1 } : {}),
        ...(opts.sportlots ? { sportlots: 1 } : {}),
      },
      parentId: sportId,
      children: [],
      lastUpdated: Date.now(),
    });
    await ctx.db.patch(sportId, { children: [yearId] });
    return { sportId, yearId };
  });
}

async function insertManufacturer(
  t: ReturnType<typeof convexTest>,
  yearId: Id<"selectorOptions">,
  value: string,
  opts: { slId?: string; prefix?: string } = {},
) {
  const id = await t.run(async (ctx) =>
    ctx.db.insert("selectorOptions", {
      level: "manufacturer",
      value,
      platformData: opts.slId ? { sportlots: { s0: opts.slId } } : {},
      ...(opts.slId ? { platformSlotSeq: { sportlots: 1 } } : {}),
      parentId: yearId,
      children: [],
      metadata: opts.prefix !== undefined ? { setNamePrefix: opts.prefix } : {},
      lastUpdated: Date.now(),
    }),
  );
  await t.run(async (ctx) => {
    const year = await ctx.db.get(yearId);
    await ctx.db.patch(yearId, { children: [...(year?.children ?? []), id] });
  });
  return id;
}

async function setsUnder(t: ReturnType<typeof convexTest>, parentId: Id<"selectorOptions">) {
  return t.run(async (ctx) =>
    ctx.db
      .query("selectorOptions")
      .withIndex("by_level_and_parent", (q) => q.eq("level", "setName").eq("parentId", parentId))
      .collect(),
  );
}

describe("ensureSelectorOptions(setName) from the All Brands view (year parent)", () => {
  test("'populated' means SOME manufacturer under the year has a set — no fetch happens", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN);
    const { yearId } = await seedSportAndYear(t);
    const topps = await insertManufacturer(t, yearId, "Topps", { slId: "1", prefix: "Topps" });
    await t.run(async (ctx) => {
      const setId = await ctx.db.insert("selectorOptions", {
        level: "setName",
        value: "Topps Series 1",
        platformData: {},
        parentId: topps,
        children: [],
        lastUpdated: Date.now(),
      });
      await ctx.db.patch(topps, { children: [setId] });
    });

    stubFetch(async (url) => {
      throw new Error(`must not fetch when already populated: ${String(url)}`);
    });

    const result = await asAdmin.action(api.selectorOptions.ensureSelectorOptions, {
      level: "setName",
      parentId: yearId,
    });
    expect(result).toEqual({ ran: false, reason: "already_populated", skippedSides: [], pausedSides: [] });
  });

  test("a year with brands but NO set anywhere is not populated, and the sync runs", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN);
    const { yearId } = await seedSportAndYear(t);
    const topps = await insertManufacturer(t, yearId, "Topps", { slId: "1", prefix: "Topps" });

    stubFetch(async (url) => {
      const href = String(url);
      if (isTokenUrl(href, "sportlots")) {
        return jsonResponse({ token: "SLSESSION=stub", expiresAt: Date.now() + 86_400_000 });
      }
      if (href.includes("dealsets.tpl")) {
        return htmlResponse(slSetListHtml([["501", "Topps Series 1"]]));
      }
      if (isTokenUrl(href, "buysportscards")) {
        return jsonResponse({ token: "bsc-stub" });
      }
      if (href.includes("api-prod.buysportscards.com")) {
        return jsonResponse(bscSetListJson([["topps-series-1", "Topps Series 1"]]));
      }
      throw new Error(`unexpected fetch: ${href}`);
    });

    const result = await asAdmin.action(api.selectorOptions.ensureSelectorOptions, {
      level: "setName",
      parentId: yearId,
    });
    expect(result.ran).toBe(true);
    expect(result.reason).toBe("synced");
    expect(await setsUnder(t, topps)).toHaveLength(1);
  });

  test("the sync runs WITHOUT manufacturerId — every brand under the year is covered, not just one", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN);
    const { yearId } = await seedSportAndYear(t);
    const topps = await insertManufacturer(t, yearId, "Topps", { slId: "1", prefix: "Topps" });
    const score = await insertManufacturer(t, yearId, "Score", { slId: "7", prefix: "Score" });

    stubFetch(async (url) => {
      const href = String(url);
      if (isTokenUrl(href, "sportlots")) {
        return jsonResponse({ token: "SLSESSION=stub", expiresAt: Date.now() + 86_400_000 });
      }
      if (href.includes("dealsets.tpl")) {
        // Both brands' SL lists are fetched; the SportLots-only entry is
        // SAVED as a set under EACH brand — proof the view-mode sync did not
        // scope to a single manufacturer.
        return htmlResponse(slSetListHtml([["901", "Something New"]]));
      }
      if (isTokenUrl(href, "buysportscards")) {
        return jsonResponse({ token: "bsc-stub" });
      }
      if (href.includes("api-prod.buysportscards.com")) {
        return jsonResponse(bscSetListJson([]));
      }
      throw new Error(`unexpected fetch: ${href}`);
    });

    const result = await asAdmin.action(api.selectorOptions.ensureSelectorOptions, {
      level: "setName",
      parentId: yearId,
    });
    expect(result.ran).toBe(true);

    expect((await setsUnder(t, topps)).map((r) => r.value)).toEqual(["Topps Something New"]);
    expect((await setsUnder(t, score)).map((r) => r.value)).toEqual(["Score Something New"]);
  });
});

describe("ensureSelectorOptions(setName) — the SportLots attach-rule gate (D14a)", () => {
  test("a year with SportLots ids and NO BSC id still reaches the action (not short-circuited)", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN);
    const { yearId } = await seedSportAndYear(t, { bsc: false, sportlots: true });
    const score = await insertManufacturer(t, yearId, "Score", { slId: "7", prefix: "Score" });

    stubFetch(async (url) => {
      const href = String(url);
      if (href.includes("buysportscards")) {
        throw new Error(`BSC must not be contacted: ${href}`);
      }
      if (isTokenUrl(href, "sportlots")) {
        return jsonResponse({ token: "SLSESSION=stub", expiresAt: Date.now() + 86_400_000 });
      }
      if (href.includes("dealsets.tpl")) {
        return htmlResponse(slSetListHtml([["701", "Score Board"]]));
      }
      throw new Error(`unexpected fetch: ${href}`);
    });

    const result = await asAdmin.action(api.selectorOptions.ensureSelectorOptions, {
      level: "setName",
      parentId: score,
    });
    // A both-sides-unresolvable path returns "no_marketplace_ids" WITHOUT
    // running anything; this must NOT be that path.
    expect(result.reason).not.toBe("no_marketplace_ids");
    expect(result.ran).toBe(true);
    expect(fetched.some((u) => u.includes("dealsets.tpl"))).toBe(true);
    expect((await setsUnder(t, score)).map((r) => r.value)).toEqual(["Score Board"]);
  });

  test("a SportLots skip at setName is NOTIFIABLE — it is not swallowed as structural", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN);
    const { yearId } = await seedSportAndYear(t, { bsc: true, sportlots: true });
    // Topps has a BSC-derivable set (via prefix) but NO SportLots id of its
    // own, so the SportLots phase for THIS brand is skipped.
    const topps = await insertManufacturer(t, yearId, "Topps", { prefix: "Topps" });

    stubFetch(async (url) => {
      const href = String(url);
      if (href.includes("sportlots")) {
        throw new Error(`SportLots must not be contacted for a brand with no SL id: ${href}`);
      }
      if (isTokenUrl(href, "buysportscards")) {
        return jsonResponse({ token: "bsc-stub" });
      }
      if (href.includes("api-prod.buysportscards.com")) {
        return jsonResponse(bscSetListJson([["topps-series-1", "Topps Series 1"]]));
      }
      throw new Error(`unexpected fetch: ${href}`);
    });

    const result = await asAdmin.action(api.selectorOptions.ensureSelectorOptions, {
      level: "setName",
      parentId: topps,
    });
    expect(result.ran).toBe(true);
    expect(result.skippedSides).toEqual(["sportlots"]);

    const status = await asAdmin.query(api.selectorOptions.getSelectorSyncStatus, {
      level: "setName",
      parentId: topps,
    });
    expect(status?.status).toBe("done");
    expect(status?.message).toMatch(/sportlots/i);
  });
});
