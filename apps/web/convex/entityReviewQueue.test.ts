/**
 * NEO-92: unit tests for `convex/entityReviewQueue.ts` — the CRUD backing
 * the step-through "new players & teams" review wizard that replaced the
 * old single-screen `UnknownEntitiesDialog` checkbox list.
 *
 * Covers the public/internal surface directly (raw `ctx.db.insert` fixtures
 * for entityReviewQueue rows, per the minimal-fixture convention in
 * convex/featurePropagation.test.ts's `seedSubtree` — no need to route
 * through the real `fetchCardChecklist` action just to get rows into the
 * table):
 *   - startBatch: one row per name, resumes (doesn't delete/recreate) an
 *     in-progress batch, schedules the Wikidata pool enqueue
 *     (NEO-99: wikidataPool.enqueueEntityReviewLookups, not the removed
 *     per-batch processEntityReviewQueue chain).
 *   - getBatch: scoped correctly by (selectorOptionId, batchId).
 *   - recordDecision: patches `decision` on exactly the targeted row,
 *     including NEO-212's "skip" action and `excludedCareerTeamNames`.
 *   - recordAllRemainingAsSkip: NEO-212's bulk counterpart to
 *     recordAllRemainingAsCreate.
 *   - cancelBatch: deletes all rows for a batch, touches nothing else.
 *   - cleanupBatch: deletes all rows for a batch (same shape as cancelBatch,
 *     but internal — this is what commitCardChecklist schedules post-commit).
 *
 * Every PUBLIC function here (getBatch/recordDecision/cancelBatch) is
 * admin-gated via `requireAdmin`, matching every other public function in
 * selectorOptions.ts — tests call these through `asAdmin` (an identity with
 * `role: "admin"`). startBatch/getInternal/applyLookupResult/cleanupBatch
 * are internal (no client-reachable auth check), called via bare `t.mutation`.
 *
 * The pool work item `runEntityReviewLookup` (a single row's lookup + patch)
 * and `lookupPlayerEnrichment`/`lookupTeamEnrichment`'s pure-lookup behavior are
 * covered separately in convex/wikidataEntityReviewQueue.test.ts (that file
 * needs real Wikidata-shaped SPARQL fetch fixtures; this one only needs to
 * prove startBatch's scheduling WIRING, not the lookup's own behavior). The
 * actual `wikidataPool.enqueueAction` call cannot run under convex-test — the
 * workpool component is not mounted — so startBatch tests assert the SCHEDULED
 * enqueue rather than draining it (the same constraint the placeholder pool's
 * tests work under).
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { Id } from "./_generated/dataModel";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN_IDENTITY = {
  subject: "user_review_001",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|user_review_001",
  role: "admin",
};

async function seedSelectorOption(
  t: ReturnType<typeof convexTest>,
): Promise<Id<"selectorOptions">> {
  return t.run(async (ctx) =>
    ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Baseball",
      sportConfig: {
        skuCode: "BB",
        league: "MLB",
        espn: { path: "baseball/mlb", leagueName: "Major League Baseball" },
        wikidata: { sportQid: "Q5369", hallOfFameQid: "Q1194380" },
      },
      platformData: {},
      children: [],
      lastUpdated: Date.now(),
    }),
  );
}

async function insertRow(
  t: ReturnType<typeof convexTest>,
  opts: {
    selectorOptionId: Id<"selectorOptions">;
    batchId: string;
    kind: "player" | "team";
    name: string;
    sportId: Id<"selectorOptions">;
    status?: "pending" | "ready" | "error";
    /** NEO-236: the bulk fast path reads `enrichment.location` to pre-fill. */
    enrichment?: Record<string, unknown>;
  },
) {
  return t.run(async (ctx) =>
    ctx.db.insert("entityReviewQueue", {
      selectorOptionId: opts.selectorOptionId,
      batchId: opts.batchId,
      createdByUserId: "user_review_001",
      kind: opts.kind,
      name: opts.name,
      sportId: opts.sportId,
      status: opts.status ?? "pending",
      ...(opts.enrichment ? { enrichment: opts.enrichment as never } : {}),
    }),
  );
}

/**
 * NEO-99: the "module:function" names of the currently-scheduled functions,
 * used to assert startBatch queued the Wikidata pool enqueue WITHOUT running it
 * (running it would reach `wikidataPool.enqueueAction`, which convex-test cannot
 * mount). Same technique as convex/placeholderWarmup.test.ts.
 */
const ENQUEUE_FN = "wikidataPool:enqueueEntityReviewLookups";
async function scheduledNames(
  t: ReturnType<typeof convexTest>,
): Promise<string[]> {
  return t.run(async (ctx) => {
    const rows = await (
      ctx as unknown as {
        db: {
          system: {
            query: (n: string) => { collect: () => Promise<Array<{ name: string }>> };
          };
        };
      }
    ).db.system.query("_scheduled_functions").collect();
    return rows.map((r) => r.name);
  });
}

// ===========================================================================
// startBatch
// ===========================================================================

