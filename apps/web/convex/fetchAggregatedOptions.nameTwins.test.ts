/**
 * NEO-325 — `fetchAggregatedOptions` and marketplace NAME TWINS.
 *
 * Two or more ids that share a name on ONE marketplace cannot be paired by
 * name (CLAUDE.md invariant 7), and a sync may not pick one for the operator:
 * "the user should be reconciling as we cannot automate that" (Jason). So a
 * twinned name contributes no item at all, and nothing already linked is
 * disturbed. Driven through the REAL action at the year level (the one level
 * both marketplaces serve and whose values are cheap to fabricate), with the
 * `fetchAggregatedOptions.allBrandsRouting.test.ts` harness: the marketplace
 * HTTP responses are stubbed, no adapter module is mocked.
 *
 * Also pins `buildTwinsLeft` (pure) and the `selectorSyncStatus` notice
 * `ensureSelectorOptions` writes from it.
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { __resetContractCache } from "./credentials";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  MAX_TWIN_NOTICE_ID_LENGTH,
  TWIN_NOTICE_IDS_PER_SIDE,
  TWIN_NOTICE_LIMIT,
  buildTwinsLeft,
} from "./selectorSyncStore";
import { MAX_SELECTOR_VALUE_LENGTH } from "./selectorSyncMatch";
import { internalQuery } from "./_generated/server";
import { v } from "convex/values";

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
  subject: "admin_user_neo325_aggregator_twins",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_user_neo325_aggregator_twins",
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

/** Year lists: SportLots as `[id, label]` options, BSC as `[slug, label]`. */
function stubYearLists(lists: {
  sl: Array<[string, string]>;
  bsc: Array<[string, string]>;
}) {
  stubFetch(async (url) => {
    const href = String(url);
    if (isTokenUrl(href, "buysportscards")) return jsonResponse({ token: "bsc-stub" });
    if (isTokenUrl(href, "sportlots")) {
      return jsonResponse({ token: "SLSESSION=stub", expiresAt: Date.now() + 86_400_000 });
    }
    if (href.includes("api-prod.buysportscards.com")) {
      return jsonResponse({
        aggregations: {
          year: lists.bsc.map(([slug, label]) => ({
            label,
            slug,
            count: 10,
            active: true,
          })),
        },
      });
    }
    if (href.includes("newinven.tpl")) {
      const opts = lists.sl
        .map(([id, label]) => `<Option value="${id}">${label}</Option>`)
        .join("");
      return htmlResponse(
        `<html><body><form><select name="yr">${opts}</select></form></body></html>`,
      );
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

async function seedSport(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) =>
    ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Hockey",
      sportConfig: { skuCode: "HK", league: "NHL" },
      platformData: { bsc: { b0: "hockey" }, sportlots: { s0: "HK" } },
      platformSlotSeq: { bsc: 1, sportlots: 1 },
      children: [],
      lastUpdated: Date.now(),
    }),
  );
}

async function seedYearRow(
  t: ReturnType<typeof convexTest>,
  sportId: Id<"selectorOptions">,
  value: string,
  ids: { bsc?: string; sportlots?: string },
) {
  return t.run(async (ctx) =>
    ctx.db.insert("selectorOptions", {
      level: "year",
      value,
      platformData: {
        ...(ids.bsc ? { bsc: { b0: ids.bsc } } : {}),
        ...(ids.sportlots ? { sportlots: { s0: ids.sportlots } } : {}),
      },
      platformSlotSeq: {
        ...(ids.bsc ? { bsc: 1 } : {}),
        ...(ids.sportlots ? { sportlots: 1 } : {}),
      },
      parentId: sportId,
      children: [],
      lastUpdated: Date.now(),
    }),
  );
}

async function yearRows(t: ReturnType<typeof convexTest>, sportId: Id<"selectorOptions">) {
  return t.run(async (ctx) =>
    ctx.db
      .query("selectorOptions")
      .withIndex("by_level_and_parent", (q) =>
        q.eq("level", "year").eq("parentId", sportId),
      )
      .collect(),
  );
}

