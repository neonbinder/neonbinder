/**
 * NEO-24 Stage 2: round-trip tests for `setSetMetadata` + the
 * selectorOptions read queries. Confirms the new optional `setMetadata`
 * object survives `ReturnsValidator` checks on `getSelectorOptionById` and
 * `getSelectorOptions`.
 *
 * (NEO-23 lesson: a returns validator that omits a freshly added optional
 * field will throw `ReturnsValidationError` on the first row that carries
 * the field. These tests pin that contract.)
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { Id } from "./_generated/dataModel";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN_IDENTITY = {
  subject: "admin_user_001",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_user_001",
  name: "Admin User",
  role: "admin",
};

async function insertBareSetName(
  t: ReturnType<typeof convexTest>,
): Promise<Id<"selectorOptions">> {
  return t.run(async (ctx) => {
    return ctx.db.insert("selectorOptions", {
      level: "setName",
      value: "2024 Topps Series 1",
      platformData: { bsc: "bsc-2024-topps-s1", sportlots: "sl-s1" },
      children: [],
      lastUpdated: Date.now(),
    });
  });
}

describe("setSetMetadata", () => {
  test("round-trips all fields via getSelectorOptionById without ReturnsValidationError", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const setId = await insertBareSetName(t);

    await asAdmin.mutation(api.selectorOptions.setSetMetadata, {
      selectorOptionId: setId,
      metadata: {
        releaseDate: "2024-02-14",
        totalCardCount: 350,
        block: "Series 1",
        tcdbSetId: "3535",
        sourceUrl: "https://www.tcdb.com/Checklist.cfm/sid/3535",
        lastSyncedAt: 1714521600000,
      },
    });

    // Query through the validator-guarded query — this fails loudly if the
    // returns object doesn't allow `setMetadata`.
    const row = await asAdmin.query(api.selectorOptions.getSelectorOptionById, {
      id: setId,
    });
    expect(row).not.toBeNull();
    expect(row!.setMetadata?.releaseDate).toBe("2024-02-14");
    expect(row!.setMetadata?.totalCardCount).toBe(350);
    expect(row!.setMetadata?.block).toBe("Series 1");
    expect(row!.setMetadata?.tcdbSetId).toBe("3535");
    expect(row!.setMetadata?.sourceUrl).toBe(
      "https://www.tcdb.com/Checklist.cfm/sid/3535",
    );
    expect(row!.setMetadata?.lastSyncedAt).toBe(1714521600000);
  });

  test("merge-patches partial metadata onto an existing setMetadata", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const setId = await insertBareSetName(t);

    await asAdmin.mutation(api.selectorOptions.setSetMetadata, {
      selectorOptionId: setId,
      metadata: { releaseDate: "2024-02-14", totalCardCount: 350 },
    });

    // Partial second write — should not clobber releaseDate.
    await asAdmin.mutation(api.selectorOptions.setSetMetadata, {
      selectorOptionId: setId,
      metadata: { tcdbSetId: "3535" },
    });

    const row = await asAdmin.query(api.selectorOptions.getSelectorOptionById, {
      id: setId,
    });
    expect(row!.setMetadata?.releaseDate).toBe("2024-02-14");
    expect(row!.setMetadata?.totalCardCount).toBe(350);
    expect(row!.setMetadata?.tcdbSetId).toBe("3535");
  });

  test("getSelectorOptions returns setMetadata without ReturnsValidationError", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    // Seed two rows under no parent — one with setMetadata, one without.
    const withMetaId = await t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "setName",
        value: "Has Metadata",
        platformData: {},
        setMetadata: {
          releaseDate: "2024-01-01",
          tcdbSetId: "9999",
        },
        children: [],
        lastUpdated: Date.now(),
      }),
    );
    await t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "setName",
        value: "No Metadata",
        platformData: {},
        children: [],
        lastUpdated: Date.now(),
      }),
    );

    // Query through the validator — fails loudly if returns shape mismatches.
    const rows = await asAdmin.query(api.selectorOptions.getSelectorOptions, {
      level: "setName",
    });

    const withMeta = rows.find((r) => r._id === withMetaId);
    expect(withMeta?.setMetadata?.releaseDate).toBe("2024-01-01");
    expect(withMeta?.setMetadata?.tcdbSetId).toBe("9999");

    const withoutMeta = rows.find((r) => r.value === "No Metadata");
    expect(withoutMeta?.setMetadata).toBeUndefined();
  });
});

describe("getAncestorChain (NEO-38: setMetadata in chain)", () => {
  test("returns the setName row's setMetadata without ReturnsValidationError", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    // Seed setName (with setMetadata) → variantType, then resolve the chain
    // from the variantType leaf.
    const { setNameId, variantTypeId } = await t.run(async (ctx) => {
      const setNameId = await ctx.db.insert("selectorOptions", {
        level: "setName" as const,
        value: "2024 Topps Series 1",
        platformData: { bsc: "bsc-2024-topps-s1", sportlots: "sl-s1" },
        setMetadata: {
          releaseDate: "2024-02-14",
          totalCardCount: 350,
          block: "Series 1",
          tcdbSetId: "3535",
          sourceUrl: "https://www.tcdb.com/Checklist.cfm/sid/3535",
          lastSyncedAt: 1714521600000,
        },
        children: [],
        lastUpdated: Date.now(),
      });
      const variantTypeId = await ctx.db.insert("selectorOptions", {
        level: "variantType" as const,
        value: "Base",
        platformData: { bsc: "bsc-base", sportlots: "sl-base" },
        parentId: setNameId,
        children: [],
        lastUpdated: Date.now(),
      });
      await ctx.db.patch(setNameId, { children: [variantTypeId] });
      return { setNameId, variantTypeId };
    });

    // This call fails loudly with ReturnsValidationError if the returns
    // validator doesn't allow `setMetadata`.
    const chain = await asAdmin.query(api.selectorOptions.getAncestorChain, {
      id: variantTypeId,
    });

    const setNameRow = chain.find((r) => r._id === setNameId);
    expect(setNameRow).toBeDefined();
    expect(setNameRow!.setMetadata?.releaseDate).toBe("2024-02-14");
    expect(setNameRow!.setMetadata?.totalCardCount).toBe(350);
    expect(setNameRow!.setMetadata?.block).toBe("Series 1");
    expect(setNameRow!.setMetadata?.tcdbSetId).toBe("3535");
    expect(setNameRow!.setMetadata?.sourceUrl).toBe(
      "https://www.tcdb.com/Checklist.cfm/sid/3535",
    );
    expect(setNameRow!.setMetadata?.lastSyncedAt).toBe(1714521600000);

    // A node without setMetadata still round-trips (field stays undefined).
    const variantRow = chain.find((r) => r._id === variantTypeId);
    expect(variantRow).toBeDefined();
    expect(variantRow!.setMetadata).toBeUndefined();
  });
});
