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
import { autographPromptAsks, autographPromptCount } from "../components/SetSelector/autograph-prompt";
import { generateListingDescription } from "./features/generateListing";
import { findAncestorLabels, storedCardListingInputs, storedCardTitleNames } from "./storedCardTitle";

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
    expect(result).toEqual({
      pages: 1,
      formatted: 3,
      skippedOverride: 0,
      abandoned: false,
      retitled: 0,
      redescribed: 0,
      parallels: 0,
    });
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
 * created under an answered node starts unanswered. (A parallel takes its
 * insert's answer when the answer is given or the parallel is BUILT — the
 * describes at the end of this file — never at the row's creation.) The behaviour tests cover
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

// ---------------------------------------------------------------------------
// Jason, 2026-10-18 — "insert info should be copied to its parallels"
// ---------------------------------------------------------------------------

/**
 * An insert with three parallels: one with no format of its own, one already
 * holding a DIFFERENT format, one already holding the format the test answers.
 */
async function seedInsertWithParallels(t: T) {
  return t.run(async (ctx) => {
    const sportId = await ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Baseball",
      platformData: {},
      children: [],
      lastUpdated: SEEDED_AT,
    });
    const insertId = await ctx.db.insert("selectorOptions", {
      level: "insert",
      value: "Signature Series",
      platformData: {},
      parentId: sportId,
      children: [],
      features: { autographed: "None" },
      lastUpdated: SEEDED_AT,
    });
    const parallel = (value: string, features: Record<string, string>) =>
      ctx.db.insert("selectorOptions", {
        level: "parallel",
        value,
        platformData: {},
        parentId: insertId,
        children: [],
        features,
        lastUpdated: SEEDED_AT,
      });
    const unsetId = await parallel("Gold", { autographed: "None", cardType: "Parallel" });
    const ownId = await parallel("Red", { autographed: "None", autographFormat: "Sticker/Label" });
    const sameId = await parallel("Blue", { autographed: "None", autographFormat: "On Card" });
    await ctx.db.patch(insertId, { children: [unsetId, ownId, sameId] });
    return { sportId, insertId, unsetId, ownId, sameId };
  });
}

/** The cards of a row, as the checklist header counts them. */
const cardsOf = (t: T, selectorOptionId: Id<"selectorOptions">) =>
  t.run(async (ctx) =>
    ctx.db
      .query("cardChecklist")
      .withIndex("by_selector_option", (q) => q.eq("selectorOptionId", selectorOptionId))
      .collect(),
  );

