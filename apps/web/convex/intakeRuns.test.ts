/**
 * NEO-379 — intake runs and the server-side matcher, end to end in
 * convex-test: a run over a placeholder job, pairs matched in the run's
 * variant as they change, a collector's pick that no sync overwrites, repeats
 * flagged, and every public function refusing another collector's run.
 *
 * The matching rules themselves are pinned in `lib/intakeMatch.test.ts`.
 */

import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { drainScheduled } from "../lib/testing/drain-scheduled";
import { seedCollectionCatalog } from "../lib/testing/collection-fixture";
import { noteIntakePairsChanged } from "./intakeRuns";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ME = { subject: "user_intakeMe0001" };
const THEM = { subject: "user_intakeThem002" };
const JOB = "job-intake-1";

let harnesses: Array<ReturnType<typeof convexTest>> = [];
afterEach(async () => {
  for (const t of harnesses) await drainScheduled(t);
  harnesses = [];
});

interface Scan {
  number?: string;
  players?: string[];
}

/**
 * A finished placeholder job of ME's with one manual pair per scan (front at
 * 2i, back at 2i+1), the catalog fixture, and a box of ME's.
 */
async function world(scans: Scan[]) {
  const t = convexTest(schema, modules);
  harnesses.push(t);
  const fx = await seedCollectionCatalog(t);
  const ids = await t.run(async (ctx) => {
    await ctx.db.insert("placeholderJobs", {
      jobId: JOB,
      userId: ME.subject,
      objectPath: `placeholders/${ME.subject}/${JOB}/`,
      createdAt: 0,
      mode: "stream",
      status: "succeeded",
    });
    const pairIds: Id<"placeholderPairs">[] = [];
    for (const [i, scan] of scans.entries()) {
      for (const [k, side] of (["front", "back"] as const).entries()) {
        await ctx.db.insert("placeholderImages", {
          jobId: JOB,
          userId: ME.subject,
          entryIndex: 2 * i + k,
          originalName: `scan-${i}-${side}.jpg`,
          status: "done",
          side,
          players: side === "front" ? scan.players : undefined,
          cardNumber: side === "back" ? scan.number : undefined,
          pairStatus: "paired",
        });
      }
      pairIds.push(
        await ctx.db.insert("placeholderPairs", {
          jobId: JOB,
          userId: ME.subject,
          frontIndex: 2 * i,
          backIndex: 2 * i + 1,
          player: scan.players?.[0],
          cardNumber: scan.number,
          confidence: "side-only",
          mechanism: "manual",
          score: 0,
        }),
      );
    }
    const boxId = await ctx.db.insert("collectionContainers", {
      ownerId: ME.subject,
      kind: "box",
      name: "For sale",
      lastUpdated: 0,
    });
    const theirBoxId = await ctx.db.insert("collectionContainers", {
      ownerId: THEM.subject,
      kind: "box",
      name: "Their box",
      lastUpdated: 0,
    });
    return { pairIds, boxId, theirBoxId };
  });
  return { t, fx, ...ids, me: t.withIdentity(ME), them: t.withIdentity(THEM) };
}

async function startRun(
  w: Awaited<ReturnType<typeof world>>,
  variantId?: Id<"selectorOptions">,
) {
  const runId = await w.me.mutation(api.intakeRuns.createIntakeRun, {
    jobId: JOB,
    homeId: w.boxId,
    variantId,
    defaults: { condition: "Near Mint", costCents: 10, location: "  Shelf 2  " },
  });
  await drainScheduled(w.t);
  return runId;
}

const byPair = async (
  w: Awaited<ReturnType<typeof world>>,
  runId: Id<"intakeRuns">,
) => {
  const rows = await w.me.query(api.intakeRuns.listIntakeMatches, { runId });
  return new Map(rows.map((r) => [r.pairId, r]));
};

