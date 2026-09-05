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
 *    transient rows keyed on it (skips, sync status) go with it
 *  - staged checklist review work (checklistCandidates / entityReviewQueue) is
 *    a HOLDING, not transient — the delete refuses while a review is live
 *  - the sweep is bounded: more archived skips than the cap refuses instead
 *  - refused for child rows / cards / cross-listings, each naming what it found
 *  - a "rows" holding carries the children's LEVEL when they share one, and
 *    omits it when they are mixed
 *  - sport row holding players (and teams, and leagues) refused
 *  - NEO-239: no protected row class — an EMPTY variantType deletes like any
 *    other row; only its HOLDINGS can refuse it
 *  - an empty SYNCED row IS deletable and reports syncedBack
 *  - non-admin rejected
 *  - getSelectorOptionHoldings mirrors the mutation's view, non-destructively
 */

import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import { ConvexError } from "convex/values";
import { api, internal } from "./_generated/api";
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

/** Mirrors TRANSIENT_DELETE_CAP in convex/selectorOptions.ts. */
const TRANSIENT_DELETE_CAP = 500;

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
  | "leagues"
  | "review";

type Hold = {
  kind: HoldKind;
  count: number;
  examples: string[];
  /** `kind: "rows"` only, and only when every child shares one level. */
  level?: Level;
};

