/**
 * NEO-446 — setting a loose photo aside on an intake run: who may, what is
 * refused, that it undoes, that pairing never picks the photo up, and that it
 * changes nothing about how the job is judged.
 */

import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { drainScheduled } from "../lib/testing/drain-scheduled";
import { seedCollectionCatalog } from "../lib/testing/collection-fixture";
import { intakePhotoPool } from "./intakePhotoPool";
import { computePairingDiff, type PairingImageRow } from "./placeholderPairing";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ME = { subject: "user_photoAsideMe01" };
const THEM = { subject: "user_photoAsideThem" };
const JOB = "job-photo-aside";

let harnesses: Array<ReturnType<typeof convexTest>> = [];
afterEach(async () => {
  for (const t of harnesses) await drainScheduled(t);
  harnesses = [];
});

type ImageFields = Partial<Doc<"placeholderImages">>;

/** One card's two sides, as the reader leaves them: same player, front and back. */
const FRONT: ImageFields = { status: "done", side: "front", players: ["Doc Gooden"], textCount: 5, pairStatus: "unmatched" };
const BACK: ImageFields = { status: "done", side: "back", players: ["Doc Gooden"], textCount: 80, cardNumber: "1", pairStatus: "unmatched" };

async function world(images: ImageFields[], job: Partial<Doc<"placeholderJobs">> = {}) {
  const t = convexTest(schema, modules);
  harnesses.push(t);
  // A run starts with its set picked (NEO-452).
  const fx = await seedCollectionCatalog(t);
  const homeId = await t.run(async (ctx) => {
    await ctx.db.insert("placeholderJobs", {
      jobId: JOB,
      userId: ME.subject,
      objectPath: `placeholders/${ME.subject}/${JOB}/`,
      createdAt: 0,
      mode: "stream",
      status: "succeeded",
      totalImages: images.length,
      processedImages: images.filter((i) => i.status === "done").length,
      failedImages: images.filter((i) => i.status === "failed").length,
      ...job,
    });
    for (const [entryIndex, image] of images.entries()) {
      await ctx.db.insert("placeholderImages", {
        jobId: JOB,
        userId: ME.subject,
        entryIndex,
        originalName: `scan-${entryIndex}.jpg`,
        status: "done",
        ...image,
      });
    }
    return await ctx.db.insert("collectionContainers", {
      ownerId: ME.subject,
      kind: "box",
      name: "For sale",
      lastUpdated: 0,
    });
  });
  const me = t.withIdentity(ME);
  // A box card saves with a price (NEO-481): the run's Min price gives one.
  const runId = await me.mutation(api.intakeRuns.createIntakeRun, {
    jobId: JOB,
    homeId,
    variantId: fx.baseId,
    defaults: { minPriceCents: 25 },
  });
  await drainScheduled(t);
  const aside = (entryIndex: number, setAside = true) =>
    me.mutation(api.intakeRuns.setIntakePhotoAside, { runId, entryIndex, setAside });
  const images_ = () =>
    t.run((ctx) =>
      ctx.db
        .query("placeholderImages")
        .withIndex("by_job_and_index", (q) => q.eq("jobId", JOB))
        .collect(),
    );
  const pairs = () =>
    t.run((ctx) =>
      ctx.db
        .query("placeholderPairs")
        .withIndex("by_job", (q) => q.eq("jobId", JOB))
        .collect(),
    );
  const jobRow = () =>
    t.run((ctx) =>
      ctx.db
        .query("placeholderJobs")
        .withIndex("by_job", (q) => q.eq("jobId", JOB))
        .unique(),
    );
  /** A later automatic pass: what any other photo finishing would schedule. */
  const repair = async () => {
    await t.action(internal.placeholderPairing.runPairing, { jobId: JOB, userId: ME.subject, final: false, force: true });
    await drainScheduled(t);
  };
  return { t, me, them: t.withIdentity(THEM), runId, aside, images: images_, pairs, jobRow, repair };
}

const insertPair = (w: Awaited<ReturnType<typeof world>>, frontIndex: number, backIndex: number) =>
  w.t.run((ctx) =>
    ctx.db.insert("placeholderPairs", {
      jobId: JOB,
      userId: ME.subject,
      frontIndex,
      backIndex,
      confidence: "side-only",
      mechanism: "adjacency",
      score: 0,
    }),
  );

