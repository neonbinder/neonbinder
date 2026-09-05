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

// ---------------------------------------------------------------------------
// CI round 2 — "absent" has five spellings, and the edit drawer writes three of
// them explicitly.
// ---------------------------------------------------------------------------

describe("diffChecklistAgainstExisting — explicitly-empty stored values", () => {
  /** What saving a card in the edit drawer leaves on the row. */
  async function simulateOperatorSave(
    t: ReturnType<typeof convexTest>,
    id: Id<"cardChecklist">,
  ) {
    await t.run(async (ctx) => {
      await ctx.db.patch(id, {
        isRookie: false,
        isRelic: false,
        cardVariation: "",
      });
    });
  }

  test("an explicit false/empty-string on the row is NOT a change against an absent incoming value", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId } = await seedTree(t);
    await t
      .withIdentity(ADMIN_IDENTITY)
      .action(api.selectorOptions.commitCardChecklist, {
        selectorOptionId: leafId,
        sportId,
        cards: [card({ cardNumber: "1", cardName: "Curated", bscRef: "bsc-1" })],
      });
    const [row] = await storedRows(t, leafId);
    await simulateOperatorSave(t, row._id);

    // The adapters simply omit these keys on a card that is none of those
    // things. Before this fix the operator's own save came back as three
    // tier-1 "needs review" diffs on the next sync — the review screen shouted
    // loudest about the cards a human had already got right.
    const result = await diff(t, leafId, [
      card({ cardNumber: "1", cardName: "Curated", bscRef: "bsc-1" }),
    ]);

    expect(result.cards).toHaveLength(1);
    expect(result.cards[0].fields).toEqual([]);
    expect(result.cards[0].bucket).toBe("identical");
  });

  test("no field entry is ever emitted for a pair that both render as empty", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId } = await seedTree(t);
    await t
      .withIdentity(ADMIN_IDENTITY)
      .action(api.selectorOptions.commitCardChecklist, {
        selectorOptionId: leafId,
        sportId,
        cards: [card({ cardNumber: "1", cardName: "Curated", bscRef: "bsc-1" })],
      });
    const [row] = await storedRows(t, leafId);
    await simulateOperatorSave(t, row._id);

    // The defect this pins: `cardVariation: ""` vs absent rendered as
    // `− —` / `+ —`, folded equal, pre-ticked itself, and made the footer
    // claim "1 change will be applied" for a change that did not exist. A
    // no-op entry must not reach the screen AT ALL — suppressing it at the
    // render layer would leave the footer's count lying.
    const result = await diff(t, leafId, [
      card({
        cardNumber: "1",
        cardName: "Curated",
        bscRef: "bsc-1",
        // A real, substantive change, so the card IS reviewable — which is
        // what makes the absence of the other entries meaningful.
        printRun: 99,
      }),
    ]);

    const names = result.cards[0].fields.map((f) => f.name);
    expect(names).toEqual(["printRun"]);
    expect(
      result.cards[0].fields.every((f) => f.oldValue !== "" || f.newValue !== ""),
    ).toBe(true);
  });

  test("a real true→absent change on the same field is still reported and still applies", async () => {
    // The counterpart guard: widening "empty" must not swallow a genuine
    // clearing. `true` is not emptyish, so this stays a change.
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
            cardName: "Was a rookie",
            bscRef: "bsc-1",
            isRookie: true,
          }),
        ],
      });
    const [row] = await storedRows(t, leafId);

    const result = await diff(t, leafId, [
      card({ cardNumber: "1", cardName: "Was a rookie", bscRef: "bsc-1" }),
    ]);
    const entry = result.cards[0];
    expect(entry.fields.map((f) => f.name)).toEqual(["isRookie"]);
    expect(entry.fields[0]).toMatchObject({ oldValue: "yes", newValue: "" });

    await t
      .withIdentity(ADMIN_IDENTITY)
      .action(api.selectorOptions.commitCardChecklist, {
        selectorOptionId: leafId,
        sportId,
        cards: [
          {
            ...card({ cardNumber: "1", cardName: "Was a rookie", bscRef: "bsc-1" }),
            applyFields: ["isRookie"],
            baseVersion: entry.baseVersion,
          },
        ],
      });
    expect((await storedRows(t, leafId))[0].isRookie).toBeUndefined();
    expect(row.isRookie).toBe(true);
  });

  test("the chunk's pre-write re-diff agrees: accepting a false→absent field writes nothing", async () => {
    // The same predicate guards both ends of the wire. If they disagreed, a
    // field the review declined to show could still be written by the commit.
    const t = convexTest(schema, modules);
    const { sportId, leafId } = await seedTree(t);
    await t
      .withIdentity(ADMIN_IDENTITY)
      .action(api.selectorOptions.commitCardChecklist, {
        selectorOptionId: leafId,
        sportId,
        cards: [card({ cardNumber: "1", cardName: "Curated", bscRef: "bsc-1" })],
      });
    const [row] = await storedRows(t, leafId);
    await simulateOperatorSave(t, row._id);
    const saved = (await storedRows(t, leafId))[0];

    await t
      .withIdentity(ADMIN_IDENTITY)
      .action(api.selectorOptions.commitCardChecklist, {
        selectorOptionId: leafId,
        sportId,
        cards: [
          {
            ...card({ cardNumber: "1", cardName: "Curated", bscRef: "bsc-1" }),
            // A hostile or stale client naming them anyway changes nothing.
            applyFields: ["isRookie", "isRelic", "cardVariation"],
            baseVersion: saved.lastUpdated,
          },
        ],
      });

    const after = (await storedRows(t, leafId))[0];
    expect(after.isRookie).toBe(false);
    expect(after.isRelic).toBe(false);
    expect(after.cardVariation).toBe("");
  });
});

