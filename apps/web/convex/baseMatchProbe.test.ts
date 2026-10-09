/**
 * NEO-325: the Base match probe, server half (`convex/baseMatchProbe.ts`).
 *
 *   - `getBaseSignatureForVariantType` reduces NB's saved Base to what the
 *     Reconcile dialog compares a marketplace set against.
 *   - `probeSlFirstPage`, `probeSlCount` and `probeBscSets` read a summary of
 *     each unmatched marketplace set by its own id, one session read per batch.
 *
 * Everything is read-only. The marketplaces are stubbed at `fetch` (the
 * network guard would fail the run otherwise) and the session read is stubbed
 * at the `./credentials` module boundary, with a counter, because "one read per
 * batch" is a contract, not an accident.
 *
 * Fixture names ("Flagship", "Gold") are deliberately not "Base": the probe
 * finds the Base by NB's `isBase` flag and the parallel type by NB's role.
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { stripNbCardNumberPrefix } from "./baseMatchProbe";
import { SL_PROBE_ID_PATTERN, checkProbeIds, isProbeId } from "./lib/baseMatchProbe";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN = {
  subject: "admin_probe_001",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_probe_001",
  name: "Admin User",
  role: "admin",
};
const NON_ADMIN = {
  subject: "user_probe_002",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|user_probe_002",
  name: "Plain User",
};

const SL_COOKIE = "PHPSESSID=SECRET-COOKIE-ZZ";
const BSC_TOKEN = "SECRET-TOKEN-ZZ";

const st = vi.hoisted(() => ({
  reads: { sportlots: 0, buysportscards: 0 } as Record<string, number>,
  tokens: {} as Record<string, string | null>,
  authCalls: 0,
  onAuth: undefined as undefined | (() => void),
}));

vi.mock("./credentials", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./credentials")>();
  const { internalAction } = await import("./_generated/server");
  const { v } = await import("convex/values");
  return {
    ...actual,
    getSiteToken: internalAction({
      args: { site: v.string() },
      returns: v.any(),
      handler: async (_ctx, args) => {
        st.reads[args.site] = (st.reads[args.site] ?? 0) + 1;
        const token = st.tokens[args.site];
        return token ? { token } : null;
      },
    }),
    authenticateBsc: internalAction({
      args: {},
      returns: v.any(),
      handler: async () => {
        st.authCalls++;
        st.onAuth?.();
        return { success: true, message: "ok" };
      },
    }),
  };
});

let logSpies: Array<ReturnType<typeof vi.spyOn>>;

beforeEach(() => {
  st.reads = { sportlots: 0, buysportscards: 0 };
  st.tokens = { sportlots: SL_COOKIE, buysportscards: BSC_TOKEN };
  st.authCalls = 0;
  st.onAuth = undefined;
  logSpies = (["log", "warn", "error", "info"] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation(() => {}),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.NEONBINDER_PAUSED_PLATFORMS;
});

/** Everything the console received this test, flattened. */
function loggedText(): string {
  return JSON.stringify(logSpies.flatMap((s) => s.mock.calls));
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type T = ReturnType<typeof convexTest>;
type Ins = (f: Record<string, unknown>) => Promise<Id<"selectorOptions">>;

/** The tree: sport > year > brand > set > { Base (isBase), Parallel type }. */
async function seedTree(
  t: T,
  opts: {
    setPrefix?: string;
    basePrefix?: string;
    parallelMeta?: Record<string, unknown>;
    parallelSlots?: boolean;
  } = {},
) {
  return t.run(async (ctx) => {
    const ins: Ins = (f) =>
      ctx.db.insert("selectorOptions", {
        platformData: {},
        children: [],
        lastUpdated: 1,
        ...f,
      } as never);
    const sport = await ins({ level: "sport", value: "Baseball", platformData: { bsc: { b0: "baseball" } } });
    const year = await ins({ level: "year", value: "2024", parentId: sport, platformData: { bsc: { b0: "2024" } } });
    const brand = await ins({ level: "manufacturer", value: "Topps", parentId: year });
    const set = await ins({
      level: "setName",
      value: "Topps Chrome",
      parentId: brand,
      platformData: { bsc: { b0: "topps-chrome" } },
      ...(opts.setPrefix ? { metadata: { cardNumberPrefix: opts.setPrefix } } : {}),
    });
    const base = await ins({
      level: "variantType",
      value: "Flagship",
      parentId: set,
      metadata: { isBase: true, ...(opts.basePrefix ? { cardNumberPrefix: opts.basePrefix } : {}) },
    });
    const parallel = await ins({
      level: "variantType",
      value: "Gold",
      parentId: set,
      metadata: { variantRole: "parallel", ...opts.parallelMeta },
      ...(opts.parallelSlots === false
        ? {}
        : {
            platformData: { bsc: { b0: "parallel" } },
            platformFacets: { bsc: { b0: "variant" } },
          }),
    });
    return { sport, year, brand, set, base, parallel };
  });
}

type CardSeed = {
  cardNumber: string;
  cardName?: string;
  sortOrder: number;
  bsc?: boolean;
  sl?: boolean;
} & Record<string, unknown>;

async function addCards(t: T, optionId: Id<"selectorOptions">, cards: CardSeed[]) {
  return t.run(async (ctx) => {
    const ids: Id<"cardChecklist">[] = [];
    for (const { bsc, sl, cardName, ...rest } of cards) {
      ids.push(
        await ctx.db.insert("cardChecklist", {
          selectorOptionId: optionId,
          cardName: cardName ?? `Card ${rest.cardNumber}`,
          lastUpdated: 1,
          platformData: {},
          ...(bsc || sl
            ? {
                platformData: {
                  ...(bsc ? { bsc: { ref: `b-${rest.cardNumber}` } } : {}),
                  ...(sl ? { sportlots: { ref: `s-${rest.cardNumber}` } } : {}),
                },
              }
            : {}),
          ...rest,
        } as never),
      );
    }
    return ids;
  });
}

const sig = (t: T, variantTypeId: Id<"selectorOptions">) =>
  t.withIdentity(ADMIN).query(api.baseMatchProbe.getBaseSignatureForVariantType, { variantTypeId });

async function rowCounts(t: T, except: string[] = []): Promise<Record<string, number>> {
  return t.run(async (ctx) => {
    const out: Record<string, number> = {};
    for (const name of Object.keys(schema.tables)) {
      if (except.includes(name)) continue;
      out[name] = (await ctx.db.query(name as never).collect()).length;
    }
    return out;
  });
}

/** The caller's profile with the credential-lock fields taken off each entry. */
async function profileWithoutLock(t: T) {
  return t.run(async (ctx) => {
    const rows = await ctx.db.query("userProfiles").collect();
    return rows.map((r) => ({
      userId: r.userId,
      siteCredentials: (r.siteCredentials ?? []).map(
        ({ lockedAt: _a, lockedOp: _b, lockToken: _c, ...rest }: Record<string, unknown>) => rest,
      ),
    }));
  });
}

// ---------------------------------------------------------------------------
// getBaseSignatureForVariantType
// ---------------------------------------------------------------------------

describe("getBaseSignatureForVariantType: not a parallel type", () => {
  test("a missing row answers notParallelType", async () => {
    const t = convexTest(schema, modules);
    const { parallel } = await seedTree(t);
    await t.run(async (ctx) => ctx.db.delete(parallel));

    expect(await sig(t, parallel)).toEqual({ status: "notParallelType" });
  });

  test("a row above variantType level answers notParallelType", async () => {
    const t = convexTest(schema, modules);
    const { set } = await seedTree(t);

    expect(await sig(t, set)).toEqual({ status: "notParallelType" });
  });

  test("an insert-role variant type answers notParallelType", async () => {
    const t = convexTest(schema, modules);
    const { parallel } = await seedTree(t, { parallelMeta: { variantRole: "insert" } });

    expect(await sig(t, parallel)).toEqual({ status: "notParallelType" });
  });

  test("a variant type with no role answers notParallelType", async () => {
    const t = convexTest(schema, modules);
    const { parallel } = await seedTree(t);
    await t.run(async (ctx) => ctx.db.patch(parallel, { metadata: {} }));

    expect(await sig(t, parallel)).toEqual({ status: "notParallelType" });
  });

  test("the isBase row itself answers notParallelType", async () => {
    const t = convexTest(schema, modules);
    const { base } = await seedTree(t);

    expect(await sig(t, base)).toEqual({ status: "notParallelType" });
  });
});

describe("getBaseSignatureForVariantType: which Base", () => {
  test("a parallel type with no parent answers noBase", async () => {
    const t = convexTest(schema, modules);
    const orphan = await t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "variantType",
        value: "Orphan",
        platformData: {},
        children: [],
        lastUpdated: 1,
        metadata: { variantRole: "parallel" },
      } as never),
    );

    expect(await sig(t, orphan)).toEqual({ status: "noBase" });
  });

  test("a set whose variant types carry no isBase flag answers noBase", async () => {
    const t = convexTest(schema, modules);
    const { base, parallel } = await seedTree(t);
    await t.run(async (ctx) => ctx.db.patch(base, { metadata: {} }));

    expect(await sig(t, parallel)).toEqual({ status: "noBase" });
  });

  test("two isBase siblings answer manyBases", async () => {
    const t = convexTest(schema, modules);
    const { set, parallel } = await seedTree(t);
    await t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "variantType",
        value: "Second",
        parentId: set,
        platformData: {},
        children: [],
        lastUpdated: 1,
        metadata: { isBase: true },
      } as never),
    );

    expect(await sig(t, parallel)).toEqual({ status: "manyBases" });
  });

  test("201 variant types in the set answer manyBases, because an unread row could be a second Base", async () => {
    const t = convexTest(schema, modules);
    const { set, parallel, base } = await seedTree(t);
    await addCards(t, base, [{ cardNumber: "1", sortOrder: 1 }]);
    // base + parallel + 199 fillers = 201.
    await t.run(async (ctx) => {
      for (let i = 0; i < 199; i++) {
        await ctx.db.insert("selectorOptions", {
          level: "variantType",
          value: `Filler ${i}`,
          parentId: set,
          platformData: {},
          children: [],
          lastUpdated: 1,
        } as never);
      }
    });

    expect(await sig(t, parallel)).toEqual({ status: "manyBases" });
  });

  test("exactly 200 variant types in the set still resolve", async () => {
    const t = convexTest(schema, modules);
    const { set, parallel, base } = await seedTree(t);
    await addCards(t, base, [{ cardNumber: "1", sortOrder: 1 }]);
    // base + parallel + 198 fillers = 200.
    await t.run(async (ctx) => {
      for (let i = 0; i < 198; i++) {
        await ctx.db.insert("selectorOptions", {
          level: "variantType",
          value: `Filler ${i}`,
          parentId: set,
          platformData: {},
          children: [],
          lastUpdated: 1,
        } as never);
      }
    });

    expect((await sig(t, parallel)).status).toBe("ok");
  });
});