describe("setAutographFormat — an insert's answer reaches its parallels", () => {
  test("a parallel with no format takes it, its AU cards follow, and its header stops asking", async () => {
    const t = convexTest(schema, modules);
    const { sportId, insertId, unsetId, sameId } = await seedInsertWithParallels(t);
    const griffey = await seedPlayer(t, sportId, "Ken Griffey Jr.");
    await seedCard(t, insertId, "1", { attributes: ["AU"], playerIds: [griffey], features: { autographed: "None" } });
    const parallelAu = await seedCard(t, unsetId, "1", {
      attributes: ["AU"],
      playerIds: [griffey],
      features: { autographed: "None" },
    });
    const parallelPlain = await seedCard(t, unsetId, "2", { attributes: ["RC"], features: { autographed: "None" } });
    // Before the answer the parallel's header asks.
    expect(autographPromptCount(undefined, await cardsOf(t, unsetId))).toBe(1);

    const result = await t.withIdentity(ADMIN).mutation(api.autographFormat.setAutographFormat, {
      selectorOptionId: insertId,
      value: "On Card",
    });
    // In the answer's own transaction: the parallel holds the format.
    expect(result.parallelIds).toEqual([unsetId, sameId]);
    const gold = await get(t, unsetId);
    expect(gold!.features).toEqual({ autographed: "None", cardType: "Parallel", autographFormat: "On Card" });
    expect(gold!.lastUpdated).not.toBe(SEEDED_AT);
    await drainScheduled(t);

    const au = await get(t, parallelAu);
    expect(au!.features?.autographed).toBe("On Card");
    expect(au!.features?.signedBy).toBe("Ken Griffey Jr.");
    expect((await get(t, parallelPlain))!.lastUpdated).toBe(SEEDED_AT);
    // The prompt's own rule: the parallel no longer asks.
    const after = await cardsOf(t, unsetId);
    expect(autographPromptAsks(gold!.features?.autographFormat, autographPromptCount(undefined, after))).toBe(false);
    expect(autographPromptCount(gold!.features?.autographFormat, after)).toBe(0);
  });

  test("a parallel already holding another format is never overwritten, and its cards are not walked", async () => {
    const t = convexTest(schema, modules);
    const { insertId, ownId } = await seedInsertWithParallels(t);
    const ownCard = await seedCard(t, ownId, "1", { attributes: ["AU"], features: { autographed: "None" } });
    const result = await t.withIdentity(ADMIN).mutation(api.autographFormat.setAutographFormat, {
      selectorOptionId: insertId,
      value: "On Card",
    });
    expect(result.parallelIds).not.toContain(ownId);
    await drainScheduled(t);
    const red = await get(t, ownId);
    expect(red!.features?.autographFormat).toBe("Sticker/Label");
    expect(red!.lastUpdated).toBe(SEEDED_AT);
    const card = await get(t, ownCard);
    expect(card!.features?.autographed).toBe("None");
    expect(card!.lastUpdated).toBe(SEEDED_AT);
  });

  test("a parallel already holding the same format has its AU cards walked again", async () => {
    const t = convexTest(schema, modules);
    const { insertId, sameId } = await seedInsertWithParallels(t);
    const late = await seedCard(t, sameId, "1", { attributes: ["AU"], features: { autographed: "None" } });
    await t.withIdentity(ADMIN).mutation(api.autographFormat.setAutographFormat, {
      selectorOptionId: insertId,
      value: "On Card",
    });
    expect((await get(t, sameId))!.lastUpdated).toBe(SEEDED_AT);
    await drainScheduled(t);
    expect((await get(t, late))!.features?.autographed).toBe("On Card");
  });

  test("a parallel's own answer does not reach its insert or its siblings", async () => {
    const t = convexTest(schema, modules);
    const { insertId, unsetId, sameId } = await seedInsertWithParallels(t);
    const result = await t.withIdentity(ADMIN).mutation(api.autographFormat.setAutographFormat, {
      selectorOptionId: sameId,
      value: "Sticker/Label",
    });
    expect(result.parallelIds).toEqual([]);
    expect((await get(t, insertId))!.features).toEqual({ autographed: "None" });
    expect((await get(t, unsetId))!.features).not.toHaveProperty("autographFormat");
  });

  test("a corrected misclick moves the parallels that took it: On Card → Sticker carries them and their cards", async () => {
    const t = convexTest(schema, modules);
    const { insertId, unsetId, sameId } = await seedInsertWithParallels(t);
    const goldCard = await seedCard(t, unsetId, "1", { attributes: ["AU"], features: { autographed: "None" } });
    const blueCard = await seedCard(t, sameId, "1", { attributes: ["AU"], features: { autographed: "None" } });
    const admin = t.withIdentity(ADMIN);
    await admin.mutation(api.autographFormat.setAutographFormat, { selectorOptionId: insertId, value: "On Card" });
    await drainScheduled(t);
    expect((await get(t, goldCard))!.features?.autographed).toBe("On Card");

    const second = await admin.mutation(api.autographFormat.setAutographFormat, {
      selectorOptionId: insertId,
      value: "Sticker/Label",
    });
    // Gold took "On Card" from the insert, Blue held it: both still hold the
    // insert's previous answer, so both move with it, in the same transaction.
    expect(second.parallelIds).toEqual(expect.arrayContaining([unsetId, sameId]));
    expect((await get(t, unsetId))!.features?.autographFormat).toBe("Sticker/Label");
    expect((await get(t, sameId))!.features?.autographFormat).toBe("Sticker/Label");
    await drainScheduled(t);
    // Their cards still holding the previous answer move too.
    expect((await get(t, goldCard))!.features?.autographed).toBe("Sticker/Label");
    expect((await get(t, blueCard))!.features?.autographed).toBe("Sticker/Label");
  });

  test("a parallel with its own different answer stays put when the insert's answer changes, and so do its cards", async () => {
    const t = convexTest(schema, modules);
    const { insertId, ownId } = await seedInsertWithParallels(t);
    // Red was answered on its own ("Sticker/Label"), and an operator set one
    // of its cards to "On Card" by hand.
    const redOverride = await seedCard(t, ownId, "1", { attributes: ["AU"], features: { autographed: "On Card" } });
    const redLate = await seedCard(t, ownId, "2", { attributes: ["AU"], features: { autographed: "None" } });
    const admin = t.withIdentity(ADMIN);
    await admin.mutation(api.autographFormat.setAutographFormat, { selectorOptionId: insertId, value: "On Card" });
    await drainScheduled(t);
    // Red holds a different answer from the insert's: untouched.
    expect((await get(t, ownId))!.features?.autographFormat).toBe("Sticker/Label");
    expect((await get(t, redLate))!.features?.autographed).toBe("None");

    await admin.mutation(api.autographFormat.setAutographFormat, { selectorOptionId: insertId, value: "Sticker/Label" });
    await drainScheduled(t);
    const red = await get(t, ownId);
    expect(red!.features?.autographFormat).toBe("Sticker/Label");
    expect(red!.lastUpdated).toBe(SEEDED_AT);
    // Red did not move (it never held the insert's previous answer), so its
    // operator's "On Card" card is not carried to Sticker; its unformatted
    // card takes Red's own answer, which the insert's now equals.
    expect((await get(t, redOverride))!.features?.autographed).toBe("On Card");
    expect((await get(t, redLate))!.features?.autographed).toBe("Sticker/Label");
  });

  test("a clear reaches no parallel", async () => {
    const t = convexTest(schema, modules);
    const { insertId, sameId } = await seedInsertWithParallels(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(insertId, { features: { autographed: "None", autographFormat: "On Card" } });
    });
    const result = await t.withIdentity(ADMIN).mutation(api.autographFormat.setAutographFormat, {
      selectorOptionId: insertId,
      value: "",
    });
    expect(result).toEqual({ parallelIds: [] });
    expect((await get(t, sameId))!.features?.autographFormat).toBe("On Card");
  });
});

