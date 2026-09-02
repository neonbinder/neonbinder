/**
 * NEO-203 phase C — the server-computed content diff the operator reviews.
 *
 * `commitCardChecklist.resync.test.ts` proves the WRITE semantics (what
 * `applyFields` + `baseVersion` do once an operator has decided).  This file
 * proves the thing they decide FROM: that `diffChecklistAgainstExisting`
 * buckets each incoming card correctly, tiers each changed field, tells a
 * reformatting apart from a rewrite, and — the load-bearing one — resolves
 * matches through the SAME cascade the commit will use, so a `baseVersion`
 * handed back from a diff is accepted by the very next commit.
 *
 * Fixture conventions mirror `commitCardChecklist.resync.test.ts` — admin
 * identity, schema, modules glob.
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
  subject: "admin_diff_001",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_diff_001",
  name: "Admin User",
  role: "admin",
};

const NON_ADMIN_IDENTITY = {
  subject: "user_diff_001",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|user_diff_001",
  name: "Regular User",
  role: "user",
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

/** One reconciled card as the review/commit wire carries it. */
function card(opts: {
  cardNumber: string;
  cardName: string;
  bscRef?: string;
  bscSetId?: string;
  slRef?: string;
  slSetId?: string;
  isRookie?: boolean;
  isRelic?: boolean;
  printRun?: number;
  autographType?: string;
  cardVariation?: string;
  players?: string[];
  teams?: string[];
  attributes?: string[];
  unmatched?: "bsc" | "sl";
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
    teams: opts.teams ?? [],
    players: opts.players ?? [],
    attributes: opts.attributes ?? [],
    isRookie: opts.isRookie,
    isRelic: opts.isRelic,
    printRun: opts.printRun,
    autographType: opts.autographType,
    cardVariation: opts.cardVariation,
    platformData,
    unmatched: opts.unmatched,
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

function diff(
  t: ReturnType<typeof convexTest>,
  selectorOptionId: Id<"selectorOptions">,
  cards: ReturnType<typeof card>[],
) {
  return t
    .withIdentity(ADMIN_IDENTITY)
    .query(api.selectorOptions.diffChecklistAgainstExisting, {
      selectorOptionId,
      cards,
    });
}

// ---------------------------------------------------------------------------

describe("diffChecklistAgainstExisting — bucketing", () => {
  test("an unchanged re-sync reports every card as identical and nothing removed", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId } = await seedTree(t);
    const cards = [
      card({ cardNumber: "1", cardName: "Alice Ace", bscRef: "bsc-1" }),
      card({ cardNumber: "2", cardName: "Bob Bat", bscRef: "bsc-2" }),
    ];

    await t
      .withIdentity(ADMIN_IDENTITY)
      .action(api.selectorOptions.commitCardChecklist, {
        selectorOptionId: leafId,
        sportId,
        cards,
      });

    const result = await diff(t, leafId, cards);
    expect(result.cards).toHaveLength(2);
    expect(result.cards.every((c) => c.bucket === "identical")).toBe(true);
    expect(result.cards.every((c) => c.fields.length === 0)).toBe(true);
    expect(result.removedUpstream.fullyOrphaned).toHaveLength(0);
    expect(result.removedUpstream.partialOrphanCount).toBe(0);
    expect(result.conflicts).toHaveLength(0);
  });

  test("a case/punctuation-only rename is formattingOnly, fold-equal, and tier 2", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId } = await seedTree(t);
    await t
      .withIdentity(ADMIN_IDENTITY)
      .action(api.selectorOptions.commitCardChecklist, {
        selectorOptionId: leafId,
        sportId,
        cards: [
          card({ cardNumber: "1", cardName: "Ken Griffey Jr", bscRef: "bsc-1" }),
        ],
      });

    const result = await diff(t, leafId, [
      // Punctuation and case only — the card still says the same thing.
      card({ cardNumber: "1", cardName: "KEN GRIFFEY JR.", bscRef: "bsc-1" }),
    ]);

    expect(result.cards).toHaveLength(1);
    const [entry] = result.cards;
    expect(entry.bucket).toBe("formattingOnly");
    expect(entry.fields).toHaveLength(1);
    expect(entry.fields[0]).toMatchObject({
      name: "cardName",
      tier: 2,
      oldValue: "Ken Griffey Jr",
      newValue: "KEN GRIFFEY JR.",
      foldEqual: true,
      source: "bsc",
    });
  });

  test("a substantive rename plus a tier-1 flag is contentChanges, and each field carries its own tier", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId } = await seedTree(t);
    await t
      .withIdentity(ADMIN_IDENTITY)
      .action(api.selectorOptions.commitCardChecklist, {
        selectorOptionId: leafId,
        sportId,
        cards: [
          card({ cardNumber: "1", cardName: "Mike Yastrzemski", bscRef: "bsc-1" }),
        ],
      });

    const result = await diff(t, leafId, [
      card({
        cardNumber: "1",
        cardName: "Carl Yastrzemski",
        bscRef: "bsc-1",
        isRookie: true,
        printRun: 99,
      }),
    ]);

    const [entry] = result.cards;
    expect(entry.bucket).toBe("contentChanges");
    const byName = new Map(entry.fields.map((f) => [f.name, f]));
    expect(byName.get("cardName")).toMatchObject({ tier: 2, foldEqual: false });
    // Trust-critical: the review must not pre-check these.
    expect(byName.get("isRookie")).toMatchObject({
      tier: 1,
      oldValue: "",
      newValue: "yes",
      foldEqual: false,
    });
    expect(byName.get("printRun")).toMatchObject({
      tier: 1,
      oldValue: "",
      newValue: "99",
    });
  });

  test("a card that matches no existing row is bucketed new with no fields", async () => {
    const t = convexTest(schema, modules);
    const { leafId } = await seedTree(t);
    const result = await diff(t, leafId, [
      card({ cardNumber: "7", cardName: "Brand New", bscRef: "bsc-7" }),
    ]);
    expect(result.cards).toEqual([
      {
        index: 0,
        cardNumber: "7",
        cardName: "Brand New",
        bucket: "new",
        fields: [],
      },
    ]);
  });

  test("players and teams are diffed by NAME, not by id", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId } = await seedTree(t);
    // Pre-existing entities, so the first commit resolves real ids onto the
    // row — a name the commit cannot resolve is left off the card entirely
    // (that is the entity wizard's job, which runs after this review).
    await t.run(async (ctx) => {
      await ctx.db.insert("players", {
        name: "Jose Ramirez",
        nameNormalized: "jose ramirez",
        sportId,
        lastUpdated: Date.now(),
      });
      await ctx.db.insert("teams", {
        name: "Cleveland Guardians",
        nameNormalized: "cleveland guardians",
        sportId,
        lastUpdated: Date.now(),
      });
    });
    await t
      .withIdentity(ADMIN_IDENTITY)
      .action(api.selectorOptions.commitCardChecklist, {
        selectorOptionId: leafId,
        sportId,
        cards: [
          card({
            cardNumber: "1",
            cardName: "Card One",
            bscRef: "bsc-1",
            players: ["Jose Ramirez"],
            teams: ["Cleveland Guardians"],
          }),
        ],
      });

    const result = await diff(t, leafId, [
      card({
        cardNumber: "1",
        cardName: "Card One",
        bscRef: "bsc-1",
        // A diacritic restoration on the player, a real change on the team.
        players: ["José Ramírez"],
        teams: ["Cleveland Indians"],
      }),
    ]);

    const byName = new Map(result.cards[0].fields.map((f) => [f.name, f]));
    expect(byName.get("playerIds")).toMatchObject({
      tier: 1,
      oldValue: "Jose Ramirez",
      newValue: "José Ramírez",
      // Fold-equal: the same player, spelled properly.
      foldEqual: true,
    });
    expect(byName.get("teamOnCardIds")).toMatchObject({
      oldValue: "Cleveland Guardians",
      newValue: "Cleveland Indians",
      foldEqual: false,
    });
    // One fold-equal field and one that is not ⇒ the card needs real review.
    expect(result.cards[0].bucket).toBe("contentChanges");
  });

  test("the `unmatched-<side>` marker the commit adds is not reported as an attributes change", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId } = await seedTree(t);
    const kept = card({
      cardNumber: "1",
      cardName: "Single Source",
      bscRef: "bsc-1",
      attributes: ["RC"],
      unmatched: "sl",
    });
    await t
      .withIdentity(ADMIN_IDENTITY)
      .action(api.selectorOptions.commitCardChecklist, {
        selectorOptionId: leafId,
        sportId,
        cards: [kept],
      });

    const result = await diff(t, leafId, [kept]);
    expect(result.cards[0].bucket).toBe("identical");
  });
});

