/**
 * NEO-446 — setting a loose photo aside on an intake run: who may, what is
 * refused, that it undoes, that pairing never picks the photo up, and that it
 * changes nothing about how the job is judged.
 */

import { convexTest } from "convex-test";
import { afterEach, describe, expect, test } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { drainScheduled } from "../lib/testing/drain-scheduled";
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
  const runId = await me.mutation(api.intakeRuns.createIntakeRun, { jobId: JOB, homeId });
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