describe("startBatch", () => {
  test("inserts one row per player/team name, all pending, sharing a fresh batchId", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const selectorOptionId = await seedSelectorOption(t);

    // NEO-99: startBatch inserts the rows as `pending` and SCHEDULES the pool
    // enqueue — it does not fetch or touch the pool itself, so there is nothing
    // to drain here (and finishing the scheduled enqueue would reach the
    // unmountable pool component). The rows are asserted while still "pending",
    // which is this test's point; the enqueue scheduling is asserted below.
    const batchId = await t.mutation(internal.entityReviewQueue.startBatch, {
      selectorOptionId,
      createdByUserId: "user_review_001",
      sportId: selectorOptionId,
      playerNames: ["Mike Trout", "Aaron Judge"],
      teamNames: ["Los Angeles Angels"],
    });

    expect(batchId).toBeTruthy();

    const rows = await asAdmin.query(api.entityReviewQueue.getBatch, {
      selectorOptionId,
      batchId,
    });
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.status).toBe("pending");
      expect(row.batchId).toBe(batchId);
      expect(row.decision).toBeUndefined();
    }
    const byName = new Map(rows.map((r) => [r.name, r]));
    expect(byName.get("Mike Trout")?.kind).toBe("player");
    expect(byName.get("Aaron Judge")?.kind).toBe("player");
    expect(byName.get("Los Angeles Angels")?.kind).toBe("team");

    // The rows are handed to the Wikidata pool via a scheduled enqueue, not the
    // old per-batch fetch chain.
    expect(await scheduledNames(t)).toContain(ENQUEUE_FN);
  });

  test("resumes an in-progress batch for the same selectorOptionId instead of deleting/recreating it", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const selectorOptionId = await seedSelectorOption(t);

    const firstBatchId = await t.mutation(internal.entityReviewQueue.startBatch, {
      selectorOptionId,
      createdByUserId: "user_review_001",
      sportId: selectorOptionId,
      playerNames: ["Mike Trout"],
      teamNames: [],
    });

    // Simulate the user having already reviewed the first row.
    const firstRows = await asAdmin.query(api.entityReviewQueue.getBatch, {
      selectorOptionId,
      batchId: firstBatchId,
    });
    await asAdmin.mutation(api.entityReviewQueue.recordDecision, {
      reviewRowId: firstRows[0]._id,
      action: "create",
    });

    // A second fetch surfaces a DIFFERENT set of unknown names (e.g. the
    // marketplace payload changed slightly) — startBatch must return the
    // SAME batchId and leave the already-decided row alone, not discard it.
    const secondBatchId = await t.mutation(internal.entityReviewQueue.startBatch, {
      selectorOptionId,
      createdByUserId: "user_review_001",
      sportId: selectorOptionId,
      playerNames: ["Someone Else Entirely"],
      teamNames: [],
    });

    expect(secondBatchId).toBe(firstBatchId);

    const rowsAfter = await asAdmin.query(api.entityReviewQueue.getBatch, {
      selectorOptionId,
      batchId: firstBatchId,
    });
    // Still just the original row — "Someone Else Entirely" was never
    // inserted, and the original row's decision survived untouched.
    expect(rowsAfter).toHaveLength(1);
    expect(rowsAfter[0].name).toBe("Mike Trout");
    expect(rowsAfter[0].decision).toEqual({ action: "create" });
  });

  test("scopes batches per user — two different users fetching the SAME selectorOptionId get separate, non-colliding batches", async () => {
    // Regression coverage for a real bug: concurrent CI workers (each a
    // distinct test user) fetching the same shared real marketplace set
    // used to resume/collide on ONE global batch keyed only by
    // selectorOptionId — causing a dropped Cancel tap (one user's commit
    // collapsed another's wizard footer mid-click) and a wrong-item-shown
    // wizard (one user's unknown name preempted another's in shared queue
    // order). Scoping by (selectorOptionId, createdByUserId) fixes both.
    const t = convexTest(schema, modules);
    const selectorOptionId = await seedSelectorOption(t);

    const batchIdForUserA = await t.mutation(internal.entityReviewQueue.startBatch, {
      selectorOptionId,
      createdByUserId: "user_a",
      sportId: selectorOptionId,
      playerNames: ["Mike Trout"],
      teamNames: [],
    });
    const batchIdForUserB = await t.mutation(internal.entityReviewQueue.startBatch, {
      selectorOptionId,
      createdByUserId: "user_b",
      sportId: selectorOptionId,
      playerNames: ["Aaron Judge"],
      teamNames: [],
    });

    expect(batchIdForUserB).not.toBe(batchIdForUserA);

    const rowsForUserA = await t.run(async (ctx) =>
      ctx.db
        .query("entityReviewQueue")
        .withIndex("by_selector_option_and_batch", (q) =>
          q.eq("selectorOptionId", selectorOptionId).eq("batchId", batchIdForUserA),
        )
        .collect(),
    );
    const rowsForUserB = await t.run(async (ctx) =>
      ctx.db
        .query("entityReviewQueue")
        .withIndex("by_selector_option_and_batch", (q) =>
          q.eq("selectorOptionId", selectorOptionId).eq("batchId", batchIdForUserB),
        )
        .collect(),
    );
    expect(rowsForUserA.map((r) => r.name)).toEqual(["Mike Trout"]);
    expect(rowsForUserB.map((r) => r.name)).toEqual(["Aaron Judge"]);

    // Each user resuming their own fetch gets their OWN batch back, not the
    // other user's.
    const resumedForUserA = await t.mutation(internal.entityReviewQueue.startBatch, {
      selectorOptionId,
      createdByUserId: "user_a",
      sportId: selectorOptionId,
      playerNames: ["Someone New"],
      teamNames: [],
    });
    expect(resumedForUserA).toBe(batchIdForUserA);
  });

  test("getBatch never exposes createdByUserId to the client", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const selectorOptionId = await seedSelectorOption(t);

    // NEO-99: startBatch no longer fetches inline (the pool work item does), so
    // there is nothing to stub or drain — asserting the projected row is enough.
    const batchId = await t.mutation(internal.entityReviewQueue.startBatch, {
      selectorOptionId,
      createdByUserId: "user_review_001",
      sportId: selectorOptionId,
      playerNames: ["Mike Trout"],
      teamNames: [],
    });

    const rows = await asAdmin.query(api.entityReviewQueue.getBatch, {
      selectorOptionId,
      batchId,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).not.toHaveProperty("createdByUserId");
  });

  test("schedules the Wikidata pool enqueue for a non-empty name list", async () => {
    // NEO-99: startBatch hands the pending rows to the deployment-wide pool via
    // a scheduled `enqueueEntityReviewLookups` (which then drains them 5-wide),
    // rather than the old per-batch serial chain. The actual enqueue reaches the
    // workpool component and so cannot run under convex-test — the rows-leave-
    // pending behavior is proven directly on `runEntityReviewLookup` in
    // convex/wikidataEntityReviewQueue.test.ts. Here we assert the WIRING: the
    // enqueue is scheduled exactly once for a non-empty batch.
    const t = convexTest(schema, modules);
    const selectorOptionId = await seedSelectorOption(t);

    await t.mutation(internal.entityReviewQueue.startBatch, {
      selectorOptionId,
      createdByUserId: "user_review_001",
      sportId: selectorOptionId,
      playerNames: ["Mike Trout"],
      teamNames: [],
    });

    const scheduled = await scheduledNames(t);
    expect(scheduled.filter((n) => n === ENQUEUE_FN)).toHaveLength(1);
  });

  test("an empty name list produces no rows and returns a batchId without scheduling anything", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const selectorOptionId = await seedSelectorOption(t);

    const batchId = await t.mutation(internal.entityReviewQueue.startBatch, {
      selectorOptionId,
      createdByUserId: "user_review_001",
      sportId: selectorOptionId,
      playerNames: [],
      teamNames: [],
    });

    const rows = await asAdmin.query(api.entityReviewQueue.getBatch, {
      selectorOptionId,
      batchId,
    });
    expect(rows).toHaveLength(0);
    // NEO-99: nothing to look up, so the pool enqueue is never scheduled.
    expect(await scheduledNames(t)).not.toContain(ENQUEUE_FN);
  });
});

// ===========================================================================
// getBatch
// ===========================================================================

describe("getBatch", () => {
  test("returns only rows scoped to the given (selectorOptionId, batchId) pair", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const selectorOptionA = await seedSelectorOption(t);
    const selectorOptionB = await seedSelectorOption(t);

    await insertRow(t, {
      selectorOptionId: selectorOptionA,
      sportId: selectorOptionA,
      batchId: "batch-a",
      kind: "player",
      name: "Row A1",
    });
    // Same selectorOption, DIFFERENT batch — must not leak into batch-a's results.
    await insertRow(t, {
      selectorOptionId: selectorOptionA,
      sportId: selectorOptionA,
      batchId: "batch-a2",
      kind: "player",
      name: "Row A2 (other batch)",
    });
    // Different selectorOption, SAME batchId string — must not leak either.
    await insertRow(t, {
      selectorOptionId: selectorOptionB,
      sportId: selectorOptionB,
      batchId: "batch-a",
      kind: "player",
      name: "Row B (other selectorOption)",
    });

    const rows = await asAdmin.query(api.entityReviewQueue.getBatch, {
      selectorOptionId: selectorOptionA,
      batchId: "batch-a",
    });

    expect(rows.map((r) => r.name)).toEqual(["Row A1"]);
  });

  test("returns an empty array for a batchId that doesn't exist", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const selectorOptionId = await seedSelectorOption(t);

    const rows = await asAdmin.query(api.entityReviewQueue.getBatch, {
      selectorOptionId,
      batchId: "nonexistent-batch",
    });
    expect(rows).toEqual([]);
  });

  test("throws for an unauthenticated caller", async () => {
    const t = convexTest(schema, modules);
    const selectorOptionId = await seedSelectorOption(t);

    await expect(
      t.query(api.entityReviewQueue.getBatch, {
        selectorOptionId,
        batchId: "any-batch",
      }),
    ).rejects.toThrow();
  });
});

// ===========================================================================
// recordDecision
// ===========================================================================