/**
 * The Base and its parallels: sport › setName › variantType "Base", and a
 * sibling variantType "Parallels" holding two base parallels (`insert`-level
 * rows), one of which has a parallel of its own.
 */
async function seedBaseWithParallels(t: T, opts: { secondBase?: boolean } = {}) {
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
    const type = (value: string) =>
      ctx.db.insert("selectorOptions", {
        level: "variantType",
        value,
        platformData: {},
        parentId: setNameId,
        children: [],
        features: { autographed: "None" },
        lastUpdated: SEEDED_AT,
      });
    const baseId = await type("Base");
    if (opts.secondBase) await type("Bases");
    const parallelsTypeId = await type("Parallels");
    const insertsTypeId = await type("Inserts");
    const row = (level: "insert" | "parallel", value: string, parentId: Id<"selectorOptions">, features: Record<string, string> = { autographed: "None" }) =>
      ctx.db.insert("selectorOptions", {
        level,
        value,
        platformData: {},
        parentId,
        children: [],
        features,
        lastUpdated: SEEDED_AT,
      });
    const refractorId = await row("insert", "Refractors", parallelsTypeId);
    const refractorGoldId = await row("parallel", "Refractors Gold", refractorId);
    const sepiaId = await row("insert", "Sepia", parallelsTypeId, { autographed: "None", autographFormat: "Sticker/Label" });
    const sepiaRedId = await row("parallel", "Sepia Red", sepiaId);
    // An insert under the Inserts type is not a parallel of the Base.
    const futureId = await row("insert", "Future Stars", insertsTypeId);
    return { baseId, refractorId, refractorGoldId, sepiaId, sepiaRedId, futureId };
  });
}

