/**
 * The provisional-pairing / Finish race: a debounced `runPairing` reads the
 * done rows and the stored pairs, then writes them in later transactions. A
 * `closePlaceholderStream` that commits inside that gap finalizes the batch
 * inline and stores the terminal pairs; the provisional run's stale diff then
 * used to land on top and pair the same images a second time (duplicate prints).
 *
 * Two independent guards close it, and each is pinned here on its own:
 *  - STATUS: a non-final write re-reads the job inside the mutation and returns
 *    `stale` once it has left the incremental statuses (`pairingRunMayWrite`).
 *  - ONE PAIR PER IMAGE: an insert whose image is already in a pair is skipped.
 *
 * The interleave is driven by hand (the action's own steps, one at a time) so
 * the gap is exactly where the test says it is. Lives at the convex/ root for
 * the module-registry reason given in placeholderPairing.incremental.test.ts.
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internalQuery } from "./_generated/server";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import * as pairingModule from "./placeholderPairing";
import { computePairingDiff, pairingRunMayWrite } from "./placeholderPairing";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const USER_A = { subject: "user_pairRaceAAAA" };
const GRIFFEY = { players: ["Ken Griffey Jr."], team: "Seattle Mariners" };

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

type T = ReturnType<typeof convexTest>;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function seedStreamJob(
  t: T,
  jobId: string,
  status: Doc<"placeholderJobs">["status"] = "collecting",
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("placeholderJobs", {
      jobId,
      userId: USER_A.subject,
      objectPath: `placeholders/${USER_A.subject}/${jobId}/`,
      createdAt: 1_700_000_000_000,
      status,
      mode: "stream",
      totalImages: 2,
      processedImages: 2,
      failedImages: 0,
      pairingScheduled: true,
    });
  });
}

/** Two done images forming an exact pair: entry 0 the front, entry 1 the back. */
async function seedExactPair(t: T, jobId: string) {
  await t.run(async (ctx) => {
    for (const [entryIndex, extra] of [
      [0, { textCount: 8 }],
      [1, { textCount: 120, cardNumber: "24" }],
    ] as const) {
      await ctx.db.insert("placeholderImages", {
        jobId,
        userId: USER_A.subject,
        entryIndex,
        originalName: `scan-${entryIndex}.jpg`,
        status: "done",
        ...GRIFFEY,
        ...extra,
      });
    }
  });
}

/** `count` done images with no identity, so the action itself pairs nothing. */
async function seedBlankImages(t: T, jobId: string, indexes: number[]) {
  await t.run(async (ctx) => {
    for (const entryIndex of indexes) {
      await ctx.db.insert("placeholderImages", {
        jobId,
        userId: USER_A.subject,
        entryIndex,
        originalName: `scan-${entryIndex}.jpg`,
        status: "done",
      });
    }
  });
}

async function seedPairRow(t: T, jobId: string, frontIndex: number, backIndex: number) {
  await t.run(async (ctx) => {
    await ctx.db.insert("placeholderPairs", {
      jobId,
      userId: USER_A.subject,
      frontIndex,
      backIndex,
      confidence: "exact",
      mechanism: "pool",
      score: 1,
    });
  });
}

const insertRow = (frontIndex: number, backIndex: number) => ({
  frontIndex,
  backIndex,
  confidence: "exact" as const,
  mechanism: "pool" as const,
  score: 1,
});

async function getPairs(t: T, jobId: string) {
  return t.run(async (ctx) => {
    const rows = await ctx.db.query("placeholderPairs").collect();
    return rows
      .filter((p) => p.jobId === jobId)
      .sort((a, b) => a.frontIndex - b.frontIndex || a.backIndex - b.backIndex);
  });
}

async function getImages(t: T, jobId: string) {
  return t.run(async (ctx) => {
    const rows = await ctx.db.query("placeholderImages").collect();
    return rows
      .filter((r) => r.jobId === jobId)
      .sort((a, b) => a.entryIndex - b.entryIndex);
  });
}