describe("setIntakePhotoAside: who and what", () => {
  test("another collector and a signed-out caller are refused, and nothing is written", async () => {
    const w = await world([FRONT]);
    await expect(
      w.them.mutation(api.intakeRuns.setIntakePhotoAside, { runId: w.runId, entryIndex: 0, setAside: true }),
    ).rejects.toThrow(/not found/);
    await expect(
      w.t.mutation(api.intakeRuns.setIntakePhotoAside, { runId: w.runId, entryIndex: 0, setAside: true }),
    ).rejects.toThrow(/Not authenticated/);
    expect((await w.images())[0].setAside).toBeUndefined();
  });

  test("a photo of another job is out of reach: the run's own job is the only one read", async () => {
    const w = await world([FRONT]);
    await w.t.run((ctx) =>
      ctx.db.insert("placeholderImages", {
        jobId: "job-someone-else",
        userId: THEM.subject,
        entryIndex: 7,
        originalName: "theirs.jpg",
        status: "done",
      }),
    );
    await expect(w.aside(7)).rejects.toThrow(/Photo not found/);
  });

  test.each(["awaiting_upload", "queued", "processing"] as const)("refuses a %s photo", async (status) => {
    const w = await world([{ status, side: undefined }]);
    await expect(w.aside(0)).rejects.toThrow(/still being read/);
    expect((await w.images())[0].setAside).toBeUndefined();
  });

  test("refuses a photo in a pair, by the pair row and by its stamp", async () => {
    const w = await world([FRONT, BACK, { ...FRONT, pairStatus: "paired" }]);
    await insertPair(w, 0, 1);
    await expect(w.aside(0)).rejects.toThrow(/in a pair/);
    await expect(w.aside(1)).rejects.toThrow(/in a pair/);
    // Stored and stamped in separate transactions: either one alone is enough.
    await expect(w.aside(2)).rejects.toThrow(/in a pair/);
    expect((await w.images()).map((i) => i.setAside)).toEqual([undefined, undefined, undefined]);
  });

  test.each([
    ["done", FRONT],
    ["failed", { status: "failed", errorCode: "ENTRY_TOO_MANY_PIXELS" }],
  ] as const)("a %s loose photo sets aside and comes back", async (_status, image) => {
    const w = await world([image as ImageFields]);
    await w.aside(0);
    expect((await w.images())[0].setAside).toBe(true);
    const listed = await w.me.query(api.placeholderPipeline.listPlaceholderImages, { jobId: JOB });
    expect(listed[0].setAside).toBe(true);
    await w.aside(0, false);
    expect((await w.images())[0].setAside).toBeUndefined();
    await drainScheduled(w.t);
  });

  test("a second press changes nothing, and a stray bring-back on a photo not aside is harmless", async () => {
    const w = await world([FRONT]);
    await w.aside(0);
    await w.aside(0);
    expect((await w.images())[0].setAside).toBe(true);
    await w.aside(0, false);
    await w.aside(0, false);
    expect((await w.images())[0].setAside).toBeUndefined();
  });
});

