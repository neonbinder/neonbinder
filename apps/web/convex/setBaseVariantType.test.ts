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
 * the same field: for a set that never synced, or one whose base is not what
 * the sync guessed.
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

async function seedSetWithVariants(t: ReturnType<typeof convexTest>) {
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
      base: await mk("Base", true),
      insert: await mk("Insert"),
      parallel: await mk("Parallel"),
    };
  });
}

const roleOf = async (
  t: ReturnType<typeof convexTest>,
  id: Id<"selectorOptions">,
) => (await t.run(async (ctx) => ctx.db.get(id)))?.metadata?.isBase;

describe("setBaseVariantType", () => {
  test("grants the role and clears it from every sibling — exactly one base per set", async () => {
    // Two base rows would make `getBaseVariantBySet` answer differently
    // depending on document order, and the Base mapping form behind it would
    // write to whichever one it happened to find.
    const t = convexTest(schema, modules);
    const { base, insert, parallel } = await seedSetWithVariants(t);

    const res = await t
      .withIdentity(ADMIN)
      .mutation(api.selectorOptions.setBaseVariantType, {
        variantTypeId: insert,
      });

    expect(res.baseId).toBe(insert);
    expect(res.clearedIds).toEqual([base]);
    expect(await roleOf(t, insert)).toBe(true);
    expect(await roleOf(t, base)).toBeUndefined();
    expect(await roleOf(t, parallel)).toBeUndefined();
  });

  test("`getBaseVariantBySet` follows the role, not the name", async () => {
    const t = convexTest(schema, modules);
    const { setId, insert } = await seedSetWithVariants(t);

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

  test("`clear` removes the role from the whole set, leaving no base", async () => {
    // A set may legitimately have no base row, and an operator who set the
    // wrong one needs a way back that does not require naming a right one.
    const t = convexTest(schema, modules);
    const { setId, base } = await seedSetWithVariants(t);

    const res = await t
      .withIdentity(ADMIN)
      .mutation(api.selectorOptions.setBaseVariantType, {
        variantTypeId: base,
        clear: true,
      });

    expect(res.baseId).toBeNull();
    expect(res.clearedIds).toEqual([base]);
    expect(await roleOf(t, base)).toBeUndefined();
    expect(
      await t
        .withIdentity(ADMIN)
        .query(api.selectorOptions.getBaseVariantBySet, { setId }),
    ).toBeNull();
  });

  test("legacy data with TWO prior base rows: granting to a third clears BOTH", async () => {
    // `metadata.isBase` was never enforced exactly-one at the storage layer —
    // it is a convention this mutation upholds going forward, not a schema
    // constraint. A deployment could plausibly already carry two rows both
    // holding the role (a bug, a race, or hand-edited data). The sibling loop
    // must clear every sibling holding the role, not just the first one it
    // finds — otherwise `getBaseVariantBySet`'s `.find()` keeps answering
    // whichever of the two happens to come first in document order.
    const t = convexTest(schema, modules);
    const { setId, base, insert, parallel } = await seedSetWithVariants(t);
    // Corrupt the data: `parallel` ALSO holds the role, out of band.
    await t.run(async (ctx) =>
      ctx.db.patch(parallel, { metadata: { isBase: true } }),
    );
    expect(await roleOf(t, base)).toBe(true);
    expect(await roleOf(t, parallel)).toBe(true);

    const res = await t
      .withIdentity(ADMIN)
      .mutation(api.selectorOptions.setBaseVariantType, {
        variantTypeId: insert,
      });

    expect(res.baseId).toBe(insert);
    expect(res.clearedIds.sort()).toEqual([base, parallel].sort());
    expect(await roleOf(t, insert)).toBe(true);
    expect(await roleOf(t, base)).toBeUndefined();
    expect(await roleOf(t, parallel)).toBeUndefined();

    const found = await t
      .withIdentity(ADMIN)
      .query(api.selectorOptions.getBaseVariantBySet, { setId });
    expect(found?.value).toBe("Insert");
  });

  test("legacy data with TWO prior base rows: `clear` on EITHER clears both, exactly-one restored as zero", async () => {
    // `clear: true` sets `shouldHoldRole` to `false` for every sibling
    // regardless of which one was named as the target, so calling it on
    // either of the two corrupted rows must reach both.
    const t = convexTest(schema, modules);
    const { setId, base, parallel } = await seedSetWithVariants(t);
    await t.run(async (ctx) =>
      ctx.db.patch(parallel, { metadata: { isBase: true } }),
    );

    const res = await t
      .withIdentity(ADMIN)
      .mutation(api.selectorOptions.setBaseVariantType, {
        variantTypeId: base,
        clear: true,
      });

    expect(res.baseId).toBeNull();
    expect(res.clearedIds.sort()).toEqual([base, parallel].sort());
    expect(await roleOf(t, base)).toBeUndefined();
    expect(await roleOf(t, parallel)).toBeUndefined();
    expect(
      await t
        .withIdentity(ADMIN)
        .query(api.selectorOptions.getBaseVariantBySet, { setId }),
    ).toBeNull();
  });

  test("`clear` targeted at a row that never held the role still clears the real base, but doesn't list the target", async () => {
    // The target itself never held the role (shouldHoldRole === holdsRole ===
    // false is a no-op FOR IT), but the sibling that actually holds it must
    // still be cleared — `clear` is a whole-set operation, not "clear this
    // one row".
    const t = convexTest(schema, modules);
    const { setId, base, insert } = await seedSetWithVariants(t);

    const res = await t
      .withIdentity(ADMIN)
      .mutation(api.selectorOptions.setBaseVariantType, {
        variantTypeId: insert, // not the base — never held the role
        clear: true,
      });

    expect(res.baseId).toBeNull();
    // `insert` never held it, so it is not in the list of rows this call
    // CHANGED — only `base`, which actually lost the role, is.
    expect(res.clearedIds).toEqual([base]);
    expect(await roleOf(t, base)).toBeUndefined();
    expect(await roleOf(t, insert)).toBeUndefined();
    expect(
      await t
        .withIdentity(ADMIN)
        .query(api.selectorOptions.getBaseVariantBySet, { setId }),
    ).toBeNull();
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

    expect(res.clearedIds).toEqual([]);
    expect(
      (await t.run(async (ctx) => ctx.db.get(base)))?.lastUpdated,
    ).toBe(SENTINEL);
  });

  test("it never reaches another set's variantTypes", async () => {
    // Scoped to (level, parentId), the same way the matcher scopes itself, so
    // a client cannot use it to clear a role somewhere else in the tree.
    const t = convexTest(schema, modules);
    const a = await seedSetWithVariants(t);
    const b = await seedSetWithVariants(t);

    await t
      .withIdentity(ADMIN)
      .mutation(api.selectorOptions.setBaseVariantType, {
        variantTypeId: a.insert,
      });

    expect(await roleOf(t, b.base)).toBe(true);
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
    const { insert } = await seedSetWithVariants(t);

    await expect(
      t.withIdentity(USER).mutation(api.selectorOptions.setBaseVariantType, {
        variantTypeId: insert,
      }),
    ).rejects.toThrow();
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