const run = (
  asAdmin: ReturnType<ReturnType<typeof convexTest>["withIdentity"]>,
  sportId: Id<"selectorOptions">,
) =>
  asAdmin.action(api.selectorOptions.fetchAggregatedOptions, {
    level: "year",
    parentId: sportId,
    parentFilters: { sport: "Hockey" },
  });

describe("fetchAggregatedOptions — name twins create nothing (NEO-325)", () => {
  test("two SportLots ids under one name plus one BSC id of that name: no row, and the BSC id stays unattached", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN);
    const sportId = await seedSport(t);
    stubYearLists({
      sl: [["sl-a", "1997"], ["sl-b", "1997"]],
      bsc: [["bsc-1997", "1997"]],
    });

    const result = await run(asAdmin, sportId);

    expect(result.success).toBe(true);
    expect(await yearRows(t, sportId)).toEqual([]);
  });

  test("two BSC ids under one name plus one SportLots id of that name: no row, and the SportLots id stays unattached", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN);
    const sportId = await seedSport(t);
    stubYearLists({
      sl: [["sl-a", "1997"]],
      bsc: [["bsc-a", "1997"], ["bsc-b", "1997"]],
    });

    const result = await run(asAdmin, sportId);

    expect(result.success).toBe(true);
    expect(await yearRows(t, sportId)).toEqual([]);
  });

  test("both sides twinned create nothing", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN);
    const sportId = await seedSport(t);
    stubYearLists({
      sl: [["sl-a", "1997"], ["sl-b", "1997"]],
      bsc: [["bsc-a", "1997"], ["bsc-b", "1997"]],
    });

    const result = await run(asAdmin, sportId);

    expect(result.success).toBe(true);
    expect(await yearRows(t, sportId)).toEqual([]);
  });

  test("a twinned name beside unique names: the unique names pair and store as before, the twinned one is left out", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN);
    const sportId = await seedSport(t);
    stubYearLists({
      sl: [["sl-98", "1998"], ["sl-a", "1997"], ["sl-b", "1997"]],
      bsc: [["bsc-98", "1998"], ["bsc-97", "1997"]],
    });

    const result = await run(asAdmin, sportId);

    expect(result.success).toBe(true);
    const rows = await yearRows(t, sportId);
    expect(rows.map((r) => r.value)).toEqual(["1998"]);
    expect(rows[0].platformData.bsc).toEqual({ b0: "bsc-98" });
    expect(rows[0].platformData.sportlots).toEqual({ s0: "sl-98" });
  });

  test("with no twins every name pairs and stores exactly as it did", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN);
    const sportId = await seedSport(t);
    stubYearLists({
      sl: [["sl-97", "1997"], ["sl-98", "1998"]],
      bsc: [["bsc-97", "1997"], ["bsc-98", "1998"]],
    });

    await run(asAdmin, sportId);

    const rows = (await yearRows(t, sportId)).sort((a, b) => a.value.localeCompare(b.value));
    expect(rows.map((r) => [r.value, r.platformData.bsc, r.platformData.sportlots])).toEqual([
      ["1997", { b0: "bsc-97" }, { s0: "sl-97" }],
      ["1998", { b0: "bsc-98" }, { s0: "sl-98" }],
    ]);
  });

  test("a list that is ONLY twins is a successful sync with nothing stored and nothing unlinked", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN);
    const sportId = await seedSport(t);
    stubYearLists({
      sl: [["sl-a", "1997"], ["sl-b", "1997"]],
      bsc: [["bsc-a", "1997"], ["bsc-b", "1997"]],
    });

    const result = await run(asAdmin, sportId);

    // Not the "no options fetched" failure: the marketplaces DID answer.
    expect(result.success).toBe(true);
    expect(result.failedPlatforms).toEqual([]);
    expect(result.unlinked).toEqual([]);
    expect(result.unlinkedTotal).toBe(0);
    expect(await yearRows(t, sportId)).toEqual([]);
  });

  test("an existing row linked to ONE twin keeps its link and its name, and nothing is unlinked", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN);
    const sportId = await seedSport(t);
    // The operator's own name for the set it linked to sl-a / bsc-a.
    const rowId = await seedYearRow(t, sportId, "Operator Year", {
      bsc: "bsc-a",
      sportlots: "sl-a",
    });
    // A unique pair beside the twins keeps the returned-id list non-empty, so
    // the unlink pass really runs: it must still read the twin ids as returned.
    stubYearLists({
      sl: [["sl-a", "1997"], ["sl-b", "1997"], ["sl-98", "1998"]],
      bsc: [["bsc-a", "1997"], ["bsc-b", "1997"], ["bsc-98", "1998"]],
    });

    const result = await run(asAdmin, sportId);

    expect(result.unlinked).toEqual([]);
    const row = await t.run((ctx) => ctx.db.get(rowId));
    expect(row?.value).toBe("Operator Year");
    expect(row?.platformData.bsc).toEqual({ b0: "bsc-a" });
    expect(row?.platformData.sportlots).toEqual({ s0: "sl-a" });
    expect((await yearRows(t, sportId)).map((r) => r.value).sort()).toEqual([
      "1998",
      "Operator Year",
    ]);
  });

  test("a row linked to the id of a twin whose name no longer matches its own keeps the link on a second sync", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN);
    const sportId = await seedSport(t);
    const rowId = await seedYearRow(t, sportId, "1997", { sportlots: "sl-a" });
    stubYearLists({
      sl: [["sl-a", "1997"], ["sl-b", "1997"]],
      bsc: [],
    });

    await run(asAdmin, sportId);
    await run(asAdmin, sportId);

    const rows = await yearRows(t, sportId);
    expect(rows.map((r) => r._id)).toEqual([rowId]);
    expect(rows[0].platformData.sportlots).toEqual({ s0: "sl-a" });
  });
});

