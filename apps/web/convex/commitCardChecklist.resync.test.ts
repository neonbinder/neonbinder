/**
 * NEO-203 — the matching cascade and re-sync write semantics.
 *
 * `convex/commitCardChecklist.duplicateNumbers.test.ts` proves the INSERT
 * path (a checklist carrying the same card number twice becomes distinct
 * rows). This file proves the RE-SYNC path: matching an incoming card back to
 * the RIGHT existing row when numbers repeat, and NeonBinder owning card
 * content once a row exists — see `resolveExistingIds` and the note on
 * `commitCardChecklistChunk` in convex/selectorOptions.ts for the full
 * cascade this exercises.
 *
 * Fixture conventions mirror `commitCardChecklist.duplicateNumbers.test.ts`
 * and `commitCardChecklist.chunking.test.ts` — admin identity, schema,
 * modules glob.
 */

import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { Id } from "./_generated/dataModel";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN_IDENTITY = {
  subject: "admin_resync_001",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_resync_001",
  name: "Admin User",
  role: "admin",
};

async function seedTree(
  t: ReturnType<typeof convexTest>,
  opts: {
    bscSlots?: Record<string, string>;
    slSlots?: Record<string, string>;
  } = {},
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
      platformData: {
        ...(opts.bscSlots ? { bsc: opts.bscSlots } : {}),
        ...(opts.slSlots ? { sportlots: opts.slSlots } : {}),
      },
      features: { manufacturer: "Topps", season: "2024" },
      parentId: setNameId,
      children: [],
      lastUpdated: Date.now(),
    });
    return { sportId, leafId };
  });
}

/** One reconciled card as the commit wire carries it. */
function card(opts: {
  cardNumber: string;
  cardName: string;
  bscRef?: string;
  bscSetId?: string;
  slRef?: string;
  slSetId?: string;
  applyFields?: string[];
  baseVersion?: number;
  isRookie?: boolean;
  isRelic?: boolean;
  printRun?: number;
  autographType?: string;
  cardVariation?: string;
  isVariation?: boolean;
  players?: string[];
  teams?: string[];
  attributes?: string[];
}) {
  const platformData: {
    bsc?: { ref: string; setId?: string };
    sportlots?: { ref: string; setId?: string };
  } = {};
  if (opts.bscRef !== undefined) {
    platformData.bsc = {
      ref: opts.bscRef,
      ...(opts.bscSetId ? { setId: opts.bscSetId } : {}),
    };
  }
  if (opts.slRef !== undefined) {
    platformData.sportlots = {
      ref: opts.slRef,
      ...(opts.slSetId ? { setId: opts.slSetId } : {}),
    };
  }
  return {
    cardNumber: opts.cardNumber,
    cardName: opts.cardName,
    team: undefined,
    teams: opts.teams ?? [],
    players: opts.players ?? [],
    attributes: opts.attributes ?? [],
    isRookie: opts.isRookie,
    isRelic: opts.isRelic,
    printRun: opts.printRun,
    autographType: opts.autographType,
    cardVariation: opts.cardVariation,
    isVariation: opts.isVariation,
    platformData,
    applyFields: opts.applyFields,
    baseVersion: opts.baseVersion,
  };
}

async function storedRows(
  t: ReturnType<typeof convexTest>,
  selectorOptionId: Id<"selectorOptions">,
) {
  return t.run(async (ctx) =>
    ctx.db
      .query("cardChecklist")
      .withIndex("by_selector_option", (q) =>
        q.eq("selectorOptionId", selectorOptionId),
      )
      .collect(),
  );
}

// ---------------------------------------------------------------------------
// Case 2 — the Alice/Bob probe: each duplicate-numbered row gets ITS OWN
// upstream correction, never the other's.
// ---------------------------------------------------------------------------