describe("recordDecision", () => {
  test("patches `decision` on exactly the targeted row — sibling rows in the same batch are untouched", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const selectorOptionId = await seedSelectorOption(t);

    const rowId1 = await insertRow(t, {
      selectorOptionId,
      sportId: selectorOptionId,
      batchId: "b1",
      kind: "player",
      name: "Mike Trout",
    });
    const rowId2 = await insertRow(t, {
      selectorOptionId,
      sportId: selectorOptionId,
      batchId: "b1",
      kind: "player",
      name: "Aaron Judge",
    });

    await asAdmin.mutation(api.entityReviewQueue.recordDecision, {
      reviewRowId: rowId1,
      action: "create",
    });

    const row1 = await t.run(async (ctx) => ctx.db.get(rowId1));
    const row2 = await t.run(async (ctx) => ctx.db.get(rowId2));
    expect(row1!.decision).toEqual({ action: "create" });
    expect(row2!.decision).toBeUndefined();
  });

  test("a 'link' decision on a player row stores linkedPlayerId, validated against the row's sport", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const selectorOptionId = await seedSelectorOption(t);
    const existingPlayerId = await t.run(async (ctx) =>
      ctx.db.insert("players", {
        name: "Mike Trout",
        nameNormalized: "mike trout",
        sportId: selectorOptionId,
        lastUpdated: Date.now(),
      }),
    );
    const rowId = await insertRow(t, {
      selectorOptionId,
      sportId: selectorOptionId,
      batchId: "b1",
      kind: "player",
      name: "Mike Trout Jr Typo",
    });

    await asAdmin.mutation(api.entityReviewQueue.recordDecision, {
      reviewRowId: rowId,
      action: "link",
      linkedPlayerId: existingPlayerId,
    });

    const row = await t.run(async (ctx) => ctx.db.get(rowId));
    expect(row!.decision).toEqual({
      action: "link",
      linkedPlayerId: existingPlayerId,
    });
  });

  test("a 'link' decision on a team row stores linkedTeamId", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const selectorOptionId = await seedSelectorOption(t);
    const existingTeamId = await t.run(async (ctx) =>
      ctx.db.insert("teams", {
        name: "Los Angeles Angels",
        nameNormalized: "angeles angels los",
        sportId: selectorOptionId,
        lastUpdated: Date.now(),
      }),
    );
    const rowId = await insertRow(t, {
      selectorOptionId,
      sportId: selectorOptionId,
      batchId: "b1",
      kind: "team",
      name: "LA Angels",
    });

    await asAdmin.mutation(api.entityReviewQueue.recordDecision, {
      reviewRowId: rowId,
      action: "link",
      linkedTeamId: existingTeamId,
    });

    const row = await t.run(async (ctx) => ctx.db.get(rowId));
    expect(row!.decision).toEqual({
      action: "link",
      linkedTeamId: existingTeamId,
    });
  });

  test("rejects a 'link' decision on a player row when linkedPlayerId is missing", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const selectorOptionId = await seedSelectorOption(t);
    const rowId = await insertRow(t, {
      selectorOptionId,
      sportId: selectorOptionId,
      batchId: "b1",
      kind: "player",
      name: "Mike Trout",
    });

    await expect(
      asAdmin.mutation(api.entityReviewQueue.recordDecision, {
        reviewRowId: rowId,
        action: "link",
      }),
    ).rejects.toThrow();
  });

  test("rejects a 'link' decision when the linked player's sport doesn't match the reviewed row's sport", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const selectorOptionId = await seedSelectorOption(t);
    // NEO-96: a genuinely DIFFERENT sport row — the guard now compares ids, so
    // the mismatch has to be a different row rather than a different string.
    const otherSportId = await seedSelectorOption(t);
    const wrongSportPlayerId = await t.run(async (ctx) =>
      ctx.db.insert("players", {
        name: "Some Football Player",
        nameNormalized: "football player some",
        sportId: otherSportId,
        lastUpdated: Date.now(),
      }),
    );
    const rowId = await insertRow(t, {
      selectorOptionId,
      sportId: selectorOptionId,
      batchId: "b1",
      kind: "player",
      name: "Mike Trout",
    });

    await expect(
      asAdmin.mutation(api.entityReviewQueue.recordDecision, {
        reviewRowId: rowId,
        action: "link",
        linkedPlayerId: wrongSportPlayerId,
      }),
    ).rejects.toThrow();
  });

  test("a 'create' decision with valid manualCareerTeams stores them on the row", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const selectorOptionId = await seedSelectorOption(t);
    const rowId = await insertRow(t, {
      selectorOptionId,
      sportId: selectorOptionId,
      batchId: "b1",
      kind: "player",
      name: "Daulton Varsho",
    });

    await asAdmin.mutation(api.entityReviewQueue.recordDecision, {
      reviewRowId: rowId,
      action: "create",
      manualCareerTeams: [
        { name: "Arizona Diamondbacks", fromYear: 2020, toYear: 2022 },
        { name: "Toronto Blue Jays", fromYear: 2023 }, // open-ended (still active)
      ],
    });

    const row = await t.run(async (ctx) => ctx.db.get(rowId));
    expect(row!.decision).toEqual({
      action: "create",
      manualCareerTeams: [
        { name: "Arizona Diamondbacks", fromYear: 2020, toYear: 2022 },
        { name: "Toronto Blue Jays", fromYear: 2023 },
      ],
    });
  });

  test("a 'create' decision with an empty/absent manualCareerTeams omits the key entirely", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const selectorOptionId = await seedSelectorOption(t);
    const rowId = await insertRow(t, {
      selectorOptionId,
      sportId: selectorOptionId,
      batchId: "b1",
      kind: "player",
      name: "Mike Trout",
    });

    await asAdmin.mutation(api.entityReviewQueue.recordDecision, {
      reviewRowId: rowId,
      action: "create",
      manualCareerTeams: [],
    });

    const row = await t.run(async (ctx) => ctx.db.get(rowId));
    // Byte-identical to the no-manual-entries path — an empty array must not
    // leave a stray `manualCareerTeams: []` on the stored decision.
    expect(row!.decision).toEqual({ action: "create" });
  });

  test("rejects a manualCareerTeams entry whose fromYear is out of bounds (too old)", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const selectorOptionId = await seedSelectorOption(t);
    const rowId = await insertRow(t, {
      selectorOptionId,
      sportId: selectorOptionId,
      batchId: "b1",
      kind: "player",
      name: "Daulton Varsho",
    });

    await expect(
      asAdmin.mutation(api.entityReviewQueue.recordDecision, {
        reviewRowId: rowId,
        action: "create",
        manualCareerTeams: [{ name: "Ancient Club", fromYear: 1800 }],
      }),
    ).rejects.toThrow(/fromYear/);
  });

  test("rejects a manualCareerTeams entry whose fromYear is in the future", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const selectorOptionId = await seedSelectorOption(t);
    const rowId = await insertRow(t, {
      selectorOptionId,
      sportId: selectorOptionId,
      batchId: "b1",
      kind: "player",
      name: "Daulton Varsho",
    });

    await expect(
      asAdmin.mutation(api.entityReviewQueue.recordDecision, {
        reviewRowId: rowId,
        action: "create",
        manualCareerTeams: [
          { name: "Future Club", fromYear: new Date().getFullYear() + 5 },
        ],
      }),
    ).rejects.toThrow(/fromYear/);
  });

  test("rejects a manualCareerTeams entry whose toYear precedes its fromYear", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const selectorOptionId = await seedSelectorOption(t);
    const rowId = await insertRow(t, {
      selectorOptionId,
      sportId: selectorOptionId,
      batchId: "b1",
      kind: "player",
      name: "Daulton Varsho",
    });

    await expect(
      asAdmin.mutation(api.entityReviewQueue.recordDecision, {
        reviewRowId: rowId,
        action: "create",
        manualCareerTeams: [
          { name: "Backwards Club", fromYear: 2022, toYear: 2019 },
        ],
      }),
    ).rejects.toThrow(/toYear/);
  });

  test("rejects a manualCareerTeams array longer than the 64-entry cap", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const selectorOptionId = await seedSelectorOption(t);
    const rowId = await insertRow(t, {
      selectorOptionId,
      sportId: selectorOptionId,
      batchId: "b1",
      kind: "player",
      name: "Journeyman",
    });

    // 65 entries — one past the cap. Every entry is individually valid, so
    // this proves the length check fires independently of the per-entry
    // year checks.
    const tooMany = Array.from({ length: 65 }, (_, i) => ({
      name: `Team ${i}`,
      fromYear: 2000,
      toYear: 2001,
    }));

    await expect(
      asAdmin.mutation(api.entityReviewQueue.recordDecision, {
        reviewRowId: rowId,
        action: "create",
        manualCareerTeams: tooMany,
      }),
    ).rejects.toThrow(/maximum is 64/);
  });

  test("accepts a manualCareerTeams array exactly at the 64-entry cap", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const selectorOptionId = await seedSelectorOption(t);
    const rowId = await insertRow(t, {
      selectorOptionId,
      sportId: selectorOptionId,
      batchId: "b1",
      kind: "player",
      name: "Journeyman",
    });

    const exactlyCap = Array.from({ length: 64 }, (_, i) => ({
      name: `Team ${i}`,
      fromYear: 2000,
      toYear: 2001,
    }));

    await asAdmin.mutation(api.entityReviewQueue.recordDecision, {
      reviewRowId: rowId,
      action: "create",
      manualCareerTeams: exactlyCap,
    });

    const row = await t.run(async (ctx) => ctx.db.get(rowId));
    expect(row!.decision).toEqual({ action: "create", manualCareerTeams: exactlyCap });
  });

  test("rejects a manualCareerTeams entry whose name is empty or whitespace-only", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const selectorOptionId = await seedSelectorOption(t);
    const rowId = await insertRow(t, {
      selectorOptionId,
      sportId: selectorOptionId,
      batchId: "b1",
      kind: "player",
      name: "Daulton Varsho",
    });

    await expect(
      asAdmin.mutation(api.entityReviewQueue.recordDecision, {
        reviewRowId: rowId,
        action: "create",
        // Whitespace-only — must be rejected before it can mint a blank team
        // via get-or-create in commitCardChecklist.
        manualCareerTeams: [{ name: "   ", fromYear: 2020, toYear: 2022 }],
      }),
    ).rejects.toThrow(/name cannot be empty/);
  });

  test("throws for an unauthenticated caller", async () => {
    const t = convexTest(schema, modules);
    const selectorOptionId = await seedSelectorOption(t);
    const rowId = await insertRow(t, {
      selectorOptionId,
      sportId: selectorOptionId,
      batchId: "b1",
      kind: "player",
      name: "Mike Trout",
    });

    await expect(
      t.mutation(api.entityReviewQueue.recordDecision, {
        reviewRowId: rowId,
        action: "create",
      }),
    ).rejects.toThrow();
  });

  test("throws for a non-existent review row", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const selectorOptionId = await seedSelectorOption(t);
    const rowId = await insertRow(t, {
      selectorOptionId,
      sportId: selectorOptionId,
      batchId: "b1",
      kind: "player",
      name: "Mike Trout",
    });
    await t.run(async (ctx) => ctx.db.delete(rowId));

    await expect(
      asAdmin.mutation(api.entityReviewQueue.recordDecision, {
        reviewRowId: rowId,
        action: "create",
      }),
    ).rejects.toThrow();
  });

  // =========================================================================
  // NEO-212: the "skip" action ("not a person / not a team")
  // =========================================================================

  test("a 'skip' decision patches exactly the targeted row — siblings untouched", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const selectorOptionId = await seedSelectorOption(t);

    const skippedId = await insertRow(t, {
      selectorOptionId,
      sportId: selectorOptionId,
      batchId: "b1",
      kind: "player",
      // The shape skip exists for: a checklist artifact, not a person.
      name: "Checklist",
    });
    const siblingId = await insertRow(t, {
      selectorOptionId,
      sportId: selectorOptionId,
      batchId: "b1",
      kind: "player",
      name: "Aaron Judge",
    });

    await asAdmin.mutation(api.entityReviewQueue.recordDecision, {
      reviewRowId: skippedId,
      action: "skip",
    });

    const skipped = await t.run(async (ctx) => ctx.db.get(skippedId));
    const sibling = await t.run(async (ctx) => ctx.db.get(siblingId));
    // Payload-free by construction — commit reads only `action` for a skip.
    expect(skipped!.decision).toEqual({ action: "skip" });
    expect(sibling!.decision).toBeUndefined();
  });

  test("a 'skip' decision works on a team row too", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const selectorOptionId = await seedSelectorOption(t);
    const rowId = await insertRow(t, {
      selectorOptionId,
      sportId: selectorOptionId,
      batchId: "b1",
      kind: "team",
      name: "Prospects",
    });

    await asAdmin.mutation(api.entityReviewQueue.recordDecision, {
      reviewRowId: rowId,
      action: "skip",
    });

    expect(
      (await t.run(async (ctx) => ctx.db.get(rowId)))!.decision,
    ).toEqual({ action: "skip" });
  });

  test("a 'skip' decision IGNORES a stray linkedPlayerId / linkedTeamId / manualCareerTeams", async () => {
    // The wizard drives all three actions through one call site, so these are
    // leftovers from a previously-selected action rather than caller error.
    // Ignoring them (not throwing) keeps the operator out of a dead end, and
    // nothing leaks: the stored decision is `{ action: "skip" }` and nothing
    // more, so commit can never see them.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const selectorOptionId = await seedSelectorOption(t);
    const existingPlayerId = await t.run(async (ctx) =>
      ctx.db.insert("players", {
        name: "Mike Trout",
        nameNormalized: "mike trout",
        sportId: selectorOptionId,
        lastUpdated: Date.now(),
      }),
    );
    const existingTeamId = await t.run(async (ctx) =>
      ctx.db.insert("teams", {
        name: "Los Angeles Angels",
        nameNormalized: "angeles angels los",
        sportId: selectorOptionId,
        lastUpdated: Date.now(),
      }),
    );
    const rowId = await insertRow(t, {
      selectorOptionId,
      sportId: selectorOptionId,
      batchId: "b1",
      kind: "player",
      name: "Checklist",
    });

    await asAdmin.mutation(api.entityReviewQueue.recordDecision, {
      reviewRowId: rowId,
      action: "skip",
      linkedPlayerId: existingPlayerId,
      linkedTeamId: existingTeamId,
      manualCareerTeams: [{ name: "Toronto Blue Jays", fromYear: 2023 }],
      excludedCareerTeamNames: ["Arizona Diamondbacks"],
    });

    const row = await t.run(async (ctx) => ctx.db.get(rowId));
    expect(row!.decision).toEqual({ action: "skip" });
  });

  test("a 'skip' decision does NOT validate the ids it ignores — a bogus link id is still accepted", async () => {
    // Same contract from the other side: skip must not run the link branch's
    // existence/sport checks, because it never stores what they would check.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const selectorOptionId = await seedSelectorOption(t);
    const deletedPlayerId = await t.run(async (ctx) =>
      ctx.db.insert("players", {
        name: "Ghost",
        nameNormalized: "ghost",
        sportId: selectorOptionId,
        lastUpdated: Date.now(),
      }),
    );
    await t.run(async (ctx) => ctx.db.delete(deletedPlayerId));
    const rowId = await insertRow(t, {
      selectorOptionId,
      sportId: selectorOptionId,
      batchId: "b1",
      kind: "player",
      name: "Checklist",
    });

    await expect(
      asAdmin.mutation(api.entityReviewQueue.recordDecision, {
        reviewRowId: rowId,
        action: "skip",
        linkedPlayerId: deletedPlayerId,
      }),
    ).resolves.toBeNull();
    expect(
      (await t.run(async (ctx) => ctx.db.get(rowId)))!.decision,
    ).toEqual({ action: "skip" });
  });

  test("a 'skip' on an already-decided row overwrites it, exactly as create/link do", async () => {
    // recordDecision has never guarded on an existing decision — the wizard
    // lets an operator go back and change a call. This asserts the CURRENT
    // rule for all three actions together so skip can't silently diverge.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const selectorOptionId = await seedSelectorOption(t);
    const existingPlayerId = await t.run(async (ctx) =>
      ctx.db.insert("players", {
        name: "Mike Trout",
        nameNormalized: "mike trout",
        sportId: selectorOptionId,
        lastUpdated: Date.now(),
      }),
    );
    const rowId = await insertRow(t, {
      selectorOptionId,
      sportId: selectorOptionId,
      batchId: "b1",
      kind: "player",
      name: "Mike Trout",
    });

    await asAdmin.mutation(api.entityReviewQueue.recordDecision, {
      reviewRowId: rowId,
      action: "create",
    });
    // create -> skip
    await asAdmin.mutation(api.entityReviewQueue.recordDecision, {
      reviewRowId: rowId,
      action: "skip",
    });
    expect(
      (await t.run(async (ctx) => ctx.db.get(rowId)))!.decision,
    ).toEqual({ action: "skip" });

    // skip -> link, and back again: a skip is no more sticky than any other
    // decision.
    await asAdmin.mutation(api.entityReviewQueue.recordDecision, {
      reviewRowId: rowId,
      action: "link",
      linkedPlayerId: existingPlayerId,
    });
    expect(
      (await t.run(async (ctx) => ctx.db.get(rowId)))!.decision,
    ).toEqual({ action: "link", linkedPlayerId: existingPlayerId });

    await asAdmin.mutation(api.entityReviewQueue.recordDecision, {
      reviewRowId: rowId,
      action: "skip",
    });
    expect(
      (await t.run(async (ctx) => ctx.db.get(rowId)))!.decision,
    ).toEqual({ action: "skip" });
  });

  test("a 'skip' decision throws for an unauthenticated caller", async () => {
    const t = convexTest(schema, modules);
    const selectorOptionId = await seedSelectorOption(t);
    const rowId = await insertRow(t, {
      selectorOptionId,
      sportId: selectorOptionId,
      batchId: "b1",
      kind: "player",
      name: "Checklist",
    });

    await expect(
      t.mutation(api.entityReviewQueue.recordDecision, {
        reviewRowId: rowId,
        action: "skip",
      }),
    ).rejects.toThrow();
  });

  // =========================================================================
  // NEO-212: excludedCareerTeamNames on a "create" decision
  // =========================================================================

  test("a 'create' decision stores excludedCareerTeamNames when given", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const selectorOptionId = await seedSelectorOption(t);
    const rowId = await insertRow(t, {
      selectorOptionId,
      sportId: selectorOptionId,
      batchId: "b1",
      kind: "player",
      name: "Daulton Varsho",
    });

    await asAdmin.mutation(api.entityReviewQueue.recordDecision, {
      reviewRowId: rowId,
      action: "create",
      excludedCareerTeamNames: [
        "Arizona Diamondbacks",
        "Toronto Blue Jays",
      ],
    });

    expect(
      (await t.run(async (ctx) => ctx.db.get(rowId)))!.decision,
    ).toEqual({
      action: "create",
      excludedCareerTeamNames: ["Arizona Diamondbacks", "Toronto Blue Jays"],
    });
  });

  test("a 'create' decision stores excludedCareerTeamNames alongside manualCareerTeams", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const selectorOptionId = await seedSelectorOption(t);
    const rowId = await insertRow(t, {
      selectorOptionId,
      sportId: selectorOptionId,
      batchId: "b1",
      kind: "player",
      name: "Daulton Varsho",
    });

    await asAdmin.mutation(api.entityReviewQueue.recordDecision, {
      reviewRowId: rowId,
      action: "create",
      manualCareerTeams: [{ name: "Toronto Blue Jays", fromYear: 2023 }],
      excludedCareerTeamNames: ["Arizona Diamondbacks"],
    });

    expect(
      (await t.run(async (ctx) => ctx.db.get(rowId)))!.decision,
    ).toEqual({
      action: "create",
      manualCareerTeams: [{ name: "Toronto Blue Jays", fromYear: 2023 }],
      excludedCareerTeamNames: ["Arizona Diamondbacks"],
    });
  });

  test("a 'create' decision with an empty/absent excludedCareerTeamNames omits the key entirely", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const selectorOptionId = await seedSelectorOption(t);
    const rowId = await insertRow(t, {
      selectorOptionId,
      sportId: selectorOptionId,
      batchId: "b1",
      kind: "player",
      name: "Mike Trout",
    });

    await asAdmin.mutation(api.entityReviewQueue.recordDecision, {
      reviewRowId: rowId,
      action: "create",
      excludedCareerTeamNames: [],
    });

    // Byte-identical to the no-exclusions path — an empty array must not leave
    // a stray `excludedCareerTeamNames: []` on the stored decision.
    expect(
      (await t.run(async (ctx) => ctx.db.get(rowId)))!.decision,
    ).toEqual({ action: "create" });
  });

  test("excludedCareerTeamNames are trimmed and deduped case-insensitively", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const selectorOptionId = await seedSelectorOption(t);
    const rowId = await insertRow(t, {
      selectorOptionId,
      sportId: selectorOptionId,
      batchId: "b1",
      kind: "player",
      name: "Daulton Varsho",
    });

    await asAdmin.mutation(api.entityReviewQueue.recordDecision, {
      reviewRowId: rowId,
      action: "create",
      excludedCareerTeamNames: [
        "Arizona Diamondbacks",
        "  arizona diamondbacks  ",
        "Toronto Blue Jays",
      ],
    });

    // First appearance wins, with its original casing — the stored list stays
    // readable as an audit record of what the operator rejected.
    expect(
      (await t.run(async (ctx) => ctx.db.get(rowId)))!.decision,
    ).toEqual({
      action: "create",
      excludedCareerTeamNames: ["Arizona Diamondbacks", "Toronto Blue Jays"],
    });
  });

  test("rejects an excludedCareerTeamNames entry that is empty or whitespace-only", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const selectorOptionId = await seedSelectorOption(t);
    const rowId = await insertRow(t, {
      selectorOptionId,
      sportId: selectorOptionId,
      batchId: "b1",
      kind: "player",
      name: "Daulton Varsho",
    });

    for (const blank of ["", "   "]) {
      await expect(
        asAdmin.mutation(api.entityReviewQueue.recordDecision, {
          reviewRowId: rowId,
          action: "create",
          // A blank label can never match an enrichment careerTeams name, so
          // it is always operator/UI error rather than a harmless no-op.
          excludedCareerTeamNames: ["Arizona Diamondbacks", blank],
        }),
      ).rejects.toThrow(/name cannot be empty/);
    }

    // The rejected call must not have partially written a decision.
    expect(
      (await t.run(async (ctx) => ctx.db.get(rowId)))!.decision,
    ).toBeUndefined();
  });

  test("rejects an excludedCareerTeamNames array longer than the 64-entry cap", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const selectorOptionId = await seedSelectorOption(t);
    const rowId = await insertRow(t, {
      selectorOptionId,
      sportId: selectorOptionId,
      batchId: "b1",
      kind: "player",
      name: "Daulton Varsho",
    });

    await expect(
      asAdmin.mutation(api.entityReviewQueue.recordDecision, {
        reviewRowId: rowId,
        action: "create",
        excludedCareerTeamNames: Array.from(
          { length: 65 },
          (_, i) => `Team ${i}`,
        ),
      }),
    ).rejects.toThrow(/maximum is 64/);
  });

  test("accepts an excludedCareerTeamNames array exactly at the 64-entry cap", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const selectorOptionId = await seedSelectorOption(t);
    const rowId = await insertRow(t, {
      selectorOptionId,
      sportId: selectorOptionId,
      batchId: "b1",
      kind: "player",
      name: "Daulton Varsho",
    });
    const names = Array.from({ length: 64 }, (_, i) => `Team ${i}`);

    await asAdmin.mutation(api.entityReviewQueue.recordDecision, {
      reviewRowId: rowId,
      action: "create",
      excludedCareerTeamNames: names,
    });

    const row = await t.run(async (ctx) => ctx.db.get(rowId));
    expect(
      row!.decision?.action === "create" &&
        row!.decision.excludedCareerTeamNames?.length,
    ).toBe(64);
  });
});

