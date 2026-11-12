/**
 * NEO-496 — a re-sync of cards with no marketplace ref and NO number (a
 * publisher checklist's unnumbered section, kept as checklist-only cards)
 * updates them instead of inserting them again.
 *
 * Before: the ref-less tier ("noRef") keyed on the card number alone, so
 * every NNO card in a set shared one key, the exactly-one guard refused them
 * all, and each re-sync inserted the section a second time. Now a no-number
 * card keys on its number AND its folded card name (`noRefMatchKey`); a
 * numbered card keys exactly as before. Same guard: two no-number cards of
 * one name still match nothing (rule 7).
 *
 * Header (stubs, identities, seedTree, card, diff) copied from
 * convex/diffChecklistAgainstExisting.test.ts.
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { Id } from "./_generated/dataModel";
// NEO-251: the dedup key the commit resolves a name through. Imported rather
// than hand-spelled so a fixture cannot key a seeded player differently from
// the way the prelude will look it up.
import { normalizePlayerName } from "./players";
import { normalizeTeamName } from "./teams";
import { cancelScheduled, drainScheduled } from "../lib/testing/drain-scheduled";

beforeEach(() => {
  // NEO-188/NEO-247: commitCardChecklist can schedule a BSC per-card team
  // lookup (processBscTeamEnrichmentQueue) as a side effect. This file has
  // nothing to say about team resolution. A THROWING stub rather than a
  // canned 200 — same convention as
  // convex/cardChecklist.bscTeamEnrichment.test.ts's NEO-220 fix: the
  // adapter already swallows a request failure ("network unavailable" is a
  // state it handles), and it cannot write anything derived from a payload
  // this file invented.
  vi.stubGlobal(
    "fetch",
    (async (url: string | URL) => {
      throw new Error(
        `NEO-247: this test file must not reach the network: ${String(url)}`,
      );
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
  subject: "admin_nno_496",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_nno_496",
  name: "Admin User",
  role: "admin",
};

const NON_ADMIN_IDENTITY = {
  subject: "user_nno_496",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|user_nno_496",
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
  // NEO-251: what the two marketplaces each said, when they disagreed. Carried
  // on the wire so the diff can tell "the operator settled this" apart from
  // "upstream changed it".
  playersConflict?: {
    bsc: string[];
    sportlots: string[];
    preferred?: "bsc" | "sportlots";
  };
  nameConflict?: { bsc: string; sportlots: string };
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
    // Spread, not always-present-and-undefined: `previewCardValidator` is
    // strict and an explicit `undefined` is not an absent optional.
    ...(opts.playersConflict ? { playersConflict: opts.playersConflict } : {}),
    ...(opts.nameConflict ? { nameConflict: opts.nameConflict } : {}),
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


async function commit(
  t: ReturnType<typeof convexTest>,
  ids: { sportId: Id<"selectorOptions">; leafId: Id<"selectorOptions"> },
  cards: ReturnType<typeof card>[],
) {
  return t.withIdentity(ADMIN_IDENTITY).action(api.selectorOptions.commitCardChecklist, {
    selectorOptionId: ids.leafId,
    sportId: ids.sportId,
    cards,
  });
}

describe("NEO-496: ref-less no-number cards match by number + name", () => {
  test("a section of NNO cards committed twice is stored once", async () => {
    const t = convexTest(schema, modules);
    const ids = await seedTree(t);
    const cards = [
      card({ cardNumber: "NNO", cardName: "Alice Ace" }),
      card({ cardNumber: "NNO", cardName: "Bob Bat" }),
      card({ cardNumber: "", cardName: "Cy Catch" }),
    ];
    await commit(t, ids, cards);
    expect(await storedRows(t, ids.leafId)).toHaveLength(3);

    const result = await diff(t, ids.leafId, cards);
    expect(result.cards.map((c) => c.bucket)).toEqual(["identical", "identical", "identical"]);

    await commit(t, ids, cards);
    const rows = await storedRows(t, ids.leafId);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.cardName).sort()).toEqual(["Alice Ace", "Bob Bat", "Cy Catch"]);
    await drainScheduled(t);
    await cancelScheduled(t);
  });

  test("the name is folded: case and punctuation do not split a card", async () => {
    const t = convexTest(schema, modules);
    const ids = await seedTree(t);
    await commit(t, ids, [card({ cardNumber: "NNO", cardName: "Ken Griffey Jr." })]);
    const result = await diff(t, ids.leafId, [card({ cardNumber: "NNO", cardName: "KEN GRIFFEY JR" })]);
    expect(result.cards[0].bucket).not.toBe("new");
    await drainScheduled(t);
    await cancelScheduled(t);
  });

  test("two stored NNO cards of one name: an incoming one matches neither (exactly-one guard)", async () => {
    const t = convexTest(schema, modules);
    const ids = await seedTree(t);
    await commit(t, ids, [
      card({ cardNumber: "NNO", cardName: "Alice Ace" }),
      card({ cardNumber: "NNO", cardName: "Alice Ace" }),
    ]);
    expect(await storedRows(t, ids.leafId)).toHaveLength(2);
    const result = await diff(t, ids.leafId, [card({ cardNumber: "NNO", cardName: "Alice Ace" })]);
    expect(result.cards[0].bucket).toBe("new");
    await drainScheduled(t);
    await cancelScheduled(t);
  });

  test("a numbered ref-less card still keys on its number alone (unchanged)", async () => {
    const t = convexTest(schema, modules);
    const ids = await seedTree(t);
    await commit(t, ids, [card({ cardNumber: "7", cardName: "Alice Ace" })]);
    const result = await diff(t, ids.leafId, [card({ cardNumber: "7", cardName: "Alicia Ace" })]);
    expect(result.cards[0].bucket).not.toBe("new");
    await commit(t, ids, [card({ cardNumber: "7", cardName: "Alicia Ace" })]);
    expect(await storedRows(t, ids.leafId)).toHaveLength(1);
    await drainScheduled(t);
    await cancelScheduled(t);
  });
});