describe("buildTwinsLeft", () => {
  const group = (name: string, bsc: string[], sportlots: string[]) => ({
    name,
    key: name.toLowerCase(),
    bsc,
    sportlots,
  });

  test("excludes every id an NB row already holds, per side", () => {
    const out = buildTwinsLeft(
      [group("Anime", ["b1", "b2"], ["s1", "s2"])],
      { bsc: new Set(["b1"]), sportlots: new Set(["s2"]) },
    );
    expect(out).toEqual({
      twinsLeft: [{ name: "Anime", bsc: ["b2"], sportlots: ["s1"] }],
      twinsLeftTotal: 1,
    });
  });

  test("a name whose every id is held is not listed at all", () => {
    const out = buildTwinsLeft(
      [group("Anime", ["b1"], ["s1", "s2"])],
      { bsc: new Set(["b1"]), sportlots: new Set(["s1", "s2"]) },
    );
    expect(out).toEqual({ twinsLeft: [], twinsLeftTotal: 0 });
  });

  test("a side can be empty: SportLots twins beside a held BSC id list only the SportLots ids", () => {
    const out = buildTwinsLeft(
      [group("Anime", ["b1"], ["s1", "s2"])],
      { bsc: new Set(["b1"]), sportlots: new Set() },
    );
    expect(out.twinsLeft).toEqual([{ name: "Anime", bsc: [], sportlots: ["s1", "s2"] }]);
  });

  test("held: null (the holder read hit its bound) reports every id", () => {
    const out = buildTwinsLeft([group("Anime", ["b1"], ["s1", "s2"])], null);
    expect(out.twinsLeft).toEqual([{ name: "Anime", bsc: ["b1"], sportlots: ["s1", "s2"] }]);
  });

  test("sorts by folded key and de-duplicates repeated ids", () => {
    const out = buildTwinsLeft(
      [group("Zebra", ["b9"], []), group("alpha", ["b1", "b1"], [])],
      null,
    );
    expect(out.twinsLeft.map((e) => e.name)).toEqual(["alpha", "Zebra"]);
    expect(out.twinsLeft[0].bsc).toEqual(["b1"]);
  });

  test("caps the ids per side but not the true count of names", () => {
    const many = Array.from({ length: TWIN_NOTICE_IDS_PER_SIDE + 5 }, (_, i) => `s${i}`);
    const out = buildTwinsLeft([group("Anime", [], many)], null);
    expect(out.twinsLeft[0].sportlots).toHaveLength(TWIN_NOTICE_IDS_PER_SIDE);
    expect(out.twinsLeft[0].sportlots).toEqual(many.slice(0, TWIN_NOTICE_IDS_PER_SIDE));
  });

  test("caps the names at TWIN_NOTICE_LIMIT while twinsLeftTotal keeps the true count", () => {
    const groups = Array.from({ length: TWIN_NOTICE_LIMIT + 7 }, (_, i) =>
      group(`name-${String(i).padStart(3, "0")}`, [`b${i}`], []),
    );
    const out = buildTwinsLeft(groups, null);
    expect(out.twinsLeft).toHaveLength(TWIN_NOTICE_LIMIT);
    expect(out.twinsLeftTotal).toBe(TWIN_NOTICE_LIMIT + 7);
    expect(out.twinsLeft[0].name).toBe("name-000");
  });

  test("a name that fails the selector-value check is left out, and the total counts only the survivors", () => {
    const out = buildTwinsLeft(
      [
        group("Anime", ["b1"], []),
        group("   ", ["b2"], []),
        group("Line\nBreak", ["b3"], []),
        group("Bell\u0007", ["b4"], []),
        group("Zero\u200bWidth", ["b5"], []),
        group("x".repeat(MAX_SELECTOR_VALUE_LENGTH + 1), ["b6"], []),
      ],
      null,
    );
    expect(out).toEqual({
      twinsLeft: [{ name: "Anime", bsc: ["b1"], sportlots: [] }],
      twinsLeftTotal: 1,
    });
  });

  test("the stored name is the trimmed one", () => {
    const out = buildTwinsLeft([group("  Anime  ", ["b1"], [])], null);
    expect(out.twinsLeft[0].name).toBe("Anime");
  });

  test("an id past its side's length ceiling is dropped, and a name left with no id is not listed", () => {
    const longBsc = "b".repeat(MAX_TWIN_NOTICE_ID_LENGTH.bsc + 1);
    const longSl = "s".repeat(MAX_TWIN_NOTICE_ID_LENGTH.sportlots + 1);
    const okBsc = "b".repeat(MAX_TWIN_NOTICE_ID_LENGTH.bsc);
    const okSl = "s".repeat(MAX_TWIN_NOTICE_ID_LENGTH.sportlots);
    const out = buildTwinsLeft(
      [
        group("Mixed", [longBsc, okBsc], [longSl, okSl]),
        group("OnlyLong", [longBsc], [longSl]),
        group("EmptyIds", [""], [""]),
      ],
      null,
    );
    expect(out.twinsLeft).toEqual([{ name: "Mixed", bsc: [okBsc], sportlots: [okSl] }]);
    expect(out.twinsLeftTotal).toBe(1);
  });
});