describe("pairing never picks up a set-aside photo", () => {
  test("a later run leaves it out, and bringing it back pairs it", async () => {
    const w = await world([FRONT, BACK]);
    await w.aside(0);
    await w.repair();
    expect(await w.pairs()).toEqual([]);
    const after = await w.images();
    expect(after[0].setAside).toBe(true);
    expect(after.map((i) => i.pairStatus)).toEqual(["unmatched", "unmatched"]);

    // Bringing it back schedules the re-pair itself.
    await w.aside(0, false);
    await drainScheduled(w.t);
    expect((await w.pairs()).map((p) => [p.frontIndex, p.backIndex])).toEqual([[0, 1]]);
  });

  test("setting aside schedules no pairing of its own", async () => {
    const w = await world([FRONT, BACK]);
    await w.aside(0);
    await drainScheduled(w.t);
    expect(await w.pairs()).toEqual([]);
    expect((await w.images())[1].pairStatus).toBe("unmatched");
  });

  test("bringing back a failed photo schedules nothing: it can't pair", async () => {
    const w = await world([{ status: "failed", errorCode: "ENTRY_TOO_MANY_PIXELS" }, FRONT, BACK]);
    await w.aside(0);
    await w.aside(0, false);
    const scheduled = await w.t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled.filter((f) => f.name.includes("runPairing") && f.state.kind === "pending")).toEqual([]);
  });

  test("a pass that read the photo before it was set aside can't store the pair", async () => {
    const w = await world([FRONT, BACK, FRONT, BACK]);
    await w.aside(1);
    const result = await w.t.mutation(internal.placeholderPairing.applyPairDiff, {
      jobId: JOB,
      userId: ME.subject,
      final: false,
      force: true,
      deleteIds: [],
      patches: [],
      inserts: [
        { frontIndex: 0, backIndex: 1, confidence: "exact", mechanism: "pool", score: 1 },
        { frontIndex: 2, backIndex: 3, confidence: "exact", mechanism: "pool", score: 1 },
      ],
    });
    expect(result.skipped).toEqual([{ frontIndex: 0, backIndex: 1 }]);
    expect((await w.pairs()).map((p) => [p.frontIndex, p.backIndex])).toEqual([[2, 3]]);
  });

  test("the manual pair refuses either side, and pairs once it is back", async () => {
    const w = await world([FRONT, BACK]);
    await w.aside(1);
    const pairUp = (frontIndex: number, backIndex: number) =>
      w.me.mutation(api.placeholderPairing.manuallyPairPlaceholderImages, { jobId: JOB, frontIndex, backIndex });
    await expect(pairUp(0, 1)).rejects.toThrow(/set aside/);
    await expect(pairUp(1, 0)).rejects.toThrow(/set aside/);
    expect(await w.pairs()).toEqual([]);
    await w.aside(1, false);
    await drainScheduled(w.t);
    expect(await w.pairs()).toHaveLength(1);
  });

  describe("computePairingDiff", () => {
    const row = (entryIndex: number, side: "front" | "back", extra: Partial<PairingImageRow> = {}): PairingImageRow => ({
      _id: `img-${entryIndex}` as unknown as Id<"placeholderImages">,
      entryIndex,
      originalName: `scan-${entryIndex}.jpg`,
      side,
      textCount: side === "back" ? 80 : 5,
      ...extra,
    });
    const pairsOf = (rows: PairingImageRow[]) =>
      computePairingDiff(rows, []).insertRows.map((p) => [p.frontIndex, p.backIndex]);

    test("the adjacency fallback doesn't see it: two unread neighbours with one aside don't pair", () => {
      expect(pairsOf([row(0, "front"), row(1, "back")])).toEqual([[0, 1]]);
      expect(pairsOf([row(0, "front"), row(1, "back", { setAside: true })])).toEqual([]);
      expect(pairsOf([row(0, "front", { setAside: true }), row(1, "back")])).toEqual([]);
    });

    test("the identity pass doesn't see it", () => {
      const players = ["Doc Gooden"];
      expect(pairsOf([row(0, "front", { players }), row(5, "back", { players })])).toEqual([[0, 5]]);
      expect(pairsOf([row(0, "front", { players }), row(5, "back", { players, setAside: true })])).toEqual([]);
    });

    test("it still gets a verdict, and an already-stamped one costs no write", () => {
      const diff = computePairingDiff([row(0, "front", { setAside: true })], []);
      expect(diff.becomingUnmatched).toEqual(["img-0"]);
      const stamped = computePairingDiff([row(0, "front", { setAside: true, pairStatus: "unmatched" })], []);
      expect(stamped.becomingUnmatched).toEqual([]);
    });

    test("the rows either side of it still pair, as neighbours do once a card is gone", () => {
      expect(pairsOf([row(0, "front"), row(1, "front", { setAside: true }), row(2, "back")])).toEqual([[0, 2]]);
    });
  });
});

