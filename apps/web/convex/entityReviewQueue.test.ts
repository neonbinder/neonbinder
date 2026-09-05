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

/**
 * NEO-99: the "module:function" names of the currently-scheduled functions,
 * used to assert startBatch queued the Wikidata pool enqueue WITHOUT running it
 * (running it would reach `wikidataPool.enqueueAction`, which convex-test cannot
 * mount). Same technique as convex/placeholderWarmup.test.ts.
 */
const ENQUEUE_FN = "wikidataPool:enqueueEntityReviewLookups";

/**
 * NEO-221: the ARGUMENTS of every scheduled pool enqueue, in schedule order.
 * The resume path has to prove it enqueues the rows it ADDED and nothing else,
 * which the function name alone cannot show.
 */
async function scheduledEnqueueArgs(
  t: ReturnType<typeof convexTest>,
): Promise<Array<{ rowIds: Array<Id<"entityReviewQueue">> }>> {
  return t.run(async (ctx) => {
    const rows = await (
      ctx as unknown as {
        db: {
          system: {
            query: (n: string) => {
              collect: () => Promise<
                Array<{
                  name: string;
                  args: Array<{ rowIds: Array<Id<"entityReviewQueue">> }>;
                }>
              >;
            };
          };
        };
      }
    ).db.system.query("_scheduled_functions").collect();
    return rows.filter((r) => r.name === ENQUEUE_FN).map((r) => r.args[0]);
  });
}

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

  test("resumes an in-progress batch instead of deleting/recreating it, keeping decisions on the names that are still there", async () => {
    // NEO-221 changed what "resume" does to the batch's CONTENTS (it now
    // reconciles against the incoming names — see the tests below), but not
    // the property this one has always been about: the batchId is preserved
    // and a decision the operator already made is never discarded.
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

    const secondBatchId = await t.mutation(internal.entityReviewQueue.startBatch, {
      selectorOptionId,
      createdByUserId: "user_review_001",
      sportId: selectorOptionId,
      playerNames: ["Mike Trout"],
      teamNames: [],
    });

    expect(secondBatchId).toBe(firstBatchId);

    const rowsAfter = await asAdmin.query(api.entityReviewQueue.getBatch, {
      selectorOptionId,
      batchId: firstBatchId,
    });
    // One row, the SAME row: the decision, not just the name, survived.
    expect(rowsAfter).toHaveLength(1);
    expect(rowsAfter[0]._id).toBe(firstRows[0]._id);
    expect(rowsAfter[0].name).toBe("Mike Trout");
    expect(rowsAfter[0].decision).toEqual({ action: "create" });
  });

  // =========================================================================
  // NEO-221 — resume RECONCILES the batch against the incoming names
  //
  // "Touch nothing" was right while the only way back into a resumed batch was
  // an identical re-fetch. NEO-220's "Back to matching" makes a second Confirm
  // with a DIFFERENT name set a normal thing to do, and a frozen batch would
  // then ask about names no card carries while never asking about the new
  // ones — leaving a real name with no decision, which is the failure the
  // whole ticket exists to remove.
  // =========================================================================

  test("resume INSERTS a row for an incoming name the batch does not have, and schedules a lookup for it", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const selectorOptionId = await seedSelectorOption(t);

    const batchId = await t.mutation(internal.entityReviewQueue.startBatch, {
      selectorOptionId,
      createdByUserId: "user_review_001",
      sportId: selectorOptionId,
      playerNames: ["Mike Trout"],
      teamNames: [],
    });
    // Settle the first row so the enqueue asserted below cannot be confused
    // for a re-run of the original name's lookup.
    const [first] = await asAdmin.query(api.entityReviewQueue.getBatch, {
      selectorOptionId,
      batchId,
    });
    await t.mutation(internal.entityReviewQueue.applyLookupResult, {
      id: first._id,
      status: "ready",
    });

    const resumed = await t.mutation(internal.entityReviewQueue.startBatch, {
      selectorOptionId,
      createdByUserId: "user_review_001",
      sportId: selectorOptionId,
      playerNames: ["Mike Trout", "Aaron Judge"],
      teamNames: ["New York Yankees"],
    });
    expect(resumed).toBe(batchId);

    const rows = await asAdmin.query(api.entityReviewQueue.getBatch, {
      selectorOptionId,
      batchId,
    });
    expect(rows.map((r) => r.name).sort()).toEqual([
      "Aaron Judge",
      "Mike Trout",
      "New York Yankees",
    ]);
    // The pre-existing row is the SAME row, still carrying the resolved status
    // its lookup wrote — reconciliation never re-runs settled work.
    expect(rows.find((r) => r.name === "Mike Trout")!._id).toBe(first._id);
    expect(rows.find((r) => r.name === "Mike Trout")!.status).toBe("ready");
    expect(rows.find((r) => r.name === "Aaron Judge")!.status).toBe("pending");
    expect(rows.find((r) => r.name === "New York Yankees")!.kind).toBe("team");
  });

  test("resume schedules the pool enqueue for the ADDED rows only", async () => {
    // The load-bearing half of the insert above: a resume must not re-enqueue
    // a lookup that has already run. Asserted through the scheduled call's
    // ARGUMENTS — the enqueue itself reaches the workpool component and cannot
    // run under convex-test.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const selectorOptionId = await seedSelectorOption(t);

    const batchId = await t.mutation(internal.entityReviewQueue.startBatch, {
      selectorOptionId,
      createdByUserId: "user_review_001",
      sportId: selectorOptionId,
      playerNames: ["Mike Trout"],
      teamNames: [],
    });
    const [first] = await asAdmin.query(api.entityReviewQueue.getBatch, {
      selectorOptionId,
      batchId,
    });

    await t.mutation(internal.entityReviewQueue.startBatch, {
      selectorOptionId,
      createdByUserId: "user_review_001",
      sportId: selectorOptionId,
      playerNames: ["Mike Trout", "Aaron Judge"],
      teamNames: [],
    });

    const rows = await asAdmin.query(api.entityReviewQueue.getBatch, {
      selectorOptionId,
      batchId,
    });
    const addedId = rows.find((r) => r.name === "Aaron Judge")!._id;

    const enqueues = await scheduledEnqueueArgs(t);
    // Two enqueues total: the original startBatch's, and the resume's.
    expect(enqueues).toHaveLength(2);
    expect(enqueues[0].rowIds).toEqual([first._id]);
    expect(enqueues[1].rowIds).toEqual([addedId]);
  });

  test("resume drops an UNDECIDED row whose name is no longer incoming", async () => {
    // An undecided row for a name no card carries is a question about nothing,
    // and the wizard's "all reviewed" would block on it forever.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const selectorOptionId = await seedSelectorOption(t);

    const batchId = await t.mutation(internal.entityReviewQueue.startBatch, {
      selectorOptionId,
      createdByUserId: "user_review_001",
      sportId: selectorOptionId,
      playerNames: ["Mike Trout", "Gone Forever"],
      teamNames: [],
    });

    await t.mutation(internal.entityReviewQueue.startBatch, {
      selectorOptionId,
      createdByUserId: "user_review_001",
      sportId: selectorOptionId,
      playerNames: ["Mike Trout"],
      teamNames: [],
    });

    const after = await asAdmin.query(api.entityReviewQueue.getBatch, {
      selectorOptionId,
      batchId,
    });
    expect(after.map((r) => r.name)).toEqual(["Mike Trout"]);
  });

  test("resume KEEPS a DECIDED row even when its name is no longer incoming", async () => {
    // Reconciliation is additive about the operator's work. The incoming name
    // list is derived — from a marketplace payload, through a pairing session
    // the operator can still change their mind about — so "not in the list any
    // more" is a statement about that derivation, not evidence the human's
    // ruling was wrong. Deleting on it would let a re-pair silently discard a
    // decision, and the only clue would be a name they have to rule on twice.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const selectorOptionId = await seedSelectorOption(t);

    const batchId = await t.mutation(internal.entityReviewQueue.startBatch, {
      selectorOptionId,
      createdByUserId: "user_review_001",
      sportId: selectorOptionId,
      playerNames: ["Mike Trout", "Ruled On"],
      teamNames: [],
    });
    const before = await asAdmin.query(api.entityReviewQueue.getBatch, {
      selectorOptionId,
      batchId,
    });
    const decidedId = before.find((r) => r.name === "Ruled On")!._id;
    await asAdmin.mutation(api.entityReviewQueue.recordDecision, {
      reviewRowId: decidedId,
      action: "create",
    });

    await t.mutation(internal.entityReviewQueue.startBatch, {
      selectorOptionId,
      createdByUserId: "user_review_001",
      sportId: selectorOptionId,
      playerNames: ["Mike Trout"],
      teamNames: [],
    });

    const after = await asAdmin.query(api.entityReviewQueue.getBatch, {
      selectorOptionId,
      batchId,
    });
    expect(after.map((r) => r.name).sort()).toEqual(["Mike Trout", "Ruled On"]);
    expect(after.find((r) => r._id === decidedId)!.decision).toEqual({
      action: "create",
    });
  });

  test("resume stamps lastTouchedAt on every surviving row — re-entering a batch is proof of life", async () => {
    // What keeps the abandoned-batch sweep off a session an operator has just
    // come back to. Without it, a batch created 25 hours ago and resumed a
    // second ago would still read as abandoned.
    const t = convexTest(schema, modules);
    const selectorOptionId = await seedSelectorOption(t);

    await t.mutation(internal.entityReviewQueue.startBatch, {
      selectorOptionId,
      createdByUserId: "user_review_001",
      sportId: selectorOptionId,
      playerNames: ["Mike Trout"],
      teamNames: [],
    });
    const before = await t.run(async (ctx) =>
      ctx.db.query("entityReviewQueue").collect(),
    );
    expect(before[0].lastTouchedAt).toBeUndefined();

    await t.mutation(internal.entityReviewQueue.startBatch, {
      selectorOptionId,
      createdByUserId: "user_review_001",
      sportId: selectorOptionId,
      playerNames: ["Mike Trout"],
      teamNames: [],
    });

    const after = await t.run(async (ctx) =>
      ctx.db.query("entityReviewQueue").collect(),
    );
    expect(after[0].lastTouchedAt).toBeGreaterThan(0);
  });

  test("resume matches on the NORMALIZED name, so a re-spelling is not an add plus a drop", async () => {
    // The names come off marketplace payloads, which respell freely. Keyed on
    // the raw string, "J.T. Realmuto" → "JT Realmuto" would delete the row the
    // operator just decided and ask again under a new id.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const selectorOptionId = await seedSelectorOption(t);

    const batchId = await t.mutation(internal.entityReviewQueue.startBatch, {
      selectorOptionId,
      createdByUserId: "user_review_001",
      sportId: selectorOptionId,
      playerNames: ["J.T. Realmuto"],
      teamNames: [],
    });
    const [row] = await asAdmin.query(api.entityReviewQueue.getBatch, {
      selectorOptionId,
      batchId,
    });
    await asAdmin.mutation(api.entityReviewQueue.recordDecision, {
      reviewRowId: row._id,
      action: "skip",
    });

    await t.mutation(internal.entityReviewQueue.startBatch, {
      selectorOptionId,
      createdByUserId: "user_review_001",
      sportId: selectorOptionId,
      playerNames: ["JT Realmuto"],
      teamNames: [],
    });

    const after = await asAdmin.query(api.entityReviewQueue.getBatch, {
      selectorOptionId,
      batchId,
    });
    expect(after).toHaveLength(1);
    expect(after[0]._id).toBe(row._id);
    // The original spelling is kept — the row is the operator's, not the
    // payload's, and its decision survived.
    expect(after[0].name).toBe("J.T. Realmuto");
    expect(after[0].decision).toEqual({ action: "skip" });
  });

  test("a player and a team sharing a name are reconciled separately", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const selectorOptionId = await seedSelectorOption(t);

    const batchId = await t.mutation(internal.entityReviewQueue.startBatch, {
      selectorOptionId,
      createdByUserId: "user_review_001",
      sportId: selectorOptionId,
      playerNames: ["Jackson"],
      teamNames: ["Jackson"],
    });

    await t.mutation(internal.entityReviewQueue.startBatch, {
      selectorOptionId,
      createdByUserId: "user_review_001",
      sportId: selectorOptionId,
      playerNames: ["Jackson"],
      teamNames: [],
    });

    const after = await asAdmin.query(api.entityReviewQueue.getBatch, {
      selectorOptionId,
      batchId,
    });
    // The team row went; the player row of the same name stayed.
    expect(after).toHaveLength(1);
    expect(after[0].kind).toBe("player");
  });

  test("resume with an unchanged name set inserts nothing and schedules nothing", async () => {
    const t = convexTest(schema, modules);
    const selectorOptionId = await seedSelectorOption(t);

    await t.mutation(internal.entityReviewQueue.startBatch, {
      selectorOptionId,
      createdByUserId: "user_review_001",
      sportId: selectorOptionId,
      playerNames: ["Mike Trout"],
      teamNames: ["New York Yankees"],
    });
    await t.mutation(internal.entityReviewQueue.startBatch, {
      selectorOptionId,
      createdByUserId: "user_review_001",
      sportId: selectorOptionId,
      playerNames: ["Mike Trout"],
      teamNames: ["New York Yankees"],
    });

    // Still exactly one enqueue: the original one. The common resume (a plain
    // page refresh) must stay as cheap as it was before reconciliation.
    expect(await scheduledEnqueueArgs(t)).toHaveLength(1);
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
// The load-bearing property: this mutation decides every undecided SETTLED row
// in one transaction.
//
// NEO-221 changed the second half of that sentence. It used to decide rows
// whose Wikidata lookup was still in flight too; it now skips them. Deciding a
// `pending` row "create" throws its enrichment away — commit seeds the new
// player/team from `enrichment`, and `enqueueEnrichment` is creation-only, so
// there is no path back — which meant one bulk tap could mint dozens of
// permanently bare rows for players Wikidata knows perfectly well. The wizard
// re-calls this as lookups land, which is why the return value (rows decided
// by THIS call) matters more than it used to.
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

  test("NEO-221: SKIPS rows still 'pending' — deciding one would throw its enrichment away", async () => {
    // The exact CI shape from NEO-110: one lookup had resolved, two were still
    // pending. That run's complaint was that the wizard read "1 of 3
    // reviewed"; NEO-221's answer is that 1 of 3 is the HONEST count, because
    // the other two have no enrichment to create from yet.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const selectorOptionId = await seedSelectorOption(t);

    const readyId = await insertRow(t, {
      selectorOptionId,
      sportId: selectorOptionId, batchId: "bulk", kind: "player", name: "KOPlayer", status: "ready",
    });
    const pendingA = await insertRow(t, {
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

    expect(count).toBe(1);
    const rows = await asAdmin.query(api.entityReviewQueue.getBatch, {
      selectorOptionId,
      batchId: "bulk",
    });
    expect(rows.find((r) => r._id === readyId)!.decision).toEqual({
      action: "create",
    });
    expect(rows.find((r) => r._id === pendingA)!.decision).toBeUndefined();
  });

  test("NEO-221: a re-call after a lookup lands decides the row that just settled", async () => {
    // The wizard drives this loop — one operator tap, the count filling in as
    // the pool drains — so a second call finding newly-settled work is the
    // normal path, not a retry.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const selectorOptionId = await seedSelectorOption(t);

    const lateId = await insertRow(t, {
      selectorOptionId,
      sportId: selectorOptionId, batchId: "bulk", kind: "player", name: "LateLookup", status: "pending",
    });

    expect(
      await asAdmin.mutation(api.entityReviewQueue.recordAllRemainingAsCreate, {
        selectorOptionId,
        batchId: "bulk",
      }),
    ).toBe(0);

    await t.mutation(internal.entityReviewQueue.applyLookupResult, {
      id: lateId,
      status: "ready",
      enrichment: { wikidataId: "Q1" },
    });

    expect(
      await asAdmin.mutation(api.entityReviewQueue.recordAllRemainingAsCreate, {
        selectorOptionId,
        batchId: "bulk",
      }),
    ).toBe(1);
    // The enrichment the wait was for is on the row commit will read.
    const row = await t.run(async (ctx) => ctx.db.get(lateId));
    expect(row!.decision).toEqual({ action: "create" });
    expect(row!.enrichment?.wikidataId).toBe("Q1");
  });

  test("an 'error' row is decided — a lookup that failed is settled, not in flight", async () => {
    // `status` is the wait condition, and "error" means the lookup has been
    // and gone with nothing to show. Blocking on it would hang the fast path
    // on every name Wikidata does not know, which is most of a rookie class.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const selectorOptionId = await seedSelectorOption(t);

    await insertRow(t, {
      selectorOptionId,
      sportId: selectorOptionId, batchId: "bulk", kind: "player", name: "NoWikidataMatch", status: "error",
    });

    expect(
      await asAdmin.mutation(api.entityReviewQueue.recordAllRemainingAsCreate, {
        selectorOptionId,
        batchId: "bulk",
      }),
    ).toBe(1);
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
    //
    // Driven through the SKIP fast path since NEO-221, because that is now the
    // only bulk path that decides a row whose lookup is still in flight — and
    // the guarantee is about the SHAPE (decided + pending), not about which
    // decision produced it. The shape is still reachable, so it is still worth
    // pinning: a straggler lookup landing on a decided row during the commit
    // prelude's read is exactly what turned a seed job red.
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

    await asAdmin.mutation(api.entityReviewQueue.recordAllRemainingAsSkip, {
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
// clearDecision (NEO-221)
//
// The other half of "an operator can change their mind". `recordDecision`
// already overwrites, which covers "I meant link, not create"; this puts a row
// back to being an open question, which is what the wizard's Back / decided
// list needs — the review UI only ever presents an UNDECIDED row.
// ===========================================================================

describe("clearDecision", () => {
  test("removes the decision and leaves the row otherwise untouched", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const selectorOptionId = await seedSelectorOption(t);

    const rowId = await insertRow(t, {
      selectorOptionId,
      sportId: selectorOptionId,
      batchId: "b",
      kind: "player",
      name: "Mike Trout",
      status: "ready",
    });
    await t.run(async (ctx) =>
      ctx.db.patch(rowId, { enrichment: { wikidataId: "Q123" } }),
    );
    await asAdmin.mutation(api.entityReviewQueue.recordDecision, {
      reviewRowId: rowId,
      action: "create",
    });

    await asAdmin.mutation(api.entityReviewQueue.clearDecision, {
      reviewRowId: rowId,
    });

    const row = await t.run(async (ctx) => ctx.db.get(rowId));
    // Byte-identical to a row that was never decided: `undefined` in a patch
    // is how Convex removes a field.
    expect(row!.decision).toBeUndefined();
    // A settled lookup stays settled — re-deciding must not cost a second
    // Wikidata round-trip.
    expect(row!.status).toBe("ready");
    expect(row!.enrichment?.wikidataId).toBe("Q123");
    expect(row!.lastTouchedAt).toBeGreaterThan(0);
    // Nothing re-enqueued: the row already has its answer.
    expect(await scheduledEnqueueArgs(t)).toHaveLength(0);
  });

  test("re-schedules the lookup when the row is still 'pending'", async () => {
    // A row decided while its lookup was in flight had that result dropped on
    // the floor (`applyLookupResult` skips a decided row, NEO-189), so it is
    // `pending` and will never leave `pending` on its own. Un-deciding it
    // without re-enqueuing would hand the operator a row stuck on
    // "Looking up…" forever.
    //
    // This is a LOOKUP, not entity enrichment: nothing here touches
    // players/teams, and the creation-only enrichment rule is about those.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const selectorOptionId = await seedSelectorOption(t);

    const rowId = await insertRow(t, {
      selectorOptionId,
      sportId: selectorOptionId,
      batchId: "b",
      kind: "player",
      name: "StillLookingUp",
      status: "pending",
    });
    // Only the bulk SKIP path can decide a pending row since NEO-221, which is
    // exactly how this state is reached in the wild.
    await asAdmin.mutation(api.entityReviewQueue.recordAllRemainingAsSkip, {
      selectorOptionId,
      batchId: "b",
    });

    await asAdmin.mutation(api.entityReviewQueue.clearDecision, {
      reviewRowId: rowId,
    });

    const enqueues = await scheduledEnqueueArgs(t);
    expect(enqueues).toHaveLength(1);
    expect(enqueues[0].rowIds).toEqual([rowId]);
  });

  test("does NOT re-schedule a lookup for a row that already errored", async () => {
    // "error" means the lookup has been and gone with nothing to show. The
    // row is answerable as it stands, so re-running it would only spend a
    // Wikidata request to reach the same place.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const selectorOptionId = await seedSelectorOption(t);

    const rowId = await insertRow(t, {
      selectorOptionId,
      sportId: selectorOptionId,
      batchId: "b",
      kind: "player",
      name: "NoMatch",
      status: "error",
    });
    await asAdmin.mutation(api.entityReviewQueue.recordDecision, {
      reviewRowId: rowId,
      action: "skip",
    });

    await asAdmin.mutation(api.entityReviewQueue.clearDecision, {
      reviewRowId: rowId,
    });

    expect(await scheduledEnqueueArgs(t)).toHaveLength(0);
  });

  test("throws on a row that no longer exists", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const selectorOptionId = await seedSelectorOption(t);

    const rowId = await insertRow(t, {
      selectorOptionId,
      sportId: selectorOptionId,
      batchId: "b",
      kind: "player",
      name: "Doomed",
    });
    await t.run(async (ctx) => ctx.db.delete(rowId));

    await expect(
      asAdmin.mutation(api.entityReviewQueue.clearDecision, {
        reviewRowId: rowId,
      }),
    ).rejects.toThrow(/Review row not found/);
  });

  test("requires admin, and leaves the decision standing when it refuses", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const selectorOptionId = await seedSelectorOption(t);

    const rowId = await insertRow(t, {
      selectorOptionId,
      sportId: selectorOptionId,
      batchId: "b",
      kind: "player",
      name: "Mike Trout",
      status: "ready",
    });
    await asAdmin.mutation(api.entityReviewQueue.recordDecision, {
      reviewRowId: rowId,
      action: "create",
    });

    await expect(
      t.mutation(api.entityReviewQueue.clearDecision, { reviewRowId: rowId }),
    ).rejects.toThrow();
    expect(
      (await t.run(async (ctx) => ctx.db.get(rowId)))!.decision,
    ).toEqual({ action: "create" });
  });
});

// ===========================================================================
// Per-session ownership (NEO-221)
//
// Batches are scoped per user on purpose (see startBatch and schema.ts): two
// admin sessions — or two Maestro CI workers, each a distinct admin test
// account — hold separate batches over the SAME set at once. `requireAdmin` is
// the real gate; these are the second layer, and they exist because a row id
// or batchId from the wrong session is far likelier to be a stale client than
// an attack, and either way silently overwriting a colleague's in-progress
// review is the wrong answer.
// ===========================================================================

describe("ownership scoping", () => {
  const OTHER_ADMIN = {
    subject: "user_review_002",
    issuer: "https://clerk.example.com",
    tokenIdentifier: "clerk|user_review_002",
    role: "admin",
  };

  test("recordDecision refuses a row from another admin's session", async () => {
    const t = convexTest(schema, modules);
    const selectorOptionId = await seedSelectorOption(t);
    // insertRow stamps createdByUserId "user_review_001" — ADMIN_IDENTITY.
    const rowId = await insertRow(t, {
      selectorOptionId,
      sportId: selectorOptionId,
      batchId: "b",
      kind: "player",
      name: "Mike Trout",
      status: "ready",
    });

    await expect(
      t.withIdentity(OTHER_ADMIN).mutation(api.entityReviewQueue.recordDecision, {
        reviewRowId: rowId,
        action: "create",
      }),
    ).rejects.toThrow(/different review session/);
    expect(
      (await t.run(async (ctx) => ctx.db.get(rowId)))!.decision,
    ).toBeUndefined();
  });

  test("clearDecision refuses a row from another admin's session", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const selectorOptionId = await seedSelectorOption(t);
    const rowId = await insertRow(t, {
      selectorOptionId,
      sportId: selectorOptionId,
      batchId: "b",
      kind: "player",
      name: "Mike Trout",
      status: "ready",
    });
    await asAdmin.mutation(api.entityReviewQueue.recordDecision, {
      reviewRowId: rowId,
      action: "create",
    });

    await expect(
      t.withIdentity(OTHER_ADMIN).mutation(api.entityReviewQueue.clearDecision, {
        reviewRowId: rowId,
      }),
    ).rejects.toThrow(/different review session/);
    expect(
      (await t.run(async (ctx) => ctx.db.get(rowId)))!.decision,
    ).toEqual({ action: "create" });
  });

  test.each([
    ["recordAllRemainingAsCreate", api.entityReviewQueue.recordAllRemainingAsCreate],
    ["recordAllRemainingAsSkip", api.entityReviewQueue.recordAllRemainingAsSkip],
  ] as const)(
    "%s refuses another admin's batch WITHOUT deciding anything",
    async (_name, fn) => {
      // Matters more here than on the single-row calls: ONE call rules on
      // every open row in the batch, so a stale batchId from another session
      // would decide a colleague's entire review in a single mutation.
      const t = convexTest(schema, modules);
      const selectorOptionId = await seedSelectorOption(t);
      for (const name of ["A", "B"])
        await insertRow(t, {
          selectorOptionId,
          sportId: selectorOptionId,
          batchId: "b",
          kind: "player",
          name,
          status: "ready",
        });

      await expect(
        t.withIdentity(OTHER_ADMIN).mutation(fn, {
          selectorOptionId,
          batchId: "b",
        }),
      ).rejects.toThrow(/different review session/);

      const rows = await t.run(async (ctx) =>
        ctx.db.query("entityReviewQueue").collect(),
      );
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.decision === undefined)).toBe(true);
    },
  );

  test("cancelBatch refuses another admin's batch WITHOUT deleting any of it", async () => {
    // Cancelling is the one irreversible thing an operator can do to a review,
    // so the check runs before the delete, not per row inside it.
    const t = convexTest(schema, modules);
    const selectorOptionId = await seedSelectorOption(t);
    for (const name of ["A", "B"])
      await insertRow(t, {
        selectorOptionId,
        sportId: selectorOptionId,
        batchId: "b",
        kind: "player",
        name,
        status: "ready",
      });

    await expect(
      t.withIdentity(OTHER_ADMIN).mutation(api.entityReviewQueue.cancelBatch, {
        selectorOptionId,
        batchId: "b",
      }),
    ).rejects.toThrow(/different review session/);
    expect(
      await t.run(async (ctx) =>
        ctx.db.query("entityReviewQueue").collect(),
      ),
    ).toHaveLength(2);
  });
});

// ===========================================================================
// The bulk fast paths do not take `includePending` from the client (NEO-221)
// ===========================================================================

describe("bulk fast paths: includePending is not a client argument", () => {
  test.each([
    ["recordAllRemainingAsCreate", api.entityReviewQueue.recordAllRemainingAsCreate],
    ["recordAllRemainingAsSkip", api.entityReviewQueue.recordAllRemainingAsSkip],
  ] as const)("%s rejects a client-supplied includePending", async (_name, fn) => {
    // Whether a `pending` row is in scope is a property of the DECISION being
    // written (create consumes the enrichment, skip does not), not a caller
    // preference — see `decideAllRemaining`. Pinned because the natural next
    // refactor is to lift the flag into the args, and that would hand a client
    // the ability to mint bare unenriched players in bulk.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const selectorOptionId = await seedSelectorOption(t);
    await insertRow(t, {
      selectorOptionId,
      sportId: selectorOptionId,
      batchId: "bulk",
      kind: "player",
      name: "StillLookingUp",
      status: "pending",
    });

    await expect(
      asAdmin.mutation(fn, {
        selectorOptionId,
        batchId: "bulk",
        includePending: true,
      } as unknown as { selectorOptionId: Id<"selectorOptions">; batchId: string }),
    ).rejects.toThrow();
  });
});

// ===========================================================================
// startBatch with an EMPTY incoming set (NEO-221)
//
// Reached through `resolveUnknownsAndStartBatch`, which now calls startBatch
// when a batch is already open even if this fetch surfaced no unknown names —
// the "Back to matching, re-pair until everything resolves, Confirm again"
// loop. Without the call the open batch is never read by commit and never
// deleted, and its rows resume themselves into the NEXT fetch of the set.
// ===========================================================================

describe("startBatch with no incoming names", () => {
  test("resolves an open batch down to its decided rows and returns its id", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const selectorOptionId = await seedSelectorOption(t);

    const batchId = await t.mutation(internal.entityReviewQueue.startBatch, {
      selectorOptionId,
      createdByUserId: "user_review_001",
      sportId: selectorOptionId,
      playerNames: ["Ruled On", "Never Ruled On"],
      teamNames: [],
    });
    const before = await asAdmin.query(api.entityReviewQueue.getBatch, {
      selectorOptionId,
      batchId,
    });
    const decidedId = before.find((r) => r.name === "Ruled On")!._id;
    await asAdmin.mutation(api.entityReviewQueue.recordDecision, {
      reviewRowId: decidedId,
      action: "create",
    });

    const resumed = await t.mutation(internal.entityReviewQueue.startBatch, {
      selectorOptionId,
      createdByUserId: "user_review_001",
      sportId: selectorOptionId,
      playerNames: [],
      teamNames: [],
    });

    // The id commit needs in order to consume and delete this batch.
    expect(resumed).toBe(batchId);
    const after = await asAdmin.query(api.entityReviewQueue.getBatch, {
      selectorOptionId,
      batchId,
    });
    // The open question is gone; the operator's ruling is not.
    expect(after.map((r) => r.name)).toEqual(["Ruled On"]);
    expect(after[0].decision).toEqual({ action: "create" });
  });

  test("empties a wholly-undecided batch without deleting the batch's identity", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const selectorOptionId = await seedSelectorOption(t);

    const batchId = await t.mutation(internal.entityReviewQueue.startBatch, {
      selectorOptionId,
      createdByUserId: "user_review_001",
      sportId: selectorOptionId,
      playerNames: ["A", "B"],
      teamNames: ["C"],
    });

    expect(
      await t.mutation(internal.entityReviewQueue.startBatch, {
        selectorOptionId,
        createdByUserId: "user_review_001",
        sportId: selectorOptionId,
        playerNames: [],
        teamNames: [],
      }),
    ).toBe(batchId);

    expect(
      await asAdmin.query(api.entityReviewQueue.getBatch, {
        selectorOptionId,
        batchId,
      }),
    ).toHaveLength(0);
  });
});

// ===========================================================================
// findOpenBatch (NEO-221)
// ===========================================================================

describe("findOpenBatch", () => {
  test("returns the open batch's id, or null when the pair has none", async () => {
    const t = convexTest(schema, modules);
    const selectorOptionId = await seedSelectorOption(t);

    expect(
      await t.query(internal.entityReviewQueue.findOpenBatch, {
        selectorOptionId,
        createdByUserId: "user_review_001",
      }),
    ).toBeNull();

    const batchId = await t.mutation(internal.entityReviewQueue.startBatch, {
      selectorOptionId,
      createdByUserId: "user_review_001",
      sportId: selectorOptionId,
      playerNames: ["Mike Trout"],
      teamNames: [],
    });

    expect(
      await t.query(internal.entityReviewQueue.findOpenBatch, {
        selectorOptionId,
        createdByUserId: "user_review_001",
      }),
    ).toBe(batchId);
    // Scoped per user, exactly as startBatch's own resume read is.
    expect(
      await t.query(internal.entityReviewQueue.findOpenBatch, {
        selectorOptionId,
        createdByUserId: "somebody_else",
      }),
    ).toBeNull();
  });
});