describe("ensureSelectorOptions — the twin notice on selectorSyncStatus (NEO-325)", () => {
  const ensure = (
    asAdmin: ReturnType<ReturnType<typeof convexTest>["withIdentity"]>,
    sportId: Id<"selectorOptions">,
  ) =>
    asAdmin.action(api.selectorOptions.ensureSelectorOptions, {
      level: "year",
      parentId: sportId,
      force: true,
    });
  const status = (
    asAdmin: ReturnType<ReturnType<typeof convexTest>["withIdentity"]>,
    sportId: Id<"selectorOptions">,
  ) =>
    asAdmin.query(api.selectorOptions.getSelectorSyncStatus, {
      level: "year",
      parentId: sportId,
    });

  test("a done row carries the twins left, with only the ids no row holds", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN);
    const sportId = await seedSport(t);
    await seedYearRow(t, sportId, "Operator Year", { sportlots: "sl-a" });
    stubYearLists({
      sl: [["sl-a", "1997"], ["sl-b", "1997"]],
      bsc: [["bsc-97", "1997"]],
    });

    await ensure(asAdmin, sportId);

    const s = await status(asAdmin, sportId);
    expect(s?.status).toBe("done");
    expect(s?.twinsLeftTotal).toBe(1);
    // sl-a is held by "Operator Year", so only sl-b is left; the lone BSC id
    // of that name is not paired and not held, so it is listed too.
    expect(s?.twinsLeft).toEqual([
      { name: "1997", bsc: ["bsc-97"], sportlots: ["sl-b"] },
    ]);
  });

  test("the next sync that finds no twins clears the notice", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN);
    const sportId = await seedSport(t);
    stubYearLists({
      sl: [["sl-a", "1997"], ["sl-b", "1997"]],
      bsc: [],
    });
    await ensure(asAdmin, sportId);
    expect((await status(asAdmin, sportId))?.twinsLeftTotal).toBe(1);

    stubYearLists({ sl: [["sl-a", "1997"]], bsc: [] });
    await ensure(asAdmin, sportId);

    const s = await status(asAdmin, sportId);
    expect(s?.twinsLeft).toBeUndefined();
    expect(s?.twinsLeftTotal).toBeUndefined();
  });

  test("a syncing call clears the previous notice before the sync finishes", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN);
    const sportId = await seedSport(t);
    await t.mutation(
      internal.selectorOptions.setSelectorSyncStatus,
      {
        level: "year",
        parentId: sportId,
        status: "done",
        twinsLeft: [{ name: "1997", bsc: [], sportlots: ["sl-b"] }],
        twinsLeftTotal: 1,
      },
    );
    await t.mutation(
      internal.selectorOptions.setSelectorSyncStatus,
      { level: "year", parentId: sportId, status: "syncing" },
    );

    const s = await status(asAdmin, sportId);
    expect(s?.status).toBe("syncing");
    expect(s?.twinsLeft).toBeUndefined();
    expect(s?.twinsLeftTotal).toBeUndefined();
  });

  test("setSelectorSyncStatus caps the stored names at TWIN_NOTICE_LIMIT and keeps the true total", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN);
    const sportId = await seedSport(t);
    const twinsLeft = Array.from({ length: TWIN_NOTICE_LIMIT + 5 }, (_, i) => ({
      name: `n${i}`,
      bsc: [],
      sportlots: [`s${i}`],
    }));
    await t.mutation(
      internal.selectorOptions.setSelectorSyncStatus,
      {
        level: "year",
        parentId: sportId,
        status: "done",
        twinsLeft,
        twinsLeftTotal: twinsLeft.length,
      },
    );

    const s = await status(asAdmin, sportId);
    expect(s?.twinsLeft).toHaveLength(TWIN_NOTICE_LIMIT);
    expect(s?.twinsLeftTotal).toBe(TWIN_NOTICE_LIMIT + 5);
  });

  test("a clean sync leaves no done row and no notice (nothing for the operator to read)", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN);
    const sportId = await seedSport(t);
    stubYearLists({ sl: [["sl-97", "1997"]], bsc: [["bsc-97", "1997"]] });

    await ensure(asAdmin, sportId);

    expect(await status(asAdmin, sportId)).toBeNull();
  });
});

