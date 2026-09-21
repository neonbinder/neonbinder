/**
 * NEO-237 (D12) — `reconcileSetCandidates`: the SOLE writer of the
 * `setCandidates` table, one call per brand scope after a SUCCESSFUL fetch of
 * that brand's SportLots list.
 *
 * Companion to `selectorBrandRouting.test.ts` (the pure `routeSlSets`
 * classifier that produces the roots this mutation is handed) — this file
 * drives the DB-writing half: upsert semantics (status kept, write-if-changed
 * on label/members), unseen rows deleted, and the bounds re-asserted at the
 * write door.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import {
  MAX_SET_CANDIDATE_MEMBERS,
  MAX_SET_CANDIDATE_ROOTS,
} from "./selectorSyncMatch";

const modules = (
  import.meta as unknown as {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("./**/*.*s");

const SENTINEL = 1_000_000;

async function seedManufacturer(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) =>
    ctx.db.insert("selectorOptions", {
      level: "manufacturer",
      value: "Bandai",
      platformData: {},
      children: [],
      lastUpdated: SENTINEL,
    }),
  );
}

async function candidatesFor(
  t: ReturnType<typeof convexTest>,
  manufacturerId: Id<"selectorOptions">,
) {
  return t.run(async (ctx) =>
    ctx.db
      .query("setCandidates")
      .withIndex("by_manufacturer_and_status", (q) =>
        q.eq("manufacturerId", manufacturerId),
      )
      .collect(),
  );
}

describe("reconcileSetCandidates — upsert", () => {
  test("inserts a new root as pending", async () => {
    const t = convexTest(schema, modules);
    const manufacturerId = await seedManufacturer(t);

    const result = await t.mutation(
      internal.selectorOptions.reconcileSetCandidates,
      {
        manufacturerId,
        side: "sportlots",
        roots: [{ id: "sl-1", label: "Chrome", members: [] }],
      },
    );
    expect(result).toEqual({ inserted: 1, updated: 0, deleted: 0, unchanged: 0 });

    const rows = await candidatesFor(t, manufacturerId);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("pending");
    expect(rows[0].label).toBe("Chrome");
  });

  test("a Skip survives a re-sync: status is KEPT on an unchanged upsert", async () => {
    const t = convexTest(schema, modules);
    const manufacturerId = await seedManufacturer(t);
    await t.mutation(internal.selectorOptions.reconcileSetCandidates, {
      manufacturerId,
      side: "sportlots",
      roots: [{ id: "sl-1", label: "Chrome", members: [] }],
    });
    const [row] = await candidatesFor(t, manufacturerId);
    await t.run((ctx) =>
      ctx.db.patch(row._id, {
        status: "skipped",
        skippedAt: SENTINEL,
      }),
    );

    // Same label/members reappear on the next fetch.
    const result = await t.mutation(
      internal.selectorOptions.reconcileSetCandidates,
      {
        manufacturerId,
        side: "sportlots",
        roots: [{ id: "sl-1", label: "Chrome", members: [] }],
      },
    );
    expect(result).toEqual({ inserted: 0, updated: 0, deleted: 0, unchanged: 1 });

    const [after] = await candidatesFor(t, manufacturerId);
    expect(after.status).toBe("skipped");
  });

  test("a Skip survives a re-sync even when the label/members changed (write-if-changed keeps status)", async () => {
    const t = convexTest(schema, modules);
    const manufacturerId = await seedManufacturer(t);
    await t.mutation(internal.selectorOptions.reconcileSetCandidates, {
      manufacturerId,
      side: "sportlots",
      roots: [{ id: "sl-1", label: "Chrome", members: [] }],
    });
    const [row] = await candidatesFor(t, manufacturerId);
    await t.run((ctx) => ctx.db.patch(row._id, { status: "skipped" }));

    const result = await t.mutation(
      internal.selectorOptions.reconcileSetCandidates,
      {
        manufacturerId,
        side: "sportlots",
        roots: [
          {
            id: "sl-1",
            label: "Chrome",
            members: [{ id: "sl-1a", label: "Chrome Refractor" }],
          },
        ],
      },
    );
    expect(result).toEqual({ inserted: 0, updated: 1, deleted: 0, unchanged: 0 });

    const [after] = await candidatesFor(t, manufacturerId);
    expect(after.status).toBe("skipped");
    expect(after.members).toEqual([{ id: "sl-1a", label: "Chrome Refractor" }]);
  });

  test("write-if-changed: identical label AND members is unchanged, not a rewrite", async () => {
    const t = convexTest(schema, modules);
    const manufacturerId = await seedManufacturer(t);
    const root = {
      id: "sl-1",
      label: "Chrome",
      members: [{ id: "sl-1a", label: "Chrome Refractor" }],
    };
    await t.mutation(internal.selectorOptions.reconcileSetCandidates, {
      manufacturerId,
      side: "sportlots",
      roots: [root],
    });

    const result = await t.mutation(
      internal.selectorOptions.reconcileSetCandidates,
      { manufacturerId, side: "sportlots", roots: [root] },
    );
    expect(result).toEqual({ inserted: 0, updated: 0, deleted: 0, unchanged: 1 });
  });

  test("changed label alone is an update", async () => {
    const t = convexTest(schema, modules);
    const manufacturerId = await seedManufacturer(t);
    await t.mutation(internal.selectorOptions.reconcileSetCandidates, {
      manufacturerId,
      side: "sportlots",
      roots: [{ id: "sl-1", label: "Chrome", members: [] }],
    });

    const result = await t.mutation(
      internal.selectorOptions.reconcileSetCandidates,
      {
        manufacturerId,
        side: "sportlots",
        roots: [{ id: "sl-1", label: "Chrome Refractors", members: [] }],
      },
    );
    expect(result).toEqual({ inserted: 0, updated: 1, deleted: 0, unchanged: 0 });
  });

  test("a root unseen on this reconcile is deleted", async () => {
    const t = convexTest(schema, modules);
    const manufacturerId = await seedManufacturer(t);
    await t.mutation(internal.selectorOptions.reconcileSetCandidates, {
      manufacturerId,
      side: "sportlots",
      roots: [
        { id: "sl-1", label: "Chrome", members: [] },
        { id: "sl-2", label: "Finest", members: [] },
      ],
    });

    const result = await t.mutation(
      internal.selectorOptions.reconcileSetCandidates,
      {
        manufacturerId,
        side: "sportlots",
        roots: [{ id: "sl-1", label: "Chrome", members: [] }],
      },
    );
    expect(result).toEqual({ inserted: 0, updated: 0, deleted: 1, unchanged: 1 });

    const rows = await candidatesFor(t, manufacturerId);
    expect(rows.map((r) => r.marketplaceId)).toEqual(["sl-1"]);
  });

  test("a skipped root that upstream stops listing is deleted too — the Skip does not pin it forever", async () => {
    const t = convexTest(schema, modules);
    const manufacturerId = await seedManufacturer(t);
    await t.mutation(internal.selectorOptions.reconcileSetCandidates, {
      manufacturerId,
      side: "sportlots",
      roots: [{ id: "sl-1", label: "Chrome", members: [] }],
    });
    const [row] = await candidatesFor(t, manufacturerId);
    await t.run((ctx) => ctx.db.patch(row._id, { status: "skipped" }));

    const result = await t.mutation(
      internal.selectorOptions.reconcileSetCandidates,
      { manufacturerId, side: "sportlots", roots: [] },
    );
    expect(result).toEqual({ inserted: 0, updated: 0, deleted: 1, unchanged: 0 });
    expect(await candidatesFor(t, manufacturerId)).toHaveLength(0);
  });

  test("only rows of the SAME side are reconciled — another side's rows are untouched", async () => {
    const t = convexTest(schema, modules);
    const manufacturerId = await seedManufacturer(t);
    await t.run((ctx) =>
      ctx.db.insert("setCandidates", {
        manufacturerId,
        side: "bsc",
        marketplaceId: "bsc-1",
        label: "Some BSC root",
        members: [],
        status: "pending",
      }),
    );

    const result = await t.mutation(
      internal.selectorOptions.reconcileSetCandidates,
      { manufacturerId, side: "sportlots", roots: [] },
    );
    expect(result).toEqual({ inserted: 0, updated: 0, deleted: 0, unchanged: 0 });

    const rows = await candidatesFor(t, manufacturerId);
    expect(rows).toHaveLength(1);
    expect(rows[0].side).toBe("bsc");
  });

  test("duplicate root ids in one call are reconciled once, not twice", async () => {
    const t = convexTest(schema, modules);
    const manufacturerId = await seedManufacturer(t);

    const result = await t.mutation(
      internal.selectorOptions.reconcileSetCandidates,
      {
        manufacturerId,
        side: "sportlots",
        roots: [
          { id: "sl-1", label: "Chrome", members: [] },
          { id: "sl-1", label: "Chrome (dup)", members: [] },
        ],
      },
    );
    expect(result.inserted).toBe(1);
    const rows = await candidatesFor(t, manufacturerId);
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe("Chrome"); // first one wins
  });
});

