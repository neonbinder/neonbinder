/**
 * NEO-237 (D3) — `setReconciliation.ts` passes the manufacturer ancestor's
 * `metadata.setNamePrefix` down to the SportLots adapter as `brandScope`, on
 * BOTH doors that read SportLots: `fetchRawOptions` (Inserts/Variant/Parallel
 * forms) and `fetchSlAttachSets` (`resolveAttachContext` carries it as
 * `slSetNamePrefix`).
 *
 * The adapter itself only ACTS on `brandScope` when the request's `brd` is
 * SportLots' all-brands sentinel (`convex/adapters/sportlots.test.ts` pins
 * that) — so this file's job is narrower and complementary: prove the PREFIX
 * IS SENT regardless of whether the manufacturer is linked via All Brands or
 * carries its own real SportLots brand id. Mocks the adapter action (rather
 * than stubbing `fetch`) so the assertion is directly on the args crossing
 * the Convex↔adapter boundary, per the `platformLevelSupport.test.ts` /
 * mocked-adapter house pattern.
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
  subject: "admin_neo237_brandscope",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_neo237_brandscope",
  role: "admin",
};

const SENTINEL = 1_000_000;

/** Captured args of every `fetchSportLotsSelectorOptions` call this file makes. */
let calls: Array<Record<string, unknown>> = [];

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
        brandScope: v.optional(v.object({ setNamePrefix: v.string() })),
        requestId: v.optional(v.string()),
      },
      returns: v.any(),
      handler: async (_ctx, args) => {
        calls.push(args as Record<string, unknown>);
        return { success: true, options: [] };
      },
    }),
  };
});

beforeEach(() => {
  calls = [];
  vi.spyOn(console, "log").mockImplementation(() => {});
});

/**
 * sport → year → manufacturer → setName → variantType, every level carrying
 * an SL id (a setName row with no marketplace link anywhere at or below it
 * makes `resolvableSides` treat SportLots as unresolvable too — the "unlinked
 * set" rule — so the leaf variantType row (Base) carries the set's own SL id,
 * the shape a real Base row has).
 */
async function seedChain(
  t: ReturnType<typeof convexTest>,
  manufacturerOpts: { slId?: string; prefix?: string },
) {
  return t.run(async (ctx) => {
    const sportId = await ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Hockey",
      sportConfig: { skuCode: "HK", league: "NHL" },
      platformData: { sportlots: { s0: "HK" } },
      platformSlotSeq: { sportlots: 1 },
      children: [],
      lastUpdated: SENTINEL,
    });
    const yearId = await ctx.db.insert("selectorOptions", {
      level: "year",
      value: "1997",
      platformData: { sportlots: { s0: "1997" } },
      platformSlotSeq: { sportlots: 1 },
      parentId: sportId,
      children: [],
      lastUpdated: SENTINEL,
    });
    const manufacturerId = await ctx.db.insert("selectorOptions", {
      level: "manufacturer",
      value: "Topps",
      platformData: manufacturerOpts.slId
        ? { sportlots: { s0: manufacturerOpts.slId } }
        : {},
      ...(manufacturerOpts.slId ? { platformSlotSeq: { sportlots: 1 } } : {}),
      metadata:
        manufacturerOpts.prefix !== undefined
          ? { setNamePrefix: manufacturerOpts.prefix }
          : {},
      parentId: yearId,
      children: [],
      lastUpdated: SENTINEL,
    });
    const setNameId = await ctx.db.insert("selectorOptions", {
      level: "setName",
      value: "Series 1",
      platformData: {},
      parentId: manufacturerId,
      children: [],
      lastUpdated: SENTINEL,
    });
    const variantTypeId = await ctx.db.insert("selectorOptions", {
      level: "variantType",
      value: "Base",
      metadata: { isBase: true },
      platformData: { sportlots: { s0: "501" } },
      platformSlotSeq: { sportlots: 1 },
      parentId: setNameId,
      children: [],
      lastUpdated: SENTINEL,
    });
    await ctx.db.patch(sportId, { children: [yearId] });
    await ctx.db.patch(yearId, { children: [manufacturerId] });
    await ctx.db.patch(manufacturerId, { children: [setNameId] });
    await ctx.db.patch(setNameId, { children: [variantTypeId] });
    return { sportId, yearId, manufacturerId, setNameId, variantTypeId };
  });
}

describe("fetchRawOptions passes brandScope from the manufacturer ancestor", () => {
  test("a via-All-Brands manufacturer (SL id = the sentinel) passes its prefix", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN);
    const { variantTypeId } = await seedChain(t, {
      slId: "All Brands",
      prefix: "Bandai",
    });

    await asAdmin.action(api.setReconciliation.fetchRawOptions, {
      level: "insert",
      parentId: variantTypeId as Id<"selectorOptions">,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].brandScope).toEqual({ setNamePrefix: "Bandai" });
  });

  test("a Topps-style ancestor with its OWN real SL id still passes the prefix — the adapter is what ignores it", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN);
    const { variantTypeId } = await seedChain(t, { slId: "1", prefix: "Topps" });

    await asAdmin.action(api.setReconciliation.fetchRawOptions, {
      level: "insert",
      parentId: variantTypeId as Id<"selectorOptions">,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].brandScope).toEqual({ setNamePrefix: "Topps" });
  });

  test("a manufacturer with no setNamePrefix sends no brandScope at all", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN);
    const { variantTypeId } = await seedChain(t, { slId: "1" });

    await asAdmin.action(api.setReconciliation.fetchRawOptions, {
      level: "insert",
      parentId: variantTypeId as Id<"selectorOptions">,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].brandScope).toBeUndefined();
  });
});

describe("fetchSlAttachSets / resolveAttachContext carry slSetNamePrefix through to brandScope", () => {
  test("a via-All-Brands manufacturer's prefix reaches the adapter call", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN);
    const { variantTypeId } = await seedChain(t, {
      slId: "All Brands",
      prefix: "Bandai",
    });

    await asAdmin.action(api.setReconciliation.fetchSlAttachSets, {
      selectorOptionId: variantTypeId as Id<"selectorOptions">,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].brandScope).toEqual({ setNamePrefix: "Bandai" });
    expect(calls[0].level).toBe("insert");
  });

  test("a real-brand ancestor still carries its prefix through resolveAttachContext", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN);
    const { variantTypeId } = await seedChain(t, { slId: "1", prefix: "Topps" });

    await asAdmin.action(api.setReconciliation.fetchSlAttachSets, {
      selectorOptionId: variantTypeId as Id<"selectorOptions">,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].brandScope).toEqual({ setNamePrefix: "Topps" });
  });

  test("no setNamePrefix on the manufacturer → no brandScope sent", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN);
    const { variantTypeId } = await seedChain(t, { slId: "1" });

    await asAdmin.action(api.setReconciliation.fetchSlAttachSets, {
      selectorOptionId: variantTypeId as Id<"selectorOptions">,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].brandScope).toBeUndefined();
  });
});
