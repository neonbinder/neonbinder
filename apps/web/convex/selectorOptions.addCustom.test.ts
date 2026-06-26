/**
 * Unit tests for `addCustomSelectorOption` (admin-gated mutation).
 *
 * Covers the "select existing rather than mint duplicate" behavior added in NEO-46:
 *  - Synced row (isCustom falsy) matching exact value → returns existing id, no insert
 *  - Synced row matched case/whitespace-insensitively → returns existing id, no insert
 *  - Prior custom row (isCustom=true) matching normalized value → returns existing id,
 *    no duplicate, isCustom still true on the returned row
 *  - No match → inserts new row with isCustom=true, returns new id
 *  - Non-admin caller is rejected by requireAdmin
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { Id } from "./_generated/dataModel";

// convex-test v0.0.53 with Vitest uses import.meta.glob to discover modules.
const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

/** Admin identity that satisfies requireAdmin (role="admin" in JWT). */
const ADMIN_IDENTITY = {
  subject: "admin_user_addcustom_001",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_user_addcustom_001",
  name: "Admin User",
  role: "admin",
};

/** Non-admin identity — used to verify gating. */
const NON_ADMIN_IDENTITY = {
  subject: "normal_user_addcustom_001",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|normal_user_addcustom_001",
  name: "Normal User",
  role: "user",
};

// ---------------------------------------------------------------------------
// Helper: count selectorOptions rows at a given (level, parentId).
// ---------------------------------------------------------------------------
async function countSportRows(
  t: ReturnType<typeof convexTest>,
  parentId?: Id<"selectorOptions">,
): Promise<number> {
  return t.run(async (ctx) => {
    const rows = await ctx.db
      .query("selectorOptions")
      .withIndex("by_level_and_parent", (q) =>
        q.eq("level", "sport").eq("parentId", parentId),
      )
      .collect();
    return rows.length;
  });
}

// ---------------------------------------------------------------------------
// addCustomSelectorOption
// ---------------------------------------------------------------------------

describe("addCustomSelectorOption", () => {
  // -------------------------------------------------------------------------
  // Synced row deduplication (isCustom falsy)
  // -------------------------------------------------------------------------

  test("should return existing synced row id when value matches exactly and insert nothing new", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    // Seed a marketplace-synced sport row (no isCustom field).
    const seededId: Id<"selectorOptions"> = await t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "sport",
        value: "Football",
        platformData: { bsc: "bsc-football", sportlots: "sl-football" },
        children: [],
        lastUpdated: Date.now(),
      }),
    );

    const returnedId = await asAdmin.mutation(
      api.selectorOptions.addCustomSelectorOption,
      { level: "sport", value: "Football" },
    );

    // Must resolve to the existing row.
    expect(returnedId).toBe(seededId);

    // Table must still have exactly one sport row — no duplicate inserted.
    expect(await countSportRows(t)).toBe(1);

    // The row's isCustom must remain falsy — the mutation must NOT convert a
    // synced row to custom.
    const row = await t.run(async (ctx) => ctx.db.get(seededId));
    expect(row?.isCustom).toBeFalsy();
  });

  // -------------------------------------------------------------------------
  // Case and whitespace insensitivity
  // -------------------------------------------------------------------------

  test("should return existing synced row when value differs only in case and surrounding whitespace", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const seededId: Id<"selectorOptions"> = await t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "sport",
        value: "Football",
        platformData: { bsc: "bsc-football" },
        children: [],
        lastUpdated: Date.now(),
      }),
    );

    // Uppercase + leading/trailing spaces should still resolve to the seeded row.
    const returnedId = await asAdmin.mutation(
      api.selectorOptions.addCustomSelectorOption,
      { level: "sport", value: "  football  " },
    );

    expect(returnedId).toBe(seededId);
    expect(await countSportRows(t)).toBe(1);
    const row = await t.run(async (ctx) => ctx.db.get(seededId));
    expect(row?.isCustom).toBeFalsy();
  });

  // -------------------------------------------------------------------------
  // Custom-row idempotency (isCustom=true prior row)
  // -------------------------------------------------------------------------

  test("should return existing custom row id when value matches a prior isCustom=true row", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    // Seed a previously-created custom sport row.
    const priorCustomId: Id<"selectorOptions"> = await t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "sport",
        value: "Lacrosse",
        platformData: {},
        children: [],
        isCustom: true,
        lastUpdated: Date.now(),
      }),
    );

    const returnedId = await asAdmin.mutation(
      api.selectorOptions.addCustomSelectorOption,
      { level: "sport", value: "Lacrosse" },
    );

    // Must resolve to the prior custom row, not a new one.
    expect(returnedId).toBe(priorCustomId);
    expect(await countSportRows(t)).toBe(1);

    // isCustom must remain true.
    const row = await t.run(async (ctx) => ctx.db.get(priorCustomId));
    expect(row?.isCustom).toBe(true);
  });

  test("should return existing custom row when value matches case/whitespace-insensitively", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const priorCustomId: Id<"selectorOptions"> = await t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "sport",
        value: "Lacrosse",
        platformData: {},
        children: [],
        isCustom: true,
        lastUpdated: Date.now(),
      }),
    );

    const returnedId = await asAdmin.mutation(
      api.selectorOptions.addCustomSelectorOption,
      { level: "sport", value: "LACROSSE" },
    );

    expect(returnedId).toBe(priorCustomId);
    expect(await countSportRows(t)).toBe(1);
  });

  // -------------------------------------------------------------------------
  // New value: inserts a fresh isCustom=true row
  // -------------------------------------------------------------------------

  test("should insert a new isCustom=true row and return its id when no match exists", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    // Pre-seed a different sport so we can verify the table count increments.
    await t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "sport",
        value: "Baseball",
        platformData: { bsc: "bsc-baseball" },
        children: [],
        lastUpdated: Date.now(),
      }),
    );

    expect(await countSportRows(t)).toBe(1);

    const newId = await asAdmin.mutation(
      api.selectorOptions.addCustomSelectorOption,
      { level: "sport", value: "Pickleball" },
    );

    expect(newId).toBeDefined();
    expect(await countSportRows(t)).toBe(2);

    const newRow = await t.run(async (ctx) => ctx.db.get(newId));
    expect(newRow).not.toBeNull();
    expect(newRow?.value).toBe("Pickleball");
    expect(newRow?.isCustom).toBe(true);
    expect(newRow?.level).toBe("sport");
  });

  // -------------------------------------------------------------------------
  // Admin gating: non-admin caller must be rejected
  // -------------------------------------------------------------------------

  test("should throw when caller does not have admin role", async () => {
    const t = convexTest(schema, modules);
    const asUser = t.withIdentity(NON_ADMIN_IDENTITY);

    await expect(
      asUser.mutation(api.selectorOptions.addCustomSelectorOption, {
        level: "sport",
        value: "Hockey",
      }),
    ).rejects.toThrow();
  });
});
