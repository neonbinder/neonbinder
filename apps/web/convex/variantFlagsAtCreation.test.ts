/**
 * NEO-291 / NEO-334 — the kind of a row at creation and re-sync.
 *
 * A variant type's TITLE is its kind (NEO-334), so a row created beneath one
 * is born with the `features.cardType` that title implies and no role flag
 * in `metadata` (the retired `isInsert` / `isParallel` left the schema in
 * NEO-334). `writeOnceFeatureSnapshots.test.ts`
 * pins the fresh-insert derivation through `storeReconciledOptions`. This file
 * covers the ground that is unique to the doors:
 *
 *   - `addCustomSelectorOption` derives the same way `storeReconciledOptions`
 *     does, and writes no flag.
 *   - a `parallel`-level row is always a Parallel, whatever its (insert-level)
 *     parent is.
 *   - a client that still sends `metadata.isInsert` to
 *     `storeReconciledOptions` is rejected at the validator, not merged.
 *   - a MATCHED row (one that already existed) is given no flag by a later
 *     sync, and the metadata it already carries is left exactly as found, in
 *     both `storeSelectorOptions` and `storeReconciledOptions`.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";

const modules = (
  import.meta as unknown as {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("./**/*.*s");

const ADMIN_IDENTITY = {
  subject: "admin_user_vfac_001",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_user_vfac_001",
  name: "Admin User",
  role: "admin",
};

const SENTINEL = 1_000_000;

/**
 * A variantType row titled "Inserts" or "Parallels" (its kind), with the
 * `variant`-tagged BSC slot a real variantType sync writes beside it.
 */
async function insertVariantType(
  t: ReturnType<typeof convexTest>,
  parentId: Id<"selectorOptions">,
  role: "insert" | "parallel",
): Promise<Id<"selectorOptions">> {
  return t.run(async (ctx) =>
    ctx.db.insert("selectorOptions", {
      level: "variantType",
      value: role === "insert" ? "Inserts" : "Parallels",
      parentId,
      children: [],
      platformData: { bsc: { b0: role } },
      platformFacets: { bsc: { b0: "variant" } },
      lastUpdated: SENTINEL,
    }),
  );
}

async function insertSetName(
  t: ReturnType<typeof convexTest>,
): Promise<Id<"selectorOptions">> {
  return t.run(async (ctx) =>
    ctx.db.insert("selectorOptions", {
      level: "setName",
      value: "2024 Topps",
      platformData: {},
      children: [],
      lastUpdated: SENTINEL,
    }),
  );
}

async function getRow(t: ReturnType<typeof convexTest>, id: Id<"selectorOptions">) {
  return t.run(async (ctx) => ctx.db.get(id));
}

// ===========================================================================
// addCustomSelectorOption — same derivation as the marketplace paths
// ===========================================================================

