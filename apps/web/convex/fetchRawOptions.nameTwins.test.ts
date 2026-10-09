/**
 * NEO-325 — `fetchRawOptions` (convex/setReconciliation.ts) and SportLots name
 * twins at the INSERT level.
 *
 *   • The set's Base SportLots set is dropped from `slOptions` BY ID, read off
 *     the Base row's slots (`baseSlIdsBesideVariantType`) — never by the Base's
 *     NAME, which also hid every SportLots twin of that name (invariant 4).
 *   • Nothing is dropped when the parent IS the Base (its picker is choosing
 *     the Base's own set).
 *   • `twinIds` is judged on the FULL list (the Base's set included), so a twin
 *     of the Base's name is still a twin, and is never auto-paired.
 *
 * The marketplace HTTP responses are stubbed (no adapter module is mocked).
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { __resetContractCache } from "./credentials";
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

const ADMIN_IDENTITY = {
  subject: "admin_neo325_raw_twins",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_neo325_raw_twins",
  name: "Admin User",
  role: "admin",
};

const SENTINEL = 1_000_000;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
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

function stubMarketplaces(lists: {
  sl: Array<[string, string]>;
  bsc?: Array<[string, string]>;
}) {
  vi.stubGlobal("fetch", (async (url: string | URL | Request) => {
    const href = String(url);
    if (href.endsWith("/health")) {
      return jsonResponse({ status: "ok", environment: "test", contractVersion: 1 });
    }
    if (isTokenUrl(href, "sportlots")) {
      return jsonResponse({ token: "SLSESSION=stub", expiresAt: Date.now() + 86_400_000 });
    }
    if (isTokenUrl(href, "buysportscards")) return jsonResponse({ token: "bsc-stub" });
    if (href.includes("dealsets.tpl")) {
      return new Response(slSetListHtml(lists.sl), {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    }
    if (href.includes("api-prod.buysportscards.com")) {
      return jsonResponse({
        aggregations: {
          variantName: (lists.bsc ?? []).map(([slug, label]) => ({
            label,
            slug,
            count: 10,
            active: true,
          })),
        },
      });
    }
    throw new Error(`unexpected fetch: ${href}`);
  }) as typeof fetch);
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

type Seed = {
  setId: Id<"selectorOptions">;
  baseId?: Id<"selectorOptions">;
  insertTypeId: Id<"selectorOptions">;
};

/**
 * sport → year → manufacturer → setName → variantType(s). SportLots needs
 * sport + year + manufacturer ids; BSC (when `bsc`) needs sport + year +
 * setName ids and a `variant`-tagged slot on the variantType.
 */
async function seed(
  t: ReturnType<typeof convexTest>,
  opts: {
    bsc?: boolean;
    base?: { sl: string[] } | "no-sl" | "none";
  } = {},
): Promise<Seed> {
  const base = opts.base ?? { sl: ["100"] };
  return t.run(async (ctx) => {
    const sport = await ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Baseball",
      platformData: {
        sportlots: { s0: "BB" },
        ...(opts.bsc ? { bsc: { b0: "baseball" } } : {}),
      },
      children: [],
      lastUpdated: SENTINEL,
    });
    const year = await ctx.db.insert("selectorOptions", {
      level: "year",
      value: "2024",
      platformData: {
        sportlots: { s0: "2024" },
        ...(opts.bsc ? { bsc: { b0: "2024" } } : {}),
      },
      parentId: sport,
      children: [],
      lastUpdated: SENTINEL,
    });
    const manufacturer = await ctx.db.insert("selectorOptions", {
      level: "manufacturer",
      value: "Topps",
      platformData: { sportlots: { s0: "TP" } },
      parentId: year,
      children: [],
      lastUpdated: SENTINEL,
    });
    const setId = await ctx.db.insert("selectorOptions", {
      level: "setName",
      value: "Topps Anime",
      // Linked on a marketplace at all: SportLots at insert needs the SET to
      // be a marketplace set (marketplaceResolvability.ts).
      platformData: { bsc: { b0: "topps-anime" } },
      parentId: manufacturer,
      children: [],
      lastUpdated: SENTINEL,
    });
    let baseId: Id<"selectorOptions"> | undefined;
    if (base !== "none") {
      const slots =
        base === "no-sl"
          ? {}
          : Object.fromEntries(base.sl.map((id, i) => [`s${i}`, id]));
      baseId = await ctx.db.insert("selectorOptions", {
        level: "variantType",
        // A name that means nothing: the role is the flag, never the name.
        value: "Core",
        metadata: { isBase: true },
        platformData: base === "no-sl" ? {} : { sportlots: slots },
        parentId: setId,
        children: [],
        lastUpdated: SENTINEL,
      });
    }
    const insertTypeId = await ctx.db.insert("selectorOptions", {
      level: "variantType",
      value: "Insert",
      platformData: opts.bsc ? { bsc: { b0: "insert" } } : {},
      ...(opts.bsc ? { platformFacets: { bsc: { b0: "variant" } } } : {}),
      parentId: setId,
      children: [],
      lastUpdated: SENTINEL,
    });
    return { setId, baseId, insertTypeId };
  });
}

