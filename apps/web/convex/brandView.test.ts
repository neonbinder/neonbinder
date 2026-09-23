/**
 * NEO-237 (D1, D9, D17) — `brandView.ts`: the All Brands view's read
 * (`getSetsUnderYear`) and the brand's set-name prefix write
 * (`setSelectorOptionSetNamePrefix`), including the re-home it triggers.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { setMoveTargetTooLargeRefusal } from "./brandView";
import { MAX_YEAR_SET_ROWS } from "./setFromMarketplace";

const modules = (
  import.meta as unknown as {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("./**/*.*s");

const ADMIN_IDENTITY = {
  subject: "admin_neo237_brandview",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_neo237_brandview",
  name: "Admin User",
  role: "admin",
};

const NON_ADMIN_IDENTITY = {
  subject: "user_neo237_brandview",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|user_neo237_brandview",
  name: "Regular User",
};

const SENTINEL = 1_000_000;

function admin(t: ReturnType<typeof convexTest>) {
  return t.withIdentity(ADMIN_IDENTITY);
}

async function seedYear(
  t: ReturnType<typeof convexTest>,
  opts: { sportlots?: Record<string, string>; sportId?: Id<"selectorOptions"> } = {},
) {
  return t.run(async (ctx) =>
    ctx.db.insert("selectorOptions", {
      level: "year",
      value: "1995",
      platformData: opts.sportlots ? { sportlots: opts.sportlots } : {},
      parentId: opts.sportId,
      children: [],
      lastUpdated: SENTINEL,
    }),
  );
}

/** sport → year, both carrying a SportLots id — SL resolvable at manufacturer. */
async function seedSlResolvableYear(t: ReturnType<typeof convexTest>) {
  const sportId = await t.run(async (ctx) =>
    ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Baseball",
      platformData: { sportlots: { s0: "BB" } },
      children: [],
      lastUpdated: SENTINEL,
    }),
  );
  return seedYear(t, { sportlots: { s0: "1995" }, sportId });
}

async function seedManufacturer(
  t: ReturnType<typeof convexTest>,
  parentId: Id<"selectorOptions">,
  value: string,
  opts: { isBrandUnknown?: boolean; setNamePrefix?: string } = {},
) {
  return t.run(async (ctx) =>
    ctx.db.insert("selectorOptions", {
      level: "manufacturer",
      value,
      platformData: {},
      ...(opts.isBrandUnknown !== undefined || opts.setNamePrefix
        ? {
            metadata: {
              ...(opts.isBrandUnknown !== undefined
                ? { isBrandUnknown: opts.isBrandUnknown }
                : {}),
              ...(opts.setNamePrefix ? { setNamePrefix: opts.setNamePrefix } : {}),
            },
          }
        : {}),
      parentId,
      children: [],
      lastUpdated: SENTINEL,
    }),
  );
}

async function seedSet(
  t: ReturnType<typeof convexTest>,
  parentId: Id<"selectorOptions">,
  value: string,
) {
  const id = await t.run(async (ctx) =>
    ctx.db.insert("selectorOptions", {
      level: "setName",
      value,
      platformData: {},
      parentId,
      children: [],
      lastUpdated: SENTINEL,
    }),
  );
  await t.run(async (ctx) => {
    const parent = await ctx.db.get(parentId);
    await ctx.db.patch(parentId, {
      children: [...(parent?.children ?? []), id],
    });
  });
  return id;
}

