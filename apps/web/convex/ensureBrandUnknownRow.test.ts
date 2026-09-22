/**
 * NEO-237 (D5) — `ensureBrandUnknownRow`: the internal mutation that mints or
 * adopts the year's "Unknown" manufacturer row, found by its ROLE
 * (`metadata.isBrandUnknown`) and never by name.
 *
 * Companion to `brandRehome.test.ts` (the pure move) and
 * `fetchAggregatedOptions.allBrandsRouting.test.ts` (the real caller). This
 * file drives the mutation directly so the transactional shape — flag set in
 * the SAME insert, features copied minus `manufacturer`, the SL slot attached
 * only when the row holds none, and the never-rename / clash-throws rules —
 * is pinned independent of the fetch plumbing above it.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";

const modules = (
  import.meta as unknown as {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("./**/*.*s");

const SENTINEL = 1_000_000;

async function seedYear(
  t: ReturnType<typeof convexTest>,
  features: Record<string, string> = { sport: "Hockey" },
) {
  return t.run(async (ctx) =>
    ctx.db.insert("selectorOptions", {
      level: "year",
      value: "1997",
      platformData: {},
      features,
      children: [],
      lastUpdated: SENTINEL,
    }),
  );
}

async function seedManufacturer(
  t: ReturnType<typeof convexTest>,
  parentId: Id<"selectorOptions">,
  value: string,
  over: Record<string, unknown> = {},
) {
  return t.run(async (ctx) =>
    ctx.db.insert("selectorOptions", {
      level: "manufacturer",
      value,
      platformData: {},
      parentId,
      children: [],
      lastUpdated: SENTINEL,
      ...over,
    }),
  );
}

describe("ensureBrandUnknownRow — minting", () => {
  test("mints a row named Unknown with the flag set in the same insert", async () => {
    const t = convexTest(schema, modules);
    const yearId = await seedYear(t);

    const result = await t.mutation(
      internal.selectorOptions.ensureBrandUnknownRow,
      { yearId },
    );
    expect(result.created).toBe(true);

    const row = await t.run(async (ctx) => ctx.db.get(result.id));
    expect(row?.value).toBe("Unknown");
    expect(row?.metadata?.isBrandUnknown).toBe(true);
    expect(row?.level).toBe("manufacturer");
    expect(row?.parentId).toBe(yearId);
  });

  test("the year's children cache is unioned with the new row", async () => {
    const t = convexTest(schema, modules);
    const yearId = await seedYear(t);

    const result = await t.mutation(
      internal.selectorOptions.ensureBrandUnknownRow,
      { yearId },
    );

    const year = await t.run(async (ctx) => ctx.db.get(yearId));
    expect(year?.children).toContain(result.id);
  });

  test("year features are copied onto the row MINUS manufacturer", async () => {
    const t = convexTest(schema, modules);
    const yearId = await seedYear(t, { sport: "Hockey", manufacturer: "Topps" });

    const result = await t.mutation(
      internal.selectorOptions.ensureBrandUnknownRow,
      { yearId },
    );

    const row = await t.run(async (ctx) => ctx.db.get(result.id));
    expect(row?.features?.sport).toBe("Hockey");
    expect(row?.features && "manufacturer" in row.features).toBe(false);
  });

  test("attaches the SportLots id passed in when minting", async () => {
    const t = convexTest(schema, modules);
    const yearId = await seedYear(t);

    const result = await t.mutation(
      internal.selectorOptions.ensureBrandUnknownRow,
      { yearId, sl: { id: "All Brands", label: "All Brands" } },
    );

    const row = await t.run(async (ctx) => ctx.db.get(result.id));
    expect(row?.platformData.sportlots?.["s0"]).toBe("All Brands");
  });

  test("throws when a sibling is already named Unknown but is not the flagged row", async () => {
    const t = convexTest(schema, modules);
    const yearId = await seedYear(t);
    await seedManufacturer(t, yearId, "Unknown"); // operator's own row, unflagged

    await expect(
      t.mutation(internal.selectorOptions.ensureBrandUnknownRow, { yearId }),
    ).rejects.toThrow(/already.*called "Unknown"/i);
  });

  test("refuses when the parent is not a year row", async () => {
    const t = convexTest(schema, modules);
    const yearId = await seedYear(t);
    const brandId = await seedManufacturer(t, yearId, "Topps");

    await expect(
      t.mutation(internal.selectorOptions.ensureBrandUnknownRow, {
        yearId: brandId,
      }),
    ).rejects.toThrow(/not a year row/i);
  });
});

describe("ensureBrandUnknownRow — adoption (idempotent, find by flag)", () => {
  test("a second call finds the existing flagged row by its role, not its name — and patches nothing", async () => {
    const t = convexTest(schema, modules);
    const yearId = await seedYear(t);
    const first = await t.mutation(
      internal.selectorOptions.ensureBrandUnknownRow,
      { yearId },
    );

    // The operator renamed it — the row keeps whatever name it has; the flag
    // is what identifies it, never the name.
    await t.run(async (ctx) =>
      ctx.db.patch(first.id, { value: "Whatever They Called It" }),
    );

    const second = await t.mutation(
      internal.selectorOptions.ensureBrandUnknownRow,
      { yearId },
    );
    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);

    const row = await t.run(async (ctx) => ctx.db.get(second.id));
    expect(row?.value).toBe("Whatever They Called It"); // never renamed
  });

  test("attaches the SportLots id only when the row holds NONE on that side", async () => {
    const t = convexTest(schema, modules);
    const yearId = await seedYear(t);
    const first = await t.mutation(
      internal.selectorOptions.ensureBrandUnknownRow,
      { yearId, sl: { id: "All Brands", label: "All Brands" } },
    );

    // A later call with a DIFFERENT sl id must not overwrite the existing one.
    const second = await t.mutation(
      internal.selectorOptions.ensureBrandUnknownRow,
      { yearId, sl: { id: "different-id", label: "Different" } },
    );
    expect(second.id).toBe(first.id);

    const row = await t.run(async (ctx) => ctx.db.get(second.id));
    expect(row?.platformData.sportlots?.["s0"]).toBe("All Brands");
  });

  test("adopting an operator-made row strips its features.manufacturer", async () => {
    const t = convexTest(schema, modules);
    const yearId = await seedYear(t, { sport: "Hockey" });
    // Operator hand-created a manufacturer row later flagged (simulating a
    // pre-NEO-237 row the backfill or a caller marks) that still carries a
    // manufacturer feature snapshot.
    const rowId = await seedManufacturer(t, yearId, "Unknown", {
      metadata: { isBrandUnknown: true },
      features: { sport: "Hockey", manufacturer: "Unknown" },
    });

    const result = await t.mutation(
      internal.selectorOptions.ensureBrandUnknownRow,
      { yearId },
    );
    expect(result.id).toBe(rowId);
    expect(result.created).toBe(false);

    const row = await t.run(async (ctx) => ctx.db.get(rowId));
    expect(row?.features?.sport).toBe("Hockey");
    expect(row?.features && "manufacturer" in row.features).toBe(false);
  });

  test("never renames the adopted row even when it does not fold to Unknown", async () => {
    const t = convexTest(schema, modules);
    const yearId = await seedYear(t);
    const rowId = await seedManufacturer(t, yearId, "All Brands", {
      metadata: { isBrandUnknown: true },
    });

    const result = await t.mutation(
      internal.selectorOptions.ensureBrandUnknownRow,
      { yearId },
    );
    expect(result.id).toBe(rowId);

    const row = await t.run(async (ctx) => ctx.db.get(rowId));
    expect(row?.value).toBe("All Brands");
  });
});