describe("diffChecklistAgainstExisting — the diff is the commit's own matching", () => {
  test("baseVersion comes back as the matched row's lastUpdated and the very next commit accepts it", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId } = await seedTree(t);
    await t
      .withIdentity(ADMIN_IDENTITY)
      .action(api.selectorOptions.commitCardChecklist, {
        selectorOptionId: leafId,
        sportId,
        cards: [
          card({ cardNumber: "1", cardName: "Original Name", bscRef: "bsc-1" }),
        ],
      });
    const [row] = await storedRows(t, leafId);

    const result = await diff(t, leafId, [
      card({ cardNumber: "1", cardName: "Upstream Name", bscRef: "bsc-1" }),
    ]);
    const entry = result.cards[0];
    expect(entry.existingId).toBe(row._id);
    expect(entry.baseVersion).toBe(row.lastUpdated);

    // Hand the diff's own answer straight back to the commit — this is the
    // whole point of sharing `buildMatchMaps` + `resolveExistingIds`.
    await t
      .withIdentity(ADMIN_IDENTITY)
      .action(api.selectorOptions.commitCardChecklist, {
        selectorOptionId: leafId,
        sportId,
        cards: [
          {
            ...card({
              cardNumber: "1",
              cardName: "Upstream Name",
              bscRef: "bsc-1",
            }),
            applyFields: entry.fields.map((f) => f.name),
            baseVersion: entry.baseVersion,
          },
        ],
      });

    const after = await storedRows(t, leafId);
    expect(after).toHaveLength(1);
    expect(after[0]._id).toBe(row._id);
    expect(after[0].cardName).toBe("Upstream Name");
  });

  test("two rows sharing a card number are each diffed against their OWN row", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId } = await seedTree(t);
    await t
      .withIdentity(ADMIN_IDENTITY)
      .action(api.selectorOptions.commitCardChecklist, {
        selectorOptionId: leafId,
        sportId,
        cards: [
          card({ cardNumber: "1", cardName: "Alice Series One", bscRef: "s1-1" }),
          card({ cardNumber: "1", cardName: "Bob Series Two", bscRef: "s2-1" }),
        ],
      });

    const result = await diff(t, leafId, [
      card({ cardNumber: "1", cardName: "Alice Corrected", bscRef: "s1-1" }),
      card({ cardNumber: "1", cardName: "Bob Corrected", bscRef: "s2-1" }),
    ]);

    expect(result.cards).toHaveLength(2);
    expect(result.cards[0].fields[0]).toMatchObject({
      oldValue: "Alice Series One",
      newValue: "Alice Corrected",
    });
    expect(result.cards[1].fields[0]).toMatchObject({
      oldValue: "Bob Series Two",
      newValue: "Bob Corrected",
    });
    expect(result.cards[0].existingId).not.toBe(result.cards[1].existingId);
  });

  test("a cross-side conflict is reported with both candidate rows and the card is left out of the diff list", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId } = await seedTree(t);
    await t
      .withIdentity(ADMIN_IDENTITY)
      .action(api.selectorOptions.commitCardChecklist, {
        selectorOptionId: leafId,
        sportId,
        cards: [
          card({ cardNumber: "1", cardName: "Row A", bscRef: "bsc-1" }),
          card({ cardNumber: "2", cardName: "Row B", slRef: "sl-2" }),
        ],
      });
    const rows = await storedRows(t, leafId);
    const rowA = rows.find((r) => r.platformData?.bsc?.ref === "bsc-1")!;
    const rowB = rows.find((r) => r.platformData?.sportlots?.ref === "sl-2")!;

    const result = await diff(t, leafId, [
      // One incoming card whose two refs point at two different NB rows.
      card({
        cardNumber: "1",
        cardName: "Contested",
        bscRef: "bsc-1",
        slRef: "sl-2",
      }),
    ]);

    expect(result.cards).toHaveLength(0);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toMatchObject({
      index: 0,
      cardNumber: "1",
      cardName: "Contested",
      bsc: { rowId: rowA._id, cardName: "Row A" },
      sportlots: { rowId: rowB._id, cardName: "Row B" },
    });
    // Contested rows are never offered for deletion — upstream still names
    // them, it is only unclear which row the name belongs to.
    expect(result.removedUpstream.fullyOrphaned).toHaveLength(0);
    expect(result.removedUpstream.partialOrphanCount).toBe(2);
  });
});

