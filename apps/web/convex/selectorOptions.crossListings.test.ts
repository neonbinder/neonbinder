/**
 * NEO-21: unit tests for the cross-release "guest" checklist surface —
 * `addCrossListingsByCardNumbers`, `removeCrossListing`,
 * `getCrossListingsForCard`, `getCardChecklist`'s guest-row merge, and
 * `deleteCard`'s cascade delete of `cardCrossListings` rows. See
 * convex/schema.ts's `cardCrossListings` table comment and the NEO-21
 * section header in convex/selectorOptions.ts (~line 1583) for the
 * "card stays pinned to its home set, junction table only adds a second
 * display location" design.
 *
 * Fixtures build a real sport -> year -> manufacturer -> setName ->
 * variantType chain (rather than the shorter sport -> setName -> variantType
 * shortcut used elsewhere) because `buildSetLabel` reads year/manufacturer/
 * setName off the parent chain — a short chain would make every
 * `homeSetLabel`/`setLabel` assertion trivially pass without exercising the
 * label-building walk.
 *
 * The getCardChecklist ordering test deliberately stamps the guest card's
 * `sortOrder` (inherited from its home checklist, and meaningless in the
 * guest context per the NEO-21 comment on `getCardChecklist`) LOWER than the
 * target's own home cards' `sortOrder`, while giving it a numerically HIGHER
 * `cardNumber`. If the merge ever regressed to sorting by `sortOrder` instead
 * of `compareCardNumbers`, this specific fixture would sort the guest card
 * first instead of last — a case where both orderings happen to agree
 * wouldn't catch that regression.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { Id } from "./_generated/dataModel";

// convex-test v0.0.53 with Vitest uses import.meta.glob to discover modules.
// Must run from the convex/ root — a subdirectory glob silently drops sibling
// modules (e.g. convex/adapters/*.ts) that requireAdmin's callers may need.
const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

// ---------------------------------------------------------------------------
// Auth identities
// ---------------------------------------------------------------------------

const ADMIN_IDENTITY = {
  subject: "admin_user_crosslisting_001",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_user_crosslisting_001",
  name: "Admin User",
  role: "admin",
};

const NON_ADMIN_IDENTITY = {
  subject: "normal_user_crosslisting_001",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|normal_user_crosslisting_001",
  name: "Normal User",
  role: "user",
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type HierarchyIds = {
  sportId: Id<"selectorOptions">;
  yearId: Id<"selectorOptions">;
  manufacturerId: Id<"selectorOptions">;
  setNameId: Id<"selectorOptions">;
  variantTypeId: Id<"selectorOptions">;
};

/** Builds a full sport -> year -> manufacturer -> setName -> variantType
 * chain so `buildSetLabel`'s ancestor walk has real year/manufacturer/
 * setName values to find. Returns every level's id. */
async function seedHierarchy(
  t: ReturnType<typeof convexTest>,
  opts: {
    sport: string;
    year: string;
    manufacturer: string;
    setName: string;
    variantType?: string;
  },
): Promise<HierarchyIds> {
  return t.run(async (ctx) => {
    const now = Date.now();
    const sportId = await ctx.db.insert("selectorOptions", {
      level: "sport",
      value: opts.sport,
      platformData: {},
      lastUpdated: now,
    });
    const yearId = await ctx.db.insert("selectorOptions", {
      level: "year",
      value: opts.year,
      platformData: {},
      parentId: sportId,
      lastUpdated: now,
    });
    const manufacturerId = await ctx.db.insert("selectorOptions", {
      level: "manufacturer",
      value: opts.manufacturer,
      platformData: {},
      parentId: yearId,
      lastUpdated: now,
    });
    const setNameId = await ctx.db.insert("selectorOptions", {
      level: "setName",
      value: opts.setName,
      platformData: {},
      parentId: manufacturerId,
      lastUpdated: now,
    });
    const variantTypeId = await ctx.db.insert("selectorOptions", {
      level: "variantType",
      value: opts.variantType ?? "Base",
      platformData: {},
      parentId: setNameId,
      lastUpdated: now,
    });
    return { sportId, yearId, manufacturerId, setNameId, variantTypeId };
  });
}

/** Inserts a cardChecklist row under the given variant-level selectorOption. */
async function seedCard(
  t: ReturnType<typeof convexTest>,
  selectorOptionId: Id<"selectorOptions">,
  opts: { cardNumber: string; cardName?: string; sortOrder: number },
): Promise<Id<"cardChecklist">> {
  return t.run(async (ctx) =>
    ctx.db.insert("cardChecklist", {
      selectorOptionId,
      cardNumber: opts.cardNumber,
      cardName: opts.cardName ?? `Card ${opts.cardNumber}`,
      platformData: {},
      sortOrder: opts.sortOrder,
      lastUpdated: Date.now(),
    }),
  );
}

