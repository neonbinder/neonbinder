/**
 * PR 451 (NEO-487) — the client's `waitKey` reaches the BSC adapter from
 * every action a "Waiting on BuySportsCards…" surface calls:
 *
 *   - `ensureSelectorOptions` (the column Sync) → `fetchAggregatedOptions` /
 *     `syncSetsAcrossManufacturers` → `fetchBscSelectorOptions`
 *   - `setReconciliation.fetchRawOptions` (Base picker, insert/parallel
 *     reconcile) → `fetchBscSelectorOptions`
 *   - `setReconciliation.fetchBscAttachOptions` (Attach Sets' BSC pane) →
 *     `fetchBscSelectorOptions`
 *   - `baseMatchProbe.probeBscSets` (the Base match probe) →
 *     `probeBscChecklistBatch`
 *
 * Each validates the key's shape AFTER the admin gate and refuses a
 * malformed one; absent, nothing is passed down. The adapter is
 * module-mocked to record what it was handed, so nothing here reaches a
 * marketplace (NEO-247). That the adapter writes the rows is pinned in
 * `marketplaceWaits.selectorFetch.test.ts` and `baseMatchProbe.test.ts`.
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";

const mockState = vi.hoisted(() => ({
  selectorWaitKeys: [] as Array<string | undefined>,
  probeWaitKeys: [] as Array<string | undefined>,
}));

vi.mock("./adapters/buysportscards", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./adapters/buysportscards")>();
  const { action, internalAction } = await import("./_generated/server");
  const { v } = await import("convex/values");
  return {
    ...actual,
    fetchBscSelectorOptions: action({
      args: {
        level: v.string(),
        parentFilters: v.object({
          sport: v.optional(v.string()),
          year: v.optional(v.string()),
          manufacturer: v.optional(v.string()),
          setName: v.optional(v.string()),
          variantType: v.optional(v.string()),
        }),
        platformFilters: v.optional(v.record(v.string(), v.array(v.string()))),
        requestId: v.optional(v.string()),
        waitKey: v.optional(v.string()),
      },
      returns: v.object({
        success: v.boolean(),
        options: v.array(v.object({ value: v.string(), platformValue: v.string() })),
        message: v.optional(v.string()),
      }),
      handler: async (_ctx, args) => {
        mockState.selectorWaitKeys.push(args.waitKey);
        return { success: true, options: [] };
      },
    }),
    probeBscChecklistBatch: internalAction({
      args: { requests: v.array(v.any()), waitKey: v.optional(v.string()) },
      returns: v.array(v.any()),
      handler: async (_ctx, args) => {
        mockState.probeWaitKeys.push(args.waitKey);
        return (args.requests as Array<{ id: string }>).map((r) => ({
          id: r.id,
          status: "ok",
          count: 0,
        }));
      },
    }),
  };
});

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN = {
  subject: "admin_neo487_thread",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_neo487_thread",
  name: "Admin User",
  role: "admin",
};
const NON_ADMIN = {
  subject: "user_neo487_thread",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|user_neo487_thread",
  name: "Plain User",
};

const KEY = "run_487-thread";
const BAD = "not a key!";

beforeEach(() => {
  mockState.selectorWaitKeys = [];
  mockState.probeWaitKeys = [];
  for (const m of ["log", "warn", "error", "info"] as const) {
    vi.spyOn(console, m).mockImplementation(() => {});
  }
});
afterEach(() => vi.restoreAllMocks());

type T = ReturnType<typeof convexTest>;

/**
 * Baseball / 2024 / Topps / Topps Chrome / { Parallel }, with BSC ids from the
 * sport down to the set and the parallel type's own `variant` facet, and NO
 * SportLots ids anywhere (that side is skipped, never asked).
 */
async function seed(t: T) {
  return t.run(async (ctx) => {
    const ins = (f: Record<string, unknown>) =>
      ctx.db.insert("selectorOptions", {
        platformData: {},
        children: [],
        lastUpdated: 1,
        ...f,
      } as never) as Promise<Id<"selectorOptions">>;
    const sport = await ins({ level: "sport", value: "Baseball", platformData: { bsc: { b0: "baseball" } } });
    const year = await ins({ level: "year", value: "2024", parentId: sport, platformData: { bsc: { b0: "2024" } } });
    const brand = await ins({ level: "manufacturer", value: "Topps", parentId: year });
    const set = await ins({
      level: "setName",
      value: "Topps Chrome",
      parentId: brand,
      platformData: { bsc: { b0: "topps-chrome" } },
    });
    const parallel = await ins({
      level: "variantType",
      value: "Parallel",
      parentId: set,
      platformData: { bsc: { b0: "parallel" } },
      platformFacets: { bsc: { b0: "variant" } },
    });
    return { sport, year, brand, set, parallel };
  });
}

