/**
 * NEO-296 — `storeReconciledOptions` is bounded by what it WRITES, and a call
 * that runs out of budget stops, says so, and is finished by calling again.
 *
 * The defect: `MAX_SYNC_ITEMS` (2,000) was sized for the matcher's CPU cost
 * with no reference to what an item costs in Convex system operations. At the
 * cap a single transaction reached ~3,050 operations, and ~4,060 with a stale
 * sibling list behind it — past the ~4,000 line where Convex kills a mutation
 * with "too many system operations". See `RECONCILE_STORE_WRITE_BUDGET` for
 * the per-item arithmetic.
 *
 * The property these tests pin is not "it stops" — anything can stop. It is
 * that stopping costs the operator nothing:
 *
 *  1. a batch inside the budget behaves exactly as it always did;
 *  2. a batch past it stores a prefix, commits it, and reports the rest;
 *  3. **a replay of the identical list finishes the job** — the stored prefix
 *     re-matches by marketplace id, changes nothing, and therefore spends no
 *     budget, so the second call walks into the tail rather than re-paying for
 *     the head. That is the whole reason the budget counts writes and not
 *     items, and it is what makes an interrupted run resumable without the
 *     caller tracking a cursor;
 *  4. nothing is applied twice: the row count after two calls is the list
 *     length, not the list length plus the prefix.
 *
 * Deliberately a file of its own rather than more cases in
 * `selectorSyncAdditive.test.ts`: that file is the shared NEO-211 family for
 * BOTH stores, and this bound belongs to this one.
 */

import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { RECONCILE_STORE_WRITE_BUDGET } from "./setReconciliation";

const modules = (
  import.meta as unknown as {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("./**/*.*s");

const ADMIN_IDENTITY = {
  subject: "admin_neo296_budget",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_neo296_budget",
  role: "admin",
};

const SENTINEL = 1_000_000;

beforeEach(() => {
  // The truncation notice is a `console.warn` on purpose; asserted below by
  // the returned shape, silenced here.
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

function admin(t: ReturnType<typeof convexTest>) {
  return t.withIdentity(ADMIN_IDENTITY);
}

async function insertParent(
  t: ReturnType<typeof convexTest>,
): Promise<Id<"selectorOptions">> {
  return t.run(async (ctx) =>
    ctx.db.insert("selectorOptions", {
      level: "manufacturer",
      value: "Topps Inc",
      platformData: {},
      children: [],
      lastUpdated: SENTINEL,
    }),
  );
}

async function setRowsUnder(
  t: ReturnType<typeof convexTest>,
  parentId: Id<"selectorOptions">,
) {
  return t.run(async (ctx) =>
    ctx.db
      .query("selectorOptions")
      .withIndex("by_level_and_parent", (q) =>
        q.eq("level", "setName").eq("parentId", parentId),
      )
      .collect(),
  );
}

/**
 * A batch of distinct, id-carrying setName rows. Each item carries its own BSC
 * id, so a replay matches it at the id tier rather than by name — the same
 * path a real re-sync takes.
 */
function batch(size: number) {
  return Array.from({ length: size }, (_, i) => ({
    value: `Set ${i}`,
    platformData: { bsc: `bsc-${i}` },
    metadata: undefined,
  }));
}

describe("storeReconciledOptions is bounded by its writes (NEO-296)", () => {
  test("a batch inside the budget is stored whole, reports no truncation, and counts its writes", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = admin(t);
    const parentId = await insertParent(t);

    const res = await asAdmin.mutation(
      api.setReconciliation.storeReconciledOptions,
      { level: "setName", parentId, reconciledItems: batch(10) },
    );

    expect(res.success).toBe(true);
    expect(res.hasMore).toBe(false);
    expect(res.itemsProcessed).toBe(10);
    expect(res.optionsCount).toBe(10);
    // Ten inserts plus the parent's one `children` union patch.
    expect(res.writeOps).toBe(11);
    expect(res.message).toContain("Successfully stored");
    expect(await setRowsUnder(t, parentId)).toHaveLength(10);
  });

  test("re-sending an unchanged list costs NO writes — the property the replay depends on", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = admin(t);
    const parentId = await insertParent(t);
    const items = batch(5);

    await asAdmin.mutation(api.setReconciliation.storeReconciledOptions, {
      level: "setName",
      parentId,
      reconciledItems: items,
    });
    const again = await asAdmin.mutation(
      api.setReconciliation.storeReconciledOptions,
      { level: "setName", parentId, reconciledItems: items },
    );

    // Every item matched its row at the id tier and changed nothing, so
    // NEO-85's write-if-changed guard patched nothing and the budget was not
    // touched. Without this, a truncated call could never be finished by
    // replaying the same list.
    expect(again.writeOps).toBe(0);
    expect(again.itemsProcessed).toBe(5);
    expect(again.hasMore).toBe(false);
    expect(await setRowsUnder(t, parentId)).toHaveLength(5);
  });

  test("a batch past the budget stores a prefix, commits it, and reports the rest", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = admin(t);
    const parentId = await insertParent(t);
    const size = RECONCILE_STORE_WRITE_BUDGET + 25;

    const res = await asAdmin.mutation(
      api.setReconciliation.storeReconciledOptions,
      { level: "setName", parentId, reconciledItems: batch(size) },
    );

    // The bound is checked between items, so the call admits exactly as many
    // items as it has writes for and stops on the next one.
    expect(res.hasMore).toBe(true);
    expect(res.itemsProcessed).toBe(RECONCILE_STORE_WRITE_BUDGET);
    expect(res.optionsCount).toBe(RECONCILE_STORE_WRITE_BUDGET);
    // The budget's inserts, plus the parent `children` patch.
    expect(res.writeOps).toBe(RECONCILE_STORE_WRITE_BUDGET + 1);
    // Reported, never silent: the operator's own sentence names the shortfall.
    expect(res.message).toContain(`${size - RECONCILE_STORE_WRITE_BUDGET}`);
    expect(res.message).toContain("Run the sync again");
    // And what it did store is committed, not rolled back with the tail.
    expect(await setRowsUnder(t, parentId)).toHaveLength(
      RECONCILE_STORE_WRITE_BUDGET,
    );
  });

  test("a replay of the SAME list finishes the job, applying nothing twice", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = admin(t);
    const parentId = await insertParent(t);
    const size = RECONCILE_STORE_WRITE_BUDGET + 25;
    const items = batch(size);

    const first = await asAdmin.mutation(
      api.setReconciliation.storeReconciledOptions,
      { level: "setName", parentId, reconciledItems: items },
    );
    expect(first.hasMore).toBe(true);

    // The caller needs no cursor: the same list, again.
    const second = await asAdmin.mutation(
      api.setReconciliation.storeReconciledOptions,
      { level: "setName", parentId, reconciledItems: items },
    );

    expect(second.hasMore).toBe(false);
    expect(second.itemsProcessed).toBe(size);
    // Only the 25 rows the first call never reached were inserted, plus the
    // one parent patch — the prefix cost nothing.
    expect(second.writeOps).toBe(26);

    const rows = await setRowsUnder(t, parentId);
    expect(rows).toHaveLength(size);
    // No row is duplicated: the prefix was re-MATCHED, not re-inserted.
    expect(new Set(rows.map((r) => r.value)).size).toBe(size);
  });

  test("an interrupted run also resumes from the tail alone", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = admin(t);
    const parentId = await insertParent(t);
    const size = RECONCILE_STORE_WRITE_BUDGET + 25;
    const items = batch(size);

    const first = await asAdmin.mutation(
      api.setReconciliation.storeReconciledOptions,
      { level: "setName", parentId, reconciledItems: items },
    );
    // A caller that DOES track the cursor sends only what was not reached.
    const second = await asAdmin.mutation(
      api.setReconciliation.storeReconciledOptions,
      {
        level: "setName",
        parentId,
        reconciledItems: items.slice(first.itemsProcessed),
      },
    );

    expect(second.hasMore).toBe(false);
    expect(second.itemsProcessed).toBe(25);
    const rows = await setRowsUnder(t, parentId);
    expect(rows).toHaveLength(size);
    expect(new Set(rows.map((r) => r.value)).size).toBe(size);
  });
});