const fetchInsert = (
  t: ReturnType<typeof convexTest>,
  parentId: Id<"selectorOptions">,
  baseSlPrefix?: string,
) =>
  t.withIdentity(ADMIN_IDENTITY).action(api.setReconciliation.fetchRawOptions, {
    level: "insert",
    parentId,
    ...(baseSlPrefix ? { baseSlPrefix } : {}),
  });

const ids = (items: Array<{ platformValue: string }>) =>
  items.map((i) => i.platformValue).sort();

describe("fetchRawOptions at insert — the Base's SportLots set is dropped BY ID (NEO-325)", () => {
  test("drops the Base's id and keeps a SportLots twin of the Base's name", async () => {
    const t = convexTest(schema, modules);
    const { insertTypeId } = await seed(t, { base: { sl: ["100"] } });
    stubMarketplaces({
      sl: [["100", "Anime"], ["101", "Anime"], ["102", "Anime Gold"]],
    });

    // The matcher aid names the Base "Anime": it must filter nothing.
    const res = await fetchInsert(t, insertTypeId, "Anime");

    expect(res.success).toBe(true);
    expect(res.errors).toEqual([]);
    expect(ids(res.slOptions)).toEqual(["101", "102"]);
    expect(ids(res.unmatchedSl)).toEqual(["101", "102"]);
  });

  test("every SportLots slot on the Base is dropped, not only the primary", async () => {
    const t = convexTest(schema, modules);
    const { insertTypeId } = await seed(t, { base: { sl: ["100", "104"] } });
    stubMarketplaces({
      sl: [["100", "Anime"], ["104", "Anime Part 2"], ["102", "Anime Gold"]],
    });

    const res = await fetchInsert(t, insertTypeId);

    expect(ids(res.slOptions)).toEqual(["102"]);
  });

  test("a set labelled like the Base but carrying another id stays: the name is never the filter", async () => {
    const t = convexTest(schema, modules);
    const { insertTypeId } = await seed(t, { base: { sl: ["100"] } });
    stubMarketplaces({ sl: [["555", "Core"], ["102", "Anime Gold"]] });

    const res = await fetchInsert(t, insertTypeId, "Core");

    expect(ids(res.slOptions)).toEqual(["102", "555"]);
  });

  test("the Base is found by its ROLE flag, whatever it is called", async () => {
    const t = convexTest(schema, modules);
    const { insertTypeId, baseId } = await seed(t, { base: { sl: ["100"] } });
    // Rename it: the drop must follow the flag, not "Base".
    await t.run((ctx) => ctx.db.patch(baseId!, { value: "Zebra" }));
    stubMarketplaces({ sl: [["100", "Anime"], ["102", "Anime Gold"]] });

    const res = await fetchInsert(t, insertTypeId);

    expect(ids(res.slOptions)).toEqual(["102"]);
  });

  test("nothing is dropped when the parent IS the Base (the Base picker chooses its own set)", async () => {
    const t = convexTest(schema, modules);
    const { baseId } = await seed(t, { base: { sl: ["100"] } });
    stubMarketplaces({ sl: [["100", "Anime"], ["102", "Anime Gold"]] });

    const res = await fetchInsert(t, baseId!);

    expect(ids(res.slOptions)).toEqual(["100", "102"]);
  });

  test("a set with no Base row drops nothing", async () => {
    const t = convexTest(schema, modules);
    const { insertTypeId } = await seed(t, { base: "none" });
    stubMarketplaces({ sl: [["100", "Anime"], ["102", "Anime Gold"]] });

    const res = await fetchInsert(t, insertTypeId);

    expect(ids(res.slOptions)).toEqual(["100", "102"]);
  });

  test("a Base with no SportLots slot drops nothing", async () => {
    const t = convexTest(schema, modules);
    const { insertTypeId } = await seed(t, { base: "no-sl" });
    stubMarketplaces({ sl: [["100", "Anime"], ["102", "Anime Gold"]] });

    const res = await fetchInsert(t, insertTypeId);

    expect(ids(res.slOptions)).toEqual(["100", "102"]);
  });
});