async function getJob(t: T, jobId: string) {
  return t.run(async (ctx) => {
    const jobs = await ctx.db.query("placeholderJobs").collect();
    return jobs.find((j) => j.jobId === jobId)!;
  });
}

async function setStatus(t: T, jobId: string, status: Doc<"placeholderJobs">["status"]) {
  const job = await getJob(t, jobId);
  await t.run(async (ctx) => ctx.db.patch(job._id, { status }));
}

function pairKeys(pairs: Doc<"placeholderPairs">[]) {
  return pairs.map((p) => `${p.frontIndex}:${p.backIndex}`);
}

/** Every `msg` line for one job (matched on `jobId`), parsed. */
function watchLogs(jobId: string, msgs: string[]) {
  const lines: Array<Record<string, unknown>> = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...logArgs: unknown[]) => {
    if (typeof logArgs[0] !== "string") return;
    try {
      const parsed = JSON.parse(logArgs[0]) as Record<string, unknown>;
      if (parsed.jobId === jobId && msgs.includes(parsed.msg as string)) {
        lines.push(parsed);
      }
    } catch {
      // Not a JSON log line; another file's output.
    }
  });
  return { lines, restore: () => spy.mockRestore() };
}

const applyDiff = (
  t: T,
  jobId: string,
  args: {
    final: boolean;
    force?: boolean;
    inserts?: Array<ReturnType<typeof insertRow>>;
    deleteIds?: Doc<"placeholderPairs">["_id"][];
  },
) =>
  t.mutation(internal.placeholderPairing.applyPairDiff, {
    jobId,
    userId: USER_A.subject,
    final: args.final,
    ...(args.force === undefined ? {} : { force: args.force }),
    deleteIds: args.deleteIds ?? [],
    patches: [],
    inserts: args.inserts ?? [],
  });

/**
 * The provisional run's read half: what `runPairing` fetched BEFORE the close
 * committed, handed to the pure diff.
 */
async function provisionalReads(t: T, jobId: string) {
  const rows = await t.query(internal.placeholderPipeline.listDoneImagesForPairing, { jobId });
  const stored = await t.query(internal.placeholderPairing.listPairsForDiff, { jobId });
  return computePairingDiff(rows, stored);
}

async function closeStream(t: T, jobId: string) {
  return t
    .withIdentity(USER_A)
    .mutation(api.placeholderStream.closePlaceholderStream, { jobId });
}

// ---------------------------------------------------------------------------
// The interleave
// ---------------------------------------------------------------------------

describe("a provisional run racing closePlaceholderStream", () => {
  test("a Finish that commits between the reads and the write leaves exactly one pair", async () => {
    const JOB = "job-race-provisional";
    const t = convexTest(schema, modules);
    await seedStreamJob(t, JOB);
    await seedExactPair(t, JOB);

    // 1. The provisional run reads, and sees nothing stored yet.
    const diff = await provisionalReads(t, JOB);
    expect(diff.insertRows).toHaveLength(1);

    // 2. Finish commits inside the gap and stores the terminal pair inline.
    expect(await closeStream(t, JOB)).toEqual({ closed: true, status: "succeeded" });
    expect(pairKeys(await getPairs(t, JOB))).toEqual(["0:1"]);

    // 3. The provisional run's write arrives late.
    const result = await applyDiff(t, JOB, { final: false, inserts: diff.insertRows });

    expect(result).toEqual({ stale: true, deleted: 0, revised: 0, inserted: 0, skipped: [] });
    const pairs = await getPairs(t, JOB);
    expect(pairs).toHaveLength(1);
    const entries = pairs.flatMap((p) => [p.frontIndex, p.backIndex]);
    expect(new Set(entries).size).toBe(entries.length);
  });

  test("the same late insert as a final run is not stale but is skipped, not stored", async () => {
    const JOB = "job-race-final-insert";
    const t = convexTest(schema, modules);
    await seedStreamJob(t, JOB);
    await seedExactPair(t, JOB);
    const diff = await provisionalReads(t, JOB);
    await closeStream(t, JOB);

    const result = await applyDiff(t, JOB, { final: true, inserts: diff.insertRows });

    expect(result).toEqual({
      stale: false,
      deleted: 0,
      revised: 0,
      inserted: 0,
      skipped: [{ frontIndex: 0, backIndex: 1 }],
    });
    expect(pairKeys(await getPairs(t, JOB))).toEqual(["0:1"]);
  });
});