describe("a set-aside photo doesn't change how the job is judged", () => {
  const finish = async (w: Awaited<ReturnType<typeof world>>) => {
    await w.t.action(internal.placeholderPairing.runPairing, { jobId: JOB, userId: ME.subject, final: true });
    await drainScheduled(w.t);
    return await w.jobRow();
  };

  test("setting aside touches no job counter or status", async () => {
    const w = await world([FRONT, { status: "failed", errorCode: "ENTRY_TOO_MANY_PIXELS" }]);
    const before = await w.jobRow();
    await w.aside(0);
    await w.aside(1);
    expect(await w.jobRow()).toEqual(before);
  });

  test("still fails on too many failures, with the failed photos set aside", async () => {
    const failed: ImageFields = { status: "failed", errorCode: "ENTRY_TOO_MANY_PIXELS" };
    const w = await world([failed, failed, FRONT], { status: "pairing" });
    await w.aside(0);
    await w.aside(1);
    const job = await finish(w);
    expect(job).toMatchObject({ status: "failed", errorCode: "TOO_MANY_IMAGE_FAILURES", failedImages: 2, totalImages: 3 });
  });

  test("still succeeds with every done photo set aside", async () => {
    const w = await world([FRONT, BACK], { status: "pairing" });
    await w.aside(0);
    await w.aside(1);
    const job = await finish(w);
    expect(job).toMatchObject({ status: "succeeded", processedImages: 2, totalImages: 2 });
    expect(await w.pairs()).toEqual([]);
  });

  test("the inline finalize on close leaves it out and judges the same", async () => {
    const w = await world([FRONT, BACK], {
      status: "collecting",
      streamClosedBy: undefined,
    });
    await w.aside(1);
    await w.me.mutation(api.placeholderStream.closePlaceholderStream, { jobId: JOB });
    await drainScheduled(w.t);
    expect(await w.pairs()).toEqual([]);
    expect((await w.jobRow())?.status).toBe("succeeded");
    expect((await w.images())[1].setAside).toBe(true);
  });
});

/**
 * A saved card outlives the pairing that found it. A side-only pair stays fluid
 * for pairing, so a later pass that likes another partner would otherwise take
 * the pair away, and the sync would then drop the saved row with it.
 */