describe("addCustomSelectorOption — kind from the parent's title (NEO-334)", () => {
  test("an insert-level row added under a type titled Inserts gets cardType Insert and no flag", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const setNameId = await insertSetName(t);
    const variantTypeId = await insertVariantType(t, setNameId, "insert");

    const insertId = await asAdmin.mutation(
      api.selectorOptions.addCustomSelectorOption,
      { level: "insert", value: "Chrome Update", parentId: variantTypeId },
    );

    const row = await getRow(t, insertId);
    expect(row?.metadata).toBeUndefined();
    expect(row?.features?.cardType).toBe("Insert");
  });

  test("an insert-level row added under a type titled Parallels gets cardType Parallel and no flag", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const setNameId = await insertSetName(t);
    const variantTypeId = await insertVariantType(t, setNameId, "parallel");

    const insertId = await asAdmin.mutation(
      api.selectorOptions.addCustomSelectorOption,
      { level: "insert", value: "Gold Refractor", parentId: variantTypeId },
    );

    const row = await getRow(t, insertId);
    expect(row?.metadata).toBeUndefined();
    expect(row?.features?.cardType).toBe("Parallel");
  });

  test("a parallel-level row is always cardType Parallel, whatever its (insert-level) parent is", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const setNameId = await insertSetName(t);
    // The parent of a `parallel`-level row is an INSERT row, not a variant
    // type — an insert row carries no `variant`-tagged slot of its own, so
    // this also proves the parallel-level branch never consults it.
    const variantTypeId = await insertVariantType(t, setNameId, "insert");
    const insertId = await asAdmin.mutation(
      api.selectorOptions.addCustomSelectorOption,
      { level: "insert", value: "Chrome Update", parentId: variantTypeId },
    );

    const parallelId = await asAdmin.mutation(
      api.selectorOptions.addCustomSelectorOption,
      { level: "parallel", value: "Gold /99", parentId: insertId },
    );

    const row = await getRow(t, parallelId);
    expect(row?.metadata).toBeUndefined();
    expect(row?.features?.cardType).toBe("Parallel");
  });

  test("an insert-level row added under a type with no kind gets no flag and no Insert/Parallel derivation", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const setNameId = await insertSetName(t);
    const variantTypeId = await t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "variantType",
        value: "Mystery",
        parentId: setNameId,
        platformData: {},
        children: [],
        lastUpdated: SENTINEL,
      }),
    );

    const insertId = await asAdmin.mutation(
      api.selectorOptions.addCustomSelectorOption,
      { level: "insert", value: "Something", parentId: variantTypeId },
    );

    const row = await getRow(t, insertId);
    expect(row?.metadata).toBeUndefined();
  });
});

// ===========================================================================
// storeReconciledOptions — client-sent role flags are refused, not merged
// ===========================================================================

describe("storeReconciledOptions — the modal cannot send a role (NEO-291)", () => {
  test("metadata.isInsert on the wire is rejected by the validator", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const setNameId = await insertSetName(t);
    const variantTypeId = await insertVariantType(t, setNameId, "insert");

    await expect(
      asAdmin.mutation(api.setReconciliation.storeReconciledOptions, {
        level: "insert",
        parentId: variantTypeId,
        reconciledItems: [
          {
            value: "Chrome Update",
            platformData: { bsc: "bsc-insert-1" },
            // @ts-expect-error — exactly the rejected shape: a bundle built
            // before this ticket still sending the old checkbox field.
            metadata: { isInsert: true },
          },
        ],
      }),
    ).rejects.toThrow();
  });
});

// ===========================================================================
// Matched rows — adds-only, never a flip
// ===========================================================================

describe("storeSelectorOptions — matched row, no flag written (NEO-334)", () => {
  test("a matched row carrying no flag is given none", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const setNameId = await insertSetName(t);
    const variantTypeId = await insertVariantType(t, setNameId, "insert");
    const insertId = await t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "insert",
        value: "Chrome Update",
        parentId: variantTypeId,
        children: [],
        platformData: { bsc: { b0: "bsc-insert-1" } },
        platformSlotSeq: { bsc: 1 },
        lastUpdated: SENTINEL,
      }),
    );

    await asAdmin.mutation(api.selectorOptions.storeSelectorOptions, {
      level: "insert",
      parentId: variantTypeId,
      options: [{ value: "Chrome Update", platformData: { bsc: "bsc-insert-1" } }],
    });

    const row = await getRow(t, insertId);
    expect(row?.metadata).toBeUndefined();
  });

  test("a matched row's own metadata is left as found, whatever the parent's title says", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const setNameId = await insertSetName(t);
    // The parent's title says Parallels. A re-sync adds no role beside the
    // prefix the row already carries.
    const variantTypeId = await insertVariantType(t, setNameId, "parallel");
    const insertId = await t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "insert",
        value: "Chrome Update",
        parentId: variantTypeId,
        children: [],
        metadata: { cardNumberPrefix: "CU-" },
        platformData: { bsc: { b0: "bsc-insert-1" } },
        platformSlotSeq: { bsc: 1 },
        lastUpdated: SENTINEL,
      }),
    );

    await asAdmin.mutation(api.selectorOptions.storeSelectorOptions, {
      level: "insert",
      parentId: variantTypeId,
      options: [{ value: "Chrome Update", platformData: { bsc: "bsc-insert-1" } }],
    });

    const row = await getRow(t, insertId);
    expect(row?.metadata).toEqual({ cardNumberPrefix: "CU-" });
  });
});