// ===========================================================================
// cancelBatch
// ===========================================================================

// ===========================================================================
// recordAllRemainingAsCreate
//
// NEO-110: this mutation had ZERO coverage, which is why a suspected bug here
// cost a full investigation to exonerate. CI run 30505189226 showed a bulk tap
// on a button reading "(3)" leaving the wizard at "1 of 3 reviewed", and the
// backend was the prime suspect. It was innocent — the tap had landed on "Add
// as New Player" after a reflow (see EntityReviewWizard.tsx's NEO-110 comment)
// — but nothing here proved that. These tests are that proof, kept permanently.
//
// The load-bearing property: this mutation decides EVERY undecided row in one
// transaction and deliberately does NOT filter on `status`, so rows whose
// lookup is still in flight are decided too (commitCardChecklist's create
// branch treats `enrichment` as optional).
// ===========================================================================

describe("recordAllRemainingAsCreate", () => {
  test("decides every undecided row in the batch and returns the count", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const selectorOptionId = await seedSelectorOption(t);

    for (const name of ["KOPlayer", "CDPlayerA", "CDPlayerB"])
      await insertRow(t, {
        selectorOptionId,
        sportId: selectorOptionId,
        batchId: "bulk",
        kind: "player",
        name,
        status: "ready",
      });

    const count = await asAdmin.mutation(
      api.entityReviewQueue.recordAllRemainingAsCreate,
      { selectorOptionId, batchId: "bulk" },
    );

    expect(count).toBe(3);
    const rows = await asAdmin.query(api.entityReviewQueue.getBatch, {
      selectorOptionId,
      batchId: "bulk",
    });
    expect(rows.filter((r) => r.decision).length).toBe(3);
    expect(rows.every((r) => r.decision?.action === "create")).toBe(true);
  });

  test("decides rows still 'pending' — an in-flight lookup must not be skipped", async () => {
    // The exact CI shape: one lookup had resolved, two were still pending.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const selectorOptionId = await seedSelectorOption(t);

    await insertRow(t, {
      selectorOptionId,
      sportId: selectorOptionId, batchId: "bulk", kind: "player", name: "KOPlayer", status: "ready",
    });
    await insertRow(t, {
      selectorOptionId,
      sportId: selectorOptionId, batchId: "bulk", kind: "player", name: "CDPlayerA", status: "pending",
    });
    await insertRow(t, {
      selectorOptionId,
      sportId: selectorOptionId, batchId: "bulk", kind: "player", name: "CDPlayerB", status: "pending",
    });

    const count = await asAdmin.mutation(
      api.entityReviewQueue.recordAllRemainingAsCreate,
      { selectorOptionId, batchId: "bulk" },
    );

    expect(count).toBe(3);
  });

  test("leaves an already-decided row alone and does not count it", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const selectorOptionId = await seedSelectorOption(t);

    const decidedId = await insertRow(t, {
      selectorOptionId,
      sportId: selectorOptionId, batchId: "bulk", kind: "player", name: "Already", status: "ready",
    });
    await insertRow(t, {
      selectorOptionId,
      sportId: selectorOptionId, batchId: "bulk", kind: "player", name: "Undecided", status: "ready",
    });
    await t.run(async (ctx) =>
      ctx.db.patch(decidedId, { decision: { action: "create" } }),
    );

    const count = await asAdmin.mutation(
      api.entityReviewQueue.recordAllRemainingAsCreate,
      { selectorOptionId, batchId: "bulk" },
    );

    expect(count).toBe(1);
  });

  test("a later enrichment write does NOT clear the decisions it set", async () => {
    // Locked in because the NEO-110 investigation's first hypothesis was that
    // this write clobbered `decision` on rows that were pending at bulk-decide
    // time. NEO-189 made the guarantee stronger rather than weaker: the write
    // is now skipped outright on a decided row, so the decision cannot be
    // touched and the row keeps the `pending` status it was decided with. See
    // the "decided-row guard" block below for why that is inert.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const selectorOptionId = await seedSelectorOption(t);

    const ids: Array<Id<"entityReviewQueue">> = [];
    for (const name of ["A", "B", "C"])
      ids.push(
        await insertRow(t, {
          selectorOptionId, sportId: selectorOptionId, batchId: "bulk", kind: "player", name, status: "pending",
        }),
      );

    await asAdmin.mutation(api.entityReviewQueue.recordAllRemainingAsCreate, {
      selectorOptionId,
      batchId: "bulk",
    });
    for (const id of ids)
      await t.mutation(internal.entityReviewQueue.applyLookupResult, {
        id,
        status: "ready",
      });

    const rows = await asAdmin.query(api.entityReviewQueue.getBatch, {
      selectorOptionId,
      batchId: "bulk",
    });
    expect(rows.filter((r) => r.decision).length).toBe(3);
    expect(rows.every((r) => r.status === "pending")).toBe(true);
  });

  test("is scoped to its own batch — rows in another batch are untouched", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const selectorOptionId = await seedSelectorOption(t);

    await insertRow(t, {
      selectorOptionId,
      sportId: selectorOptionId, batchId: "mine", kind: "player", name: "Mine", status: "ready",
    });
    await insertRow(t, {
      selectorOptionId,
      sportId: selectorOptionId, batchId: "theirs", kind: "player", name: "Theirs", status: "ready",
    });

    const count = await asAdmin.mutation(
      api.entityReviewQueue.recordAllRemainingAsCreate,
      { selectorOptionId, batchId: "mine" },
    );

    expect(count).toBe(1);
    const theirs = await asAdmin.query(api.entityReviewQueue.getBatch, {
      selectorOptionId,
      batchId: "theirs",
    });
    expect(theirs[0].decision).toBeUndefined();
  });

  test("requires admin", async () => {
    const t = convexTest(schema, modules);
    const selectorOptionId = await seedSelectorOption(t);
    await insertRow(t, {
      selectorOptionId,
      sportId: selectorOptionId, batchId: "bulk", kind: "player", name: "X", status: "ready",
    });

    await expect(
      t.mutation(api.entityReviewQueue.recordAllRemainingAsCreate, {
        selectorOptionId,
        batchId: "bulk",
      }),
    ).rejects.toThrow();
  });
});