async function countCrossListings(
  t: ReturnType<typeof convexTest>,
  selectorOptionId: Id<"selectorOptions">,
): Promise<number> {
  return t.run(async (ctx) => {
    const rows = await ctx.db
      .query("cardCrossListings")
      .withIndex("by_selector_option", (q) =>
        q.eq("selectorOptionId", selectorOptionId),
      )
      .collect();
    return rows.length;
  });
}

// ===========================================================================
// addCrossListingsByCardNumbers
// ===========================================================================

describe("addCrossListingsByCardNumbers", () => {
  test("should link a card number that exists under the source and create a cardCrossListings row", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const home = await seedHierarchy(t, {
      sport: "Football",
      year: "2021",
      manufacturer: "Panini",
      setName: "Score",
    });
    const guest = await seedHierarchy(t, {
      sport: "Football",
      year: "2022",
      manufacturer: "Panini",
      setName: "Chronicles",
    });
    const cardId = await seedCard(t, home.variantTypeId, {
      cardNumber: "301",
      sortOrder: 0,
    });

    const result = await asAdmin.mutation(
      api.selectorOptions.addCrossListingsByCardNumbers,
      {
        sourceSelectorOptionId: home.variantTypeId,
        targetSelectorOptionId: guest.variantTypeId,
        cardNumbers: ["301"],
      },
    );

    expect(result).toEqual({
      linked: ["301"],
      alreadyLinked: [],
      notFound: [],
    });

    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("cardCrossListings")
        .withIndex("by_selector_option", (q) =>
          q.eq("selectorOptionId", guest.variantTypeId),
        )
        .collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].cardChecklistId).toBe(cardId);
    expect(rows[0].selectorOptionId).toBe(guest.variantTypeId);
  });

  test("should return alreadyLinked and not duplicate the row when the same number is linked again", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const home = await seedHierarchy(t, {
      sport: "Football",
      year: "2021",
      manufacturer: "Panini",
      setName: "Score",
    });
    const guest = await seedHierarchy(t, {
      sport: "Football",
      year: "2022",
      manufacturer: "Panini",
      setName: "Chronicles",
    });
    await seedCard(t, home.variantTypeId, { cardNumber: "301", sortOrder: 0 });

    const args = {
      sourceSelectorOptionId: home.variantTypeId,
      targetSelectorOptionId: guest.variantTypeId,
      cardNumbers: ["301"],
    };
    const first = await asAdmin.mutation(
      api.selectorOptions.addCrossListingsByCardNumbers,
      args,
    );
    expect(first.linked).toEqual(["301"]);

    const second = await asAdmin.mutation(
      api.selectorOptions.addCrossListingsByCardNumbers,
      args,
    );
    expect(second).toEqual({
      linked: [],
      alreadyLinked: ["301"],
      notFound: [],
    });

    // No duplicate junction row was created by the repeat call.
    expect(await countCrossListings(t, guest.variantTypeId)).toBe(1);
  });

  test("should return notFound for a card number that does not exist under the source", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const home = await seedHierarchy(t, {
      sport: "Football",
      year: "2021",
      manufacturer: "Panini",
      setName: "Score",
    });
    const guest = await seedHierarchy(t, {
      sport: "Football",
      year: "2022",
      manufacturer: "Panini",
      setName: "Chronicles",
    });
    // Source has no card "999".
    await seedCard(t, home.variantTypeId, { cardNumber: "301", sortOrder: 0 });

    const result = await asAdmin.mutation(
      api.selectorOptions.addCrossListingsByCardNumbers,
      {
        sourceSelectorOptionId: home.variantTypeId,
        targetSelectorOptionId: guest.variantTypeId,
        cardNumbers: ["999"],
      },
    );

    expect(result).toEqual({
      linked: [],
      alreadyLinked: [],
      notFound: ["999"],
    });
    expect(await countCrossListings(t, guest.variantTypeId)).toBe(0);
  });

  test("mixed batch: found, not-found, and already-linked numbers each land in the right bucket", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const home = await seedHierarchy(t, {
      sport: "Football",
      year: "2021",
      manufacturer: "Panini",
      setName: "Score",
    });
    const guest = await seedHierarchy(t, {
      sport: "Football",
      year: "2022",
      manufacturer: "Panini",
      setName: "Chronicles",
    });
    await seedCard(t, home.variantTypeId, { cardNumber: "1", sortOrder: 0 });
    await seedCard(t, home.variantTypeId, { cardNumber: "2", sortOrder: 1 });
    // "3" is intentionally not seeded under home — will be notFound.

    // Pre-link "1" so this call's repeat of it exercises alreadyLinked.
    await asAdmin.mutation(api.selectorOptions.addCrossListingsByCardNumbers, {
      sourceSelectorOptionId: home.variantTypeId,
      targetSelectorOptionId: guest.variantTypeId,
      cardNumbers: ["1"],
    });

    const result = await asAdmin.mutation(
      api.selectorOptions.addCrossListingsByCardNumbers,
      {
        sourceSelectorOptionId: home.variantTypeId,
        targetSelectorOptionId: guest.variantTypeId,
        cardNumbers: ["1", "2", "3"],
      },
    );

    expect(result).toEqual({
      linked: ["2"],
      alreadyLinked: ["1"],
      notFound: ["3"],
    });
    expect(await countCrossListings(t, guest.variantTypeId)).toBe(2);
  });

  test("should throw when sourceSelectorOptionId and targetSelectorOptionId are the same", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const home = await seedHierarchy(t, {
      sport: "Football",
      year: "2021",
      manufacturer: "Panini",
      setName: "Score",
    });
    await seedCard(t, home.variantTypeId, { cardNumber: "301", sortOrder: 0 });

    await expect(
      asAdmin.mutation(api.selectorOptions.addCrossListingsByCardNumbers, {
        sourceSelectorOptionId: home.variantTypeId,
        targetSelectorOptionId: home.variantTypeId,
        cardNumbers: ["301"],
      }),
    ).rejects.toThrow("Cannot cross-list a set into itself");
  });

  test("should throw when caller does not have admin role", async () => {
    const t = convexTest(schema, modules);
    const asUser = t.withIdentity(NON_ADMIN_IDENTITY);

    const home = await seedHierarchy(t, {
      sport: "Football",
      year: "2021",
      manufacturer: "Panini",
      setName: "Score",
    });
    const guest = await seedHierarchy(t, {
      sport: "Football",
      year: "2022",
      manufacturer: "Panini",
      setName: "Chronicles",
    });

    await expect(
      asUser.mutation(api.selectorOptions.addCrossListingsByCardNumbers, {
        sourceSelectorOptionId: home.variantTypeId,
        targetSelectorOptionId: guest.variantTypeId,
        cardNumbers: ["301"],
      }),
    ).rejects.toThrow();
  });

  test("should throw when sourceSelectorOptionId is not a variant-level set", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    // setNameId is sport/year/manufacturer/setName — not variantType/insert/
    // parallel — so cardChecklist rows can never actually live under it.
    const home = await seedHierarchy(t, {
      sport: "Football",
      year: "2021",
      manufacturer: "Panini",
      setName: "Score",
    });
    const guest = await seedHierarchy(t, {
      sport: "Football",
      year: "2022",
      manufacturer: "Panini",
      setName: "Chronicles",
    });

    await expect(
      asAdmin.mutation(api.selectorOptions.addCrossListingsByCardNumbers, {
        sourceSelectorOptionId: home.setNameId,
        targetSelectorOptionId: guest.variantTypeId,
        cardNumbers: ["301"],
      }),
    ).rejects.toThrow(/variant-level/);
  });

  test("should throw when targetSelectorOptionId is not a variant-level set", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const home = await seedHierarchy(t, {
      sport: "Football",
      year: "2021",
      manufacturer: "Panini",
      setName: "Score",
    });
    const guest = await seedHierarchy(t, {
      sport: "Football",
      year: "2022",
      manufacturer: "Panini",
      setName: "Chronicles",
    });
    await seedCard(t, home.variantTypeId, { cardNumber: "301", sortOrder: 0 });

    await expect(
      asAdmin.mutation(api.selectorOptions.addCrossListingsByCardNumbers, {
        sourceSelectorOptionId: home.variantTypeId,
        targetSelectorOptionId: guest.setNameId,
        cardNumbers: ["301"],
      }),
    ).rejects.toThrow(/variant-level/);
  });

  test("should throw when cardNumbers exceeds the server-side cap", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const home = await seedHierarchy(t, {
      sport: "Football",
      year: "2021",
      manufacturer: "Panini",
      setName: "Score",
    });
    const guest = await seedHierarchy(t, {
      sport: "Football",
      year: "2022",
      manufacturer: "Panini",
      setName: "Chronicles",
    });

    // The client caps a single request at 1000 too, but that's advisory —
    // this proves a direct API call can't bypass it by skipping the UI.
    const tooMany = Array.from({ length: 1001 }, (_, i) => String(i + 1));

    await expect(
      asAdmin.mutation(api.selectorOptions.addCrossListingsByCardNumbers, {
        sourceSelectorOptionId: home.variantTypeId,
        targetSelectorOptionId: guest.variantTypeId,
        cardNumbers: tooMany,
      }),
    ).rejects.toThrow(/Too many card numbers/);
  });
});