describe("fetchRawOptions — twinIds (NEO-325)", () => {
  test("SportLots twinIds names every id of a shared name, judged on the FULL list (the Base's set included)", async () => {
    const t = convexTest(schema, modules);
    const { insertTypeId } = await seed(t, { base: { sl: ["100"] } });
    stubMarketplaces({
      sl: [["100", "Anime"], ["101", "anime "], ["102", "Anime Gold"]],
    });

    const res = await fetchInsert(t, insertTypeId);

    expect([...res.twinIds.sportlots].sort()).toEqual(["100", "101"]);
    expect(res.twinIds.bsc).toEqual([]);
  });

  test("a list with no shared names has no twinIds", async () => {
    const t = convexTest(schema, modules);
    const { insertTypeId } = await seed(t, { base: { sl: ["100"] } });
    stubMarketplaces({ sl: [["100", "Anime"], ["102", "Anime Gold"]] });

    const res = await fetchInsert(t, insertTypeId);

    expect(res.twinIds).toEqual({ bsc: [], sportlots: [] });
  });

  test("a twin of the Base's name is never auto-paired with a BSC set of that name, though its namesake left the list", async () => {
    const t = convexTest(schema, modules);
    const { insertTypeId } = await seed(t, { bsc: true, base: { sl: ["100"] } });
    stubMarketplaces({
      sl: [["100", "Anime"], ["101", "Anime"]],
      bsc: [["anime", "Anime"]],
    });

    const res = await fetchInsert(t, insertTypeId);

    expect(res.errors).toEqual([]);
    // After the Base's id leaves, "Anime" (101) is unique in slOptions, so
    // only `twinIds` / `blocked` stops the exact-name pass from linking it.
    expect(res.autoMatched).toEqual([]);
    expect(res.unmatchedBsc.map((b) => b.platformValue)).toEqual(["anime"]);
    expect(res.unmatchedSl.map((s) => s.platformValue)).toEqual(["101"]);
    // Offered, never linked.
    expect(
      res.slCandidates[0]?.candidates.map((c) => c.sl.platformValue),
    ).toContain("101");
  });

  test("BSC twinIds names the ids of a name two BSC sets share", async () => {
    const t = convexTest(schema, modules);
    const { insertTypeId } = await seed(t, { bsc: true, base: "none" });
    stubMarketplaces({
      sl: [["102", "Anime Gold"]],
      bsc: [["gold-1", "Gold"], ["gold-2", "Gold"], ["silver", "Silver"]],
    });

    const res = await fetchInsert(t, insertTypeId);

    expect([...res.twinIds.bsc].sort()).toEqual(["gold-1", "gold-2"]);
    expect(res.autoMatched).toEqual([]);
  });

  test("a side that is skipped reports empty twinIds", async () => {
    const t = convexTest(schema, modules);
    stubMarketplaces({ sl: [] });
    const res = await t
      .withIdentity(ADMIN_IDENTITY)
      .action(api.setReconciliation.fetchRawOptions, { level: "year" });

    expect(res.twinIds).toEqual({ bsc: [], sportlots: [] });
  });
});

describe("baseSlIdsBesideVariantType (NEO-325)", () => {
  const read = (t: ReturnType<typeof convexTest>, variantTypeId: Id<"selectorOptions">) =>
    t.query(internal.setReconciliation.baseSlIdsBesideVariantType, { variantTypeId });

  test("a non-Base variant type reads the Base's SportLots ids, in every slot", async () => {
    const t = convexTest(schema, modules);
    const { insertTypeId } = await seed(t, { base: { sl: ["100", "104"] } });
    expect([...(await read(t, insertTypeId))].sort()).toEqual(["100", "104"]);
  });

  test("the Base itself reads nothing", async () => {
    const t = convexTest(schema, modules);
    const { baseId } = await seed(t, { base: { sl: ["100"] } });
    expect(await read(t, baseId!)).toEqual([]);
  });

  test("a row that is not a variant type reads nothing", async () => {
    const t = convexTest(schema, modules);
    const { setId } = await seed(t, { base: { sl: ["100"] } });
    expect(await read(t, setId)).toEqual([]);
  });

  test("a set with no Base, or a Base with no SportLots slot, reads nothing", async () => {
    const t = convexTest(schema, modules);
    const none = await seed(t, { base: "none" });
    expect(await read(t, none.insertTypeId)).toEqual([]);
    const noSl = await seed(t, { base: "no-sl" });
    expect(await read(t, noSl.insertTypeId)).toEqual([]);
  });

  test("a sibling that is not the Base contributes no ids, whatever it holds", async () => {
    const t = convexTest(schema, modules);
    const { setId, insertTypeId } = await seed(t, { base: { sl: ["100"] } });
    await t.run((ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "variantType",
        value: "Parallel",
        platformData: { sportlots: { s0: "999" } },
        parentId: setId,
        children: [],
        lastUpdated: SENTINEL,
      }),
    );
    expect(await read(t, insertTypeId)).toEqual(["100"]);
  });

  test("a Base under a DIFFERENT set is not read", async () => {
    const t = convexTest(schema, modules);
    const a = await seed(t, { base: "none" });
    await seed(t, { base: { sl: ["777"] } });
    expect(await read(t, a.insertTypeId)).toEqual([]);
  });
});
