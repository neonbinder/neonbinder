/**
 * NEO-306 — the backstop: no SportLots-only auto-sync of the rows under a
 * variant type that has NO role.
 *
 * What happened on a PR preview: "Clear base set" removed `isBase` from an
 * SL-only set's Base and left the row. Base stopped being terminal, the
 * cascade opened an Inserts column under it, and the drill's auto-sync asked
 * SportLots — which answers `insert` with every set the brand has that year.
 * Those junk rows' SL ids then counted as covered and hid real sets from Sync
 * Sets and the review.
 *
 * The clear is gone (`setBaseVariantType.test.ts`), but a legacy row can still
 * be in that state. So `ensureSelectorOptions` refuses exactly this case on
 * DRILL: level `insert`, parent a variant type with no NB role, BSC not asked
 * for want of ids, SportLots askable. Pinned alongside it, the cases that must
 * keep syncing: a role'd type, a role-less type BSC can scope (an
 * "Autographs" type), and an explicit Sync.
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Doc, Id } from "./_generated/dataModel";

const modules = (
  import.meta as unknown as {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("./**/*.*s");

/** Credentials are not under test — hand both adapters a token. */
vi.mock("./credentials", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./credentials")>();
  const { internalAction } = await import("./_generated/server");
  const { v } = await import("convex/values");
  return {
    ...actual,
    getSiteToken: internalAction({
      args: { site: v.string() },
      returns: v.any(),
      handler: async () => ({ token: "test-token" }),
    }),
    authenticateBsc: internalAction({
      args: {},
      returns: v.any(),
      handler: async () => ({ success: true }),
    }),
  };
});

const ADMIN = {
  subject: "admin_roleless_vt",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_roleless_vt",
  role: "admin",
};

const SENTINEL = 1_000_000;