describe("setAutographFormat — a Base answer reaches the Base's parallels", () => {
  test("each base parallel with no format takes it, and so do ITS parallels; one holding its own stops the reach there", async () => {
    const t = convexTest(schema, modules);
    const ids = await seedBaseWithParallels(t);
    const refractorCard = await seedCard(t, ids.refractorId, "1", { attributes: ["AU"], features: { autographed: "None" } });
    const goldCard = await seedCard(t, ids.refractorGoldId, "1", { attributes: ["AU"], features: { autographed: "None" } });

    const result = await t.withIdentity(ADMIN).mutation(api.autographFormat.setAutographFormat, {
      selectorOptionId: ids.baseId,
      value: "On Card",
    });
    expect(result.parallelIds).toEqual([ids.refractorId, ids.refractorGoldId]);
    await drainScheduled(t);

    expect((await get(t, ids.refractorId))!.features?.autographFormat).toBe("On Card");
    expect((await get(t, ids.refractorGoldId))!.features?.autographFormat).toBe("On Card");
    expect((await get(t, refractorCard))!.features?.autographed).toBe("On Card");
    expect((await get(t, goldCard))!.features?.autographed).toBe("On Card");
    // Sepia holds its own answer, so neither it nor its parallel moves.
    expect((await get(t, ids.sepiaId))!.features?.autographFormat).toBe("Sticker/Label");
    expect((await get(t, ids.sepiaRedId))!.features).not.toHaveProperty("autographFormat");
    // An insert is not a base parallel.
    expect((await get(t, ids.futureId))!.features).not.toHaveProperty("autographFormat");
  });

  test("a set with no single Base reaches nothing, as the build refuses it", async () => {
    const t = convexTest(schema, modules);
    const ids = await seedBaseWithParallels(t, { secondBase: true });
    const result = await t.withIdentity(ADMIN).mutation(api.autographFormat.setAutographFormat, {
      selectorOptionId: ids.baseId,
      value: "On Card",
    });
    expect(result.parallelIds).toEqual([]);
    expect((await get(t, ids.refractorId))!.features).not.toHaveProperty("autographFormat");
  });
});

describe("inheritAutographFormatToParallels — the commit door", () => {
  test("reaches the parallels and walks only their cards (the leaf's are born formatted)", async () => {
    const t = convexTest(schema, modules);
    const { insertId, unsetId } = await seedInsertWithParallels(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(insertId, { features: { autographed: "None", autographFormat: "On Card" } });
    });
    const leafCard = await seedCard(t, insertId, "9", { attributes: ["AU"], features: { autographed: "None" } });
    const parallelCard = await seedCard(t, unsetId, "1", { attributes: ["AU"], features: { autographed: "None" } });
    await t.mutation(internal.autographFormat.inheritAutographFormatToParallels, {
      selectorOptionId: insertId,
      format: "On Card",
    });
    expect((await get(t, unsetId))!.features?.autographFormat).toBe("On Card");
    await drainScheduled(t);
    expect((await get(t, parallelCard))!.features?.autographed).toBe("On Card");
    // `walkLeaf: false` — the leaf's own walk is the commit's, not this one's.
    expect((await get(t, leafCard))!.features?.autographed).toBe("None");
  });

  test("does nothing once the leaf no longer holds the format", async () => {
    const t = convexTest(schema, modules);
    const { insertId, unsetId } = await seedInsertWithParallels(t);
    await t.mutation(internal.autographFormat.inheritAutographFormatToParallels, {
      selectorOptionId: insertId,
      format: "On Card",
    });
    expect((await get(t, unsetId))!.features).not.toHaveProperty("autographFormat");
    const scheduled = await t.run(async (ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled).toEqual([]);
  });
});