// ===========================================================================
// recordAllRemainingAsSkip (NEO-212)
//
// The mirror image of the create fast path, for a set whose surfaced "new
// names" are mostly not entities at all (subset/parallel labels, checklist
// headers). Both mutations share one private `decideAllRemaining` helper, so
// these tests are as much about the two NOT drifting — same batch scoping,
// same already-decided rule, same count — as about skip itself.
// ===========================================================================

describe("recordAllRemainingAsSkip", () => {
  test("decides every undecided row in the batch as skip and returns the count", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const selectorOptionId = await seedSelectorOption(t);

    for (const name of ["Checklist", "Header", "Puzzle Piece"])
      await insertRow(t, {
        selectorOptionId,
        sportId: selectorOptionId,
        batchId: "bulk",
        kind: "player",
        name,
        status: "ready",
      });

    const count = await asAdmin.mutation(
      api.entityReviewQueue.recordAllRemainingAsSkip,
      { selectorOptionId, batchId: "bulk" },
    );

    expect(count).toBe(3);
    const rows = await asAdmin.query(api.entityReviewQueue.getBatch, {
      selectorOptionId,
      batchId: "bulk",
    });
    expect(rows.every((r) => r.decision?.action === "skip")).toBe(true);
  });

  test("decides rows still 'pending' — same as the create variant (NEO-221 owns changing that)", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const selectorOptionId = await seedSelectorOption(t);

    await insertRow(t, {
      selectorOptionId,
      sportId: selectorOptionId, batchId: "bulk", kind: "player", name: "Resolved", status: "ready",
    });
    await insertRow(t, {
      selectorOptionId,
      sportId: selectorOptionId, batchId: "bulk", kind: "player", name: "StillLookingUp", status: "pending",
    });

    const count = await asAdmin.mutation(
      api.entityReviewQueue.recordAllRemainingAsSkip,
      { selectorOptionId, batchId: "bulk" },
    );

    expect(count).toBe(2);
  });

  test("leaves an already-decided row alone and does not count it", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const selectorOptionId = await seedSelectorOption(t);

    const decidedId = await insertRow(t, {
      selectorOptionId,
      sportId: selectorOptionId, batchId: "bulk", kind: "player", name: "Already", status: "ready",
    });
    const undecidedId = await insertRow(t, {
      selectorOptionId,
      sportId: selectorOptionId, batchId: "bulk", kind: "player", name: "Undecided", status: "ready",
    });
    await t.run(async (ctx) =>
      ctx.db.patch(decidedId, { decision: { action: "create" } }),
    );

    const count = await asAdmin.mutation(
      api.entityReviewQueue.recordAllRemainingAsSkip,
      { selectorOptionId, batchId: "bulk" },
    );

    expect(count).toBe(1);
    // The operator's own "create" call survives the bulk skip — the fast path
    // fills in the REMAINDER, it does not overrule decisions already made.
    expect(
      (await t.run(async (ctx) => ctx.db.get(decidedId)))!.decision,
    ).toEqual({ action: "create" });
    expect(
      (await t.run(async (ctx) => ctx.db.get(undecidedId)))!.decision,
    ).toEqual({ action: "skip" });
  });

  test("is scoped to its own batch — a row in another batch of the same selectorOption is untouched", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const selectorOptionId = await seedSelectorOption(t);

    await insertRow(t, {
      selectorOptionId,
      sportId: selectorOptionId, batchId: "mine", kind: "player", name: "Mine", status: "ready",
    });
    await insertRow(t, {
      selectorOptionId,
      sportId: selectorOptionId, batchId: "theirs", kind: "player", name: "Theirs", status: "ready",
    });

    const count = await asAdmin.mutation(
      api.entityReviewQueue.recordAllRemainingAsSkip,
      { selectorOptionId, batchId: "mine" },
    );

    expect(count).toBe(1);
    const theirs = await asAdmin.query(api.entityReviewQueue.getBatch, {
      selectorOptionId,
      batchId: "theirs",
    });
    expect(theirs[0].decision).toBeUndefined();
  });

  test("returns 0 when every row is already decided", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const selectorOptionId = await seedSelectorOption(t);
    const rowId = await insertRow(t, {
      selectorOptionId,
      sportId: selectorOptionId, batchId: "bulk", kind: "player", name: "Only", status: "ready",
    });
    await t.run(async (ctx) =>
      ctx.db.patch(rowId, { decision: { action: "skip" } }),
    );

    expect(
      await asAdmin.mutation(api.entityReviewQueue.recordAllRemainingAsSkip, {
        selectorOptionId,
        batchId: "bulk",
      }),
    ).toBe(0);
  });

  test("requires admin", async () => {
    const t = convexTest(schema, modules);
    const selectorOptionId = await seedSelectorOption(t);
    const rowId = await insertRow(t, {
      selectorOptionId,
      sportId: selectorOptionId, batchId: "bulk", kind: "player", name: "X", status: "ready",
    });

    await expect(
      t.mutation(api.entityReviewQueue.recordAllRemainingAsSkip, {
        selectorOptionId,
        batchId: "bulk",
      }),
    ).rejects.toThrow();
    // Rejected before any write.
    expect(
      (await t.run(async (ctx) => ctx.db.get(rowId)))!.decision,
    ).toBeUndefined();
  });
});

