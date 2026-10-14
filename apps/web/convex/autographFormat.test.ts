/**
 * NEO-345 — `autographFormat.setAutographFormat` and its chunked cascade.
 *
 * The format is the operator's answer, once per synced leaf, to "how are these
 * signed?" (the marketplaces do not say). These pin: the admin gate and the
 * closed vocabulary; the leaf write; the cascade onto AU cards only, through
 * `applyBscAttributeFill`'s fill-empty rule, with Signed By seeded and an
 * operator's own `autographed` left alone; the clear that touches no card; and
 * the page walk (bounded, resumable, abandoned when a newer answer lands).
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Doc, Id } from "./_generated/dataModel";
import { drainScheduled } from "../lib/testing/drain-scheduled";
import { normalizePlayerName } from "./players";

const modules = (
  import.meta as unknown as {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("./**/*.*s");

const ADMIN = { subject: "admin", role: "admin" };
const SIGNED_IN = { subject: "user" };
const SEEDED_AT = 1_700_000_000_000;

type T = ReturnType<typeof convexTest>;

async function seedLeaf(
  t: T,
  opts: { level?: "variantType" | "insert" | "parallel" | "setName"; features?: Record<string, string> } = {},
): Promise<{ sportId: Id<"selectorOptions">; leafId: Id<"selectorOptions"> }> {
  return t.run(async (ctx) => {
    const sportId = await ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Baseball",
      platformData: {},
      children: [],
      lastUpdated: SEEDED_AT,
    });
    const leafId = await ctx.db.insert("selectorOptions", {
      level: opts.level ?? "insert",
      value: "Signature Series",
      platformData: {},
      parentId: sportId,
      children: [],
      features: opts.features ?? { autographed: "None" },
      lastUpdated: SEEDED_AT,
    });
    return { sportId, leafId };
  });
}

async function seedPlayer(t: T, sportId: Id<"selectorOptions">, name: string) {
  return t.run(async (ctx) =>
    ctx.db.insert("players", {
      name,
      nameNormalized: normalizePlayerName(name),
      sportId,
      lastUpdated: SEEDED_AT,
    }),
  );
}

async function seedCard(
  t: T,
  leafId: Id<"selectorOptions">,
  cardNumber: string,
  fields: Partial<Doc<"cardChecklist">> = {},
): Promise<Id<"cardChecklist">> {
  return t.run(async (ctx) =>
    ctx.db.insert("cardChecklist", {
      selectorOptionId: leafId,
      cardNumber,
      cardName: `Card ${cardNumber}`,
      platformData: {},
      sortOrder: Number(cardNumber) || 0,
      lastUpdated: SEEDED_AT,
      ...fields,
    }),
  );
}

const get = <K extends "cardChecklist" | "selectorOptions">(t: T, id: Id<K>) =>
  t.run(async (ctx) => ctx.db.get(id));

describe("setAutographFormat — the gate and the vocabulary", () => {
  test("refuses a signed-out caller and a non-admin before any write", async () => {
    const t = convexTest(schema, modules);
    const { leafId } = await seedLeaf(t);
    const call = (tt: T) =>
      tt.mutation(api.autographFormat.setAutographFormat, {
        selectorOptionId: leafId,
        value: "On Card",
      });
    await expect(call(t)).rejects.toThrow();
    await expect(call(t.withIdentity(SIGNED_IN))).rejects.toThrow();
    const leaf = await get(t, leafId);
    expect(leaf!.lastUpdated).toBe(SEEDED_AT);
    expect(leaf!.features).toEqual({ autographed: "None" });
  });

  test("refuses a value outside the vocabulary at the validator", async () => {
    const t = convexTest(schema, modules);
    const { leafId } = await seedLeaf(t);
    for (const value of ["Unknown", "on card", "None", "Sticker"]) {
      await expect(
        t.withIdentity(ADMIN).mutation(api.autographFormat.setAutographFormat, {
          selectorOptionId: leafId,
          value: value as "On Card",
        }),
      ).rejects.toThrow();
    }
    expect((await get(t, leafId))!.features).toEqual({ autographed: "None" });
  });

  test("refuses a row that is not a base, insert or parallel", async () => {
    const t = convexTest(schema, modules);
    const { leafId } = await seedLeaf(t, { level: "setName" });
    await expect(
      t.withIdentity(ADMIN).mutation(api.autographFormat.setAutographFormat, {
        selectorOptionId: leafId,
        value: "On Card",
      }),
    ).rejects.toThrow(/base, insert or parallel/);
    expect((await get(t, leafId))!.lastUpdated).toBe(SEEDED_AT);
  });
});