// ---------------------------------------------------------------------------
// One pair per image
// ---------------------------------------------------------------------------

describe("applyPairDiff never pairs an image twice", () => {
  test("every chunk is checked: only the insert sharing no image with a stored pair lands", async () => {
    const JOB = "job-skip-every-chunk";
    const t = convexTest(schema, modules);
    await seedStreamJob(t, JOB, "processing");

    const first = await applyDiff(t, JOB, { final: false, inserts: [insertRow(0, 1)] });
    expect(first.inserted).toBe(1);

    const second = await applyDiff(t, JOB, {
      final: false,
      inserts: [insertRow(0, 2), insertRow(3, 1), insertRow(4, 5)],
    });

    expect(second.inserted).toBe(1);
    expect(second.skipped).toEqual([
      { frontIndex: 0, backIndex: 2 },
      { frontIndex: 3, backIndex: 1 },
    ]);
    expect(pairKeys(await getPairs(t, JOB))).toEqual(["0:1", "4:5"]);
  });

  test("within one call the first insert claims its images, so a rival is skipped", async () => {
    const JOB = "job-skip-within-call";
    const t = convexTest(schema, modules);
    await seedStreamJob(t, JOB, "processing");

    const result = await applyDiff(t, JOB, {
      final: false,
      inserts: [insertRow(0, 1), insertRow(0, 2)],
    });

    expect(result.inserted).toBe(1);
    expect(result.skipped).toEqual([{ frontIndex: 0, backIndex: 2 }]);
    expect(pairKeys(await getPairs(t, JOB))).toEqual(["0:1"]);
  });

  test("a delete and the insert that replaces it in one call: the insert is not skipped", async () => {
    const JOB = "job-skip-delete-then-insert";
    const t = convexTest(schema, modules);
    await seedStreamJob(t, JOB, "processing");
    await seedPairRow(t, JOB, 0, 2);
    const [old] = await getPairs(t, JOB);

    const result = await applyDiff(t, JOB, {
      final: false,
      deleteIds: [old._id],
      inserts: [insertRow(0, 1)],
    });

    expect(result).toMatchObject({ stale: false, deleted: 1, inserted: 1, skipped: [] });
    expect(pairKeys(await getPairs(t, JOB))).toEqual(["0:1"]);
  });
});

// ---------------------------------------------------------------------------
// The status gate
// ---------------------------------------------------------------------------