describe("commitCardChecklist — re-sync applies each row's OWN correction", () => {
  test("two rows sharing a card number each receive their own correction, not each other's (Alice/Bob probe)", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId } = await seedTree(t);

    await t.withIdentity(ADMIN_IDENTITY).action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: leafId,
      sportId,
      cards: [
        card({ cardNumber: "1", cardName: "Alice Series One", bscRef: "s1-card-1" }),
        card({ cardNumber: "1", cardName: "Bob Series Two", bscRef: "s2-card-1" }),
      ],
    });

    const before = await storedRows(t, leafId);
    const aliceRow = before.find((r) => r.platformData?.bsc?.ref === "s1-card-1")!;
    const bobRow = before.find((r) => r.platformData?.bsc?.ref === "s2-card-1")!;
    expect(aliceRow).toBeDefined();
    expect(bobRow).toBeDefined();

    await t.withIdentity(ADMIN_IDENTITY).action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: leafId,
      sportId,
      cards: [
        card({
          cardNumber: "1",
          cardName: "Alice Corrected",
          bscRef: "s1-card-1",
          applyFields: ["cardName"],
          baseVersion: aliceRow.lastUpdated,
        }),
        card({
          cardNumber: "1",
          cardName: "Bob Corrected",
          bscRef: "s2-card-1",
          applyFields: ["cardName"],
          baseVersion: bobRow.lastUpdated,
        }),
      ],
    });

    const after = await storedRows(t, leafId);
    expect(after).toHaveLength(2);
    const aliceAfter = after.find((r) => r._id === aliceRow._id)!;
    const bobAfter = after.find((r) => r._id === bobRow._id)!;
    expect(aliceAfter.cardName).toBe("Alice Corrected");
    expect(bobAfter.cardName).toBe("Bob Corrected");
    // The bug this ticket fixes: neither row received the OTHER's correction.
    expect(aliceAfter.cardName).not.toBe("Bob Corrected");
    expect(bobAfter.cardName).not.toBe("Alice Corrected");
  });
});

// ---------------------------------------------------------------------------
// Case 3 — an upstream SportLots description fix (the ref) still re-matches
// via the slot+number tier, because setId is present.
// ---------------------------------------------------------------------------

describe("commitCardChecklist — tier 2 (slot + number) survives an upstream ref change", () => {
  test("an SL ref change re-matches via slot+number; row id stable, linkage updated, no churn", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId } = await seedTree(t, { slSlots: { s0: "sl-set-1" } });

    await t.withIdentity(ADMIN_IDENTITY).action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: leafId,
      sportId,
      cards: [
        card({
          cardNumber: "5",
          cardName: "Original Card",
          slRef: "#5 Old Description",
          slSetId: "sl-set-1",
        }),
      ],
    });

    const before = await storedRows(t, leafId);
    expect(before).toHaveLength(1);
    const originalId = before[0]._id;
    expect(before[0].platformData?.sportlots?.src).toBe("s0");

    const result = await t.withIdentity(ADMIN_IDENTITY).action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: leafId,
      sportId,
      cards: [
        card({
          cardNumber: "5",
          cardName: "Original Card",
          slRef: "#5 New Corrected Description",
          slSetId: "sl-set-1",
        }),
      ],
    });

    expect(result.unmatchedExistingCount).toBe(0);
    expect(result.collisionInserts).toBe(0);
    expect(result.conflicts).toHaveLength(0);

    const after = await storedRows(t, leafId);
    expect(after).toHaveLength(1);
    expect(after[0]._id).toBe(originalId);
    expect(after[0].platformData?.sportlots?.ref).toBe("#5 New Corrected Description");
    expect(after[0].platformData?.sportlots?.src).toBe("s0");
  });
});

// ---------------------------------------------------------------------------
// Case 4 — ambiguity is surfaced, never guessed.
// ---------------------------------------------------------------------------

