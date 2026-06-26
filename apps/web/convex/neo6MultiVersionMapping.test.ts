/**
 * Unit tests for NEO-6 phase 1: multi-version set mapping.
 *
 * Covers:
 *  - storeReconciledOptions refresh-without-clobber
 *  - storeReconciledOptions primary-absent reconciliation (extras survive)
 *  - storeReconciledOptions deletion guard (extras row not deleted)
 *  - attachPlatformIds happy path
 *  - attachPlatformIds rejects non-variant levels
 *  - attachPlatformIds idempotence
 *  - attachPlatformIds admin-gating
 *  - detachPlatformId happy path
 *  - detachPlatformId primary-protected (explicit primaryPlatformId)
 *  - detachPlatformId primary-protected (implicit first-element fallback)
 *  - renamePlatformLabel happy path
 *  - renamePlatformLabel rejects empty/whitespace label
 *  - renamePlatformLabel rejects unattached id
 */

import { convexTest } from "convex-test";
import { expect, test, describe } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { Id } from "./_generated/dataModel";

// convex-test v0.0.53 with Vitest uses import.meta.glob to discover modules.
// Pass them explicitly so tests run correctly in edge-runtime environment.
// (Vite's import.meta.glob type isn't in the convex tsconfig — cast through
//  unknown to keep the build clean without leaking a global type augment.)
const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

/** Admin identity that satisfies requireAdmin (role="admin" in JWT). */
const ADMIN_IDENTITY = {
  subject: "admin_user_001",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_user_001",
  name: "Admin User",
  // Convex-auth reads `role` from the JWT claim set.
  role: "admin",
};

/** Non-admin identity — used to verify gating. */
const NON_ADMIN_IDENTITY = {
  subject: "normal_user_001",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|normal_user_001",
  name: "Normal User",
  role: "user",
};

// ---------------------------------------------------------------------------
// Helper: seed a bare parent selectorOption so parentId references are valid.
// ---------------------------------------------------------------------------
async function insertParent(
  t: ReturnType<typeof convexTest>,
  override?: Partial<{
    level: "sport" | "year" | "manufacturer" | "setName";
    value: string;
  }>,
): Promise<Id<"selectorOptions">> {
  return t.run(async (ctx) => {
    return await ctx.db.insert("selectorOptions", {
      level: override?.level ?? "setName",
      value: override?.value ?? "2022 Topps",
      platformData: { bsc: "bsc-setname-01", sportlots: "sl-setname-01" },
      children: [],
      lastUpdated: Date.now(),
    });
  });
}

// ---------------------------------------------------------------------------
// Helper: seed a variantType row with operator extras pre-attached.
// Returns the inserted row's _id.
// ---------------------------------------------------------------------------
async function insertVariantWithExtras(
  t: ReturnType<typeof convexTest>,
  parentId: Id<"selectorOptions">,
): Promise<Id<"selectorOptions">> {
  return t.run(async (ctx) => {
    return await ctx.db.insert("selectorOptions", {
      level: "variantType",
      value: "Base Set",
      platformData: {
        sportlots: ["primary-id", "extra-id-1", "extra-id-2"],
      },
      primaryPlatformId: { sportlots: "primary-id" },
      platformLabels: {
        sportlots: {
          "extra-id-1": "Series 2",
          "extra-id-2": "Series 3",
        },
      },
      parentId,
      children: [],
      lastUpdated: Date.now(),
    });
  });
}

// ===========================================================================
// storeReconciledOptions
// ===========================================================================