describe("diffChecklistAgainstExisting — removed upstream", () => {
  test("a row whose only linked side came back but no longer lists it is fully orphaned", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId } = await seedTree(t);
    await t
      .withIdentity(ADMIN_IDENTITY)
      .action(api.selectorOptions.commitCardChecklist, {
        selectorOptionId: leafId,
        sportId,
        cards: [
          card({ cardNumber: "1", cardName: "Still Here", bscRef: "bsc-1" }),
          card({ cardNumber: "2", cardName: "Delisted", bscRef: "bsc-2" }),
        ],
      });
    const rows = await storedRows(t, leafId);
    const gone = rows.find((r) => r.cardNumber === "2")!;

    const result = await diff(t, leafId, [
      card({ cardNumber: "1", cardName: "Still Here", bscRef: "bsc-1" }),
    ]);

    expect(result.removedUpstream.fullyOrphaned).toEqual([
      {
        id: gone._id,
        cardNumber: "2",
        cardName: "Delisted",
        sides: ["bsc"],
      },
    ]);
    expect(result.removedUpstream.partialOrphanCount).toBe(0);
  });

  test("a row linked to a side that produced no cards this sync is a PARTIAL orphan, never deletion-eligible", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId } = await seedTree(t);
    await t
      .withIdentity(ADMIN_IDENTITY)
      .action(api.selectorOptions.commitCardChecklist, {
        selectorOptionId: leafId,
        sportId,
        cards: [
          card({ cardNumber: "1", cardName: "BSC card", bscRef: "bsc-1" }),
          card({ cardNumber: "2", cardName: "SL card", slRef: "sl-2" }),
        ],
      });

    // SportLots failed this run: only BSC cards came back. The SL-linked row
    // must not be offered for deletion just because its marketplace was down.
    const result = await diff(t, leafId, [
      card({ cardNumber: "1", cardName: "BSC card", bscRef: "bsc-1" }),
    ]);

    expect(result.removedUpstream.fullyOrphaned).toHaveLength(0);
    expect(result.removedUpstream.partialOrphanCount).toBe(1);
  });

  test("a row still live on one of its two linked sides is matched, not orphaned", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId } = await seedTree(t);
    await t
      .withIdentity(ADMIN_IDENTITY)
      .action(api.selectorOptions.commitCardChecklist, {
        selectorOptionId: leafId,
        sportId,
        cards: [
          card({
            cardNumber: "1",
            cardName: "Cross listed",
            bscRef: "bsc-1",
            slRef: "sl-1",
          }),
          card({ cardNumber: "9", cardName: "Filler", bscRef: "bsc-9" }),
        ],
      });

    // BSC dropped the card; SportLots still lists it. Tier 1 matches on the
    // surviving ref, so this is an update, not a removal.
    const result = await diff(t, leafId, [
      card({ cardNumber: "1", cardName: "Cross listed", slRef: "sl-1" }),
      card({ cardNumber: "9", cardName: "Filler", bscRef: "bsc-9" }),
    ]);

    expect(result.removedUpstream.fullyOrphaned).toHaveLength(0);
    expect(result.cards.map((c) => c.bucket)).toEqual([
      "identical",
      "identical",
    ]);
  });

  test("custom cards are never reported as removed upstream", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId } = await seedTree(t);
    await t
      .withIdentity(ADMIN_IDENTITY)
      .action(api.selectorOptions.commitCardChecklist, {
        selectorOptionId: leafId,
        sportId,
        cards: [card({ cardNumber: "1", cardName: "Marketplace", bscRef: "bsc-1" })],
      });
    await t
      .withIdentity(ADMIN_IDENTITY)
      .mutation(api.selectorOptions.addCustomCard, {
        selectorOptionId: leafId,
        cardNumber: "9001",
        cardName: "Hand added",
      });

    const result = await diff(t, leafId, [
      card({ cardNumber: "1", cardName: "Marketplace", bscRef: "bsc-1" }),
    ]);

    expect(result.removedUpstream.fullyOrphaned).toHaveLength(0);
    expect(result.removedUpstream.partialOrphanCount).toBe(0);
  });
});

describe("diffChecklistAgainstExisting — access", () => {
  test("a non-admin cannot read the diff", async () => {
    const t = convexTest(schema, modules);
    const { leafId } = await seedTree(t);
    await expect(
      t
        .withIdentity(NON_ADMIN_IDENTITY)
        .query(api.selectorOptions.diffChecklistAgainstExisting, {
          selectorOptionId: leafId,
          cards: [],
        }),
    ).rejects.toThrow(/Admin access required/);
  });

  test("an anonymous caller cannot read the diff", async () => {
    const t = convexTest(schema, modules);
    const { leafId } = await seedTree(t);
    await expect(
      t.query(api.selectorOptions.diffChecklistAgainstExisting, {
        selectorOptionId: leafId,
        cards: [],
      }),
    ).rejects.toThrow(/Not authenticated/);
  });
});
