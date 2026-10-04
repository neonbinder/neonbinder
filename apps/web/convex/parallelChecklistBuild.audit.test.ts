/**
 * NEO-321 security audit — S1 (a source that moves mid-build), S2 (the Base
 * lookup fails closed past its cap) and N1 (every card read is bounded by
 * bytes, so a fat Base cannot hit the 16 MiB read limit as a raw error).
 *
 * Same adapter mocks as `parallelChecklistBuild.test.ts`. S1 also wraps
 * `deleteCardPlayerLinks`, which `deleteParallelCardsPage` calls for every
 * card it deletes, so a test can move `isBase` INSIDE the delete transaction:
 * exactly "between the delete and the insert".
 */

import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import {
  BLOCKED_CHANGED_MID_BUILD,
  BLOCKED_CHANGED_NOTHING_CLEARED,
  blockedChangedMidBuild,
  BLOCKED_TOO_MANY_CARDS,
  BLOCKED_TOO_MANY_VARIANT_TYPES,
  MAX_CARD_BYTES_FOR_BUILD,
  MAX_VARIANT_TYPES_PER_SET,
  READ_BYTES_RESERVE,
} from "./parallelChecklistBuild";

const modules = (
  import.meta as unknown as {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("./**/*.*s");

const ADMIN = {
  subject: "admin_neo321_audit",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_neo321_audit",
  role: "admin",
};

const SENTINEL = 1_700_000_000_000;

const bscState = vi.hoisted(() => ({
  cards: [] as Array<{ cardNumber: string; cardName: string; platformRef: string }>,
  calls: 0,
  /** One-shot, run while the action awaits the fetch (before any write). */
  onFetch: null as null | (() => Promise<void>),
}));
vi.mock("./adapters/buysportscards", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./adapters/buysportscards")>();
  const { action } = await import("./_generated/server");
  const { v } = await import("convex/values");
  return {
    ...actual,
    fetchBscChecklist: action({
      args: {
        parentFilters: v.record(v.string(), v.string()),
        platformFilters: v.optional(v.record(v.string(), v.array(v.string()))),
        facetFilters: v.optional(v.record(v.string(), v.array(v.string()))),
        sourceFacet: v.optional(v.string()),
      },
      returns: v.any(),
      handler: async () => {
        bscState.calls++;
        const hook = bscState.onFetch;
        if (hook) {
          bscState.onFetch = null;
          await hook();
        }
        return { success: true, cards: bscState.cards };
      },
    }),
  };
});

/** S1 — run once, inside the first delete transaction, after a card goes. */
const deleteHook = vi.hoisted(() => ({
  once: null as null | ((ctx: MutationCtx) => Promise<void>),
}));
vi.mock("./cardPlayerLinks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./cardPlayerLinks")>();
  return {
    ...actual,
    deleteCardPlayerLinks: async (
      ctx: MutationCtx,
      cardId: Id<"cardChecklist">,
    ) => {
      await actual.deleteCardPlayerLinks(ctx, cardId);
      const hook = deleteHook.once;
      if (hook) {
        deleteHook.once = null;
        await hook(ctx);
      }
    },
  };
});

beforeEach(() => {
  bscState.cards = [];
  bscState.calls = 0;
  bscState.onFetch = null;
  deleteHook.once = null;
});

type T = ReturnType<typeof convexTest>;

