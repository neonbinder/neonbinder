/**
 * NEO-71-74: unit tests for `setCardFeature`'s `signedBy` auto-fill.
 *
 * When a card's `autographed` feature transitions from blank/"None" to any
 * other value ("On Card" / "Sticker/Label"), `setCardFeature` resolves the
 * player(s) already attached to the card via `cardChecklist.playerIds[]`
 * (against the `players` table's `name` field) and writes their name(s),
 * joined with ", " in `playerIds` order, into `signedBy` — overwriting
 * whatever was there before at that specific transition. See
 * convex/selectorOptions.ts's `setCardFeature` handler (~line 1510).
 *
 * This only fires on the blank→set transition:
 *  - autographed already non-"None" changed to a different non-"None" value
 *    does NOT re-derive/overwrite signedBy
 *  - autographed going from non-"None" back to "None" does NOT clear
 *    signedBy
 *  - no playerIds (or zero resolvable players) leaves signedBy untouched,
 *    without crashing
 *
 * Card fixtures are raw `ctx.db.insert` calls (matching the established
 * pattern in convex/featurePropagation.test.ts's `seedSubtree` and
 * convex/updateCardChecklistFields.test.ts's `seed`) since `setCardFeature`
 * only ever reads the single cardChecklist row + its linked players — no
 * selectorOptions copy-down pipeline is exercised here.
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
  subject: "admin_user_001",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_user_001",
  name: "Admin User",
  role: "admin",
};

type SeedOpts = {
  // Player names to insert into the `players` table, in insertion order.
  playerNames?: string[];
  // Indices into `playerNames` used to build the card's `playerIds` array —
  // lets a test decouple insertion order from playerIds order.
  playerIdOrder?: number[];
  // Explicitly set playerIds to an empty array (distinct from omitting it).
  emptyPlayerIds?: boolean;
  initialFeatures?: Record<string, string>;
};

async function seedCard(t: ReturnType<typeof convexTest>, opts: SeedOpts = {}) {
  return t.run(async (ctx) => {
    const sportId = await ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Baseball",
      sportConfig: {
        skuCode: "BB",
        league: "MLB",
        espn: { path: "baseball/mlb", leagueName: "Major League Baseball" },
        wikidata: { sportQid: "Q5369", hallOfFameQid: "Q1194380" },
      },
      platformData: {},
      children: [],
      lastUpdated: Date.now(),
    });
    const variantTypeId = await ctx.db.insert("selectorOptions", {
      level: "variantType",
      value: "Base",
      platformData: {},
      parentId: sportId,
      children: [],
      lastUpdated: Date.now(),
    });

    const insertedPlayerIds: Array<Id<"players">> = [];
    for (const name of opts.playerNames ?? []) {
      const id = await ctx.db.insert("players", {
        name,
        nameNormalized: name.toLowerCase(),
        sportId,
        lastUpdated: Date.now(),
      });
      insertedPlayerIds.push(id);
    }

    const orderedPlayerIds = opts.playerIdOrder
      ? opts.playerIdOrder.map((i) => insertedPlayerIds[i])
      : insertedPlayerIds;

    const hasPlayerNames = (opts.playerNames?.length ?? 0) > 0;
    const cardId = await ctx.db.insert("cardChecklist", {
      selectorOptionId: variantTypeId,
      cardNumber: "1",
      cardName: "Test Card",
      platformData: {},
      sortOrder: 0,
      lastUpdated: Date.now(),
      ...(opts.emptyPlayerIds
        ? { playerIds: [] }
        : hasPlayerNames
          ? { playerIds: orderedPlayerIds }
          : {}),
      ...(opts.initialFeatures ? { features: opts.initialFeatures } : {}),
    });

    return { cardId, playerIds: orderedPlayerIds };
  });
}

describe("setCardFeature: signedBy auto-fill on autographed blank->set transition", () => {
  test("single player attached: autographed None -> 'On Card' sets signedBy to that player's name", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { cardId } = await seedCard(t, { playerNames: ["Mike Trout"] });

    await asAdmin.mutation(api.selectorOptions.setCardFeature, {
      cardChecklistId: cardId,
      key: "autographed",
      value: "On Card",
    });

    const card = await t.run(async (ctx) => ctx.db.get(cardId));
    expect(card!.features?.autographed).toBe("On Card");
    expect(card!.features?.signedBy).toBe("Mike Trout");
  });

  test("multiple players attached (dual relic-auto): signedBy joins names with ', ' in playerIds order", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    // Insert Judge first, Trout second, but list playerIds as
    // [Trout, Judge] — proves the join follows playerIds order, not
    // players-table insertion order.
    const { cardId } = await seedCard(t, {
      playerNames: ["Aaron Judge", "Mike Trout"],
      playerIdOrder: [1, 0],
    });

    await asAdmin.mutation(api.selectorOptions.setCardFeature, {
      cardChecklistId: cardId,
      key: "autographed",
      value: "On Card",
    });

    const card = await t.run(async (ctx) => ctx.db.get(cardId));
    expect(card!.features?.signedBy).toBe("Mike Trout, Aaron Judge");
  });

  test("no playerIds at all: signedBy is not set and the mutation does not crash", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { cardId } = await seedCard(t); // no playerNames -> playerIds omitted

    await expect(
      asAdmin.mutation(api.selectorOptions.setCardFeature, {
        cardChecklistId: cardId,
        key: "autographed",
        value: "On Card",
      }),
    ).resolves.toBeNull();

    const card = await t.run(async (ctx) => ctx.db.get(cardId));
    expect(card!.features?.autographed).toBe("On Card");
    expect(card!.features?.signedBy).toBeUndefined();
  });

  test("empty playerIds array: signedBy is not set and the mutation does not crash", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { cardId } = await seedCard(t, { emptyPlayerIds: true });

    await expect(
      asAdmin.mutation(api.selectorOptions.setCardFeature, {
        cardChecklistId: cardId,
        key: "autographed",
        value: "On Card",
      }),
    ).resolves.toBeNull();

    const card = await t.run(async (ctx) => ctx.db.get(cardId));
    expect(card!.features?.autographed).toBe("On Card");
    expect(card!.features?.signedBy).toBeUndefined();
  });

  test("autographed already non-None changed to a different non-None value does not re-derive signedBy", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { cardId } = await seedCard(t, { playerNames: ["Mike Trout"] });

    // Blank -> set transition auto-fills signedBy from the attached player.
    await asAdmin.mutation(api.selectorOptions.setCardFeature, {
      cardChecklistId: cardId,
      key: "autographed",
      value: "On Card",
    });
    // Operator then manually overwrites signedBy (e.g. correcting a typo'd
    // display form of the name).
    await asAdmin.mutation(api.selectorOptions.setCardFeature, {
      cardChecklistId: cardId,
      key: "signedBy",
      value: "Michael Trout",
    });

    // autographed changes again, but it's non-None -> non-None — the
    // operator's manual signedBy value must survive untouched.
    await asAdmin.mutation(api.selectorOptions.setCardFeature, {
      cardChecklistId: cardId,
      key: "autographed",
      value: "Sticker/Label",
    });

    const card = await t.run(async (ctx) => ctx.db.get(cardId));
    expect(card!.features?.autographed).toBe("Sticker/Label");
    expect(card!.features?.signedBy).toBe("Michael Trout");
  });

  test("autographed going from a non-None value back to 'None' leaves signedBy untouched", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { cardId } = await seedCard(t, { playerNames: ["Mike Trout"] });

    await asAdmin.mutation(api.selectorOptions.setCardFeature, {
      cardChecklistId: cardId,
      key: "autographed",
      value: "On Card",
    });

    await asAdmin.mutation(api.selectorOptions.setCardFeature, {
      cardChecklistId: cardId,
      key: "autographed",
      value: "None",
    });

    const card = await t.run(async (ctx) => ctx.db.get(cardId));
    expect(card!.features?.autographed).toBe("None");
    // Not cleared even though autographed is blank again.
    expect(card!.features?.signedBy).toBe("Mike Trout");
  });

  test("a pre-existing manual signedBy value is overwritten by the player-derived value at the blank->set transition", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    // Operator had typed something into signedBy while autographed was
    // still "None" (e.g. a placeholder or a guess).
    const { cardId } = await seedCard(t, {
      playerNames: ["Mike Trout"],
      initialFeatures: { autographed: "None", signedBy: "Old Placeholder" },
    });

    await asAdmin.mutation(api.selectorOptions.setCardFeature, {
      cardChecklistId: cardId,
      key: "autographed",
      value: "On Card",
    });

    const card = await t.run(async (ctx) => ctx.db.get(cardId));
    // The auto-fill is a real overwrite at this transition, not a
    // fill-if-blank guard — the player-derived name wins.
    expect(card!.features?.signedBy).toBe("Mike Trout");
  });
});

/**
 * NEO-217 — the seed fires on a real "this card is an autograph" value and
 * nothing else. Both non-values that can now reach the mutation are pinned:
 * "None" (the toggle row's first option) and "" (the clear introduced by this
 * ticket), which the shared `applyFeatureEdit` helper turns into a key
 * REMOVAL. Neither is a card becoming an autograph, so neither may seed
 * Signed By — a card with players attached must not sprout a Signed By value
 * from an operator explicitly saying "not autographed".
 */