// ---------------------------------------------------------------------------
// CI round 2 — ambiguity that exists vs ambiguity that cost something.
// ---------------------------------------------------------------------------

/**
 * NEO-217 — `autographType` is no longer an NB content field.
 *
 * `features.autographed` is the one truth for "this card is an autograph": it
 * is what the listing title and description read, what the drawer edits, and
 * what `deriveCardObservedFeatures` still derives FROM the incoming
 * `autographType` at insert. The raw column stays on legacy rows and stays on
 * the wire, but it is no longer displayed or diffed — the marketplace signal
 * is information-free (BSC never sends it, SportLots sends the literal
 * "Unknown"), so a tier-1 diff on it could only ever offer `− — / + Unknown`,
 * which is pure noise on a review screen whose whole job is to be believed.
 */
describe("diffChecklistAgainstExisting — autographType is not diffed (NEO-217)", () => {
  test("a legacy stored autographType against an incoming card that carries none is not a field entry", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId } = await seedTree(t);
    await t
      .withIdentity(ADMIN_IDENTITY)
      .action(api.selectorOptions.commitCardChecklist, {
        selectorOptionId: leafId,
        sportId,
        cards: [card({ cardNumber: "1", cardName: "Curated", bscRef: "bsc-1" })],
      });
    const [row] = await storedRows(t, leafId);
    // Stand in for a row written before NEO-217 stopped storing it.
    await t.run(async (ctx) => {
      await ctx.db.patch(row._id, { autographType: "Unknown" });
    });

    const result = await diff(t, leafId, [
      card({ cardNumber: "1", cardName: "Curated", bscRef: "bsc-1" }),
    ]);

    expect(result.cards[0].fields).toEqual([]);
    expect(result.cards[0].bucket).toBe("identical");
  });

  test("an incoming autographType against a row that has none is not a field entry either", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId } = await seedTree(t);
    await t
      .withIdentity(ADMIN_IDENTITY)
      .action(api.selectorOptions.commitCardChecklist, {
        selectorOptionId: leafId,
        sportId,
        cards: [card({ cardNumber: "1", cardName: "Curated", bscRef: "bsc-1" })],
      });

    const result = await diff(t, leafId, [
      card({
        cardNumber: "1",
        cardName: "Curated",
        bscRef: "bsc-1",
        autographType: "Unknown",
        // A real change, so the card IS reviewable — which is what makes the
        // absence of an `autographType` entry meaningful rather than vacuous.
        printRun: 99,
      }),
    ]);

    expect(result.cards[0].fields.map((f) => f.name)).toEqual(["printRun"]);
  });
});

