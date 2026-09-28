/**
 * NEO-308 — `chunkGroupingPlan` slices a single operator save (a
 * `GroupingPlan`) into pieces `applyParallelGroupings` will each accept on
 * its own, because that mutation refuses anything past
 * `MAX_PARALLEL_GROUPING_ENTRIES` in one call (NEO-296's transaction bound —
 * see `selectorOptions.ts`).
 *
 * What has to hold for the modal's multi-call loop
 * (`ParallelGroupingModal.handleConfirm`) to be safe:
 *
 *  - every entry the operator staged lands in EXACTLY one chunk, and no
 *    chunk exceeds the limit;
 *  - a row named more than once in one class (promoted/demoted/reparented
 *    twice) collapses to its LAST occurrence, matching the mutation's own
 *    "last one wins" de-dupe (see `promotionTargets` etc. in
 *    `applyParallelGroupings`) — so the plan sent to the server never
 *    contains a row twice within one class;
 *  - within the flattened order, demotions land before reparentings before
 *    promotions (D→R→P) — a demotion may make a row the valid TARGET of a
 *    promotion or reparenting later in the SAME save, so a chunk boundary
 *    must never separate a demotion from a promotion/reparenting that
 *    depends on it landing first;
 *  - stable order within a class, so two runs over the same plan produce
 *    byte-identical chunks (no `Set`/`Map` iteration-order surprises, no
 *    reliance on a sort the caller didn't ask for).
 */

import { describe, expect, test } from "vitest";
import {
  chunkGroupingPlan,
  MAX_PARALLEL_GROUPING_ENTRIES,
  type GroupingPlan,
} from "./parallelGroupingPlan";
import type { Id } from "./_generated/dataModel";

function id(n: number | string): Id<"selectorOptions"> {
  return `row_${n}` as unknown as Id<"selectorOptions">;
}

function promotion(n: number) {
  return { insertId: id(`p${n}`), targetInsertId: id("target") };
}
function demotion(n: number) {
  return { parallelId: id(`d${n}`) };
}
function reparenting(n: number) {
  return { parallelId: id(`r${n}`), newInsertId: id("target") };
}

const EMPTY: GroupingPlan = { promotions: [], demotions: [], reparentings: [] };

/** Total entries across all three lists of a plan (or a chunk). */
function count(plan: GroupingPlan): number {
  return plan.promotions.length + plan.demotions.length + plan.reparentings.length;
}

describe("chunkGroupingPlan — the empty and exactly-at-the-limit plans", () => {
  test("an empty plan chunks to nothing", () => {
    expect(chunkGroupingPlan(EMPTY)).toEqual([]);
  });

  test("an empty plan chunks to nothing at any explicit limit too", () => {
    expect(chunkGroupingPlan(EMPTY, 1)).toEqual([]);
    expect(chunkGroupingPlan(EMPTY, MAX_PARALLEL_GROUPING_ENTRIES)).toEqual([]);
  });

  test("MAX_PARALLEL_GROUPING_ENTRIES is 200", () => {
    expect(MAX_PARALLEL_GROUPING_ENTRIES).toBe(200);
  });

  test("exactly the limit's worth of entries is one chunk", () => {
    const plan: GroupingPlan = {
      promotions: Array.from({ length: 200 }, (_, i) => promotion(i)),
      demotions: [],
      reparentings: [],
    };
    const chunks = chunkGroupingPlan(plan);
    expect(chunks).toHaveLength(1);
    expect(count(chunks[0])).toBe(200);
    expect(chunks[0].promotions).toHaveLength(200);
    expect(chunks[0].demotions).toEqual([]);
    expect(chunks[0].reparentings).toEqual([]);
  });

  test("one entry past the limit spills a second chunk of exactly one", () => {
    const plan: GroupingPlan = {
      promotions: Array.from({ length: 201 }, (_, i) => promotion(i)),
      demotions: [],
      reparentings: [],
    };
    const chunks = chunkGroupingPlan(plan);
    expect(chunks).toHaveLength(2);
    expect(count(chunks[0])).toBe(200);
    expect(count(chunks[1])).toBe(1);
  });
});

