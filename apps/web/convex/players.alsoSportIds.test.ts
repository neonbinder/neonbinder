/**
 * NEO-318 — `players.alsoSportIds`, the derived copy of `playerSports` the
 * Players admin list reads. The writer's own behaviour is pinned in
 * players.crossSport.test.ts; this file covers the READ side:
 *
 *   - `listForManagement` returns the copy and agrees with `getByIdParam`
 *     (which still reads the side table, the authority);
 *   - every other public shape strips it, and the raw internal read keeps it
 *     (convex-test validates `returns`, so a leak fails the call);
 *   - the list's read count does not depend on how many players it lists.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { listForManagementImpl, normalizePlayerName } from "./players";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

type T = ReturnType<typeof convexTest>;

const ADMIN_IDENTITY = {
  subject: "user_also_sports_admin",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|user_also_sports_admin",
  role: "admin",
};

async function seedSport(t: T, value: string): Promise<Id<"selectorOptions">> {
  return t.run((ctx) =>
    ctx.db.insert("selectorOptions", {
      level: "sport",
      value,
      platformData: {},
      children: [],
      lastUpdated: Date.now(),
    }),
  );
}

async function insertPlayers(
  t: T,
  sportId: Id<"selectorOptions">,
  names: string[],
): Promise<Id<"players">[]> {
  return t.run(async (ctx) => {
    const ids: Id<"players">[] = [];
    for (const name of names) {
      ids.push(
        await ctx.db.insert("players", {
          name,
          nameNormalized: normalizePlayerName(name),
          sportId,
          createdByUserId: "user_seed",
          lastUpdated: Date.now(),
        }),
      );
    }
    return ids;
  });
}

describe("listForManagement reads the alsoSportIds copy", () => {
  test("returns the copy, and agrees with getByIdParam for every row", async () => {
    const t = convexTest(schema, modules);
    const football = await seedSport(t, "Football");
    const baseball = await seedSport(t, "Baseball");
    const hockey = await seedSport(t, "Hockey");
    const [bo, deion, solo] = await insertPlayers(t, football, [
      "Bo Jackson",
      "Deion Sanders",
      "Solo Player",
    ]);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    await asAdmin.mutation(api.players.setAdditionalSports, {
      playerId: bo,
      sportIds: [baseball, hockey],
    });
    await asAdmin.mutation(api.players.setAdditionalSports, {
      playerId: deion,
      sportIds: [baseball],
    });

    const list = await asAdmin.query(api.players.listForManagement, {});

    expect(list.players).toHaveLength(3);
    const byId = new Map(list.players.map((p) => [p._id, p.alsoSportIds]));
    expect(byId.get(bo)).toEqual([baseball, hockey]);
    expect(byId.get(deion)).toEqual([baseball]);
    expect(byId.get(solo)).toEqual([]);
    for (const row of list.players) {
      const detail = await asAdmin.query(api.players.getByIdParam, { id: row._id });
      expect(row.alsoSportIds).toEqual(detail?.alsoSportIds);
    }
  });

  test("a member listed under the other sport carries the copy too", async () => {
    const t = convexTest(schema, modules);
    const football = await seedSport(t, "Football");
    const baseball = await seedSport(t, "Baseball");
    const [bo] = await insertPlayers(t, football, ["Bo Jackson"]);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    await asAdmin.mutation(api.players.setAdditionalSports, {
      playerId: bo,
      sportIds: [baseball],
    });

    const list = await asAdmin.query(api.players.listForManagement, { sportId: baseball });

    expect(list.players.map((p) => [p._id, p.alsoSportIds])).toEqual([[bo, [baseball]]]);
  });

  test("raw-seeded playerSports rows with no copy list as [] (pre-existing rows need a fill)", async () => {
    // Documents the migration seam: the list trusts the copy, so a row whose
    // membership predates the column shows no chip until a fill (or any
    // setAdditionalSports call) writes it.
    const t = convexTest(schema, modules);
    const football = await seedSport(t, "Football");
    const baseball = await seedSport(t, "Baseball");
    const [bo] = await insertPlayers(t, football, ["Bo Jackson"]);
    await t.run((ctx) =>
      ctx.db.insert("playerSports", {
        playerId: bo,
        sportId: baseball,
        nameNormalized: normalizePlayerName("Bo Jackson"),
      }),
    );
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const list = await asAdmin.query(api.players.listForManagement, {});
    const detail = await asAdmin.query(api.players.getByIdParam, { id: bo });

    expect(list.players[0].alsoSportIds).toEqual([]);
    // The authority still knows; only the list's copy is behind.
    expect(detail?.alsoSportIds).toEqual([baseball]);
  });
});

describe("the alsoSportIds copy never leaks into a public player shape", () => {
  test("every public read succeeds against a row that carries the copy; only getInternal returns it", async () => {
    const t = convexTest(schema, modules);
    const football = await seedSport(t, "Football");
    const baseball = await seedSport(t, "Baseball");
    const [bo] = await insertPlayers(t, football, ["Bo Jackson"]);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    await asAdmin.mutation(api.players.setAdditionalSports, {
      playerId: bo,
      sportIds: [baseball],
    });

    const found = await asAdmin.query(api.players.findByNameAndSport, {
      name: "Bo Jackson",
      sportId: football,
    });
    const listed = await asAdmin.query(api.players.list, { sportId: football });
    const got = await asAdmin.query(api.players.get, { id: bo });
    const many = await asAdmin.query(api.players.getManyByIds, { ids: [bo] });
    const searched = await asAdmin.query(api.players.search, { query: "Bo Jackson" });
    const byParam = await asAdmin.query(api.players.getByIdParam, { id: bo });
    const managed = await asAdmin.query(api.players.listForManagement, {});
    const internalRow = await t.query(internal.players.getInternal, { id: bo });

    expect(found?._id).toBe(bo);
    expect(listed.map((p) => p._id)).toEqual([bo]);
    expect(got?._id).toBe(bo);
    expect(many.map((p) => p._id)).toEqual([bo]);
    expect(searched.length).toBeGreaterThan(0);
    expect(found).not.toHaveProperty("alsoSportIds");
    expect(listed[0]).not.toHaveProperty("alsoSportIds");
    expect(got).not.toHaveProperty("alsoSportIds");
    expect(many[0]).not.toHaveProperty("alsoSportIds");
    // The two shapes that DO carry it, by design.
    expect(byParam?.alsoSportIds).toEqual([baseball]);
    expect(managed.players[0].alsoSportIds).toEqual([baseball]);
    expect(internalRow?.alsoSportIds).toEqual([baseball]);
  });
});

describe("listForManagementImpl read count is independent of how many players it lists", () => {
  type Counts = { query: number; get: number };

  function countingCtx(ctx: QueryCtx): { ctx: QueryCtx; counts: Counts } {
    const counts: Counts = { query: 0, get: 0 };
    const db = new Proxy(ctx.db, {
      get(target, prop, receiver) {
        if (prop === "query" || prop === "get") counts[prop]++;
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    return { ctx: { ...ctx, db } as QueryCtx, counts };
  }

  async function countsFor(t: T, sportId?: Id<"selectorOptions">) {
    return t.run(async (ctx) => {
      const counted = countingCtx(ctx);
      const result = await listForManagementImpl(counted.ctx, sportId ? { sportId } : {});
      return { counts: counted.counts, listed: result.players.length };
    });
  }

  async function seed(t: T, homeCount: number, offset: number) {
    const baseball = await seedSport(t, "Baseball");
    const football = await seedSport(t, "Football");
    await insertPlayers(
      t,
      baseball,
      Array.from({ length: homeCount }, (_, i) => `Home Player ${String(i + offset).padStart(4, "0")}`),
    );
    const guests = await insertPlayers(t, football, ["Bo Jackson", "Deion Sanders"]);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    for (const playerId of guests) {
      await asAdmin.mutation(api.players.setAdditionalSports, { playerId, sportIds: [baseball] });
    }
    return { baseball };
  }

  test("sport view: one playerSports query, one players query, one get per MEMBER only", async () => {
    const t = convexTest(schema, modules);
    const { baseball } = await seed(t, 30, 0);

    const { counts, listed } = await countsFor(t, baseball);

    expect(listed).toBe(32);
    expect(counts).toEqual({ query: 2, get: 2 });
  });

  test("sport view: 60+ more home players change neither count", async () => {
    const t = convexTest(schema, modules);
    const { baseball } = await seed(t, 30, 0);
    const small = await countsFor(t, baseball);
    await insertPlayers(
      t,
      baseball,
      Array.from({ length: 65 }, (_, i) => `Extra Player ${String(i).padStart(4, "0")}`),
    );

    const large = await countsFor(t, baseball);

    expect(large.listed).toBe(97);
    expect(large.counts).toEqual(small.counts);
    expect(large.counts).toEqual({ query: 2, get: 2 });
  });

  test("all-sports view: a single query and no gets, however many players", async () => {
    const t = convexTest(schema, modules);
    const { baseball } = await seed(t, 30, 0);
    const small = await countsFor(t);
    await insertPlayers(
      t,
      baseball,
      Array.from({ length: 65 }, (_, i) => `Extra Player ${String(i).padStart(4, "0")}`),
    );

    const large = await countsFor(t);

    expect(small.counts).toEqual({ query: 1, get: 0 });
    expect(large.listed).toBe(97);
    expect(large.counts).toEqual({ query: 1, get: 0 });
  });
});