// ===========================================================================
// applyLookupResult — NEO-189 decided-row guard
// ===========================================================================

/**
 * The seed job's `commitCardChecklist` died on a Convex optimistic-concurrency
 * conflict: its prelude reads a whole `entityReviewQueue` batch, and stragglers
 * from the Wikidata pool kept patching those same rows through
 * `applyLookupResult` — on every internal retry, so the commit never won.
 *
 * convex-test runs mutations serially and therefore cannot reproduce a real OCC
 * conflict. So the fix is tested where it actually lives: the WRITER no longer
 * writes once the operator has ruled. (The bounded retry behind it is a plain
 * function, unit-tested in lib/errors/occ-retry.test.ts.)
 */
describe("applyLookupResult — decided-row guard (NEO-189)", () => {
  test("skips the patch entirely on a row that already carries a decision", async () => {
    const t = convexTest(schema, modules);
    const selectorOptionId = await seedSelectorOption(t);
    const id = await insertRow(t, {
      selectorOptionId, sportId: selectorOptionId, batchId: "b", kind: "player", name: "Decided", status: "pending",
    });
    await t.run(async (ctx) =>
      ctx.db.patch(id, { decision: { action: "create" } }),
    );

    // A straggler lookup lands after the operator hit "Add All Remaining".
    await t.mutation(internal.entityReviewQueue.applyLookupResult, {
      id,
      status: "ready",
      enrichment: { wikidataId: "Q42", isHallOfFame: true },
    });

    const row = await t.run(async (ctx) => ctx.db.get(id));
    // No write happened at all — which is the point: a write here is what
    // invalidated the commit prelude's read set.
    expect(row!.status).toBe("pending");
    expect(row!.enrichment).toBeUndefined();
    expect(row!.decision).toEqual({ action: "create" });
  });

  test("skips the patch on a row decided 'skip' (NEO-212) as well as 'create'", async () => {
    // The guard branches on the PRESENCE of a decision, not its action, so
    // NEO-212's new action inherits it — asserted rather than assumed, since a
    // straggler lookup writing here is exactly what broke the seed commit.
    const t = convexTest(schema, modules);
    const selectorOptionId = await seedSelectorOption(t);
    const id = await insertRow(t, {
      selectorOptionId, sportId: selectorOptionId, batchId: "b", kind: "player", name: "Checklist", status: "pending",
    });
    await t.run(async (ctx) =>
      ctx.db.patch(id, { decision: { action: "skip" } }),
    );

    await t.mutation(internal.entityReviewQueue.applyLookupResult, {
      id,
      status: "ready",
      enrichment: { wikidataId: "Q42", isHallOfFame: true },
    });

    const row = await t.run(async (ctx) => ctx.db.get(id));
    expect(row!.status).toBe("pending");
    expect(row!.enrichment).toBeUndefined();
    expect(row!.decision).toEqual({ action: "skip" });
  });

  test("does not downgrade a decided row that had already resolved", async () => {
    const t = convexTest(schema, modules);
    const selectorOptionId = await seedSelectorOption(t);
    const id = await insertRow(t, {
      selectorOptionId, sportId: selectorOptionId, batchId: "b", kind: "player", name: "Both", status: "ready",
    });
    await t.run(async (ctx) =>
      ctx.db.patch(id, {
        decision: { action: "create" },
        enrichment: { wikidataId: "Q1" },
      }),
    );

    await t.mutation(internal.entityReviewQueue.applyLookupResult, {
      id,
      status: "error",
    });

    const row = await t.run(async (ctx) => ctx.db.get(id));
    expect(row!.status).toBe("ready");
    expect(row!.enrichment?.wikidataId).toBe("Q1");
  });

  test("still patches an UNDECIDED pending row — the wizard depends on it", async () => {
    const t = convexTest(schema, modules);
    const selectorOptionId = await seedSelectorOption(t);
    const id = await insertRow(t, {
      selectorOptionId, sportId: selectorOptionId, batchId: "b", kind: "player", name: "Waiting", status: "pending",
    });

    await t.mutation(internal.entityReviewQueue.applyLookupResult, {
      id,
      status: "ready",
      enrichment: { wikidataId: "Q7", isHallOfFame: false },
    });

    const row = await t.run(async (ctx) => ctx.db.get(id));
    // Undecided rows are the ones the wizard blocks on: the guard must not
    // touch them, or the review step never becomes reviewable.
    expect(row!.status).toBe("ready");
    expect(row!.enrichment?.wikidataId).toBe("Q7");
  });

  test("still resolves an UNDECIDED row whose lookup found nothing", async () => {
    const t = convexTest(schema, modules);
    const selectorOptionId = await seedSelectorOption(t);
    const id = await insertRow(t, {
      selectorOptionId, sportId: selectorOptionId, batchId: "b", kind: "team", name: "NoMatch", status: "pending",
    });

    await t.mutation(internal.entityReviewQueue.applyLookupResult, {
      id,
      status: "error",
    });

    expect((await t.run(async (ctx) => ctx.db.get(id)))!.status).toBe("error");
  });

  test("no-ops on a row a Cancel deleted while the lookup was draining", async () => {
    const t = convexTest(schema, modules);
    const selectorOptionId = await seedSelectorOption(t);
    const id = await insertRow(t, {
      selectorOptionId, sportId: selectorOptionId, batchId: "b", kind: "player", name: "Gone", status: "pending",
    });
    await t.run(async (ctx) => ctx.db.delete(id));

    await expect(
      t.mutation(internal.entityReviewQueue.applyLookupResult, {
        id,
        status: "ready",
      }),
    ).resolves.toBeNull();
  });
});