describe("storeReconciledOptions — matched row, no flag written (NEO-334)", () => {
  test("a matched row carrying no flag is given none", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const setNameId = await insertSetName(t);
    const variantTypeId = await insertVariantType(t, setNameId, "parallel");
    const insertId = await t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "insert",
        value: "Gold Refractor",
        parentId: variantTypeId,
        children: [],
        platformData: { bsc: { b0: "bsc-parallel-1" } },
        platformSlotSeq: { bsc: 1 },
        lastUpdated: SENTINEL,
      }),
    );

    await asAdmin.mutation(api.setReconciliation.storeReconciledOptions, {
      level: "insert",
      parentId: variantTypeId,
      reconciledItems: [
        { value: "Gold Refractor", platformData: { bsc: "bsc-parallel-1" } },
      ],
    });

    const row = await getRow(t, insertId);
    expect(row?.metadata).toBeUndefined();
  });

  test("a matched row's own metadata is left as found, whatever the parent's title says", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const setNameId = await insertSetName(t);
    const variantTypeId = await insertVariantType(t, setNameId, "insert");
    const insertId = await t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "insert",
        value: "Gold Refractor",
        parentId: variantTypeId,
        children: [],
        metadata: { cardNumberPrefix: "GR-" },
        platformData: { bsc: { b0: "bsc-parallel-1" } },
        platformSlotSeq: { bsc: 1 },
        lastUpdated: SENTINEL,
      }),
    );

    await asAdmin.mutation(api.setReconciliation.storeReconciledOptions, {
      level: "insert",
      parentId: variantTypeId,
      reconciledItems: [
        { value: "Gold Refractor", platformData: { bsc: "bsc-parallel-1" } },
      ],
    });

    const row = await getRow(t, insertId);
    expect(row?.metadata).toEqual({ cardNumberPrefix: "GR-" });
  });
});

// ===========================================================================
// storeReconciledOptions — the shared cardNumberPrefix rule applies here too
// ===========================================================================

describe("storeReconciledOptions — cardNumberPrefix goes through the shared rule (NEO-291)", () => {
  test("an invalid prefix on a fresh insert is refused, not silently trimmed", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const setNameId = await insertSetName(t);
    const variantTypeId = await insertVariantType(t, setNameId, "insert");

    await expect(
      asAdmin.mutation(api.setReconciliation.storeReconciledOptions, {
        level: "insert",
        parentId: variantTypeId,
        reconciledItems: [
          {
            value: "Chrome Update",
            platformData: { bsc: "bsc-insert-1" },
            metadata: { cardNumberPrefix: "DK-\n1" },
          },
        ],
      }),
    ).rejects.toThrow(/line breaks or control characters/);
  });

  test("an invalid prefix on a re-linked (matched) row is refused too", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const setNameId = await insertSetName(t);
    const variantTypeId = await insertVariantType(t, setNameId, "insert");
    await t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "insert",
        value: "Chrome Update",
        parentId: variantTypeId,
        children: [],
        platformData: { bsc: { b0: "bsc-insert-1" } },
        platformSlotSeq: { bsc: 1 },
        lastUpdated: SENTINEL,
      }),
    );

    await expect(
      asAdmin.mutation(api.setReconciliation.storeReconciledOptions, {
        level: "insert",
        parentId: variantTypeId,
        reconciledItems: [
          {
            value: "Chrome Update",
            platformData: { bsc: "bsc-insert-1" },
            metadata: { cardNumberPrefix: "DK-\n1" },
          },
        ],
      }),
    ).rejects.toThrow(/line breaks or control characters/);
  });
});
