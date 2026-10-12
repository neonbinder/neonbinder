/**
 * NEO-339 — `setReconciliation.previewSetStructure`, the read-only structure
 * preview `nb_draft_set` drafts a set from.
 *
 * Pinned here:
 *   - it writes nothing (every table compared before and after);
 *   - over a VIRTUAL variant type it returns what `fetchRawOptions` returns
 *     under the REAL row the sync would create, field for field;
 *   - roles come from BSC's own ids by the store's rules (sole base, token
 *     rule, fail-closed), and only Base / Insert / Parallel types are fetched;
 *   - every marketplace filter it sends is an id from a slot (or the id BSC
 *     just returned), never an NB display value;
 *   - a Base SportLots pick is accepted by id only, from the Base candidates
 *     it fetched, and is then dropped from the other types' lists by id.
 *
 * The adapters are mocked at the Convex boundary (the brandScope test's
 * pattern), so the assertions are on the args that cross it.
 */

import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";

const modules = (
  import.meta as unknown as {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("./**/*.*s");

const ADMIN = {
  subject: "admin_neo339_structure",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_neo339_structure",
  role: "admin",
};
const SIGNED_IN = { subject: "user_neo339_structure" };

type Item = { value: string; platformValue: string };
type Call = {
  level: string;
  platformFilters?: Record<string, unknown>;
  parentFilters?: Record<string, unknown>;
};

const state = vi.hoisted(() => ({
  bscCalls: [] as Call[],
  slCalls: [] as Call[],
  /** BSC `variant` facet values for the set. */
  variants: [] as Item[],
  /** BSC `variantName` values per `variant` id. */
  variantNames: {} as Record<string, Item[]>,
  /** SportLots' flat set list for the brand-year. */
  slSets: [] as Item[],
  failVariantList: false,
}));

vi.mock("./adapters/buysportscards", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./adapters/buysportscards")>();
  const { action } = await import("./_generated/server");
  const { v } = await import("convex/values");
  return {
    ...actual,
    fetchBscSelectorOptions: action({
      args: {
        level: v.string(),
        parentFilters: v.any(),
        platformFilters: v.optional(v.any()),
        requestId: v.optional(v.string()),
      },
      returns: v.any(),
      handler: async (_ctx, args) => {
        state.bscCalls.push(args as Call);
        if (args.level === "variantType") {
          if (state.failVariantList) {
            return { success: false, options: [], message: "unreachable" };
          }
          return { success: true, options: state.variants };
        }
        const variant = (args.platformFilters?.variantType ?? [])[0] as
          | string
          | undefined;
        return {
          success: true,
          options: (variant && state.variantNames[variant]) || [],
        };
      },
    }),
  };
});

vi.mock("./adapters/sportlots", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./adapters/sportlots")>();
  const { action } = await import("./_generated/server");
  const { v } = await import("convex/values");
  return {
    ...actual,
    fetchSportLotsSelectorOptions: action({
      args: {
        level: v.string(),
        parentFilters: v.any(),
        platformFilters: v.optional(v.any()),
        labelContext: v.optional(v.any()),
        brandScope: v.optional(v.any()),
        requestId: v.optional(v.string()),
      },
      returns: v.any(),
      handler: async (_ctx, args) => {
        state.slCalls.push(args as Call);
        return { success: true, options: state.slSets };
      },
    }),
  };
});

beforeEach(() => {
  state.bscCalls = [];
  state.slCalls = [];
  state.failVariantList = false;
  state.variants = [
    { value: "Base", platformValue: "base" },
    { value: "Insert", platformValue: "insert" },
    { value: "Parallel", platformValue: "parallel" },
    { value: "Promo", platformValue: "promo" },
  ];
  state.variantNames = {
    base: [],
    insert: [
      { value: "Anime", platformValue: "anime" },
      { value: "Youthquake", platformValue: "youthquake" },
    ],
    parallel: [{ value: "Gold Wave Refractor", platformValue: "gold-wave" }],
  };
  state.slSets = [
    { value: "Topps Chrome", platformValue: "100" },
    { value: "Topps Chrome Anime", platformValue: "101" },
    { value: "Topps Chrome Youthquake", platformValue: "102" },
    { value: "Topps Chrome Gold Wave Refractor", platformValue: "103" },
  ];
  vi.spyOn(console, "log").mockImplementation(() => {});
});