describe("a parallel built after its insert has a format inherits it", () => {
  async function buildOne(t: T, parallelId: Id<"selectorOptions">, insertId: Id<"selectorOptions">, sourceCardId: Id<"cardChecklist">) {
    return t.mutation(internal.parallelChecklistBuild.insertParallelCardsPage, {
      parallelId,
      sourceId: insertId,
      copies: [
        {
          sourceCardId,
          expect: { cardNumber: "1", cardName: "Card 1", namesOnCard: [] },
          bsc: { ref: "bsc-1" },
        },
      ],
      remap: [],
    });
  }

  test("the first copy page writes the insert's format onto the parallel and the AU copy is born formatted, AUTO in its title", async () => {
    const t = convexTest(schema, modules);
    const { insertId, unsetId } = await seedInsertWithParallels(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(insertId, { features: { autographed: "None", autographFormat: "Sticker/Label" } });
    });
    // An insert card the cascade has not reached yet: the copy is formatted
    // by the parallel's inherited answer, not by the card's own fact.
    const source = await seedCard(t, insertId, "1", { attributes: ["AU"], features: { autographed: "None" } });
    const page = await buildOne(t, unsetId, insertId, source);
    expect(page.changed).toBe(false);
    expect(page.created).toHaveLength(1);
    expect((await get(t, unsetId))!.features?.autographFormat).toBe("Sticker/Label");
    const copy = await get(t, page.created[0].to);
    expect(copy!.features?.autographed).toBe("Sticker/Label");
    expect(copy!.features).not.toHaveProperty("autographFormat");
    expect(copy!.listingTitle).toMatch(/\bAUTO\b/);
  });

  test("a parallel holding its own format keeps it at build time", async () => {
    const t = convexTest(schema, modules);
    const { insertId, ownId } = await seedInsertWithParallels(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(insertId, { features: { autographed: "None", autographFormat: "On Card" } });
    });
    const source = await seedCard(t, insertId, "1", { attributes: ["AU"], features: { autographed: "None" } });
    const page = await buildOne(t, ownId, insertId, source);
    expect((await get(t, ownId))!.features?.autographFormat).toBe("Sticker/Label");
    expect((await get(t, page.created[0].to))!.features?.autographed).toBe("Sticker/Label");
  });

  test("an insert with no format gives the parallel none", async () => {
    const t = convexTest(schema, modules);
    const { insertId, unsetId } = await seedInsertWithParallels(t);
    const source = await seedCard(t, insertId, "1", { attributes: ["AU"], features: { autographed: "None" } });
    const page = await buildOne(t, unsetId, insertId, source);
    expect((await get(t, unsetId))!.features).not.toHaveProperty("autographFormat");
    expect((await get(t, page.created[0].to))!.features?.autographed).toBe("None");
  });

  test("a changed page (another build got there first) writes no format", async () => {
    const t = convexTest(schema, modules);
    const { insertId, unsetId } = await seedInsertWithParallels(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(insertId, { features: { autographed: "None", autographFormat: "On Card" } });
    });
    const source = await seedCard(t, insertId, "1", { attributes: ["AU"], features: { autographed: "None" } });
    await seedCard(t, unsetId, "1", {});
    const page = await buildOne(t, unsetId, insertId, source);
    expect(page.changed).toBe(true);
    expect((await get(t, unsetId))!.features).not.toHaveProperty("autographFormat");
  });
});

// ---------------------------------------------------------------------------
// Jason, 2026-10-18 — the generated title is rebuilt once the format lands
// ---------------------------------------------------------------------------