describe("NEO-300 — the variant-type subtree walk is paid for out of the same budget", () => {
  async function variantTypeWithInserts(
    t: ReturnType<typeof convexTest>,
    existing: number,
  ): Promise<Id<"selectorOptions">> {
    return t.run(async (ctx) => {
      const vt = await ctx.db.insert("selectorOptions", {
        level: "variantType",
        value: "Inserts",
        platformData: { bsc: { b0: "insert" } },
        platformFacets: { bsc: { b0: "variant" } },
        children: [],
        lastUpdated: SENTINEL,
      });
      for (let i = 0; i < existing; i++) {
        await ctx.db.insert("selectorOptions", {
          level: "insert",
          value: `Existing ${i}`,
          platformData: { bsc: { b0: `existing-${i}` } },
          parentId: vt,
          children: [],
          lastUpdated: SENTINEL,
        });
      }
      return vt;
    });
  }

  function insertBatch(size: number) {
    return Array.from({ length: size }, (_, i) => ({
      value: `Insert ${i}`,
      platformData: { bsc: `ins-${i}` },
      metadata: undefined,
    }));
  }

  test("one read per existing insert comes off the write budget, and a replay still finishes", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = admin(t);
    const existing = 5;
    const vt = await variantTypeWithInserts(t, existing);
    const items = insertBatch(RECONCILE_STORE_WRITE_BUDGET);

    const first = await asAdmin.mutation(
      api.setReconciliation.storeReconciledOptions,
      { level: "insert", parentId: vt, reconciledItems: items },
    );
    // New ids no sibling holds → the walk ran: one parallels read per insert.
    expect(first.hasMore).toBe(true);
    expect(first.itemsProcessed).toBe(RECONCILE_STORE_WRITE_BUDGET - existing);
    // The admitted inserts, plus the parent `children` patch.
    expect(first.writeOps).toBe(RECONCILE_STORE_WRITE_BUDGET - existing + 1);

    const second = await asAdmin.mutation(
      api.setReconciliation.storeReconciledOptions,
      { level: "insert", parentId: vt, reconciledItems: items },
    );
    expect(second.hasMore).toBe(false);
    expect(second.itemsProcessed).toBe(RECONCILE_STORE_WRITE_BUDGET);
    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("selectorOptions")
        .withIndex("by_level_and_parent", (q) =>
          q.eq("level", "insert").eq("parentId", vt),
        )
        .collect(),
    );
    expect(rows).toHaveLength(existing + RECONCILE_STORE_WRITE_BUDGET);
  });
});