describe("diffChecklistAgainstExisting — ambiguity is only reported when it changed an outcome", () => {
  /**
   * The 1996 Score shape: ONE SportLots set holds both series, so two distinct
   * cards land on the same `(side, slot, cardNumber)` fallback key. That key is
   * withheld as ambiguous — correctly — but both cards carry their own ref.
   */
  async function seedSharedSlot(t: ReturnType<typeof convexTest>) {
    const { sportId, leafId } = await seedTree(t, {
      slSlots: { s0: "sl-combined" },
    });
    await t
      .withIdentity(ADMIN_IDENTITY)
      .action(api.selectorOptions.commitCardChecklist, {
        selectorOptionId: leafId,
        sportId,
        cards: [
          card({
            cardNumber: "1",
            cardName: "Series One #1",
            slRef: "sl-s1-1",
            slSetId: "sl-combined",
          }),
          card({
            cardNumber: "1",
            cardName: "Series Two #1",
            slRef: "sl-s2-1",
            slSetId: "sl-combined",
          }),
        ],
      });
    return { sportId, leafId };
  }

  test("ambiguous fallback keys with every card ref-matched report NOTHING", async () => {
    const t = convexTest(schema, modules);
    const { leafId } = await seedSharedSlot(t);

    const result = await diff(t, leafId, [
      card({
        cardNumber: "1",
        cardName: "Series One #1",
        slRef: "sl-s1-1",
        slSetId: "sl-combined",
      }),
      card({
        cardNumber: "1",
        cardName: "Series Two #1",
        slRef: "sl-s2-1",
        slSetId: "sl-combined",
      }),
    ]);

    // The regression: the screen used to announce "N match keys are held by
    // more than one card, so those cards are treated as new" beside "0 new".
    // The fallback tier was never consulted — every card matched on its ref —
    // so nothing was treated as new and there is nothing to report.
    expect(result.ambiguityBlockedCount).toBe(0);
    expect(result.cards.every((c) => c.bucket === "identical")).toBe(true);
    expect(result.cards.some((c) => c.bucket === "new")).toBe(false);
  });

  test("a card that ambiguity actually cost a match IS counted", async () => {
    const t = convexTest(schema, modules);
    const { leafId } = await seedSharedSlot(t);

    const result = await diff(t, leafId, [
      card({
        cardNumber: "1",
        // A SportLots description edit changes the ref (NEO-91), so tier 1
        // misses and the cascade falls through to the slot+number tier — which
        // is exactly the key two stored rows share. No guess is made.
        cardName: "Series One #1",
        slRef: "sl-s1-1-description-was-corrected",
        slSetId: "sl-combined",
      }),
    ]);

    expect(result.ambiguityBlockedCount).toBe(1);
    expect(result.cards.map((c) => c.bucket)).toEqual(["new"]);
  });

  test("a genuinely new card is not blamed on ambiguity", async () => {
    const t = convexTest(schema, modules);
    const { leafId } = await seedSharedSlot(t);

    const result = await diff(t, leafId, [
      card({
        cardNumber: "500",
        cardName: "Brand New",
        slRef: "sl-500",
        slSetId: "sl-combined",
      }),
    ]);

    expect(result.cards.map((c) => c.bucket)).toEqual(["new"]);
    expect(result.ambiguityBlockedCount).toBe(0);
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

  test("a card no marketplace claims is never reported as removed upstream", async () => {
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

    // NEO-239 — and not as a PARTIAL orphan either. The hand-added row has no
    // ref on either side, so upstream's silence about it is not evidence of
    // anything; it is not an orphan of any degree. Keyed on the refs the row
    // carries, not on who created it.
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