type NotEmptyData = {
  code: string;
  holds: Hold[];
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

function holdFor(data: NotEmptyData, kind: HoldKind): Hold | undefined {
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

  test("sweeps the transient rows that mean nothing without the row", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const sportId = await insertRow(t, "sport", "Baseball");
    const setId = await insertRow(t, "setName", "Topps Chrome", {
      parentId: sportId,
      isCustom: true,
    });

    await t.run(async (ctx) => {
      // A "not a person" ruling is meaningless once the set is gone.
      await ctx.db.insert("entityReviewSkips", {
        selectorOptionId: setId,
        kind: "team",
        nameNormalized: "checklist",
        name: "Checklist",
        skippedAt: SENTINEL_LAST_UPDATED,
        skippedByUserId: ADMIN_IDENTITY.subject,
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
      skips: (await ctx.db.query("entityReviewSkips").collect()).length,
      statuses: (await ctx.db.query("selectorSyncStatus").collect()).length,
    }));

    expect(leftovers).toEqual({ skips: 0, statuses: 0 });
  });

  // ── security condition 2: staged review work is a HOLDING, not transient ──
  //
  // A set under review has ~900 checklistCandidates and a queue of unresolved
  // names but NOT ONE cardChecklist row — so before this, the delete was most
  // available exactly while another admin's review was live.

  test("refuses a row carrying staged checklistCandidates", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const setId = await insertRow(t, "setName", "Topps Chrome", {
      isCustom: true,
    });
    await t.run(async (ctx) => {
      for (const cardNumber of ["1", "2", "3"]) {
        await ctx.db.insert("checklistCandidates", {
          selectorOptionId: setId,
          batchId: "batch-1",
          createdByUserId: "some_other_admin",
          cardNumber,
          cardName: `Card ${cardNumber}`,
          platformData: {},
          bucket: "matched",
          stem: cardNumber,
          status: "ready",
          lastUpdated: SENTINEL_LAST_UPDATED,
        });
      }
    });

    // The row has NO cards yet — that is the whole hazard.
    expect(
      await t.run(async (ctx) =>
        (await ctx.db.query("cardChecklist").collect()).length,
      ),
    ).toBe(0);

    const error = await expectRefusal(() =>
      asAdmin.mutation(api.selectorOptions.deleteSelectorOption, { id: setId }),
    );

    expect(error.data.code).toBe("SELECTOR_ROW_NOT_EMPTY");
    expect(holdFor(error.data, "review")).toEqual({
      kind: "review",
      count: 3,
      // Never the staged names — another operator's in-progress work.
      examples: [],
    });

    expect(await t.run(async (ctx) => ctx.db.get(setId))).not.toBeNull();
    expect(
      await t.run(async (ctx) =>
        (await ctx.db.query("checklistCandidates").collect()).length,
      ),
    ).toBe(3);
  });

  test("refuses a row carrying an entityReviewQueue", async () => {
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
        createdByUserId: "some_other_admin",
        kind: "player",
        name: "Unresolved Name",
        sportId,
        status: "pending",
      });
    });

    const error = await expectRefusal(() =>
      asAdmin.mutation(api.selectorOptions.deleteSelectorOption, { id: setId }),
    );

    expect(error.data.code).toBe("SELECTOR_ROW_NOT_EMPTY");
    expect(holdFor(error.data, "review")).toEqual({
      kind: "review",
      count: 1,
      examples: [],
    });

    expect(
      await t.run(async (ctx) =>
        (await ctx.db.query("entityReviewQueue").collect()).length,
      ),
    ).toBe(1);
  });

  test("getSelectorOptionHoldings reports staged review work too", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const setId = await insertRow(t, "setName", "Topps Chrome", {
      isCustom: true,
    });
    await t.run(async (ctx) => {
      await ctx.db.insert("checklistCandidates", {
        selectorOptionId: setId,
        batchId: "batch-1",
        createdByUserId: "some_other_admin",
        cardNumber: "1",
        cardName: "Card 1",
        platformData: {},
        bucket: "matched",
        stem: "1",
        status: "ready",
        lastUpdated: SENTINEL_LAST_UPDATED,
      });
    });

    const holdings = await asAdmin.query(
      api.selectorOptions.getSelectorOptionHoldings,
      { id: setId },
    );
    expect(holdings.holds).toEqual([
      { kind: "review", count: 1, examples: [] },
    ]);
  });

  // ── security condition 3a: the sweep is bounded ──────────────────────────

  test("refuses rather than sweeping more archived skips than the cap", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const setId = await insertRow(t, "setName", "Topps Chrome", {
      isCustom: true,
    });
    await t.run(async (ctx) => {
      for (let i = 0; i < TRANSIENT_DELETE_CAP + 1; i++) {
        await ctx.db.insert("entityReviewSkips", {
          selectorOptionId: setId,
          kind: "player",
          nameNormalized: `name ${i}`,
          name: `Name ${i}`,
          skippedAt: SENTINEL_LAST_UPDATED,
          skippedByUserId: ADMIN_IDENTITY.subject,
        });
      }
    });

    const error = await expectRefusal(() =>
      asAdmin.mutation(api.selectorOptions.deleteSelectorOption, { id: setId }),
    );

    expect(error.data.code).toBe("SELECTOR_ROW_NOT_EMPTY");
    // Refused rather than issuing a 501-row write batch in one transaction.
    expect(holdFor(error.data, "review")?.count).toBe(TRANSIENT_DELETE_CAP + 1);
    expect(await t.run(async (ctx) => ctx.db.get(setId))).not.toBeNull();
  });

  test("sweeps a skip count at the cap without refusing", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const setId = await insertRow(t, "setName", "Topps Chrome", {
      isCustom: true,
    });
    await t.run(async (ctx) => {
      for (let i = 0; i < TRANSIENT_DELETE_CAP; i++) {
        await ctx.db.insert("entityReviewSkips", {
          selectorOptionId: setId,
          kind: "player",
          nameNormalized: `name ${i}`,
          name: `Name ${i}`,
          skippedAt: SENTINEL_LAST_UPDATED,
          skippedByUserId: ADMIN_IDENTITY.subject,
        });
      }
    });

    const result = await asAdmin.mutation(
      api.selectorOptions.deleteSelectorOption,
      { id: setId },
    );
    expect(result.deleted).toBe(true);
    expect(
      await t.run(async (ctx) =>
        (await ctx.db.query("entityReviewSkips").collect()).length,
      ),
    ).toBe(0);
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
    // The children's level, so the FE says "2 sets" — the PARENT's level
    // cannot say this (a variantType holds inserts OR parallels).
    expect(rows?.level).toBe("setName");

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

  test("names the children's level, not the parent's, for parallels under an insert", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const setId = await insertRow(t, "setName", "Topps Chrome");
    const insertId = await insertRow(t, "insert", "Future Stars", {
      parentId: setId,
      isCustom: true,
    });
    await insertRow(t, "parallel", "Gold /50", { parentId: insertId });

    const error = await expectRefusal(() =>
      asAdmin.mutation(api.selectorOptions.deleteSelectorOption, {
        id: insertId,
      }),
    );

    expect(holdFor(error.data, "rows")).toEqual({
      kind: "rows",
      count: 1,
      examples: ["Gold /50"],
      level: "parallel",
    });
  });

  test("omits level when the children are mixed rather than guessing", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const setId = await insertRow(t, "setName", "Topps Chrome");
    // A variantType legitimately holds BOTH — inserts of an Insert variant
    // type and parallels of the row itself.
    const vtId = await insertRow(t, "variantType", "Insert", {
      parentId: setId,
      isCustom: true,
    });
    await insertRow(t, "insert", "Future Stars", { parentId: vtId });
    await insertRow(t, "parallel", "Gold /50", { parentId: vtId });

    const error = await expectRefusal(() =>
      asAdmin.mutation(api.selectorOptions.deleteSelectorOption, { id: vtId }),
    );

    const rows = holdFor(error.data, "rows");
    expect(rows?.count).toBe(2);
    // Absent, so the FE falls back to the neutral "2 rows" instead of naming
    // two parallels that are actually one parallel and one insert.
    expect(rows?.level).toBeUndefined();
  });

  test("an EMPTY variantType deletes like any other row (NEO-239)", async () => {
    // NEO-219 refused this as `SELECTOR_ROW_PROTECTED`, on the reasoning that
    // Base/Insert/Parallel are load-bearing STRINGS the sync,
    // `getBaseVariantBySet` and the BSC facet derivation resolve by name.
    // NEO-239 made every one of those read the row instead — `metadata.isBase`
    // and a `variant`-tagged slot — so the name is a name and there is no
    // protected row class left. The other half of that reasoning, "the sync
    // would just re-create it", is real and is reported as `syncedBack`, not
    // used to refuse.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const setId = await insertRow(t, "setName", "Topps Chrome");
    const baseId = await insertRow(t, "variantType", "Base", {
      parentId: setId,
    });

    const result = await asAdmin.mutation(
      api.selectorOptions.deleteSelectorOption,
      { id: baseId },
    );

    expect(result.deleted).toBe(true);
    expect(await t.run(async (ctx) => ctx.db.get(baseId))).toBeNull();
  });

  test("a hand-added variantType deletes too — same row, same rules", async () => {
    // It was already allowed; the point now is that it is not a DIFFERENT
    // case. Nothing distinguishes the two rows to the delete path.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const setId = await insertRow(t, "setName", "Topps Chrome");
    const handAdded = await insertRow(t, "variantType", "Box Topper", {
      parentId: setId,
    });

    const result = await asAdmin.mutation(
      api.selectorOptions.deleteSelectorOption,
      { id: handAdded },
    );
    expect(result.deleted).toBe(true);
  });

  test("a variantType that HOLDS something is still refused, on the holdings", async () => {
    // The refusal that survives, and the one that was always the real guard:
    // what hangs off the row. NEO-219 reported `SELECTOR_ROW_PROTECTED` first
    // here because that reason was durable; now there is only one reason, and
    // it names what the operator has to clear.
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
    expect(error.data.code).toBe("SELECTOR_ROW_NOT_EMPTY");
    expect(await t.run(async (ctx) => ctx.db.get(baseId))).not.toBeNull();
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

// ===========================================================================
// Audit trail (security condition 5)
// ===========================================================================

describe("deleteSelectorOption — audit log", () => {
  test("names the admin who deleted the row", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const sportId = await insertRow(t, "sport", "Cricket", { isCustom: true });

    // Captured INSIDE the implementation, not read off `mock.calls` after the
    // fact — `mockRestore` clears the recorded calls. Same shape as
    // commitCardChecklist.resync.test.ts.
    const logs: string[] = [];
    const spy = vi
      .spyOn(console, "log")
      .mockImplementation((...args: unknown[]) => {
        logs.push(args.map(String).join(" "));
      });
    try {
      await asAdmin.mutation(api.selectorOptions.deleteSelectorOption, {
        id: sportId,
      });
    } finally {
      spy.mockRestore();
    }

    const lines = logs
      .filter((line) => line.includes("selector_option_deleted"))
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(lines).toHaveLength(1);
    // The row is gone afterwards, so this line is the ONLY trace the one
    // sanctioned delete leaves. It has to say who.
    expect(lines[0]).toMatchObject({
      msg: "selector_option_deleted",
      adminUserId: ADMIN_IDENTITY.subject,
      id: sportId,
      level: "sport",
      value: "Cricket",
      // NEO-239 — `isCustom` is NOT on the line. Nothing writes the field any
      // more, so logging it would read `false` on every row, including the
      // hand-added ones, and say the opposite of what it looks like it says.
      // `syncedBack` carries the fact that actually distinguishes them.
      syncedBack: false,
    });
    expect(lines[0]).not.toHaveProperty("isCustom");
  });
});

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

  test("carries the children's level on a rows holding", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const yearId = await insertRow(t, "year", "2024");
    await insertRow(t, "manufacturer", "Topps", { parentId: yearId });

    const holdings = await asAdmin.query(
      api.selectorOptions.getSelectorOptionHoldings,
      { id: yearId },
    );

    expect(holdings.holds).toEqual([
      {
        kind: "rows",
        count: 1,
        examples: ["Topps"],
        level: "manufacturer",
      },
    ]);
  });

  test("NO row reports as protected any more (NEO-239)", async () => {
    // `protected` was `refusesValueRename` — a variantType row nobody typed by
    // hand. That class is gone, so the field is always false and the delete
    // affordance is never disabled on those grounds. Kept in the shape so the
    // FE keeps compiling; it should stop reading it.
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
    expect(holdings.protected).toBe(false);
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

// ===========================================================================
// Adversarial pass (NEO-219 readiness) — structural edge cases the happy-path
// suite above does not reach: a row that holds ONLY transient state, a
// diverged/dangling `parent.children`, a parent that no longer exists, and a
// checklist commit racing the delete between the query and the write.
// ===========================================================================

describe("deleteSelectorOption — adversarial", () => {
  // NEO-219 security condition 2 rewrote this case. It used to assert that a
  // row carrying all four per-batch tables deleted cleanly. Two of them —
  // checklistCandidates and entityReviewQueue — are another operator's live
  // review, and a set under review has NO cardChecklist rows yet, so that
  // behaviour made the delete most available exactly when it was most
  // destructive. They are holdings now; the other two are still swept.
  test("staged review rows hold the delete; skips and sync status do not", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const sportId = await insertRow(t, "sport", "Baseball");
    const setId = await insertRow(t, "setName", "Topps Chrome", {
      parentId: sportId,
      isCustom: true,
    });

    const seedSweepable = async () => {
      await t.run(async (ctx) => {
        await ctx.db.insert("entityReviewSkips", {
          selectorOptionId: setId,
          kind: "team",
          nameNormalized: "checklist",
          name: "Checklist",
          skippedAt: SENTINEL_LAST_UPDATED,
          skippedByUserId: ADMIN_IDENTITY.subject,
        });
        await ctx.db.insert("selectorSyncStatus", {
          level: "variantType",
          parentId: setId,
          status: "error",
          message: "boom",
          updatedAt: SENTINEL_LAST_UPDATED,
        });
      });
    };

    // All four present → the two staged ones hold it.
    await seedSweepable();
    const stagedIds = await t.run(async (ctx) => ({
      queue: await ctx.db.insert("entityReviewQueue", {
        selectorOptionId: setId,
        batchId: "batch-1",
        createdByUserId: "some_other_admin",
        kind: "player",
        name: "Some Name",
        sportId,
        status: "pending",
      }),
      candidate: await ctx.db.insert("checklistCandidates", {
        selectorOptionId: setId,
        batchId: "batch-1",
        createdByUserId: "some_other_admin",
        cardNumber: "1",
        cardName: "Some Player",
        platformData: {},
        bucket: "matched",
        stem: "1",
        status: "ready",
        lastUpdated: SENTINEL_LAST_UPDATED,
      }),
    }));

    const holdingsBefore = await asAdmin.query(
      api.selectorOptions.getSelectorOptionHoldings,
      { id: setId },
    );
    expect(holdingsBefore.holds).toEqual([
      { kind: "review", count: 2, examples: [] },
    ]);

    const error = await expectRefusal(() =>
      asAdmin.mutation(api.selectorOptions.deleteSelectorOption, { id: setId }),
    );
    expect(error.data.code).toBe("SELECTOR_ROW_NOT_EMPTY");
    // Refused writes NOTHING — the other operator's review is intact, and so
    // are the sweepable rows.
    expect(await t.run(async (ctx) => ctx.db.get(setId))).not.toBeNull();
    expect(
      await t.run(async (ctx) => ({
        queue: await ctx.db.get(stagedIds.queue),
        candidate: await ctx.db.get(stagedIds.candidate),
        skips: (await ctx.db.query("entityReviewSkips").collect()).length,
        statuses: (await ctx.db.query("selectorSyncStatus").collect()).length,
      })),
    ).toEqual({
      queue: expect.objectContaining({ name: "Some Name" }),
      candidate: expect.objectContaining({ cardName: "Some Player" }),
      skips: 1,
      statuses: 1,
    });

    // Review finishes (its rows are cleaned up by the commit) → now it goes,
    // and the two sweepable tables go with it.
    await t.run(async (ctx) => {
      await ctx.db.delete(stagedIds.queue);
      await ctx.db.delete(stagedIds.candidate);
    });

    expect(
      await asAdmin.query(api.selectorOptions.getSelectorOptionHoldings, {
        id: setId,
      }),
    ).toEqual({ holds: [], protected: false });

    const result = await asAdmin.mutation(
      api.selectorOptions.deleteSelectorOption,
      { id: setId },
    );
    expect(result.deleted).toBe(true);
    expect(await t.run(async (ctx) => ctx.db.get(setId))).toBeNull();
    expect(
      await t.run(async (ctx) => ({
        skips: (await ctx.db.query("entityReviewSkips").collect()).length,
        statuses: (await ctx.db.query("selectorSyncStatus").collect()).length,
      })),
    ).toEqual({ skips: 0, statuses: 0 });
  });

  test("deletes even when the parent's `children` array does NOT list it (legacy divergence)", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const sportId = await insertRow(t, "sport", "Baseball");
    const doomedId = await insertRow(t, "year", "2024", {
      parentId: sportId,
      isCustom: true,
    });
    // Simulate a parent whose `children` array never listed this row (or has
    // already been edited elsewhere) — insertRow appended it, so force it back
    // out to reproduce the legacy/diverged shape.
    await t.run(async (ctx) => {
      const parent = await ctx.db.get(sportId);
      await ctx.db.patch(sportId, {
        children: (parent!.children ?? []).filter((c) => c !== doomedId),
      });
    });

    const result = await asAdmin.mutation(
      api.selectorOptions.deleteSelectorOption,
      { id: doomedId },
    );

    expect(result.deleted).toBe(true);
    // The write-if-changed guard sees no change and leaves the (already not
    // listing it) array alone rather than erroring on a "remove" that is a
    // no-op.
    const parent = await t.run(async (ctx) => ctx.db.get(sportId));
    expect(parent!.children).toEqual([]);
  });

  test("deletes cleanly when its OWN parentId points at a row that no longer exists", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    // A real parent, deleted out from under the child without going through
    // deleteSelectorOption (e.g. the admin reset tooling), leaving a dangling
    // parentId — the shape collectSelectorOptionHoldings + the parent patch at
    // the end of the mutation must both tolerate.
    const ghostParentId = await insertRow(t, "sport", "Ephemeral", {
      isCustom: true,
    });
    const orphanId = await insertRow(t, "year", "2024", {
      parentId: ghostParentId,
      isCustom: true,
    });
    await t.run(async (ctx) => ctx.db.delete(ghostParentId));

    const result = await asAdmin.mutation(
      api.selectorOptions.deleteSelectorOption,
      { id: orphanId },
    );

    expect(result.deleted).toBe(true);
    expect(result.parentId).toBe(ghostParentId);
    expect(await t.run(async (ctx) => ctx.db.get(orphanId))).toBeNull();
  });

  test("deletes a row whose `children` array names ids with no backing rows (dangling children, no real holdings)", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const sportId = await insertRow(t, "sport", "Baseball");
    const yearId = await insertRow(t, "year", "2024", { parentId: sportId });
    // A child was created and then hard-deleted some other way, leaving its id
    // behind in the parent's `children` array — but `by_parent` (what
    // collectSelectorOptionHoldings actually reads) sees nothing, since no row
    // has parentId===yearId any more.
    const ghostChildId = await insertRow(t, "manufacturer", "Ghost", {
      parentId: yearId,
    });
    await t.run(async (ctx) => ctx.db.delete(ghostChildId));
    const stillListing = await t.run(async (ctx) => ctx.db.get(yearId));
    expect(stillListing!.children).toContain(ghostChildId);

    const holdings = await asAdmin.query(
      api.selectorOptions.getSelectorOptionHoldings,
      { id: yearId },
    );
    expect(holdings).toEqual({ holds: [], protected: false });

    const result = await asAdmin.mutation(
      api.selectorOptions.deleteSelectorOption,
      { id: yearId },
    );
    expect(result.deleted).toBe(true);
  });

  test("a card committed AFTER the holdings read but BEFORE the delete is still caught — the mutation re-checks, never trusts the query", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const setId = await insertRow(t, "setName", "Topps Chrome");
    const rowId = await insertRow(t, "insert", "Future Stars", {
      parentId: setId,
      isCustom: true,
    });

    // The FE's disabled-state read: empty, so the delete affordance is live.
    const holdingsAtOpen = await asAdmin.query(
      api.selectorOptions.getSelectorOptionHoldings,
      { id: rowId },
    );
    expect(holdingsAtOpen).toEqual({ holds: [], protected: false });

    // A checklist commit lands while the confirm dialog is sitting open.
    await insertCard(t, rowId, "1", "Shohei Ohtani");

    const error = await expectRefusal(() =>
      asAdmin.mutation(api.selectorOptions.deleteSelectorOption, {
        id: rowId,
      }),
    );
    expect(error.data.code).toBe("SELECTOR_ROW_NOT_EMPTY");
    expect(holdFor(error.data, "cards")?.count).toBe(1);
    // Nothing written: the row and its new card both survive.
    expect(await t.run(async (ctx) => ctx.db.get(rowId))).not.toBeNull();
  });
});

