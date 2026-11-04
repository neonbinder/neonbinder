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
import { cancelScheduled, drainScheduled } from "../lib/testing/drain-scheduled";
import { seedCollectionCatalog } from "../lib/testing/collection-fixture";
import { insertTestCard } from "../lib/testing/card-row";
import { priceEveryVariant } from "../lib/testing/common-prices";
import { defaultConditionOf } from "./collection";
import { INTAKE_SETTLE_SCAN, noteIntakePairsChanged } from "./intakeRuns";

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

/** The match row of a pair (the sync has made it by the time a test asks). */
async function matchOf(
  w: Awaited<ReturnType<typeof world>>,
  pairId: Id<"placeholderPairs">,
): Promise<Id<"intakeMatches">> {
  return await w.t.run(async (ctx) => {
    const row = await ctx.db
      .query("intakeMatches")
      .withIndex("by_pair", (q) => q.eq("pairId", pairId))
      .first();
    if (!row) throw new Error("no match row yet");
    return row._id;
  });
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
    await expect(
      w.them.mutation(api.intakeRuns.setIntakeRunHome, { runId, homeId: w.theirBoxId }),
    ).rejects.toThrow(/not found/);
    await expect(
      w.me.mutation(api.intakeRuns.setIntakeRunHome, { runId, homeId: w.theirBoxId }),
    ).rejects.toThrow(/not found/);
  });

  test("a run moves to another of the collector's boxes, never to a binder", async () => {
    const w = await world([{ number: "1", players: ["Doc Gooden"] }]);
    const runId = await startRun(w, w.fx.baseId);
    const [otherBox, binder] = await w.t.run(async (ctx) => [
      await ctx.db.insert("collectionContainers", { ownerId: ME.subject, kind: "box", name: "Row 2", lastUpdated: 0 }),
      await ctx.db.insert("collectionContainers", { ownerId: ME.subject, kind: "binder", name: "Rookies", lastUpdated: 0 }),
    ]);
    await w.me.mutation(api.intakeRuns.setIntakeRunHome, { runId, homeId: otherBox });
    expect((await w.me.query(api.intakeRuns.getIntakeRun, { runId }))?.homeName).toBe("Row 2");
    await expect(
      w.me.mutation(api.intakeRuns.setIntakeRunHome, { runId, homeId: binder }),
    ).rejects.toThrow(/Pick a box/);
  });

  test("a binder run is refused a box, and a run whose home is gone is not moved", async () => {
    const w = await world([{ number: "1", players: ["Doc Gooden"] }]);
    const [binder, otherBinder] = await w.t.run(async (ctx) => [
      await ctx.db.insert("collectionContainers", { ownerId: ME.subject, kind: "binder", name: "Rookies", lastUpdated: 0 }),
      await ctx.db.insert("collectionContainers", { ownerId: ME.subject, kind: "binder", name: "Stars", lastUpdated: 0 }),
    ]);
    const runId = await w.me.mutation(api.intakeRuns.createIntakeRun, { jobId: JOB, homeId: binder });
    await expect(
      w.me.mutation(api.intakeRuns.setIntakeRunHome, { runId, homeId: w.boxId }),
    ).rejects.toThrow(/Pick a binder/);
    await w.t.run(async (ctx) => ctx.db.delete(binder));
    await expect(
      w.me.mutation(api.intakeRuns.setIntakeRunHome, { runId, homeId: otherBinder }),
    ).rejects.toThrow(/gone/);
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


describe("the collector's answers (NEO-382)", () => {
  const copiesOf = (w: Awaited<ReturnType<typeof world>>, cardId: Id<"cardChecklist">) =>
    w.t.run(async (ctx) =>
      (await ctx.db.query("collectionCopies").collect()).filter((c) => c.cardId === cardId),
    );

  test("after a move, the next save files into the new box", async () => {
    const w = await world([{ number: "1", players: ["Doc Gooden"] }]);
    const runId = await startRun(w, w.fx.baseId);
    const row2 = await w.t.run(async (ctx) =>
      ctx.db.insert("collectionContainers", { ownerId: ME.subject, kind: "box", name: "Row 2", lastUpdated: 0 }),
    );
    await w.me.mutation(api.intakeRuns.setIntakeRunHome, { runId, homeId: row2 });
    await w.me.mutation(api.intakeRuns.saveIntakeMatch, { runId, pairId: w.pairIds[0], quantity: 1 });
    const copies = await copiesOf(w, w.fx.gooden1);
    expect(copies.map((c) => c.homeId)).toEqual([row2]);
  });

  test("a save files the copies with the run's defaults, once", async () => {
    const w = await world([{ number: "1", players: ["Doc Gooden"] }]);
    const runId = await startRun(w, w.fx.baseId);
    const first = await w.me.mutation(api.intakeRuns.saveIntakeMatch, {
      runId,
      pairId: w.pairIds[0],
      quantity: 2,
      details: { notes: "From the show" },
    });
    expect(first.alreadySaved).toBe(false);
    // A double click (or a retried request) adds nothing.
    const again = await w.me.mutation(api.intakeRuns.saveIntakeMatch, {
      runId,
      pairId: w.pairIds[0],
      quantity: 2,
    });
    expect(again).toEqual({ copyId: first.copyId, alreadySaved: true });

    const copies = await copiesOf(w, w.fx.gooden1);
    expect(copies).toHaveLength(1);
    expect(copies[0]).toMatchObject({
      homeId: w.boxId,
      quantity: 2,
      condition: "Near Mint",
      costCents: 10,
      location: "Shelf 2",
      notes: "From the show",
    });
    const row = (await byPair(w, runId)).get(w.pairIds[0])!;
    expect(row).toMatchObject({ savedCopyId: first.copyId, savedQuantity: 2, haveHere: 2 });
    // A saved card is not re-picked.
    await expect(
      w.me.mutation(api.intakeRuns.pickIntakeCard, { runId, pairId: w.pairIds[0], cardId: null }),
    ).rejects.toThrow(/already saved/);
  });

  test("NEO-427: a scanned save keeps its own line beside an identical one", async () => {
    const w = await world([{ number: "1", players: ["Doc Gooden"] }]);
    const twin = await w.t.run((ctx) =>
      ctx.db.insert("collectionCopies", {
        ownerId: ME.subject,
        cardId: w.fx.gooden1,
        homeId: w.boxId,
        quantity: 3,
        condition: "Near Mint",
        costCents: 10,
        location: "Shelf 2",
        lastUpdated: 0,
      }),
    );
    const runId = await startRun(w, w.fx.baseId);
    const saved = await w.me.mutation(api.intakeRuns.saveIntakeMatch, {
      runId,
      pairId: w.pairIds[0],
      quantity: 1,
    });
    expect(saved.copyId).not.toBe(twin);
    const copies = await copiesOf(w, w.fx.gooden1);
    expect(copies.map((c) => c.quantity).sort()).toEqual([1, 3]);
    expect(copies.find((c) => c._id === twin)).toMatchObject({ quantity: 3 });
  });

  test("NEO-427: in a binder it takes the first open pocket, not its identical twin's", async () => {
    const w = await world([{ number: "1", players: ["Doc Gooden"] }]);
    await w.t.run(async (ctx) => {
      await ctx.db.patch(w.boxId, { kind: "binder" });
      await ctx.db.insert("collectionCopies", {
        ownerId: ME.subject,
        cardId: w.fx.gooden1,
        homeId: w.boxId,
        slot: 0,
        quantity: 3,
        condition: "Near Mint",
        costCents: 10,
        location: "Shelf 2",
        lastUpdated: 0,
      });
    });
    const runId = await startRun(w, w.fx.baseId);
    const { copyId } = await w.me.mutation(api.intakeRuns.saveIntakeMatch, {
      runId,
      pairId: w.pairIds[0],
      quantity: 1,
    });
    expect(await w.t.run((ctx) => ctx.db.get(copyId))).toMatchObject({ quantity: 1, slot: 1 });
  });

  test("a double scan must be answered: a second copy saves, a re-scan is set aside", async () => {
    const w = await world([
      { number: "2", players: ["Darryl Strawberry"] },
      { number: "2", players: ["Darryl Strawberry"] },
      { number: "2", players: ["Darryl Strawberry"] },
    ]);
    const runId = await startRun(w, w.fx.baseId);
    await expect(
      w.me.mutation(api.intakeRuns.saveIntakeMatch, { runId, pairId: w.pairIds[1], quantity: 1 }),
    ).rejects.toThrow(/second copy/);
    // The first scan of the card is no repeat, so there is nothing to answer.
    await expect(
      w.me.mutation(api.intakeRuns.answerIntakeRepeat, { runId, pairId: w.pairIds[0], secondCopy: true }),
    ).rejects.toThrow(/isn't a repeat/);

    await w.me.mutation(api.intakeRuns.answerIntakeRepeat, { runId, pairId: w.pairIds[1], secondCopy: true });
    await w.me.mutation(api.intakeRuns.saveIntakeMatch, { runId, pairId: w.pairIds[1], quantity: 1 });

    await w.me.mutation(api.intakeRuns.answerIntakeRepeat, { runId, pairId: w.pairIds[2], secondCopy: false });
    await expect(
      w.me.mutation(api.intakeRuns.saveIntakeMatch, { runId, pairId: w.pairIds[2], quantity: 1 }),
    ).rejects.toThrow(/set aside/);

    const rows = await byPair(w, runId);
    expect(rows.get(w.pairIds[1])).toMatchObject({ repeatIsSecondCopy: true, savedQuantity: 1 });
    expect(rows.get(w.pairIds[2])).toMatchObject({ setAside: true });
    expect((await copiesOf(w, w.fx.strawberry2)).reduce((n, c) => n + c.quantity, 0)).toBe(1);

    // Brought back, the re-scan asks again.
    await w.me.mutation(api.intakeRuns.setIntakeMatchAside, { runId, pairId: w.pairIds[2], setAside: false });
    const back = (await byPair(w, runId)).get(w.pairIds[2])!;
    expect(back.setAside).toBeUndefined();
    expect(back.repeatOfPairId).toBe(w.pairIds[0]);
  });

  test("a pair with no card, or a bad quantity, does not save", async () => {
    const w = await world([
      { number: "77", players: ["Nobody Known"] },
      { number: "1", players: ["Doc Gooden"] },
    ]);
    const runId = await startRun(w, w.fx.baseId);
    await expect(
      w.me.mutation(api.intakeRuns.saveIntakeMatch, { runId, pairId: w.pairIds[0], quantity: 1 }),
    ).rejects.toThrow(/Pick the card/);
    for (const quantity of [0, 1.5, 100_000]) {
      await expect(
        w.me.mutation(api.intakeRuns.saveIntakeMatch, { runId, pairId: w.pairIds[1], quantity }),
      ).rejects.toThrow(/between 1/);
    }
  });

  test("the search finds the variant's cards by number, then by name", async () => {
    const w = await world([{ number: "1" }]);
    const runId = await startRun(w, w.fx.baseId);
    const byNumber = await w.me.query(api.intakeRuns.searchIntakeCards, { runId, q: "#002" });
    expect(byNumber.map((c) => c._id)).toEqual([w.fx.strawberry2]);
    const byName = await w.me.query(api.intakeRuns.searchIntakeCards, { runId, q: "gooden" });
    expect(byName.map((c) => c._id)).toEqual(expect.arrayContaining([w.fx.gooden1]));
    expect(await w.them.query(api.intakeRuns.searchIntakeCards, { runId, q: "1" })).toEqual([]);
  });

  test("a saved or set-aside card is never re-matched; a second-copy answer is asked again when the match moves", async () => {
    const w = await world([
      { number: "1", players: ["Doc Gooden"] },
      { number: "2", players: ["Darryl Strawberry"] },
      { number: "1", players: ["Doc Gooden"] },
    ]);
    const runId = await startRun(w, w.fx.baseId);
    await w.me.mutation(api.intakeRuns.saveIntakeMatch, { runId, pairId: w.pairIds[0], quantity: 1 });
    await w.me.mutation(api.intakeRuns.setIntakeMatchAside, { runId, pairId: w.pairIds[1], setAside: true });
    await w.me.mutation(api.intakeRuns.answerIntakeRepeat, { runId, pairId: w.pairIds[2], secondCopy: true });

    // A new variant re-matches every open card, and only those.
    await w.me.mutation(api.intakeRuns.setIntakeRunVariant, { runId, variantId: w.fx.goldId, pinned: true });
    await drainScheduled(w.t);
    const rows = await byPair(w, runId);
    expect(rows.get(w.pairIds[0])).toMatchObject({ cardId: w.fx.gooden1, savedQuantity: 1 });
    expect(rows.get(w.pairIds[1])).toMatchObject({ cardId: w.fx.strawberry2, setAside: true });
    const moved = rows.get(w.pairIds[2])!;
    expect(moved.cardId).toBe(w.fx.gold1);
    expect(moved.repeatIsSecondCopy).toBeUndefined();

    // A saved card takes no more answers.
    await expect(
      w.me.mutation(api.intakeRuns.setIntakeMatchAside, { runId, pairId: w.pairIds[0], setAside: true }),
    ).rejects.toThrow(/already saved/);
    await expect(
      w.me.mutation(api.intakeRuns.answerIntakeRepeat, { runId, pairId: w.pairIds[0], secondCopy: false }),
    ).rejects.toThrow(/already saved/);
  });

  test("a save takes up to 999 copies, and a per-card detail left out keeps the run's", async () => {
    const w = await world([{ number: "1", players: ["Doc Gooden"] }]);
    const runId = await startRun(w, w.fx.baseId);
    await w.me.mutation(api.intakeRuns.saveIntakeMatch, {
      runId,
      pairId: w.pairIds[0],
      quantity: 999,
      details: { condition: undefined, location: "Binder 4" },
    });
    const [copy] = await copiesOf(w, w.fx.gooden1);
    expect(copy).toMatchObject({ quantity: 999, condition: "Near Mint", location: "Binder 4" });
    const row = (await byPair(w, runId)).get(w.pairIds[0])!;
    expect(row.card).toMatchObject({ _id: w.fx.gooden1, cardNumber: "1" });
  });

  test("the search: no variant finds nothing, an empty search lists the variant, at most 8", async () => {
    const w = await world([{ number: "1" }, { number: "77", players: ["Nobody Known"] }]);
    const bare = await startRun(w);
    expect(await w.me.query(api.intakeRuns.searchIntakeCards, { runId: bare, q: "1" })).toEqual([]);
    expect((await byPair(w, bare)).get(w.pairIds[1])!.card).toBeNull();

    await w.me.mutation(api.intakeRuns.setIntakeRunVariant, { runId: bare, variantId: w.fx.baseId, pinned: true });
    const all = await w.me.query(api.intakeRuns.searchIntakeCards, { runId: bare, q: "  " });
    expect(all.map((c) => c._id)).toEqual(
      expect.arrayContaining([w.fx.gooden1, w.fx.strawberry2, w.fx.gooden1Sliding]),
    );
    await w.t.run(async (ctx) => {
      for (let i = 0; i < 12; i++) {
        await insertTestCard(ctx, {
          selectorOptionId: w.fx.baseId,
          cardNumber: `${100 + i}`,
          cardName: `Filler ${i}`,
          platformData: {},
          sortOrder: 100 + i,
          lastUpdated: 0,
        } as never);
      }
    });
    expect(await w.me.query(api.intakeRuns.searchIntakeCards, { runId: bare, q: "filler" })).toHaveLength(8);
  });

  test("another collector cannot save, answer or set aside", async () => {
    const w = await world([{ number: "1", players: ["Doc Gooden"] }]);
    const runId = await startRun(w, w.fx.baseId);
    const pairId = w.pairIds[0];
    await expect(w.them.mutation(api.intakeRuns.saveIntakeMatch, { runId, pairId, quantity: 1 })).rejects.toThrow(/not found/);
    await expect(w.them.mutation(api.intakeRuns.answerIntakeRepeat, { runId, pairId, secondCopy: true })).rejects.toThrow(/not found/);
    await expect(w.them.mutation(api.intakeRuns.setIntakeMatchAside, { runId, pairId, setAside: true })).rejects.toThrow(/not found/);
  });
});

describe("NEO-370 — a settled box run kicks the collector's listing drain", () => {
  type W = Awaited<ReturnType<typeof world>>;
  /**
   * Listing started on BSC, and the photo session closed by the collector
   * ("Done adding photos"): the only close that may trigger a sync.
   */
  const listOn = async (w: W) => {
    // NEO-370: a syncing collector's box saves need a price (`listingGate`).
    await priceEveryVariant(w.t, ME.subject);
    await w.t.run(async (ctx) => {
      await ctx.db.insert("marketplaceListingStates", {
        ownerId: ME.subject,
        platform: "bsc",
        listingStartedAt: 1,
        lastUpdated: 0,
      });
      await ctx.db.insert("userProfiles", {
        userId: ME.subject,
        siteCredentials: [{ site: "buysportscards", hasCredentials: true }],
      } as never);
      const job = (await ctx.db.query("placeholderJobs").collect())[0];
      await ctx.db.patch(job._id, { streamClosedBy: "user" });
    });
  };
  const closedBy = (w: W, by: "user" | "idle" | undefined) =>
    w.t.run(async (ctx) => {
      const job = (await ctx.db.query("placeholderJobs").collect())[0];
      await ctx.db.patch(job._id, { streamClosedBy: by });
    });
  const drainsOf = async (w: W) =>
    (await w.t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())).filter((f) =>
      f.name.includes("drainOwner"),
    );
  /** Hold the scheduler's clock so a kicked drain stays pending (it would reach BSC). */
  async function held<T>(w: W, body: () => Promise<T>): Promise<T> {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      return await body();
    } finally {
      await cancelScheduled(w.t as never);
      vi.useRealTimers();
    }
  }
  const two = () => world([
    { number: "1", players: ["Doc Gooden"] },
    { number: "2", players: ["Darryl Strawberry"] },
  ]);
  /** A save whose photos have landed, so the test below proves its own rule rather than NEO-427's hold. */
  const saveWithPhotos = async (w: W, runId: Id<"intakeRuns">, pairId: Id<"placeholderPairs">) => {
    await w.me.mutation(api.intakeRuns.saveIntakeMatch, { runId, pairId, quantity: 1 });
    await w.t.mutation(internal.intakeRuns.recordIntakePhotos, {
      matchId: await matchOf(w, pairId),
      photos: "attached",
    });
  };

  test("NEO-427: photos on their way hold the kick, and their report (either way) releases it", async () => {
    for (const photos of ["attached", "failed"] as const) {
      const w = await two();
      await listOn(w);
      const runId = await startRun(w, w.fx.baseId);
      await held(w, async () => {
        await w.me.mutation(api.intakeRuns.setIntakeMatchAside, { runId, pairId: w.pairIds[1], setAside: true });
        await w.me.mutation(api.intakeRuns.saveIntakeMatch, { runId, pairId: w.pairIds[0], quantity: 1 });
        expect(await drainsOf(w)).toEqual([]);
        await w.t.mutation(internal.intakeRuns.recordIntakePhotos, {
          matchId: await matchOf(w, w.pairIds[0]),
          photos,
        });
        expect(await drainsOf(w)).toHaveLength(1);
      });
    }
  });

  test("NEO-427: a pair saved before photos came along (no state) holds nothing", async () => {
    const w = await two();
    await listOn(w);
    const runId = await startRun(w, w.fx.baseId);
    await held(w, async () => {
      await w.me.mutation(api.intakeRuns.saveIntakeMatch, { runId, pairId: w.pairIds[0], quantity: 1 });
      const matchId = await matchOf(w, w.pairIds[0]);
      await w.t.run((ctx) => ctx.db.patch(matchId, { photos: undefined }));
      await w.me.mutation(api.intakeRuns.setIntakeMatchAside, { runId, pairId: w.pairIds[1], setAside: true });
      expect(await drainsOf(w)).toHaveLength(1);
    });
  });

  test("NEO-427: an attach that never reports stops holding once it times out", async () => {
    const w = await two();
    await listOn(w);
    const runId = await startRun(w, w.fx.baseId);
    await held(w, async () => {
      await w.me.mutation(api.intakeRuns.setIntakeMatchAside, { runId, pairId: w.pairIds[1], setAside: true });
      await w.me.mutation(api.intakeRuns.saveIntakeMatch, { runId, pairId: w.pairIds[0], quantity: 1 });
      await w.t.mutation(internal.intakeRuns.expireIntakePhotoAttach, { matchId: await matchOf(w, w.pairIds[0]) });
      expect(await drainsOf(w)).toHaveLength(1);
    });
  });

  test("the last pair answered (a set-aside) kicks one drain; the saves before it kick none", async () => {
    const w = await two();
    await listOn(w);
    const runId = await startRun(w, w.fx.baseId);
    await held(w, async () => {
      await saveWithPhotos(w, runId, w.pairIds[0]);
      expect(await drainsOf(w)).toEqual([]);
      await w.me.mutation(api.intakeRuns.setIntakeMatchAside, { runId, pairId: w.pairIds[1], setAside: true });
      const drains = await drainsOf(w);
      expect(drains.map((d) => d.args[0])).toEqual([{ ownerId: ME.subject, platform: "bsc" }]);
    });
  });

  test("the last pair saved kicks the drain", async () => {
    const w = await two();
    await listOn(w);
    const runId = await startRun(w, w.fx.baseId);
    await held(w, async () => {
      await w.me.mutation(api.intakeRuns.setIntakeMatchAside, { runId, pairId: w.pairIds[1], setAside: true });
      expect(await drainsOf(w)).toEqual([]);
      await saveWithPhotos(w, runId, w.pairIds[0]);
      expect(await drainsOf(w)).toHaveLength(1);
    });
  });

  test("photos still processing: every pair saved kicks nothing yet", async () => {
    const w = await two();
    await listOn(w);
    await w.t.run(async (ctx) => {
      const job = (await ctx.db.query("placeholderJobs").collect())[0];
      await ctx.db.patch(job._id, { status: "processing" });
    });
    const runId = await startRun(w, w.fx.baseId);
    await held(w, async () => {
      await saveWithPhotos(w, runId, w.pairIds[0]);
      await saveWithPhotos(w, runId, w.pairIds[1]);
      expect(await drainsOf(w)).toEqual([]);
    });
  });

  test("every pair answered while photos process: the job finishing kicks the drain", async () => {
    for (const finish of ["succeeded", "failed"] as const) {
      const w = await two();
      await listOn(w);
      await w.t.run(async (ctx) => {
        const job = (await ctx.db.query("placeholderJobs").collect())[0];
        await ctx.db.patch(job._id, { status: "processing" });
      });
      const runId = await startRun(w, w.fx.baseId);
      await held(w, async () => {
        await saveWithPhotos(w, runId, w.pairIds[0]);
        await w.me.mutation(api.intakeRuns.setIntakeMatchAside, { runId, pairId: w.pairIds[1], setAside: true });
        expect(await drainsOf(w)).toEqual([]);
        if (finish === "succeeded") {
          await w.t.mutation(internal.placeholderPipeline.markJobSucceeded, { jobId: JOB });
        } else {
          await w.t.mutation(internal.placeholderPipeline.markJobFailed, { jobId: JOB, errorCode: "TEST" });
        }
        expect((await drainsOf(w)).map((d) => d.args[0])).toEqual([{ ownerId: ME.subject, platform: "bsc" }]);
      });
    }
  });

  test("a job finishing with a pair still unanswered kicks nothing", async () => {
    const w = await two();
    await listOn(w);
    await w.t.run(async (ctx) => {
      const job = (await ctx.db.query("placeholderJobs").collect())[0];
      await ctx.db.patch(job._id, { status: "processing" });
    });
    const runId = await startRun(w, w.fx.baseId);
    await held(w, async () => {
      await saveWithPhotos(w, runId, w.pairIds[0]);
      await w.t.mutation(internal.placeholderPipeline.markJobSucceeded, { jobId: JOB });
      expect(await drainsOf(w)).toEqual([]);
    });
  });

  test("everything set aside (nothing saved) kicks nothing", async () => {
    const w = await two();
    await listOn(w);
    const runId = await startRun(w, w.fx.baseId);
    await held(w, async () => {
      await w.me.mutation(api.intakeRuns.setIntakeMatchAside, { runId, pairId: w.pairIds[0], setAside: true });
      await w.me.mutation(api.intakeRuns.setIntakeMatchAside, { runId, pairId: w.pairIds[1], setAside: true });
      expect(await drainsOf(w)).toEqual([]);
    });
  });

  test("a binder run never kicks: the home is read first and a binder is not for sale", async () => {
    const w = await two();
    await listOn(w);
    const runId = await startRun(w, w.fx.baseId);
    await w.t.run(async (ctx) => {
      await ctx.db.patch(w.boxId, { kind: "binder" });
    });
    await held(w, async () => {
      await saveWithPhotos(w, runId, w.pairIds[0]);
      await saveWithPhotos(w, runId, w.pairIds[1]);
      expect(await drainsOf(w)).toEqual([]);
    });
  });

  test("a job that already failed counts as finished: the last save kicks the drain", async () => {
    const w = await two();
    await listOn(w);
    await w.t.run(async (ctx) => {
      const job = (await ctx.db.query("placeholderJobs").collect())[0];
      await ctx.db.patch(job._id, { status: "failed" });
    });
    const runId = await startRun(w, w.fx.baseId);
    await held(w, async () => {
      await saveWithPhotos(w, runId, w.pairIds[0]);
      expect(await drainsOf(w)).toEqual([]);
      await saveWithPhotos(w, runId, w.pairIds[1]);
      expect(await drainsOf(w)).toHaveLength(1);
    });
  });

  describe("the settle scan is bounded", () => {
    /** Pad the run with already-set-aside rows so it holds `total` match rows. */
    async function padTo(w: W, runId: Id<"intakeRuns">, total: number) {
      await w.t.run(async (ctx) => {
        const have = (await ctx.db.query("intakeMatches").withIndex("by_run", (q) => q.eq("runId", runId)).collect()).length;
        for (let i = have; i < total; i++) {
          await ctx.db.insert("intakeMatches", {
            runId,
            userId: ME.subject,
            pairId: w.pairIds[0],
            frontIndex: 1000 + 2 * i,
            backIndex: 1001 + 2 * i,
            readKey: `pad-${i}`,
            confidence: 0,
            band: "none",
            reason: "playerOnly",
            candidates: [],
            variations: [],
            setAside: true,
          });
        }
      });
    }

    test("a run of exactly INTAKE_SETTLE_SCAN rows still settles and kicks", async () => {
      const w = await two();
      await listOn(w);
      const runId = await startRun(w, w.fx.baseId);
      await padTo(w, runId, INTAKE_SETTLE_SCAN);
      await held(w, async () => {
        await saveWithPhotos(w, runId, w.pairIds[0]);
        await saveWithPhotos(w, runId, w.pairIds[1]);
        expect(await drainsOf(w)).toHaveLength(1);
      });
    });

    test("a run larger than INTAKE_SETTLE_SCAN is not checked on a save: no kick", async () => {
      const w = await two();
      await listOn(w);
      const runId = await startRun(w, w.fx.baseId);
      await padTo(w, runId, INTAKE_SETTLE_SCAN + 1);
      await held(w, async () => {
        await saveWithPhotos(w, runId, w.pairIds[0]);
        await saveWithPhotos(w, runId, w.pairIds[1]);
        expect(await drainsOf(w)).toEqual([]);
      });
    });
  });

  test("answering a repeat as a second copy kicks nothing; saving that copy does", async () => {
    const w = await world([
      { number: "1", players: ["Doc Gooden"] },
      { number: "2", players: ["Darryl Strawberry"] },
      { number: "2", players: ["Darryl Strawberry"] },
    ]);
    await listOn(w);
    const runId = await startRun(w, w.fx.baseId);
    await held(w, async () => {
      await saveWithPhotos(w, runId, w.pairIds[0]);
      await saveWithPhotos(w, runId, w.pairIds[1]);
      await w.me.mutation(api.intakeRuns.answerIntakeRepeat, { runId, pairId: w.pairIds[2], secondCopy: true });
      expect(await drainsOf(w)).toEqual([]);
      await saveWithPhotos(w, runId, w.pairIds[2]);
      expect(await drainsOf(w)).toHaveLength(1);
    });
  });

  test("a re-scan answered as set aside settles the run and kicks", async () => {
    const w = await world([
      { number: "2", players: ["Darryl Strawberry"] },
      { number: "2", players: ["Darryl Strawberry"] },
    ]);
    await listOn(w);
    const runId = await startRun(w, w.fx.baseId);
    await held(w, async () => {
      await saveWithPhotos(w, runId, w.pairIds[0]);
      await w.me.mutation(api.intakeRuns.answerIntakeRepeat, { runId, pairId: w.pairIds[1], secondCopy: false });
      expect(await drainsOf(w)).toHaveLength(1);
    });
  });

  test("bringing a set-aside pair back (setAside: false) kicks nothing, and the run is unsettled again", async () => {
    const w = await two();
    await listOn(w);
    const runId = await startRun(w, w.fx.baseId);
    await held(w, async () => {
      await w.me.mutation(api.intakeRuns.setIntakeMatchAside, { runId, pairId: w.pairIds[1], setAside: true });
      await w.me.mutation(api.intakeRuns.setIntakeMatchAside, { runId, pairId: w.pairIds[1], setAside: false });
      expect(await drainsOf(w)).toEqual([]);
      // The brought-back pair is open again: saving the other alone does not settle.
      await saveWithPhotos(w, runId, w.pairIds[0]);
      expect(await drainsOf(w)).toEqual([]);
    });
  });

  test("a session closed by the idle sweep never kicks, however settled the run", async () => {
    const w = await two();
    await listOn(w);
    await closedBy(w, "idle");
    const runId = await startRun(w, w.fx.baseId);
    await held(w, async () => {
      await saveWithPhotos(w, runId, w.pairIds[0]);
      await saveWithPhotos(w, runId, w.pairIds[1]);
      expect(await drainsOf(w)).toEqual([]);
    });
  });

  test("a finished job no one closed (an upload batch, or a session before this rule) never kicks", async () => {
    const w = await two();
    await listOn(w);
    await closedBy(w, undefined);
    const runId = await startRun(w, w.fx.baseId);
    await held(w, async () => {
      await saveWithPhotos(w, runId, w.pairIds[0]);
      await saveWithPhotos(w, runId, w.pairIds[1]);
      expect(await drainsOf(w)).toEqual([]);
    });
  });

  test("every pair answered while still collecting: Done adding photos closes the session and kicks", async () => {
    const w = await two();
    await listOn(w);
    await w.t.run(async (ctx) => {
      const job = (await ctx.db.query("placeholderJobs").collect())[0];
      await ctx.db.patch(job._id, {
        status: "collecting",
        streamClosedBy: undefined,
        totalImages: 4,
        processedImages: 4,
        failedImages: 0,
        lastActivityAt: Date.now(),
      });
    });
    const runId = await startRun(w, w.fx.baseId);
    await held(w, async () => {
      await saveWithPhotos(w, runId, w.pairIds[0]);
      await w.me.mutation(api.intakeRuns.setIntakeMatchAside, { runId, pairId: w.pairIds[1], setAside: true });
      expect(await drainsOf(w)).toEqual([]);
      const closed = await w.me.mutation(api.placeholderStream.closePlaceholderStream, { jobId: JOB });
      expect(closed).toMatchObject({ closed: true, status: "succeeded" });
      const job = await w.t.run(async (ctx) => (await ctx.db.query("placeholderJobs").collect())[0]);
      expect(job.streamClosedBy).toBe("user");
      expect((await drainsOf(w)).map((d) => d.args[0])).toEqual([{ ownerId: ME.subject, platform: "bsc" }]);
    });
  });

  test("the idle sweep closing a settled session records it and kicks nothing", async () => {
    const w = await two();
    await listOn(w);
    await w.t.run(async (ctx) => {
      const job = (await ctx.db.query("placeholderJobs").collect())[0];
      await ctx.db.patch(job._id, {
        status: "collecting",
        streamClosedBy: undefined,
        totalImages: 4,
        processedImages: 4,
        failedImages: 0,
        lastActivityAt: 1,
      });
    });
    const runId = await startRun(w, w.fx.baseId);
    await held(w, async () => {
      await saveWithPhotos(w, runId, w.pairIds[0]);
      await saveWithPhotos(w, runId, w.pairIds[1]);
      expect(await w.t.mutation(internal.placeholderStream.sweepIdleStreams, {})).toMatchObject({ closed: 1 });
      const job = await w.t.run(async (ctx) => (await ctx.db.query("placeholderJobs").collect())[0]);
      expect(job.streamClosedBy).toBe("idle");
      expect(job.status).toBe("succeeded");
      expect(await drainsOf(w)).toEqual([]);
    });
  });

  test("an in-person box (not listed on marketplaces) never kicks", async () => {
    const w = await two();
    await listOn(w);
    await w.t.run((ctx) => ctx.db.patch(w.boxId, { listedOnMarketplaces: false }));
    const runId = await startRun(w, w.fx.baseId);
    await held(w, async () => {
      await saveWithPhotos(w, runId, w.pairIds[0]);
      await saveWithPhotos(w, runId, w.pairIds[1]);
      expect(await drainsOf(w)).toEqual([]);
    });
  });

  test("a collector not listing (no saved sign-in started it): the settled run schedules no drain", async () => {
    const w = await two();
    await listOn(w);
    await w.t.run(async (ctx) => {
      const state = (await ctx.db.query("marketplaceListingStates").collect())[0];
      await ctx.db.patch(state._id, { listingStartedAt: undefined });
    });
    const runId = await startRun(w, w.fx.baseId);
    await held(w, async () => {
      await saveWithPhotos(w, runId, w.pairIds[0]);
      await saveWithPhotos(w, runId, w.pairIds[1]);
      expect(await drainsOf(w)).toEqual([]);
    });
  });

  test("a collector who lists nowhere: the settled run schedules no drain", async () => {
    const w = await two();
    const runId = await startRun(w, w.fx.baseId);
    await held(w, async () => {
      await saveWithPhotos(w, runId, w.pairIds[0]);
      await saveWithPhotos(w, runId, w.pairIds[1]);
      expect(await drainsOf(w)).toEqual([]);
    });
  });
});

describe("NEO-427 — a save's photos", () => {
  type W = Awaited<ReturnType<typeof world>>;
  async function saved(w: W) {
    const runId = await startRun(w, w.fx.baseId);
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const { copyId } = await w.me.mutation(api.intakeRuns.saveIntakeMatch, {
      runId,
      pairId: w.pairIds[0],
      quantity: 1,
    });
    const matchId = await matchOf(w, w.pairIds[0]);
    return { runId, copyId, matchId };
  }
  const tile = async (w: W, runId: Id<"intakeRuns">) => {
    const rows = await w.me.query(api.intakeRuns.listIntakeMatches, { runId });
    const { photos, photoFailure } = rows[0];
    return { photos, photoFailure };
  };
  const fail = (w: W, matchId: Id<"intakeMatches">, photoFailure: "scanGone" | "error") =>
    w.t.mutation(internal.intakeRuns.recordIntakePhotos, { matchId, photos: "failed", photoFailure });
  const live = (w: W, copyId: Id<"collectionCopies">, side: "front" | "back") =>
    w.t.run(async (ctx) => {
      await ctx.db.insert("collectionCopyPhotos", {
        ownerId: ME.subject,
        copyId,
        side,
        token: `${side}${"0".repeat(32 - side.length)}`,
        contentType: "image/jpeg",
        imageBytes: 1,
        thumbBytes: 1,
        status: "live",
        since: 0,
      });
      await ctx.db.patch(copyId, { hasPhotos: true });
    });
  const one = () => world([{ number: "1", players: ["Doc Gooden"] }]);
  const scheduledNames = async (w: W) =>
    (await w.t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())).map((f) => f.name);

  afterEach(async () => {
    for (const t of harnesses) await cancelScheduled(t as never);
    vi.useRealTimers();
  });

  test("a save goes pending and queues the attach and its timeout; saving again queues nothing", async () => {
    const w = await one();
    const { runId, copyId, matchId } = await saved(w);
    expect(await tile(w, runId)).toEqual({ photos: "pending", photoFailure: undefined });
    const attaches = (await scheduledNames(w)).filter((n) => n.includes("attachIntakePhotos"));
    expect(attaches).toHaveLength(1);
    expect((await scheduledNames(w)).filter((n) => n.includes("expireIntakePhotoAttach"))).toHaveLength(1);
    const before = (await scheduledNames(w)).length;
    await expect(
      w.me.mutation(api.intakeRuns.saveIntakeMatch, { runId, pairId: w.pairIds[0], quantity: 1 }),
    ).resolves.toEqual({ copyId, alreadySaved: true });
    expect((await scheduledNames(w)).length).toBe(before);
    expect(await w.t.query(internal.intakeRuns.intakePhotoWork, { matchId })).toEqual({
      ownerId: ME.subject,
      copyId,
      jobId: JOB,
      frontIndex: 0,
      backIndex: 1,
    });
    expect(await w.t.query(internal.intakeRuns.intakeRunSavedMatches, { runId })).toEqual([matchId]);
  });

  test("a row not saved yet has no photo work, and isn't among a run's saved rows", async () => {
    const w = await one();
    const runId = await startRun(w, w.fx.baseId);
    const matchId = await matchOf(w, w.pairIds[0]);
    expect(await w.t.query(internal.intakeRuns.intakePhotoWork, { matchId })).toBeNull();
    expect(await w.t.query(internal.intakeRuns.intakeRunSavedMatches, { runId })).toEqual([]);
  });

  test("a report sets the state; a late failure never takes back photos that landed", async () => {
    const w = await one();
    const { runId, matchId } = await saved(w);
    await fail(w, matchId, "scanGone");
    expect(await tile(w, runId)).toEqual({ photos: "failed", photoFailure: "scanGone" });
    await w.t.mutation(internal.intakeRuns.recordIntakePhotos, { matchId, photos: "attached" });
    expect(await tile(w, runId)).toEqual({ photos: "attached", photoFailure: undefined });
    await fail(w, matchId, "error");
    expect(await tile(w, runId)).toEqual({ photos: "attached", photoFailure: undefined });
  });

  test("the timeout calls a pending attach failed, and leaves any other state alone", async () => {
    const w = await one();
    const { runId, matchId } = await saved(w);
    await w.t.mutation(internal.intakeRuns.expireIntakePhotoAttach, { matchId });
    expect(await tile(w, runId)).toEqual({ photos: "failed", photoFailure: "error" });
    await fail(w, matchId, "scanGone");
    await w.t.mutation(internal.intakeRuns.expireIntakePhotoAttach, { matchId });
    expect(await tile(w, runId)).toEqual({ photos: "failed", photoFailure: "scanGone" });
  });

  test("Try again: only the owner's failed row, with its copy still there, goes back to pending", async () => {
    const w = await one();
    const { runId, copyId, matchId } = await saved(w);
    const retry = (ownerId: string) => w.t.mutation(internal.intakeRuns.beginIntakePhotoRetry, { matchId, ownerId });
    await expect(retry(ME.subject)).rejects.toThrow(/on their way/);
    await fail(w, matchId, "error");
    await expect(retry(THEM.subject)).rejects.toThrow(/isn't in this run/);
    const timeouts = async () => (await scheduledNames(w)).filter((n) => n.includes("expireIntakePhotoAttach")).length;
    const before = await timeouts();
    await retry(ME.subject);
    expect(await tile(w, runId)).toEqual({ photos: "pending", photoFailure: undefined });
    expect(await timeouts()).toBe(before + 1);
    await fail(w, matchId, "error");
    await w.t.run((ctx) => ctx.db.delete(copyId));
    await expect(retry(ME.subject)).rejects.toThrow(/left your collection/);
  });

  describe("a hand-added twin stays out of a line whose photos are due", () => {
    const addTwin = (w: W) =>
      w.me.mutation(api.collection.addLineItem, {
        cardId: w.fx.gooden1,
        details: { quantity: 1, condition: "Near Mint", costCents: 10, location: "Shelf 2", homeId: w.boxId },
      });
    const lines = async (w: W) =>
      (await w.t.run((ctx) => ctx.db.query("collectionCopies").collect())).map((c) => c.quantity).sort();

    test("while they're on their way", async () => {
      const w = await one();
      await saved(w);
      await addTwin(w);
      expect(await lines(w)).toEqual([1, 1]);
    });

    test("after a failure, with Try again left", async () => {
      const w = await one();
      const { matchId } = await saved(w);
      await fail(w, matchId, "error");
      await addTwin(w);
      expect(await lines(w)).toEqual([1, 1]);
    });

    test("in a binder it takes the next pocket, rather than being refused the line's", async () => {
      const w = await one();
      await w.t.run((ctx) => ctx.db.patch(w.boxId, { kind: "binder" }));
      const { copyId } = await saved(w);
      const { copyId: twin } = await addTwin(w);
      expect(twin).not.toBe(copyId);
      const [a, b] = await w.t.run(async (ctx) => [await ctx.db.get(copyId), await ctx.db.get(twin)]);
      expect(a).toMatchObject({ slot: 0, quantity: 1 });
      expect(b).toMatchObject({ slot: 1, quantity: 1 });
    });

    test("through the box's quantity field too", async () => {
      const w = await one();
      const { copyId } = await saved(w);
      const acquiredOn = "2026-01-01";
      await w.t.run(async (ctx) => {
        const condition = await defaultConditionOf(ctx as never, ME.subject);
        await ctx.db.patch(copyId, { condition, acquiredOn, costCents: undefined, location: undefined });
      });
      await w.me.mutation(api.collectionInventory.setBoxQuantity, {
        cardId: w.fx.gooden1,
        boxId: w.boxId,
        quantity: 2,
        acquiredOn,
      });
      expect(await lines(w)).toEqual([1, 1]);
    });

    test("a line with no photo state folds as ever", async () => {
      const w = await one();
      const { copyId, matchId } = await saved(w);
      await w.t.run((ctx) => ctx.db.patch(matchId, { photos: undefined }));
      const { copyId: twin } = await addTwin(w);
      expect(twin).toBe(copyId);
      expect(await lines(w)).toEqual([2]);
    });
  });

  test("a failed tile stops asking when the copy leaves, or the collector makes it up by hand", async () => {
    const w = await one();
    const { runId, copyId, matchId } = await saved(w);
    // Aged-out scans asked for a photo: any one answers them.
    await fail(w, matchId, "scanGone");
    expect(await tile(w, runId)).toEqual({ photos: "failed", photoFailure: "scanGone" });
    await live(w, copyId, "back");
    expect(await tile(w, runId)).toEqual({ photos: "attached", photoFailure: undefined });
    // Try again asks for both sides: one is not enough.
    await fail(w, matchId, "error");
    expect(await tile(w, runId)).toEqual({ photos: "failed", photoFailure: "error" });
    await live(w, copyId, "front");
    expect(await tile(w, runId)).toEqual({ photos: "attached", photoFailure: undefined });
    await w.t.run(async (ctx) => {
      await ctx.db.delete(copyId);
    });
    expect(await tile(w, runId)).toEqual({ photos: undefined, photoFailure: undefined });
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

describe("NEO-370 — the listing gate on photo intake saves", () => {
  const syncOn = (w: Awaited<ReturnType<typeof world>>) =>
    w.t.run((ctx) =>
      ctx.db.insert("marketplaceListingStates", {
        ownerId: ME.subject,
        platform: "bsc",
        listingStartedAt: 1,
        lastUpdated: 0,
      }),
    );

  test("the run's price goes on the saved copy, so it lists at it", async () => {
    const w = await world([{ number: "1", players: ["Doc Gooden"] }]);
    await syncOn(w);
    const runId = await w.me.mutation(api.intakeRuns.createIntakeRun, {
      jobId: JOB,
      homeId: w.boxId,
      variantId: w.fx.baseId,
      defaults: { condition: "Near Mint", minPriceCents: 75 },
    });
    await drainScheduled(w.t);
    const { copyId } = await w.me.mutation(api.intakeRuns.saveIntakeMatch, {
      runId,
      pairId: w.pairIds[0],
      quantity: 1,
    });
    const copy = await w.t.run((ctx) => ctx.db.get(copyId));
    expect(copy).toMatchObject({ minPriceCents: 75, condition: "Near Mint", homeId: w.boxId });
  });

  test("a save into a listed box with the price taken off the run is refused, writing nothing", async () => {
    const w = await world([{ number: "1", players: ["Doc Gooden"] }]);
    await syncOn(w);
    const runId = await w.me.mutation(api.intakeRuns.createIntakeRun, {
      jobId: JOB,
      homeId: w.boxId,
      variantId: w.fx.baseId,
      defaults: { minPriceCents: 75 },
    });
    await drainScheduled(w.t);
    await w.me.mutation(api.intakeRuns.setIntakeRunDefaults, { runId, defaults: {} });
    await expect(
      w.me.mutation(api.intakeRuns.saveIntakeMatch, { runId, pairId: w.pairIds[0], quantity: 1 }),
    ).rejects.toThrow(/For sale sells on your marketplaces, so cards going in need a price first/);
    expect(await w.t.run((ctx) => ctx.db.query("collectionCopies").collect())).toEqual([]);
    // A per-card price answers it too.
    await w.me.mutation(api.intakeRuns.saveIntakeMatch, {
      runId,
      pairId: w.pairIds[0],
      quantity: 1,
      details: { minPriceCents: 30 },
    });
  });

  test("a collector who syncs nowhere saves into a box with no price, as before", async () => {
    const w = await world([{ number: "1", players: ["Doc Gooden"] }]);
    const runId = await startRun(w, w.fx.baseId);
    await w.me.mutation(api.intakeRuns.saveIntakeMatch, { runId, pairId: w.pairIds[0], quantity: 1 });
  });
});
