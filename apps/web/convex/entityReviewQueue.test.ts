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
    sport?: string;
    status?: "pending" | "ready" | "error";
  },
) {
  return t.run(async (ctx) =>
    ctx.db.insert("entityReviewQueue", {
      selectorOptionId: opts.selectorOptionId,
      batchId: opts.batchId,
      kind: opts.kind,
      name: opts.name,
      sport: opts.sport ?? "Baseball",
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

    const batchId = await t.mutation(internal.entityReviewQueue.startBatch, {
      selectorOptionId,
      sport: "Baseball",
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
  });

  test("resumes an in-progress batch for the same selectorOptionId instead of deleting/recreating it", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const selectorOptionId = await seedSelectorOption(t);

    const firstBatchId = await t.mutation(internal.entityReviewQueue.startBatch, {
      selectorOptionId,
      sport: "Baseball",
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
      sport: "Baseball",
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
        sport: "Baseball",
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
      sport: "Baseball",
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
      batchId: "batch-a",
      kind: "player",
      name: "Row A1",
    });
    // Same selectorOption, DIFFERENT batch — must not leak into batch-a's results.
    await insertRow(t, {
      selectorOptionId: selectorOptionA,
      batchId: "batch-a2",
      kind: "player",
      name: "Row A2 (other batch)",
    });
    // Different selectorOption, SAME batchId string — must not leak either.
    await insertRow(t, {
      selectorOptionId: selectorOptionB,
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
      batchId: "b1",
      kind: "player",
      name: "Mike Trout",
    });
    const rowId2 = await insertRow(t, {
      selectorOptionId,
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
        primarySport: "Baseball",
        lastUpdated: Date.now(),
      }),
    );
    const rowId = await insertRow(t, {
      selectorOptionId,
      batchId: "b1",
      kind: "player",
      name: "Mike Trout Jr Typo",
      sport: "Baseball",
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
        sport: "Baseball",
        lastUpdated: Date.now(),
      }),
    );
    const rowId = await insertRow(t, {
      selectorOptionId,
      batchId: "b1",
      kind: "team",
      name: "LA Angels",
      sport: "Baseball",
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
    const wrongSportPlayerId = await t.run(async (ctx) =>
      ctx.db.insert("players", {
        name: "Some Football Player",
        nameNormalized: "football player some",
        primarySport: "Football",
        lastUpdated: Date.now(),
      }),
    );
    const rowId = await insertRow(t, {
      selectorOptionId,
      batchId: "b1",
      kind: "player",
      name: "Mike Trout",
      sport: "Baseball",
    });

    await expect(
      asAdmin.mutation(api.entityReviewQueue.recordDecision, {
        reviewRowId: rowId,
        action: "link",
        linkedPlayerId: wrongSportPlayerId,
      }),
    ).rejects.toThrow();
  });

  test("throws for an unauthenticated caller", async () => {
    const t = convexTest(schema, modules);
    const selectorOptionId = await seedSelectorOption(t);
    const rowId = await insertRow(t, {
      selectorOptionId,
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

describe("cancelBatch", () => {
  test("deletes every row for the batch and touches nothing else", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const selectorOptionId = await seedSelectorOption(t);

    await insertRow(t, { selectorOptionId, batchId: "cancel-me", kind: "player", name: "Mike Trout" });
    await insertRow(t, { selectorOptionId, batchId: "cancel-me", kind: "team", name: "Los Angeles Angels" });
    // A row in a DIFFERENT batch must survive.
    const otherBatchRowId = await insertRow(t, {
      selectorOptionId,
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
        primarySport: "Baseball",
        lastUpdated: 1_700_000_000_000,
      }),
    );
    const preexistingTeamId = await t.run(async (ctx) =>
      ctx.db.insert("teams", {
        name: "Existing Team",
        nameNormalized: "existing team",
        sport: "Baseball",
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

    await insertRow(t, { selectorOptionId, batchId: "done-batch", kind: "player", name: "Mike Trout" });
    await insertRow(t, { selectorOptionId, batchId: "done-batch", kind: "team", name: "Angels" });
    const otherBatchRowId = await insertRow(t, {
      selectorOptionId,
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
