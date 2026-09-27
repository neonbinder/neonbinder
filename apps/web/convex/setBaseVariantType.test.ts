/**
 * NEO-239 — Base as an NB ROLE, not a name.
 *
 * "Which variantType row is this set's base?" was answered in five places by
 * comparing the display value to the literal `"base"`. That made an NB
 * behaviour depend on a word BuySportsCards happens to use for the facet, and
 * it broke the moment an operator renamed the row — which is now allowed,
 * because the rename refusal that used to protect the name is gone.
 *
 * The role is derived ONCE, from BSC's own `base` variant id, when the sync
 * creates or first matches the row. This mutation is the operator's door onto
 * the same field, for a set that has no base row.
 *
 * NEO-306 — the role and the row are one thing: the door only grants, only to
 * a set with no base, and the way a set loses its base is deleting the (empty)
 * row. No transfer, no clear.
 */

import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { baseRoleTakenMessage } from "./selectorOptions";

const modules = (
  import.meta as unknown as {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("./**/*.*s");

const ADMIN = {
  subject: "admin_base_role",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_base_role",
  role: "admin",
};

const USER = {
  subject: "user_base_role",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|user_base_role",
  role: "user",
};

const SENTINEL = 1_000_000;

async function seedSetWithVariants(
  t: ReturnType<typeof convexTest>,
  opts: { withBase?: boolean } = {},
) {
  const withBase = opts.withBase ?? true;
  return t.run(async (ctx) => {
    const setId = await ctx.db.insert("selectorOptions", {
      level: "setName",
      value: "Topps",
      platformData: {},
      children: [],
      lastUpdated: SENTINEL,
    });
    const mk = (value: string, isBase?: boolean) =>
      ctx.db.insert("selectorOptions", {
        level: "variantType",
        value,
        platformData: {},
        ...(isBase !== undefined ? { metadata: { isBase } } : {}),
        parentId: setId,
        children: [],
        lastUpdated: SENTINEL,
      });
    return {
      setId,
      base: await mk("Base", withBase ? true : undefined),
      insert: await mk("Insert"),
      parallel: await mk("Parallel"),
    };
  });
}

const roleOf = async (
  t: ReturnType<typeof convexTest>,
  id: Id<"selectorOptions">,
) => (await t.run(async (ctx) => ctx.db.get(id)))?.metadata?.isBase;

const lastUpdatedOf = async (
  t: ReturnType<typeof convexTest>,
  id: Id<"selectorOptions">,
) => (await t.run(async (ctx) => ctx.db.get(id)))?.lastUpdated;

describe("setBaseVariantType", () => {
  test("grants the role to a set that has no base, touching no sibling", async () => {
    const t = convexTest(schema, modules);
    const { base, insert, parallel } = await seedSetWithVariants(t, {
      withBase: false,
    });

    const res = await t
      .withIdentity(ADMIN)
      .mutation(api.selectorOptions.setBaseVariantType, {
        variantTypeId: insert,
      });

    expect(res).toEqual({ baseId: insert });
    expect(await roleOf(t, insert)).toBe(true);
    expect(await roleOf(t, base)).toBeUndefined();
    expect(await roleOf(t, parallel)).toBeUndefined();
    expect(await lastUpdatedOf(t, base)).toBe(SENTINEL);
    expect(await lastUpdatedOf(t, parallel)).toBe(SENTINEL);
  });

  test("`getBaseVariantBySet` follows the role, not the name", async () => {
    const t = convexTest(schema, modules);
    const { setId, insert } = await seedSetWithVariants(t, { withBase: false });

    await t
      .withIdentity(ADMIN)
      .mutation(api.selectorOptions.setBaseVariantType, {
        variantTypeId: insert,
      });

    const found = await t
      .withIdentity(ADMIN)
      .query(api.selectorOptions.getBaseVariantBySet, { setId });
    // The row named "Insert" is the base now, because that is what the
    // operator said. Nothing reads the string.
    expect(found?.value).toBe("Insert");
  });

  test("a renamed base keeps the role — which is why the rename is safe", async () => {
    const t = convexTest(schema, modules);
    const { setId, base } = await seedSetWithVariants(t);

    await t.withIdentity(ADMIN).mutation(api.selectorOptions.renameSelectorOption, {
      id: base,
      value: "Base Set",
    });

    expect(await roleOf(t, base)).toBe(true);
    const found = await t
      .withIdentity(ADMIN)
      .query(api.selectorOptions.getBaseVariantBySet, { setId });
    expect(found?.value).toBe("Base Set");
  });

  test("NEO-306: REFUSES a transfer — a set that has a base keeps it, and nothing is written", async () => {
    // The role and the row are one thing (Jason, 2026-09-27). Moving the flag
    // off a row is the same act as clearing it, and a cleared Base stops being
    // terminal: the cascade opens an Inserts column under it and SportLots
    // fills it with the brand's whole set list.
    const t = convexTest(schema, modules);
    const { setId, base, insert } = await seedSetWithVariants(t);

    await expect(
      t.withIdentity(ADMIN).mutation(api.selectorOptions.setBaseVariantType, {
        variantTypeId: insert,
      }),
    ).rejects.toThrow(baseRoleTakenMessage("Base"));

    expect(await roleOf(t, base)).toBe(true);
    expect(await roleOf(t, insert)).toBeUndefined();
    expect(await lastUpdatedOf(t, base)).toBe(SENTINEL);
    expect(await lastUpdatedOf(t, insert)).toBe(SENTINEL);
    expect(
      (
        await t
          .withIdentity(ADMIN)
          .query(api.selectorOptions.getBaseVariantBySet, { setId })
      )?.value,
    ).toBe("Base");
  });

  test("the refusal is a sentence an operator can act on, naming the base by its NB name", () => {
    expect(baseRoleTakenMessage("Base Set")).toBe(
      "Base Set is already this set's base set. A set has one — delete Base Set first to mark another.",
    );
  });

  test("the refusal is a ConvexError, so production does not redact it to 'Server Error'", async () => {
    const t = convexTest(schema, modules);
    const { insert } = await seedSetWithVariants(t);

    const error = await t
      .withIdentity(ADMIN)
      .mutation(api.selectorOptions.setBaseVariantType, { variantTypeId: insert })
      .then(
        () => null,
        (e: unknown) => e,
      );

    expect(error).toBeInstanceOf(ConvexError);
    expect((error as ConvexError<string>).data).toBe(baseRoleTakenMessage("Base"));
  });

  test("legacy data with TWO base rows: marking a third refuses and leaves both", async () => {
    // `metadata.isBase` was never enforced exactly-one at the storage layer.
    // A set already carrying two is reported by
    // `backfillVariantTypeRole:reportBaseAnomalies`, never fixed here.
    const t = convexTest(schema, modules);
    const { base, insert, parallel } = await seedSetWithVariants(t);
    await t.run(async (ctx) =>
      ctx.db.patch(parallel, { metadata: { isBase: true } }),
    );

    await expect(
      t.withIdentity(ADMIN).mutation(api.selectorOptions.setBaseVariantType, {
        variantTypeId: insert,
      }),
    ).rejects.toThrow(/is already this set's base set/);

    expect(await roleOf(t, base)).toBe(true);
    expect(await roleOf(t, parallel)).toBe(true);
    expect(await roleOf(t, insert)).toBeUndefined();
  });

  test("`clear` is gone: the role cannot be taken off a row that stays", async () => {
    const t = convexTest(schema, modules);
    const { base } = await seedSetWithVariants(t);

    await expect(
      t.withIdentity(ADMIN).mutation(api.selectorOptions.setBaseVariantType, {
        variantTypeId: base,
        clear: true,
      } as never),
    ).rejects.toThrow();
    expect(await roleOf(t, base)).toBe(true);
  });

  test("re-granting the role to the row that already holds it writes nothing", async () => {
    // NEO-85: a no-op patch still invalidates every query watching the row and
    // reflows the SetSelector columns under Maestro's coordinate taps.
    const t = convexTest(schema, modules);
    const { base } = await seedSetWithVariants(t);

    const res = await t
      .withIdentity(ADMIN)
      .mutation(api.selectorOptions.setBaseVariantType, {
        variantTypeId: base,
      });

    expect(res).toEqual({ baseId: base });
    expect(await lastUpdatedOf(t, base)).toBe(SENTINEL);
  });

  test("it never reaches another set's variantTypes", async () => {
    // Scoped to (level, parentId), the same way the matcher scopes itself: a
    // base in ANOTHER set neither blocks this one nor is touched by it.
    const t = convexTest(schema, modules);
    const a = await seedSetWithVariants(t, { withBase: false });
    const b = await seedSetWithVariants(t);

    await t
      .withIdentity(ADMIN)
      .mutation(api.selectorOptions.setBaseVariantType, {
        variantTypeId: a.insert,
      });

    expect(await roleOf(t, a.insert)).toBe(true);
    expect(await roleOf(t, b.base)).toBe(true);
    expect(await lastUpdatedOf(t, b.base)).toBe(SENTINEL);
  });

  test("refuses a row that is not a variantType", async () => {
    const t = convexTest(schema, modules);
    const { setId } = await seedSetWithVariants(t);

    await expect(
      t.withIdentity(ADMIN).mutation(api.selectorOptions.setBaseVariantType, {
        variantTypeId: setId,
      }),
    ).rejects.toThrow(/only operates on variantType rows/);
  });

  test("is admin-gated", async () => {
    const t = convexTest(schema, modules);
    const { insert } = await seedSetWithVariants(t, { withBase: false });

    await expect(
      t.withIdentity(USER).mutation(api.selectorOptions.setBaseVariantType, {
        variantTypeId: insert,
      }),
    ).rejects.toThrow();
  });
});

/**
 * NEO-306 — taking the role away IS deleting the row, through the ordinary
 * empty-row delete. These pin that the Base gets no special door: the same
 * emptiness refusal, and once it is gone the set can be given a base again.
 */
describe("deleting the base row is how a set loses its base", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  test("an EMPTY base deletes, and the set can then be given another base", async () => {
    const t = convexTest(schema, modules);
    const { setId, base, insert } = await seedSetWithVariants(t);
    const asAdmin = t.withIdentity(ADMIN);

    await asAdmin.mutation(api.selectorOptions.deleteSelectorOption, { id: base });

    expect(await t.run(async (ctx) => ctx.db.get(base))).toBeNull();
    expect(
      await asAdmin.query(api.selectorOptions.getBaseVariantBySet, { setId }),
    ).toBeNull();

    await asAdmin.mutation(api.selectorOptions.setBaseVariantType, {
      variantTypeId: insert,
    });
    expect(await roleOf(t, insert)).toBe(true);
  });

  test("a base holding cards is REFUSED with the holdings, and keeps its role", async () => {
    const t = convexTest(schema, modules);
    const { base } = await seedSetWithVariants(t);
    await t.run(async (ctx) =>
      ctx.db.insert("cardChecklist", {
        selectorOptionId: base,
        cardNumber: "1",
        cardName: "Aaron Judge",
        platformData: {},
        sortOrder: 1,
        lastUpdated: SENTINEL,
      }),
    );

    const error = await t
      .withIdentity(ADMIN)
      .mutation(api.selectorOptions.deleteSelectorOption, { id: base })
      .then(
        () => null,
        (e: unknown) => e,
      );

    expect(error).toBeInstanceOf(ConvexError);
    const data = (error as ConvexError<{ code: string; holds: Array<{ kind: string; count: number }> }>).data;
    expect(data.code).toBe("SELECTOR_ROW_NOT_EMPTY");
    expect(data.holds.find((h) => h.kind === "cards")?.count).toBe(1);
    expect(await roleOf(t, base)).toBe(true);
  });
});

describe("the base role is derived once, from BSC's own id", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  async function seedSet(t: ReturnType<typeof convexTest>) {
    return t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "setName",
        value: "Topps",
        platformData: { bsc: { b0: "2024-topps" } },
        children: [],
        lastUpdated: SENTINEL,
      }),
    );
  }

  test("a variantType sync tags its BSC slot `variant` and marks the base row", async () => {
    const t = convexTest(schema, modules);
    const setId = await seedSet(t);

    await t
      .withIdentity(ADMIN)
      .mutation(api.selectorOptions.storeSelectorOptions, {
        level: "variantType",
        parentId: setId,
        options: [
          { value: "Base", platformData: { bsc: "base" } },
          { value: "Insert", platformData: { bsc: "insert" } },
        ],
      });

    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("selectorOptions")
        .withIndex("by_level_and_parent", (q) =>
          q.eq("level", "variantType").eq("parentId", setId),
        )
        .collect(),
    );
    const base = rows.find((r) => r.value === "Base")!;
    const insert = rows.find((r) => r.value === "Insert")!;

    // The tag is what makes BSC resolvable at this level from here on.
    expect(base.platformFacets?.bsc).toEqual({ b0: "variant" });
    expect(insert.platformFacets?.bsc).toEqual({ b0: "variant" });
    // The role comes from the ID being "base" — never from the display value.
    expect(base.metadata?.isBase).toBe(true);
    expect(insert.metadata?.isBase).toBeUndefined();
  });

  test("a row already in the table gains the tag and the role on its next sync", async () => {
    // Every variantType row on dev and prod predates this ticket: no tag, no
    // role. The backfill covers them in one shot, and this covers the ones a
    // sync reaches first.
    const t = convexTest(schema, modules);
    const setId = await seedSet(t);
    const existing = await t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "variantType",
        value: "Base",
        platformData: { bsc: { b0: "base" } },
        primaryPlatformId: { bsc: "b0" },
        platformSlotSeq: { bsc: 1 },
        parentId: setId,
        children: [],
        lastUpdated: SENTINEL,
      }),
    );

    await t
      .withIdentity(ADMIN)
      .mutation(api.selectorOptions.storeSelectorOptions, {
        level: "variantType",
        parentId: setId,
        options: [{ value: "Base", platformData: { bsc: "base" } }],
      });

    const row = await t.run(async (ctx) => ctx.db.get(existing));
    expect(row?.platformFacets?.bsc).toEqual({ b0: "variant" });
    expect(row?.metadata?.isBase).toBe(true);
  });

  test("a later sync never flips a role the operator set", async () => {
    const t = convexTest(schema, modules);
    const setId = await seedSet(t);
    const demoted = await t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "variantType",
        value: "Base",
        platformData: { bsc: { b0: "base" } },
        platformFacets: { bsc: { b0: "variant" } },
        metadata: { isBase: false },
        primaryPlatformId: { bsc: "b0" },
        platformSlotSeq: { bsc: 1 },
        parentId: setId,
        children: [],
        lastUpdated: SENTINEL,
      }),
    );

    await t
      .withIdentity(ADMIN)
      .mutation(api.selectorOptions.storeSelectorOptions, {
        level: "variantType",
        parentId: setId,
        options: [{ value: "Base", platformData: { bsc: "base" } }],
      });

    expect(await roleOf(t, demoted)).toBe(false);
  });

  test("adding a variantType BY HAND does not derive the role from the typed name", async () => {
    // Deriving `isBase` from someone typing "Base" would put the name-keyed
    // behaviour straight back, one level up. A hand-added row gets the role
    // from `setBaseVariantType` or not at all.
    const t = convexTest(schema, modules);
    const setId = await seedSet(t);

    const id = await t
      .withIdentity(ADMIN)
      .mutation(api.selectorOptions.addCustomSelectorOption, {
        level: "variantType",
        value: "Base",
        parentId: setId,
      });

    expect(await roleOf(t, id)).toBeUndefined();
  });

  test("the MATCH branch tags a non-base row `variant` but never grants it the role", async () => {
    // The insert-branch test above ("a variantType sync tags its BSC slot")
    // proves this for a brand-new row. This is the same claim through the
    // MATCH branch: an existing row synced again with a non-"base" id must
    // gain the facet tag (so BSC stays resolvable at this level) while
    // `metadata.isBase` stays untouched — the match branch's guard is
    // `selectorValueKey(item.ids.bsc) === "base"`, and "insert" must fail it.
    const t = convexTest(schema, modules);
    const setId = await seedSet(t);
    const existing = await t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "variantType",
        value: "Insert",
        platformData: { bsc: { b0: "insert" } },
        primaryPlatformId: { bsc: "b0" },
        platformSlotSeq: { bsc: 1 },
        parentId: setId,
        children: [],
        lastUpdated: SENTINEL,
      }),
    );

    await t
      .withIdentity(ADMIN)
      .mutation(api.selectorOptions.storeSelectorOptions, {
        level: "variantType",
        parentId: setId,
        options: [{ value: "Insert", platformData: { bsc: "insert" } }],
      });

    const row = await t.run(async (ctx) => ctx.db.get(existing));
    expect(row?.platformFacets?.bsc).toEqual({ b0: "variant" });
    expect(row?.metadata?.isBase).toBeUndefined();
  });
});