// ===========================================================================
// removeCrossListing
// ===========================================================================

describe("removeCrossListing", () => {
  test("should delete the junction row and leave the underlying cardChecklist row untouched", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const home = await seedHierarchy(t, {
      sport: "Football",
      year: "2021",
      manufacturer: "Panini",
      setName: "Score",
    });
    const guest = await seedHierarchy(t, {
      sport: "Football",
      year: "2022",
      manufacturer: "Panini",
      setName: "Chronicles",
    });
    const cardId = await seedCard(t, home.variantTypeId, {
      cardNumber: "301",
      cardName: "Justin Jefferson",
      sortOrder: 0,
    });
    const cardBefore = await t.run(async (ctx) => ctx.db.get(cardId));

    await asAdmin.mutation(api.selectorOptions.addCrossListingsByCardNumbers, {
      sourceSelectorOptionId: home.variantTypeId,
      targetSelectorOptionId: guest.variantTypeId,
      cardNumbers: ["301"],
    });

    const [link] = await t.run(async (ctx) =>
      ctx.db
        .query("cardCrossListings")
        .withIndex("by_selector_option", (q) =>
          q.eq("selectorOptionId", guest.variantTypeId),
        )
        .collect(),
    );
    expect(link).toBeDefined();

    await asAdmin.mutation(api.selectorOptions.removeCrossListing, {
      crossListingId: link._id,
    });

    // Junction row is gone.
    expect(await countCrossListings(t, guest.variantTypeId)).toBe(0);

    // The home card row survives, unchanged.
    const cardAfter = await t.run(async (ctx) => ctx.db.get(cardId));
    expect(cardAfter).not.toBeNull();
    expect(cardAfter).toEqual(cardBefore);
  });

  test("should throw when caller does not have admin role", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const asUser = t.withIdentity(NON_ADMIN_IDENTITY);

    const home = await seedHierarchy(t, {
      sport: "Football",
      year: "2021",
      manufacturer: "Panini",
      setName: "Score",
    });
    const guest = await seedHierarchy(t, {
      sport: "Football",
      year: "2022",
      manufacturer: "Panini",
      setName: "Chronicles",
    });
    await seedCard(t, home.variantTypeId, { cardNumber: "301", sortOrder: 0 });
    await asAdmin.mutation(api.selectorOptions.addCrossListingsByCardNumbers, {
      sourceSelectorOptionId: home.variantTypeId,
      targetSelectorOptionId: guest.variantTypeId,
      cardNumbers: ["301"],
    });
    const [link] = await t.run(async (ctx) =>
      ctx.db
        .query("cardCrossListings")
        .withIndex("by_selector_option", (q) =>
          q.eq("selectorOptionId", guest.variantTypeId),
        )
        .collect(),
    );

    await expect(
      asUser.mutation(api.selectorOptions.removeCrossListing, {
        crossListingId: link._id,
      }),
    ).rejects.toThrow();
  });
});