/** Every outgoing request, answered with an empty 200. */
let outgoing: string[] = [];

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  outgoing = [];
  vi.stubGlobal(
    "fetch",
    (async (input: RequestInfo | URL) => {
      outgoing.push(String(input instanceof Request ? input.url : input));
      return new Response(JSON.stringify({ aggregations: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch,
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type Metadata = Doc<"selectorOptions">["metadata"];

/**
 * sport → year → brand → set → variant type, linked the way an SL-first
 * build is: sport/year/brand carry SportLots scope, the set row carries
 * nothing of its own, and the variant type carries the SL SET id (which is
 * what makes SportLots count the set as linked). `bsc` adds BSC ids on the
 * sport, year and set plus a `variant`-tagged id on the type.
 */
async function seedChain(
  t: ReturnType<typeof convexTest>,
  opts: { metadata?: Metadata; bsc?: { variantId: string } },
): Promise<Id<"selectorOptions">> {
  const bsc = (id: string) => (opts.bsc ? { bsc: { b0: id } } : {});
  return t.run(async (ctx) => {
    const sport = await ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Baseball",
      platformData: { ...bsc("baseball"), sportlots: { s0: "BB" } },
      children: [],
      lastUpdated: SENTINEL,
    });
    const year = await ctx.db.insert("selectorOptions", {
      level: "year",
      value: "2024",
      platformData: { ...bsc("2024"), sportlots: { s0: "2024" } },
      parentId: sport,
      children: [],
      lastUpdated: SENTINEL,
    });
    const brand = await ctx.db.insert("selectorOptions", {
      level: "manufacturer",
      value: "Topps",
      platformData: { sportlots: { s0: "TP" } },
      parentId: year,
      children: [],
      lastUpdated: SENTINEL,
    });
    const set = await ctx.db.insert("selectorOptions", {
      level: "setName",
      value: "Topps Heritage",
      platformData: { ...bsc("2024-topps-heritage") },
      parentId: brand,
      children: [],
      lastUpdated: SENTINEL,
    });
    return ctx.db.insert("selectorOptions", {
      level: "variantType",
      value: "Base",
      platformData: {
        ...(opts.bsc ? { bsc: { b0: opts.bsc.variantId } } : {}),
        sportlots: { s0: "884412" },
      },
      ...(opts.bsc ? { platformFacets: { bsc: { b0: "variant" as const } } } : {}),
      ...(opts.metadata ? { metadata: opts.metadata } : {}),
      parentId: set,
      children: [],
      lastUpdated: SENTINEL,
    });
  });
}

const drill = (
  t: ReturnType<typeof convexTest>,
  parentId: Id<"selectorOptions">,
  force?: boolean,
) =>
  t.withIdentity(ADMIN).action(api.selectorOptions.ensureSelectorOptions, {
    level: "insert",
    parentId,
    ...(force ? { force } : {}),
  });

const insertRowsUnder = (
  t: ReturnType<typeof convexTest>,
  parentId: Id<"selectorOptions">,
) =>
  t.run(async (ctx) =>
    ctx.db
      .query("selectorOptions")
      .withIndex("by_level_and_parent", (q) =>
        q.eq("level", "insert").eq("parentId", parentId),
      )
      .collect(),
  );

describe("ensureSelectorOptions at insert — a role-less variant type", () => {
  test.each([
    ["no metadata at all (a Base that lost its flag)", undefined],
    ["a legacy `isBase: false`", { isBase: false }],
    ["unrelated metadata only", { cardNumberPrefix: "B-" }],
  ] as const)(
    "%s, SportLots-only: the drill does NOT sync, and no marketplace is asked",
    async (_label, metadata) => {
      const t = convexTest(schema, modules);
      const typeId = await seedChain(t, {
        metadata: metadata as Metadata,
      });

      const res = await drill(t, typeId);

      expect(res.ran).toBe(false);
      expect(res.reason).toBe("no_variant_role");
      expect(outgoing).toEqual([]);
      expect(await insertRowsUnder(t, typeId)).toEqual([]);
      // The column goes idle — the same instant state a hand-made subtree
      // gets — so rows can still be added by hand.
      expect(
        await t
          .withIdentity(ADMIN)
          .query(api.selectorOptions.getSelectorSyncStatus, {
            level: "insert",
            parentId: typeId,
          }),
      ).toBeNull();
    },
  );

  test("an explicit Sync (force) is the operator's call and still runs", async () => {
    const t = convexTest(schema, modules);
    const typeId = await seedChain(t, {});

    const res = await drill(t, typeId, true);

    expect(res.ran).toBe(true);
    expect(res.reason).not.toBe("no_variant_role");
    expect(outgoing.length).toBeGreaterThan(0);
  });

  test.each(["insert", "parallel"] as const)(
    "a type with variantRole %s is NOT blocked: SportLots' pool is what its column is for",
    async (variantRole) => {
      const t = convexTest(schema, modules);
      const typeId = await seedChain(t, { metadata: { variantRole } });

      const res = await drill(t, typeId);

      expect(res.ran).toBe(true);
      expect(res.reason).not.toBe("no_variant_role");
      expect(outgoing.length).toBeGreaterThan(0);
    },
  );

  test("a role-less type BSC can scope (an 'Autographs' type) still syncs its rows, from BSC", async () => {
    // `autographs` names neither insert nor parallel, so the sync never
    // conferred a role — and it legitimately has children on BSC.
    const t = convexTest(schema, modules);
    const typeId = await seedChain(t, { bsc: { variantId: "autographs" } });

    const res = await drill(t, typeId);

    expect(res.ran).toBe(true);
    expect(res.reason).not.toBe("no_variant_role");
    expect(res.skippedSides).not.toContain("bsc");
    expect(outgoing.length).toBeGreaterThan(0);
  });

  test("the block is by ROLE, never by name: a role-less type named 'Inserts' is blocked too", async () => {
    const t = convexTest(schema, modules);
    const typeId = await seedChain(t, {});
    await t.run(async (ctx) => ctx.db.patch(typeId, { value: "Inserts" }));

    const res = await drill(t, typeId);

    expect(res.reason).toBe("no_variant_role");
    expect(outgoing).toEqual([]);
  });
});