describe("a pair the collector has answered is settled", () => {
  // Front of a Strawberry, an unread back saved with it, and a second back that
  // names the same player: a better partner for the front, on identity.
  const NAMED_FRONT: ImageFields = { status: "done", side: "front", players: ["Darryl Strawberry"], textCount: 5, cardNumber: "2", pairStatus: "paired" };
  const UNREAD_BACK: ImageFields = { status: "done", side: "back", textCount: 80, pairStatus: "paired" };
  const NAMED_BACK: ImageFields = { status: "done", side: "back", players: ["Darryl Strawberry"], textCount: 80, cardNumber: "2", pairStatus: "unmatched" };

  /** The run's first pair (0, 1) side-only and matched to a card, photo 2 loose beside it. */
  async function answered(extraImages: ImageFields[] = [NAMED_BACK]) {
    vi.spyOn(intakePhotoPool, "enqueueAction").mockResolvedValue("work" as never);
    const t = convexTest(schema, modules);
    harnesses.push(t);
    const fx = await seedCollectionCatalog(t);
    const { homeId, pairId } = await t.run(async (ctx) => {
      await ctx.db.insert("placeholderJobs", {
        jobId: JOB,
        userId: ME.subject,
        objectPath: `placeholders/${ME.subject}/${JOB}/`,
        createdAt: 0,
        mode: "stream",
        status: "succeeded",
      });
      for (const [entryIndex, image] of [NAMED_FRONT, UNREAD_BACK, ...extraImages].entries()) {
        await ctx.db.insert("placeholderImages", {
          jobId: JOB,
          userId: ME.subject,
          entryIndex,
          originalName: `scan-${entryIndex}.jpg`,
          status: "done",
          ...image,
        });
      }
      const pairId = await ctx.db.insert("placeholderPairs", {
        jobId: JOB,
        userId: ME.subject,
        frontIndex: 0,
        backIndex: 1,
        confidence: "side-only",
        mechanism: "adjacency",
        score: 0,
      });
      const homeId = await ctx.db.insert("collectionContainers", {
        ownerId: ME.subject,
        kind: "box",
        name: "For sale",
        lastUpdated: 0,
      });
      return { homeId, pairId };
    });
    const me = t.withIdentity(ME);
    // A box card saves with a price (NEO-481): the run's Min price gives one.
    const runId = await me.mutation(api.intakeRuns.createIntakeRun, {
      jobId: JOB,
      homeId,
      variantId: fx.baseId,
      defaults: { minPriceCents: 25 },
    });
    await drainScheduled(t);
    const pairs = () =>
      t.run(async (ctx) =>
        (await ctx.db.query("placeholderPairs").withIndex("by_job", (q) => q.eq("jobId", JOB)).collect()).map((p) => [
          p.frontIndex,
          p.backIndex,
        ]),
      );
    const match = () => t.run((ctx) => ctx.db.query("intakeMatches").withIndex("by_pair", (q) => q.eq("pairId", pairId)).first());
    const copies = () => t.run(async (ctx) => (await ctx.db.query("collectionCopies").collect()).length);
    const repair = async () => {
      await t.action(internal.placeholderPairing.runPairing, { jobId: JOB, userId: ME.subject, final: false, force: true });
      await drainScheduled(t);
    };
    return { t, me, runId, pairId, pairs, match, copies, repair };
  }

  test("Bring back can't take a saved pair's front for the photo brought back", async () => {
    const w = await answered();
    await w.me.mutation(api.intakeRuns.setIntakePhotoAside, { runId: w.runId, entryIndex: 2, setAside: true });
    await w.me.mutation(api.intakeRuns.saveIntakeMatch, { runId: w.runId, pairId: w.pairId, quantity: 1 });
    await drainScheduled(w.t);
    expect((await w.match())?.savedAt).toBeDefined();
    expect(await w.copies()).toBe(1);

    await w.me.mutation(api.intakeRuns.setIntakePhotoAside, { runId: w.runId, entryIndex: 2, setAside: false });
    await drainScheduled(w.t);

    expect(await w.pairs()).toEqual([[0, 1]]);
    expect((await w.match())?.savedAt).toBeDefined();
    expect(await w.copies()).toBe(1);
    expect(await w.me.query(api.intakeRuns.listIntakeMatches, { runId: w.runId })).toHaveLength(1);
  });

  test("no other pass can either: a later run, and an identity edit", async () => {
    const w = await answered();
    await w.me.mutation(api.intakeRuns.saveIntakeMatch, { runId: w.runId, pairId: w.pairId, quantity: 1 });
    await drainScheduled(w.t);

    await w.repair();
    expect(await w.pairs()).toEqual([[0, 1]]);

    await w.me.mutation(api.placeholderPairing.updatePlaceholderImageIdentity, { jobId: JOB, entryIndex: 2, cardNumber: "3" });
    await drainScheduled(w.t);
    expect(await w.pairs()).toEqual([[0, 1]]);
    expect((await w.match())?.savedAt).toBeDefined();
  });

  // A pass that still wanted the saved front would have its write refused and pair
  // nothing, so what proves a pass read the hold is the second-best pair it makes.
  const SECOND_FRONT: ImageFields = { status: "done", side: "front", players: ["Darryl Strawberry"], textCount: 5, pairStatus: "unmatched" };

  test("a later run pairs around a saved pair, instead of wanting its front", async () => {
    const w = await answered([NAMED_BACK, SECOND_FRONT]);
    await w.me.mutation(api.intakeRuns.saveIntakeMatch, { runId: w.runId, pairId: w.pairId, quantity: 1 });
    await drainScheduled(w.t);
    await w.repair();
    expect(await w.pairs()).toEqual([[0, 1], [3, 2]]);
  });

  test("closing the stream pairs around it too", async () => {
    const w = await answered([NAMED_BACK, SECOND_FRONT]);
    await w.me.mutation(api.intakeRuns.saveIntakeMatch, { runId: w.runId, pairId: w.pairId, quantity: 1 });
    await drainScheduled(w.t);
    await w.t.run(async (ctx) => {
      const job = await ctx.db.query("placeholderJobs").withIndex("by_job", (q) => q.eq("jobId", JOB)).first();
      await ctx.db.patch(job!._id, { status: "collecting", totalImages: 4, processedImages: 4 });
    });
    await w.me.mutation(api.placeholderStream.closePlaceholderStream, { jobId: JOB });
    await drainScheduled(w.t);
    expect(await w.pairs()).toEqual([[0, 1], [3, 2]]);
    expect((await w.match())?.savedAt).toBeDefined();
  });

  test("a pair set aside holds the same way, and goes back to fluid when it's brought back", async () => {
    const w = await answered();
    await w.me.mutation(api.intakeRuns.setIntakeMatchAside, { runId: w.runId, pairId: w.pairId, setAside: true });
    await drainScheduled(w.t);
    await w.repair();
    expect(await w.pairs()).toEqual([[0, 1]]);
    expect((await w.match())?.setAside).toBe(true);

    await w.me.mutation(api.intakeRuns.setIntakeMatchAside, { runId: w.runId, pairId: w.pairId, setAside: false });
    await w.repair();
    expect(await w.pairs()).toEqual([[0, 2]]);
  });

  test("a pair nobody has answered stays fluid, as it always was", async () => {
    const w = await answered();
    await w.repair();
    expect(await w.pairs()).toEqual([[0, 2]]);
    expect(await w.match()).toBeNull();
  });

  test("a pass that read the pair before the save can't delete or rewrite it", async () => {
    const w = await answered();
    await w.me.mutation(api.intakeRuns.saveIntakeMatch, { runId: w.runId, pairId: w.pairId, quantity: 1 });
    await drainScheduled(w.t);
    const result = await w.t.mutation(internal.placeholderPairing.applyPairDiff, {
      jobId: JOB,
      userId: ME.subject,
      final: false,
      force: true,
      deleteIds: [w.pairId],
      patches: [{ pairId: w.pairId, confidence: "fuzzy", mechanism: "pool", score: 1 }],
      inserts: [],
    });
    expect(result).toMatchObject({ deleted: 0, revised: 0 });
    expect(await w.t.run((ctx) => ctx.db.get(w.pairId))).toMatchObject({ confidence: "side-only", mechanism: "adjacency" });
  });

  test("the sync never drops a saved row, even with its pair gone; an unsaved one still goes", async () => {
    const w = await answered();
    await w.me.mutation(api.intakeRuns.saveIntakeMatch, { runId: w.runId, pairId: w.pairId, quantity: 1 });
    await drainScheduled(w.t);
    await w.t.run((ctx) => ctx.db.delete(w.pairId));
    const result = await w.t.mutation(internal.intakeRuns.syncIntakeMatches, { runId: w.runId });
    expect(result.removed).toBe(0);
    expect((await w.match())?.savedAt).toBeDefined();
    expect(await w.me.query(api.intakeRuns.listIntakeMatches, { runId: w.runId })).toHaveLength(1);
  });

  test("the sync still drops an unsaved row whose pair is gone", async () => {
    const w = await answered();
    await w.t.run((ctx) => ctx.db.delete(w.pairId));
    const result = await w.t.mutation(internal.intakeRuns.syncIntakeMatches, { runId: w.runId });
    expect(result.removed).toBe(1);
    expect(await w.match()).toBeNull();
  });

  test("a person can still split an unsaved pair on purpose", async () => {
    const w = await answered();
    await w.me.mutation(api.placeholderPairing.unpairPlaceholderImages, { jobId: JOB, frontIndex: 0, backIndex: 1 });
    await drainScheduled(w.t);
    expect(await w.pairs()).not.toContainEqual([0, 1]);
    expect(await w.match()).toBeNull();
  });

  test("computePairingDiff leaves a held stored pair and its photos out", () => {
    const row = (entryIndex: number, side: "front" | "back", players?: string[]): PairingImageRow => ({
      _id: `img-${entryIndex}` as unknown as Id<"placeholderImages">,
      entryIndex,
      originalName: `scan-${entryIndex}.jpg`,
      side,
      textCount: side === "back" ? 80 : 5,
      players,
    });
    const rows = [row(0, "front", ["Doc Gooden"]), row(1, "back"), row(2, "back", ["Doc Gooden"])];
    const stored = {
      _id: "pair-1" as unknown as Id<"placeholderPairs">,
      frontIndex: 0,
      backIndex: 1,
      confidence: "side-only" as const,
      mechanism: "adjacency" as const,
      score: 0,
    };
    const fluid = computePairingDiff(rows, [stored]);
    expect(fluid.deleteIds).toEqual([stored._id]);
    const held = computePairingDiff(rows, [{ ...stored, heldByMatch: true }]);
    expect(held.deleteIds).toEqual([]);
    expect(held.patches).toEqual([]);
    expect(held.insertRows).toEqual([]);
  });
});