// ===========================================================================
// getCardChecklist: guest-row merge + natural card-number ordering
// ===========================================================================

describe("getCardChecklist: cross-listed guest rows", () => {
  test("merges home and guest rows, sorted by card number (not sortOrder), with correct guest annotations", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const home = await seedHierarchy(t, {
      sport: "Football",
      year: "2021",
      manufacturer: "Panini",
      setName: "Score",
    });
    const guest = await seedHierarchy(t, {
      sport: "Football",
      year: "2022",
      manufacturer: "Panini",
      setName: "Chronicles",
    });

    // Guest set's own home cards, sortOrder matching their card-number order.
    await seedCard(t, guest.variantTypeId, { cardNumber: "5", sortOrder: 0 });
    await seedCard(t, guest.variantTypeId, { cardNumber: "15", sortOrder: 1 });

    // The visiting card: numerically the highest card number ("301") but
    // stamped with a sortOrder far LOWER than the guest set's own rows
    // (inherited from its home checklist, where it was card 301 of ~320 and
    // legitimately had a low index — irrelevant here). If getCardChecklist
    // ever sorted by sortOrder instead of compareCardNumbers, this card
    // would land FIRST instead of LAST.
    const homeCardId = await seedCard(t, home.variantTypeId, {
      cardNumber: "301",
      cardName: "Justin Jefferson",
      sortOrder: -100,
    });

    await asAdmin.mutation(api.selectorOptions.addCrossListingsByCardNumbers, {
      sourceSelectorOptionId: home.variantTypeId,
      targetSelectorOptionId: guest.variantTypeId,
      cardNumbers: ["301"],
    });
    const [link] = await t.run(async (ctx) =>
      ctx.db
        .query("cardCrossListings")
        .withIndex("by_selector_option", (q) =>
          q.eq("selectorOptionId", guest.variantTypeId),
        )
        .collect(),
    );

    const checklist = await asAdmin.query(api.selectorOptions.getCardChecklist, {
      selectorOptionId: guest.variantTypeId,
    });

    // Natural card-number order, guest card last despite lowest sortOrder.
    expect(checklist.map((c) => c.cardNumber)).toEqual(["5", "15", "301"]);
    expect(checklist).toHaveLength(3);

    const guestRow = checklist.find((c) => c.cardNumber === "301");
    expect(guestRow).toBeDefined();
    expect(guestRow?._id).toBe(homeCardId);
    expect(guestRow?.isCrossListed).toBe(true);
    expect(guestRow?.crossListingId).toBe(link._id);
    expect(guestRow?.homeSetLabel).toBe("2021 Panini Score");

    // Home rows carry none of the three guest-only fields truthily.
    const homeRowA = checklist.find((c) => c.cardNumber === "5");
    const homeRowB = checklist.find((c) => c.cardNumber === "15");
    for (const row of [homeRowA, homeRowB]) {
      expect(row?.isCrossListed).toBeFalsy();
      expect(row?.crossListingId).toBeUndefined();
      expect(row?.homeSetLabel).toBeUndefined();
    }
  });

  test("should throw when caller does not have admin role", async () => {
    const t = convexTest(schema, modules);
    const asUser = t.withIdentity(NON_ADMIN_IDENTITY);

    const guest = await seedHierarchy(t, {
      sport: "Football",
      year: "2022",
      manufacturer: "Panini",
      setName: "Chronicles",
    });

    await expect(
      asUser.query(api.selectorOptions.getCardChecklist, {
        selectorOptionId: guest.variantTypeId,
      }),
    ).rejects.toThrow();
  });
});