describe("setAutographFormat — the leaf and its AU cards", () => {
  test("writes the leaf, then formats AU cards only, seeding Signed By", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId } = await seedLeaf(t);
    const griffey = await seedPlayer(t, sportId, "Ken Griffey Jr.");
    const ripken = await seedPlayer(t, sportId, "Cal Ripken Jr.");

    const auNone = await seedCard(t, leafId, "1", {
      attributes: ["AU"],
      playerIds: [griffey],
      features: { autographed: "None" },
    });
    const auAbsent = await seedCard(t, leafId, "2", {
      attributes: ["AU", "RC"],
      playerIds: [griffey, ripken],
    });
    const plain = await seedCard(t, leafId, "3", {
      attributes: ["RC"],
      playerIds: [ripken],
      features: { autographed: "None" },
    });
    const keepsSigner = await seedCard(t, leafId, "4", {
      attributes: ["AU"],
      playerIds: [griffey],
      features: { autographed: "None", signedBy: "Someone Else" },
    });

    await t.withIdentity(ADMIN).mutation(api.autographFormat.setAutographFormat, {
      selectorOptionId: leafId,
      value: "Sticker/Label",
    });
    // The leaf is written in the mutation itself.
    expect((await get(t, leafId))!.features?.autographFormat).toBe("Sticker/Label");
    await drainScheduled(t);

    const one = await get(t, auNone);
    expect(one!.features?.autographed).toBe("Sticker/Label");
    expect(one!.features?.signedBy).toBe("Ken Griffey Jr.");

    const two = await get(t, auAbsent);
    expect(two!.features?.autographed).toBe("Sticker/Label");
    expect(two!.features?.signedBy).toBe("Ken Griffey Jr., Cal Ripken Jr.");

    const three = await get(t, plain);
    expect(three!.features).toEqual({ autographed: "None" });
    expect(three!.lastUpdated).toBe(SEEDED_AT);

    const four = await get(t, keepsSigner);
    expect(four!.features?.autographed).toBe("Sticker/Label");
    expect(four!.features?.signedBy).toBe("Someone Else");
  });

  test("an operator's own autographed on an AU card is left alone", async () => {
    const t = convexTest(schema, modules);
    const { leafId } = await seedLeaf(t);
    const override = await seedCard(t, leafId, "1", {
      attributes: ["AU"],
      features: { autographed: "On Card", signedBy: "Ken Griffey Jr." },
    });
    await t.withIdentity(ADMIN).mutation(api.autographFormat.setAutographFormat, {
      selectorOptionId: leafId,
      value: "Sticker/Label",
    });
    await drainScheduled(t);
    const row = await get(t, override);
    expect(row!.features).toEqual({ autographed: "On Card", signedBy: "Ken Griffey Jr." });
    expect(row!.lastUpdated).toBe(SEEDED_AT);
  });

  test("a changed answer moves the cards the PREVIOUS answer formatted", async () => {
    const t = convexTest(schema, modules);
    const { leafId } = await seedLeaf(t);
    const card = await seedCard(t, leafId, "1", {
      attributes: ["AU"],
      features: { autographed: "None" },
    });
    const admin = t.withIdentity(ADMIN);
    await admin.mutation(api.autographFormat.setAutographFormat, {
      selectorOptionId: leafId,
      value: "On Card",
    });
    await drainScheduled(t);
    expect((await get(t, card))!.features?.autographed).toBe("On Card");

    await admin.mutation(api.autographFormat.setAutographFormat, {
      selectorOptionId: leafId,
      value: "Sticker/Label",
    });
    await drainScheduled(t);
    expect((await get(t, leafId))!.features?.autographFormat).toBe("Sticker/Label");
    expect((await get(t, card))!.features?.autographed).toBe("Sticker/Label");
  });

  test("a clear removes the leaf's key and touches no card", async () => {
    const t = convexTest(schema, modules);
    const { leafId } = await seedLeaf(t, {
      features: { autographed: "None", autographFormat: "On Card" },
    });
    const card = await seedCard(t, leafId, "1", {
      attributes: ["AU"],
      features: { autographed: "On Card" },
    });
    await t.withIdentity(ADMIN).mutation(api.autographFormat.setAutographFormat, {
      selectorOptionId: leafId,
      value: "",
    });
    await drainScheduled(t);
    const leaf = await get(t, leafId);
    expect(leaf!.features).toEqual({ autographed: "None" });
    expect(leaf!.features).not.toHaveProperty("autographFormat");
    const row = await get(t, card);
    expect(row!.features).toEqual({ autographed: "On Card" });
    expect(row!.lastUpdated).toBe(SEEDED_AT);
    const scheduled = await t.run(async (ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(scheduled).toEqual([]);
  });

  test("a clear on a leaf with no format writes nothing", async () => {
    const t = convexTest(schema, modules);
    const { leafId } = await seedLeaf(t);
    await t.withIdentity(ADMIN).mutation(api.autographFormat.setAutographFormat, {
      selectorOptionId: leafId,
      value: "",
    });
    expect((await get(t, leafId))!.lastUpdated).toBe(SEEDED_AT);
  });

  test("re-picking the same answer formats AU cards that arrived since, without re-writing the leaf", async () => {
    const t = convexTest(schema, modules);
    const { leafId } = await seedLeaf(t, {
      features: { autographed: "None", autographFormat: "On Card" },
    });
    const late = await seedCard(t, leafId, "1", {
      attributes: ["AU"],
      features: { autographed: "None" },
    });
    await t.withIdentity(ADMIN).mutation(api.autographFormat.setAutographFormat, {
      selectorOptionId: leafId,
      value: "On Card",
    });
    expect((await get(t, leafId))!.lastUpdated).toBe(SEEDED_AT);
    await drainScheduled(t);
    expect((await get(t, late))!.features?.autographed).toBe("On Card");
  });
});