describe("the cascade rebuilds a still-generated title", () => {
  const preview = (t: T, cardId: Id<"cardChecklist">) =>
    t.withIdentity(ADMIN).query(api.selectorOptions.previewListingTitle, { cardId });

  /** Seed an AU card whose stored title is exactly what the generator makes of it now. */
  async function generatedCard(
    t: T,
    leafId: Id<"selectorOptions">,
    cardNumber: string,
    fields: Partial<Doc<"cardChecklist">>,
  ) {
    const id = await seedCard(t, leafId, cardNumber, { attributes: ["AU"], features: { autographed: "None" }, ...fields });
    const before = await preview(t, id);
    await t.run(async (ctx) => {
      await ctx.db.patch(id, {
        listingTitle: before.title,
        ...(before.coreFits ? {} : { listingTitleTruncated: true }),
      });
    });
    return { id, before };
  }

  test("a generated title gains AUTO, built by Regenerate's own builder; the flag stays absent", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId } = await seedLeaf(t, { features: { autographed: "None", season: "2024" } });
    const griffey = await seedPlayer(t, sportId, "Ken Griffey Jr.");
    const { id, before } = await generatedCard(t, leafId, "1", { playerIds: [griffey] });
    expect(before.title).not.toMatch(/\bAUTO\b/);

    await t.withIdentity(ADMIN).mutation(api.autographFormat.setAutographFormat, {
      selectorOptionId: leafId,
      value: "On Card",
    });
    await drainScheduled(t);

    const row = await get(t, id);
    expect(row!.features?.autographed).toBe("On Card");
    expect(row!.listingTitle).toMatch(/\bAUTO\b/);
    // The rebuilt title is exactly what Regenerate offers for the card now.
    expect(row!.listingTitle).toBe((await preview(t, id)).title);
    expect(row!).not.toHaveProperty("listingTitleTruncated");
  });

  test("an operator's own title is never touched, though the card is formatted", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId } = await seedLeaf(t, { features: { autographed: "None", season: "2024" } });
    const griffey = await seedPlayer(t, sportId, "Ken Griffey Jr.");
    const edited = await seedCard(t, leafId, "1", {
      attributes: ["AU"],
      playerIds: [griffey],
      features: { autographed: "None" },
      listingTitle: "Griffey Kid signed beauty #1",
    });
    // An edit that differs from the generated title by one word is still an edit.
    const { id: nearly, before } = await generatedCard(t, leafId, "2", { playerIds: [griffey] });
    await t.run(async (ctx) => {
      await ctx.db.patch(nearly, { listingTitle: `${before.title} Mint` });
    });

    await t.withIdentity(ADMIN).mutation(api.autographFormat.setAutographFormat, {
      selectorOptionId: leafId,
      value: "Sticker/Label",
    });
    await drainScheduled(t);

    const one = await get(t, edited);
    expect(one!.features?.autographed).toBe("Sticker/Label");
    expect(one!.listingTitle).toBe("Griffey Kid signed beauty #1");
    expect((await get(t, nearly))!.listingTitle).toBe(`${before.title} Mint`);
  });

  test("a cut title is rebuilt like creation: still flagged when it was, still unflagged when it was answered before save", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId } = await seedLeaf(t);
    // Three long names: the core is cut at a word boundary with room left
    // for the AUTO token.
    const players = [];
    for (const name of ["Alexander Hamilton", "Bartholomew Featherstonehaugh", "Maximilian Montgomery-Worthington"]) {
      players.push(await seedPlayer(t, sportId, name));
    }
    const flagged = await generatedCard(t, leafId, "1", { playerIds: players });
    expect(flagged.before.coreFits).toBe(false);
    const kept = await generatedCard(t, leafId, "2", { playerIds: players });
    await t.run(async (ctx) => {
      await ctx.db.patch(kept.id, { listingTitleTruncated: undefined });
    });

    await t.withIdentity(ADMIN).mutation(api.autographFormat.setAutographFormat, {
      selectorOptionId: leafId,
      value: "On Card",
    });
    await drainScheduled(t);

    const one = await get(t, flagged.id);
    const now = await preview(t, flagged.id);
    expect(now.coreFits).toBe(false);
    expect(one!.listingTitle).toBe(now.title);
    expect(one!.listingTitle).toMatch(/\bAUTO\b/);
    expect(one!.listingTitleTruncated).toBe(true);
    const two = await get(t, kept.id);
    expect(two!.listingTitle).toBe((await preview(t, kept.id)).title);
    expect(two!).not.toHaveProperty("listingTitleTruncated");
  });

  test("a parallel's AU cards reached by the insert's answer gain AUTO too", async () => {
    const t = convexTest(schema, modules);
    const { insertId, unsetId } = await seedInsertWithParallels(t);
    const { id } = await generatedCard(t, unsetId, "1", {});
    await t.withIdentity(ADMIN).mutation(api.autographFormat.setAutographFormat, {
      selectorOptionId: insertId,
      value: "On Card",
    });
    await drainScheduled(t);
    const row = await get(t, id);
    expect(row!.listingTitle).toMatch(/\bAUTO\b/);
    expect(row!.listingTitle).toBe((await preview(t, id)).title);
  });

  test("a changed answer moves the card's format but leaves its title (AUTO either way)", async () => {
    const t = convexTest(schema, modules);
    const { leafId } = await seedLeaf(t);
    const { id } = await generatedCard(t, leafId, "1", {});
    const admin = t.withIdentity(ADMIN);
    await admin.mutation(api.autographFormat.setAutographFormat, { selectorOptionId: leafId, value: "On Card" });
    await drainScheduled(t);
    const first = await get(t, id);
    await admin.mutation(api.autographFormat.setAutographFormat, { selectorOptionId: leafId, value: "Sticker/Label" });
    await drainScheduled(t);
    const second = await get(t, id);
    expect(second!.features?.autographed).toBe("Sticker/Label");
    expect(second!.listingTitle).toBe(first!.listingTitle);
  });

  test("the action reports the titles it rebuilt", async () => {
    const t = convexTest(schema, modules);
    const { leafId } = await seedLeaf(t, { features: { autographed: "None", autographFormat: "On Card" } });
    await generatedCard(t, leafId, "1", {});
    await seedCard(t, leafId, "2", { attributes: ["AU"], listingTitle: "Hand written" });
    const result = await t.action(internal.autographFormat.cascadeAutographFormat, {
      selectorOptionId: leafId,
      format: "On Card",
    });
    expect(result).toMatchObject({ formatted: 2, retitled: 1 });
  });
});

