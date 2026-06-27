/**
 * NEO-26 Stage 4: `updateCard` accepts a `teamOnCardIds[]` patch and
 * round-trips it through `getCardChecklist` without
 * `ReturnsValidationError`.
 *
 * Covers the form-edit path: the operator changes the team chips in
 * CardChecklistItem → mutation writes only `teamOnCardIds` (no legacy
 * `team` arg in the signature anymore) → next query render shows the
 * updated list.
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

describe("updateCard with teamOnCardIds patch", () => {
  test("writes the full array and the next read reflects it", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const { cardId, teamA, teamB, variantTypeId } = await t.run(async (ctx) => {
      const sportId = await ctx.db.insert("selectorOptions", {
        level: "sport",
        value: "Baseball",
        platformData: { bsc: "x", sportlots: "y" },
        children: [],
        lastUpdated: Date.now(),
      });
      const setNameId = await ctx.db.insert("selectorOptions", {
        level: "setName",
        value: "2024 Topps",
        platformData: { bsc: "x", sportlots: "y" },
        parentId: sportId,
        children: [],
        lastUpdated: Date.now(),
      });
      const variantTypeId = await ctx.db.insert("selectorOptions", {
        level: "variantType",
        value: "Base",
        platformData: { bsc: "x", sportlots: "y" },
        parentId: setNameId,
        children: [],
        lastUpdated: Date.now(),
      });

      const teamA = await ctx.db.insert("teams", {
        name: "Yankees",
        nameNormalized: "yankees",
        sport: "Baseball",
        lastUpdated: Date.now(),
      });
      const teamB = await ctx.db.insert("teams", {
        name: "Red Sox",
        nameNormalized: "red sox",
        sport: "Baseball",
        lastUpdated: Date.now(),
      });

      const cardId = await ctx.db.insert("cardChecklist", {
        selectorOptionId: variantTypeId,
        cardNumber: "1",
        cardName: "Test Card",
        teamOnCardIds: [teamA],
        platformData: {},
        sortOrder: 0,
        lastUpdated: Date.now(),
      });

      return { cardId, teamA, teamB, variantTypeId };
    });

    // 1. Patch to a 2-team array.
    await asAdmin.mutation(api.selectorOptions.updateCard, {
      id: cardId,
      teamOnCardIds: [teamA, teamB],
    });

    const cards1 = await asAdmin.query(
      api.selectorOptions.getCardChecklist,
      { selectorOptionId: variantTypeId },
    );
    const fetched1 = cards1.find((c) => c._id === cardId);
    expect(fetched1!.teamOnCardIds).toEqual([teamA, teamB]);

    // 2. Patch to an empty array (clear the link).
    await asAdmin.mutation(api.selectorOptions.updateCard, {
      id: cardId,
      teamOnCardIds: [],
    });

    const cards2 = await asAdmin.query(
      api.selectorOptions.getCardChecklist,
      { selectorOptionId: variantTypeId },
    );
    const fetched2 = cards2.find((c) => c._id === cardId);
    expect(fetched2!.teamOnCardIds).toEqual([]);
  });

  test("legacy `team` string on the row round-trips through the query without throwing", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    // Insert a row carrying the legacy `team` string. The schema still
    // tolerates the field for the migration window; the query returns
    // validator was updated to keep it optional so this round-trip is
    // clean. The deprecation is documented in convex/schema.ts.
    const { variantTypeId, cardId } = await t.run(async (ctx) => {
      const sportId = await ctx.db.insert("selectorOptions", {
        level: "sport",
        value: "Baseball",
        platformData: { bsc: "x", sportlots: "y" },
        children: [],
        lastUpdated: Date.now(),
      });
      const variantTypeId = await ctx.db.insert("selectorOptions", {
        level: "variantType",
        value: "Base",
        platformData: { bsc: "x", sportlots: "y" },
        parentId: sportId,
        children: [],
        lastUpdated: Date.now(),
      });
      const cardId: Id<"cardChecklist"> = await ctx.db.insert(
        "cardChecklist",
        {
          selectorOptionId: variantTypeId,
          cardNumber: "1",
          cardName: "Stale",
          team: "Some Old String",
          platformData: {},
          sortOrder: 0,
          lastUpdated: Date.now(),
        } as any,
      );
      return { variantTypeId, cardId };
    });

    // Plain query — must not throw on the legacy field.
    const cards = await asAdmin.query(
      api.selectorOptions.getCardChecklist,
      { selectorOptionId: variantTypeId },
    );
    const got = cards.find((c) => c._id === cardId)!;
    expect((got as any).team).toBe("Some Old String");
  });
});