describe("cascadeAutographFormatPage — the bounded walk", () => {
  test("pages by the write bound, resumes after the last card examined, and finishes", async () => {
    const t = convexTest(schema, modules);
    const { leafId } = await seedLeaf(t, {
      features: { autographed: "None", autographFormat: "On Card" },
    });
    const ids: Array<Id<"cardChecklist">> = [];
    for (let i = 1; i <= 7; i++) {
      ids.push(
        await seedCard(t, leafId, String(i), {
          // Every other card is an auto; the plain ones cost no write.
          attributes: i % 2 === 1 ? ["AU"] : ["RC"],
          features: { autographed: "None" },
        }),
      );
    }
    let after: number | undefined;
    let pages = 0;
    let formatted = 0;
    for (;;) {
      const page = await t.mutation(internal.autographFormat.cascadeAutographFormatPage, {
        selectorOptionId: leafId,
        format: "On Card",
        writeLimit: 2,
        scanLimit: 5,
        ...(after !== undefined ? { after } : {}),
      });
      pages++;
      formatted += page.formatted;
      expect(page.abandoned).toBe(false);
      if (page.done) break;
      expect(page.after).not.toBeNull();
      expect(page.after).not.toBe(after);
      after = page.after!;
      expect(pages).toBeLessThan(10);
    }
    expect(formatted).toBe(4);
    expect(pages).toBeGreaterThan(1);
    for (const [i, id] of ids.entries()) {
      const row = await get(t, id);
      expect(row!.features?.autographed).toBe(i % 2 === 0 ? "On Card" : "None");
    }

    // Idempotent: a second walk writes nothing.
    const again = await t.mutation(internal.autographFormat.cascadeAutographFormatPage, {
      selectorOptionId: leafId,
      format: "On Card",
    });
    expect(again).toMatchObject({ done: true, formatted: 0, skippedOverride: 0 });
  });

  test("counts an override instead of filling it", async () => {
    const t = convexTest(schema, modules);
    const { leafId } = await seedLeaf(t, {
      features: { autographed: "None", autographFormat: "Sticker/Label" },
    });
    await seedCard(t, leafId, "1", { attributes: ["AU"], features: { autographed: "On Card" } });
    await seedCard(t, leafId, "2", { attributes: ["AU"] });
    const page = await t.mutation(internal.autographFormat.cascadeAutographFormatPage, {
      selectorOptionId: leafId,
      format: "Sticker/Label",
    });
    expect(page).toMatchObject({ done: true, formatted: 1, skippedOverride: 1, scanned: 2 });
  });

  test("abandons when the leaf no longer holds the format it is spreading", async () => {
    const t = convexTest(schema, modules);
    const { leafId } = await seedLeaf(t, {
      features: { autographed: "None", autographFormat: "Sticker/Label" },
    });
    const card = await seedCard(t, leafId, "1", {
      attributes: ["AU"],
      features: { autographed: "None" },
    });
    const page = await t.mutation(internal.autographFormat.cascadeAutographFormatPage, {
      selectorOptionId: leafId,
      format: "On Card",
    });
    expect(page.abandoned).toBe(true);
    expect((await get(t, card))!.features?.autographed).toBe("None");
  });

  test("the action walks every page to the end", async () => {
    const t = convexTest(schema, modules);
    const { leafId } = await seedLeaf(t, {
      features: { autographed: "None", autographFormat: "On Card" },
    });
    for (let i = 1; i <= 3; i++) {
      await seedCard(t, leafId, String(i), { attributes: ["AU"] });
    }
    const result = await t.action(internal.autographFormat.cascadeAutographFormat, {
      selectorOptionId: leafId,
      format: "On Card",
    });
    expect(result).toEqual({ pages: 1, formatted: 3, skippedOverride: 0, abandoned: false });
  });
});