describe("the cascade rebuilds a still-generated listing description, by the same rule", () => {
  /** What creation's builder writes for the stored card as it stands now. */
  const generatedDescription = (t: T, cardId: Id<"cardChecklist">) =>
    t.run(async (ctx) => {
      const card = (await ctx.db.get(cardId))!;
      const chain = await findAncestorLabels(ctx, await ctx.db.get(card.selectorOptionId));
      const names = await storedCardTitleNames(ctx, card);
      return generateListingDescription(storedCardListingInputs(card, chain, names));
    });

  async function cardWithGeneratedText(
    t: T,
    leafId: Id<"selectorOptions">,
    cardNumber: string,
    fields: Partial<Doc<"cardChecklist">> = {},
  ) {
    const id = await seedCard(t, leafId, cardNumber, { attributes: ["AU"], features: { autographed: "None" }, ...fields });
    const title = (await t.withIdentity(ADMIN).query(api.selectorOptions.previewListingTitle, { cardId: id })).title;
    const description = await generatedDescription(t, id);
    await t.run(async (ctx) => {
      await ctx.db.patch(id, {
        ...(fields.listingTitle === undefined ? { listingTitle: title } : {}),
        ...(fields.listingDescription === undefined ? { listingDescription: description } : {}),
      });
    });
    return { id, title, description };
  }

  test("a generated description gains the autograph sentence, exactly what creation's builder writes", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId } = await seedLeaf(t, { features: { autographed: "None", season: "2024" } });
    const griffey = await seedPlayer(t, sportId, "Ken Griffey Jr.");
    const { id, description } = await cardWithGeneratedText(t, leafId, "1", { playerIds: [griffey] });
    expect(description).not.toContain("Autographed");

    await t.withIdentity(ADMIN).mutation(api.autographFormat.setAutographFormat, {
      selectorOptionId: leafId,
      value: "On Card",
    });
    await drainScheduled(t);

    const row = await get(t, id);
    expect(row!.listingDescription).toContain("Autographed (On Card).");
    expect(row!.listingDescription).toBe(await generatedDescription(t, id));
  });

  test("an operator's description is never touched, while the generated title beside it is rebuilt", async () => {
    const t = convexTest(schema, modules);
    const { leafId } = await seedLeaf(t);
    const { id } = await cardWithGeneratedText(t, leafId, "1", { listingDescription: "Signed in blue ink at the 1990 show." });
    await t.withIdentity(ADMIN).mutation(api.autographFormat.setAutographFormat, {
      selectorOptionId: leafId,
      value: "On Card",
    });
    await drainScheduled(t);
    const row = await get(t, id);
    expect(row!.listingDescription).toBe("Signed in blue ink at the 1990 show.");
    expect(row!.listingTitle).toMatch(/\bAUTO\b/);
  });

  test("a hand-written title does not stop a generated description from being rebuilt", async () => {
    const t = convexTest(schema, modules);
    const { leafId } = await seedLeaf(t);
    const { id } = await cardWithGeneratedText(t, leafId, "1", { listingTitle: "My own words #1" });
    await t.withIdentity(ADMIN).mutation(api.autographFormat.setAutographFormat, {
      selectorOptionId: leafId,
      value: "Sticker/Label",
    });
    await drainScheduled(t);
    const row = await get(t, id);
    expect(row!.listingTitle).toBe("My own words #1");
    expect(row!.listingDescription).toContain("Autographed (Sticker/Label).");
    expect(row!.listingDescription).toBe(await generatedDescription(t, id));
  });

  test("the action reports the descriptions it rebuilt", async () => {
    const t = convexTest(schema, modules);
    const { leafId } = await seedLeaf(t, { features: { autographed: "None", autographFormat: "On Card" } });
    await cardWithGeneratedText(t, leafId, "1");
    await cardWithGeneratedText(t, leafId, "2", { listingDescription: "Hand written." });
    const result = await t.action(internal.autographFormat.cascadeAutographFormat, {
      selectorOptionId: leafId,
      format: "On Card",
    });
    expect(result).toMatchObject({ formatted: 2, retitled: 2, redescribed: 1 });
  });
});
