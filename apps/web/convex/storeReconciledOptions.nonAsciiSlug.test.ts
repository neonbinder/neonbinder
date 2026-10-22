/**
 * A marketplace id is a VALUE, never a Convex field name.
 *
 * Convex field names must be non-control ASCII. BSC slugs are not: BSC lists
 * a 2023 Topps Chrome insert as `topps-chrome-exposé`. The Save path used to
 * send each slot's display label keyed BY that slug
 * (`platformLabels: { bsc: { "topps-chrome-exposé": "Exposé" } }`), and Convex
 * refused the whole call with "Field name topps-chrome-exposé has invalid
 * character 'é'", so nothing past Base was written.
 *
 * The labels now travel as `{ id, label }` pairs. These tests drive the real
 * builder (`buildReconciledItems`, the dialog's and the set-build tool's Save)
 * into the real mutation, so they fail if either side ever keys on the id
 * again. The legacy id-keyed record is still accepted (an open SPA tab from
 * before the deploy sends it), and pinned here too.
 */

import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Doc, Id } from "./_generated/dataModel";
import { buildReconciledItems, type ReadySet } from "../lib/set-build/reconcile";
import { labelForId } from "./lib/platformLabelPairs";

const modules = (
  import.meta as unknown as {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("./**/*.*s");

const ADMIN = { subject: "admin_non_ascii_slug", role: "admin" };
const SLUG = "topps-chrome-exposé";

type T = ReturnType<typeof convexTest>;
type RowId = Id<"selectorOptions">;
type Row = Doc<"selectorOptions">;

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

async function insertRow(
  t: T,
  fields: Partial<Row> & { level: Row["level"]; value: string },
): Promise<RowId> {
  return t.run(async (ctx) => {
    const id = await ctx.db.insert("selectorOptions", {
      platformData: {},
      children: [],
      lastUpdated: 1,
      ...fields,
    } as Omit<Row, "_id" | "_creationTime">);
    if (fields.parentId) {
      const parent = await ctx.db.get(fields.parentId);
      await ctx.db.patch(fields.parentId, {
        children: [...(parent?.children ?? []), id],
      });
    }
    return id;
  });
}

/** sport → year → brand → set → Insert variant type (the parent of `insert` rows). */
async function seedInsertType(t: T): Promise<RowId> {
  const sportId = await insertRow(t, { level: "sport", value: "Baseball" });
  const yearId = await insertRow(t, { level: "year", value: "2023", parentId: sportId });
  const brandId = await insertRow(t, {
    level: "manufacturer",
    value: "Topps",
    parentId: yearId,
  });
  const setId = await insertRow(t, {
    level: "setName",
    value: "Chrome",
    parentId: brandId,
    platformData: { bsc: { b0: "topps-chrome" } },
    platformFacets: { bsc: { b0: "setName" } },
    platformSlotSeq: { bsc: 1 },
  });
  return insertRow(t, {
    level: "variantType",
    value: "Insert",
    parentId: setId,
    platformData: { bsc: { b0: "insert" } },
    platformFacets: { bsc: { b0: "variant" } },
    platformSlotSeq: { bsc: 1 },
  });
}

async function childrenOf(t: T, parentId: RowId): Promise<Row[]> {
  return t.run(async (ctx) => {
    const rows = await ctx.db.query("selectorOptions").collect();
    return rows.filter((r) => r.parentId === parentId);
  });
}

describe("storeReconciledOptions: a non-ASCII marketplace id never becomes a field name", () => {
  test("the Save items carry labels as {id, label} pairs, never keyed by the slug", () => {
    const ready: ReadySet[] = [
      {
        key: "set-0",
        title: "Exposé",
        bsc: [{ value: "Exposé", platformValue: SLUG }],
        sl: [{ value: "Expose", platformValue: "12345" }],
        confidence: 1,
      },
    ];
    const [item] = buildReconciledItems(ready);
    expect(item.platformLabels).toEqual({
      bsc: [{ id: SLUG, label: "Exposé" }],
      sportlots: [{ id: "12345", label: "Expose" }],
    });
    // No object anywhere in the item is keyed by a marketplace id.
    const keys: string[] = [];
    const walk = (x: unknown) => {
      if (Array.isArray(x)) x.forEach(walk);
      else if (x && typeof x === "object") {
        for (const [k, v] of Object.entries(x)) {
          keys.push(k);
          walk(v);
        }
      }
    };
    walk(item);
    expect(keys).not.toContain(SLUG);
    expect(keys.every((k) => /^[\x20-\x7e]+$/.test(k))).toBe(true);
  });

  test("an insert whose BSC slug is `topps-chrome-exposé` is stored, with its label on the slot", async () => {
    const t = convexTest(schema, modules);
    const insertTypeId = await seedInsertType(t);
    const reconciledItems = buildReconciledItems([
      {
        key: "set-0",
        title: "Exposé",
        bsc: [{ value: "Exposé", platformValue: SLUG }],
        sl: [],
        confidence: 1,
      },
    ]);

    const res = await t
      .withIdentity(ADMIN)
      .mutation(api.setReconciliation.storeReconciledOptions, {
        level: "insert",
        parentId: insertTypeId,
        reconciledItems,
      });
    expect(res.success).toBe(true);

    const rows = await childrenOf(t, insertTypeId);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row.value).toBe("Exposé");
    // Stored shape is unchanged: slot key → slug, slot key → label.
    expect(row.platformData.bsc).toEqual({ b0: SLUG });
    expect(row.platformLabels?.bsc).toEqual({ b0: "Exposé" });
  });

  test("a match against an existing row refreshes the slot label from the pairs", async () => {
    const t = convexTest(schema, modules);
    const insertTypeId = await seedInsertType(t);
    const existingId = await insertRow(t, {
      level: "insert",
      value: "Exposé",
      parentId: insertTypeId,
      platformData: { bsc: { b0: SLUG } },
      platformLabels: { bsc: { b0: "Old label" } },
      platformSlotSeq: { bsc: 1 },
    });

    const res = await t
      .withIdentity(ADMIN)
      .mutation(api.setReconciliation.storeReconciledOptions, {
        level: "insert",
        parentId: insertTypeId,
        reconciledItems: buildReconciledItems([
          {
            key: "set-0",
            existingId,
            title: "Exposé",
            bsc: [{ value: "Exposé", platformValue: SLUG }],
            sl: [],
            confidence: 0,
          },
        ]),
      });
    expect(res.success).toBe(true);

    const row = await t.run(async (ctx) => ctx.db.get(existingId));
    expect(row?.platformData.bsc).toEqual({ b0: SLUG });
    expect(row?.platformLabels?.bsc).toEqual({ b0: "Exposé" });
  });

  test("the legacy id-keyed record (an SPA tab open across the deploy) still stores its label", async () => {
    const t = convexTest(schema, modules);
    const insertTypeId = await seedInsertType(t);

    const res = await t
      .withIdentity(ADMIN)
      .mutation(api.setReconciliation.storeReconciledOptions, {
        level: "insert",
        parentId: insertTypeId,
        reconciledItems: [
          {
            value: "Gold Refractor",
            platformData: { bsc: ["gold-refractor"] },
            platformLabels: { bsc: { "gold-refractor": "Gold Refractor" } },
          },
        ],
      });
    expect(res.success).toBe(true);

    const [row] = await childrenOf(t, insertTypeId);
    expect(row.platformLabels?.bsc).toEqual({ b0: "Gold Refractor" });
  });
});

describe("labelForId", () => {
  test("reads a pair list, last pair for an id wins (the old record's overwrite rule)", () => {
    expect(
      labelForId(
        [
          { id: SLUG, label: "First" },
          { id: "other", label: "Other" },
          { id: SLUG, label: "Second" },
        ],
        SLUG,
      ),
    ).toBe("Second");
  });

  test("reads the legacy record by own key only", () => {
    expect(labelForId({ a: "A" }, "a")).toBe("A");
    expect(labelForId({ a: "A" }, "constructor")).toBeUndefined();
    expect(labelForId({ a: "A" }, "__proto__")).toBeUndefined();
  });

  test("absent side or id → undefined", () => {
    expect(labelForId(undefined, SLUG)).toBeUndefined();
    expect(labelForId([], SLUG)).toBeUndefined();
  });
});