describe("the status gate inside the write mutations", () => {
  const STATUSES: Doc<"placeholderJobs">["status"][] = [
    "pending",
    "uploaded",
    "extracting",
    "collecting",
    "processing",
    "pairing",
    "succeeded",
    "failed",
  ];

  // The gate's own truth table, so a typo in either set shows up by name.
  const INCREMENTAL = ["collecting", "processing"];
  const FORCEABLE = ["collecting", "processing", "pairing", "succeeded", "failed"];

  test.each(STATUSES)("applyPairDiff on a %s job: provisional / forced / final", async (status) => {
    const t = convexTest(schema, modules);
    const outcomes: Record<string, boolean> = {};
    for (const [label, flags] of [
      ["provisional", { final: false }],
      ["forced", { final: false, force: true }],
      ["final", { final: true }],
    ] as const) {
      const JOB = `job-gate-diff-${status}-${label}`;
      await seedStreamJob(t, JOB, status);
      const r = await applyDiff(t, JOB, { ...flags, inserts: [insertRow(0, 1)] });
      outcomes[label] = !r.stale;
      expect(await getPairs(t, JOB)).toHaveLength(r.stale ? 0 : 1);
    }
    expect(outcomes).toEqual({
      provisional: INCREMENTAL.includes(status),
      forced: FORCEABLE.includes(status),
      final: true,
    });
  });

  test.each(STATUSES)("syncImagePairStatus on a %s job: provisional / forced / final", async (status) => {
    const t = convexTest(schema, modules);
    const outcomes: Record<string, boolean> = {};
    for (const [label, flags] of [
      ["provisional", { final: false }],
      ["forced", { final: false, force: true }],
      ["final", { final: true }],
    ] as const) {
      const JOB = `job-gate-sync-${status}-${label}`;
      await seedStreamJob(t, JOB, status);
      await seedBlankImages(t, JOB, [0]);
      const [img] = await getImages(t, JOB);
      const r = await t.mutation(internal.placeholderPairing.syncImagePairStatus, {
        jobId: JOB,
        pairStatus: "unmatched",
        imageIds: [img._id],
        ...flags,
      });
      outcomes[label] = !r.stale;
      expect(r.marked).toBe(r.stale ? 0 : 1);
      expect((await getImages(t, JOB))[0].pairStatus).toBe(r.stale ? undefined : "unmatched");
    }
    expect(outcomes).toEqual({
      provisional: INCREMENTAL.includes(status),
      forced: FORCEABLE.includes(status),
      final: true,
    });
  });

  test("a deleted job is stale for a non-final write and writes nothing", async () => {
    const t = convexTest(schema, modules);
    const r = await applyDiff(t, "job-never-existed", { final: false, inserts: [insertRow(0, 1)] });
    expect(r.stale).toBe(true);
    expect(await getPairs(t, "job-never-existed")).toHaveLength(0);
  });

  test("pairingRunMayWrite agrees with the mutations on the statuses that matter", () => {
    expect(pairingRunMayWrite("succeeded", { final: false })).toBe(false);
    expect(pairingRunMayWrite("succeeded", { final: false, force: true })).toBe(true);
    expect(pairingRunMayWrite("pending", { final: false, force: true })).toBe(false);
    expect(pairingRunMayWrite("pending", { final: true })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// syncImagePairStatus reads the pairs table
// ---------------------------------------------------------------------------

describe("syncImagePairStatus stamps what the pairs table says", () => {
  test("an image with no stored pair is not stamped paired; one with a pair is not stamped unmatched", async () => {
    const JOB = "job-sync-table";
    const t = convexTest(schema, modules);
    await seedStreamJob(t, JOB, "processing");
    await seedBlankImages(t, JOB, [0, 1, 2, 3]);
    await seedPairRow(t, JOB, 0, 1); // 0 and 1 are paired; 2 and 3 are not.
    const ids = (await getImages(t, JOB)).map((i) => i._id);
    const sync = (pairStatus: "paired" | "unmatched", imageIds: typeof ids) =>
      t.mutation(internal.placeholderPairing.syncImagePairStatus, {
        jobId: JOB,
        final: false,
        pairStatus,
        imageIds,
      });

    // Wrong direction both ways: refused, nothing stamped.
    expect((await sync("paired", [ids[2], ids[3]])).marked).toBe(0);
    expect((await sync("unmatched", [ids[0], ids[1]])).marked).toBe(0);
    expect((await getImages(t, JOB)).map((i) => i.pairStatus)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);

    // Right direction both ways: stamped.
    expect((await sync("paired", [ids[0], ids[1]])).marked).toBe(2);
    expect((await sync("unmatched", [ids[2], ids[3]])).marked).toBe(2);
    expect((await getImages(t, JOB)).map((i) => i.pairStatus)).toEqual([
      "paired",
      "paired",
      "unmatched",
      "unmatched",
    ]);
  });
});

// ---------------------------------------------------------------------------
// The action
// ---------------------------------------------------------------------------

describe("runPairing", () => {
  test("a provisional run on a succeeded job writes nothing", async () => {
    const JOB = "job-run-succeeded";
    const t = convexTest(schema, modules);
    await seedStreamJob(t, JOB, "succeeded");
    await seedExactPair(t, JOB);

    await t.action(internal.placeholderPairing.runPairing, {
      jobId: JOB,
      userId: USER_A.subject,
      final: false,
    });

    expect(await getPairs(t, JOB)).toHaveLength(0);
    expect((await getImages(t, JOB)).map((i) => i.pairStatus)).toEqual([undefined, undefined]);
    expect((await getJob(t, JOB)).status).toBe("succeeded");
  });
});

// ---------------------------------------------------------------------------
// Logs describe what was stored
// ---------------------------------------------------------------------------

describe("logs when an insert is skipped", () => {
  /**
   * The run reads the stored pairs through a stand-in that reports none, while
   * the pair is really there: the same view a run has when the other writer
   * commits after its read.
   */
  function harnessWithBlindStoredRead() {
    return convexTest(schema, {
      ...modules,
      "./placeholderPairing.ts": async () => ({
        ...pairingModule,
        listPairsForDiff: internalQuery({
          handler: async () => [],
        }),
      }),
    });
  }

  test("no pair_decided for the skipped insert; the done line reports skipped and a reduced inserted", async () => {
    const JOB = "job-log-skipped";
    const t = harnessWithBlindStoredRead();
    await seedStreamJob(t, JOB, "collecting");
    await seedExactPair(t, JOB);
    await seedPairRow(t, JOB, 0, 1);
    const watch = watchLogs(JOB, ["placeholder_pair_decided", "placeholder_pairing_done"]);

    try {
      await t.action(internal.placeholderPairing.runPairing, {
        jobId: JOB,
        userId: USER_A.subject,
        final: false,
      });
    } finally {
      watch.restore();
    }

    expect(watch.lines.filter((l) => l.msg === "placeholder_pair_decided")).toEqual([]);
    const done = watch.lines.filter((l) => l.msg === "placeholder_pairing_done");
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ inserted: 0, skipped: 1 });
    expect(pairKeys(await getPairs(t, JOB))).toEqual(["0:1"]);
  });

  test("with nothing skipped the decision is logged and skipped is 0", async () => {
    const JOB = "job-log-not-skipped";
    const t = convexTest(schema, modules);
    await seedStreamJob(t, JOB, "collecting");
    await seedExactPair(t, JOB);
    const watch = watchLogs(JOB, ["placeholder_pair_decided", "placeholder_pairing_done"]);

    try {
      await t.action(internal.placeholderPairing.runPairing, {
        jobId: JOB,
        userId: USER_A.subject,
        final: false,
      });
    } finally {
      watch.restore();
    }

    expect(watch.lines.filter((l) => l.msg === "placeholder_pair_decided")).toHaveLength(1);
    expect(watch.lines.find((l) => l.msg === "placeholder_pairing_done")).toMatchObject({
      inserted: 1,
      skipped: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// Manual pairing
// ---------------------------------------------------------------------------

describe("manuallyPairPlaceholderImages and the pairs table", () => {
  test("refuses an image that is in a stored pair although its pairStatus is unset", async () => {
    const JOB = "job-manual-table";
    const t = convexTest(schema, modules);
    await seedStreamJob(t, JOB, "succeeded");
    await seedBlankImages(t, JOB, [0, 1, 2]);
    await seedPairRow(t, JOB, 0, 1);
    expect((await getImages(t, JOB)).map((i) => i.pairStatus)).toEqual([undefined, undefined, undefined]);

    await expect(
      t.withIdentity(USER_A).mutation(api.placeholderPairing.manuallyPairPlaceholderImages, {
        jobId: JOB,
        frontIndex: 2,
        backIndex: 1,
      }),
    ).rejects.toThrow(/already paired/i);
    await expect(
      t.withIdentity(USER_A).mutation(api.placeholderPairing.manuallyPairPlaceholderImages, {
        jobId: JOB,
        frontIndex: 0,
        backIndex: 2,
      }),
    ).rejects.toThrow(/already paired/i);
    expect(pairKeys(await getPairs(t, JOB))).toEqual(["0:1"]);
  });
});