/** sport → year → setName ─┬─ "Base" (isBase) └─ "Parallel" → "Gold Wave". BSC only. */
async function seedSet(t: T) {
  return t.run(async (ctx) => {
    const sport = await ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Baseball",
      platformData: { bsc: { b0: "baseball" } },
      children: [],
      lastUpdated: SENTINEL,
    });
    const year = await ctx.db.insert("selectorOptions", {
      level: "year",
      value: "2024",
      parentId: sport,
      platformData: { bsc: { b0: "2024" } },
      children: [],
      lastUpdated: SENTINEL,
    });
    const setName = await ctx.db.insert("selectorOptions", {
      level: "setName",
      value: "Topps Chrome",
      parentId: year,
      platformData: { bsc: { b0: "topps-chrome" } },
      children: [],
      lastUpdated: SENTINEL,
    });
    const base = await ctx.db.insert("selectorOptions", {
      level: "variantType",
      value: "Base",
      parentId: setName,
      platformData: { bsc: { b0: "base" } },
      platformFacets: { bsc: { b0: "variant" } },
      metadata: { isBase: true },
      children: [],
      lastUpdated: SENTINEL,
    });
    const parallelType = await ctx.db.insert("selectorOptions", {
      level: "variantType",
      value: "Parallel",
      parentId: setName,
      platformData: { bsc: { b0: "parallel" } },
      platformFacets: { bsc: { b0: "variant" } },
      metadata: { variantRole: "parallel" },
      children: [],
      lastUpdated: SENTINEL,
    });
    const gold = await ctx.db.insert("selectorOptions", {
      level: "insert",
      value: "Gold Wave",
      parentId: parallelType,
      platformData: { bsc: { b0: "gold-wave" } },
      platformFacets: { bsc: { b0: "variantName" } },
      metadata: { isParallel: true },
      children: [],
      lastUpdated: SENTINEL,
    });
    await ctx.db.patch(parallelType, { children: [gold] });
    return { setName, base, parallelType, gold };
  });
}

async function addCard(
  t: T,
  selectorOptionId: Id<"selectorOptions">,
  card: Partial<Doc<"cardChecklist">> & { cardNumber: string; cardName: string },
) {
  return t.run(async (ctx) =>
    ctx.db.insert("cardChecklist", {
      selectorOptionId,
      platformData: {},
      sortOrder: 0,
      lastUpdated: SENTINEL,
      ...card,
    }),
  );
}

const cardsOn = (t: T, selectorOptionId: Id<"selectorOptions">) =>
  t.run(async (ctx) =>
    ctx.db
      .query("cardChecklist")
      .withIndex("by_selector_option", (q) => q.eq("selectorOptionId", selectorOptionId))
      .collect(),
  );

/** A string of `kb` kilobytes, to give a row real weight in the read budget. */
const heavy = (kb: number) => "x".repeat(kb * 1024);

/** `count` Base cards of ~`kb` KB each, inserted in batches under the write limit. */
async function addHeavyCards(
  t: T,
  selectorOptionId: Id<"selectorOptions">,
  count: number,
  kb: number,
) {
  const perBatch = Math.max(1, Math.floor((6 * 1024) / kb));
  for (let start = 0; start < count; start += perBatch) {
    await t.run(async (ctx) => {
      for (let i = start; i < Math.min(count, start + perBatch); i++) {
        await ctx.db.insert("cardChecklist", {
          selectorOptionId,
          cardNumber: String(i + 1),
          cardName: `Player ${i + 1}`,
          platformData: {},
          sortOrder: i,
          lastUpdated: SENTINEL,
          // Never copied: a copy's listing text is generated fresh.
          listingDescription: heavy(kb),
        });
      }
    });
  }
}

describe("S1 — isBase moved between the delete and the insert", () => {
  test("the insert page answers `changed`, and the build reports the partial wipe with its lost links", async () => {
    const t = convexTest(schema, modules);
    const { setName, base, gold } = await seedSet(t);
    await addCard(t, base, { cardNumber: "1", cardName: "Aaron Judge" });
    // The parallel's old card, linked to the card the fetch still lists.
    await addCard(t, gold, {
      cardNumber: "1",
      cardName: "Aaron Judge",
      platformData: { bsc: { ref: "bsc-1", src: "b0" } },
    });
    bscState.cards = [{ cardNumber: "1", cardName: "Aaron Judge", platformRef: "bsc-1" }];

    // Inside the delete transaction: the operator marks another type the Base.
    deleteHook.once = async (ctx) => {
      await ctx.db.patch(base, { metadata: {} });
      await ctx.db.insert("selectorOptions", {
        level: "variantType",
        value: "Base Too",
        parentId: setName,
        platformData: {},
        metadata: { isBase: true },
        children: [],
        lastUpdated: SENTINEL,
      });
    };

    const result = await t
      .withIdentity(ADMIN)
      .action(api.parallelChecklistBuild.buildParallelChecklist, { parallelId: gold });

    expect(deleteHook.once).toBeNull(); // the hook really ran
    expect(result.status).toBe("blocked");
    expect(result.blockedReason).toBe(BLOCKED_CHANGED_MID_BUILD);
    expect(result.deletedCount).toBe(1);
    expect(result.stillListedNotRelinked.bsc).toBe(1);
    // Nothing was copied from the Base that is no longer the Base.
    expect(await cardsOn(t, gold)).toHaveLength(0);
  });
});