describe("getBaseSignatureForVariantType: cards", () => {
  test("a Base with no cards answers noCards", async () => {
    const t = convexTest(schema, modules);
    const { parallel } = await seedTree(t);

    expect(await sig(t, parallel)).toEqual({ status: "noCards" });
  });

  test("a Base holding only variations (by variationOfCardId) answers noCards", async () => {
    const t = convexTest(schema, modules);
    const { base, parallel } = await seedTree(t);
    // The parent lives on another option so the Base itself holds only the variation.
    const [parent] = await addCards(t, parallel, [{ cardNumber: "1", sortOrder: 1 }]);
    await addCards(t, base, [{ cardNumber: "1", sortOrder: 1, variationOfCardId: parent }]);

    expect(await sig(t, parallel)).toEqual({ status: "noCards" });
  });

  test("a Base holding only variations (by cardVariation) answers noCards", async () => {
    const t = convexTest(schema, modules);
    const { base, parallel } = await seedTree(t);
    await addCards(t, base, [{ cardNumber: "1", sortOrder: 1, cardVariation: "Action Image" }]);

    expect(await sig(t, parallel)).toEqual({ status: "noCards" });
  });

  test("a whitespace-only cardVariation is not a variation", async () => {
    const t = convexTest(schema, modules);
    const { base, parallel } = await seedTree(t);
    await addCards(t, base, [{ cardNumber: "1", sortOrder: 1, cardVariation: "   " }]);

    expect((await sig(t, parallel)).status).toBe("ok");
  });

  test("5,001 cards answer tooManyCards", async () => {
    const t = convexTest(schema, modules);
    const { base, parallel } = await seedTree(t);
    await t.run(async (ctx) => {
      for (let i = 1; i <= 5001; i++) {
        await ctx.db.insert("cardChecklist", {
          selectorOptionId: base,
          cardNumber: String(i),
          cardName: "x",
          sortOrder: i,
          lastUpdated: 1,
          platformData: {},
        } as never);
      }
    });

    expect(await sig(t, parallel)).toEqual({ status: "tooManyCards" });
  });

  test("exactly 5,000 cards are ok", async () => {
    const t = convexTest(schema, modules);
    const { base, parallel } = await seedTree(t);
    await t.run(async (ctx) => {
      for (let i = 1; i <= 5000; i++) {
        await ctx.db.insert("cardChecklist", {
          selectorOptionId: base,
          cardNumber: String(i),
          cardName: "x",
          sortOrder: i,
          lastUpdated: 1,
          platformData: {},
        } as never);
      }
    });

    const out = await sig(t, parallel);
    expect(out.status).toBe("ok");
    if (out.status === "ok") expect(out.cards).toHaveLength(5000);
  });
});

