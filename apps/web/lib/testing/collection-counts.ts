/**
 * NEO-359 — hand counts of a collector's containers and tally, for the
 * collection tests. Compares what the rows say with what the containers store,
 * so a write path that forgets to move a count goes red.
 *
 * Lives under lib/ rather than convex/ so it is never deployed as a module.
 */

import type { convexTest } from "convex-test";
import type { Id } from "../../convex/_generated/dataModel";

type T = ReturnType<typeof convexTest>;

export type Count = { copies: number; lines: number };

/** What every container of `ownerId` SHOULD count, from the rows, by id. */
export async function truthByContainer(t: T, ownerId: string) {
  const entries = await t.run(async (ctx) => {
    const containers = (await ctx.db.query("collectionContainers").collect()).filter(
      (c) => c.ownerId === ownerId,
    );
    const copies = (await ctx.db.query("collectionCopies").collect()).filter(
      (c) => c.ownerId === ownerId,
    );
    const wants = (await ctx.db.query("collectionWants").collect()).filter(
      (w) => w.ownerId === ownerId,
    );
    const out: Array<
      [Id<"collectionContainers">, { name: string; system: string | null; stored: Count | null; truth: Count }]
    > = [];
    for (const c of containers) {
      let rows: typeof copies;
      let truth: Count;
      if (c.system === "want") {
        truth = { copies: wants.length, lines: wants.length };
      } else {
        rows = c.system === "trade" ? copies.filter((r) => r.upForTrade === true) : copies.filter((r) => r.homeId === c._id);
        truth = { copies: rows.reduce((n, r) => n + r.quantity, 0), lines: rows.length };
      }
      out.push([c._id, { name: c.name, system: c.system ?? null, stored: c.count ?? null, truth }]);
    }
    return out;
  });
  return new Map(entries);
}

/** Every stored container count equals the hand count; none is absent. Returns the map. */
export async function expectCountsExact(t: T, ownerId: string, expect: (v: unknown) => { toEqual: (x: unknown) => void }) {
  const map = await truthByContainer(t, ownerId);
  for (const [, row] of map) {
    expect({ name: row.name, count: row.stored }).toEqual({ name: row.name, count: row.truth });
  }
  return map;
}

/**
 * The owner tally on Main equals the hand count (copies, lines, distinct
 * cards) of the COLLECTION side only (NEO-364): rows whose home is a binder
 * (Main included, or no home). Box lines never count.
 */
export async function tallyTruth(t: T, ownerId: string) {
  return t.run(async (ctx) => {
    const containers = (await ctx.db.query("collectionContainers").collect()).filter(
      (c) => c.ownerId === ownerId,
    );
    const kindOf = new Map(containers.map((c) => [c._id as string, c.kind]));
    const rows = (await ctx.db.query("collectionCopies").collect()).filter(
      (c) =>
        c.ownerId === ownerId &&
        (c.homeId === undefined || (kindOf.has(c.homeId as string) && kindOf.get(c.homeId as string) !== "box")),
    );
    const main = containers.find((c) => c.system === "main");
    return {
      stored: main?.tally ?? null,
      truth: {
        copies: rows.reduce((n, r) => n + r.quantity, 0),
        lines: rows.length,
        cards: new Set(rows.map((r) => r.cardId as string)).size,
      },
    };
  });
}

/** What every box of `ownerId` holds by hand: copies, lines (the inventory side). */
export async function boxTruth(t: T, ownerId: string) {
  return t.run(async (ctx) => {
    const boxes = (await ctx.db.query("collectionContainers").collect()).filter(
      (c) => c.ownerId === ownerId && c.kind === "box",
    );
    const ids = new Set(boxes.map((b) => b._id as string));
    const rows = (await ctx.db.query("collectionCopies").collect()).filter(
      (c) => c.ownerId === ownerId && c.homeId !== undefined && ids.has(c.homeId as string),
    );
    return {
      copies: rows.reduce((n, r) => n + r.quantity, 0),
      lines: rows.length,
      cards: new Set(rows.map((r) => r.cardId as string)).size,
    };
  });
}

/**
 * Every set build of `ownerId`: what its row keeps (`kept`, null = absent),
 * its scope stamp, and the hand count of distinct cards held in it on the
 * COLLECTION side (NEO-364: binder-home rows only, never a box).
 */
export async function buildingTruth(t: T, ownerId: string) {
  return t.run(async (ctx) => {
    const containers = (await ctx.db.query("collectionContainers").collect()).filter(
      (c) => c.ownerId === ownerId,
    );
    const kindOf = new Map(containers.map((c) => [c._id as string, c.kind]));
    const rows = (await ctx.db.query("collectionCopies").collect()).filter(
      (c) =>
        c.ownerId === ownerId &&
        (c.homeId === undefined || (kindOf.has(c.homeId as string) && kindOf.get(c.homeId as string) !== "box")),
    );
    const builds = (await ctx.db.query("collectionBuildingSets").collect()).filter(
      (b) => b.ownerId === ownerId,
    );
    return builds.map((b) => ({
      setId: b.setId,
      kept: b.cards ?? null,
      scope: b.tallyScope ?? null,
      truth: new Set(rows.filter((r) => r.setId === b.setId).map((r) => r.cardId as string)).size,
    }));
  });
}