// ===========================================================================
// Belt-and-braces: the commit chunk fails closed on a deleted row
// (security condition 2)
// ===========================================================================

describe("commitCardChecklistChunk — deleted parent row", () => {
  test("throws SELECTOR_ROW_DELETED and inserts nothing", async () => {
    const t = convexTest(schema, modules);

    const setId = await insertRow(t, "setName", "Topps Chrome", {
      isCustom: true,
    });
    // The delete now refuses while a review is staged, but the commit ACTION
    // spans several transactions, so a chunk can still arrive after the row
    // went away. `resolveCardSlots` degrades to `() => ({})` for a missing row
    // rather than throwing, so without this guard the chunk would insert
    // cards pointing at nothing, with no slot attribution at all.
    await t.run(async (ctx) => {
      await ctx.db.delete(setId);
    });

    let thrown: unknown;
    try {
      await t.run(async (ctx) =>
        ctx.runMutation(internal.selectorOptions.commitCardChecklistChunk, {
          selectorOptionId: setId,
          sportValue: "Baseball",
          cards: [
            {
              cardNumber: "1",
              cardName: "Shohei Ohtani",
              platformData: { bsc: { ref: "bsc-1", setId: "topps-chrome" } },
              sortOrder: 1,
              playerNames: [],
              teamNames: [],
            },
          ],
        }),
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ConvexError);
    expect(
      (thrown as ConvexError<{ code: string }>).data,
    ).toMatchObject({ code: "SELECTOR_ROW_DELETED" });

    expect(
      await t.run(async (ctx) =>
        (await ctx.db.query("cardChecklist").collect()).length,
      ),
    ).toBe(0);
  });

  test("still commits normally while the row exists", async () => {
    const t = convexTest(schema, modules);

    const setId = await insertRow(t, "setName", "Topps Chrome", {
      isCustom: true,
    });

    const result = await t.run(async (ctx) =>
      ctx.runMutation(internal.selectorOptions.commitCardChecklistChunk, {
        selectorOptionId: setId,
        sportValue: "Baseball",
        cards: [
          {
            cardNumber: "1",
            cardName: "Shohei Ohtani",
            platformData: {},
            sortOrder: 1,
            playerNames: [],
            teamNames: [],
          },
        ],
      }),
    );

    expect(result.storedIds).toHaveLength(1);
  });
});