describe("setCardFeature: 'None' and '' never seed signedBy (NEO-217)", () => {
  test("autographed set to 'None' from blank does not seed signedBy", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { cardId } = await seedCard(t, { playerNames: ["Mike Trout"] });

    await asAdmin.mutation(api.selectorOptions.setCardFeature, {
      cardChecklistId: cardId,
      key: "autographed",
      value: "None",
    });

    const card = await t.run(async (ctx) => ctx.db.get(cardId));
    expect(card!.features?.autographed).toBe("None");
    expect(card!.features).not.toHaveProperty("signedBy");
  });

  test("autographed cleared with '' from blank removes the key and does not seed signedBy", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { cardId } = await seedCard(t, { playerNames: ["Mike Trout"] });

    await asAdmin.mutation(api.selectorOptions.setCardFeature, {
      cardChecklistId: cardId,
      key: "autographed",
      value: "",
    });

    const card = await t.run(async (ctx) => ctx.db.get(cardId));
    expect(card!.features).not.toHaveProperty("autographed");
    expect(card!.features).not.toHaveProperty("signedBy");
  });

  test("autographed cleared with '' from a real value removes the key and leaves an existing signedBy alone", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { cardId } = await seedCard(t, {
      playerNames: ["Mike Trout"],
      initialFeatures: { autographed: "On Card", signedBy: "Mike Trout" },
    });

    await asAdmin.mutation(api.selectorOptions.setCardFeature, {
      cardChecklistId: cardId,
      key: "autographed",
      value: "",
    });

    const card = await t.run(async (ctx) => ctx.db.get(cardId));
    expect(card!.features).not.toHaveProperty("autographed");
    // Same discipline as the existing "back to None" case: clearing the
    // autograph format is not a statement about who signed it.
    expect(card!.features?.signedBy).toBe("Mike Trout");
  });
});
