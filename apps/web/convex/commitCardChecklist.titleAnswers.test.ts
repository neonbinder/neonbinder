/**
 * NEO-335 — a NEW card's title, answered on the wizard's "Card titles" step
 * before save, written at commit.
 *
 * Three answers reach `commitCardChecklist` on a preview card:
 *
 *  - `listingTitle` — the operator's own title, written verbatim, never
 *    flagged cut short. Over LISTING_TITLE_MAX refuses the commit before any
 *    phase writes (the same cap `updateCard` holds an edit to).
 *  - `listingTitleKept` — the operator kept the trimmed title. The server
 *    still generates it; it just does not flag it.
 *  - `cardVariationAnswered` — `cardVariation` is the operator's trim, held
 *    to ASPECT_VALUE_MAX and stored trimmed.
 *
 * Absent, every card commits exactly as before. A card that re-syncs a stored
 * row ignores the title answer (titles are asked on new rows only).
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Doc, Id } from "./_generated/dataModel";
import { cancelScheduled, drainScheduled } from "../lib/testing/drain-scheduled";
import { ASPECT_VALUE_MAX, LISTING_TITLE_MAX } from "./features/listingLimits";

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    (async (url: string | URL) => {
      throw new Error(`NEO-335: this test file must not reach the network: ${String(url)}`);
    }) as unknown as typeof fetch,
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN_IDENTITY = {
  subject: "admin_titleanswers_001",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_titleanswers_001",
  name: "Admin User",
  role: "admin",
};

type T = ReturnType<typeof convexTest>;

/** A set name long enough that every card's title core is cut. */
const LONG_SET_NAME =
  "Chrome Update Series Sapphire Edition Platinum Anniversary Collectors Box Hobby Exclusive";

async function seedTree(
  t: T,
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
      value: LONG_SET_NAME,
      platformData: {},
      features: { manufacturer: "Topps", season: "2026" },
      parentId: sportId,
      children: [],
      lastUpdated: Date.now(),
    });
    const leafId = await ctx.db.insert("selectorOptions", {
      level: "variantType",
      value: "Base",
      platformData: {},
      features: { manufacturer: "Topps", season: "2026" },
      parentId: setNameId,
      children: [],
      lastUpdated: Date.now(),
    });
    return { sportId, leafId };
  });
}

/** A SportLots-only card: no BSC ref, so nothing is queued for a team lookup. */
function card(opts: {
  cardNumber: string;
  slRef?: string;
  cardVariation?: string;
  listingTitle?: string;
  listingTitleKept?: true;
  cardVariationAnswered?: true;
}) {
  return {
    cardNumber: opts.cardNumber,
    cardName: `Card ${opts.cardNumber}`,
    teams: [],
    players: [],
    platformData: { sportlots: { ref: opts.slRef ?? `SL-${opts.cardNumber}` } },
    ...(opts.cardVariation !== undefined ? { cardVariation: opts.cardVariation } : {}),
    ...(opts.listingTitle !== undefined ? { listingTitle: opts.listingTitle } : {}),
    ...(opts.listingTitleKept ? { listingTitleKept: opts.listingTitleKept } : {}),
    ...(opts.cardVariationAnswered ? { cardVariationAnswered: opts.cardVariationAnswered } : {}),
  };
}

async function rowsByNumber(
  t: T,
  leafId: Id<"selectorOptions">,
): Promise<Map<string, Doc<"cardChecklist">>> {
  const rows = await t.run(async (ctx) =>
    ctx.db
      .query("cardChecklist")
      .withIndex("by_selector_option", (q) => q.eq("selectorOptionId", leafId))
      .collect(),
  );
  return new Map(rows.map((r) => [r.cardNumber, r]));
}

async function commit(
  t: T,
  ids: { sportId: Id<"selectorOptions">; leafId: Id<"selectorOptions"> },
  cards: ReturnType<typeof card>[],
) {
  return t.withIdentity(ADMIN_IDENTITY).action(api.selectorOptions.commitCardChecklist, {
    selectorOptionId: ids.leafId,
    sportId: ids.sportId,
    cards,
  });
}

async function settle(t: T) {
  await drainScheduled(t);
  await cancelScheduled(t);
}