describe("the generic feature doors refuse autographFormat (NEO-345)", () => {
  test("setSelectorOptionFeature refuses a set and a clear, pointing at setAutographFormat", async () => {
    const t = convexTest(schema, modules);
    const { leafId } = await seedLeaf(t, {
      features: { autographed: "None", autographFormat: "On Card" },
    });
    for (const value of ["Sticker/Label", ""]) {
      await expect(
        t.withIdentity(ADMIN).mutation(api.selectorOptions.setSelectorOptionFeature, {
          selectorOptionId: leafId,
          key: "autographFormat",
          value,
        }),
      ).rejects.toThrow(/setAutographFormat/);
    }
    const leaf = await get(t, leafId);
    expect(leaf!.features?.autographFormat).toBe("On Card");
    expect(leaf!.lastUpdated).toBe(SEEDED_AT);
  });

  test("setCardFeature refuses it too: a card has no format of its own", async () => {
    const t = convexTest(schema, modules);
    const { leafId } = await seedLeaf(t);
    const card = await seedCard(t, leafId, "1", { attributes: ["AU"] });
    await expect(
      t.withIdentity(ADMIN).mutation(api.selectorOptions.setCardFeature, {
        cardChecklistId: card,
        key: "autographFormat",
        value: "On Card",
      }),
    ).rejects.toThrow(/setAutographFormat/);
    expect((await get(t, card))!.lastUpdated).toBe(SEEDED_AT);
  });

  test("every other key still goes through", async () => {
    const t = convexTest(schema, modules);
    const { leafId } = await seedLeaf(t);
    await t.withIdentity(ADMIN).mutation(api.selectorOptions.setSelectorOptionFeature, {
      selectorOptionId: leafId,
      key: "autographed",
      value: "On Card",
    });
    expect((await get(t, leafId))!.features?.autographed).toBe("On Card");
  });
});

/**
 * Jason chose to ask for the format per synced PART, never per set: a node
 * created under an answered node starts unanswered. The behaviour tests cover
 * the sync store and the hand-made row; the source pin below covers every
 * other creation path (conversions, the SportLots review, the reconciler),
 * whose fixtures are too heavy to rebuild here.
 */