const T = 1_700_000_000_000;

/** sport → year → manufacturer → setName, ids where a real synced set has them. */
async function seedSet(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => {
    const sportId = await ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Baseball",
      sportConfig: { skuCode: "BB", league: "MLB" },
      platformData: { bsc: { b0: "baseball" }, sportlots: { s0: "BB" } },
      platformSlotSeq: { bsc: 1, sportlots: 1 },
      children: [],
      lastUpdated: T,
    });
    const yearId = await ctx.db.insert("selectorOptions", {
      level: "year",
      value: "2024",
      platformData: { bsc: { b0: "2024" }, sportlots: { s0: "2024" } },
      platformSlotSeq: { bsc: 1, sportlots: 1 },
      parentId: sportId,
      children: [],
      lastUpdated: T,
    });
    const mfrId = await ctx.db.insert("selectorOptions", {
      level: "manufacturer",
      value: "Topps",
      platformData: { sportlots: { s0: "TP" } },
      platformSlotSeq: { sportlots: 1 },
      parentId: yearId,
      children: [],
      lastUpdated: T,
    });
    const setId = await ctx.db.insert("selectorOptions", {
      level: "setName",
      value: "Chrome",
      platformData: { bsc: { b0: "2024-topps-chrome" } },
      platformSlotSeq: { bsc: 1 },
      parentId: mfrId,
      children: [],
      lastUpdated: T,
    });
    return { sportId, yearId, mfrId, setId };
  });
}

/** A variant-type row exactly as the variant-type sync writes one. */
async function seedVariantType(
  t: ReturnType<typeof convexTest>,
  setId: Id<"selectorOptions">,
  bscVariantId: string,
  label: string,
  metadata: { isBase?: boolean; variantRole?: "insert" | "parallel" },
  sportlots?: { id: string; label: string },
) {
  return t.run(async (ctx) =>
    ctx.db.insert("selectorOptions", {
      level: "variantType",
      value: label,
      platformData: {
        bsc: { b0: bscVariantId },
        ...(sportlots ? { sportlots: { s0: sportlots.id } } : {}),
      },
      ...(sportlots
        ? { platformLabels: { sportlots: { s0: sportlots.label } } }
        : {}),
      platformFacets: { bsc: { b0: "variant" } },
      platformSlotSeq: { bsc: 1, ...(sportlots ? { sportlots: 1 } : {}) },
      metadata,
      parentId: setId,
      children: [],
      lastUpdated: T,
    }),
  );
}

/** Every document in every table, for a zero-writes comparison. */
async function snapshotAll(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => {
    const out: Record<string, unknown[]> = {};
    for (const table of Object.keys(schema.tables)) {
      out[table] = await ctx.db.query(table as "selectorOptions").collect();
    }
    return out;
  });
}