describe("matching a run's pairs", () => {
  test("each pair is matched in the run's variant, with variations and repeats", async () => {
    const w = await world([
      { number: "1", players: ["Doc Gooden"] },
      { number: "2", players: ["Darryl Strawberry"] },
      { number: "2", players: ["D. Strawberry"] },
      { number: "77", players: ["Nobody Known"] },
    ]);
    const runId = await startRun(w, w.fx.baseId);
    const rows = await byPair(w, runId);
    const [a, b, c, d] = w.pairIds.map((id) => rows.get(id)!);

    expect(a).toMatchObject({ cardId: w.fx.gooden1, band: "matched", reason: "numberAndPlayer" });
    expect(a.variations.map((v) => v._id)).toEqual([w.fx.gooden1Sliding]);
    expect(a.variations[0].variation).toBe("Sliding");
    expect(b).toMatchObject({ cardId: w.fx.strawberry2, band: "matched" });
    expect(b.repeatOfPairId).toBeUndefined();
    // The same card scanned again is flagged against the earlier pair.
    expect(c).toMatchObject({ cardId: w.fx.strawberry2, repeatOfPairId: w.pairIds[1] });
    expect(d).toMatchObject({ band: "none", reason: "noMatch" });
    expect(d.cardId).toBeUndefined();
  });

  test("You have N here counts the copies in the run's home only", async () => {
    const w = await world([{ number: "2", players: ["Darryl Strawberry"] }]);
    await w.t.run(async (ctx) => {
      for (const [homeId, quantity] of [[w.boxId, 3], [w.boxId, 1]] as const) {
        await ctx.db.insert("collectionCopies", {
          ownerId: ME.subject,
          cardId: w.fx.strawberry2,
          homeId,
          quantity,
          lastUpdated: 0,
        });
      }
      const binder = await ctx.db.insert("collectionContainers", {
        ownerId: ME.subject,
        kind: "binder",
        name: "Elsewhere",
        lastUpdated: 0,
      });
      await ctx.db.insert("collectionCopies", {
        ownerId: ME.subject,
        cardId: w.fx.strawberry2,
        homeId: binder,
        quantity: 5,
        lastUpdated: 0,
      });
    });
    const runId = await startRun(w, w.fx.baseId);
    const rows = await byPair(w, runId);
    expect(rows.get(w.pairIds[0])!.haveHere).toBe(4);
  });

  test("with no variant nothing is matched until one is pinned", async () => {
    const w = await world([{ number: "1", players: ["Doc Gooden"] }]);
    const runId = await startRun(w);
    let row = (await byPair(w, runId)).get(w.pairIds[0])!;
    expect(row).toMatchObject({ band: "none", reason: "noVariant" });

    await w.me.mutation(api.intakeRuns.setIntakeRunVariant, {
      runId,
      variantId: w.fx.baseId,
      pinned: true,
    });
    await drainScheduled(w.t);
    row = (await byPair(w, runId)).get(w.pairIds[0])!;
    expect(row).toMatchObject({ cardId: w.fx.gooden1, band: "matched" });
    const run = await w.me.query(api.intakeRuns.getIntakeRun, { runId });
    expect(run).toMatchObject({ variantName: "Base", variantPinned: true, homeKind: "box" });
    // Free text defaults are trimmed.
    expect(run?.defaults).toMatchObject({ condition: "Near Mint", costCents: 10, location: "Shelf 2" });
  });

  test("a collector's pick survives a pair that changes; clearing it re-matches", async () => {
    const w = await world([{ number: "1", players: ["Doc Gooden"] }]);
    const runId = await startRun(w, w.fx.baseId);
    await w.me.mutation(api.intakeRuns.pickIntakeCard, {
      runId,
      pairId: w.pairIds[0],
      cardId: w.fx.gooden1Sliding,
    });
    // A swap re-merges the pair's identity and notes the change.
    await w.me.mutation(api.placeholderPairing.swapPairSides, {
      jobId: JOB,
      frontIndex: 0,
      backIndex: 1,
    });
    await drainScheduled(w.t);
    let row = (await byPair(w, runId)).get(w.pairIds[0])!;
    expect(row).toMatchObject({ cardId: w.fx.gooden1Sliding, byUser: true, reason: "byUser" });

    await w.me.mutation(api.intakeRuns.pickIntakeCard, { runId, pairId: w.pairIds[0], cardId: null });
    await drainScheduled(w.t);
    row = (await byPair(w, runId)).get(w.pairIds[0])!;
    expect(row.byUser).toBeUndefined();
    expect(row.reason).not.toBe("byUser");
  });

  test("a pair that is gone takes its match with it", async () => {
    const w = await world([
      { number: "1", players: ["Doc Gooden"] },
      { number: "2", players: ["Darryl Strawberry"] },
    ]);
    const runId = await startRun(w, w.fx.baseId);
    await w.t.run(async (ctx) => {
      await ctx.db.delete(w.pairIds[0]);
      await noteIntakePairsChanged(ctx, JOB);
    });
    await drainScheduled(w.t);
    const rows = await byPair(w, runId);
    expect([...rows.keys()]).toEqual([w.pairIds[1]]);
  });

  test("a job with no run queues nothing when its pairs change", async () => {
    const w = await world([{ number: "1", players: ["Doc Gooden"] }]);
    await w.me.mutation(api.placeholderPairing.swapPairSides, {
      jobId: JOB,
      frontIndex: 0,
      backIndex: 1,
    });
    const queued = await w.t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect()).map((f) => f.name),
    );
    expect(queued.filter((n) => n.includes("intakeRuns"))).toEqual([]);
  });

  test("one run per job: starting again returns the same run", async () => {
    const w = await world([{ number: "1" }]);
    const first = await startRun(w, w.fx.baseId);
    const again = await startRun(w, w.fx.baseId);
    expect(again).toBe(first);
    const runs = await w.me.query(api.intakeRuns.listMyIntakeRuns, {});
    expect(runs.map((r) => r._id)).toEqual([first]);
  });
});

