/**
 * NEO-189 — `commitCardChecklist` links each variation to the card it varies.
 *
 * The wire carries only the domain flag `isVariation`; WHICH card a variation
 * belongs to is resolved here, after every row has an id. So these tests are
 * the real check that the rule survives the round trip — the pure-function
 * tests in lib/cards/variations.test.ts prove the rule, these prove the wiring.
 *
 * Fixture conventions mirror convex/commitCardChecklist.entityReview.test.ts.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { Id } from "./_generated/dataModel";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN_IDENTITY = {
  subject: "admin_variations_001",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_variations_001",
  name: "Admin User",
  role: "admin",
};

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
      value: "Heritage",
      platformData: {},
      features: { manufacturer: "Topps", season: "2021" },
      parentId: sportId,
      children: [],
      lastUpdated: Date.now(),
    });
    const variantTypeId = await ctx.db.insert("selectorOptions", {
      level: "variantType",
      value: "Base",
      platformData: {},
      features: { manufacturer: "Topps", season: "2021" },
      parentId: setNameId,
      children: [],
      lastUpdated: Date.now(),
    });
    return { sportId, variantTypeId };
  });
}

function card(
  cardNumber: string,
  cardName: string,
  extra: { isVariation?: boolean; cardVariation?: string } = {},
) {
  return {
    cardNumber,
    cardName,
    team: undefined,
    teams: [],
    players: [],
    attributes: [],
    isRookie: undefined,
    isRelic: undefined,
    printRun: undefined,
    autographType: undefined,
    cardVariation: extra.cardVariation,
    isVariation: extra.isVariation,
    platformData: {},
  };
}

async function readChecklist(
  t: ReturnType<typeof convexTest>,
  selectorOptionId: Id<"selectorOptions">,
) {
  // Build the Map OUTSIDE t.run — a Map is not a Convex value and cannot cross
  // the mutation boundary.
  const rows = await t.run(async (ctx) =>
    ctx.db
      .query("cardChecklist")
      .withIndex("by_selector_option", (q) =>
        q.eq("selectorOptionId", selectorOptionId),
      )
      .collect(),
  );
  return { rows, byNumber: new Map(rows.map((r) => [r.cardNumber, r])) };
}

describe("commitCardChecklist — variation linking", () => {
  test("BSC shape: 11b and 11c are linked to 11", async () => {
    const t = convexTest(schema, modules);
    const { sportId, variantTypeId } = await seedTree(t);

    await t.withIdentity(ADMIN_IDENTITY).mutation(
      api.selectorOptions.commitCardChecklist,
      {
        selectorOptionId: variantTypeId,
        sportId,
        cards: [
          card("11", "Phillies 2021 Rookie Stars"),
          card("11b", "Alec Bohm", { isVariation: true, cardVariation: "Action" }),
          card("11c", "Alec Bohm", { isVariation: true, cardVariation: "Alternate" }),
          card("12", "Someone Else"),
        ],
      },
    );

    const { byNumber } = await readChecklist(t, variantTypeId);
    const parent = byNumber.get("11")!;
    expect(byNumber.get("11b")!.variationOfCardId).toBe(parent._id);
    expect(byNumber.get("11c")!.variationOfCardId).toBe(parent._id);
    expect(parent.variationOfCardId).toBeUndefined();
    expect(byNumber.get("12")!.variationOfCardId).toBeUndefined();
    // The name survives the trip.
    expect(byNumber.get("11b")!.cardVariation).toBe("Action");
  });

  test("COUNTER-EXAMPLE: 1b/1c link to 1a when there is no bare #1", async () => {
    // 2021 Topps ships no card #1 — the base card is itself suffixed.
    const t = convexTest(schema, modules);
    const { sportId, variantTypeId } = await seedTree(t);

    await t.withIdentity(ADMIN_IDENTITY).mutation(
      api.selectorOptions.commitCardChecklist,
      {
        selectorOptionId: variantTypeId,
        sportId,
        cards: [
          card("1a", "Fernando Tatis Jr."),
          card("1b", "Fernando Tatis Jr.", { isVariation: true, cardVariation: "Sliding" }),
          card("1c", "Fernando Tatis Jr.", { isVariation: true, cardVariation: "In Dugout" }),
        ],
      },
    );

    const { byNumber } = await readChecklist(t, variantTypeId);
    const base = byNumber.get("1a")!;
    expect(byNumber.get("1b")!.variationOfCardId).toBe(base._id);
    expect(byNumber.get("1c")!.variationOfCardId).toBe(base._id);
  });

  test("a variation may be a different player — nothing assumes shared identity", async () => {
    const t = convexTest(schema, modules);
    const { sportId, variantTypeId } = await seedTree(t);

    await t.withIdentity(ADMIN_IDENTITY).mutation(
      api.selectorOptions.commitCardChecklist,
      {
        selectorOptionId: variantTypeId,
        sportId,
        cards: [
          card("52", "Archie Bradley"),
          card("52b", "Mickey Mantle", { isVariation: true, cardVariation: "Legend; Batting" }),
        ],
      },
    );

    const { byNumber } = await readChecklist(t, variantTypeId);
    expect(byNumber.get("52b")!.variationOfCardId).toBe(byNumber.get("52")!._id);
    expect(byNumber.get("52b")!.cardName).toBe("Mickey Mantle");
    // Each row gets its own SKU; a variation is not a delta on its parent.
    expect(byNumber.get("52b")!.sku).not.toBe(byNumber.get("52")!.sku);
  });

  test("AMBIGUOUS: a stem with no non-variation row is left unlinked, not guessed", async () => {
    // 2021 Heritage inserts #251: two checklist print variations, no base card.
    const t = convexTest(schema, modules);
    const { sportId, variantTypeId } = await seedTree(t);

    await t.withIdentity(ADMIN_IDENTITY).mutation(
      api.selectorOptions.commitCardChecklist,
      {
        selectorOptionId: variantTypeId,
        sportId,
        cards: [
          card("251a", "Checklist", { isVariation: true, cardVariation: "Large Print" }),
          card("251b", "Checklist", { isVariation: true, cardVariation: "Small Print" }),
        ],
      },
    );

    const { rows } = await readChecklist(t, variantTypeId);
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r.variationOfCardId).toBeUndefined();
  });

  test("a set with no variations is entirely unaffected", async () => {
    const t = convexTest(schema, modules);
    const { sportId, variantTypeId } = await seedTree(t);

    await t.withIdentity(ADMIN_IDENTITY).mutation(
      api.selectorOptions.commitCardChecklist,
      {
        selectorOptionId: variantTypeId,
        sportId,
        cards: [card("1", "A"), card("2", "B"), card("3", "C")],
      },
    );

    const { rows } = await readChecklist(t, variantTypeId);
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(r.variationOfCardId).toBeUndefined();
  });

  test("re-committing is idempotent — links do not duplicate or drift", async () => {
    const t = convexTest(schema, modules);
    const { sportId, variantTypeId } = await seedTree(t);
    const cards = [
      card("11", "Phillies 2021 Rookie Stars"),
      card("11b", "Alec Bohm", { isVariation: true, cardVariation: "Action" }),
    ];

    await t.withIdentity(ADMIN_IDENTITY).mutation(
      api.selectorOptions.commitCardChecklist,
      { selectorOptionId: variantTypeId, sportId, cards },
    );
    const first = await readChecklist(t, variantTypeId);

    await t.withIdentity(ADMIN_IDENTITY).mutation(
      api.selectorOptions.commitCardChecklist,
      { selectorOptionId: variantTypeId, sportId, cards },
    );
    const second = await readChecklist(t, variantTypeId);

    expect(second.rows).toHaveLength(2);
    expect(second.byNumber.get("11b")!._id).toBe(first.byNumber.get("11b")!._id);
    expect(second.byNumber.get("11b")!.variationOfCardId).toBe(
      second.byNumber.get("11")!._id,
    );
  });

  test("a row that stops being a variation loses its pointer on re-sync", async () => {
    // Without this, an upstream correction leaves the card parented forever.
    const t = convexTest(schema, modules);
    const { sportId, variantTypeId } = await seedTree(t);

    await t.withIdentity(ADMIN_IDENTITY).mutation(
      api.selectorOptions.commitCardChecklist,
      {
        selectorOptionId: variantTypeId,
        sportId,
        cards: [
          card("11", "Parent"),
          card("11b", "Alec Bohm", { isVariation: true, cardVariation: "Action" }),
        ],
      },
    );
    expect(
      (await readChecklist(t, variantTypeId)).byNumber.get("11b")!
        .variationOfCardId,
    ).toBeDefined();

    await t.withIdentity(ADMIN_IDENTITY).mutation(
      api.selectorOptions.commitCardChecklist,
      {
        selectorOptionId: variantTypeId,
        sportId,
        cards: [card("11", "Parent"), card("11b", "Alec Bohm")],
      },
    );

    expect(
      (await readChecklist(t, variantTypeId)).byNumber.get("11b")!
        .variationOfCardId,
    ).toBeUndefined();
  });
});

describe("a hand-set variation parent survives re-sync", () => {
  test("the commit pass does not re-derive over an operator's link", async () => {
    // Without this the correction lasts exactly until the next fetch — the
    // same failure NEO-137 fixed for card pairing.
    const t = convexTest(schema, modules);
    const { sportId, variantTypeId } = await seedTree(t);

    // #7 and #900 share no stem, so no derivation would ever link them.
    await t.withIdentity(ADMIN_IDENTITY).mutation(
      api.selectorOptions.commitCardChecklist,
      {
        selectorOptionId: variantTypeId,
        sportId,
        cards: [card("7", "Brandon Belt"), card("900", "Brandon Belt SP")],
      },
    );

    const before = await readChecklist(t, variantTypeId);
    await t
      .withIdentity(ADMIN_IDENTITY)
      .mutation(api.selectorOptions.setCardVariationParent, {
        cardId: before.byNumber.get("900")!._id,
        parentCardId: before.byNumber.get("7")!._id,
      });

    // Re-sync the identical payload.
    await t.withIdentity(ADMIN_IDENTITY).mutation(
      api.selectorOptions.commitCardChecklist,
      {
        selectorOptionId: variantTypeId,
        sportId,
        cards: [card("7", "Brandon Belt"), card("900", "Brandon Belt SP")],
      },
    );

    const after = await readChecklist(t, variantTypeId);
    expect(after.byNumber.get("900")!.variationOfCardId).toBe(
      after.byNumber.get("7")!._id,
    );
  });

  test("a hand-CLEARED link is not re-derived either", async () => {
    const t = convexTest(schema, modules);
    const { sportId, variantTypeId } = await seedTree(t);
    const cards = [
      card("11", "Phillies 2021 Rookie Stars"),
      card("11b", "Alec Bohm", { isVariation: true, cardVariation: "Action" }),
    ];

    await t.withIdentity(ADMIN_IDENTITY).mutation(
      api.selectorOptions.commitCardChecklist,
      { selectorOptionId: variantTypeId, sportId, cards },
    );
    const before = await readChecklist(t, variantTypeId);
    expect(before.byNumber.get("11b")!.variationOfCardId).toBeDefined();

    // The operator says 11b is NOT a variation of 11.
    await t
      .withIdentity(ADMIN_IDENTITY)
      .mutation(api.selectorOptions.setCardVariationParent, {
        cardId: before.byNumber.get("11b")!._id,
      });

    await t.withIdentity(ADMIN_IDENTITY).mutation(
      api.selectorOptions.commitCardChecklist,
      { selectorOptionId: variantTypeId, sportId, cards },
    );

    const after = await readChecklist(t, variantTypeId);
    expect(after.byNumber.get("11b")!.variationOfCardId).toBeUndefined();
  });
});
