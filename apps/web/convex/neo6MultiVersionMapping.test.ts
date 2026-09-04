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
 *  - detachPlatformId confirmPrimary override (explicit primary, extras remain)
 *  - detachPlatformId confirmPrimary override (sole implicit primary, side emptied)
 *  - detachPlatformId confirmPrimary does not bypass admin gate
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
/**
 * NEO-137: platformData is a SLOT MAP now. Tests assert on marketplace IDs
 * (what an operator sees) rather than slot keys wherever the slot itself is
 * not the point.
 */
function idsOf(
  map: Record<string, string> | undefined,
): string[] {
  if (!map) return [];
  return Object.entries(map)
    .sort(([a], [b]) => Number(a.slice(1)) - Number(b.slice(1)))
    .map(([, id]) => id);
}

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
      platformData: { bsc: { b0: "bsc-setname-01" }, sportlots: { s0: "sl-setname-01" } },
      platformSlotSeq: { bsc: 1, sportlots: 1 },
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
      platformData: { sportlots: { s0: "primary-id", s1: "extra-id-1", s2: "extra-id-2" } },
      platformSlotSeq: { sportlots: 3 },
      primaryPlatformId: { sportlots: "s0" },
      platformLabels: { sportlots: { s1: "Series 2", s2: "Series 3" } },
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

    // NEO-137: the primary SLOT is reused and its id refreshed. Reusing the
    // key is what keeps this row's cards resolving across a marketplace
    // re-slug — retiring it on a routine re-sync would orphan the checklist.
    expect(row.primaryPlatformId?.sportlots).toBe("s0");
    expect(row.platformData.sportlots?.s0).toBe("primary-id-refreshed");

    // platformData contains refreshed primary + both extras.
    const slIds = idsOf(row.platformData.sportlots);
    expect(slIds).toContain("primary-id-refreshed");
    expect(slIds).toContain("extra-id-1");
    expect(slIds).toContain("extra-id-2");
    expect(slIds[0]).toBe("primary-id-refreshed"); // primary is the lowest slot

    // Extras keep their slots, so their labels survive untouched.
    expect(row.platformLabels?.sportlots?.s1).toBe("Series 2");
    expect(row.platformLabels?.sportlots?.s2).toBe("Series 3");

    // Refreshed primary has no label entry (reconciler produced none here).
    expect(row.platformLabels?.sportlots?.s0).toBeUndefined();
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
    //
    // NEO-211 changed what "removed" has to look like. A side is only unlinked
    // when the caller DECLARES it fetched successfully (`coveredSides`) *and*
    // that side actually returned something — an item carrying no ids at all
    // is indistinguishable from a marketplace outage, and an outage must never
    // strip linkage. So the batch now says "SportLots answered, and here is
    // what it returned", with this row's id conspicuously absent from it.
    // Everything asserted below is the original assertion, unchanged.
    await asAdmin.mutation(api.setReconciliation.storeReconciledOptions, {
      level: "variantType",
      parentId,
      coveredSides: ["sportlots"],
      reconciledItems: [
        {
          value: "Base Set",
          platformData: { sportlots: undefined },
          metadata: undefined,
        },
        {
          // Another set SportLots DID return this run — the evidence that the
          // side came back at all.
          value: "Some Other Set",
          platformData: { sportlots: "sl-still-listed" },
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

    // Two rows now: "Base Set" plus the still-listed set that proves the side
    // came back. "Base Set" itself is never deleted — that is the whole point
    // of NEO-211 — so it is still here to assert against.
    expect(rows).toHaveLength(2);
    const row = rows.find((r) => r.value === "Base Set")!;
    expect(row).toBeTruthy();

    // Primary is gone from primaryPlatformId.
    expect(row.primaryPlatformId?.sportlots).toBeUndefined();

    // Extras still attached, in their original slots.
    const slIds = idsOf(row.platformData.sportlots);
    expect(slIds).toContain("extra-id-1");
    expect(slIds).toContain("extra-id-2");

    // The dropped primary's slot key is RETIRED, not recycled: the counter is
    // never rewound, so a future attach cannot hand s0 to a different set
    // while cards still point at it.
    expect(row.platformData.sportlots?.s0).toBeUndefined();
    expect(row.platformSlotSeq?.sportlots).toBeGreaterThanOrEqual(3);

    // Labels for extras are preserved.
    expect(row.platformLabels?.sportlots?.s1).toBe("Series 2");
    expect(row.platformLabels?.sportlots?.s2).toBe("Series 3");
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
        platformData: { sportlots: { s0: "sl-base-01" } },
      platformSlotSeq: { sportlots: 1 },
        primaryPlatformId: { sportlots: "s0" },
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
    const slIds = idsOf(row!.platformData.sportlots);

    // Original primary is still present.
    expect(slIds).toContain("sl-base-01");
    // New IDs appended.
    expect(slIds).toContain("sl-series2");
    expect(slIds).toContain("sl-series3");

    // Labels written.
    expect(row!.platformLabels?.sportlots?.s1).toBe("Series 2");
    expect(row!.platformLabels?.sportlots?.s2).toBe("Series 3");
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
          platformData: { bsc: { b0: "bsc-01" } },
      platformSlotSeq: { bsc: 1 },
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
        platformData: { bsc: { b0: "bsc-01", b1: "bsc-02" } },
      platformSlotSeq: { bsc: 2 },
        primaryPlatformId: { bsc: "b0" },
        platformLabels: { bsc: { b1: "Gold" } },
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
    const bscIds = idsOf(row!.platformData.bsc);
    // No duplicate.
    expect(bscIds.filter((id) => id === "bsc-02")).toHaveLength(1);
    // Label was overwritten (intentional).
    expect(row!.platformLabels?.bsc?.b1).toBe("Gold Updated");
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
        platformData: { bsc: { b0: "bsc-01" } },
      platformSlotSeq: { bsc: 1 },
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
// setVariantTypePlatformData — the Base Set picker's write path
// ===========================================================================

describe("setVariantTypePlatformData", () => {
  /**
   * REGRESSION (NEO-137): this handler used to spread the incoming WIRE ids
   * straight over `row.platformData`, producing a mixed object like
   * `{ bsc: { b0: "x" }, sportlots: "884412" }` that the schema rejects. The
   * mutation threw, the Base Set picker never closed, and setup.yaml failed
   * with `"Select Base Set" is not visible` — taking the entire E2E lane down
   * with it, since every other flow depends on the seed.
   *
   * There was no unit test on this path, which is why CI found it and the
   * local suite did not.
   */
  test("converts wire marketplace ids into slots and stores the SL display name as the slot label", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const parentId = await insertParent(t);
    const baseId: Id<"selectorOptions"> = await t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "variantType",
        value: "Base",
        platformData: {},
        parentId,
        children: [],
        lastUpdated: Date.now(),
      }),
    );

    await asAdmin.mutation(api.selectorOptions.setVariantTypePlatformData, {
      variantTypeId: baseId,
      platformData: {
        bsc: "2024-topps-chrome-base",
        sportlots: "884412",
        sportlotsDisplay: "2024 Topps Chrome",
      },
    });

    const row = await t.run(async (ctx) => ctx.db.get(baseId));
    // Slot-keyed, NOT a bare id spread over the map.
    expect(row!.platformData.bsc).toEqual({ b0: "2024-topps-chrome-base" });
    expect(row!.platformData.sportlots).toEqual({ s0: "884412" });
    // sportlotsDisplay becomes the SL slot's label — that is what replaced it.
    expect(row!.platformLabels?.sportlots).toEqual({ s0: "2024 Topps Chrome" });
    expect(row!.platformSlotSeq).toEqual({ bsc: 1, sportlots: 1 });
  });

  test("re-picking a different SL set reuses the slot so the row's cards keep resolving", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const parentId = await insertParent(t);
    const baseId: Id<"selectorOptions"> = await t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "variantType",
        value: "Base",
        platformData: { sportlots: { s0: "884412" } },
        platformSlotSeq: { sportlots: 1 },
        primaryPlatformId: { sportlots: "s0" },
        parentId,
        children: [],
        lastUpdated: Date.now(),
      }),
    );

    await asAdmin.mutation(api.selectorOptions.setVariantTypePlatformData, {
      variantTypeId: baseId,
      platformData: { sportlots: "999999", sportlotsDisplay: "Corrected Set" },
    });

    const row = await t.run(async (ctx) => ctx.db.get(baseId));
    // Same slot key, refreshed id — cards pointing at s0 stay valid.
    expect(row!.platformData.sportlots).toEqual({ s0: "999999" });
    expect(row!.platformLabels?.sportlots).toEqual({ s0: "Corrected Set" });
  });

  test("rejects a non-Base variantType", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const parentId = await insertParent(t);
    const insertId: Id<"selectorOptions"> = await t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "variantType",
        value: "Insert",
        platformData: {},
        parentId,
        children: [],
        lastUpdated: Date.now(),
      }),
    );

    await expect(
      asAdmin.mutation(api.selectorOptions.setVariantTypePlatformData, {
        variantTypeId: insertId,
        platformData: { sportlots: "884412" },
      }),
    ).rejects.toThrow(/only operates on Base variantTypes/);
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
      // NEO-137: keyed by SLOT — a marketplace id is no longer a unique
      // handle on a row, so "detach that set" would be ambiguous.
      slot: "s1", // extra-id-1
    });

    expect(result.success).toBe(true);

    const row = await t.run(async (ctx) => ctx.db.get(rowId));
    const slIds = idsOf(row!.platformData.sportlots);

    expect(slIds).not.toContain("extra-id-1");
    expect(slIds).toContain("primary-id"); // primary untouched
    expect(slIds).toContain("extra-id-2"); // other extra untouched

    // Label for the detached id is gone.
    expect(row!.platformLabels?.sportlots?.s1).toBeUndefined();
    // Label for the surviving extra is still there.
    expect(row!.platformLabels?.sportlots?.s2).toBe("Series 3");
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
        slot: "s0", // primary-id
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
        platformData: { bsc: { b0: "bsc-implicit-primary", b1: "bsc-extra" } },
      platformSlotSeq: { bsc: 2 },
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
        slot: "b0", // bsc-implicit-primary
      }),
    ).rejects.toThrow(/Refusing to detach the reconciliation primary/);
  });

  // -------------------------------------------------------------------------
  // confirmPrimary: explicit primaryPlatformId, extras remain
  // -------------------------------------------------------------------------
  test("should detach the explicit primaryPlatformId and clear it when confirmPrimary is true", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const parentId = await insertParent(t);
    const rowId = await insertVariantWithExtras(t, parentId);

    const result = await asAdmin.mutation(api.selectorOptions.detachPlatformId, {
      selectorOptionId: rowId,
      side: "sportlots",
      slot: "s0", // primary-id
      confirmPrimary: true,
    });

    expect(result.success).toBe(true);

    const row = await t.run(async (ctx) => ctx.db.get(rowId));
    const slIds = idsOf(row!.platformData.sportlots);

    // Detached id is gone.
    expect(slIds).not.toContain("primary-id");
    // Remaining extras untouched.
    expect(slIds).toContain("extra-id-1");
    expect(slIds).toContain("extra-id-2");

    // primaryPlatformId for this side is cleared (absent/undefined) so the
    // row falls back to `current[0]` for its new effective primary.
    expect(row!.primaryPlatformId?.sportlots).toBeUndefined();

    // The detached id's label entry (there was none for "primary-id" to
    // begin with, but confirm no stray entry was created) is absent...
    expect(row!.platformLabels?.sportlots?.s0).toBeUndefined();
    // ...and the surviving extra's label is untouched.
    expect(row!.platformLabels?.sportlots?.s1).toBe("Series 2");
    expect(row!.platformLabels?.sportlots?.s2).toBe("Series 3");
  });

  // -------------------------------------------------------------------------
  // confirmPrimary: implicit (array[0]) primary, no extras — side goes empty
  // -------------------------------------------------------------------------
  test("should detach the sole implicit primary and leave the side empty when confirmPrimary is true", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const parentId = await insertParent(t);
    // Seed a row WITHOUT an explicit primaryPlatformId and with only one id
    // on the bsc side — the implicit primary is also the only element.
    const rowId: Id<"selectorOptions"> = await t.run(async (ctx) => {
      return ctx.db.insert("selectorOptions", {
        level: "insert",
        value: "Black Refractor",
        platformData: { bsc: { b0: "bsc-sole-primary" } },
      platformSlotSeq: { bsc: 1 },
        platformLabels: { bsc: { b0: "Sole Primary" } },
        // NOTE: no primaryPlatformId field — array[0] is the implicit primary.
        parentId,
        children: [],
        lastUpdated: Date.now(),
      });
    });

    const result = await asAdmin.mutation(api.selectorOptions.detachPlatformId, {
      selectorOptionId: rowId,
      side: "bsc",
      slot: "b0", // bsc-sole-primary
      confirmPrimary: true,
    });

    expect(result.success).toBe(true);

    const row = await t.run(async (ctx) => ctx.db.get(rowId));

    // The side is now fully empty.
    expect(row!.platformData.bsc).toBeUndefined();
    // No effective primary remains.
    expect(row!.primaryPlatformId?.bsc).toBeUndefined();
    // No dangling label entry for the detached id.
    expect(row!.platformLabels?.bsc?.b0).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // confirmPrimary does not bypass the admin gate
  // -------------------------------------------------------------------------
  test("should throw when non-admin caller passes confirmPrimary: true", async () => {
    const t = convexTest(schema, modules);
    const asUser = t.withIdentity(NON_ADMIN_IDENTITY);

    const parentId = await insertParent(t);
    const rowId = await insertVariantWithExtras(t, parentId);

    await expect(
      asUser.mutation(api.selectorOptions.detachPlatformId, {
        selectorOptionId: rowId,
        side: "sportlots",
        slot: "s0", // primary-id
        confirmPrimary: true,
      }),
    ).rejects.toThrow();
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
        slot: "s1", // extra-id-1
        label: "Series 2 Revised",
      },
    );

    expect(result.success).toBe(true);

    const row = await t.run(async (ctx) => ctx.db.get(rowId));
    expect(row!.platformLabels?.sportlots?.s1).toBe("Series 2 Revised");
    // Other label untouched.
    expect(row!.platformLabels?.sportlots?.s2).toBe("Series 3");
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
        slot: "s1",
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
        slot: "s1",
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
        slot: "s99", // never allocated on this row
        label: "Some Label",
      }),
    ).rejects.toThrow(/Cannot rename label for unattached slot/);
  });
});
