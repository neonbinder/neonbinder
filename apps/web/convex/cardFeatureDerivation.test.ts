/**
 * NEO-38: integration test that the addCustomCard path INHERITS materialized
 * ancestor-node features (so a card isn't blank in the detail panel) plus its
 * own card-observed features. The set-level heuristic no longer lives on each
 * card — it's seeded onto the originating selectorOption NODES at commit time
 * and cascades down via setSelectorOptionFeature. A custom card added afterward
 * therefore inherits whatever the ancestor nodes already carry.
 *
 * These tests seed the node features the way the real flow does — via
 * `setSelectorOptionFeature` (which materializes down) — then add a custom card
 * and assert it inherited them.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN_IDENTITY = {
  subject: "admin_user_001",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_user_001",
  name: "Admin User",
  role: "admin",
};

describe("addCustomCard inherits materialized features (NEO-38)", () => {
  test("new custom card inherits node-level features + observed features", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const { sportId, yearId, mfrId, variantTypeId } = await t.run(
      async (ctx) => {
        const sportId = await ctx.db.insert("selectorOptions", {
          level: "sport" as const,
          value: "Baseball",
          platformData: { bsc: "x", sportlots: "y" },
          children: [],
          lastUpdated: Date.now(),
        });
        const yearId = await ctx.db.insert("selectorOptions", {
          level: "year" as const,
          value: "2024",
          platformData: { bsc: "x", sportlots: "y" },
          parentId: sportId,
          children: [],
          lastUpdated: Date.now(),
        });
        await ctx.db.patch(sportId, { children: [yearId] });
        const mfrId = await ctx.db.insert("selectorOptions", {
          level: "manufacturer" as const,
          value: "Topps",
          platformData: { bsc: "x", sportlots: "y" },
          parentId: yearId,
          children: [],
          lastUpdated: Date.now(),
        });
        await ctx.db.patch(yearId, { children: [mfrId] });
        const setNameId = await ctx.db.insert("selectorOptions", {
          level: "setName" as const,
          value: "Topps Chrome",
          platformData: { bsc: "x", sportlots: "y" },
          parentId: mfrId,
          children: [],
          lastUpdated: Date.now(),
        });
        await ctx.db.patch(mfrId, { children: [setNameId] });
        const variantTypeId = await ctx.db.insert("selectorOptions", {
          level: "variantType" as const,
          value: "Base",
          platformData: { bsc: "x", sportlots: "y" },
          parentId: setNameId,
          children: [],
          lastUpdated: Date.now(),
        });
        await ctx.db.patch(setNameId, { children: [variantTypeId] });
        return { sportId, yearId, mfrId, setNameId, variantTypeId };
      },
    );

    // Seed the heuristic at its natural originating nodes (this is what
    // commitCardChecklist does), each cascading down via materialization.
    await asAdmin.mutation(api.selectorOptions.setSelectorOptionFeature, {
      selectorOptionId: sportId,
      key: "league",
      value: "MLB",
    });
    await asAdmin.mutation(api.selectorOptions.setSelectorOptionFeature, {
      selectorOptionId: yearId,
      key: "era",
      value: "Modern (1980-Now)",
    });
    await asAdmin.mutation(api.selectorOptions.setSelectorOptionFeature, {
      selectorOptionId: yearId,
      key: "vintage",
      value: "false",
    });
    await asAdmin.mutation(api.selectorOptions.setSelectorOptionFeature, {
      selectorOptionId: mfrId,
      key: "manufacturer",
      value: "Topps",
    });
    await asAdmin.mutation(api.selectorOptions.setSelectorOptionFeature, {
      selectorOptionId: variantTypeId,
      key: "cardType",
      value: "Base",
    });

    await asAdmin.mutation(api.selectorOptions.addCustomCard, {
      selectorOptionId: variantTypeId,
      cardNumber: "1",
      cardName: "Aaron Judge",
      attributes: ["RC"],
    });

    const cards = await asAdmin.query(api.selectorOptions.getCardChecklist, {
      selectorOptionId: variantTypeId,
    });
    expect(cards).toHaveLength(1);
    const f = cards[0].features ?? {};

    // Inherited from the materialized ancestor nodes.
    expect(f.league).toBe("MLB");
    expect(f.era).toBe("Modern (1980-Now)");
    expect(f.vintage).toBe("false");
    expect(f.manufacturer).toBe("Topps");
    expect(f.cardType).toBe("Base");
    // RC attribute → observed rookie (still derived per-card).
    expect(f.isRookie).toBe("true");
  });

  test("operator-set ancestor feature is inherited by a new custom card", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const { setNameId, variantTypeId } = await t.run(async (ctx) => {
      const sportId = await ctx.db.insert("selectorOptions", {
        level: "sport" as const,
        value: "Baseball",
        platformData: { bsc: "x", sportlots: "y" },
        children: [],
        lastUpdated: Date.now(),
      });
      const setNameId = await ctx.db.insert("selectorOptions", {
        level: "setName" as const,
        value: "BBM",
        platformData: { bsc: "x", sportlots: "y" },
        parentId: sportId,
        children: [],
        lastUpdated: Date.now(),
      });
      await ctx.db.patch(sportId, { children: [setNameId] });
      const variantTypeId = await ctx.db.insert("selectorOptions", {
        level: "variantType" as const,
        value: "Base",
        platformData: { bsc: "x", sportlots: "y" },
        parentId: setNameId,
        children: [],
        lastUpdated: Date.now(),
      });
      await ctx.db.patch(setNameId, { children: [variantTypeId] });
      return { setNameId, variantTypeId };
    });

    // Operator overrides league at the setName level (e.g. a Japanese set);
    // materializes down to the variantType node.
    await asAdmin.mutation(api.selectorOptions.setSelectorOptionFeature, {
      selectorOptionId: setNameId,
      key: "league",
      value: "NPB",
    });

    await asAdmin.mutation(api.selectorOptions.addCustomCard, {
      selectorOptionId: variantTypeId,
      cardNumber: "1",
      cardName: "Player",
    });

    const cards = await asAdmin.query(api.selectorOptions.getCardChecklist, {
      selectorOptionId: variantTypeId,
    });
    // The inherited operator value is materialized onto the card.
    expect((cards[0].features ?? {}).league).toBe("NPB");
  });
});