const asAdmin = (t: T) => t.withIdentity(ADMIN);

describe("the column Sync: ensureSelectorOptions", () => {
  test("a year column passes the key through fetchAggregatedOptions to the BSC fetch", async () => {
    const t = convexTest(schema, modules);
    const { sport } = await seed(t);

    await asAdmin(t).action(api.selectorOptions.ensureSelectorOptions, {
      level: "year",
      parentId: sport,
      force: true,
      waitKey: KEY,
    });

    expect(mockState.selectorWaitKeys).toEqual([KEY]);
  });

  test("a sets column passes the key through syncSetsAcrossManufacturers to the BSC fetch", async () => {
    const t = convexTest(schema, modules);
    const { brand } = await seed(t);

    await asAdmin(t).action(api.selectorOptions.ensureSelectorOptions, {
      level: "setName",
      parentId: brand,
      force: true,
      waitKey: KEY,
    });

    expect(mockState.selectorWaitKeys).toEqual([KEY]);
  });

  test("no key: none is passed down", async () => {
    const t = convexTest(schema, modules);
    const { sport } = await seed(t);

    await asAdmin(t).action(api.selectorOptions.ensureSelectorOptions, {
      level: "year",
      parentId: sport,
      force: true,
    });

    expect(mockState.selectorWaitKeys).toEqual([undefined]);
  });

  test("a malformed key is refused before any marketplace call", async () => {
    const t = convexTest(schema, modules);
    const { sport } = await seed(t);

    await expect(
      asAdmin(t).action(api.selectorOptions.ensureSelectorOptions, {
        level: "year",
        parentId: sport,
        force: true,
        waitKey: BAD,
      }),
    ).rejects.toThrow(/waitKey/);
    expect(mockState.selectorWaitKeys).toEqual([]);
  });
});

describe("the legacy drill forms' actions", () => {
  test("fetchAggregatedOptions passes the key to the BSC fetch", async () => {
    const t = convexTest(schema, modules);
    const { sport } = await seed(t);

    await asAdmin(t).action(api.selectorOptions.fetchAggregatedOptions, {
      level: "year",
      parentId: sport,
      parentFilters: { sport: "Baseball" },
      waitKey: KEY,
    });

    expect(mockState.selectorWaitKeys).toEqual([KEY]);
  });

  test("syncSetsAcrossManufacturers passes the key to the BSC fetch", async () => {
    const t = convexTest(schema, modules);
    const { year } = await seed(t);

    await asAdmin(t).action(api.selectorOptions.syncSetsAcrossManufacturers, {
      yearId: year,
      waitKey: KEY,
    });

    expect(mockState.selectorWaitKeys).toEqual([KEY]);
  });

  test("fetchAggregatedOptions refuses a malformed key", async () => {
    const t = convexTest(schema, modules);
    const { sport } = await seed(t);

    await expect(
      asAdmin(t).action(api.selectorOptions.fetchAggregatedOptions, {
        level: "year",
        parentId: sport,
        parentFilters: { sport: "Baseball" },
        waitKey: BAD,
      }),
    ).rejects.toThrow(/waitKey/);
    expect(mockState.selectorWaitKeys).toEqual([]);
  });

  test("syncSetsAcrossManufacturers refuses a malformed key", async () => {
    const t = convexTest(schema, modules);
    const { year } = await seed(t);

    await expect(
      asAdmin(t).action(api.selectorOptions.syncSetsAcrossManufacturers, {
        yearId: year,
        waitKey: BAD,
      }),
    ).rejects.toThrow(/waitKey/);
    expect(mockState.selectorWaitKeys).toEqual([]);
  });
});

describe("the Base picker and insert/parallel reconcile: fetchRawOptions", () => {
  test("passes the key to the BSC fetch", async () => {
    const t = convexTest(schema, modules);
    const { parallel } = await seed(t);

    await asAdmin(t).action(api.setReconciliation.fetchRawOptions, {
      level: "insert",
      parentId: parallel,
      parentFilters: { sport: "Baseball", year: "2024", manufacturer: "Topps", setName: "Topps Chrome", variantType: "Parallel" },
      waitKey: KEY,
    });

    expect(mockState.selectorWaitKeys).toEqual([KEY]);
  });

  test("refuses a malformed key", async () => {
    const t = convexTest(schema, modules);
    const { parallel } = await seed(t);

    await expect(
      asAdmin(t).action(api.setReconciliation.fetchRawOptions, {
        level: "insert",
        parentId: parallel,
        waitKey: BAD,
      }),
    ).rejects.toThrow(/waitKey/);
    expect(mockState.selectorWaitKeys).toEqual([]);
  });
});