describe("getSetsUnderYear", () => {
  test("returns every set under every brand, with the brand suffix and parentId", async () => {
    const t = convexTest(schema, modules);
    const year = await seedYear(t);
    const topps = await seedManufacturer(t, year, "Topps");
    const bowman = await seedManufacturer(t, year, "Bowman");
    const chrome = await seedSet(t, topps, "Chrome");
    const draft = await seedSet(t, bowman, "Draft");

    const rows = await admin(t).query(api.brandView.getSetsUnderYear, {
      yearId: year,
    });

    expect(rows).toHaveLength(2);
    const byId = new Map(rows.map((r) => [r._id, r]));
    expect(byId.get(chrome)).toMatchObject({
      value: "Chrome",
      parentId: topps,
      brand: "Topps",
    });
    expect(byId.get(draft)).toMatchObject({
      value: "Draft",
      parentId: bowman,
      brand: "Bowman",
    });
  });

  test("returns [] for an id that is not a year", async () => {
    const t = convexTest(schema, modules);
    const year = await seedYear(t);
    const topps = await seedManufacturer(t, year, "Topps");

    const rows = await admin(t).query(api.brandView.getSetsUnderYear, {
      yearId: topps,
    });
    expect(rows).toEqual([]);
  });

  test("a brand with zero sets contributes nothing, no crash", async () => {
    const t = convexTest(schema, modules);
    const year = await seedYear(t);
    await seedManufacturer(t, year, "Topps");

    const rows = await admin(t).query(api.brandView.getSetsUnderYear, {
      yearId: year,
    });
    expect(rows).toEqual([]);
  });

  test("rejects a non-admin caller", async () => {
    const t = convexTest(schema, modules);
    const year = await seedYear(t);
    await expect(
      t
        .withIdentity(NON_ADMIN_IDENTITY)
        .query(api.brandView.getSetsUnderYear, { yearId: year }),
    ).rejects.toThrow(/Admin access required/);
  });
});

