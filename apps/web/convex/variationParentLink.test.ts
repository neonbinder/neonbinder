/**
 * NEO-189 — the stored parent/child link on `cardChecklist`.
 *
 * The case that matters is deletion. A variation is a full card in its own
 * right — its own players, SKU and platform refs — so deleting its parent must
 * not take it with it, and must not leave it pointing at a row that is gone.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN = { subject: "user_admin", role: "admin" };

async function seedSetWithVariations(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const selectorOptionId = await ctx.db.insert("selectorOptions", {
      level: "variantType",
      value: "Base",
      platformData: {},
      lastUpdated: Date.now(),
    });
    const base = async (cardNumber: string, cardName: string) =>
      await ctx.db.insert("cardChecklist", {
        selectorOptionId,
        cardNumber,
        cardName,
        platformData: {},
        sortOrder: 0,
        lastUpdated: Date.now(),
      });

    const parent = await base("11", "Phillies 2021 Rookie Stars");
    const varA = await base("11b", "Alec Bohm");
    const varB = await base("11c", "Alec Bohm");
    const unrelated = await base("12", "Alec Bohm");

    for (const [id, name] of [
      [varA, "Action"],
      [varB, "Throwback Alternate"],
    ] as const) {
      await ctx.db.patch(id, {
        variationOfCardId: parent,
        cardVariation: name,
      });
    }
    return { selectorOptionId, parent, varA, varB, unrelated };
  });
}

describe("variationOfCardId", () => {
  test("a card's variations are one indexed read, not a scan", async () => {
    const t = convexTest(schema, modules);
    const { parent, varA, varB } = await seedSetWithVariations(t);

    const children = await t.run(async (ctx) =>
      ctx.db
        .query("cardChecklist")
        .withIndex("by_variation_parent", (q) =>
          q.eq("variationOfCardId", parent),
        )
        .collect(),
    );
    expect(children.map((c) => c._id).sort()).toEqual([varA, varB].sort());
    expect(children.map((c) => c.cardVariation).sort()).toEqual([
      "Action",
      "Throwback Alternate",
    ]);
  });

  test("a variation carries its own identity, not a delta on the parent", async () => {
    // 2021 Topps #52 is Archie Bradley; 52b is Mickey Mantle. Nothing about the
    // link may imply shared identity.
    const t = convexTest(schema, modules);
    const { selectorOptionId } = await seedSetWithVariations(t);
    await t.run(async (ctx) => {
      const parent = await ctx.db.insert("cardChecklist", {
        selectorOptionId,
        cardNumber: "52",
        cardName: "Archie Bradley",
        platformData: { bsc: { ref: "bsc-52" } },
        sku: "NB-BB-2021-TOPPS-52-aaaaaa",
        sortOrder: 1,
        lastUpdated: Date.now(),
      });
      const child = await ctx.db.insert("cardChecklist", {
        selectorOptionId,
        cardNumber: "52b",
        cardName: "Mickey Mantle",
        cardVariation: "Legend; Batting",
        variationOfCardId: parent,
        platformData: { bsc: { ref: "bsc-52b" } },
        sku: "NB-BB-2021-TOPPS-52B-bbbbbb",
        sortOrder: 2,
        lastUpdated: Date.now(),
      });
      const row = (await ctx.db.get(child))!;
      expect(row.cardName).toBe("Mickey Mantle");
      expect(row.platformData.bsc?.ref).toBe("bsc-52b");
      expect(row.sku).not.toBe("NB-BB-2021-TOPPS-52-aaaaaa");
    });
  });
});

describe("deleteCard — the variation cascade", () => {
  test("deleting a parent PROMOTES its variations, it does not delete them", async () => {
    const t = convexTest(schema, modules);
    const { parent, varA, varB, unrelated } = await seedSetWithVariations(t);

    await t
      .withIdentity(ADMIN)
      .mutation(api.selectorOptions.deleteCard, { id: parent });

    const rows = await t.run(async (ctx) => ({
      parent: await ctx.db.get(parent),
      a: await ctx.db.get(varA),
      b: await ctx.db.get(varB),
      unrelated: await ctx.db.get(unrelated),
    }));

    expect(rows.parent).toBeNull();
    // The variations survive as ordinary cards, keeping their own data.
    expect(rows.a).not.toBeNull();
    expect(rows.b).not.toBeNull();
    expect(rows.a!.variationOfCardId).toBeUndefined();
    expect(rows.b!.variationOfCardId).toBeUndefined();
    expect(rows.a!.cardVariation).toBe("Action");
    expect(rows.unrelated).not.toBeNull();
  });

  test("no dangling pointer survives the delete", async () => {
    const t = convexTest(schema, modules);
    const { parent } = await seedSetWithVariations(t);
    await t
      .withIdentity(ADMIN)
      .mutation(api.selectorOptions.deleteCard, { id: parent });

    const dangling = await t.run(async (ctx) =>
      ctx.db
        .query("cardChecklist")
        .withIndex("by_variation_parent", (q) =>
          q.eq("variationOfCardId", parent),
        )
        .collect(),
    );
    expect(dangling).toEqual([]);
  });

  test("deleting a variation leaves its parent and siblings untouched", async () => {
    const t = convexTest(schema, modules);
    const { parent, varA, varB } = await seedSetWithVariations(t);
    await t
      .withIdentity(ADMIN)
      .mutation(api.selectorOptions.deleteCard, { id: varA });

    const rows = await t.run(async (ctx) => ({
      parent: await ctx.db.get(parent),
      a: await ctx.db.get(varA),
      b: await ctx.db.get(varB),
    }));
    expect(rows.a).toBeNull();
    expect(rows.parent).not.toBeNull();
    expect(rows.b!.variationOfCardId).toBe(parent as Id<"cardChecklist">);
  });
});
