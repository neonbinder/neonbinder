/**
 * NEO-291 — `setSelectorOptionCardNumberPrefix`.
 *
 * The one metadata field the metadata-box retirement leaves an operator to
 * type by hand. Replaces `updateSelectorOptionMetadata` (deleted this
 * ticket), which merged a whole client-sent object; this mutation touches
 * exactly `metadata.cardNumberPrefix` and nothing else.
 */

import { ConvexError } from "convex/values";
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { MAX_CARD_NUMBER_PREFIX_LENGTH } from "./cardNumberPrefix";

const modules = (
  import.meta as unknown as {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("./**/*.*s");

const ADMIN_IDENTITY = {
  subject: "admin_user_cnp_001",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_user_cnp_001",
  name: "Admin User",
  role: "admin",
};

const NON_ADMIN_IDENTITY = {
  subject: "user_cnp_001",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|user_cnp_001",
  name: "Normal User",
  role: "user",
};

const SENTINEL = 1_000_000;

async function insertRow(
  t: ReturnType<typeof convexTest>,
  metadata?: Record<string, unknown>,
): Promise<Id<"selectorOptions">> {
  return t.run(async (ctx) =>
    ctx.db.insert("selectorOptions", {
      level: "insert",
      value: "Diamond Kings",
      platformData: {},
      children: [],
      ...(metadata ? { metadata } : {}),
      lastUpdated: SENTINEL,
    }),
  );
}

async function getRow(t: ReturnType<typeof convexTest>, id: Id<"selectorOptions">) {
  return t.run(async (ctx) => ctx.db.get(id));
}

describe("setSelectorOptionCardNumberPrefix", () => {
  test("trims and stores the prefix", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const id = await insertRow(t);

    await asAdmin.mutation(api.selectorOptions.setSelectorOptionCardNumberPrefix, {
      id,
      cardNumberPrefix: "  DK- ",
    });

    expect((await getRow(t, id))?.metadata).toEqual({ cardNumberPrefix: "DK-" });
  });

  test("\"\" removes the key and leaves other metadata (isBase, etc.) intact", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const id = await insertRow(t, { isBase: true, cardNumberPrefix: "DK-" });

    await asAdmin.mutation(api.selectorOptions.setSelectorOptionCardNumberPrefix, {
      id,
      cardNumberPrefix: "",
    });

    expect((await getRow(t, id))?.metadata).toEqual({ isBase: true });
  });

  test("clearing the only metadata key drops the object rather than storing {}", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const id = await insertRow(t, { cardNumberPrefix: "DK-" });

    await asAdmin.mutation(api.selectorOptions.setSelectorOptionCardNumberPrefix, {
      id,
      cardNumberPrefix: "",
    });

    expect((await getRow(t, id))?.metadata).toBeUndefined();
  });

  test("a whitespace-only value clears the key the same as an empty string", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const id = await insertRow(t, { cardNumberPrefix: "DK-" });

    await asAdmin.mutation(api.selectorOptions.setSelectorOptionCardNumberPrefix, {
      id,
      cardNumberPrefix: "   ",
    });

    expect((await getRow(t, id))?.metadata).toBeUndefined();
  });

  test("refuses a newline with a ConvexError an operator can read", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const id = await insertRow(t);

    await expect(
      asAdmin.mutation(api.selectorOptions.setSelectorOptionCardNumberPrefix, {
        id,
        cardNumberPrefix: "DK-\n1",
      }),
    ).rejects.toThrow(/line breaks or control characters/);
  });

  test("refuses a control character", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const id = await insertRow(t);

    await expect(
      asAdmin.mutation(api.selectorOptions.setSelectorOptionCardNumberPrefix, {
        id,
        cardNumberPrefix: "DK-\u0007",
      }),
    ).rejects.toThrow(/control characters/);
  });

  test("refuses a zero-width character", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const id = await insertRow(t);

    await expect(
      asAdmin.mutation(api.selectorOptions.setSelectorOptionCardNumberPrefix, {
        id,
        cardNumberPrefix: "DK-​",
      }),
    ).rejects.toThrow(/zero-width or invisible/);
  });

  test("refuses a value over the max length", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const id = await insertRow(t);
    const tooLong = "X".repeat(MAX_CARD_NUMBER_PREFIX_LENGTH + 1);

    await expect(
      asAdmin.mutation(api.selectorOptions.setSelectorOptionCardNumberPrefix, {
        id,
        cardNumberPrefix: tooLong,
      }),
    ).rejects.toThrow(new RegExp(`at most ${MAX_CARD_NUMBER_PREFIX_LENGTH} characters`));
  });

  test("accepts a value at exactly the max length", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const id = await insertRow(t);
    const atMax = "X".repeat(MAX_CARD_NUMBER_PREFIX_LENGTH);

    await asAdmin.mutation(api.selectorOptions.setSelectorOptionCardNumberPrefix, {
      id,
      cardNumberPrefix: atMax,
    });

    expect((await getRow(t, id))?.metadata).toEqual({ cardNumberPrefix: atMax });
  });

  test("a ConvexError thrown here carries string data, the shape userFacingMessage shows verbatim", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const id = await insertRow(t);

    try {
      await asAdmin.mutation(api.selectorOptions.setSelectorOptionCardNumberPrefix, {
        id,
        cardNumberPrefix: "DK-\n1",
      });
      expect.unreachable("expected a ConvexError");
    } catch (e) {
      expect(e).toBeInstanceOf(ConvexError);
      expect(typeof (e as ConvexError<string>).data).toBe("string");
    }
  });

  test("refuses a non-admin caller", async () => {
    const t = convexTest(schema, modules);
    const asUser = t.withIdentity(NON_ADMIN_IDENTITY);
    const id = await insertRow(t);

    await expect(
      asUser.mutation(api.selectorOptions.setSelectorOptionCardNumberPrefix, {
        id,
        cardNumberPrefix: "DK-",
      }),
    ).rejects.toThrow();

    expect((await getRow(t, id))?.metadata).toBeUndefined();
  });

  test("refuses an anonymous caller", async () => {
    const t = convexTest(schema, modules);
    const id = await insertRow(t);

    await expect(
      t.mutation(api.selectorOptions.setSelectorOptionCardNumberPrefix, {
        id,
        cardNumberPrefix: "DK-",
      }),
    ).rejects.toThrow();
  });

  test("a row that no longer exists is refused with a readable message", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const id = await insertRow(t);
    await t.run(async (ctx) => ctx.db.delete(id));

    await expect(
      asAdmin.mutation(api.selectorOptions.setSelectorOptionCardNumberPrefix, {
        id,
        cardNumberPrefix: "DK-",
      }),
    ).rejects.toThrow(/gone/);
  });
});
