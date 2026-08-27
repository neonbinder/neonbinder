/**
 * NEO-189 — the NeonBinder variation vocabulary.
 *
 * Note what these tests do NOT cover: any notion of what a marketplace calls a
 * variation. That was removed on the product owner's instruction (2026-08-27)
 * — NeonBinder holds its own card data, and the only marketplace fact worth
 * keeping is the per-card `ref` that lets a listing sync, which already lives
 * on `cardChecklist.platformData`. Label matching at import time is a transient
 * suggestion (`suggestVariationPairings`), not stored knowledge.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN = { subject: "user_admin", role: "admin" };

describe("createVariationType", () => {
  test("requires an admin", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.mutation(api.variationTypes.createVariationType, { name: "Action" }),
    ).rejects.toThrow();
  });

  test("creates a name and reports it as new", async () => {
    const t = convexTest(schema, modules);
    const res = await t
      .withIdentity(ADMIN)
      .mutation(api.variationTypes.createVariationType, { name: "Action" });
    expect(res).toMatchObject({ name: "Action", created: true });
  });

  test("two admins reaching for one name converge on a single row", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN);
    const a = await asAdmin.mutation(api.variationTypes.createVariationType, {
      name: "Nickname",
    });
    const b = await asAdmin.mutation(api.variationTypes.createVariationType, {
      name: "  nickname ",
    });
    expect(b.variationTypeId).toBe(a.variationTypeId);
    expect(b.created).toBe(false);
    expect(await t.query(api.variationTypes.listVariationTypes, {})).toHaveLength(1);
  });

  test("an empty name is refused", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t
        .withIdentity(ADMIN)
        .mutation(api.variationTypes.createVariationType, { name: "   " }),
    ).rejects.toThrow();
  });
});

describe("renameVariationType", () => {
  test("renames in place, so cards pointing at the row follow with no backfill", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN);
    const { variationTypeId } = await asAdmin.mutation(
      api.variationTypes.createVariationType,
      { name: "Team Color" },
    );
    await asAdmin.mutation(api.variationTypes.renameVariationType, {
      variationTypeId,
      name: "Team Color Swap",
    });
    const all = await t.query(api.variationTypes.listVariationTypes, {});
    expect(all).toHaveLength(1);
    expect(all[0]._id).toBe(variationTypeId);
    expect(all[0].name).toBe("Team Color Swap");
  });

  test("renaming onto an existing name is refused rather than silently merging", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN);
    await asAdmin.mutation(api.variationTypes.createVariationType, {
      name: "Action",
    });
    const { variationTypeId } = await asAdmin.mutation(
      api.variationTypes.createVariationType,
      { name: "Nickname" },
    );
    await expect(
      asAdmin.mutation(api.variationTypes.renameVariationType, {
        variationTypeId,
        name: "action",
      }),
    ).rejects.toThrow(/already exists/);
    expect(await t.query(api.variationTypes.listVariationTypes, {})).toHaveLength(2);
  });

  test("renaming a row to its own name is a no-op, not a clash", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN);
    const { variationTypeId } = await asAdmin.mutation(
      api.variationTypes.createVariationType,
      { name: "Action" },
    );
    const res = await asAdmin.mutation(api.variationTypes.renameVariationType, {
      variationTypeId,
      name: "ACTION",
    });
    expect(res.name).toBe("ACTION");
  });

  test("requires an admin", async () => {
    const t = convexTest(schema, modules);
    const { variationTypeId } = await t
      .withIdentity(ADMIN)
      .mutation(api.variationTypes.createVariationType, { name: "Action" });
    await expect(
      t.mutation(api.variationTypes.renameVariationType, {
        variationTypeId,
        name: "Other",
      }),
    ).rejects.toThrow();
  });
});

describe("listVariationTypes", () => {
  test("returns the vocabulary in name order", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN);
    for (const name of ["Nickname", "Action", "Missing Stars"]) {
      await asAdmin.mutation(api.variationTypes.createVariationType, { name });
    }
    const all = await t.query(api.variationTypes.listVariationTypes, {});
    expect(all.map((v) => v.name)).toEqual(["Action", "Missing Stars", "Nickname"]);
  });

  test("an empty vocabulary is empty, not an error", async () => {
    const t = convexTest(schema, modules);
    expect(await t.query(api.variationTypes.listVariationTypes, {})).toEqual([]);
  });
});
