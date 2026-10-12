/**
 * NEO-335 — `setSelectorOptionListingShortName`, the set attributes panel's
 * "Short name for titles".
 *
 * Same contract as `setSelectorOptionCardNumberPrefix`: one metadata key and
 * nothing else touched; trim, `""` deletes, control / invisible characters and
 * over-length refused with a string `ConvexError`; admin only. Plus: only on
 * a set or a part of one, never a sport, year or brand.
 */

import { ConvexError } from "convex/values";
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { MAX_LISTING_SHORT_NAME_LENGTH } from "./listingShortName";

const modules = (
  import.meta as unknown as {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("./**/*.*s");

const ADMIN_IDENTITY = {
  subject: "admin_user_lsn_001",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_user_lsn_001",
  name: "Admin User",
  role: "admin",
};

const NON_ADMIN_IDENTITY = {
  subject: "user_lsn_001",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|user_lsn_001",
  name: "Normal User",
  role: "user",
};

const SENTINEL = 1_000_000;

type T = ReturnType<typeof convexTest>;

async function insertRow(
  t: T,
  opts: { level?: "setName" | "variantType" | "insert" | "parallel" | "sport" | "year" | "manufacturer"; metadata?: Record<string, unknown> } = {},
): Promise<Id<"selectorOptions">> {
  return t.run(async (ctx) =>
    ctx.db.insert("selectorOptions", {
      level: opts.level ?? "insert",
      value: "Hologram",
      platformData: {},
      children: [],
      ...(opts.metadata ? { metadata: opts.metadata } : {}),
      lastUpdated: SENTINEL,
    }),
  );
}

async function getRow(t: T, id: Id<"selectorOptions">) {
  return t.run(async (ctx) => ctx.db.get(id));
}

function set(t: T, id: Id<"selectorOptions">, listingShortName: string) {
  return t
    .withIdentity(ADMIN_IDENTITY)
    .mutation(api.selectorOptions.setSelectorOptionListingShortName, { id, listingShortName });
}

describe("setSelectorOptionListingShortName", () => {
  test("trims and stores the short name, bumping lastUpdated", async () => {
    const t = convexTest(schema, modules);
    const id = await insertRow(t);
    await set(t, id, "  Upper Deck Hologram ");
    const row = await getRow(t, id);
    expect(row?.metadata).toEqual({ listingShortName: "Upper Deck Hologram" });
    expect(row?.lastUpdated).toBeGreaterThan(SENTINEL);
  });

  test.each(["setName", "variantType", "insert", "parallel"] as const)(
    "is accepted on a %s row",
    async (level) => {
      const t = convexTest(schema, modules);
      const id = await insertRow(t, { level });
      await set(t, id, "UD Hologram");
      expect((await getRow(t, id))?.metadata?.listingShortName).toBe("UD Hologram");
    },
  );

  test.each(["sport", "year", "manufacturer"] as const)(
    "is refused on a %s row, which no title walk reads",
    async (level) => {
      const t = convexTest(schema, modules);
      const id = await insertRow(t, { level });
      await expect(set(t, id, "UD Hologram")).rejects.toThrow(/set or a part of one/);
      expect((await getRow(t, id))?.metadata).toBeUndefined();
    },
  );

  // `isInsert` here is a RETIRED role flag (NEO-334: the kind is the variant
  // type's title) that stored rows keep until `stripRoleFlags` runs. Nothing
  // reads it; the point is that a short-name write never drops a key it does
  // not own.
  test("\"\" removes the key and leaves every other metadata key (prefix, a retired flag) intact", async () => {
    const t = convexTest(schema, modules);
    const id = await insertRow(t, {
      metadata: { isInsert: true, cardNumberPrefix: "H-", listingShortName: "UD Hologram" },
    });
    await set(t, id, "");
    expect((await getRow(t, id))?.metadata).toEqual({ isInsert: true, cardNumberPrefix: "H-" });
  });

  test("setting one never touches the keys beside it", async () => {
    const t = convexTest(schema, modules);
    const id = await insertRow(t, { metadata: { isInsert: true } });
    await set(t, id, "UD Hologram");
    expect((await getRow(t, id))?.metadata).toEqual({
      isInsert: true,
      listingShortName: "UD Hologram",
    });
  });

  test("clearing the only key drops the object rather than storing {}", async () => {
    const t = convexTest(schema, modules);
    const id = await insertRow(t, { metadata: { listingShortName: "UD Hologram" } });
    await set(t, id, "   ");
    expect((await getRow(t, id))?.metadata).toBeUndefined();
  });

  test.each([
    ["a newline", "UD\nHologram", /line breaks or control characters/],
    ["a control character", "UD Hologram\u0007", /control characters/],
    ["a zero-width character", "UD\u200BHologram", /zero-width or invisible/],
  ])("refuses %s, writing nothing", async (_label, raw, message) => {
    const t = convexTest(schema, modules);
    const id = await insertRow(t, { metadata: { listingShortName: "Kept" } });
    await expect(set(t, id, raw)).rejects.toThrow(message);
    const row = await getRow(t, id);
    expect(row?.metadata).toEqual({ listingShortName: "Kept" });
    expect(row?.lastUpdated).toBe(SENTINEL);
  });

  test("accepts exactly the cap and refuses one over it", async () => {
    const t = convexTest(schema, modules);
    const id = await insertRow(t);
    const atCap = "X".repeat(MAX_LISTING_SHORT_NAME_LENGTH);
    await set(t, id, atCap);
    expect((await getRow(t, id))?.metadata).toEqual({ listingShortName: atCap });
    await expect(set(t, id, `${atCap}X`)).rejects.toThrow(
      new RegExp(`at most ${MAX_LISTING_SHORT_NAME_LENGTH} characters`),
    );
    expect((await getRow(t, id))?.metadata).toEqual({ listingShortName: atCap });
  });

  test("the refusal is a ConvexError with string data, which userFacingMessage shows verbatim", async () => {
    const t = convexTest(schema, modules);
    const id = await insertRow(t);
    try {
      await set(t, id, "UD\nHologram");
      expect.unreachable("expected a ConvexError");
    } catch (e) {
      expect(e).toBeInstanceOf(ConvexError);
      expect(typeof (e as ConvexError<string>).data).toBe("string");
    }
  });

  test("refuses a signed-in non-admin and an anonymous caller, writing nothing", async () => {
    const t = convexTest(schema, modules);
    const id = await insertRow(t);
    await expect(
      t
        .withIdentity(NON_ADMIN_IDENTITY)
        .mutation(api.selectorOptions.setSelectorOptionListingShortName, {
          id,
          listingShortName: "UD Hologram",
        }),
    ).rejects.toThrow();
    await expect(
      t.mutation(api.selectorOptions.setSelectorOptionListingShortName, {
        id,
        listingShortName: "UD Hologram",
      }),
    ).rejects.toThrow();
    const row = await getRow(t, id);
    expect(row?.metadata).toBeUndefined();
    expect(row?.lastUpdated).toBe(SENTINEL);
  });

  test("a row that no longer exists is refused with a readable message", async () => {
    const t = convexTest(schema, modules);
    const id = await insertRow(t);
    await t.run(async (ctx) => ctx.db.delete(id));
    await expect(set(t, id, "UD Hologram")).rejects.toThrow(/gone/);
  });
});
