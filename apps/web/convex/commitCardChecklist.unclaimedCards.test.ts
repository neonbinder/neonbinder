/**
 * NEO-239 — card preservation keyed on `hasMarketplaceRef`, not on `isCustom`.
 *
 * Seven sites in the commit pipeline used to ask "did a human make this card?"
 * to decide whether it survives a re-sync, sorts after the marketplace
 * numbers, gets its pending names resolved, and stays out of the
 * dropped-upstream report. Every one of them actually wanted a different
 * question: **does any marketplace claim this card?** — i.e. is there a `ref`
 * on either side.
 *
 * The two questions agree on the day a card is created and diverge afterwards,
 * in the direction that matters. A hand-added card the operator LATER pairs to
 * a BSC row has an upstream now; treating it as NB-only meant it was never
 * reported when that upstream dropped it, and it kept sorting after the
 * marketplace numbers it is interleaved with. `isCustom` could not express
 * that transition; `platformData` already did.
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
  subject: "admin_neo239_cards",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_neo239_cards",
  role: "admin",
};

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

async function seedTree(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => {
    const sportId = await ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Baseball",
      sportConfig: { skuCode: "BB", league: "MLB" },
      platformData: {},
      children: [],
      lastUpdated: Date.now(),
    });
    const setNameId = await ctx.db.insert("selectorOptions", {
      level: "setName",
      value: "Topps",
      platformData: {},
      parentId: sportId,
      children: [],
      lastUpdated: Date.now(),
    });
    const leafId = await ctx.db.insert("selectorOptions", {
      level: "variantType",
      value: "Base",
      platformData: {},
      parentId: setNameId,
      children: [],
      lastUpdated: Date.now(),
    });
    return { sportId, leafId };
  });
}

function card(cardNumber: string, cardName: string, bscRef?: string) {
  return {
    cardNumber,
    cardName,
    team: undefined,
    teams: [],
    players: [],
    attributes: [],
    platformData: bscRef ? { bsc: { ref: bscRef } } : {},
  };
}

async function rows(
  t: ReturnType<typeof convexTest>,
  selectorOptionId: Id<"selectorOptions">,
) {
  const all = await t.run(async (ctx) =>
    ctx.db.query("cardChecklist").collect(),
  );
  return all
    .filter((r) => r.selectorOptionId === selectorOptionId)
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

describe("a card no marketplace claims survives a re-sync", () => {
  test("it is preserved, sorts after the marketplace numbers, and is not reported as dropped", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId } = await seedTree(t);
    const asAdmin = t.withIdentity(ADMIN);

    await asAdmin.action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: leafId,
      sportId,
      cards: [card("1", "Marketplace One", "bsc-1")],
    });
    await asAdmin.mutation(api.selectorOptions.addCustomCard, {
      selectorOptionId: leafId,
      cardNumber: "9001",
      cardName: "Hand Added",
    });

    // Re-sync with the SAME upstream card. Nothing dropped anything.
    const res = await asAdmin.action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: leafId,
      sportId,
      cards: [card("1", "Marketplace One", "bsc-1")],
    });

    const after = await rows(t, leafId);
    expect(after.map((r) => r.cardNumber)).toEqual(["1", "9001"]);
    // Not in the "upstream no longer lists this" report: it has no upstream.
    expect(res.unmatchedExistingCount).toBe(0);
  });

  test("`addCustomCard` writes no `isCustom` — the empty platformData IS the fact", async () => {
    const t = convexTest(schema, modules);
    const { leafId } = await seedTree(t);

    await t.withIdentity(ADMIN).mutation(api.selectorOptions.addCustomCard, {
      selectorOptionId: leafId,
      cardNumber: "9001",
      cardName: "Hand Added",
    });

    const [row] = await rows(t, leafId);
    expect(row.isCustom).toBeUndefined();
    expect(row.platformData).toEqual({});
  });
});

describe("a card that GAINS a marketplace ref joins the marketplace population", () => {
  test("once paired, it is reported when upstream stops listing it", async () => {
    // The transition `isCustom` could not express. A hand-added card the
    // operator later pairs to a BSC row now HAS an upstream — so upstream's
    // silence about it means something, and the operator is owed the report.
    const t = convexTest(schema, modules);
    const { sportId, leafId } = await seedTree(t);
    const asAdmin = t.withIdentity(ADMIN);

    await asAdmin.mutation(api.selectorOptions.addCustomCard, {
      selectorOptionId: leafId,
      cardNumber: "9001",
      cardName: "Hand Added",
    });
    // The operator pairs it: the commit writes a BSC ref onto that same row.
    await asAdmin.action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: leafId,
      sportId,
      cards: [card("9001", "Hand Added", "bsc-9001")],
    });
    const paired = (await rows(t, leafId))[0];
    expect(paired.platformData.bsc?.ref).toBe("bsc-9001");

    // Now BSC stops listing it.
    const res = await asAdmin.action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: leafId,
      sportId,
      cards: [card("1", "Marketplace One", "bsc-1")],
    });

    expect(res.unmatchedExistingCount).toBe(1);
    // Reported, never deleted — that is still a separate operator decision.
    expect((await rows(t, leafId)).map((r) => r.cardNumber).sort()).toEqual([
      "1",
      "9001",
    ]);
  });
});

describe("pending names on an unclaimed card are still resolved", () => {
  test("a pending name on a ref-less card is resolved and cleared", async () => {
    // The pending-name fold in the commit prelude was keyed on `isCustom`, and
    // it is the only reason a name typed onto a hand-added card ever gets
    // looked up: no INCOMING card mentions it, so without the fold it stays
    // pending forever and is re-offered on every later fetch. Keyed on the
    // refs instead, it covers the same rows PLUS the legacy ref-less ones the
    // flag missed.
    const t = convexTest(schema, modules);
    const { sportId, leafId } = await seedTree(t);
    const asAdmin = t.withIdentity(ADMIN);

    await t.run(async (ctx) => {
      await ctx.db.insert("players", {
        name: "Ken Griffey Jr.",
        // `normalizePlayerName`: lowercased, punctuation stripped, tokens sorted.
        nameNormalized: "griffey jr ken",
        sportId,
        lastUpdated: Date.now(),
      });
      await ctx.db.insert("cardChecklist", {
        selectorOptionId: leafId,
        cardNumber: "9001",
        cardName: "Hand Added",
        platformData: {},
        pendingPlayerNames: ["Ken Griffey Jr."],
        sortOrder: 0,
        lastUpdated: Date.now(),
      });
    });

    await asAdmin.action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: leafId,
      sportId,
      cards: [card("1", "Marketplace One", "bsc-1")],
    });

    const handAdded = (await rows(t, leafId)).find(
      (r) => r.cardNumber === "9001",
    )!;
    expect(handAdded.pendingPlayerNames).toBeUndefined();
  });
});
