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
 *     in-progress batch, schedules processEntityReviewQueue.
 *   - getBatch: scoped correctly by (selectorOptionId, batchId).
 *   - recordDecision: patches `decision` on exactly the targeted row.
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
 * `processEntityReviewQueue`'s own pop-front/reschedule pacing and
 * `lookupPlayerEnrichment`/`lookupTeamEnrichment`'s pure-lookup behavior are
 * covered separately in convex/wikidataEntityReviewQueue.test.ts (that file
 * needs real Wikidata-shaped SPARQL fetch fixtures; this one only needs to
 * prove startBatch's scheduling WIRING, not the queue's own draining
 * behavior).
 */

import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";
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
    }),
  );
}

// ===========================================================================
// startBatch
// ===========================================================================

describe("startBatch", () => {
  test("inserts one row per player/team name, all pending, sharing a fresh batchId", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const selectorOptionId = await seedSelectorOption(t);

    // startBatch schedules the background enrichment queue as a side effect.
    // The rows are asserted while still "pending" (that IS this test's point),
    // then the queue is drained in the finally so its SPARQL/ESPN fetches
    // cannot land inside a LATER test — one of which asserts nothing fetched
    // at all. Pre-existing leak; it only started failing once the sport row
    // carried real enrichment config for the lookups to act on.
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      (async () =>
        new Response(JSON.stringify({ results: { bindings: [] } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })) as unknown as typeof fetch,
    );
    try {
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

      await t.finishAllScheduledFunctions(vi.runAllTimers);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
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

    // startBatch schedules the background enrichment queue as a side effect.
    // Stub + drain it here so the SPARQL fetch cannot land during a LATER test
    // — the next test asserts that nothing fetched, and was failing on this
    // one's leaked scheduled action rather than on its own behaviour.
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      (async () =>
        new Response(JSON.stringify({ results: { bindings: [] } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })) as unknown as typeof fetch,
    );
    try {
      const batchId = await t.mutation(internal.entityReviewQueue.startBatch, {
        selectorOptionId,
        createdByUserId: "user_review_001",
        sportId: selectorOptionId,
        playerNames: ["Mike Trout"],
        teamNames: [],
      });
      await t.finishAllScheduledFunctions(vi.runAllTimers);

      const rows = await asAdmin.query(api.entityReviewQueue.getBatch, {
        selectorOptionId,
        batchId,
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).not.toHaveProperty("createdByUserId");
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  test("schedules processEntityReviewQueue for a non-empty name list (rows eventually leave 'pending')", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const selectorOptionId = await seedSelectorOption(t);

    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      (async () =>
        new Response(JSON.stringify({ results: { bindings: [] } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })) as unknown as typeof fetch,
    );

    try {
      const batchId = await t.mutation(internal.entityReviewQueue.startBatch, {
        selectorOptionId,
        createdByUserId: "user_review_001",
        sportId: selectorOptionId,
        playerNames: ["Mike Trout"],
        teamNames: [],
      });
      await t.finishAllScheduledFunctions(vi.runAllTimers);

      const rows = await asAdmin.query(api.entityReviewQueue.getBatch, {
        selectorOptionId,
        batchId,
      });
      // No Wikidata match (empty bindings) -> "error", not "pending" — proves
      // the scheduled queue actually ran, not just that the row exists.
      expect(rows[0].status).toBe("error");
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  test("an empty name list produces no rows and returns a batchId without scheduling anything", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const selectorOptionId = await seedSelectorOption(t);

    let fetchCalled = false;
    vi.stubGlobal(
      "fetch",
      (async () => {
        fetchCalled = true;
        throw new Error("fetch must not be called — nothing was scheduled");
      }) as unknown as typeof fetch,
    );

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
    expect(fetchCalled).toBe(false);
    vi.unstubAllGlobals();
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
    // applyLookupResult patches only status/enrichment. Locked in because the
    // NEO-110 investigation's first hypothesis was that this write clobbered
    // `decision` on rows that were pending at bulk-decide time.
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
    expect(rows.every((r) => r.status === "ready")).toBe(true);
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