describe("Attach Sets' BSC pane: fetchBscAttachOptions", () => {
  test("passes the key to the BSC fetch", async () => {
    const t = convexTest(schema, modules);
    const { parallel } = await seed(t);

    await asAdmin(t).action(api.setReconciliation.fetchBscAttachOptions, {
      selectorOptionId: parallel,
      view: "sets",
      waitKey: KEY,
    });

    expect(mockState.selectorWaitKeys).toEqual([KEY]);
  });

  test("refuses a malformed key", async () => {
    const t = convexTest(schema, modules);
    const { parallel } = await seed(t);

    await expect(
      asAdmin(t).action(api.setReconciliation.fetchBscAttachOptions, {
        selectorOptionId: parallel,
        view: "sets",
        waitKey: BAD,
      }),
    ).rejects.toThrow(/waitKey/);
    expect(mockState.selectorWaitKeys).toEqual([]);
  });
});

describe("the Base match probe: probeBscSets", () => {
  test("passes the key to the checklist batch", async () => {
    const t = convexTest(schema, modules);
    const { parallel } = await seed(t);

    await asAdmin(t).action(api.baseMatchProbe.probeBscSets, {
      variantTypeId: parallel,
      variantNameIds: ["gold"],
      waitKey: KEY,
    });

    expect(mockState.probeWaitKeys).toEqual([KEY]);
  });

  test("no key: none is passed down", async () => {
    const t = convexTest(schema, modules);
    const { parallel } = await seed(t);

    await asAdmin(t).action(api.baseMatchProbe.probeBscSets, {
      variantTypeId: parallel,
      variantNameIds: ["gold"],
    });

    expect(mockState.probeWaitKeys).toEqual([undefined]);
  });

  test("refuses a malformed key", async () => {
    const t = convexTest(schema, modules);
    const { parallel } = await seed(t);

    await expect(
      asAdmin(t).action(api.baseMatchProbe.probeBscSets, {
        variantTypeId: parallel,
        variantNameIds: ["gold"],
        waitKey: BAD,
      }),
    ).rejects.toThrow(/waitKey/);
    expect(mockState.probeWaitKeys).toEqual([]);
  });
});

describe("the admin gate comes first", () => {
  test.each([
    ["ensureSelectorOptions", (t: T, ids: Awaited<ReturnType<typeof seed>>) =>
      t.withIdentity(NON_ADMIN).action(api.selectorOptions.ensureSelectorOptions, { level: "year", parentId: ids.sport, waitKey: BAD })],
    ["fetchAggregatedOptions", (t: T, ids: Awaited<ReturnType<typeof seed>>) =>
      t.withIdentity(NON_ADMIN).action(api.selectorOptions.fetchAggregatedOptions, { level: "year", parentId: ids.sport, waitKey: BAD })],
    ["syncSetsAcrossManufacturers", (t: T, ids: Awaited<ReturnType<typeof seed>>) =>
      t.withIdentity(NON_ADMIN).action(api.selectorOptions.syncSetsAcrossManufacturers, { yearId: ids.year, waitKey: BAD })],
    ["fetchRawOptions", (t: T, ids: Awaited<ReturnType<typeof seed>>) =>
      t.withIdentity(NON_ADMIN).action(api.setReconciliation.fetchRawOptions, { level: "insert", parentId: ids.parallel, waitKey: BAD })],
    ["fetchBscAttachOptions", (t: T, ids: Awaited<ReturnType<typeof seed>>) =>
      t.withIdentity(NON_ADMIN).action(api.setReconciliation.fetchBscAttachOptions, { selectorOptionId: ids.parallel, view: "sets", waitKey: BAD })],
    ["probeBscSets", (t: T, ids: Awaited<ReturnType<typeof seed>>) =>
      t.withIdentity(NON_ADMIN).action(api.baseMatchProbe.probeBscSets, { variantTypeId: ids.parallel, variantNameIds: ["gold"], waitKey: BAD })],
  ])("%s: a non-admin with a malformed key is told it is not an admin", async (_name, call) => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);

    await expect(call(t, ids)).rejects.toThrow(/Admin access required/);
  });
});