describe("commitCardChecklist — the 'Card titles' answers (NEO-335)", () => {
  test("no answer: the generated title, flagged cut short — exactly as before", async () => {
    const t = convexTest(schema, modules);
    const ids = await seedTree(t);
    await commit(t, ids, [card({ cardNumber: "1" })]);
    const row = (await rowsByNumber(t, ids.leafId)).get("1")!;
    expect(row.listingTitleTruncated).toBe(true);
    expect(row.listingTitle!.length).toBeLessThanOrEqual(LISTING_TITLE_MAX);
    expect(row.listingTitle).toMatch(/#1$|#1 /);
    await settle(t);
  });

  test("kept: the same generated title, not flagged", async () => {
    const t = convexTest(schema, modules);
    const ids = await seedTree(t);
    await commit(t, ids, [card({ cardNumber: "1" }), card({ cardNumber: "2", listingTitleKept: true })]);
    const rows = await rowsByNumber(t, ids.leafId);
    const plain = rows.get("1")!;
    const kept = rows.get("2")!;
    expect(kept.listingTitle).toBe(plain.listingTitle!.replace("#1", "#2"));
    expect(kept.listingTitleTruncated).toBeUndefined();
    await settle(t);
  });

  test("their own title: written trimmed and verbatim, not flagged", async () => {
    const t = convexTest(schema, modules);
    const ids = await seedTree(t);
    await commit(t, ids, [
      card({ cardNumber: "1", listingTitle: "  2026 Topps Chrome Update Sapphire #1 Baseball  " }),
    ]);
    const row = (await rowsByNumber(t, ids.leafId)).get("1")!;
    expect(row.listingTitle).toBe("2026 Topps Chrome Update Sapphire #1 Baseball");
    expect(row.listingTitleTruncated).toBeUndefined();
    await settle(t);
  });

  test("a title over the cap refuses the WHOLE commit before anything is written", async () => {
    const t = convexTest(schema, modules);
    const ids = await seedTree(t);
    await expect(
      commit(t, ids, [
        card({ cardNumber: "1" }),
        card({ cardNumber: "2", listingTitle: "t".repeat(LISTING_TITLE_MAX + 1) }),
      ]),
    ).rejects.toThrow(/card #2: the title is 81 characters; the limit is 80/);
    expect((await rowsByNumber(t, ids.leafId)).size).toBe(0);
    await settle(t);
  });

  test("a blank title is no answer: generated and flagged as before", async () => {
    const t = convexTest(schema, modules);
    const ids = await seedTree(t);
    await commit(t, ids, [card({ cardNumber: "1", listingTitle: "   " })]);
    expect((await rowsByNumber(t, ids.leafId)).get("1")!.listingTitleTruncated).toBe(true);
    await settle(t);
  });

  test("an answered variation is stored trimmed; one over the aspect cap refuses the commit", async () => {
    const t = convexTest(schema, modules);
    const ids = await seedTree(t);
    await commit(t, ids, [
      card({ cardNumber: "1", cardVariation: "  Sliding  ", cardVariationAnswered: true }),
    ]);
    expect((await rowsByNumber(t, ids.leafId)).get("1")!.cardVariation).toBe("Sliding");

    await expect(
      commit(t, ids, [
        card({
          cardNumber: "2",
          cardVariation: "v".repeat(ASPECT_VALUE_MAX + 1),
          cardVariationAnswered: true,
        }),
      ]),
    ).rejects.toThrow(/card #2: the variation is 66 characters; the limit is 65/);
    await settle(t);
  });

  test("an UNanswered over-long variation still commits (warn-only, unchanged)", async () => {
    const t = convexTest(schema, modules);
    const ids = await seedTree(t);
    const long = "v".repeat(ASPECT_VALUE_MAX + 5);
    await commit(t, ids, [card({ cardNumber: "1", cardVariation: long })]);
    expect((await rowsByNumber(t, ids.leafId)).get("1")!.cardVariation).toBe(long);
    await settle(t);
  });

  test("a card that re-syncs a stored row ignores the title answer", async () => {
    const t = convexTest(schema, modules);
    const ids = await seedTree(t);
    await commit(t, ids, [card({ cardNumber: "1", slRef: "SL-A" })]);
    const before = (await rowsByNumber(t, ids.leafId)).get("1")!;

    await commit(t, ids, [card({ cardNumber: "1", slRef: "SL-A", listingTitle: "Something else #1" })]);
    const after = (await rowsByNumber(t, ids.leafId)).get("1")!;
    expect(after._id).toBe(before._id);
    expect(after.listingTitle).toBe(before.listingTitle);
    expect(after.listingTitleTruncated).toBe(true);
    await settle(t);
  });
});