describe("chunkGroupingPlan — a large mixed plan", () => {
  /** 500 entries: 150 demotions, 120 reparentings, 230 promotions. */
  function mixedPlan(): GroupingPlan {
    return {
      promotions: Array.from({ length: 230 }, (_, i) => promotion(i)),
      demotions: Array.from({ length: 150 }, (_, i) => demotion(i)),
      reparentings: Array.from({ length: 120 }, (_, i) => reparenting(i)),
    };
  }

  test("chunks to 3, every entry exactly once, none over the limit", () => {
    const plan = mixedPlan();
    const chunks = chunkGroupingPlan(plan);
    expect(chunks).toHaveLength(3);
    for (const chunk of chunks) {
      expect(count(chunk)).toBeGreaterThan(0);
      expect(count(chunk)).toBeLessThanOrEqual(MAX_PARALLEL_GROUPING_ENTRIES);
    }
    expect(chunks.reduce((sum, c) => sum + count(c), 0)).toBe(500);

    // Every demotion/reparenting/promotion id from the source plan shows up
    // in exactly one chunk, in the matching list.
    const seenDemotions = chunks.flatMap((c) => c.demotions.map((d) => d.parallelId));
    const seenReparentings = chunks.flatMap((c) =>
      c.reparentings.map((r) => r.parallelId),
    );
    const seenPromotions = chunks.flatMap((c) => c.promotions.map((p) => p.insertId));
    expect(new Set(seenDemotions).size).toBe(150);
    expect(seenDemotions).toHaveLength(150);
    expect(new Set(seenReparentings).size).toBe(120);
    expect(seenReparentings).toHaveLength(120);
    expect(new Set(seenPromotions).size).toBe(230);
    expect(seenPromotions).toHaveLength(230);
  });

  test("flattens demotions, then reparentings, then promotions, stable within each class", () => {
    const plan = mixedPlan();
    const chunks = chunkGroupingPlan(plan);
    const flatKind: string[] = [];
    for (const chunk of chunks) {
      flatKind.push(
        ...chunk.demotions.map(() => "D"),
        ...chunk.reparentings.map(() => "R"),
        ...chunk.promotions.map(() => "P"),
      );
    }
    // The whole run, across every chunk, is every D then every R then every P.
    expect(flatKind.join("")).toBe(
      "D".repeat(150) + "R".repeat(120) + "P".repeat(230),
    );

    // Stable within class: demotion N still precedes demotion N+1.
    const demotionOrder = chunks.flatMap((c) => c.demotions.map((d) => d.parallelId));
    expect(demotionOrder).toEqual(plan.demotions.map((d) => d.parallelId));
    const reparentOrder = chunks.flatMap((c) =>
      c.reparentings.map((r) => r.parallelId),
    );
    expect(reparentOrder).toEqual(plan.reparentings.map((r) => r.parallelId));
    const promotionOrder = chunks.flatMap((c) => c.promotions.map((p) => p.insertId));
    expect(promotionOrder).toEqual(plan.promotions.map((p) => p.insertId));
  });

  test("a chunk boundary never separates a demotion from every reparenting/promotion", () => {
    // With 150 D + 120 R + 230 P at limit 200: chunk 1 = 150D + 50R,
    // chunk 2 = 70R + 130P, chunk 3 = 100P. Demotions are entirely done
    // before any reparenting/promotion is even sent, so no ordering hazard
    // exists across chunks for this shape — assert the boundary lines up
    // exactly there, which is the property the property-based test above
    // only shows in aggregate.
    const plan = mixedPlan();
    const chunks = chunkGroupingPlan(plan);
    expect(chunks[0].demotions).toHaveLength(150);
    expect(chunks[0].reparentings).toHaveLength(50);
    expect(chunks[0].promotions).toHaveLength(0);
    expect(chunks[1].demotions).toHaveLength(0);
    expect(chunks[1].reparentings).toHaveLength(70);
    expect(chunks[1].promotions).toHaveLength(130);
    expect(chunks[2].demotions).toHaveLength(0);
    expect(chunks[2].reparentings).toHaveLength(0);
    expect(chunks[2].promotions).toHaveLength(100);
  });

  test("respects an explicit limit smaller than the default", () => {
    const plan: GroupingPlan = {
      promotions: [promotion(1), promotion(2), promotion(3)],
      demotions: [demotion(1)],
      reparentings: [],
    };
    const chunks = chunkGroupingPlan(plan, 2);
    // Flattened D->P order: D1, P1, P2, P3 -> chunks of 2: [D1,P1], [P2,P3]
    expect(chunks).toHaveLength(2);
    expect(count(chunks[0])).toBe(2);
    expect(count(chunks[1])).toBe(2);
    expect(chunks[0].demotions).toEqual([demotion(1)]);
    expect(chunks[0].promotions).toEqual([promotion(1)]);
    expect(chunks[1].promotions).toEqual([promotion(2), promotion(3)]);
  });

  test("is deterministic: two calls on the same plan produce identical chunks", () => {
    const plan = mixedPlan();
    expect(chunkGroupingPlan(plan)).toEqual(chunkGroupingPlan(plan));
  });
});

describe("chunkGroupingPlan — duplicate rows within a class collapse, last wins", () => {
  test("the same promotion insertId twice keeps only the LAST target", () => {
    const plan: GroupingPlan = {
      promotions: [
        { insertId: id("dup"), targetInsertId: id("first-target") },
        promotion(1),
        { insertId: id("dup"), targetInsertId: id("second-target") },
      ],
      demotions: [],
      reparentings: [],
    };
    const chunks = chunkGroupingPlan(plan);
    expect(chunks).toHaveLength(1);
    const dupEntries = chunks[0].promotions.filter((p) => p.insertId === id("dup"));
    expect(dupEntries).toHaveLength(1);
    expect(dupEntries[0].targetInsertId).toBe(id("second-target"));
  });

  test("the same demotion parallelId twice collapses to one entry", () => {
    const plan: GroupingPlan = {
      promotions: [],
      demotions: [demotion(1), demotion(2), demotion(1)],
      reparentings: [],
    };
    const chunks = chunkGroupingPlan(plan);
    expect(chunks).toHaveLength(1);
    // Only two DISTINCT rows, however many times "d1" was named.
    expect(chunks[0].demotions).toHaveLength(2);
    const ids = chunks[0].demotions.map((d) => d.parallelId).sort();
    expect(ids).toEqual([demotion(1).parallelId, demotion(2).parallelId].sort());
  });

  test("the same reparenting parallelId twice keeps only the LAST newInsertId", () => {
    const plan: GroupingPlan = {
      promotions: [],
      demotions: [],
      reparentings: [
        { parallelId: id("dup"), newInsertId: id("first-target") },
        { parallelId: id("dup"), newInsertId: id("second-target") },
      ],
    };
    const chunks = chunkGroupingPlan(plan);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].reparentings).toEqual([
      { parallelId: id("dup"), newInsertId: id("second-target") },
    ]);
  });

  test("de-dupe happens before slicing, so a plan with many duplicates of one row never spills a spurious chunk", () => {
    const plan: GroupingPlan = {
      promotions: Array.from({ length: 300 }, () => promotion(1)),
      demotions: [],
      reparentings: [],
    };
    const chunks = chunkGroupingPlan(plan);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].promotions).toEqual([promotion(1)]);
  });
});
