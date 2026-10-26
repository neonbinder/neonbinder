/**
 * NEO-367 — a catalog card's Notes: the write path (`addCustomCard`,
 * `updateCard`, both through `normalizeCardNotes`), the strict
 * `getCardChecklist` returns validator, and a re-sync leaving the field alone.
 *
 * Fixture conventions mirror convex/commitCardChecklist.resync.test.ts.
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { Id } from "./_generated/dataModel";
import { CARD_NOTES_MAX, normalizeCardNotes } from "./cardNotes";
import { cancelScheduled, drainScheduled } from "../lib/testing/drain-scheduled";
import { insertTestCard } from "../lib/testing/card-row";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN_IDENTITY = {
  subject: "admin_card_notes_001",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_card_notes_001",
  role: "admin",
};

const NON_ADMIN_IDENTITY = {
  subject: "user_card_notes_002",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|user_card_notes_002",
};

beforeEach(() => {
  // A re-sync can schedule a BSC team lookup; nothing here may reach the
  // network (same stub as commitCardChecklist.resync.test.ts).
  vi.stubGlobal(
    "fetch",
    (async (url: string | URL) => {
      throw new Error(`NEO-367: this test file must not reach the network: ${String(url)}`);
    }) as unknown as typeof fetch,
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function seedTree(
  t: ReturnType<typeof convexTest>,
): Promise<{ sportId: Id<"selectorOptions">; leafId: Id<"selectorOptions"> }> {
  return t.run(async (ctx) => {
    const sportId = await ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Baseball",
      sportConfig: { skuCode: "BB", league: "MLB" },
      platformData: {},
      children: [],
      lastUpdated: Date.now(),
    });
    const setNameId = await ctx.db.insert("selectorOptions", {
      level: "setName",
      value: "Test Set",
      platformData: {},
      features: { manufacturer: "Topps", season: "2024" },
      parentId: sportId,
      children: [],
      lastUpdated: Date.now(),
    });
    const leafId = await ctx.db.insert("selectorOptions", {
      level: "variantType",
      value: "Base",
      platformData: {},
      features: { manufacturer: "Topps", season: "2024" },
      parentId: setNameId,
      children: [],
      lastUpdated: Date.now(),
    });
    return { sportId, leafId };
  });
}

async function insertCard(
  t: ReturnType<typeof convexTest>,
  selectorOptionId: Id<"selectorOptions">,
  notes?: string,
): Promise<Id<"cardChecklist">> {
  return t.run(async (ctx) =>
    insertTestCard(ctx, {
      selectorOptionId,
      cardNumber: "7",
      cardName: "Mickey Mantle",
      platformData: {},
      sortOrder: 0,
      lastUpdated: Date.now(),
      ...(notes !== undefined ? { notes } : {}),
    }),
  );
}

// `t.run` hands an `undefined` result back as `null`, so absent reads `null`.
const storedNotes = (t: ReturnType<typeof convexTest>, id: Id<"cardChecklist">) =>
  t.run(async (ctx) => (await ctx.db.get(id))?.notes ?? null);

describe("normalizeCardNotes", () => {
  test("trims, and stores blank as absent", () => {
    expect(normalizeCardNotes("  short print  ")).toBe("short print");
    expect(normalizeCardNotes("   \n  ")).toBeUndefined();
    expect(normalizeCardNotes("")).toBeUndefined();
    expect(normalizeCardNotes(undefined)).toBeUndefined();
  });

  test("keeps line breaks inside the note", () => {
    expect(normalizeCardNotes("line one\nline two\n")).toBe("line one\nline two");
  });

  test("accepts exactly the cap and refuses one over, naming the length not the text", () => {
    expect(normalizeCardNotes("x".repeat(CARD_NOTES_MAX))).toHaveLength(CARD_NOTES_MAX);
    const over = "secret".padEnd(CARD_NOTES_MAX + 1, "y");
    expect(() => normalizeCardNotes(over)).toThrow(
      `Notes are ${CARD_NOTES_MAX + 1} characters; the limit is ${CARD_NOTES_MAX}.`,
    );
    expect(() => normalizeCardNotes(over)).not.toThrow(/secret/);
  });

  test("the cap is measured after trimming", () => {
    expect(normalizeCardNotes(`  ${"x".repeat(CARD_NOTES_MAX)}  `)).toHaveLength(CARD_NOTES_MAX);
  });
});

describe("updateCard — notes", () => {
  test("sets a trimmed note", async () => {
    const t = convexTest(schema, modules);
    const { leafId } = await seedTree(t);
    const id = await insertCard(t, leafId);
    await t.withIdentity(ADMIN_IDENTITY).mutation(api.selectorOptions.updateCard, {
      id,
      notes: "  Short print, about 1:120 packs  ",
    });
    expect(await storedNotes(t, id)).toBe("Short print, about 1:120 packs");
  });

  test('"" and whitespace clear the field rather than storing an empty string', async () => {
    const t = convexTest(schema, modules);
    const { leafId } = await seedTree(t);
    const id = await insertCard(t, leafId, "Error card");
    await t.withIdentity(ADMIN_IDENTITY).mutation(api.selectorOptions.updateCard, {
      id,
      notes: "   ",
    });
    const row = await t.run(async (ctx) => ctx.db.get(id));
    expect(row).not.toBeNull();
    expect("notes" in row!).toBe(false);
  });

  test("omitting notes leaves an existing note untouched", async () => {
    const t = convexTest(schema, modules);
    const { leafId } = await seedTree(t);
    const id = await insertCard(t, leafId, "Error card");
    await t.withIdentity(ADMIN_IDENTITY).mutation(api.selectorOptions.updateCard, {
      id,
      cardName: "Mickey Mantle Jr.",
    });
    expect(await storedNotes(t, id)).toBe("Error card");
  });

  test("an over-length note is refused and nothing in the call is written", async () => {
    const t = convexTest(schema, modules);
    const { leafId } = await seedTree(t);
    const id = await insertCard(t, leafId, "Error card");
    await expect(
      t.withIdentity(ADMIN_IDENTITY).mutation(api.selectorOptions.updateCard, {
        id,
        cardName: "Should not land",
        notes: "x".repeat(CARD_NOTES_MAX + 1),
      }),
    ).rejects.toThrow(/limit is 1000/);
    const row = await t.run(async (ctx) => ctx.db.get(id));
    expect(row?.notes).toBe("Error card");
    expect(row?.cardName).toBe("Mickey Mantle");
  });

  test("a non-admin cannot write a note", async () => {
    const t = convexTest(schema, modules);
    const { leafId } = await seedTree(t);
    const id = await insertCard(t, leafId);
    await expect(
      t.withIdentity(NON_ADMIN_IDENTITY).mutation(api.selectorOptions.updateCard, {
        id,
        notes: "Sneaky",
      }),
    ).rejects.toThrow();
    expect(await storedNotes(t, id)).toBeNull();
  });
});

describe("addCustomCard — notes", () => {
  test("a hand-added card is born with its trimmed note", async () => {
    const t = convexTest(schema, modules);
    const { leafId } = await seedTree(t);
    const id = await t.withIdentity(ADMIN_IDENTITY).mutation(api.selectorOptions.addCustomCard, {
      selectorOptionId: leafId,
      cardNumber: "52",
      cardName: "Archie Bradley",
      notes: " No team printed on the card ",
    });
    expect(await storedNotes(t, id)).toBe("No team printed on the card");
  });

  test("a blank note leaves the field absent", async () => {
    const t = convexTest(schema, modules);
    const { leafId } = await seedTree(t);
    const id = await t.withIdentity(ADMIN_IDENTITY).mutation(api.selectorOptions.addCustomCard, {
      selectorOptionId: leafId,
      cardNumber: "52",
      cardName: "Archie Bradley",
      notes: "  ",
    });
    const row = await t.run(async (ctx) => ctx.db.get(id));
    expect("notes" in row!).toBe(false);
  });

  test("an over-length note refuses the whole add, leaving no card behind", async () => {
    const t = convexTest(schema, modules);
    const { leafId } = await seedTree(t);
    await expect(
      t.withIdentity(ADMIN_IDENTITY).mutation(api.selectorOptions.addCustomCard, {
        selectorOptionId: leafId,
        cardNumber: "52",
        cardName: "Archie Bradley",
        notes: "x".repeat(CARD_NOTES_MAX + 1),
      }),
    ).rejects.toThrow(/limit is 1000/);
    const rows = await t.run(async (ctx) => ctx.db.query("cardChecklist").collect());
    expect(rows).toHaveLength(0);
  });
});

describe("getCardChecklist — notes", () => {
  test("returns the note (the returns validator is strict, so omitting it would throw)", async () => {
    const t = convexTest(schema, modules);
    const { leafId } = await seedTree(t);
    await insertCard(t, leafId, "Short print");
    const rows = await t
      .withIdentity(ADMIN_IDENTITY)
      .query(api.selectorOptions.getCardChecklist, { selectorOptionId: leafId });
    expect(rows).toHaveLength(1);
    expect(rows[0].notes).toBe("Short print");
  });
});

describe("commitCardChecklist — a re-sync never writes notes", () => {
  function wireCard(cardName: string, extra: Record<string, unknown> = {}) {
    return {
      cardNumber: "1",
      cardName,
      team: undefined,
      teams: [],
      players: [],
      attributes: [],
      platformData: { bsc: { ref: "stable-ref" } },
      ...extra,
    };
  }

  test("an accepted upstream correction on the same card leaves its note alone", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId } = await seedTree(t);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    await asAdmin.action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: leafId,
      sportId,
      cards: [wireCard("Original Name")],
    });
    const [inserted] = await t.run(async (ctx) => ctx.db.query("cardChecklist").collect());
    await asAdmin.mutation(api.selectorOptions.updateCard, {
      id: inserted._id,
      notes: "Error card, corrected in a later print run",
    });
    const edited = await t.run(async (ctx) => ctx.db.get(inserted._id));

    // The operator accepts every field, `notes` included: it is not an NB
    // content field the sync may write, so naming it does nothing.
    await asAdmin.action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: leafId,
      sportId,
      cards: [
        wireCard("Corrected Name", {
          applyFields: ["cardName", "notes"],
          baseVersion: edited!.lastUpdated,
        }),
      ],
    });

    const after = await t.run(async (ctx) => ctx.db.get(inserted._id));
    expect(after?.cardName).toBe("Corrected Name");
    expect(after?.notes).toBe("Error card, corrected in a later print run");
    await drainScheduled(t);
    await cancelScheduled(t);
  });

  test("the commit wire has no notes field, so a marketplace cannot send one", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId } = await seedTree(t);
    await expect(
      t.withIdentity(ADMIN_IDENTITY).action(api.selectorOptions.commitCardChecklist, {
        selectorOptionId: leafId,
        sportId,
        cards: [wireCard("Name", { notes: "From a marketplace" })],
      }),
    ).rejects.toThrow(/notes/);
  });
});