describe("cancelBatch", () => {
  test("deletes every row for the batch and touches nothing else", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const selectorOptionId = await seedSelectorOption(t);

    await insertRow(t, { selectorOptionId, sportId: selectorOptionId, batchId: "cancel-me", kind: "player", name: "Mike Trout" });
    await insertRow(t, { selectorOptionId, sportId: selectorOptionId, batchId: "cancel-me", kind: "team", name: "Los Angeles Angels" });
    // A row in a DIFFERENT batch must survive.
    const otherBatchRowId = await insertRow(t, {
      selectorOptionId,
      sportId: selectorOptionId,
      batchId: "keep-me",
      kind: "player",
      name: "Aaron Judge",
    });

    // Pre-existing players/teams/cardChecklist rows — cancelling a review
    // batch must be a no-op on every other table (same all-or-nothing
    // semantics as the old dialog's Cancel).
    const preexistingPlayerId = await t.run(async (ctx) =>
      ctx.db.insert("players", {
        name: "Existing Player",
        nameNormalized: "existing player",
        sportId: selectorOptionId,
        lastUpdated: 1_700_000_000_000,
      }),
    );
    const preexistingTeamId = await t.run(async (ctx) =>
      ctx.db.insert("teams", {
        name: "Existing Team",
        nameNormalized: "existing team",
        sportId: selectorOptionId,
        lastUpdated: 1_700_000_000_000,
      }),
    );

    await asAdmin.mutation(api.entityReviewQueue.cancelBatch, {
      selectorOptionId,
      batchId: "cancel-me",
    });

    const remaining = await asAdmin.query(api.entityReviewQueue.getBatch, {
      selectorOptionId,
      batchId: "cancel-me",
    });
    expect(remaining).toHaveLength(0);

    const otherBatchRow = await t.run(async (ctx) => ctx.db.get(otherBatchRowId));
    expect(otherBatchRow).not.toBeNull();

    const player = await t.run(async (ctx) => ctx.db.get(preexistingPlayerId));
    const team = await t.run(async (ctx) => ctx.db.get(preexistingTeamId));
    expect(player!.lastUpdated).toBe(1_700_000_000_000);
    expect(team!.lastUpdated).toBe(1_700_000_000_000);
    const allCards = await t.run(async (ctx) => ctx.db.query("cardChecklist").collect());
    expect(allCards).toHaveLength(0);
  });

  test("throws for an unauthenticated caller", async () => {
    const t = convexTest(schema, modules);
    const selectorOptionId = await seedSelectorOption(t);
    await expect(
      t.mutation(api.entityReviewQueue.cancelBatch, {
        selectorOptionId,
        batchId: "any-batch",
      }),
    ).rejects.toThrow();
  });
});

// ===========================================================================
// cleanupBatch
// ===========================================================================

describe("cleanupBatch", () => {
  test("deletes every row for the batch (same shape as cancelBatch, but internal)", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const selectorOptionId = await seedSelectorOption(t);

    await insertRow(t, { selectorOptionId, sportId: selectorOptionId, batchId: "done-batch", kind: "player", name: "Mike Trout" });
    await insertRow(t, { selectorOptionId, sportId: selectorOptionId, batchId: "done-batch", kind: "team", name: "Angels" });
    const otherBatchRowId = await insertRow(t, {
      selectorOptionId,
      sportId: selectorOptionId,
      batchId: "other-batch",
      kind: "player",
      name: "Aaron Judge",
    });

    await t.mutation(internal.entityReviewQueue.cleanupBatch, {
      selectorOptionId,
      batchId: "done-batch",
    });

    const remaining = await asAdmin.query(api.entityReviewQueue.getBatch, {
      selectorOptionId,
      batchId: "done-batch",
    });
    expect(remaining).toHaveLength(0);
    const otherBatchRow = await t.run(async (ctx) => ctx.db.get(otherBatchRowId));
    expect(otherBatchRow).not.toBeNull();
  });

  test("no-ops cleanly when the batch has already been cleaned up (or never existed)", async () => {
    const t = convexTest(schema, modules);
    const selectorOptionId = await seedSelectorOption(t);

    await expect(
      t.mutation(internal.entityReviewQueue.cleanupBatch, {
        selectorOptionId,
        batchId: "never-existed",
      }),
    ).resolves.toBeNull();
  });
});

// ===========================================================================
// NEO-236 — the operator's Location + Name rides on the create decision
//
// A `teams` row born out of this queue is built from `decision.create` and
// nothing else; the prelude has no fallback to `row.name`. So what
// recordDecision stores here IS what gets created, and these tests pin the
// validation that stands between an operator's typing and a `teams` insert.
// ===========================================================================