describe("reconcileSetCandidates — bounds re-asserted at the write door", () => {
  test("refuses a manufacturerId that is not a manufacturer row", async () => {
    const t = convexTest(schema, modules);
    const yearId = await t.run((ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "year",
        value: "1997",
        platformData: {},
        children: [],
        lastUpdated: SENTINEL,
      }),
    );

    await expect(
      t.mutation(internal.selectorOptions.reconcileSetCandidates, {
        manufacturerId: yearId,
        side: "sportlots",
        roots: [],
      }),
    ).rejects.toThrow(/not a manufacturer row/i);
  });

  test("refuses more roots than MAX_SET_CANDIDATE_ROOTS", async () => {
    const t = convexTest(schema, modules);
    const manufacturerId = await seedManufacturer(t);
    const roots = Array.from({ length: MAX_SET_CANDIDATE_ROOTS + 1 }, (_, i) => ({
      id: `sl-${i}`,
      label: `Set ${i}`,
      members: [],
    }));

    await expect(
      t.mutation(internal.selectorOptions.reconcileSetCandidates, {
        manufacturerId,
        side: "sportlots",
        roots,
      }),
    ).rejects.toThrow(/exceeds/i);
  });

  test("refuses a root with more members than MAX_SET_CANDIDATE_MEMBERS", async () => {
    const t = convexTest(schema, modules);
    const manufacturerId = await seedManufacturer(t);
    const members = Array.from({ length: MAX_SET_CANDIDATE_MEMBERS + 1 }, (_, i) => ({
      id: `sl-1-${i}`,
      label: `Variant ${i}`,
    }));

    await expect(
      t.mutation(internal.selectorOptions.reconcileSetCandidates, {
        manufacturerId,
        side: "sportlots",
        roots: [{ id: "sl-1", label: "Chrome", members }],
      }),
    ).rejects.toThrow(/members/i);
  });

  test("refuses an over-length root label", async () => {
    const t = convexTest(schema, modules);
    const manufacturerId = await seedManufacturer(t);

    await expect(
      t.mutation(internal.selectorOptions.reconcileSetCandidates, {
        manufacturerId,
        side: "sportlots",
        roots: [{ id: "sl-1", label: "x".repeat(500), members: [] }],
      }),
    ).rejects.toThrow();
  });
});