describe("autographFormat never copies down to a new node (NEO-345)", () => {
  async function seedAnsweredType(t: T) {
    return t.run(async (ctx) => {
      const sportId = await ctx.db.insert("selectorOptions", {
        level: "sport",
        value: "Baseball",
        platformData: {},
        children: [],
        lastUpdated: SEEDED_AT,
      });
      const setNameId = await ctx.db.insert("selectorOptions", {
        level: "setName",
        value: "Chrome",
        platformData: {},
        parentId: sportId,
        children: [],
        lastUpdated: SEEDED_AT,
      });
      const typeId = await ctx.db.insert("selectorOptions", {
        level: "variantType",
        value: "Inserts",
        platformData: {},
        parentId: setNameId,
        children: [],
        features: { season: "2026", autographed: "None", autographFormat: "On Card" },
        lastUpdated: SEEDED_AT,
      });
      await ctx.db.patch(sportId, { children: [setNameId] });
      await ctx.db.patch(setNameId, { children: [typeId] });
      return { typeId };
    });
  }

  test("a synced insert under an answered type inherits everything else, not the format", async () => {
    const t = convexTest(schema, modules);
    const { typeId } = await seedAnsweredType(t);
    await t.withIdentity(ADMIN).mutation(api.selectorOptions.storeSelectorOptions, {
      level: "insert",
      parentId: typeId,
      options: [{ value: "Signature Series", platformData: { bsc: "sig-1" } }],
      coveredSides: ["bsc"],
    });
    const [row] = await t.run(async (ctx) =>
      ctx.db
        .query("selectorOptions")
        .withIndex("by_level_and_parent", (q) =>
          q.eq("level", "insert").eq("parentId", typeId),
        )
        .collect(),
    );
    expect(row.features?.season).toBe("2026");
    expect(row.features).not.toHaveProperty("autographFormat");
  });

  test("a hand-made insert under an answered type does not inherit it either", async () => {
    const t = convexTest(schema, modules);
    const { typeId } = await seedAnsweredType(t);
    const id = await t.withIdentity(ADMIN).mutation(
      api.selectorOptions.addCustomSelectorOption,
      { level: "insert", value: "Signature Series", parentId: typeId },
    );
    const row = await get(t, id);
    expect(row!.features?.season).toBe("2026");
    expect(row!.features).not.toHaveProperty("autographFormat");
  });

  test("every node-creation copy-down spreads inheritableFeatures, never a parent's raw map", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const sites: Array<[string, RegExp]> = [
      ["selectorOptions.ts", /\.\.\.\(parentFeatures \?\? \{\}\)|\.\.\.\(parent\?\.features \?\? \{\}\)/],
      ["setReconciliation.ts", /\.\.\.\(parentFeatures \?\? \{\}\)/],
      ["setParallelConversion.ts", /\.\.\.\(targetType\.features \?\? \{\}\)/],
      ["setInsertConversion.ts", /\.\.\.\(parent\.features \?\? \{\}\)/],
      ["slSetReview.ts", /\.\.\.\(type\.features \?\? \{\}\)/],
    ];
    for (const [file, raw] of sites) {
      const src = readFileSync(join(__dirname, file), "utf8");
      expect(src, file).not.toMatch(raw);
      expect(src, file).toContain("...inheritableFeatures(");
    }
  });

  test("the materialize cascade refuses it", async () => {
    const t = convexTest(schema, modules);
    const { leafId } = await seedLeaf(t);
    const { materializeSelectorOptionFeature } = await import("./selectorOptions");
    await expect(
      t.run((ctx) => materializeSelectorOptionFeature(ctx, leafId, "autographFormat", "On Card")),
    ).rejects.toThrow(/not inherited/);
  });
});

describe("addCustomCard under an answered leaf (NEO-345)", () => {
  test("an AU card is born with the leaf's format and Signed By; the key stays on the leaf", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId } = await seedLeaf(t, {
      level: "variantType",
      features: { autographed: "None", autographFormat: "Sticker/Label" },
    });
    const griffey = await seedPlayer(t, sportId, "Ken Griffey Jr.");
    const admin = t.withIdentity(ADMIN);
    await admin.mutation(api.selectorOptions.addCustomCard, {
      selectorOptionId: leafId,
      cardNumber: "1",
      cardName: "Ken Griffey Jr.",
      attributes: ["AU"],
      playerIds: [griffey],
    });
    await admin.mutation(api.selectorOptions.addCustomCard, {
      selectorOptionId: leafId,
      cardNumber: "2",
      cardName: "Ken Griffey Jr.",
      attributes: ["RC"],
      playerIds: [griffey],
    });
    await drainScheduled(t);
    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("cardChecklist")
        .withIndex("by_selector_option", (q) => q.eq("selectorOptionId", leafId))
        .collect(),
    );
    const byNumber = new Map(rows.map((r) => [r.cardNumber, r]));
    const auto = byNumber.get("1")!;
    expect(auto.features?.autographed).toBe("Sticker/Label");
    expect(auto.features?.signedBy).toBe("Ken Griffey Jr.");
    expect(auto.features).not.toHaveProperty("autographFormat");
    const plain = byNumber.get("2")!;
    expect(plain.features?.autographed).toBe("None");
    expect(plain.features?.signedBy).toBeUndefined();
    expect(plain.features).not.toHaveProperty("autographFormat");
  });

  test("with no answer on the leaf an AU card stays None", async () => {
    const t = convexTest(schema, modules);
    const { leafId } = await seedLeaf(t, { level: "variantType" });
    await t.withIdentity(ADMIN).mutation(api.selectorOptions.addCustomCard, {
      selectorOptionId: leafId,
      cardNumber: "1",
      cardName: "Somebody",
      attributes: ["AU"],
    });
    await drainScheduled(t);
    const [row] = await t.run(async (ctx) =>
      ctx.db
        .query("cardChecklist")
        .withIndex("by_selector_option", (q) => q.eq("selectorOptionId", leafId))
        .collect(),
    );
    expect(row.features?.autographed).toBe("None");
    expect(row.features?.signedBy).toBeUndefined();
  });
});