describe("ownership", () => {
  test("another collector's job, home or run is refused", async () => {
    const w = await world([{ number: "1", players: ["Doc Gooden"] }]);
    await expect(
      w.me.mutation(api.intakeRuns.createIntakeRun, { jobId: JOB, homeId: w.theirBoxId }),
    ).rejects.toThrow(/not found/);
    await expect(
      w.them.mutation(api.intakeRuns.createIntakeRun, { jobId: JOB, homeId: w.theirBoxId }),
    ).rejects.toThrow(/Job not found/);
    await expect(
      w.t.mutation(api.intakeRuns.createIntakeRun, { jobId: JOB, homeId: w.boxId }),
    ).rejects.toThrow(/Not authenticated/);

    const runId = await startRun(w, w.fx.baseId);
    expect(await w.them.query(api.intakeRuns.getIntakeRun, { runId })).toBeNull();
    expect(await w.them.query(api.intakeRuns.listIntakeMatches, { runId })).toEqual([]);
    expect(await w.them.query(api.intakeRuns.listMyIntakeRuns, {})).toEqual([]);
    expect(await w.t.query(api.intakeRuns.getIntakeRun, { runId })).toBeNull();
    await expect(
      w.them.mutation(api.intakeRuns.pickIntakeCard, {
        runId,
        pairId: w.pairIds[0],
        cardId: w.fx.gooden1,
      }),
    ).rejects.toThrow(/not found/);
    await expect(
      w.them.mutation(api.intakeRuns.setIntakeRunVariant, { runId, variantId: w.fx.baseId }),
    ).rejects.toThrow(/not found/);
    await expect(
      w.them.mutation(api.intakeRuns.setIntakeRunDefaults, { runId, defaults: {} }),
    ).rejects.toThrow(/not found/);
  });

  test("a variant with no cards, and a negative price, are refused", async () => {
    const w = await world([{ number: "1" }]);
    await expect(
      w.me.mutation(api.intakeRuns.createIntakeRun, {
        jobId: JOB,
        homeId: w.boxId,
        variantId: w.fx.setId,
      }),
    ).rejects.toThrow(/no cards/);
    await expect(
      w.me.mutation(api.intakeRuns.createIntakeRun, {
        jobId: JOB,
        homeId: w.boxId,
        defaults: { minPriceCents: -5 },
      }),
    ).rejects.toThrow(/Minimum price/);
  });
});


describe("the set builder reset", () => {
  test("drains intake matches and runs, matches first", async () => {
    const w = await world([
      { number: "1", players: ["Doc Gooden"] },
      { number: "2", players: ["Darryl Strawberry"] },
    ]);
    await startRun(w, w.fx.baseId);
    vi.stubEnv("ALLOW_RESET_SET_BUILDER_DATA", "true");
    try {
      const r = await w.t.mutation(internal.selectorOptions.resetIntakeRunsBatch, {});
      expect(r).toEqual({ deleted: 3, hasMore: false });
    } finally {
      vi.unstubAllEnvs();
    }
    const left = await w.t.run(async (ctx) => [
      ...(await ctx.db.query("intakeMatches").collect()),
      ...(await ctx.db.query("intakeRuns").collect()),
    ]);
    expect(left).toEqual([]);
  });
});