describe("commitCardChecklist — ambiguity is surfaced, never guessed", () => {
  test("4a: two existing rows sharing one SportLots ref — neither matches, reported via ambiguousMatchKeys", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId } = await seedTree(t);
    const [rowAId, rowBId] = await t.run(async (ctx) => {
      const a = await ctx.db.insert("cardChecklist", {
        selectorOptionId: leafId,
        cardNumber: "1",
        cardName: "Row A (duplicate SL ref)",
        platformData: { sportlots: { ref: "#1 Same Description" } },
        sortOrder: 0,
        lastUpdated: Date.now(),
      });
      const b = await ctx.db.insert("cardChecklist", {
        selectorOptionId: leafId,
        cardNumber: "2",
        cardName: "Row B (duplicate SL ref)",
        platformData: { sportlots: { ref: "#1 Same Description" } },
        sortOrder: 1,
        lastUpdated: Date.now(),
      });
      return [a, b];
    });

    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });

    const result = await t.withIdentity(ADMIN_IDENTITY).action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: leafId,
      sportId,
      cards: [
        card({ cardNumber: "1", cardName: "Incoming Card", slRef: "#1 Same Description" }),
      ],
    });

    expect(result.unmatchedExistingCount).toBe(2);
    expect(result.conflicts).toHaveLength(0);
    expect(result.collisionInserts).toBe(0);

    const rows = await storedRows(t, leafId);
    expect(rows).toHaveLength(3); // A and B kept untouched, plus the new insert
    expect(rows.find((r) => r._id === rowAId)!.cardName).toBe("Row A (duplicate SL ref)");
    expect(rows.find((r) => r._id === rowBId)!.cardName).toBe("Row B (duplicate SL ref)");

    const matchLine = logs.find((l) => l.includes('"msg":"commit_card_matching"'));
    expect(matchLine).toBeDefined();
    const parsed = JSON.parse(matchLine!);
    expect(
      (parsed.ambiguousKeys as string[]).some((k) => k.startsWith("slRef:")),
    ).toBe(true);

    spy.mockRestore();
  });

  test("4b: two existing rows sharing (slot, cardNumber) with distinct refs — no tier-2 match", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId } = await seedTree(t, { bscSlots: { b0: "real-bsc-set" } });
    const [rowXId, rowYId] = await t.run(async (ctx) => {
      const x = await ctx.db.insert("cardChecklist", {
        selectorOptionId: leafId,
        cardNumber: "9",
        cardName: "Row X",
        platformData: { bsc: { ref: "refX", src: "b0" } },
        sortOrder: 0,
        lastUpdated: Date.now(),
      });
      const y = await ctx.db.insert("cardChecklist", {
        selectorOptionId: leafId,
        cardNumber: "9",
        cardName: "Row Y",
        platformData: { bsc: { ref: "refY", src: "b0" } },
        sortOrder: 1,
        lastUpdated: Date.now(),
      });
      return [x, y];
    });

    const result = await t.withIdentity(ADMIN_IDENTITY).action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: leafId,
      sportId,
      cards: [
        card({
          cardNumber: "9",
          cardName: "Incoming Card",
          bscRef: "refZ",
          bscSetId: "real-bsc-set",
        }),
      ],
    });

    expect(result.unmatchedExistingCount).toBe(2);
    const rows = await storedRows(t, leafId);
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r._id === rowXId)!.cardName).toBe("Row X");
    expect(rows.find((r) => r._id === rowYId)!.cardName).toBe("Row Y");
  });

  test("4c: an incoming setId shaped like a slot key ('b0') is never compared against a stored src", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId } = await seedTree(t, { bscSlots: { b0: "real-bsc-set" } });
    const existingId = await t.run(async (ctx) =>
      ctx.db.insert("cardChecklist", {
        selectorOptionId: leafId,
        cardNumber: "7",
        cardName: "Existing Card",
        platformData: { bsc: { ref: "old-ref", src: "b0" } },
        sortOrder: 0,
        lastUpdated: Date.now(),
      }),
    );

    const result = await t.withIdentity(ADMIN_IDENTITY).action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: leafId,
      sportId,
      cards: [
        // The literal string "b0" happens to look like a slot key, but it is
        // not the set id ("real-bsc-set") attached to that slot.
        card({ cardNumber: "7", cardName: "Incoming Card", bscRef: "new-ref", bscSetId: "b0" }),
      ],
    });

    expect(result.unmatchedExistingCount).toBe(1);
    const rows = await storedRows(t, leafId);
    expect(rows).toHaveLength(2);
    const existing = rows.find((r) => r._id === existingId)!;
    expect(existing.cardName).toBe("Existing Card");
    expect(existing.platformData?.bsc?.ref).toBe("old-ref");
  });
});