describe("getBaseSignatureForVariantType: an ok signature", () => {
  test("first is the lowest-sortOrder non-variation card, not the first inserted or a variation", async () => {
    const t = convexTest(schema, modules);
    const { base, parallel } = await seedTree(t);
    const [parent] = await addCards(t, base, [{ cardNumber: "20", cardName: "Twenty", sortOrder: 20 }]);
    await addCards(t, base, [
      { cardNumber: "7", cardName: "Seven", sortOrder: 7 },
      { cardNumber: "3", cardName: "Three", sortOrder: 3 },
      // Lowest sortOrder of all, but a variation: never the first.
      { cardNumber: "1", cardName: "One Var", sortOrder: 1, variationOfCardId: parent },
      { cardNumber: "2", cardName: "Two Var", sortOrder: 2, cardVariation: "Action" },
    ]);

    const out = await sig(t, parallel);

    if (out.status !== "ok") throw new Error(`expected ok, got ${out.status}`);
    expect(out.first).toMatchObject({ cardNumber: "3", cardName: "Three" });
  });

  test("cards come back in sortOrder with variations left out", async () => {
    const t = convexTest(schema, modules);
    const { base, parallel } = await seedTree(t);
    await addCards(t, base, [
      { cardNumber: "9", sortOrder: 9 },
      { cardNumber: "1", sortOrder: 1 },
      { cardNumber: "5", sortOrder: 5 },
      { cardNumber: "5", sortOrder: 6, cardVariation: "Action" },
    ]);

    const out = await sig(t, parallel);

    if (out.status !== "ok") throw new Error(`expected ok, got ${out.status}`);
    expect(out.cards.map((c) => c.cardNumber)).toEqual(["1", "5", "9"]);
  });

  test("equal sortOrders keep creation order", async () => {
    const t = convexTest(schema, modules);
    const { base, parallel } = await seedTree(t);
    await addCards(t, base, [
      { cardNumber: "B", sortOrder: 4 },
      { cardNumber: "A", sortOrder: 4 },
      { cardNumber: "C", sortOrder: 4 },
    ]);

    const out = await sig(t, parallel);

    if (out.status !== "ok") throw new Error(`expected ok, got ${out.status}`);
    expect(out.cards.map((c) => c.cardNumber)).toEqual(["B", "A", "C"]);
  });

  test("perSide counts non-variation cards holding a ref on each side", async () => {
    const t = convexTest(schema, modules);
    const { base, parallel } = await seedTree(t);
    const [parent] = await addCards(t, base, [
      { cardNumber: "1", sortOrder: 1, bsc: true, sl: true },
    ]);
    await addCards(t, base, [
      { cardNumber: "2", sortOrder: 2, bsc: true },
      { cardNumber: "3", sortOrder: 3 },
      // Variations carry refs on both sides but must not be counted.
      { cardNumber: "1", sortOrder: 4, bsc: true, sl: true, variationOfCardId: parent },
      { cardNumber: "2", sortOrder: 5, bsc: true, sl: true, cardVariation: "Action" },
    ]);

    const out = await sig(t, parallel);

    if (out.status !== "ok") throw new Error(`expected ok, got ${out.status}`);
    expect(out.perSide).toEqual({ bsc: 2, sportlots: 1 });
  });

  test("baseName is the Base row's own value and baseId its id", async () => {
    const t = convexTest(schema, modules);
    const { base, parallel } = await seedTree(t);
    await addCards(t, base, [{ cardNumber: "1", sortOrder: 1 }]);

    const out = await sig(t, parallel);

    if (out.status !== "ok") throw new Error(`expected ok, got ${out.status}`);
    expect(out.baseId).toBe(base);
    expect(out.baseName).toBe("Flagship");
  });

  test("no prefix anywhere leaves numbers untouched and omits cardNumberPrefix", async () => {
    const t = convexTest(schema, modules);
    const { base, parallel } = await seedTree(t);
    await addCards(t, base, [{ cardNumber: "TC-1", sortOrder: 1 }]);

    const out = await sig(t, parallel);

    if (out.status !== "ok") throw new Error(`expected ok, got ${out.status}`);
    expect(out.cards[0].cardNumber).toBe("TC-1");
    expect("cardNumberPrefix" in out).toBe(false);
  });

  test("a prefix on the set strips every card number, and is reported", async () => {
    const t = convexTest(schema, modules);
    const { base, parallel } = await seedTree(t, { setPrefix: "TC-" });
    await addCards(t, base, [
      { cardNumber: "TC-1", sortOrder: 1 },
      { cardNumber: "TC-22", sortOrder: 2 },
    ]);

    const out = await sig(t, parallel);

    if (out.status !== "ok") throw new Error(`expected ok, got ${out.status}`);
    expect(out.cards.map((c) => c.cardNumber)).toEqual(["1", "22"]);
    expect(out.first.cardNumber).toBe("1");
    expect(out.cardNumberPrefix).toBe("TC-");
  });

  test("the deepest prefix on the chain wins over a shallower one", async () => {
    const t = convexTest(schema, modules);
    const { base, parallel } = await seedTree(t, { setPrefix: "SET-", basePrefix: "BS-" });
    await addCards(t, base, [
      { cardNumber: "BS-12", sortOrder: 1 },
      { cardNumber: "SET-13", sortOrder: 2 },
    ]);

    const out = await sig(t, parallel);

    if (out.status !== "ok") throw new Error(`expected ok, got ${out.status}`);
    expect(out.cardNumberPrefix).toBe("BS-");
    // The shallower prefix no longer applies once a deeper one is set.
    expect(out.cards.map((c) => c.cardNumber)).toEqual(["12", "SET-13"]);
  });

  test("the prefix matches case-insensitively and the rest keeps its case", async () => {
    const t = convexTest(schema, modules);
    const { base, parallel } = await seedTree(t, { setPrefix: "TC-" });
    await addCards(t, base, [
      { cardNumber: "tc-7a", sortOrder: 1 },
      { cardNumber: "  TC-8B  ", sortOrder: 2 },
    ]);

    const out = await sig(t, parallel);

    if (out.status !== "ok") throw new Error(`expected ok, got ${out.status}`);
    expect(out.cards.map((c) => c.cardNumber)).toEqual(["7a", "8B"]);
  });

  test("a number equal to the prefix is not stripped down to nothing", async () => {
    const t = convexTest(schema, modules);
    const { base, parallel } = await seedTree(t, { setPrefix: "TC-" });
    await addCards(t, base, [
      { cardNumber: "TC-", sortOrder: 1 },
      { cardNumber: "tc-", sortOrder: 2 },
    ]);

    const out = await sig(t, parallel);

    if (out.status !== "ok") throw new Error(`expected ok, got ${out.status}`);
    expect(out.cards.map((c) => c.cardNumber)).toEqual(["TC-", "tc-"]);
  });

  test("namesOnCard lists printed names from links, then pending names", async () => {
    const t = convexTest(schema, modules);
    const { base, parallel } = await seedTree(t);
    const playerId = await t.run(async (ctx) => {
      const sportId = await ctx.db.insert("selectorOptions", {
        level: "sport",
        value: "Football",
        platformData: {},
        children: [],
        lastUpdated: 1,
      } as never);
      return ctx.db.insert("players", {
        name: "Mike Trout",
        nameNormalized: "mike trout",
        sportId,
        lastUpdated: 1,
      } as never);
    });
    await addCards(t, base, [
      {
        cardNumber: "1",
        sortOrder: 1,
        playerIds: [playerId],
        playerLinks: [{ playerId, nameOnCard: "Mikey Trout" }],
        pendingPlayerNames: ["Aaron Judge"],
      },
    ]);

    const out = await sig(t, parallel);

    if (out.status !== "ok") throw new Error(`expected ok, got ${out.status}`);
    expect(out.first.namesOnCard).toEqual(["Mikey Trout", "Aaron Judge"]);
    expect(out.first.isTeamCard).toBe(false);
  });

  test("a card with team names and no players is a team card", async () => {
    const t = convexTest(schema, modules);
    const { base, parallel } = await seedTree(t);
    await addCards(t, base, [
      { cardNumber: "1", sortOrder: 1, pendingTeamNames: ["Padres"] },
      { cardNumber: "2", sortOrder: 2, pendingTeamNames: ["Padres"], pendingPlayerNames: ["A Player"] },
      { cardNumber: "3", sortOrder: 3 },
    ]);

    const out = await sig(t, parallel);

    if (out.status !== "ok") throw new Error(`expected ok, got ${out.status}`);
    expect(out.cards.map((c) => c.isTeamCard)).toEqual([true, false, false]);
    expect(out.cards[0].namesOnCard).toEqual([]);
  });

  test("a write-free read: no table changes", async () => {
    const t = convexTest(schema, modules);
    const { base, parallel } = await seedTree(t);
    await addCards(t, base, [{ cardNumber: "1", sortOrder: 1 }]);
    const before = await rowCounts(t);

    await sig(t, parallel);

    expect(await rowCounts(t)).toEqual(before);
  });
});

describe("getBaseSignatureForVariantType: auth", () => {
  test("an unauthenticated caller is refused", async () => {
    const t = convexTest(schema, modules);
    const { parallel } = await seedTree(t);

    await expect(
      t.query(api.baseMatchProbe.getBaseSignatureForVariantType, { variantTypeId: parallel }),
    ).rejects.toThrow(/Not authenticated/);
  });

  test("a signed-in non-admin is refused", async () => {
    const t = convexTest(schema, modules);
    const { parallel } = await seedTree(t);

    await expect(
      t.withIdentity(NON_ADMIN).query(api.baseMatchProbe.getBaseSignatureForVariantType, {
        variantTypeId: parallel,
      }),
    ).rejects.toThrow(/Admin access required/);
  });
});