describe("storeReconciledOptions", () => {
  // -------------------------------------------------------------------------
  // refresh-without-clobber: primary refreshed, extras survive
  // -------------------------------------------------------------------------
  test("should preserve extras and refresh primary when reconciler provides updated primary id", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const parentId = await insertParent(t);
    await insertVariantWithExtras(t, parentId);

    // Reconciler now reports a refreshed primary ID for the same value.
    await asAdmin.mutation(api.setReconciliation.storeReconciledOptions, {
      level: "variantType",
      parentId,
      reconciledItems: [
        {
          value: "Base Set",
          platformData: { sportlots: "primary-id-refreshed" },
          metadata: undefined,
        },
      ],
    });

    const rows = await t.run(async (ctx) => {
      return await ctx.db
        .query("selectorOptions")
        .withIndex("by_level_and_parent", (q) =>
          q.eq("level", "variantType").eq("parentId", parentId),
        )
        .collect();
    });

    expect(rows).toHaveLength(1);
    const row = rows[0];

    // Primary slot is refreshed to the new ID.
    expect(row.primaryPlatformId?.sportlots).toBe("primary-id-refreshed");

    // platformData contains refreshed primary + both extras.
    const slIds = row.platformData.sportlots as string[];
    expect(slIds).toContain("primary-id-refreshed");
    expect(slIds).toContain("extra-id-1");
    expect(slIds).toContain("extra-id-2");
    expect(slIds[0]).toBe("primary-id-refreshed"); // primary is first

    // Extra labels are preserved.
    expect(row.platformLabels?.sportlots?.["extra-id-1"]).toBe("Series 2");
    expect(row.platformLabels?.sportlots?.["extra-id-2"]).toBe("Series 3");

    // Refreshed primary has no label entry (reconciler does not produce labels).
    expect(row.platformLabels?.sportlots?.["primary-id-refreshed"]).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // primary absent: reconciler sends undefined — extras survive, primary dropped
  // -------------------------------------------------------------------------
  test("should keep extras but drop primaryPlatformId when reconciler removes the primary", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const parentId = await insertParent(t);
    await insertVariantWithExtras(t, parentId);

    // Reconciler sends the same value but with no sportlots ID (removed).
    await asAdmin.mutation(api.setReconciliation.storeReconciledOptions, {
      level: "variantType",
      parentId,
      reconciledItems: [
        {
          value: "Base Set",
          platformData: { sportlots: undefined },
          metadata: undefined,
        },
      ],
    });

    const rows = await t.run(async (ctx) => {
      return await ctx.db
        .query("selectorOptions")
        .withIndex("by_level_and_parent", (q) =>
          q.eq("level", "variantType").eq("parentId", parentId),
        )
        .collect();
    });

    expect(rows).toHaveLength(1);
    const row = rows[0];

    // Primary is gone from primaryPlatformId.
    expect(row.primaryPlatformId?.sportlots).toBeUndefined();

    // Extras still attached.
    const slIds = Array.isArray(row.platformData.sportlots)
      ? row.platformData.sportlots
      : row.platformData.sportlots
        ? [row.platformData.sportlots]
        : [];
    expect(slIds).toContain("extra-id-1");
    expect(slIds).toContain("extra-id-2");

    // Labels for extras are preserved.
    expect(row.platformLabels?.sportlots?.["extra-id-1"]).toBe("Series 2");
    expect(row.platformLabels?.sportlots?.["extra-id-2"]).toBe("Series 3");
  });

  // -------------------------------------------------------------------------
  // deletion guard: extras row NOT in reconciledItems must survive
  // -------------------------------------------------------------------------
  test("should not delete an extras row that is absent from reconciledItems and should keep it in parent children", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const parentId = await insertParent(t);
    const extrasRowId = await insertVariantWithExtras(t, parentId);

    // Reconcile a DIFFERENT value — processedValues will NOT include "base set".
    await asAdmin.mutation(api.setReconciliation.storeReconciledOptions, {
      level: "variantType",
      parentId,
      reconciledItems: [
        {
          value: "Chrome Set",
          platformData: { sportlots: "sl-chrome-01" },
          metadata: undefined,
        },
      ],
    });

    // Extras row must still exist.
    const extrasRow = await t.run(async (ctx) => ctx.db.get(extrasRowId));
    expect(extrasRow).not.toBeNull();
    expect(extrasRow!.value).toBe("Base Set");

    // Extras row must be in the parent's children array.
    const parent = await t.run(async (ctx) => ctx.db.get(parentId));
    expect(parent!.children).toContain(extrasRowId);
  });
});

// ===========================================================================
// attachPlatformIds
// ===========================================================================

