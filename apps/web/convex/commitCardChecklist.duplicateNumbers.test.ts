/**
 * NEO-189 — a checklist carrying the SAME card number twice is representable.
 *
 * ## Why this file exists
 *
 * `fetchBscChecklist` briefly deduped its fan-out by card number, first source
 * wins, justified as "a duplicate-numbered checklist is not representable,
 * because `commitCardChecklist` upserts by cardNumber". That justification is
 * what these tests check, because it decided whether real data was destroyed at
 * fetch time — and it was wrong.
 *
 * The upsert keys against rows ALREADY IN THE DATABASE: `existingByNumber` is
 * built from a `by_selector_option` query taken before the write loop, and rows
 * the loop itself inserts are never added to it. So a commit inserts one
 * `cardChecklist` row per incoming card, and Convex indexes carry no uniqueness
 * constraint. Two cards numbered #1 produce two rows.
 *
 * That matters beyond the abstract: BSC splits 1996 Score Dugout Collection
 * Artist's Proofs into Series 1 and Series 2 and numbers BOTH #1-110, so the
 * whole 220-card set is duplicate-numbered. `.maestro/flows/set-selector/
 * inserts-1996-score-one-nb-set-two-bsc-sources.yaml` asserts "Saved 220 cards"
 * end to end; this file is the fast, CI-cheap version of the same claim, so the
 * next person to consider a number-keyed merge does not have to run Maestro to
 * find out what commit actually does.
 *
 * ## KNOWN LIMITATION, deliberately not asserted here — RE-SYNC
 *
 * The insert path above is sound. The RE-sync path is not: on a second commit
 * `existingByNumber` holds one row per number, so both incoming #1s resolve to
 * the SAME stored row. One gets patched twice (the later card wins) and the
 * other stored row is left carrying stale data — `processedNumbers` contains
 * "1", so the stale-row sweep does not delete it either. The row count stays
 * right and the contents drift.
 *
 * This predates the dedup and is NOT what that dedup fixed — dropping at fetch
 * time hid the conflict from the operator instead of resolving it, and cost the
 * first sync its data too. The real fix is to key the upsert on the identity
 * the rest of this codebase already uses for a marketplace row —
 * `platformData.bsc.ref` / `platformData.sportlots.ref` (NEO-91: SportLots'
 * ref IS the description, precisely because its numbers repeat) — falling back
 * to cardNumber only for rows with no ref. That changes how every existing set
 * re-syncs, so it is its own ticket rather than a rider on a regression fix.
 *
 * No test pins the broken behaviour: a test asserting a defect fails the day
 * someone fixes it, which teaches exactly the wrong lesson.
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
  subject: "admin_dupnum_001",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_dupnum_001",
  name: "Admin User",
  role: "admin",
};

const S1 = "dugout-collection-artists-proofs-series-1";
const S2 = "dugout-collection-artists-proofs-series-2";

async function seedTree(t: ReturnType<typeof convexTest>) {
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
      value: "Score",
      platformData: {},
      features: { manufacturer: "Score", season: "1996" },
      parentId: sportId,
      children: [],
      lastUpdated: Date.now(),
    });
    const insertId = await ctx.db.insert("selectorOptions", {
      level: "insert",
      value: "Dugout Collection Artists Proofs",
      platformData: {},
      features: { manufacturer: "Score", season: "1996" },
      parentId: setNameId,
      children: [],
      lastUpdated: Date.now(),
    });
    return { sportId, insertId };
  });
}

/** One reconciled card as the commit wire carries it. */
function card(cardNumber: string, cardName: string, bscRef: string, setId: string) {
  return {
    cardNumber,
    cardName,
    team: undefined,
    teams: [],
    players: [cardName],
    attributes: [],
    isRookie: undefined,
    isRelic: undefined,
    printRun: undefined,
    autographType: undefined,
    cardVariation: undefined,
    isVariation: undefined,
    platformData: { bsc: { ref: bscRef, setId } },
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

describe("commitCardChecklist — two source sets sharing card numbers", () => {
  test("both #1s become their own row — the upsert does not collapse them", async () => {
    const t = convexTest(schema, modules);
    const { sportId, insertId } = await seedTree(t);

    const result = await t
      .withIdentity(ADMIN_IDENTITY)
      .mutation(api.selectorOptions.commitCardChecklist, {
        selectorOptionId: insertId,
        sportId,
        cards: [
          card("1", "Alice Series One", `${S1}-card-1`, S1),
          card("1", "Bob Series Two", `${S2}-card-1`, S2),
        ],
      });

    expect(result.success).toBe(true);
    expect(result.count).toBe(2);

    const rows = await storedRows(t, insertId);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.cardNumber).sort()).toEqual(["1", "1"]);
    // Two genuinely different cards, not one row written twice.
    expect(rows.map((r) => r.cardName).sort()).toEqual([
      "Alice Series One",
      "Bob Series Two",
    ]);
    // Each keeps its own marketplace identity — the thing that actually tells
    // two same-numbered cards apart everywhere downstream. (The stored shape is
    // `{ ref, src }`: the wire's `setId` is resolved to a SLOT on the parent
    // row by `resolveCardSlots`, and this fixture attaches no slots, so `src`
    // is legitimately absent here. Slot attribution has its own coverage in
    // fetchCardChecklist.facetSources.test.ts.)
    expect(rows.map((r) => r.platformData?.bsc?.ref).sort()).toEqual([
      `${S1}-card-1`,
      `${S2}-card-1`,
    ]);
    // SKUs are per-row, so two same-numbered cards are still individually
    // addressable downstream.
    expect(new Set(rows.map((r) => r.sku)).size).toBe(2);
  });

  test("a fully duplicate-numbered set commits every row (the 1996 Score shape)", async () => {
    // 220 cards over 110 numbers — every number twice, which is what BSC
    // actually returns for this set once both series are fetched. If commit
    // collapsed by number this would store 110 and CI's Maestro flow would be
    // asserting something the backend cannot do.
    const t = convexTest(schema, modules);
    const { sportId, insertId } = await seedTree(t);

    const cards = [];
    for (const [slug, label] of [
      [S1, "S1"],
      [S2, "S2"],
    ] as const) {
      for (let n = 1; n <= 110; n++) {
        cards.push(card(String(n), `Player ${label}-${n}`, `${slug}-card-${n}`, slug));
      }
    }

    const result = await t
      .withIdentity(ADMIN_IDENTITY)
      .mutation(api.selectorOptions.commitCardChecklist, {
        selectorOptionId: insertId,
        sportId,
        cards,
      });

    expect(result.count).toBe(220);

    const rows = await storedRows(t, insertId);
    expect(rows).toHaveLength(220);
    expect(new Set(rows.map((r) => r.cardNumber)).size).toBe(110);
    expect(new Set(rows.map((r) => r.platformData?.bsc?.ref)).size).toBe(220);
  });
});