describe("the changed-mid-build sentence is true to what was removed", () => {
  test("it claims cards were cleared only when some were", () => {
    expect(blockedChangedMidBuild(3)).toBe(BLOCKED_CHANGED_MID_BUILD);
    expect(blockedChangedMidBuild(0)).toBe(BLOCKED_CHANGED_NOTHING_CLEARED);
    expect(BLOCKED_CHANGED_NOTHING_CLEARED).not.toMatch(/clear/i);
  });

  test("the partial-wipe sentence leaves the count and the instruction to the client", () => {
    // ParallelBuildPanel's `blockedText` appends ", after N old cards were
    // removed — build it again"; a second instruction or a second word for
    // the removal here would read twice on the same line.
    expect(BLOCKED_CHANGED_MID_BUILD).toBe("its cards changed partway through the rebuild");
    expect(BLOCKED_CHANGED_MID_BUILD).not.toMatch(/build it again|clear|remov/i);
    // With nothing removed there is no client clause, so this one says it.
    expect(BLOCKED_CHANGED_NOTHING_CLEARED.match(/build it again/g)).toHaveLength(1);
  });

  test("a first build whose Base moves during the fetch says nothing was cleared", async () => {
    const t = convexTest(schema, modules);
    const { setName, base, gold } = await seedSet(t);
    await addCard(t, base, { cardNumber: "1", cardName: "Aaron Judge" });
    bscState.cards = [{ cardNumber: "1", cardName: "Aaron Judge", platformRef: "bsc-1" }];
    // The parallel holds no cards, so nothing is ever deleted; the move lands
    // after the context read and before the first insert page.
    bscState.onFetch = async () => {
      await t.run(async (ctx) => {
        await ctx.db.patch(base, { metadata: {} });
        await ctx.db.insert("selectorOptions", {
          level: "variantType",
          value: "Base Too",
          parentId: setName,
          platformData: {},
          metadata: { isBase: true },
          children: [],
          lastUpdated: SENTINEL,
        });
      });
    };

    const result = await t
      .withIdentity(ADMIN)
      .action(api.parallelChecklistBuild.buildParallelChecklist, { parallelId: gold });

    expect(bscState.onFetch).toBeNull(); // the hook really ran
    expect(result.status).toBe("blocked");
    expect(result.blockedReason).toBe(BLOCKED_CHANGED_NOTHING_CLEARED);
    expect(result.deletedCount).toBe(0);
    expect(await cardsOn(t, gold)).toHaveLength(0);
  });
});

describe("S2 — the Base lookup fails closed past its variant-type cap", () => {
  async function addVariantTypes(t: T, setName: Id<"selectorOptions">, count: number) {
    await t.run(async (ctx) => {
      for (let i = 0; i < count; i++) {
        await ctx.db.insert("selectorOptions", {
          level: "variantType",
          value: `Extra ${i}`,
          parentId: setName,
          platformData: {},
          children: [],
          lastUpdated: SENTINEL,
        });
      }
    });
  }

  test("one past the cap: the list says why and the build is refused, nothing fetched", async () => {
    const t = convexTest(schema, modules);
    const { setName, base, parallelType, gold } = await seedSet(t);
    await addCard(t, base, { cardNumber: "1", cardName: "Aaron Judge" });
    // Base + Parallel + extras = cap + 1.
    await addVariantTypes(t, setName, MAX_VARIANT_TYPES_PER_SET - 1);

    const list = await t
      .withIdentity(ADMIN)
      .query(api.parallelChecklistBuild.getParallelsForBuild, { sourceId: parallelType });
    expect(list.source).toBeUndefined();
    expect(list.sourceBlocked).toBe(BLOCKED_TOO_MANY_VARIANT_TYPES);

    const result = await t
      .withIdentity(ADMIN)
      .action(api.parallelChecklistBuild.buildParallelChecklist, { parallelId: gold });
    expect(result.blockedReason).toBe(BLOCKED_TOO_MANY_VARIANT_TYPES);
    expect(bscState.calls).toBe(0);
  });

  test("exactly at the cap the Base is still found", async () => {
    const t = convexTest(schema, modules);
    const { setName, base, parallelType } = await seedSet(t);
    await addVariantTypes(t, setName, MAX_VARIANT_TYPES_PER_SET - 2);
    const list = await t
      .withIdentity(ADMIN)
      .query(api.parallelChecklistBuild.getParallelsForBuild, { sourceId: parallelType });
    expect(list.source?.id).toBe(base);
  });
});