describe("attachPlatformIds", () => {
  // -------------------------------------------------------------------------
  // happy path
  // -------------------------------------------------------------------------
  test("should attach new SL ids with labels to a variantType row", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const parentId = await insertParent(t);
    // Seed a simple variantType row with a single primary and no extras.
    const rowId: Id<"selectorOptions"> = await t.run(async (ctx) => {
      return ctx.db.insert("selectorOptions", {
        level: "variantType",
        value: "Base",
        platformData: { sportlots: "sl-base-01" },
        primaryPlatformId: { sportlots: "sl-base-01" },
        parentId,
        children: [],
        lastUpdated: Date.now(),
      });
    });

    const result = await asAdmin.mutation(
      api.selectorOptions.attachPlatformIds,
      {
        selectorOptionId: rowId,
        additions: {
          sportlots: [
            { id: "sl-series2", label: "Series 2" },
            { id: "sl-series3", label: "Series 3" },
          ],
        },
      },
    );

    expect(result.success).toBe(true);
    expect(result.attachedCount).toBe(2);

    const row = await t.run(async (ctx) => ctx.db.get(rowId));
    const slIds = Array.isArray(row!.platformData.sportlots)
      ? row!.platformData.sportlots
      : [row!.platformData.sportlots];

    // Original primary is still present.
    expect(slIds).toContain("sl-base-01");
    // New IDs appended.
    expect(slIds).toContain("sl-series2");
    expect(slIds).toContain("sl-series3");

    // Labels written.
    expect(row!.platformLabels?.sportlots?.["sl-series2"]).toBe("Series 2");
    expect(row!.platformLabels?.sportlots?.["sl-series3"]).toBe("Series 3");
  });

  // -------------------------------------------------------------------------
  // rejects non-variant levels
  // -------------------------------------------------------------------------
  test.each([
    ["sport", "Football"],
    ["year", "2022"],
    ["manufacturer", "Topps"],
    ["setName", "Chrome"],
  ] as const)(
    "should reject attachPlatformIds on level=%s",
    async (level, value) => {
      const t = convexTest(schema, modules);
      const asAdmin = t.withIdentity(ADMIN_IDENTITY);

      const rowId: Id<"selectorOptions"> = await t.run(async (ctx) => {
        return ctx.db.insert("selectorOptions", {
          level,
          value,
          platformData: { bsc: "bsc-01" },
          children: [],
          lastUpdated: Date.now(),
        });
      });

      await expect(
        asAdmin.mutation(api.selectorOptions.attachPlatformIds, {
          selectorOptionId: rowId,
          additions: { bsc: [{ id: "bsc-new", label: "Label" }] },
        }),
      ).rejects.toThrow(/variantType\/insert\/parallel/);
    },
  );

  // -------------------------------------------------------------------------
  // idempotence: re-attaching an existing id returns attachedCount=0
  // -------------------------------------------------------------------------
  test("should return attachedCount=0 and not duplicate when id already attached", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const parentId = await insertParent(t);
    const rowId: Id<"selectorOptions"> = await t.run(async (ctx) => {
      return ctx.db.insert("selectorOptions", {
        level: "variantType",
        value: "Base",
        platformData: { bsc: ["bsc-01", "bsc-02"] },
        primaryPlatformId: { bsc: "bsc-01" },
        platformLabels: { bsc: { "bsc-02": "Gold" } },
        parentId,
        children: [],
        lastUpdated: Date.now(),
      });
    });

    const result = await asAdmin.mutation(
      api.selectorOptions.attachPlatformIds,
      {
        selectorOptionId: rowId,
        additions: {
          bsc: [{ id: "bsc-02", label: "Gold Updated" }],
        },
      },
    );

    expect(result.attachedCount).toBe(0);

    const row = await t.run(async (ctx) => ctx.db.get(rowId));
    const bscIds = Array.isArray(row!.platformData.bsc)
      ? row!.platformData.bsc
      : [row!.platformData.bsc];
    // No duplicate.
    expect(bscIds.filter((id) => id === "bsc-02")).toHaveLength(1);
    // Label was overwritten (intentional).
    expect(row!.platformLabels?.bsc?.["bsc-02"]).toBe("Gold Updated");
  });

  // -------------------------------------------------------------------------
  // admin-gating: non-admin caller is rejected
  // -------------------------------------------------------------------------
  test("should throw when caller does not have admin role", async () => {
    const t = convexTest(schema, modules);
    const asUser = t.withIdentity(NON_ADMIN_IDENTITY);

    const parentId = await insertParent(t);
    const rowId: Id<"selectorOptions"> = await t.run(async (ctx) => {
      return ctx.db.insert("selectorOptions", {
        level: "variantType",
        value: "Base",
        platformData: { bsc: "bsc-01" },
        parentId,
        children: [],
        lastUpdated: Date.now(),
      });
    });

    await expect(
      asUser.mutation(api.selectorOptions.attachPlatformIds, {
        selectorOptionId: rowId,
        additions: { bsc: [{ id: "bsc-new", label: "Label" }] },
      }),
    ).rejects.toThrow();
  });
});

// ===========================================================================
// detachPlatformId
// ===========================================================================