// ---------------------------------------------------------------------------
// Case 5 — no applyFields at all: linkage refreshed, every NB content field
// left exactly as it was.
// ---------------------------------------------------------------------------

describe("commitCardChecklist — re-sync with no applyFields", () => {
  test("refreshes platformData linkage but leaves every NB content field untouched", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId } = await seedTree(t, {
      bscSlots: { b0: "set-primary", b1: "set-alt" },
    });

    await t.withIdentity(ADMIN_IDENTITY).action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: leafId,
      sportId,
      cards: [
        card({
          cardNumber: "1",
          cardName: "Operator Named This",
          bscRef: "stable-ref",
          bscSetId: "set-primary",
          players: ["Player One"],
          teams: ["Team One"],
          attributes: ["FOIL"],
          isRookie: true,
          isRelic: false,
          printRun: 10,
          autographType: "On-Card",
          cardVariation: "Blue Refractor",
        }),
      ],
    });

    // Simulate an operator hand-edit made after the fetch — exactly what
    // NEO-203 exists to protect from a re-sync.
    const inserted = (await storedRows(t, leafId))[0];
    await t.run(async (ctx) => {
      await ctx.db.patch(inserted._id, {
        cardName: "Operator Renamed This",
        printRun: 5,
      });
    });
    const edited = (await storedRows(t, leafId))[0];

    const result = await t.withIdentity(ADMIN_IDENTITY).action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: leafId,
      sportId,
      cards: [
        card({
          cardNumber: "1",
          cardName: "Marketplace Says This Now",
          bscRef: "stable-ref",
          bscSetId: "set-alt", // linkage moves to a DIFFERENT attached slot
          players: ["A Different Player"],
          teams: ["A Different Team"],
          attributes: ["DIFFERENT"],
          isRookie: false,
          isRelic: true,
          printRun: 999,
          autographType: "Sticker",
          cardVariation: "Red Refractor",
          // NO applyFields — the safe default.
        }),
      ],
    });

    expect(result.staleDecisions).toBe(0);
    const after = (await storedRows(t, leafId))[0];
    // Content is exactly what it was before this sync.
    expect(after.cardName).toBe("Operator Renamed This");
    expect(after.printRun).toBe(5);
    expect(after.playerIds).toEqual(edited.playerIds);
    expect(after.teamOnCardIds).toEqual(edited.teamOnCardIds);
    expect(after.attributes).toEqual(edited.attributes);
    expect(after.isRookie).toBe(edited.isRookie);
    expect(after.isRelic).toBe(edited.isRelic);
    expect(after.autographType).toBe(edited.autographType);
    expect(after.cardVariation).toBe(edited.cardVariation);
    // But linkage WAS refreshed — the slot moved from b0 to b1.
    expect(after.platformData?.bsc?.ref).toBe("stable-ref");
    expect(after.platformData?.bsc?.src).toBe("b1");
  });
});

// ---------------------------------------------------------------------------
// Case 8 — a card no longer listed upstream is kept, never deleted.
// ---------------------------------------------------------------------------