describe("previewSetStructure", () => {
  test("refuses a signed-in non-admin", async () => {
    const t = convexTest(schema, modules);
    const { setId } = await seedSet(t);
    await expect(
      t.withIdentity(SIGNED_IN).action(api.setReconciliation.previewSetStructure, {
        setId,
      }),
    ).rejects.toThrow(/Admin access required/);
    expect(state.bscCalls).toHaveLength(0);
  });

  test("refuses an id that is not a set row, before any marketplace call", async () => {
    const t = convexTest(schema, modules);
    const { yearId } = await seedSet(t);
    await expect(
      t.withIdentity(ADMIN).action(api.setReconciliation.previewSetStructure, {
        setId: yearId,
      }),
    ).rejects.toThrow(/not a set/);
    expect(state.bscCalls).toHaveLength(0);
    expect(state.slCalls).toHaveLength(0);
  });

  test("writes nothing, confers roles from BSC's ids, fetches only Base/Insert/Parallel", async () => {
    const t = convexTest(schema, modules);
    const { setId } = await seedSet(t);
    const before = await snapshotAll(t);

    const res = await t
      .withIdentity(ADMIN)
      .action(api.setReconciliation.previewSetStructure, { setId });

    expect(await snapshotAll(t)).toEqual(before);
    expect(res.success).toBe(true);
    expect(res.types.map((x) => [x.bscVariantId, x.role])).toEqual([
      ["base", "base"],
      ["insert", "insert"],
      ["parallel", "parallel"],
      ["promo", null],
    ]);
    expect(res.types.find((x) => x.role === null)?.candidates).toBeUndefined();
    expect(
      res.types
        .find((x) => x.role === "insert")
        ?.candidates?.bscOptions.map((o) => o.platformValue),
    ).toEqual(["anime", "youthquake"]);
    // 1 variant-type list + (BSC + SportLots) for each of three typed types.
    expect(res.marketplaceCalls).toBe(7);
    expect(state.bscCalls).toHaveLength(4);
    expect(state.slCalls).toHaveLength(3);
    expect(res.baseSportlots).toBeUndefined();
  });

  test("every filter sent is an id from a slot or from BSC's own answer, never an NB name", async () => {
    const t = convexTest(schema, modules);
    const { setId } = await seedSet(t);
    await t
      .withIdentity(ADMIN)
      .action(api.setReconciliation.previewSetStructure, { setId });

    const ids = new Set([
      "baseball",
      "2024",
      "2024-topps-chrome",
      "base",
      "insert",
      "parallel",
      "BB",
      "TP",
    ]);
    for (const call of [...state.bscCalls, ...state.slCalls]) {
      for (const value of Object.values(call.platformFilters ?? {})) {
        for (const id of Array.isArray(value) ? value : [value]) {
          expect(ids.has(id as string)).toBe(true);
        }
      }
    }
    // The insert-level BSC calls are scoped by the variant id BSC returned.
    const scoped = state.bscCalls
      .filter((c) => c.level === "insert")
      .map((c) => (c.platformFilters?.variantType as string[])[0]);
    expect(scoped).toEqual(["base", "insert", "parallel"]);
  });

  test("a type's candidates equal fetchRawOptions under the real row the sync would create", async () => {
    const t = convexTest(schema, modules);
    const { setId } = await seedSet(t);
    const preview = await t
      .withIdentity(ADMIN)
      .action(api.setReconciliation.previewSetStructure, { setId });

    // Now the rows the variant-type sync would write, and the dialogs' fetch.
    await seedVariantType(t, setId, "base", "Base", { isBase: true });
    const insertTypeId = await seedVariantType(t, setId, "insert", "Insert", {
      variantRole: "insert",
    });
    const parallelTypeId = await seedVariantType(t, setId, "parallel", "Parallel", {
      variantRole: "parallel",
    });
    const filters = {
      sport: "Baseball",
      year: "2024",
      manufacturer: "Topps",
      setName: "Chrome",
    };
    for (const [typeId, role] of [
      [insertTypeId, "insert"],
      [parallelTypeId, "parallel"],
    ] as const) {
      const real = await t
        .withIdentity(ADMIN)
        .action(api.setReconciliation.fetchRawOptions, {
          level: "insert",
          parentId: typeId,
          parentFilters: { ...filters, variantType: role },
        });
      expect(preview.types.find((x) => x.role === role)?.candidates).toEqual(real);
    }
  });

  test("a Base SportLots pick is taken by id and dropped from the other types' lists", async () => {
    const t = convexTest(schema, modules);
    const { setId } = await seedSet(t);
    const res = await t
      .withIdentity(ADMIN)
      .action(api.setReconciliation.previewSetStructure, {
        setId,
        baseSportlotsId: "100",
      });
    expect(res.success).toBe(true);
    expect(res.baseSportlots).toEqual({
      id: "100",
      label: "Topps Chrome",
      source: "argument",
    });
    const base = res.types.find((x) => x.role === "base")!;
    expect(base.candidates?.slOptions.map((o) => o.platformValue)).toContain("100");
    const insert = res.types.find((x) => x.role === "insert")!;
    expect(insert.candidates?.slOptions.map((o) => o.platformValue)).not.toContain(
      "100",
    );

    // Same answer the Reconcile dialog gets once the Base row carries that set.
    await seedVariantType(t, setId, "base", "Base", { isBase: true }, {
      id: "100",
      label: "Topps Chrome",
    });
    const insertTypeId = await seedVariantType(t, setId, "insert", "Insert", {
      variantRole: "insert",
    });
    const real = await t
      .withIdentity(ADMIN)
      .action(api.setReconciliation.fetchRawOptions, {
        level: "insert",
        parentId: insertTypeId,
        parentFilters: {
          sport: "Baseball",
          year: "2024",
          manufacturer: "Topps",
          setName: "Chrome",
          variantType: "Insert",
        },
        baseSlPrefix: "Topps Chrome",
      });
    expect(insert.candidates).toEqual(real);
  });

  test("an existing Base row's SportLots set is used when no pick is passed", async () => {
    const t = convexTest(schema, modules);
    const { setId } = await seedSet(t);
    await seedVariantType(t, setId, "base", "Base", { isBase: true }, {
      id: "100",
      label: "Topps Chrome",
    });
    const res = await t
      .withIdentity(ADMIN)
      .action(api.setReconciliation.previewSetStructure, { setId });
    expect(res.baseSportlots).toEqual({
      id: "100",
      label: "Topps Chrome",
      source: "existingBase",
    });
    const insert = res.types.find((x) => x.role === "insert")!;
    expect(insert.candidates?.slOptions.map((o) => o.platformValue)).not.toContain(
      "100",
    );
  });

  test("a Base pick that is not among the Base candidates is refused, never matched", async () => {
    const t = convexTest(schema, modules);
    const { setId } = await seedSet(t);
    const res = await t
      .withIdentity(ADMIN)
      .action(api.setReconciliation.previewSetStructure, {
        setId,
        baseSportlotsId: "999",
      });
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/not one of this set's Base candidates/);
    // Nothing past the Base fetch: no insert/parallel fetch on a refused pick.
    expect(res.types.find((x) => x.role === "insert")?.candidates).toBeUndefined();
  });

  test("two BSC base ids confer no base role (sole-base rule, fail-closed)", async () => {
    const t = convexTest(schema, modules);
    const { setId } = await seedSet(t);
    state.variants = [
      { value: "Base", platformValue: "base" },
      { value: "Base Set", platformValue: "base-set" },
      { value: "Insert Parallel", platformValue: "insert-parallel" },
    ];
    const res = await t
      .withIdentity(ADMIN)
      .action(api.setReconciliation.previewSetStructure, { setId });
    expect(res.types.map((x) => x.role)).toEqual([null, null, null]);
    expect(res.marketplaceCalls).toBe(1);
  });

  test("a BSC failure on the variant-type list is a failed preview, not an empty set", async () => {
    const t = convexTest(schema, modules);
    const { setId } = await seedSet(t);
    state.failVariantList = true;
    const res = await t
      .withIdentity(ADMIN)
      .action(api.setReconciliation.previewSetStructure, { setId });
    expect(res.success).toBe(false);
    expect(res.variantTypes.errors.map((e) => e.platform)).toEqual(["bsc"]);
    expect(res.types).toEqual([]);
  });
});