describe("stripNbCardNumberPrefix", () => {
  test.each([
    ["TC-1", "TC-", "1"],
    ["tc-1", "TC-", "1"],
    ["TC-", "TC-", "TC-"],
    ["  TC-9 ", " TC- ", "9"],
    ["12", "TC-", "12"],
    ["TC-1", undefined, "TC-1"],
    ["TC-1", "", "TC-1"],
    ["TC-1", "   ", "TC-1"],
  ])("%s with prefix %j gives %s", (num, prefix, expected) => {
    expect(stripNbCardNumberPrefix(num, prefix)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// SportLots probes
// ---------------------------------------------------------------------------

const slRow = (n: string, d: string, variation = false) =>
  `<td class="${variation ? "smallcolorleft" : "smallleft"}">${n}</td>\n<td class="smallleft">${d}</td>`;

type SlCall = { id: string; start: number; cookie: string };

/**
 * Stub fetch for SportLots: `pageFor(id, start)` answers each POST. Records
 * every call and the highest number in flight at once (each call yields so
 * concurrent callers genuinely overlap).
 */
function stubSl(
  pageFor: (id: string, start: number) => string | Response | Error,
) {
  const calls: SlCall[] = [];
  const flight = { now: 0, max: 0 };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      const body = new URLSearchParams(String(init.body));
      const id = body.get("selset") ?? "";
      const start = Number(body.get("start"));
      calls.push({ id, start, cookie: String((init.headers as Record<string, string>).Cookie) });
      flight.now++;
      flight.max = Math.max(flight.max, flight.now);
      await new Promise((r) => setTimeout(r, 2));
      flight.now--;
      const out = pageFor(id, start);
      if (out instanceof Error) throw out;
      return out instanceof Response ? out : new Response(out, { status: 200 });
    }),
  );
  return { calls, flight };
}

const asAdmin = (t: T) => t.withIdentity(ADMIN);

describe("probeSlFirstPage", () => {
  test("reads the session once for the batch and POSTs one first page per unique id", async () => {
    const { calls } = stubSl((id) => slRow("1", `Player ${id}`));
    const t = convexTest(schema, modules);

    const out = await asAdmin(t).action(api.baseMatchProbe.probeSlFirstPage, {
      setIds: ["11", "22", "11", "33"],
    });

    expect(st.reads.sportlots).toBe(1);
    expect(st.reads.buysportscards).toBe(0);
    expect(out.map((r) => r.id)).toEqual(["11", "22", "33"]);
    expect(calls.map((c) => `${c.id}@${c.start}`).sort()).toEqual(["11@1", "22@1", "33@1"]);
    expect(calls.every((c) => c.cookie === SL_COOKIE)).toBe(true);
  });

  test("answers the first non-variation row, the page's non-variation count and pageHadRows", async () => {
    stubSl(() =>
      [
        slRow("1", "Mike Trout [ VAR Action ]", true),
        slRow("1", "Mike Trout"),
        slRow("2", "Aaron Judge"),
      ].join("\n"),
    );
    const t = convexTest(schema, modules);

    const out = await asAdmin(t).action(api.baseMatchProbe.probeSlFirstPage, { setIds: ["11"] });

    expect(out).toEqual([
      {
        id: "11",
        status: "ok",
        first: { cardNumber: "1", cardName: "Mike Trout", players: ["Mike Trout"] },
        nonVariationRowsOnPage: 2,
        pageHadRows: true,
      },
    ]);
  });

  test("a page of variations only has pageHadRows true and no first", async () => {
    stubSl(() => slRow("1", "Mike Trout [ VAR Action ]", true));
    const t = convexTest(schema, modules);

    const [r] = await asAdmin(t).action(api.baseMatchProbe.probeSlFirstPage, { setIds: ["11"] });

    expect(r).toEqual({ id: "11", status: "ok", nonVariationRowsOnPage: 0, pageHadRows: true });
  });

  test("an empty page is ok with pageHadRows false", async () => {
    stubSl(() => "");
    const t = convexTest(schema, modules);

    const [r] = await asAdmin(t).action(api.baseMatchProbe.probeSlFirstPage, { setIds: ["11"] });

    expect(r).toEqual({ id: "11", status: "ok", nonVariationRowsOnPage: 0, pageHadRows: false });
  });

  test("reads only the first page even when the set has more", async () => {
    const { calls } = stubSl((_id, start) => slRow(String(start), `Player ${start}`));
    const t = convexTest(schema, modules);

    await asAdmin(t).action(api.baseMatchProbe.probeSlFirstPage, { setIds: ["11"] });

    expect(calls.map((c) => c.start)).toEqual([1]);
  });

  test("one id failing does not fail the others, whatever the failure", async () => {
    const timeout = new Error("The operation was aborted due to timeout");
    timeout.name = "TimeoutError";
    stubSl((id) =>
      id === "22"
        ? new Response("no", { status: 500 })
        : id === "33"
          ? timeout
          : id === "44"
            ? '<form action="login.tpl">'
            : slRow("1", "Good Player"),
    );
    const t = convexTest(schema, modules);

    const out = await asAdmin(t).action(api.baseMatchProbe.probeSlFirstPage, {
      setIds: ["11", "22", "33", "44", "55"],
    });

    expect(out.map((r) => [r.id, r.status, "kind" in r ? r.kind : undefined])).toEqual([
      ["11", "ok", undefined],
      ["22", "failed", "http_error"],
      ["33", "failed", "timeout"],
      ["44", "failed", "signed_out"],
      ["55", "ok", undefined],
    ]);
  });

  test("no cookie answers no_sign_in for every id and fetches nothing", async () => {
    st.tokens.sportlots = null;
    const { calls } = stubSl(() => slRow("1", "X"));
    const t = convexTest(schema, modules);

    const out = await asAdmin(t).action(api.baseMatchProbe.probeSlFirstPage, { setIds: ["1", "2"] });

    expect(out).toEqual([
      { id: "1", status: "failed", kind: "no_sign_in" },
      { id: "2", status: "failed", kind: "no_sign_in" },
    ]);
    expect(calls).toHaveLength(0);
    expect(st.reads.sportlots).toBe(1);
  });

  test("a paused SportLots is refused with zero session reads and zero fetches", async () => {
    process.env.NEONBINDER_PAUSED_PLATFORMS = "sportlots";
    const { calls } = stubSl(() => slRow("1", "X"));
    const t = convexTest(schema, modules);

    const out = await asAdmin(t).action(api.baseMatchProbe.probeSlFirstPage, { setIds: ["1", "2"] });

    expect(out).toEqual([
      { id: "1", status: "failed", kind: "refused" },
      { id: "2", status: "failed", kind: "refused" },
    ]);
    expect(st.reads.sportlots).toBe(0);
    expect(calls).toHaveLength(0);
  });

  test("pausing BuySportsCards does not stop SportLots", async () => {
    process.env.NEONBINDER_PAUSED_PLATFORMS = "buysportscards";
    stubSl(() => slRow("1", "X Player"));
    const t = convexTest(schema, modules);

    const [r] = await asAdmin(t).action(api.baseMatchProbe.probeSlFirstPage, { setIds: ["1"] });

    expect(r.status).toBe("ok");
  });

  test("an empty id list answers [] without reading the session", async () => {
    stubSl(() => "");
    const t = convexTest(schema, modules);

    expect(await asAdmin(t).action(api.baseMatchProbe.probeSlFirstPage, { setIds: [] })).toEqual([]);
    expect(st.reads.sportlots).toBe(0);
  });

  test("33 distinct ids are refused before any session read or fetch", async () => {
    const { calls } = stubSl(() => "");
    const t = convexTest(schema, modules);

    await expect(
      asAdmin(t).action(api.baseMatchProbe.probeSlFirstPage, {
        setIds: Array.from({ length: 33 }, (_, i) => `${1000 + i}`),
      }),
    ).rejects.toThrow(/At most 32/);
    expect(st.reads.sportlots).toBe(0);
    expect(calls).toHaveLength(0);
  });

  test("32 distinct ids plus duplicates are accepted", async () => {
    const { calls } = stubSl(() => slRow("1", "X Player"));
    const t = convexTest(schema, modules);
    const ids = Array.from({ length: 32 }, (_, i) => `${1000 + i}`);

    const out = await asAdmin(t).action(api.baseMatchProbe.probeSlFirstPage, {
      setIds: [...ids, ...ids.slice(0, 10)],
    });

    expect(out).toHaveLength(32);
    expect(calls).toHaveLength(32);
    expect(st.reads.sportlots).toBe(1);
  });

  test.each([
    ["an empty id", ""],
    ["a 65-character id", "1".repeat(65)],
    ["an id with a control character", "ab\ncd"],
  ])("%s throws before any session read or fetch", async (_label, bad) => {
    const { calls } = stubSl(() => "");
    const t = convexTest(schema, modules);

    await expect(
      asAdmin(t).action(api.baseMatchProbe.probeSlFirstPage, { setIds: ["11", bad] }),
    ).rejects.toThrow();
    expect(st.reads.sportlots).toBe(0);
    expect(calls).toHaveLength(0);
  });

  test("a 64-character id is accepted", async () => {
    stubSl(() => "");
    const t = convexTest(schema, modules);

    const out = await asAdmin(t).action(api.baseMatchProbe.probeSlFirstPage, {
      setIds: ["1".repeat(64)],
    });

    expect(out).toHaveLength(1);
  });

  test("at most 8 sets are in flight at once", async () => {
    const { flight, calls } = stubSl(() => slRow("1", "X Player"));
    const t = convexTest(schema, modules);

    await asAdmin(t).action(api.baseMatchProbe.probeSlFirstPage, {
      setIds: Array.from({ length: 32 }, (_, i) => `${1000 + i}`),
    });

    expect(calls).toHaveLength(32);
    expect(flight.max).toBe(8);
  });

  test("results keep the request order", async () => {
    stubSl((id) => slRow("1", `Player ${id}`));
    const t = convexTest(schema, modules);
    const ids = ["99", "2", "55", "1"];

    const out = await asAdmin(t).action(api.baseMatchProbe.probeSlFirstPage, { setIds: ids });

    expect(out.map((r) => r.id)).toEqual(ids);
  });

  test("an unauthenticated caller is refused before anything is read", async () => {
    const { calls } = stubSl(() => "");
    const t = convexTest(schema, modules);

    await expect(
      t.action(api.baseMatchProbe.probeSlFirstPage, { setIds: ["1"] }),
    ).rejects.toThrow(/Not authenticated/);
    expect(st.reads.sportlots).toBe(0);
    expect(calls).toHaveLength(0);
  });

  test("a non-admin is refused", async () => {
    stubSl(() => "");
    const t = convexTest(schema, modules);

    await expect(
      t.withIdentity(NON_ADMIN).action(api.baseMatchProbe.probeSlFirstPage, { setIds: ["1"] }),
    ).rejects.toThrow(/Admin access required/);
  });
});

describe("probeSlCount", () => {
  test("counts non-variation rows across pages; pages includes the empty end page", async () => {
    const { calls } = stubSl((_id, start) =>
      start === 1
        ? [slRow("1", "Mike Trout [ VAR Action ]", true), slRow("1", "Mike Trout"), slRow("2", "Aaron Judge")].join("\n")
        : start === 101
          ? slRow("3", "Juan Soto")
          : "",
    );
    const t = convexTest(schema, modules);

    const out = await asAdmin(t).action(api.baseMatchProbe.probeSlCount, { setIds: ["11"] });

    expect(out).toEqual([{ id: "11", status: "ok", count: 3, pages: 3 }]);
    expect(calls.map((c) => c.start)).toEqual([1, 101, 201]);
    expect(st.reads.sportlots).toBe(1);
  });

  test("an empty set counts zero over one page", async () => {
    stubSl(() => "");
    const t = convexTest(schema, modules);

    const out = await asAdmin(t).action(api.baseMatchProbe.probeSlCount, { setIds: ["11"] });

    expect(out).toEqual([{ id: "11", status: "ok", count: 0, pages: 1 }]);
  });

  test("one session read serves several sets", async () => {
    stubSl((id, start) => (start === 1 ? slRow("1", `Player ${id}`) : ""));
    const t = convexTest(schema, modules);

    const out = await asAdmin(t).action(api.baseMatchProbe.probeSlCount, {
      setIds: ["1", "2", "3", "4", "5", "6", "7", "8"],
    });

    expect(out).toHaveLength(8);
    expect(st.reads.sportlots).toBe(1);
  });

  test("a failure on a later page fails that id only, with the walk's kind", async () => {
    stubSl((id, start) =>
      id === "20" && start === 101
        ? new Response("x", { status: 502 })
        : start === 1
          ? slRow("1", `Player ${id}`)
          : "",
    );
    const t = convexTest(schema, modules);

    const out = await asAdmin(t).action(api.baseMatchProbe.probeSlCount, { setIds: ["10", "20"] });

    expect(out).toEqual([
      { id: "10", status: "ok", count: 1, pages: 2 },
      { id: "20", status: "failed", kind: "http_error" },
    ]);
  });

  test("9 distinct ids are refused before anything is read", async () => {
    const { calls } = stubSl(() => "");
    const t = convexTest(schema, modules);

    await expect(
      asAdmin(t).action(api.baseMatchProbe.probeSlCount, {
        setIds: Array.from({ length: 9 }, (_, i) => `${i}`),
      }),
    ).rejects.toThrow(/At most 8/);
    expect(st.reads.sportlots).toBe(0);
    expect(calls).toHaveLength(0);
  });

  test("8 ids plus a duplicate are accepted", async () => {
    stubSl(() => "");
    const t = convexTest(schema, modules);
    const ids = Array.from({ length: 8 }, (_, i) => `${i}`);

    const out = await asAdmin(t).action(api.baseMatchProbe.probeSlCount, { setIds: [...ids, "0"] });

    expect(out).toHaveLength(8);
  });

  test("a paused SportLots is refused with zero reads and zero fetches", async () => {
    process.env.NEONBINDER_PAUSED_PLATFORMS = "sportlots,buysportscards";
    const { calls } = stubSl(() => "");
    const t = convexTest(schema, modules);

    const out = await asAdmin(t).action(api.baseMatchProbe.probeSlCount, { setIds: ["1"] });

    expect(out).toEqual([{ id: "1", status: "failed", kind: "refused" }]);
    expect(st.reads.sportlots).toBe(0);
    expect(calls).toHaveLength(0);
  });

  test("no cookie answers no_sign_in", async () => {
    st.tokens.sportlots = null;
    stubSl(() => "");
    const t = convexTest(schema, modules);

    const out = await asAdmin(t).action(api.baseMatchProbe.probeSlCount, { setIds: ["1"] });

    expect(out).toEqual([{ id: "1", status: "failed", kind: "no_sign_in" }]);
  });

  test("auth: unauthenticated and non-admin callers are refused", async () => {
    stubSl(() => "");
    const t = convexTest(schema, modules);

    await expect(t.action(api.baseMatchProbe.probeSlCount, { setIds: ["1"] })).rejects.toThrow(
      /Not authenticated/,
    );
    await expect(
      t.withIdentity(NON_ADMIN).action(api.baseMatchProbe.probeSlCount, { setIds: ["1"] }),
    ).rejects.toThrow(/Admin access required/);
    expect(st.reads.sportlots).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// probeBscSets
// ---------------------------------------------------------------------------

type BscCall = { token: string; filters: Record<string, string[]> };

function stubBsc(
  answer: (call: BscCall, n: number) => unknown[] | Response | Error,
) {
  const calls: BscCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      const body = JSON.parse(String(init.body)) as { filters: Record<string, string[]> };
      const call = {
        token: (headers.authorization ?? "").replace(/^Bearer /, ""),
        filters: body.filters,
      };
      calls.push(call);
      const out = answer(call, calls.length);
      if (out instanceof Error) throw out;
      if (out instanceof Response) return out;
      return new Response(JSON.stringify(out), { status: 200 });
    }),
  );
  return calls;
}

let bscSeq = 0;
const bscCard = (no: string, players: string, extra: Record<string, unknown> = {}) => ({
  id: `bsc-${++bscSeq}`,
  cardNo: no,
  players,
  ...extra,
});
const bscVar = (no: string, players: string) =>
  bscCard(no, players, { playerAttribute: "VAR", playerAttributeDesc: "VAR: Action" });

const probeBsc = (t: T, variantTypeId: Id<"selectorOptions">, variantNameIds: string[]) =>
  asAdmin(t).action(api.baseMatchProbe.probeBscSets, { variantTypeId, variantNameIds });

describe("probeBscSets", () => {
  test("each request is the chain's filters with variantName pinned to that one id", async () => {
    const calls = stubBsc(() => [bscCard("1", "Mike Trout")]);
    const t = convexTest(schema, modules);
    const { parallel } = await seedTree(t);

    await probeBsc(t, parallel, ["gold", "blue"]);

    expect(calls.map((c) => c.filters)).toEqual([
      { sport: ["baseball"], year: ["2024"], setName: ["topps-chrome"], variant: ["parallel"], variantName: ["gold"] },
      { sport: ["baseball"], year: ["2024"], setName: ["topps-chrome"], variant: ["parallel"], variantName: ["blue"] },
    ]);
  });

  test("a variantName on the chain is overridden by the probed id", async () => {
    const calls = stubBsc(() => []);
    const t = convexTest(schema, modules);
    const { parallel } = await seedTree(t);
    await t.run(async (ctx) =>
      ctx.db.patch(parallel, {
        platformData: { bsc: { b0: "parallel", b1: "chain-variant-name" } },
        platformFacets: { bsc: { b0: "variant", b1: "variantName" } },
      } as never),
    );

    await probeBsc(t, parallel, ["probed"]);

    expect(calls).toHaveLength(1);
    expect(calls[0].filters.variantName).toEqual(["probed"]);
    expect(calls[0].filters.variant).toEqual(["parallel"]);
  });

  test("count and first skip VAR rows, wherever they sit", async () => {
    stubBsc(() => [
      bscVar("1", "Mike Trout"),
      bscCard("1", "Mike Trout"),
      bscCard("2", "Aaron Judge"),
      bscVar("2", "Aaron Judge"),
    ]);
    const t = convexTest(schema, modules);
    const { parallel } = await seedTree(t);

    const out = await probeBsc(t, parallel, ["gold"]);

    expect(out).toEqual([
      {
        id: "gold",
        status: "ok",
        count: 2,
        first: { cardNumber: "1", cardName: "Mike Trout", players: ["Mike Trout"] },
      },
    ]);
  });

  test("a set with no rows is ok with count 0 and no first", async () => {
    stubBsc(() => []);
    const t = convexTest(schema, modules);
    const { parallel } = await seedTree(t);

    const out = await probeBsc(t, parallel, ["gold"]);

    expect(out).toEqual([{ id: "gold", status: "ok", count: 0 }]);
  });

  test("a parallel type with no variant slot is refused per id with zero reads and zero fetches", async () => {
    const calls = stubBsc(() => []);
    const t = convexTest(schema, modules);
    const { parallel } = await seedTree(t, { parallelSlots: false });

    const out = await probeBsc(t, parallel, ["gold", "blue"]);

    expect(out).toEqual([
      { id: "gold", status: "refused" },
      { id: "blue", status: "refused" },
    ]);
    expect(st.reads.buysportscards).toBe(0);
    expect(calls).toHaveLength(0);
  });

  test("a row that is not a parallel variant type is refused", async () => {
    const calls = stubBsc(() => []);
    const t = convexTest(schema, modules);
    const { base, set } = await seedTree(t);

    expect(await probeBsc(t, base, ["gold"])).toEqual([{ id: "gold", status: "refused" }]);
    expect(await probeBsc(t, set, ["gold"])).toEqual([{ id: "gold", status: "refused" }]);
    expect(st.reads.buysportscards).toBe(0);
    expect(calls).toHaveLength(0);
  });

  test("a deleted variant type is refused", async () => {
    const calls = stubBsc(() => []);
    const t = convexTest(schema, modules);
    const { parallel } = await seedTree(t);
    await t.run(async (ctx) => ctx.db.delete(parallel));

    expect(await probeBsc(t, parallel, ["gold"])).toEqual([{ id: "gold", status: "refused" }]);
    expect(calls).toHaveLength(0);
  });

  test("a missing variantTypeId is rejected by the validator", async () => {
    stubBsc(() => []);
    const t = convexTest(schema, modules);

    await expect(
      asAdmin(t).action(api.baseMatchProbe.probeBscSets, { variantNameIds: ["gold"] } as never),
    ).rejects.toThrow();
    expect(st.reads.buysportscards).toBe(0);
  });

  test("a failing id keeps its place between ok ids", async () => {
    stubBsc((call) =>
      call.filters.variantName[0] === "b"
        ? new Response("no", { status: 500 })
        : [bscCard("1", `Player ${call.filters.variantName[0]}`)],
    );
    const t = convexTest(schema, modules);
    const { parallel } = await seedTree(t);

    const out = await probeBsc(t, parallel, ["a", "b", "c"]);

    expect(out.map((r) => [r.id, r.status, "kind" in r ? r.kind : undefined])).toEqual([
      ["a", "ok", undefined],
      ["b", "failed", "http_error"],
      ["c", "ok", undefined],
    ]);
  });

  test("a thrown fetch fails that id with its kind and the rest still run", async () => {
    stubBsc((call) =>
      call.filters.variantName[0] === "a" ? new Error("socket hang up") : [bscCard("1", "Some Player")],
    );
    const t = convexTest(schema, modules);
    const { parallel } = await seedTree(t);

    const out = await probeBsc(t, parallel, ["a", "b"]);

    expect(out[0]).toEqual({ id: "a", status: "failed", kind: "network" });
    expect(out[1]).toMatchObject({ id: "b", status: "ok", count: 1 });
  });

  test("one token read serves 4 ids", async () => {
    const calls = stubBsc(() => [bscCard("1", "Some Player")]);
    const t = convexTest(schema, modules);
    const { parallel } = await seedTree(t);

    const out = await probeBsc(t, parallel, ["a", "b", "c", "d"]);

    expect(out).toHaveLength(4);
    expect(calls).toHaveLength(4);
    expect(st.reads.buysportscards).toBe(1);
    expect(st.reads.sportlots).toBe(0);
    expect(calls.every((c) => c.token === BSC_TOKEN)).toBe(true);
  });

  test("after a 401 the session is re-authenticated and the next id sends the refreshed token", async () => {
    st.onAuth = () => {
      st.tokens.buysportscards = "REFRESHED-TOKEN-QQ";
    };
    const calls = stubBsc((call) =>
      call.token === BSC_TOKEN
        ? new Response("expired", { status: 401 })
        : [bscCard("1", "Some Player")],
    );
    const t = convexTest(schema, modules);
    const { parallel } = await seedTree(t);

    const out = await probeBsc(t, parallel, ["a", "b"]);

    expect(out.map((r) => r.status)).toEqual(["ok", "ok"]);
    expect(st.authCalls).toBe(1);
    // The first id: stale token, 401, then the refreshed one. The second id
    // goes straight out with the refreshed token and does not 401 again.
    expect(calls.map((c) => c.token)).toEqual([BSC_TOKEN, "REFRESHED-TOKEN-QQ", "REFRESHED-TOKEN-QQ"]);
    // One batch read, plus the one re-read after the re-auth.
    expect(st.reads.buysportscards).toBe(2);
  });

  test("a 5th distinct id is refused before anything is read", async () => {
    const calls = stubBsc(() => []);
    const t = convexTest(schema, modules);
    const { parallel } = await seedTree(t);

    await expect(probeBsc(t, parallel, ["a", "b", "c", "d", "e"])).rejects.toThrow(/At most 4/);
    expect(st.reads.buysportscards).toBe(0);
    expect(calls).toHaveLength(0);
  });

  test("4 ids plus duplicates are accepted and fetched once each", async () => {
    const calls = stubBsc(() => []);
    const t = convexTest(schema, modules);
    const { parallel } = await seedTree(t);

    const out = await probeBsc(t, parallel, ["a", "b", "c", "d", "a", "b"]);

    expect(out.map((r) => r.id)).toEqual(["a", "b", "c", "d"]);
    expect(calls).toHaveLength(4);
  });

  test("a 201-character id is refused, a 200-character one is accepted", async () => {
    const calls = stubBsc(() => []);
    const t = convexTest(schema, modules);
    const { parallel } = await seedTree(t);

    await expect(probeBsc(t, parallel, ["x".repeat(201)])).rejects.toThrow();
    expect(calls).toHaveLength(0);
    const out = await probeBsc(t, parallel, ["x".repeat(200)]);
    expect(out).toHaveLength(1);
  });

  test("an empty or control-character id is refused", async () => {
    stubBsc(() => []);
    const t = convexTest(schema, modules);
    const { parallel } = await seedTree(t);

    await expect(probeBsc(t, parallel, [""])).rejects.toThrow();
    await expect(probeBsc(t, parallel, ["a\u0000b"])).rejects.toThrow();
  });

  test("a paused BuySportsCards is refused with zero reads and zero fetches", async () => {
    process.env.NEONBINDER_PAUSED_PLATFORMS = "buysportscards";
    const calls = stubBsc(() => []);
    const t = convexTest(schema, modules);
    const { parallel } = await seedTree(t);

    const out = await probeBsc(t, parallel, ["a", "b"]);

    expect(out).toEqual([
      { id: "a", status: "failed", kind: "refused" },
      { id: "b", status: "failed", kind: "refused" },
    ]);
    expect(st.reads.buysportscards).toBe(0);
    expect(calls).toHaveLength(0);
  });

  test("no BSC token answers no_sign_in for every id and fetches nothing", async () => {
    st.tokens.buysportscards = null;
    const calls = stubBsc(() => []);
    const t = convexTest(schema, modules);
    const { parallel } = await seedTree(t);

    const out = await probeBsc(t, parallel, ["a", "b"]);

    expect(out).toEqual([
      { id: "a", status: "failed", kind: "no_sign_in" },
      { id: "b", status: "failed", kind: "no_sign_in" },
    ]);
    expect(calls).toHaveLength(0);
  });

  test("auth: unauthenticated and non-admin callers are refused", async () => {
    const calls = stubBsc(() => []);
    const t = convexTest(schema, modules);
    const { parallel } = await seedTree(t);

    await expect(
      t.action(api.baseMatchProbe.probeBscSets, { variantTypeId: parallel, variantNameIds: ["a"] }),
    ).rejects.toThrow(/Not authenticated/);
    await expect(
      t.withIdentity(NON_ADMIN).action(api.baseMatchProbe.probeBscSets, {
        variantTypeId: parallel,
        variantNameIds: ["a"],
      }),
    ).rejects.toThrow(/Admin access required/);
    expect(st.reads.buysportscards).toBe(0);
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Common: read-only, and no secret in a log line
// ---------------------------------------------------------------------------

describe("the probes write nothing and log no secret", () => {
  test("no table changes across a run of every probe, including failures and a re-auth", async () => {
    st.onAuth = () => {
      st.tokens.buysportscards = "REFRESHED-TOKEN-QQ";
    };
    const t = convexTest(schema, modules);
    const { base, parallel } = await seedTree(t);
    await addCards(t, base, [{ cardNumber: "1", sortOrder: 1 }]);
    // The credential lock (and a re-auth's status write) may insert or patch
    // the caller's `userProfiles` row: that is the F2 allowance, so the table
    // is compared apart. Every other table must not change at all, and the
    // profile must come back with the same credential status once the lock
    // fields are taken off.
    await t.run(async (ctx) =>
      ctx.db.insert("userProfiles", {
        userId: ADMIN.subject,
        siteCredentials: [
          { site: "buysportscards", hasCredentials: true, lastUpdated: "2026-10-01T00:00:00.000Z" },
        ],
      } as never),
    );
    const before = await rowCounts(t, ["userProfiles"]);
    const profileBefore = await profileWithoutLock(t);

    stubSl((id, start) =>
      id === "2" ? new Response("x", { status: 500 }) : start === 1 ? slRow("1", "Some Player") : "",
    );
    await asAdmin(t).action(api.baseMatchProbe.probeSlFirstPage, { setIds: ["1", "2"] });
    await asAdmin(t).action(api.baseMatchProbe.probeSlCount, { setIds: ["1", "2"] });
    stubBsc((call) =>
      call.token === BSC_TOKEN ? new Response("x", { status: 401 }) : [bscCard("1", "Some Player")],
    );
    await probeBsc(t, parallel, ["a", "b"]);
    await sig(t, parallel);

    expect(await rowCounts(t, ["userProfiles"])).toEqual(before);
    expect(await profileWithoutLock(t)).toEqual(profileBefore);
  });

  test("neither the SportLots cookie nor a BSC token reaches the console", async () => {
    st.onAuth = () => {
      st.tokens.buysportscards = "REFRESHED-TOKEN-QQ";
    };
    const t = convexTest(schema, modules);
    const { parallel } = await seedTree(t);

    stubSl((id, start) =>
      id === "2" ? new Response("x", { status: 500 }) : start === 1 ? slRow("1", "Some Player") : "",
    );
    await asAdmin(t).action(api.baseMatchProbe.probeSlFirstPage, { setIds: ["1", "2"] });
    await asAdmin(t).action(api.baseMatchProbe.probeSlCount, { setIds: ["1", "2"] });
    stubBsc((call) =>
      call.token === BSC_TOKEN ? new Response("x", { status: 401 }) : [bscCard("1", "Some Player")],
    );
    await probeBsc(t, parallel, ["a", "b"]);

    const text = loggedText();
    // Guard the guard: the probes did log, so an empty haystack proves nothing.
    expect(text).toContain("base_match_probe");
    expect(text).not.toContain("SECRET-COOKIE-ZZ");
    expect(text).not.toContain("SECRET-TOKEN-ZZ");
    expect(text).not.toContain("REFRESHED-TOKEN-QQ");
  });
});

// ---------------------------------------------------------------------------
// The internal batch actions trust nothing: they re-check what the public
// actions already checked (the public layer alone is unobservable behind them,
// so these call the adapters directly).
// ---------------------------------------------------------------------------

describe("the internal batch actions re-check their own inputs", () => {
  test("probeSlListcardsBatch refuses a paused SportLots before any session read or fetch", async () => {
    process.env.NEONBINDER_PAUSED_PLATFORMS = "sportlots";
    const { calls } = stubSl(() => "");
    const t = convexTest(schema, modules);

    const out = await asAdmin(t).action(internal.adapters.sportlots.probeSlListcardsBatch, {
      setIds: ["1"],
      mode: "firstPage",
    });

    expect(out).toEqual([{ id: "1", status: "failed", kind: "refused" }]);
    expect(st.reads.sportlots).toBe(0);
    expect(calls).toHaveLength(0);
  });

  test("probeSlListcardsBatch applies the per-mode cap itself", async () => {
    stubSl(() => "");
    const t = convexTest(schema, modules);
    const nine = Array.from({ length: 9 }, (_, i) => `${i}`);

    await expect(
      asAdmin(t).action(internal.adapters.sportlots.probeSlListcardsBatch, { setIds: nine, mode: "count" }),
    ).rejects.toThrow(/At most 8/);
    // The same nine are fine for a first-page batch.
    const out = await asAdmin(t).action(internal.adapters.sportlots.probeSlListcardsBatch, {
      setIds: nine,
      mode: "firstPage",
    });
    expect(out).toHaveLength(9);
  });

  test("probeSlListcardsBatch needs an admin", async () => {
    stubSl(() => "");
    const t = convexTest(schema, modules);

    await expect(
      t.action(internal.adapters.sportlots.probeSlListcardsBatch, { setIds: ["1"], mode: "count" }),
    ).rejects.toThrow(/Not authenticated/);
  });

  test("probeBscChecklistBatch refuses a paused BuySportsCards before any token read or fetch", async () => {
    process.env.NEONBINDER_PAUSED_PLATFORMS = "buysportscards";
    const calls = stubBsc(() => []);
    const t = convexTest(schema, modules);

    const out = await asAdmin(t).action(internal.adapters.buysportscards.probeBscChecklistBatch, {
      requests: [{ id: "a", facetFilters: { sport: ["baseball"] } }],
    });

    expect(out).toEqual([{ id: "a", status: "failed", kind: "refused" }]);
    expect(st.reads.buysportscards).toBe(0);
    expect(calls).toHaveLength(0);
  });

  test("probeBscChecklistBatch rejects duplicate request ids and a fifth request", async () => {
    const calls = stubBsc(() => []);
    const t = convexTest(schema, modules);
    const req = (id: string) => ({ id, facetFilters: { sport: ["baseball"] } });

    await expect(
      asAdmin(t).action(internal.adapters.buysportscards.probeBscChecklistBatch, {
        requests: [req("a"), req("a")],
      }),
    ).rejects.toThrow(/duplicate/);
    await expect(
      asAdmin(t).action(internal.adapters.buysportscards.probeBscChecklistBatch, {
        requests: ["a", "b", "c", "d", "e"].map(req),
      }),
    ).rejects.toThrow(/At most 4/);
    expect(st.reads.buysportscards).toBe(0);
    expect(calls).toHaveLength(0);
  });

  test("probeBscChecklistBatch refuses an under-scoped request without widening it", async () => {
    const calls = stubBsc(() => [bscCard("1", "Some Player")]);
    const t = convexTest(schema, modules);

    const out = await asAdmin(t).action(internal.adapters.buysportscards.probeBscChecklistBatch, {
      requests: [{ id: "a", facetFilters: { sport: ["baseball"], variantName: ["a"] } }],
    });

    expect(out).toEqual([{ id: "a", status: "failed", kind: "refused" }]);
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The id check itself (isProbeId / checkProbeIds)
// ---------------------------------------------------------------------------

describe("isProbeId", () => {
  const BSC = { maxLength: 200 };
  const SL = { maxLength: 64, pattern: SL_PROBE_ID_PATTERN };

  test.each([
    ["a leading space", " gold"],
    ["a trailing space", "gold "],
    ["a leading no-break space", "\u00a0gold"],
    ["a trailing no-break space", "gold\u00a0"],
    ["a leading byte-order mark", "\ufeffgold"],
    ["a trailing newline", "gold\n"],
    ["a tab inside", "go\tld"],
    ["a DEL inside", "go\u007fld"],
    ["a C1 control (NEL) inside", "go\u0085ld"],
    ["the last C1 control inside", "go\u009fld"],
    ["a line separator (U+2028) inside", "go\u2028ld"],
    ["a paragraph separator (U+2029) inside", "go\u2029ld"],
    ["a NUL inside", "go\u0000ld"],
  ])("refuses %s even with no id shape to check", (_label, id) => {
    expect(isProbeId(id, BSC)).toBe(false);
  });

  test("accepts a BSC slug", () => {
    expect(isProbeId("2024-topps-chrome-gold-refractor", BSC)).toBe(true);
  });

  test("the character just past C1 (U+00A0 inside, U+00A1) is judged on its own", () => {
    // U+00A1 is a plain character: it must not be caught by the C1 range.
    expect(isProbeId("go\u00a1ld", BSC)).toBe(true);
  });

  test("refuses an empty id and an id one character over the bound", () => {
    expect(isProbeId("", BSC)).toBe(false);
    expect(isProbeId("x".repeat(200), BSC)).toBe(true);
    expect(isProbeId("x".repeat(201), BSC)).toBe(false);
  });

  test.each([["abc"], ["12a"], ["-1"], ["1.5"], ["\u0661\u0662"], ["1 2"], ["１２"]])(
    "the SportLots shape refuses %j, which a bare slug check would take",
    (id) => {
      expect(isProbeId(id, BSC)).toBe(true);
      expect(isProbeId(id, SL)).toBe(false);
    },
  );

  test("the SportLots shape accepts a numeric set id, up to its length bound", () => {
    expect(isProbeId("328996", SL)).toBe(true);
    expect(isProbeId("1".repeat(64), SL)).toBe(true);
    expect(isProbeId("1".repeat(65), SL)).toBe(false);
  });
});

describe("checkProbeIds", () => {
  const SL = { max: 3, maxLength: 64, pattern: SL_PROBE_ID_PATTERN };

  test("keeps first-seen order and drops repeats", () => {
    expect(checkProbeIds(["3", "1", "3", "2", "1"], SL)).toEqual(["3", "1", "2"]);
  });

  test("one bad id refuses the call whatever its size, ahead of the count", () => {
    // Four distinct ids is over the cap, but the bad id is what is named.
    expect(() => checkProbeIds(["1", "2", "3", "abc"], SL)).toThrow(/not plain text/);
  });

  test("more than max distinct ids is refused, duplicates not counted", () => {
    expect(() => checkProbeIds(["1", "2", "3", "4"], SL)).toThrow(/At most 3/);
    expect(checkProbeIds(["1", "2", "3", "3", "2"], SL)).toHaveLength(3);
  });

  test("the refusal names the bound, never the id", () => {
    let message = "";
    try {
      checkProbeIds(["secret-looking-id"], SL);
    } catch (err) {
      message = String((err as { data?: unknown }).data ?? err);
    }
    expect(message).not.toContain("secret-looking-id");
    expect(message).toContain("64");
  });
});

describe("a non-numeric SportLots set id refuses the whole call before any cookie read", () => {
  const bad = ["12a", "abc", "-1", "1.5", "\u0661\u0662", " 12", "12\u2028"];

  test.each(bad.map((b) => [JSON.stringify(b), b]))("probeSlFirstPage, %s", async (_l, id) => {
    const { calls } = stubSl(() => "");
    const t = convexTest(schema, modules);

    await expect(
      asAdmin(t).action(api.baseMatchProbe.probeSlFirstPage, { setIds: ["11", id] }),
    ).rejects.toThrow(/not plain text/);
    expect(st.reads.sportlots).toBe(0);
    expect(calls).toHaveLength(0);
  });

  test.each(bad.map((b) => [JSON.stringify(b), b]))("probeSlCount, %s", async (_l, id) => {
    const { calls } = stubSl(() => "");
    const t = convexTest(schema, modules);

    await expect(
      asAdmin(t).action(api.baseMatchProbe.probeSlCount, { setIds: ["11", id] }),
    ).rejects.toThrow(/not plain text/);
    expect(st.reads.sportlots).toBe(0);
    expect(calls).toHaveLength(0);
  });

  test.each(["firstPage", "count"] as const)(
    "the internal batch, %s mode, checks the shape itself",
    async (mode) => {
      const { calls } = stubSl(() => "");
      const t = convexTest(schema, modules);

      await expect(
        asAdmin(t).action(internal.adapters.sportlots.probeSlListcardsBatch, {
          setIds: ["11", "12a"],
          mode,
        }),
      ).rejects.toThrow(/not plain text/);
      expect(st.reads.sportlots).toBe(0);
      expect(calls).toHaveLength(0);
    },
  );

  test("a numeric id beside a duplicate still goes through", async () => {
    stubSl(() => slRow("1", "Some Player"));
    const t = convexTest(schema, modules);

    const out = await asAdmin(t).action(api.baseMatchProbe.probeSlFirstPage, {
      setIds: ["328996", "328996"],
    });

    expect(out.map((r) => r.id)).toEqual(["328996"]);
  });
});