describe("N1 — card reads are bounded by bytes", () => {
  /** convex-test enforces this limit, so an unbounded read throws as on Convex. */
  const tightReads = () =>
    convexTest({
      schema,
      modules,
      transactionLimits: { bytesRead: READ_BYTES_RESERVE + 3 * 1024 * 1024 },
    });

  test("a Base heavier than one transaction's read budget still builds, every card copied", async () => {
    const t = tightReads();
    const { base, gold } = await seedSet(t);
    // ~10 MB of Base, over the ~7 MiB a transaction may read here.
    await addHeavyCards(t, base, 20, 500);
    bscState.cards = Array.from({ length: 20 }, (_, i) => ({
      cardNumber: String(i + 1),
      cardName: `Player ${i + 1}`,
      platformRef: `bsc-${i + 1}`,
    }));

    const result = await t
      .withIdentity(ADMIN)
      .action(api.parallelChecklistBuild.buildParallelChecklist, { parallelId: gold });

    expect(result.status).toBe("built");
    expect(result.copied).toBe(20);
    expect(await cardsOn(t, gold)).toHaveLength(20);
  }, 60_000);

  test("the list still answers when the parallels' cards outweigh its read budget", async () => {
    const t = tightReads();
    const { parallelType, gold } = await seedSet(t);
    const others = await t.run(async (ctx) => {
      const ids: Array<Id<"selectorOptions">> = [];
      for (const value of ["Green Wave", "Red Wave"]) {
        ids.push(
          await ctx.db.insert("selectorOptions", {
            level: "insert",
            value,
            parentId: parallelType,
            platformData: { bsc: { b0: value.toLowerCase() } },
            platformFacets: { bsc: { b0: "variantName" } },
            children: [],
            lastUpdated: SENTINEL,
          }),
        );
      }
      return ids;
    });
    for (const id of [gold, ...others]) await addHeavyCards(t, id, 10, 500);

    const list = await t
      .withIdentity(ADMIN)
      .query(api.parallelChecklistBuild.getParallelsForBuild, { sourceId: parallelType });
    expect(list.parallels).toHaveLength(3);
    expect(list.parallels.every((p) => p.hasCards)).toBe(true);
  }, 60_000);

  test("a Base past the total byte cap is refused with the too-many-cards sentence, nothing fetched", async () => {
    const t = convexTest(schema, modules);
    const { base, gold } = await seedSet(t);
    // A literal size, NOT derived from the constant (a derived count would
    // grow with the cap and could never catch a raised one): 56 x 900 KB is
    // ~49.2 MiB, just over the 48 MiB cap and well under 5,000 cards.
    await addHeavyCards(t, base, 56, 900);
    expect(56 * 900 * 1024).toBeGreaterThan(MAX_CARD_BYTES_FOR_BUILD);

    const result = await t
      .withIdentity(ADMIN)
      .action(api.parallelChecklistBuild.buildParallelChecklist, { parallelId: gold });

    expect(result.status).toBe("blocked");
    expect(result.blockedReason).toBe(BLOCKED_TOO_MANY_CARDS);
    expect(bscState.calls).toBe(0);
    expect(await cardsOn(t, gold)).toHaveLength(0);
  }, 120_000);
});