describe("recordDecision — NEO-236 team create payload", () => {
  test("stores the operator's Location + Name on a team row, trimmed", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const selectorOptionId = await seedSelectorOption(t);
    const rowId = await insertRow(t, {
      selectorOptionId,
      sportId: selectorOptionId,
      batchId: "b1",
      kind: "team",
      name: "SD PADRES",
      status: "ready",
    });

    await asAdmin.mutation(api.entityReviewQueue.recordDecision, {
      reviewRowId: rowId,
      action: "create",
      create: { location: "  San   Diego ", name: "  Padres  " },
    });

    const row = await t.run(async (ctx) => ctx.db.get(rowId));
    expect(row!.decision).toEqual({
      action: "create",
      create: { location: "San Diego", name: "Padres" },
    });
  });

  test("omits `location` when it is blank — a location-less team is a real team", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const selectorOptionId = await seedSelectorOption(t);
    const rowId = await insertRow(t, {
      selectorOptionId,
      sportId: selectorOptionId,
      batchId: "b1",
      kind: "team",
      name: "Orix Buffaloes",
      status: "ready",
    });

    await asAdmin.mutation(api.entityReviewQueue.recordDecision, {
      reviewRowId: rowId,
      action: "create",
      create: { location: "   ", name: "Orix Buffaloes" },
    });

    const row = await t.run(async (ctx) => ctx.db.get(rowId));
    expect(row!.decision).toEqual({
      action: "create",
      create: { name: "Orix Buffaloes" },
    });
  });

  test("refuses a blank name — it composes to nothing and can create nothing", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const selectorOptionId = await seedSelectorOption(t);
    const rowId = await insertRow(t, {
      selectorOptionId,
      sportId: selectorOptionId,
      batchId: "b1",
      kind: "team",
      name: "Padres",
      status: "ready",
    });

    await expect(
      asAdmin.mutation(api.entityReviewQueue.recordDecision, {
        reviewRowId: rowId,
        action: "create",
        create: { location: "San Diego", name: "   " },
      }),
    ).rejects.toThrow(/Team name cannot be empty/);
  });

  test("refuses a composed name past the stored-name limit", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const selectorOptionId = await seedSelectorOption(t);
    const rowId = await insertRow(t, {
      selectorOptionId,
      sportId: selectorOptionId,
      batchId: "b1",
      kind: "team",
      name: "Long",
      status: "ready",
    });

    // Neither half is over the limit; TOGETHER they are. The bound has to be
    // on the composed name, which is what lands in the row.
    await expect(
      asAdmin.mutation(api.entityReviewQueue.recordDecision, {
        reviewRowId: rowId,
        action: "create",
        create: { location: "L".repeat(70), name: "N".repeat(70) },
      }),
    ).rejects.toThrow(/the limit is 120/);
  });

  test("drops a `create` sent on a PLAYER row — it is meaningless there", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const selectorOptionId = await seedSelectorOption(t);
    const rowId = await insertRow(t, {
      selectorOptionId,
      sportId: selectorOptionId,
      batchId: "b1",
      kind: "player",
      name: "Mike Trout",
      status: "ready",
    });

    await asAdmin.mutation(api.entityReviewQueue.recordDecision, {
      reviewRowId: rowId,
      action: "create",
      create: { name: "Padres" },
    });

    const row = await t.run(async (ctx) => ctx.db.get(rowId));
    expect(row!.decision).toEqual({ action: "create" });
  });

  test("drops `createTeams` sent on a TEAM row — commit never reads it there", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const selectorOptionId = await seedSelectorOption(t);
    const rowId = await insertRow(t, {
      selectorOptionId,
      sportId: selectorOptionId,
      batchId: "b1",
      kind: "team",
      name: "Padres",
      status: "ready",
    });

    await asAdmin.mutation(api.entityReviewQueue.recordDecision, {
      reviewRowId: rowId,
      action: "create",
      create: { name: "Padres" },
      createTeams: [{ sourceName: "Angels", name: "Angels" }],
    });

    const row = await t.run(async (ctx) => ctx.db.get(rowId));
    expect(row!.decision).toEqual({
      action: "create",
      create: { name: "Padres" },
    });
  });
});

describe("recordDecision — NEO-236 career-team create payload", () => {
  const seedPlayerRow = async (t: ReturnType<typeof convexTest>) => {
    const selectorOptionId = await seedSelectorOption(t);
    const rowId = await insertRow(t, {
      selectorOptionId,
      sportId: selectorOptionId,
      batchId: "b1",
      kind: "player",
      name: "Tony Gwynn",
      status: "ready",
    });
    return rowId;
  };

  test("stores one pair per accepted career team, keyed by the label it answers", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const rowId = await seedPlayerRow(t);

    await asAdmin.mutation(api.entityReviewQueue.recordDecision, {
      reviewRowId: rowId,
      action: "create",
      createTeams: [
        { sourceName: "  Padres  ", location: " San Diego ", name: " Padres " },
        { sourceName: "Aztecs", name: "San Diego State Aztecs baseball" },
      ],
    });

    const row = await t.run(async (ctx) => ctx.db.get(rowId));
    expect(row!.decision).toEqual({
      action: "create",
      createTeams: [
        { sourceName: "Padres", location: "San Diego", name: "Padres" },
        { sourceName: "Aztecs", name: "San Diego State Aztecs baseball" },
      ],
    });
  });

  test("dedupes by sourceName, keeping the first — commit looks the list up by that key", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const rowId = await seedPlayerRow(t);

    await asAdmin.mutation(api.entityReviewQueue.recordDecision, {
      reviewRowId: rowId,
      action: "create",
      createTeams: [
        { sourceName: "Padres", location: "San Diego", name: "Padres" },
        { sourceName: "PADRES", location: "Wrong", name: "Padres" },
      ],
    });

    const row = await t.run(async (ctx) => ctx.db.get(rowId));
    expect(
      (row!.decision as { createTeams: unknown[] }).createTeams,
    ).toEqual([{ sourceName: "Padres", location: "San Diego", name: "Padres" }]);
  });

  test("refuses a blank sourceName — it can never match a career-team label", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const rowId = await seedPlayerRow(t);

    await expect(
      asAdmin.mutation(api.entityReviewQueue.recordDecision, {
        reviewRowId: rowId,
        action: "create",
        createTeams: [{ sourceName: "   ", name: "Padres" }],
      }),
    ).rejects.toThrow(/Career-team source name cannot be empty/);
  });

  test("refuses an over-length list rather than truncating it", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const rowId = await seedPlayerRow(t);

    await expect(
      asAdmin.mutation(api.entityReviewQueue.recordDecision, {
        reviewRowId: rowId,
        action: "create",
        createTeams: Array.from({ length: 65 }, (_, i) => ({
          sourceName: `Team ${i}`,
          name: `Team ${i}`,
        })),
      }),
    ).rejects.toThrow(/the maximum is 64/);
  });

  test("an old-shaped create decision (no pairs at all) still records", async () => {
    // Every field is optional so a queue row written before NEO-236 — and a
    // client that has not shipped the new fields yet — stays valid.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const rowId = await seedPlayerRow(t);

    await asAdmin.mutation(api.entityReviewQueue.recordDecision, {
      reviewRowId: rowId,
      action: "create",
    });

    const row = await t.run(async (ctx) => ctx.db.get(rowId));
    expect(row!.decision).toEqual({ action: "create" });
  });
});

describe("recordAllRemainingAsCreate — NEO-236 team pre-fill", () => {
  test("splits a team row on an ESPN location that is a whole-word prefix", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const selectorOptionId = await seedSelectorOption(t);
    const rowId = await insertRow(t, {
      selectorOptionId,
      sportId: selectorOptionId,
      batchId: "b1",
      kind: "team",
      name: "San Diego Padres",
      status: "ready",
      enrichment: { location: "San Diego" },
    });

    await asAdmin.mutation(api.entityReviewQueue.recordAllRemainingAsCreate, {
      selectorOptionId,
      batchId: "b1",
    });

    const row = await t.run(async (ctx) => ctx.db.get(rowId));
    // Exactly what the wizard would have pre-filled and the operator would
    // have confirmed unedited — "confirm one row" and "confirm the batch" must
    // mean the same thing.
    expect(row!.decision).toEqual({
      action: "create",
      create: { location: "San Diego", name: "Padres" },
    });
  });

  test("leaves the whole name intact when the location is not a prefix", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const selectorOptionId = await seedSelectorOption(t);
    const rowId = await insertRow(t, {
      selectorOptionId,
      sportId: selectorOptionId,
      batchId: "b1",
      kind: "team",
      name: "Los Angeles Angels",
      status: "ready",
      // Where the franchise plays, not the front of its name.
      enrichment: { location: "Anaheim" },
    });

    await asAdmin.mutation(api.entityReviewQueue.recordAllRemainingAsCreate, {
      selectorOptionId,
      batchId: "b1",
    });

    const row = await t.run(async (ctx) => ctx.db.get(rowId));
    expect(row!.decision).toEqual({
      action: "create",
      create: { name: "Los Angeles Angels" },
    });
  });

  test("a team row with no enrichment at all gets the whole name and no location", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const selectorOptionId = await seedSelectorOption(t);
    const rowId = await insertRow(t, {
      selectorOptionId,
      sportId: selectorOptionId,
      batchId: "b1",
      kind: "team",
      name: "Orix Buffaloes",
      status: "pending",
    });

    await asAdmin.mutation(api.entityReviewQueue.recordAllRemainingAsCreate, {
      selectorOptionId,
      batchId: "b1",
    });

    const row = await t.run(async (ctx) => ctx.db.get(rowId));
    expect(row!.decision).toEqual({
      action: "create",
      create: { name: "Orix Buffaloes" },
    });
  });

  test("a player row is untouched by the pre-fill", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const selectorOptionId = await seedSelectorOption(t);
    const rowId = await insertRow(t, {
      selectorOptionId,
      sportId: selectorOptionId,
      batchId: "b1",
      kind: "player",
      name: "Mike Trout",
      status: "ready",
    });

    await asAdmin.mutation(api.entityReviewQueue.recordAllRemainingAsCreate, {
      selectorOptionId,
      batchId: "b1",
    });

    const row = await t.run(async (ctx) => ctx.db.get(rowId));
    expect(row!.decision).toEqual({ action: "create" });
  });

  test("bulk SKIP carries no create payload on a team row", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const selectorOptionId = await seedSelectorOption(t);
    const rowId = await insertRow(t, {
      selectorOptionId,
      sportId: selectorOptionId,
      batchId: "b1",
      kind: "team",
      name: "CHECKLIST",
      status: "ready",
      enrichment: { location: "CHECKLIST" },
    });

    await asAdmin.mutation(api.entityReviewQueue.recordAllRemainingAsSkip, {
      selectorOptionId,
      batchId: "b1",
    });

    const row = await t.run(async (ctx) => ctx.db.get(rowId));
    expect(row!.decision).toEqual({ action: "skip" });
  });
});
