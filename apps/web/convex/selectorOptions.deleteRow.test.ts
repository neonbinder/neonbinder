/**
 * NEO-219 C — the one sanctioned selectorOptions delete, and the reactive
 * holdings read behind its affordance.
 *
 * "Sets are fixed, never deleted" holds everywhere except a row with NOTHING
 * below it (Jason, 2026-09-03). These tests are the guard: every refusal path,
 * and the narrow success path.
 *
 * Covers:
 *  - empty custom row is deleted, the parent's children array shrinks, and the
 *    transient per-batch rows keyed on it go with it
 *  - refused for child rows / cards / cross-listings, each naming what it found
 *  - sport row holding players (and teams, and leagues) refused
 *  - non-custom variantType refused as protected, custom variantType allowed
 *  - an empty SYNCED row IS deletable and reports syncedBack
 *  - non-admin rejected
 *  - getSelectorOptionHoldings mirrors the mutation's view, non-destructively
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { api } from "./_generated/api";
import schema from "./schema";
import { Id } from "./_generated/dataModel";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN_IDENTITY = {
  subject: "admin_user_neo219_delete",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_user_neo219_delete",
  name: "Admin User",
  role: "admin",
};

const NON_ADMIN_IDENTITY = {
  subject: "normal_user_neo219_delete",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|normal_user_neo219_delete",
  name: "Normal User",
  role: "user",
};

const SENTINEL_LAST_UPDATED = 1_700_000_000_000;

type Level =
  | "sport"
  | "year"
  | "manufacturer"
  | "setName"
  | "variantType"
  | "insert"
  | "parallel";

type HoldKind =
  | "rows"
  | "cards"
  | "crossListings"
  | "players"
  | "teams"
  | "leagues";

type NotEmptyData = {
  code: string;
  holds: Array<{ kind: HoldKind; count: number; examples: string[] }>;
};

async function insertRow(
  t: ReturnType<typeof convexTest>,
  level: Level,
  value: string,
  opts: {
    parentId?: Id<"selectorOptions">;
    isCustom?: boolean;
    platformData?: {
      bsc?: Record<string, string>;
      sportlots?: Record<string, string>;
    };
  } = {},
): Promise<Id<"selectorOptions">> {
  return t.run(async (ctx) => {
    const id = await ctx.db.insert("selectorOptions", {
      level,
      value,
      platformData: opts.platformData ?? {},
      parentId: opts.parentId,
      children: [],
      ...(opts.isCustom ? { isCustom: true } : {}),
      lastUpdated: SENTINEL_LAST_UPDATED,
    });
    if (opts.parentId) {
      const parent = await ctx.db.get(opts.parentId);
      if (parent) {
        await ctx.db.patch(opts.parentId, {
          children: [...(parent.children ?? []), id],
        });
      }
    }
    return id;
  });
}

async function insertCard(
  t: ReturnType<typeof convexTest>,
  selectorOptionId: Id<"selectorOptions">,
  cardNumber: string,
  cardName: string,
): Promise<Id<"cardChecklist">> {
  return t.run(async (ctx) =>
    ctx.db.insert("cardChecklist", {
      selectorOptionId,
      cardNumber,
      cardName,
      platformData: {},
      sortOrder: Number(cardNumber) || 0,
      lastUpdated: SENTINEL_LAST_UPDATED,
    }),
  );
}

function holdFor(
  data: NotEmptyData,
  kind: HoldKind,
): { kind: HoldKind; count: number; examples: string[] } | undefined {
  return data.holds.find((hold) => hold.kind === kind);
}

async function expectRefusal(
  fn: () => Promise<unknown>,
): Promise<ConvexError<NotEmptyData>> {
  let thrown: unknown;
  try {
    await fn();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ConvexError);
  return thrown as ConvexError<NotEmptyData>;
}

// ===========================================================================
// Success path
// ===========================================================================

describe("deleteSelectorOption — empty row", () => {
  test("deletes an empty custom row and shrinks the parent's children", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const sportId = await insertRow(t, "sport", "Baseball");
    const keeperId = await insertRow(t, "year", "2023", { parentId: sportId });
    const doomedId = await insertRow(t, "year", "2024", {
      parentId: sportId,
      isCustom: true,
    });

    const result = await asAdmin.mutation(
      api.selectorOptions.deleteSelectorOption,
      { id: doomedId },
    );

    expect(result.deleted).toBe(true);
    expect(result.parentId).toBe(sportId);
    // No marketplace id on the row, so nothing warns about a re-sync.
    expect(result.syncedBack).toBeUndefined();

    const gone = await t.run(async (ctx) => ctx.db.get(doomedId));
    expect(gone).toBeNull();

    const parent = await t.run(async (ctx) => ctx.db.get(sportId));
    expect(parent!.children).toEqual([keeperId]);
  });

  test("deletes the transient per-batch rows keyed on the row", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const sportId = await insertRow(t, "sport", "Baseball");
    const setId = await insertRow(t, "setName", "Topps Chrome", {
      parentId: sportId,
      isCustom: true,
    });

    await t.run(async (ctx) => {
      await ctx.db.insert("entityReviewQueue", {
        selectorOptionId: setId,
        batchId: "batch-1",
        createdByUserId: ADMIN_IDENTITY.subject,
        kind: "player",
        name: "Some Name",
        sportId,
        status: "pending",
      });
      await ctx.db.insert("entityReviewSkips", {
        selectorOptionId: setId,
        kind: "team",
        nameNormalized: "checklist",
        name: "Checklist",
        skippedAt: SENTINEL_LAST_UPDATED,
        skippedByUserId: ADMIN_IDENTITY.subject,
      });
      await ctx.db.insert("checklistCandidates", {
        selectorOptionId: setId,
        batchId: "batch-1",
        createdByUserId: ADMIN_IDENTITY.subject,
        cardNumber: "1",
        cardName: "Some Player",
        platformData: {},
        bucket: "matched",
        stem: "1",
        status: "ready",
        lastUpdated: SENTINEL_LAST_UPDATED,
      });
      // Status row for a CHILD column of the row being deleted.
      await ctx.db.insert("selectorSyncStatus", {
        level: "variantType",
        parentId: setId,
        status: "error",
        message: "boom",
        updatedAt: SENTINEL_LAST_UPDATED,
      });
    });

    await asAdmin.mutation(api.selectorOptions.deleteSelectorOption, {
      id: setId,
    });

    const leftovers = await t.run(async (ctx) => ({
      queue: (await ctx.db.query("entityReviewQueue").collect()).length,
      skips: (await ctx.db.query("entityReviewSkips").collect()).length,
      candidates: (await ctx.db.query("checklistCandidates").collect()).length,
      statuses: (await ctx.db.query("selectorSyncStatus").collect()).length,
    }));

    expect(leftovers).toEqual({
      queue: 0,
      skips: 0,
      candidates: 0,
      statuses: 0,
    });
  });

  test("an empty SYNCED row is deletable and reports syncedBack", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const mfrId = await insertRow(t, "manufacturer", "Topps");
    // No isCustom, and it carries a BSC slug — a row the marketplace named.
    const setId = await insertRow(t, "setName", "Topps Chrome", {
      parentId: mfrId,
      platformData: { bsc: { b0: "topps-chrome" } },
    });

    const result = await asAdmin.mutation(
      api.selectorOptions.deleteSelectorOption,
      { id: setId },
    );

    expect(result.deleted).toBe(true);
    // Decision 1: any empty row goes, and the dialog says the next sync may
    // bring a synced one back.
    expect(result.syncedBack).toBe(true);
    expect(await t.run(async (ctx) => ctx.db.get(setId))).toBeNull();
  });

  test("deletes a root row with no parent", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const sportId = await insertRow(t, "sport", "Cricket", { isCustom: true });

    const result = await asAdmin.mutation(
      api.selectorOptions.deleteSelectorOption,
      { id: sportId },
    );

    expect(result.deleted).toBe(true);
    expect(result.parentId).toBeUndefined();
  });
});

// ===========================================================================
// Refusals
// ===========================================================================

describe("deleteSelectorOption — refusals", () => {
  test("refuses a row with child rows and names them", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const mfrId = await insertRow(t, "manufacturer", "Topps");
    await insertRow(t, "setName", "Topps Chrome", { parentId: mfrId });
    await insertRow(t, "setName", "Topps Series 1", { parentId: mfrId });

    const error = await expectRefusal(() =>
      asAdmin.mutation(api.selectorOptions.deleteSelectorOption, {
        id: mfrId,
      }),
    );

    expect(error.data.code).toBe("SELECTOR_ROW_NOT_EMPTY");
    const rows = holdFor(error.data, "rows");
    expect(rows?.count).toBe(2);
    expect(rows?.examples).toEqual(
      expect.arrayContaining(["Topps Chrome", "Topps Series 1"]),
    );

    expect(await t.run(async (ctx) => ctx.db.get(mfrId))).not.toBeNull();
  });

  test("refuses a row holding cards and names them", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const setId = await insertRow(t, "setName", "Topps Chrome");
    const rowId = await insertRow(t, "insert", "Future Stars", {
      parentId: setId,
      isCustom: true,
    });
    await insertCard(t, rowId, "1", "Shohei Ohtani");
    await insertCard(t, rowId, "2", "Mike Trout");

    const error = await expectRefusal(() =>
      asAdmin.mutation(api.selectorOptions.deleteSelectorOption, { id: rowId }),
    );

    expect(error.data.code).toBe("SELECTOR_ROW_NOT_EMPTY");
    const cards = holdFor(error.data, "cards");
    expect(cards?.count).toBe(2);
    expect(cards?.examples).toEqual(
      expect.arrayContaining(["#1 Shohei Ohtani", "#2 Mike Trout"]),
    );
  });

  test("refuses a row that is only a cross-listing guest", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const setId = await insertRow(t, "setName", "2022 Chronicles");
    const homeRowId = await insertRow(t, "insert", "Home", {
      parentId: setId,
      isCustom: true,
    });
    const guestRowId = await insertRow(t, "insert", "Guest", {
      parentId: setId,
      isCustom: true,
    });
    const cardId = await insertCard(t, homeRowId, "301", "Julio Rodriguez");
    await t.run(async (ctx) => {
      await ctx.db.insert("cardCrossListings", {
        cardChecklistId: cardId,
        selectorOptionId: guestRowId,
        lastUpdated: SENTINEL_LAST_UPDATED,
      });
    });

    const error = await expectRefusal(() =>
      asAdmin.mutation(api.selectorOptions.deleteSelectorOption, {
        id: guestRowId,
      }),
    );

    expect(error.data.code).toBe("SELECTOR_ROW_NOT_EMPTY");
    // The guest row holds no cards of its own — only the junction row.
    expect(holdFor(error.data, "cards")).toBeUndefined();
    const cross = holdFor(error.data, "crossListings");
    expect(cross?.count).toBe(1);
    expect(cross?.examples).toEqual(["#301 Julio Rodriguez"]);
  });

  test("refuses a sport row holding players, teams and leagues", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const sportId = await insertRow(t, "sport", "Pickleball", {
      isCustom: true,
    });
    await t.run(async (ctx) => {
      await ctx.db.insert("players", {
        name: "Ben Johns",
        nameNormalized: "ben johns",
        sportId,
        lastUpdated: SENTINEL_LAST_UPDATED,
      });
      await ctx.db.insert("teams", {
        name: "Austin Ignite",
        nameNormalized: "austin ignite",
        sportId,
        lastUpdated: SENTINEL_LAST_UPDATED,
      });
      await ctx.db.insert("leagues", {
        name: "Major League Pickleball",
        nameNormalized: "major league pickleball",
        sportId,
        lastUpdated: SENTINEL_LAST_UPDATED,
      });
    });

    const error = await expectRefusal(() =>
      asAdmin.mutation(api.selectorOptions.deleteSelectorOption, {
        id: sportId,
      }),
    );

    expect(error.data.code).toBe("SELECTOR_ROW_NOT_EMPTY");
    expect(holdFor(error.data, "players")).toEqual({
      kind: "players",
      count: 1,
      examples: ["Ben Johns"],
    });
    expect(holdFor(error.data, "teams")?.examples).toEqual(["Austin Ignite"]);
    expect(holdFor(error.data, "leagues")?.examples).toEqual([
      "Major League Pickleball",
    ]);
  });

  test("does not check players/teams/leagues at non-sport levels", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const sportId = await insertRow(t, "sport", "Baseball");
    const yearId = await insertRow(t, "year", "2024", {
      parentId: sportId,
      isCustom: true,
    });
    // A player pointing at the SPORT must not block deleting a YEAR.
    await t.run(async (ctx) => {
      await ctx.db.insert("players", {
        name: "Mike Trout",
        nameNormalized: "mike trout",
        sportId,
        lastUpdated: SENTINEL_LAST_UPDATED,
      });
    });

    const result = await asAdmin.mutation(
      api.selectorOptions.deleteSelectorOption,
      { id: yearId },
    );
    expect(result.deleted).toBe(true);
  });

  test("refuses a non-custom variantType as protected", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const setId = await insertRow(t, "setName", "Topps Chrome");
    const baseId = await insertRow(t, "variantType", "Base", {
      parentId: setId,
    });

    const error = await expectRefusal(() =>
      asAdmin.mutation(api.selectorOptions.deleteSelectorOption, { id: baseId }),
    );

    expect(error.data.code).toBe("SELECTOR_ROW_PROTECTED");
    expect(await t.run(async (ctx) => ctx.db.get(baseId))).not.toBeNull();
  });

  test("allows an empty CUSTOM variantType", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const setId = await insertRow(t, "setName", "Topps Chrome");
    const customVt = await insertRow(t, "variantType", "Box Topper", {
      parentId: setId,
      isCustom: true,
    });

    const result = await asAdmin.mutation(
      api.selectorOptions.deleteSelectorOption,
      { id: customVt },
    );
    expect(result.deleted).toBe(true);
  });

  test("reports protected before holdings so the reason is the durable one", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const setId = await insertRow(t, "setName", "Topps Chrome");
    const baseId = await insertRow(t, "variantType", "Base", {
      parentId: setId,
    });
    await insertCard(t, baseId, "1", "Shohei Ohtani");

    const error = await expectRefusal(() =>
      asAdmin.mutation(api.selectorOptions.deleteSelectorOption, { id: baseId }),
    );
    expect(error.data.code).toBe("SELECTOR_ROW_PROTECTED");
  });

  test("throws for a row that does not exist", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const doomedId = await insertRow(t, "sport", "Cricket", { isCustom: true });
    await asAdmin.mutation(api.selectorOptions.deleteSelectorOption, {
      id: doomedId,
    });

    await expect(
      asAdmin.mutation(api.selectorOptions.deleteSelectorOption, {
        id: doomedId,
      }),
    ).rejects.toThrow(/not found/);
  });

  test("rejects a non-admin caller", async () => {
    const t = convexTest(schema, modules);
    const sportId = await insertRow(t, "sport", "Cricket", { isCustom: true });

    await expect(
      t
        .withIdentity(NON_ADMIN_IDENTITY)
        .mutation(api.selectorOptions.deleteSelectorOption, { id: sportId }),
    ).rejects.toThrow(/Admin access required/);

    expect(await t.run(async (ctx) => ctx.db.get(sportId))).not.toBeNull();
  });

  test("rejects an unauthenticated caller", async () => {
    const t = convexTest(schema, modules);
    const sportId = await insertRow(t, "sport", "Cricket", { isCustom: true });

    await expect(
      t.mutation(api.selectorOptions.deleteSelectorOption, { id: sportId }),
    ).rejects.toThrow(/Not authenticated/);
  });
});

// ===========================================================================
// getSelectorOptionHoldings
// ===========================================================================

describe("getSelectorOptionHoldings", () => {
  test("reports an empty row as deletable and unprotected", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const sportId = await insertRow(t, "sport", "Cricket", { isCustom: true });

    expect(
      await asAdmin.query(api.selectorOptions.getSelectorOptionHoldings, {
        id: sportId,
      }),
    ).toEqual({ holds: [], protected: false });
  });

  test("mirrors what the mutation would refuse on, and deletes nothing", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const setId = await insertRow(t, "setName", "Topps Chrome");
    const rowId = await insertRow(t, "insert", "Future Stars", {
      parentId: setId,
      isCustom: true,
    });
    await insertCard(t, rowId, "1", "Shohei Ohtani");

    const holdings = await asAdmin.query(
      api.selectorOptions.getSelectorOptionHoldings,
      { id: rowId },
    );

    expect(holdings.protected).toBe(false);
    expect(holdings.holds).toEqual([
      { kind: "cards", count: 1, examples: ["#1 Shohei Ohtani"] },
    ]);
    expect(await t.run(async (ctx) => ctx.db.get(rowId))).not.toBeNull();
  });

  test("flags a non-custom variantType as protected", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const setId = await insertRow(t, "setName", "Topps Chrome");
    const baseId = await insertRow(t, "variantType", "Base", {
      parentId: setId,
    });

    const holdings = await asAdmin.query(
      api.selectorOptions.getSelectorOptionHoldings,
      { id: baseId },
    );
    expect(holdings.protected).toBe(true);
    expect(holdings.holds).toEqual([]);
  });

  test("returns an empty answer for a row that has just been deleted", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const sportId = await insertRow(t, "sport", "Cricket", { isCustom: true });
    await asAdmin.mutation(api.selectorOptions.deleteSelectorOption, {
      id: sportId,
    });

    // A live subscription under an open column must not become an error.
    expect(
      await asAdmin.query(api.selectorOptions.getSelectorOptionHoldings, {
        id: sportId,
      }),
    ).toEqual({ holds: [], protected: false });
  });

  test("rejects a non-admin caller", async () => {
    const t = convexTest(schema, modules);
    const sportId = await insertRow(t, "sport", "Cricket", { isCustom: true });

    await expect(
      t
        .withIdentity(NON_ADMIN_IDENTITY)
        .query(api.selectorOptions.getSelectorOptionHoldings, { id: sportId }),
    ).rejects.toThrow(/Admin access required/);
  });
});