/**
 * `heldIdsForTwinNotice` swapped for a recorder: the registry entry for
 * `selectorOptions` is re-exported with that one internal query replaced, so
 * the real action calls the stand-in through `ctx.runQuery`.
 */
function modulesWithHeldRecorder(mode: { throws: boolean }) {
  const calls: Array<{ bsc: string[]; sportlots: string[] }> = [];
  const wrapped: Record<string, () => Promise<unknown>> = {
    ...modules,
    "./selectorOptions.ts": async () => {
      const real = (await modules["./selectorOptions.ts"]()) as Record<string, unknown>;
      return {
        ...real,
        heldIdsForTwinNotice: internalQuery({
          args: {
            level: v.string(),
            parentId: v.optional(v.id("selectorOptions")),
            bsc: v.array(v.string()),
            sportlots: v.array(v.string()),
          },
          handler: async (_ctx, args) => {
            calls.push({ bsc: args.bsc, sportlots: args.sportlots });
            if (mode.throws) throw new Error("holder read blew up");
            return { bsc: [] as string[], sportlots: [] as string[] };
          },
        }),
      };
    },
  };
  return { wrapped, calls };
}

describe("ensureSelectorOptions — the twin holder read (NEO-325 security re-audit)", () => {
  const ensureAs = (t: ReturnType<typeof convexTest>, sportId: Id<"selectorOptions">) =>
    t.withIdentity(ADMIN).action(api.selectorOptions.ensureSelectorOptions, {
      level: "year",
      parentId: sportId,
      force: true,
    });
  const statusOf = (t: ReturnType<typeof convexTest>, sportId: Id<"selectorOptions">) =>
    t.withIdentity(ADMIN).query(api.selectorOptions.getSelectorSyncStatus, {
      level: "year",
      parentId: sportId,
    });

  test("a throwing holder read leaves the sync succeeding, with EVERY twin id listed and only counts logged", async () => {
    const { wrapped, calls } = modulesWithHeldRecorder({ throws: true });
    const t = convexTest(schema, wrapped);
    const sportId = await seedSport(t);
    // Held by an operator row: with a working read it would NOT be listed.
    await seedYearRow(t, sportId, "Operator Year", { sportlots: "sl-a" });
    stubYearLists({
      sl: [["sl-a", "1997"], ["sl-b", "1997"], ["sl-98", "1998"]],
      bsc: [["bsc-98", "1998"]],
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await ensureAs(t, sportId);

    expect(calls).toHaveLength(1);
    const s = await statusOf(t, sportId);
    expect(s?.status).toBe("done");
    expect(s?.twinsLeft).toEqual([{ name: "1997", bsc: [], sportlots: ["sl-a", "sl-b"] }]);
    expect(s?.twinsLeftTotal).toBe(1);
    const line = warn.mock.calls
      .map((c) => String(c[0]))
      .find((l) => l.includes("selector_sync_twin_holders_failed"));
    expect(line).toBeDefined();
    for (const secret of ["sl-a", "sl-b", "1997", "holder read blew up"]) {
      expect(line).not.toContain(secret);
    }
    // The data the sync wrote before the read is still there.
    const rows = await t.run((ctx) =>
      ctx.db.query("selectorOptions").collect(),
    );
    expect(rows.some((r) => r.level === "year" && r.value === "1998")).toBe(true);
  });

  test("ids past the length ceiling never reach the holder read, and are not in the notice", async () => {
    const { wrapped, calls } = modulesWithHeldRecorder({ throws: false });
    const t = convexTest(schema, wrapped);
    const sportId = await seedSport(t);
    const longSl = "s".repeat(MAX_TWIN_NOTICE_ID_LENGTH.sportlots + 1);
    const longBsc = "b".repeat(MAX_TWIN_NOTICE_ID_LENGTH.bsc + 1);
    stubYearLists({
      sl: [["sl-a", "1997"], ["sl-b", "1997"], [longSl, "1997"]],
      bsc: [["bsc-a", "1997"], [longBsc, "1997"]],
    });

    await ensureAs(t, sportId);

    expect(calls).toHaveLength(1);
    expect(calls[0].sportlots.sort()).toEqual(["sl-a", "sl-b"]);
    expect(calls[0].bsc).toEqual(["bsc-a"]);
    const s = await statusOf(t, sportId);
    expect(s?.twinsLeft).toEqual([
      { name: "1997", bsc: ["bsc-a"], sportlots: ["sl-a", "sl-b"] },
    ]);
  });

  test("a BSC twin whose label carries a control character is not in the notice, and the clean twin beside it is", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    stubYearLists({
      sl: [["sl-a", "1997"], ["sl-b", "1997"]],
      bsc: [["bsc-x", "Bad\u0007Year"], ["bsc-y", "Bad\u0007Year"]],
    });

    const result = await t
      .withIdentity(ADMIN)
      .action(api.selectorOptions.fetchAggregatedOptions, {
        level: "year",
        parentId: sportId,
        parentFilters: { sport: "Hockey" },
      });
    await ensureAs(t, sportId);

    expect(result.success).toBe(true);
    const s = await statusOf(t, sportId);
    expect(s?.twinsLeft?.map((e) => e.name)).toEqual(["1997"]);
    expect(JSON.stringify(s?.twinsLeft)).not.toContain("bsc-x");
    expect(JSON.stringify(s?.twinsLeft)).not.toContain("\u0007");
  });
});