describe("detachPlatformId", () => {
  // -------------------------------------------------------------------------
  // happy path
  // -------------------------------------------------------------------------
  test("should remove an extra id and its label from the row", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const parentId = await insertParent(t);
    const rowId = await insertVariantWithExtras(t, parentId);

    const result = await asAdmin.mutation(api.selectorOptions.detachPlatformId, {
      selectorOptionId: rowId,
      side: "sportlots",
      id: "extra-id-1",
    });

    expect(result.success).toBe(true);

    const row = await t.run(async (ctx) => ctx.db.get(rowId));
    const slIds = Array.isArray(row!.platformData.sportlots)
      ? row!.platformData.sportlots
      : row!.platformData.sportlots
        ? [row!.platformData.sportlots]
        : [];

    expect(slIds).not.toContain("extra-id-1");
    expect(slIds).toContain("primary-id"); // primary untouched
    expect(slIds).toContain("extra-id-2"); // other extra untouched

    // Label for the detached id is gone.
    expect(row!.platformLabels?.sportlots?.["extra-id-1"]).toBeUndefined();
    // Label for the surviving extra is still there.
    expect(row!.platformLabels?.sportlots?.["extra-id-2"]).toBe("Series 3");
  });

  // -------------------------------------------------------------------------
  // primary-protected: explicit primaryPlatformId
  // -------------------------------------------------------------------------
  test("should throw when trying to detach the explicit primaryPlatformId value", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const parentId = await insertParent(t);
    const rowId = await insertVariantWithExtras(t, parentId);

    await expect(
      asAdmin.mutation(api.selectorOptions.detachPlatformId, {
        selectorOptionId: rowId,
        side: "sportlots",
        id: "primary-id",
      }),
    ).rejects.toThrow(/Refusing to detach the reconciliation primary/);
  });

  // -------------------------------------------------------------------------
  // primary-protected: implicit first-element fallback when primaryPlatformId unset
  // -------------------------------------------------------------------------
  test("should throw when trying to detach the first element when primaryPlatformId is absent", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const parentId = await insertParent(t);
    // Seed a row WITHOUT an explicit primaryPlatformId — first element is implicit primary.
    const rowId: Id<"selectorOptions"> = await t.run(async (ctx) => {
      return ctx.db.insert("selectorOptions", {
        level: "insert",
        value: "Black Refractor",
        platformData: { bsc: ["bsc-implicit-primary", "bsc-extra"] },
        // NOTE: no primaryPlatformId field
        parentId,
        children: [],
        lastUpdated: Date.now(),
      });
    });

    await expect(
      asAdmin.mutation(api.selectorOptions.detachPlatformId, {
        selectorOptionId: rowId,
        side: "bsc",
        id: "bsc-implicit-primary",
      }),
    ).rejects.toThrow(/Refusing to detach the reconciliation primary/);
  });
});

// ===========================================================================
// renamePlatformLabel
// ===========================================================================

describe("renamePlatformLabel", () => {
  // -------------------------------------------------------------------------
  // happy path
  // -------------------------------------------------------------------------
  test("should update the label for an attached extra id", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const parentId = await insertParent(t);
    const rowId = await insertVariantWithExtras(t, parentId);

    const result = await asAdmin.mutation(
      api.selectorOptions.renamePlatformLabel,
      {
        selectorOptionId: rowId,
        side: "sportlots",
        id: "extra-id-1",
        label: "Series 2 Revised",
      },
    );

    expect(result.success).toBe(true);

    const row = await t.run(async (ctx) => ctx.db.get(rowId));
    expect(row!.platformLabels?.sportlots?.["extra-id-1"]).toBe("Series 2 Revised");
    // Other label untouched.
    expect(row!.platformLabels?.sportlots?.["extra-id-2"]).toBe("Series 3");
  });

  // -------------------------------------------------------------------------
  // rejects empty label
  // -------------------------------------------------------------------------
  test("should throw when label is empty string", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const parentId = await insertParent(t);
    const rowId = await insertVariantWithExtras(t, parentId);

    await expect(
      asAdmin.mutation(api.selectorOptions.renamePlatformLabel, {
        selectorOptionId: rowId,
        side: "sportlots",
        id: "extra-id-1",
        label: "",
      }),
    ).rejects.toThrow(/Label cannot be empty/);
  });

  // -------------------------------------------------------------------------
  // rejects whitespace-only label
  // -------------------------------------------------------------------------
  test("should throw when label is whitespace only", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const parentId = await insertParent(t);
    const rowId = await insertVariantWithExtras(t, parentId);

    await expect(
      asAdmin.mutation(api.selectorOptions.renamePlatformLabel, {
        selectorOptionId: rowId,
        side: "sportlots",
        id: "extra-id-1",
        label: "   ",
      }),
    ).rejects.toThrow(/Label cannot be empty/);
  });

  // -------------------------------------------------------------------------
  // rejects unattached id
  // -------------------------------------------------------------------------
  test("should throw when renaming a label for an id that is not attached", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const parentId = await insertParent(t);
    const rowId = await insertVariantWithExtras(t, parentId);

    await expect(
      asAdmin.mutation(api.selectorOptions.renamePlatformLabel, {
        selectorOptionId: rowId,
        side: "sportlots",
        id: "not-attached-id",
        label: "Some Label",
      }),
    ).rejects.toThrow(/Cannot rename label for unattached id/);
  });
});