// ===========================================================================
// deleteCard: cascade-deletes cardCrossListings rows referencing the card
// ===========================================================================

describe("deleteCard: cross-listing cascade", () => {
  test("deleting a cross-listed home card removes its cardCrossListings rows too, leaving no orphan", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const home = await seedHierarchy(t, {
      sport: "Football",
      year: "2021",
      manufacturer: "Panini",
      setName: "Score",
    });
    const guest = await seedHierarchy(t, {
      sport: "Football",
      year: "2022",
      manufacturer: "Panini",
      setName: "Chronicles",
    });
    const cardId = await seedCard(t, home.variantTypeId, {
      cardNumber: "301",
      sortOrder: 0,
    });

    await asAdmin.mutation(api.selectorOptions.addCrossListingsByCardNumbers, {
      sourceSelectorOptionId: home.variantTypeId,
      targetSelectorOptionId: guest.variantTypeId,
      cardNumbers: ["301"],
    });

    // Sanity: the link exists before deletion.
    const before = await asAdmin.query(
      api.selectorOptions.getCrossListingsForCard,
      { cardChecklistId: cardId },
    );
    expect(before).toHaveLength(1);
    expect(before[0].setLabel).toBe("2022 Panini Chronicles");

    await asAdmin.mutation(api.selectorOptions.deleteCard, { id: cardId });

    // The card itself is gone.
    const cardAfter = await t.run(async (ctx) => ctx.db.get(cardId));
    expect(cardAfter).toBeNull();

    // No orphaned cardCrossListings row survives — checked both via the
    // by_card index (getCrossListingsForCard) and directly against the
    // guest-side by_selector_option index.
    const after = await asAdmin.query(
      api.selectorOptions.getCrossListingsForCard,
      { cardChecklistId: cardId },
    );
    expect(after).toEqual([]);
    expect(await countCrossListings(t, guest.variantTypeId)).toBe(0);
  });
});