describe("commitCardChecklist — upstream removal", () => {
  test("a card dropped from the incoming payload is kept and counted in unmatchedExistingCount", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId } = await seedTree(t);

    await t.withIdentity(ADMIN_IDENTITY).action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: leafId,
      sportId,
      cards: [
        card({ cardNumber: "1", cardName: "Keeper", bscRef: "K1" }),
        card({ cardNumber: "2", cardName: "Dropped Upstream", bscRef: "K2" }),
      ],
    });
    const before = await storedRows(t, leafId);
    expect(before).toHaveLength(2);
    const droppedId = before.find((r) => r.platformData?.bsc?.ref === "K2")!._id;

    const result = await t.withIdentity(ADMIN_IDENTITY).action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: leafId,
      sportId,
      cards: [card({ cardNumber: "1", cardName: "Keeper", bscRef: "K1" })],
    });

    expect(result.unmatchedExistingCount).toBe(1);
    expect(result.operatorDeleted).toBe(0);
    const after = await storedRows(t, leafId);
    expect(after).toHaveLength(2);
    expect(after.some((r) => r._id === droppedId)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Case 12 — custom/legacy no-ref rows match by bare number (tier 3) and keep
// their identity across a re-sync.
// ---------------------------------------------------------------------------

describe("commitCardChecklist — tier 3 (bare number, no-ref rows)", () => {
  test("a no-ref row is matched by bare number and its identity survives", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId } = await seedTree(t);
    const legacyId = await t.run(async (ctx) =>
      ctx.db.insert("cardChecklist", {
        selectorOptionId: leafId,
        cardNumber: "42",
        cardName: "Legacy/Custom Card",
        isCustom: true,
        platformData: {},
        sortOrder: 0,
        lastUpdated: Date.now(),
      }),
    );

    const result = await t.withIdentity(ADMIN_IDENTITY).action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: leafId,
      sportId,
      cards: [card({ cardNumber: "42", cardName: "Incoming, no refs" })],
    });

    expect(result.unmatchedExistingCount).toBe(0);
    const rows = await storedRows(t, leafId);
    expect(rows).toHaveLength(1); // matched, never duplicated
    expect(rows[0]._id).toBe(legacyId);
    expect(rows[0].isCustom).toBe(true); // untouched by the match itself
  });
});

// ---------------------------------------------------------------------------
// Case 13 — variations resolve PER SOURCE SET (the Bonham/Garcia shape from
// lib/cards/variations.ts).
// ---------------------------------------------------------------------------

describe("commitCardChecklist — variations resolved per source set", () => {
  test("two sources sharing a card-number stem never cross-link their variations", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId } = await seedTree(t);

    await t.withIdentity(ADMIN_IDENTITY).action(api.selectorOptions.commitCardChecklist, {
      selectorOptionId: leafId,
      sportId,
      cards: [
        card({ cardNumber: "29", cardName: "Player Alpha", bscRef: "setA-29", bscSetId: "insert-A" }),
        card({
          cardNumber: "29b",
          cardName: "Player Alpha",
          bscRef: "setA-29b",
          bscSetId: "insert-A",
          isVariation: true,
          cardVariation: "Action",
        }),
        card({ cardNumber: "29", cardName: "Player Beta", bscRef: "setB-29", bscSetId: "insert-B" }),
        card({
          cardNumber: "29b",
          cardName: "Player Beta",
          bscRef: "setB-29b",
          bscSetId: "insert-B",
          isVariation: true,
          cardVariation: "Action",
        }),
      ],
    });

    const rows = await storedRows(t, leafId);
    const byRef = new Map(rows.map((r) => [r.platformData?.bsc?.ref, r]));
    const parentA = byRef.get("setA-29")!;
    const childA = byRef.get("setA-29b")!;
    const parentB = byRef.get("setB-29")!;
    const childB = byRef.get("setB-29b")!;

    expect(childA.variationOfCardId).toBe(parentA._id);
    expect(childB.variationOfCardId).toBe(parentB._id);
    // Never crossed: Alpha's variation never links to Beta's parent or vice
    // versa, even though both partitions share the "29" stem.
    expect(childA.variationOfCardId).not.toBe(parentB._id);
    expect(childB.variationOfCardId).not.toBe(parentA._id);
  });
});
