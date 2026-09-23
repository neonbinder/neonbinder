/**
 * NEO-294 — "Unknown should not be renamable" (Jason, 2026-09-22), through
 * the mutation.
 *
 * The rule itself is stated as a pure test in `selectorSyncMatch.test.ts`
 * (`planValueRename` refuses a row carrying `metadata.isBrandUnknown`). This
 * file asserts the OPERATOR door: `renameSelectorOption` refuses before it
 * reads siblings, the refusal arrives as a `ConvexError` whose `data` an
 * operator can read (production redacts a plain `Error`'s message to "Server
 * Error"), and nothing about the row changes.
 *
 * The control cases matter as much as the refusal: an ordinary brand row and
 * a row whose flag is an explicit `false` — NEO-237's "an operator saying this
 * IS a real brand" — rename exactly as they did before.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { api } from "./_generated/api";
import schema from "./schema";
import { Id } from "./_generated/dataModel";
import { BRAND_UNKNOWN_RENAME_REFUSAL } from "./selectorSyncMatch";

const modules = (
  import.meta as unknown as {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("./**/*.*s");

const ADMIN_IDENTITY = {
  subject: "admin_user_neo294_rename",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_user_neo294_rename",
  name: "Admin User",
  role: "admin",
};

const SENTINEL_LAST_UPDATED = 1_700_000_000_000;

type Metadata = { isBrandUnknown?: boolean; setNamePrefix?: string };

async function insertRow(
  t: ReturnType<typeof convexTest>,
  level: "sport" | "year" | "manufacturer",
  value: string,
  parentId?: Id<"selectorOptions">,
  metadata?: Metadata,
): Promise<Id<"selectorOptions">> {
  return t.run(async (ctx) => {
    const id = await ctx.db.insert("selectorOptions", {
      level,
      value,
      platformData: {},
      parentId,
      children: [],
      ...(metadata ? { metadata } : {}),
      lastUpdated: SENTINEL_LAST_UPDATED,
    });
    if (parentId) {
      const parent = await ctx.db.get(parentId);
      if (parent) {
        await ctx.db.patch(parentId, {
          children: [...(parent.children ?? []), id],
        });
      }
    }
    return id;
  });
}

/** sport › year, the chain every manufacturer row here hangs from. */
async function year(t: ReturnType<typeof convexTest>) {
  const sportId = await insertRow(t, "sport", "Baseball");
  return insertRow(t, "year", "2026", sportId);
}

describe("renameSelectorOption — the year's Unknown row", () => {
  test("refuses the rename and says why", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const yearId = await year(t);
    const unknownId = await insertRow(t, "manufacturer", "Unknown", yearId, {
      isBrandUnknown: true,
    });

    await expect(
      asAdmin.mutation(api.selectorOptions.renameSelectorOption, {
        id: unknownId,
        value: "Choice",
      }),
    ).rejects.toThrow(ConvexError);

    const after = await t.run((ctx) => ctx.db.get(unknownId));
    expect(after?.value).toBe("Unknown");
    // Not even `lastUpdated` moves: the refusal is before any patch.
    expect(after?.lastUpdated).toBe(SENTINEL_LAST_UPDATED);
  });

  test("the refusal carries the operator's sentence in `data`", async () => {
    // A plain `Error` reaches a production client as "Server Error"; only a
    // `ConvexError`'s `data` is text a backend deliberately chose for a
    // person, which is the house rule every refusal in this panel follows.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const yearId = await year(t);
    const unknownId = await insertRow(t, "manufacturer", "Unknown", yearId, {
      isBrandUnknown: true,
    });

    let captured: unknown;
    try {
      await asAdmin.mutation(api.selectorOptions.renameSelectorOption, {
        id: unknownId,
        value: "Choice",
      });
    } catch (e) {
      captured = e;
    }
    expect((captured as ConvexError<{ code: string; message: string }>).data)
      .toEqual({
        code: "BRAND_UNKNOWN_RENAME_REFUSED",
        message: BRAND_UNKNOWN_RENAME_REFUSAL,
      });
  });

  test("refuses a flagged row still wearing the legacy 'All Brands' name", async () => {
    // Found by the NB role, never by the name — the same rule every other
    // brand-unknown consumer follows, and the reason the row NB has not
    // renamed to "Unknown" yet is frozen too.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const yearId = await year(t);
    const legacyId = await insertRow(t, "manufacturer", "All Brands", yearId, {
      isBrandUnknown: true,
    });

    await expect(
      asAdmin.mutation(api.selectorOptions.renameSelectorOption, {
        id: legacyId,
        value: "Star",
      }),
    ).rejects.toThrow(ConvexError);
    expect(await t.run((ctx) => ctx.db.get(legacyId))).toMatchObject({
      value: "All Brands",
    });
  });

  test("an ordinary brand row under the same year still renames", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const yearId = await year(t);
    await insertRow(t, "manufacturer", "Unknown", yearId, {
      isBrandUnknown: true,
    });
    const choiceId = await insertRow(t, "manufacturer", "Choice", yearId, {
      setNamePrefix: "Choice",
    });

    const res = await asAdmin.mutation(
      api.selectorOptions.renameSelectorOption,
      { id: choiceId, value: "Choice Marketing" },
    );
    expect(res).toEqual({
      success: true,
      message: 'Renamed to "Choice Marketing"',
    });
    expect(await t.run((ctx) => ctx.db.get(choiceId))).toMatchObject({
      value: "Choice Marketing",
    });
  });

  test("an explicit isBrandUnknown: false is a real brand and renames", async () => {
    // NEO-237: `markBrandUnknownRole` never overrules an explicit `false` —
    // that is an operator saying "this IS a brand". The rename door agrees,
    // which is why the guard tests for `=== true` rather than truthiness.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const yearId = await year(t);
    const brandId = await insertRow(t, "manufacturer", "Best", yearId, {
      isBrandUnknown: false,
    });

    await asAdmin.mutation(api.selectorOptions.renameSelectorOption, {
      id: brandId,
      value: "Best Cards",
    });
    expect(await t.run((ctx) => ctx.db.get(brandId))).toMatchObject({
      value: "Best Cards",
    });
  });
});