describe("setSelectorOptionSetNamePrefix", () => {
  test("saves a trimmed prefix and re-homes matching sets out of Unknown", async () => {
    const t = convexTest(schema, modules);
    const year = await seedYear(t);
    const unknown = await seedManufacturer(t, year, "Unknown", {
      isBrandUnknown: true,
    });
    const topps = await seedManufacturer(t, year, "Topps");
    const matching = await seedSet(t, unknown, "Topps Chrome");
    const nonMatching = await seedSet(t, unknown, "Panini Prizm");

    const result = await admin(t).mutation(
      api.brandView.setSelectorOptionSetNamePrefix,
      { id: topps, setNamePrefix: "  Topps  " },
    );

    expect(result).toEqual({ rehomed: 1 });
    const [row, movedSet, staleSet] = await t.run(async (ctx) => [
      await ctx.db.get(topps),
      await ctx.db.get(matching),
      await ctx.db.get(nonMatching),
    ]);
    expect(row?.metadata?.setNamePrefix).toBe("Topps");
    expect(movedSet?.parentId).toBe(topps);
    expect(staleSet?.parentId).toBe(unknown);
  });

  test("an empty string clears the prefix, and never falls back to the display value; re-homes nothing", async () => {
    const t = convexTest(schema, modules);
    const year = await seedYear(t);
    const topps = await seedManufacturer(t, year, "Topps", {
      setNamePrefix: "Topps",
    });

    const result = await admin(t).mutation(
      api.brandView.setSelectorOptionSetNamePrefix,
      { id: topps, setNamePrefix: "" },
    );

    expect(result).toEqual({ rehomed: 0 });
    const row = await t.run((ctx) => ctx.db.get(topps));
    expect(row?.metadata?.setNamePrefix).toBeUndefined();
  });

  test("keeps the rest of `metadata` intact — one field patched, not the object", async () => {
    const t = convexTest(schema, modules);
    const year = await seedYear(t);
    const topps = await t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "manufacturer",
        value: "Topps",
        platformData: {},
        metadata: { cardNumberPrefix: "T-" },
        parentId: year,
        children: [],
        lastUpdated: SENTINEL,
      }),
    );

    await admin(t).mutation(api.brandView.setSelectorOptionSetNamePrefix, {
      id: topps,
      setNamePrefix: "Topps",
    });

    const row = await t.run((ctx) => ctx.db.get(topps));
    expect(row?.metadata?.setNamePrefix).toBe("Topps");
    expect(row?.metadata?.cardNumberPrefix).toBe("T-");
  });

  test("a clash under the target keeps the sibling where it is, and the count reflects only what moved", async () => {
    const t = convexTest(schema, modules);
    const year = await seedYear(t);
    const unknown = await seedManufacturer(t, year, "Unknown", {
      isBrandUnknown: true,
    });
    const topps = await seedManufacturer(t, year, "Topps");
    await seedSet(t, topps, "Chrome");
    const clashing = await seedSet(t, unknown, "Chrome");
    const clean = await seedSet(t, unknown, "Topps Finest");

    const result = await admin(t).mutation(
      api.brandView.setSelectorOptionSetNamePrefix,
      { id: topps, setNamePrefix: "Topps" },
    );

    expect(result.rehomed).toBe(1);
    const [clashRow, cleanRow] = await t.run(async (ctx) => [
      await ctx.db.get(clashing),
      await ctx.db.get(clean),
    ]);
    expect(clashRow?.parentId).toBe(unknown);
    expect(cleanRow?.parentId).toBe(topps);
  });

  test("refused on the flagged Unknown row", async () => {
    const t = convexTest(schema, modules);
    const year = await seedYear(t);
    const unknown = await seedManufacturer(t, year, "Unknown", {
      isBrandUnknown: true,
    });

    await expect(
      admin(t).mutation(api.brandView.setSelectorOptionSetNamePrefix, {
        id: unknown,
        setNamePrefix: "Unknown",
      }),
    ).rejects.toThrow(/doesn't get one of its own/);
  });

  test("refused on a non-manufacturer row", async () => {
    const t = convexTest(schema, modules);
    const year = await seedYear(t);

    await expect(
      admin(t).mutation(api.brandView.setSelectorOptionSetNamePrefix, {
        id: year,
        setNamePrefix: "Topps",
      }),
    ).rejects.toThrow(/set on a brand/);
  });

  test("refuses a prefix over the length ceiling", async () => {
    const t = convexTest(schema, modules);
    const year = await seedYear(t);
    const topps = await seedManufacturer(t, year, "Topps");

    let thrown: unknown;
    try {
      await admin(t).mutation(api.brandView.setSelectorOptionSetNamePrefix, {
        id: topps,
        setNamePrefix: "A".repeat(201),
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConvexError);
  });

  test("a gone row refuses cleanly", async () => {
    const t = convexTest(schema, modules);
    const year = await seedYear(t);
    const topps = await seedManufacturer(t, year, "Topps");
    await t.run((ctx) => ctx.db.delete(topps));

    await expect(
      admin(t).mutation(api.brandView.setSelectorOptionSetNamePrefix, {
        id: topps,
        setNamePrefix: "Topps",
      }),
    ).rejects.toThrow(/gone/);
  });

  test("rejects a non-admin caller", async () => {
    const t = convexTest(schema, modules);
    const year = await seedYear(t);
    const topps = await seedManufacturer(t, year, "Topps");

    await expect(
      t
        .withIdentity(NON_ADMIN_IDENTITY)
        .mutation(api.brandView.setSelectorOptionSetNamePrefix, {
          id: topps,
          setNamePrefix: "Topps",
        }),
    ).rejects.toThrow(/Admin access required/);
  });

  test("security review S2 — PREFIX_TAKEN when a sibling brand already holds the folded prefix", async () => {
    const t = convexTest(schema, modules);
    const year = await seedYear(t);
    const bowman = await seedManufacturer(t, year, "Bowman", {
      setNamePrefix: "Choice",
    });
    const upstartBrand = await seedManufacturer(t, year, "Choice Cards");

    let thrown: unknown;
    try {
      await admin(t).mutation(api.brandView.setSelectorOptionSetNamePrefix, {
        id: upstartBrand,
        setNamePrefix: "  CHOICE ",
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConvexError);
    expect(
      (thrown as ConvexError<{ code: string; existingId: string }>).data,
    ).toMatchObject({ code: "PREFIX_TAKEN", existingId: bowman });

    // Nothing was written on the row that tried to take it.
    const row = await t.run((ctx) => ctx.db.get(upstartBrand));
    expect(row?.metadata?.setNamePrefix).toBeUndefined();
  });

  test("PREFIX_TAKEN is not raised against the row's own current prefix", async () => {
    const t = convexTest(schema, modules);
    const year = await seedYear(t);
    const topps = await seedManufacturer(t, year, "Topps", {
      setNamePrefix: "Topps",
    });

    // Re-saving the same prefix (e.g. re-trimmed) must not clash with itself.
    const result = await admin(t).mutation(
      api.brandView.setSelectorOptionSetNamePrefix,
      { id: topps, setNamePrefix: "Topps" },
    );
    expect(result).toEqual({ rehomed: 0 });
  });
});

describe("setManufacturerSlViaAllBrands", () => {
  test("enabled: true writes the sentinel SL slot with the row's own value as the label", async () => {
    const t = convexTest(schema, modules);
    const year = await seedSlResolvableYear(t);
    const bandai = await seedManufacturer(t, year, "Bandai");

    await admin(t).mutation(api.brandView.setManufacturerSlViaAllBrands, {
      id: bandai,
      enabled: true,
    });

    const row = await t.run((ctx) => ctx.db.get(bandai));
    expect(row?.platformData.sportlots).toEqual({ s0: "All Brands" });
    expect(row?.platformLabels?.sportlots).toEqual({ s0: "Bandai" });
  });

  test("enabled: true is idempotent — turning it on twice writes the slot once", async () => {
    const t = convexTest(schema, modules);
    const year = await seedSlResolvableYear(t);
    const bandai = await seedManufacturer(t, year, "Bandai");

    await admin(t).mutation(api.brandView.setManufacturerSlViaAllBrands, {
      id: bandai,
      enabled: true,
    });
    const before = await t.run((ctx) => ctx.db.get(bandai));
    await admin(t).mutation(api.brandView.setManufacturerSlViaAllBrands, {
      id: bandai,
      enabled: true,
    });
    const after = await t.run((ctx) => ctx.db.get(bandai));
    expect(after?.platformData.sportlots).toEqual({ s0: "All Brands" });
    expect(after?.lastUpdated).toBe(before?.lastUpdated);
  });

  test("enabled: false detaches the sentinel slot and nothing else", async () => {
    const t = convexTest(schema, modules);
    const year = await seedSlResolvableYear(t);
    const bandai = await seedManufacturer(t, year, "Bandai");
    await admin(t).mutation(api.brandView.setManufacturerSlViaAllBrands, {
      id: bandai,
      enabled: true,
    });

    await admin(t).mutation(api.brandView.setManufacturerSlViaAllBrands, {
      id: bandai,
      enabled: false,
    });

    const row = await t.run((ctx) => ctx.db.get(bandai));
    expect(row?.platformData.sportlots ?? {}).toEqual({});
  });

  test("enabled: false when already off is a no-op", async () => {
    const t = convexTest(schema, modules);
    const year = await seedSlResolvableYear(t);
    const bandai = await seedManufacturer(t, year, "Bandai");

    const result = await admin(t).mutation(
      api.brandView.setManufacturerSlViaAllBrands,
      { id: bandai, enabled: false },
    );
    expect(result).toBeNull();
  });

  test("refuses enabled: true when the chain cannot scope SportLots (SL_NOT_RESOLVABLE)", async () => {
    const t = convexTest(schema, modules);
    const year = await seedYear(t); // no SportLots ids on sport/year
    const bandai = await seedManufacturer(t, year, "Bandai");

    let thrown: unknown;
    try {
      await admin(t).mutation(api.brandView.setManufacturerSlViaAllBrands, {
        id: bandai,
        enabled: true,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConvexError);
    expect(
      (thrown as ConvexError<{ code: string }>).data?.code,
    ).toBe("SL_NOT_RESOLVABLE");
    const row = await t.run((ctx) => ctx.db.get(bandai));
    expect(row?.platformData.sportlots ?? {}).toEqual({});
  });

  test("refuses when the row already holds a REAL (non-sentinel) SportLots id — never overwritten or stood beside", async () => {
    const t = convexTest(schema, modules);
    const year = await seedSlResolvableYear(t);
    const topps = await t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "manufacturer",
        value: "Topps",
        platformData: { sportlots: { s0: "17" } },
        parentId: year,
        children: [],
        lastUpdated: SENTINEL,
      }),
    );

    let thrown: unknown;
    try {
      await admin(t).mutation(api.brandView.setManufacturerSlViaAllBrands, {
        id: topps,
        enabled: true,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConvexError);
    expect((thrown as ConvexError<{ code: string }>).data?.code).toBe(
      "SL_LINKED",
    );

    // The other direction too: turning "off" a real link is refused, not a
    // silent no-op that would strip a genuine link.
    let thrownOff: unknown;
    try {
      await admin(t).mutation(api.brandView.setManufacturerSlViaAllBrands, {
        id: topps,
        enabled: false,
      });
    } catch (error) {
      thrownOff = error;
    }
    expect((thrownOff as ConvexError<{ code: string }>).data?.code).toBe(
      "SL_LINKED",
    );
    const row = await t.run((ctx) => ctx.db.get(topps));
    expect(row?.platformData.sportlots).toEqual({ s0: "17" });
  });

  test("refused on the flagged Unknown row", async () => {
    const t = convexTest(schema, modules);
    const year = await seedSlResolvableYear(t);
    const unknown = await seedManufacturer(t, year, "Unknown", {
      isBrandUnknown: true,
    });

    await expect(
      admin(t).mutation(api.brandView.setManufacturerSlViaAllBrands, {
        id: unknown,
        enabled: true,
      }),
    ).rejects.toThrow(/doesn't match by name/);
  });

  test("refused on a non-manufacturer row", async () => {
    const t = convexTest(schema, modules);
    const year = await seedSlResolvableYear(t);

    await expect(
      admin(t).mutation(api.brandView.setManufacturerSlViaAllBrands, {
        id: year,
        enabled: true,
      }),
    ).rejects.toThrow(/set on a brand/);
  });

  test("a gone row refuses cleanly", async () => {
    const t = convexTest(schema, modules);
    const year = await seedSlResolvableYear(t);
    const bandai = await seedManufacturer(t, year, "Bandai");
    await t.run((ctx) => ctx.db.delete(bandai));

    await expect(
      admin(t).mutation(api.brandView.setManufacturerSlViaAllBrands, {
        id: bandai,
        enabled: true,
      }),
    ).rejects.toThrow(/gone/);
  });

  test("rejects a non-admin caller", async () => {
    const t = convexTest(schema, modules);
    const year = await seedSlResolvableYear(t);
    const bandai = await seedManufacturer(t, year, "Bandai");

    await expect(
      t
        .withIdentity(NON_ADMIN_IDENTITY)
        .mutation(api.brandView.setManufacturerSlViaAllBrands, {
          id: bandai,
          enabled: true,
        }),
    ).rejects.toThrow(/Admin access required/);
  });
});

/**
 * NEO-294 — the operator's "move this set to another brand".
 *
 * The undo for every automatic placement (the prefix re-home, the
 * known-brands list, the sync's own bucketing), so what these pin is that the
 * move is a PURE NB RE-PARENT — same `_id`, same subtree, same marketplace
 * slots — that it refuses rather than merges when the target already has a
 * set of that name, and that it stamps the row so no later sync moves it back.
 */
describe("getBrandsForYearOfSet", () => {
  test("every brand in the set's year, Unknown first then by name, current flagged", async () => {
    const t = convexTest(schema, modules);
    const year = await seedYear(t);
    const topps = await seedManufacturer(t, year, "Topps");
    const bowman = await seedManufacturer(t, year, "Bowman");
    const unknown = await seedManufacturer(t, year, "Unknown", {
      isBrandUnknown: true,
    });
    // A brand under a DIFFERENT year, which must never be offered.
    const otherYear = await seedYear(t);
    await seedManufacturer(t, otherYear, "Fleer");
    const set = await seedSet(t, unknown, "Choice Biloxi Shuckers");

    const rows = await admin(t).query(api.brandView.getBrandsForYearOfSet, {
      setId: set,
    });

    expect(rows).toEqual([
      { _id: unknown, value: "Unknown", isCurrent: true },
      { _id: bowman, value: "Bowman", isCurrent: false },
      { _id: topps, value: "Topps", isCurrent: false },
    ]);
  });

  test("returns [] for an id that is not a set", async () => {
    const t = convexTest(schema, modules);
    const year = await seedYear(t);
    const topps = await seedManufacturer(t, year, "Topps");

    expect(
      await admin(t).query(api.brandView.getBrandsForYearOfSet, {
        setId: topps,
      }),
    ).toEqual([]);
  });

  test("rejects a non-admin caller", async () => {
    const t = convexTest(schema, modules);
    const year = await seedYear(t);
    const unknown = await seedManufacturer(t, year, "Unknown", {
      isBrandUnknown: true,
    });
    const set = await seedSet(t, unknown, "Choice Biloxi Shuckers");

    await expect(
      t
        .withIdentity(NON_ADMIN_IDENTITY)
        .query(api.brandView.getBrandsForYearOfSet, { setId: set }),
    ).rejects.toThrow(/Admin access required/);
  });
});

describe("moveSetToBrand", () => {
  test("re-parents the set, keeps its subtree and slots, and stamps the operator flag", async () => {
    const t = convexTest(schema, modules);
    const year = await seedYear(t);
    const unknown = await seedManufacturer(t, year, "Unknown", {
      isBrandUnknown: true,
    });
    const choice = await seedManufacturer(t, year, "Choice", {
      setNamePrefix: "Choice",
    });
    const set = await seedSet(t, unknown, "Choice Biloxi Shuckers");
    // A marketplace slot on the set and a variant type under it: the two
    // things the operator is really asking about before they press the button.
    const variantType = await t.run(async (ctx) => {
      await ctx.db.patch(set, {
        platformData: { bsc: { b0: "bsc-set-1" } },
        metadata: { cardNumberPrefix: "DK-" },
      });
      return ctx.db.insert("selectorOptions", {
        level: "variantType",
        value: "Base",
        platformData: {},
        parentId: set,
        children: [],
        lastUpdated: SENTINEL,
      });
    });

    const result = await admin(t).mutation(api.brandView.moveSetToBrand, {
      setId: set,
      brandId: choice,
    });

    expect(result).toEqual({ movedTo: "Choice" });
    const [moved, oldParent, newParent, child] = await t.run(async (ctx) => [
      await ctx.db.get(set),
      await ctx.db.get(unknown),
      await ctx.db.get(choice),
      await ctx.db.get(variantType),
    ]);
    expect(moved!.parentId).toBe(choice);
    // Same row, same links, same cards below it.
    expect(moved!.value).toBe("Choice Biloxi Shuckers");
    expect(moved!.platformData).toEqual({ bsc: { b0: "bsc-set-1" } });
    expect(child!.parentId).toBe(set);
    // The stamp lands beside the metadata that was already there.
    expect(moved!.metadata).toEqual({
      cardNumberPrefix: "DK-",
      brandSetByOperator: true,
    });
    // Both children caches follow the row.
    expect(oldParent!.children ?? []).not.toContain(set);
    expect(newParent!.children ?? []).toContain(set);
  });

  test("moves a set back to the year's Unknown row — the one caller allowed to", async () => {
    const t = convexTest(schema, modules);
    const year = await seedYear(t);
    const unknown = await seedManufacturer(t, year, "Unknown", {
      isBrandUnknown: true,
    });
    const choice = await seedManufacturer(t, year, "Choice", {
      setNamePrefix: "Choice",
    });
    const set = await seedSet(t, choice, "Choice Biloxi Shuckers");

    const result = await admin(t).mutation(api.brandView.moveSetToBrand, {
      setId: set,
      brandId: unknown,
    });

    expect(result).toEqual({ movedTo: "Unknown" });
    const moved = await t.run(async (ctx) => ctx.db.get(set));
    expect(moved!.parentId).toBe(unknown);
    // Without the stamp the next sync would file it straight back under
    // Choice by prefix, and the operator's decision would not survive.
    expect(moved!.metadata?.brandSetByOperator).toBe(true);
  });

  test("an already-stamped set moves again — the stamp binds the sync, not the operator", async () => {
    const t = convexTest(schema, modules);
    const year = await seedYear(t);
    const unknown = await seedManufacturer(t, year, "Unknown", {
      isBrandUnknown: true,
    });
    const choice = await seedManufacturer(t, year, "Choice");
    const star = await seedManufacturer(t, year, "Star");
    const set = await seedSet(t, unknown, "Choice Biloxi Shuckers");

    await admin(t).mutation(api.brandView.moveSetToBrand, {
      setId: set,
      brandId: choice,
    });
    // Second thoughts, same hand: every AUTOMATIC re-home skips a stamped row,
    // and this door is the one that does not.
    const result = await admin(t).mutation(api.brandView.moveSetToBrand, {
      setId: set,
      brandId: star,
    });

    expect(result).toEqual({ movedTo: "Star" });
    const moved = await t.run(async (ctx) => ctx.db.get(set));
    expect(moved!.parentId).toBe(star);
    expect(moved!.metadata?.brandSetByOperator).toBe(true);
  });

  test("refuses a fold-equal sibling name at the target; nothing moves, nothing merges", async () => {
    const t = convexTest(schema, modules);
    const year = await seedYear(t);
    const unknown = await seedManufacturer(t, year, "Unknown", {
      isBrandUnknown: true,
    });
    const choice = await seedManufacturer(t, year, "Choice");
    const set = await seedSet(t, unknown, "Choice Biloxi Shuckers");
    const sitting = await seedSet(t, choice, "  choice biloxi shuckers ");

    await expect(
      admin(t).mutation(api.brandView.moveSetToBrand, {
        setId: set,
        brandId: choice,
      }),
    ).rejects.toThrow(ConvexError);

    const [stillUnknown, stillThere] = await t.run(async (ctx) => [
      await ctx.db.get(set),
      await ctx.db.get(sitting),
    ]);
    expect(stillUnknown!.parentId).toBe(unknown);
    expect(stillUnknown!.metadata?.brandSetByOperator).toBeUndefined();
    expect(stillThere).not.toBeNull();
  });

  test("the clash refusal names the set already sitting there", async () => {
    const t = convexTest(schema, modules);
    const year = await seedYear(t);
    const unknown = await seedManufacturer(t, year, "Unknown", {
      isBrandUnknown: true,
    });
    const choice = await seedManufacturer(t, year, "Choice");
    const set = await seedSet(t, unknown, "Choice Biloxi Shuckers");
    const sitting = await seedSet(t, choice, "choice biloxi shuckers");

    const error = await admin(t)
      .mutation(api.brandView.moveSetToBrand, { setId: set, brandId: choice })
      .catch((e: unknown) => e);
    expect((error as ConvexError<{ code: string }>).data).toEqual({
      code: "SET_NAME_CLASH_AT_TARGET",
      existingId: sitting,
      value: "choice biloxi shuckers",
    });
  });

  /**
   * NEO-294 audit, condition 2. Unknown is a legal destination here and is
   * the biggest bucket in every year, so the sibling read is bounded. Past
   * the bound the clash check cannot be made, and a move made anyway would
   * create the duplicate that check exists to prevent — so it FAILS CLOSED.
   */
  test("refuses when the target holds more sets than the clash check may read, and moves nothing", async () => {
    const t = convexTest(schema, modules);
    const year = await seedYear(t);
    const unknown = await seedManufacturer(t, year, "Unknown", {
      isBrandUnknown: true,
    });
    const choice = await seedManufacturer(t, year, "Choice");
    const set = await seedSet(t, unknown, "Choice Biloxi Shuckers");
    // One past the bound. Inserted directly: the `children` cache plays no
    // part in the read this test is about.
    await t.run(async (ctx) => {
      for (let i = 0; i <= MAX_YEAR_SET_ROWS; i++) {
        await ctx.db.insert("selectorOptions", {
          level: "setName",
          value: `Filler ${i}`,
          platformData: {},
          parentId: choice,
          children: [],
          lastUpdated: SENTINEL,
        });
      }
    });

    const error = await admin(t)
      .mutation(api.brandView.moveSetToBrand, { setId: set, brandId: choice })
      .catch((e: unknown) => e);
    expect((error as ConvexError<string>).data).toBe(
      setMoveTargetTooLargeRefusal("Choice"),
    );

    const after = await t.run((ctx) => ctx.db.get(set));
    expect(after!.parentId).toBe(unknown);
    expect(after!.metadata?.brandSetByOperator).toBeUndefined();
  });

  test("refuses a brand under a different year", async () => {
    const t = convexTest(schema, modules);
    const year = await seedYear(t);
    const otherYear = await seedYear(t);
    const unknown = await seedManufacturer(t, year, "Unknown", {
      isBrandUnknown: true,
    });
    const elsewhere = await seedManufacturer(t, otherYear, "Choice");
    const set = await seedSet(t, unknown, "Choice Biloxi Shuckers");

    await expect(
      admin(t).mutation(api.brandView.moveSetToBrand, {
        setId: set,
        brandId: elsewhere,
      }),
    ).rejects.toThrow(/different year/);
    const stayed = await t.run(async (ctx) => ctx.db.get(set));
    expect(stayed!.parentId).toBe(unknown);
  });

  test("refuses the brand the set is already under", async () => {
    const t = convexTest(schema, modules);
    const year = await seedYear(t);
    const choice = await seedManufacturer(t, year, "Choice");
    const set = await seedSet(t, choice, "Choice Biloxi Shuckers");

    await expect(
      admin(t).mutation(api.brandView.moveSetToBrand, {
        setId: set,
        brandId: choice,
      }),
    ).rejects.toThrow(/already under Choice/);
    // A refused no-op never stamps the row either.
    const stayed = await t.run(async (ctx) => ctx.db.get(set));
    expect(stayed!.metadata?.brandSetByOperator).toBeUndefined();
  });

  test("refuses a source that is not a set, and a target that is not a brand", async () => {
    const t = convexTest(schema, modules);
    const year = await seedYear(t);
    const unknown = await seedManufacturer(t, year, "Unknown", {
      isBrandUnknown: true,
    });
    const choice = await seedManufacturer(t, year, "Choice");
    const set = await seedSet(t, unknown, "Choice Biloxi Shuckers");

    await expect(
      admin(t).mutation(api.brandView.moveSetToBrand, {
        setId: unknown,
        brandId: choice,
      }),
    ).rejects.toThrow(/Only a set moves/);
    await expect(
      admin(t).mutation(api.brandView.moveSetToBrand, {
        setId: set,
        brandId: year,
      }),
    ).rejects.toThrow(/not one/);
  });

  test("rejects a non-admin caller and writes nothing", async () => {
    const t = convexTest(schema, modules);
    const year = await seedYear(t);
    const unknown = await seedManufacturer(t, year, "Unknown", {
      isBrandUnknown: true,
    });
    const choice = await seedManufacturer(t, year, "Choice");
    const set = await seedSet(t, unknown, "Choice Biloxi Shuckers");

    await expect(
      t.withIdentity(NON_ADMIN_IDENTITY).mutation(api.brandView.moveSetToBrand, {
        setId: set,
        brandId: choice,
      }),
    ).rejects.toThrow(/Admin access required/);
    const stayed = await t.run(async (ctx) => ctx.db.get(set));
    expect(stayed!.parentId).toBe(unknown);
  });
});
