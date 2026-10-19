/**
 * NEO-345 — the commit's batch-level `autographFormat` arg: the sync wizard's
 * "Autographed cards" answer.
 *
 * Pins: the answer is written onto the LEAF by the page that opens the commit,
 * before any card is inserted, so every new AU card is born `autographed` with
 * it (Signed By seeded) and a non-AU card is not; a leaf that already holds a
 * format keeps it (fill-empty); a commit with no answer leaves AU cards at the
 * inherited "None" whatever the marketplace's `autographType` says (SportLots'
 * "Unknown" is no longer read as "On Card"); and the format never lands in a
 * card's own features.
 *
 * Fixture shape copied from commitCardChecklist.crossSportOverride.test.ts.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { normalizePlayerName } from "./players";
import { drainScheduled } from "../lib/testing/drain-scheduled";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

type T = ReturnType<typeof convexTest>;

const ADMIN_IDENTITY = {
  subject: "admin_autograph_format_commit",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_autograph_format_commit",
  role: "admin",
};

async function seedSet(
  t: T,
  leaf: { level?: "variantType" | "setName"; features?: Record<string, string> } = {},
) {
  return t.run(async (ctx) => {
    const sportId = await ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Baseball",
      platformData: {},
      children: [],
      lastUpdated: Date.now(),
    });
    const setNameId = await ctx.db.insert("selectorOptions", {
      level: "setName",
      value: "Chrome",
      platformData: {},
      parentId: sportId,
      children: [],
      features: { autographed: "None" },
      lastUpdated: Date.now(),
    });
    await ctx.db.patch(sportId, { children: [setNameId] });
    const variantTypeId = await ctx.db.insert("selectorOptions", {
      level: "variantType",
      value: "Base",
      platformData: {},
      parentId: setNameId,
      children: [],
      features: leaf.features ?? { autographed: "None" },
      lastUpdated: Date.now(),
    });
    await ctx.db.patch(setNameId, { children: [variantTypeId] });
    const player = await ctx.db.insert("players", {
      name: "Mike Trout",
      nameNormalized: normalizePlayerName("Mike Trout"),
      sportId,
      lastUpdated: Date.now(),
    });
    return {
      sportId,
      setNameId,
      variantTypeId,
      player,
      leafId: leaf.level === "setName" ? setNameId : variantTypeId,
    };
  });
}

function makeCard(
  cardNumber: string,
  overrides: Partial<{ attributes: string[]; autographType: string; players: string[] }> = {},
) {
  return {
    cardNumber,
    cardName: "Mike Trout",
    team: undefined,
    teams: [],
    players: overrides.players ?? ["Mike Trout"],
    attributes: overrides.attributes ?? [],
    isRookie: false,
    isRelic: false,
    printRun: undefined,
    autographType: overrides.autographType,
    cardVariation: undefined,
    platformData: {},
    unmatched: undefined,
  };
}

async function cardsUnder(t: T, leafId: Id<"selectorOptions">) {
  const rows = await t.run(async (ctx) =>
    ctx.db
      .query("cardChecklist")
      .withIndex("by_selector_option", (q) => q.eq("selectorOptionId", leafId))
      .collect(),
  );
  return new Map(rows.map((r) => [r.cardNumber, r]));
}

describe("commitCardChecklist — autographFormat (NEO-345)", () => {
  test.each(["On Card", "Sticker/Label"] as const)(
    "the answer %s is written onto the leaf and every new AU card is born with it",
    async (format) => {
      const t = convexTest(schema, modules);
      const { sportId, leafId } = await seedSet(t);
      await t.withIdentity(ADMIN_IDENTITY).action(api.selectorOptions.commitCardChecklist, {
        selectorOptionId: leafId,
        sportId,
        cards: [
          // SportLots' wording: it must not decide anything.
          makeCard("1", { attributes: ["AU"], autographType: "Unknown" }),
          makeCard("2", { attributes: ["RC"] }),
        ],
        autographFormat: format,
      });
      await drainScheduled(t);

      const leaf = await t.run(async (ctx) => ctx.db.get(leafId));
      expect(leaf!.features?.autographFormat).toBe(format);

      const cards = await cardsUnder(t, leafId);
      expect(cards.get("1")!.features?.autographed).toBe(format);
      expect(cards.get("1")!.features?.signedBy).toBe("Mike Trout");
      expect(cards.get("1")!.features).not.toHaveProperty("autographFormat");
      expect(cards.get("2")!.features?.autographed).toBe("None");
      expect(cards.get("2")!.features?.signedBy).toBeUndefined();
      expect(cards.get("2")!.features).not.toHaveProperty("autographFormat");
    },
  );

  test("no answer: an AU card stays None whatever the marketplace says", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId } = await seedSet(t);
    await t.withIdentity(ADMIN_IDENTITY).action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: leafId,
      sportId,
      cards: [
        makeCard("1", { attributes: ["AU"], autographType: "Unknown" }),
        makeCard("2", { attributes: ["AU"], autographType: "On-Card" }),
      ],
    });
    await drainScheduled(t);

    const leaf = await t.run(async (ctx) => ctx.db.get(leafId));
    expect(leaf!.features).not.toHaveProperty("autographFormat");
    const cards = await cardsUnder(t, leafId);
    for (const n of ["1", "2"]) {
      expect(cards.get(n)!.features?.autographed).toBe("None");
      expect(cards.get(n)!.features?.signedBy).toBeUndefined();
      expect(cards.get(n)).not.toHaveProperty("autographType");
    }
  });

  test("fill-empty: a leaf that already holds a format keeps it, and its cards follow it", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId } = await seedSet(t, {
      features: { autographed: "None", autographFormat: "Sticker/Label" },
    });
    await t.withIdentity(ADMIN_IDENTITY).action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: leafId,
      sportId,
      cards: [makeCard("1", { attributes: ["AU"] })],
      autographFormat: "On Card",
    });
    await drainScheduled(t);

    const leaf = await t.run(async (ctx) => ctx.db.get(leafId));
    expect(leaf!.features?.autographFormat).toBe("Sticker/Label");
    const cards = await cardsUnder(t, leafId);
    expect(cards.get("1")!.features?.autographed).toBe("Sticker/Label");
  });

  test("a stored format reaches new AU cards with no answer on the wire", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId } = await seedSet(t, {
      features: { autographed: "None", autographFormat: "On Card" },
    });
    await t.withIdentity(ADMIN_IDENTITY).action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: leafId,
      sportId,
      cards: [makeCard("1", { attributes: ["AU"] })],
    });
    await drainScheduled(t);
    const cards = await cardsUnder(t, leafId);
    expect(cards.get("1")!.features?.autographed).toBe("On Card");
    expect(cards.get("1")!.features?.signedBy).toBe("Mike Trout");
  });

  test("an answer for a row that is not a base, insert or parallel is refused before any card is written", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId } = await seedSet(t, { level: "setName" });
    await expect(
      t.withIdentity(ADMIN_IDENTITY).action(api.selectorOptions.commitCardChecklist, {
        selectorOptionId: leafId,
        sportId,
        cards: [makeCard("1", { attributes: ["AU"] })],
        autographFormat: "On Card",
      }),
    ).rejects.toThrow(/base, insert or parallel/);
    await drainScheduled(t);
    const leaf = await t.run(async (ctx) => ctx.db.get(leafId));
    expect(leaf!.features).not.toHaveProperty("autographFormat");
    expect((await cardsUnder(t, leafId)).size).toBe(0);
  });

  test("a value outside the vocabulary is refused at the validator", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId } = await seedSet(t);
    await expect(
      t.withIdentity(ADMIN_IDENTITY).action(api.selectorOptions.commitCardChecklist, {
        selectorOptionId: leafId,
        sportId,
        cards: [makeCard("1", { attributes: ["AU"] })],
        autographFormat: "Unknown" as "On Card",
      }),
    ).rejects.toThrow();
    expect((await cardsUnder(t, leafId)).size).toBe(0);
  });
});

describe("commitCardChecklist — autographFormat reaches the leaf's parallels (Jason, 2026-10-18)", () => {
  test("the Base's answer lands on each base parallel with no format of its own, and their AU cards follow", async () => {
    const t = convexTest(schema, modules);
    const { sportId, setNameId, leafId } = await seedSet(t);
    const { refractorId, sepiaId, refractorCard, sepiaCard } = await t.run(async (ctx) => {
      const parallelsTypeId = await ctx.db.insert("selectorOptions", {
        level: "variantType",
        value: "Parallels",
        platformData: {},
        parentId: setNameId,
        children: [],
        features: { autographed: "None" },
        lastUpdated: Date.now(),
      });
      const row = (value: string, features: Record<string, string>) =>
        ctx.db.insert("selectorOptions", {
          level: "insert",
          value,
          platformData: {},
          parentId: parallelsTypeId,
          children: [],
          features,
          lastUpdated: Date.now(),
        });
      const refractorId = await row("Refractors", { autographed: "None" });
      const sepiaId = await row("Sepia", { autographed: "None", autographFormat: "Sticker/Label" });
      const card = (selectorOptionId: Id<"selectorOptions">) =>
        ctx.db.insert("cardChecklist", {
          selectorOptionId,
          cardNumber: "1",
          cardName: "Mike Trout",
          attributes: ["AU"],
          features: { autographed: "None" },
          platformData: {},
          sortOrder: 1,
          lastUpdated: Date.now(),
        });
      return { refractorId, sepiaId, refractorCard: await card(refractorId), sepiaCard: await card(sepiaId) };
    });

    await t.withIdentity(ADMIN_IDENTITY).action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: leafId,
      sportId,
      cards: [makeCard("1", { attributes: ["AU"] })],
      autographFormat: "On Card",
    });
    await drainScheduled(t);

    const get = <K extends "selectorOptions" | "cardChecklist">(id: Id<K>) => t.run(async (ctx) => ctx.db.get(id));
    expect((await get(refractorId))!.features?.autographFormat).toBe("On Card");
    expect((await get(refractorCard))!.features?.autographed).toBe("On Card");
    // A parallel holding its own format keeps it, and so do its cards.
    expect((await get(sepiaId))!.features?.autographFormat).toBe("Sticker/Label");
    expect((await get(sepiaCard))!.features?.autographed).toBe("None");
  });
});
