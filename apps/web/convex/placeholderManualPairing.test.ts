/**
 * Manual correction surface tests (NEO-152).
 *
 * The model misreads identities, and before this there was no way to fix a pair
 * or force one. These three mutations restore that control, and the crux — the
 * thing that makes this correctness-critical rather than a convenience — is that
 * a MANUAL pair must survive the automatic `runPairing` re-runs, which recompute
 * `pairBatch` from scratch and diff. A naive manual pair row would be deleted by
 * the next auto-diff. This suite pins:
 *
 *   - the Acuña case end to end: correct a misread front name → identity-first
 *     auto-pairs it to its real back on the scheduled re-run;
 *   - a manual pair of two identity-DISAGREEING images survives a subsequent
 *     automatic run (property (a): never deleted; property (b): never re-paired
 *     to their identity twins; property (c): everything else re-pairs freely);
 *   - unpair frees both for re-pairing;
 *   - the guards (already-paired refusal, done-only, caps, ownership/auth).
 *
 * The "survives the diff" property is additionally mutation-tested from the
 * shell (break the `autoStored` exclusion → the manual pair is deleted).
 *
 * Fixtures use ambiguous text counts (4 front / 6 back) so the SIDE comes from
 * the count while IDENTITY drives the pairing — the same convention as
 * placeholderPairing.incremental.test.ts.
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const USER_A = { subject: "user_manualAAAA1111" };
const USER_B = { subject: "user_manualBBBB2222" };

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type ImageSpec = {
  players?: string[];
  team?: string;
  cardNumber?: string;
  textCount: number;
};

const FRONT = (players: string[], team: string): ImageSpec => ({
  players,
  team,
  textCount: 4,
});
const BACK = (players: string[], team: string, cardNumber: string): ImageSpec => ({
  players,
  team,
  cardNumber,
  textCount: 6,
});

async function seedJob(
  t: ReturnType<typeof convexTest>,
  jobId: string,
  overrides: Partial<{
    userId: string;
    status: string;
    totalImages: number;
    processedImages: number;
    failedImages: number;
  }> = {},
) {
  const userId = overrides.userId ?? USER_A.subject;
  await t.run(async (ctx) => {
    await ctx.db.insert("placeholderJobs", {
      jobId,
      userId,
      objectPath: `placeholders/${userId}/${jobId}/input.zip`,
      createdAt: 1_700_000_000_000,
      status: (overrides.status ?? "pairing") as Doc<"placeholderJobs">["status"],
      totalImages: overrides.totalImages ?? 0,
      processedImages: overrides.processedImages ?? 0,
      failedImages: overrides.failedImages ?? 0,
    });
  });
}

async function seedDone(
  t: ReturnType<typeof convexTest>,
  jobId: string,
  entryIndex: number,
  spec: ImageSpec,
  userId = USER_A.subject,
): Promise<Id<"placeholderImages">> {
  return t.run(async (ctx) =>
    ctx.db.insert("placeholderImages", {
      jobId,
      userId,
      entryIndex,
      originalName: `scan-${entryIndex}.jpg`,
      status: "done",
      players: spec.players,
      team: spec.team,
      cardNumber: spec.cardNumber,
      textCount: spec.textCount,
    }),
  );
}

async function getJob(t: ReturnType<typeof convexTest>, jobId: string) {
  return t.run(async (ctx) => {
    const jobs = await ctx.db.query("placeholderJobs").collect();
    return jobs.find((j) => j.jobId === jobId) ?? null;
  });
}

async function getImages(t: ReturnType<typeof convexTest>, jobId: string) {
  return t.run(async (ctx) => {
    const rows = await ctx.db.query("placeholderImages").collect();
    return rows.filter((r) => r.jobId === jobId).sort((a, b) => a.entryIndex - b.entryIndex);
  });
}

async function getPairs(t: ReturnType<typeof convexTest>, jobId: string) {
  return t.run(async (ctx) => {
    const rows = await ctx.db.query("placeholderPairs").collect();
    return rows
      .filter((p) => p.jobId === jobId)
      .sort((a, b) => a.frontIndex - b.frontIndex || a.backIndex - b.backIndex);
  });
}

async function drain(t: ReturnType<typeof convexTest>) {
  await t.finishAllScheduledFunctions(vi.runAllTimers);
}

/** Establish the initial automatic pairing (as the batch's final run would). */
async function runAuto(
  t: ReturnType<typeof convexTest>,
  jobId: string,
  userId = USER_A.subject,
  final = true,
) {
  await t.action(internal.placeholderPairing.runPairing, { jobId, userId, final });
}

// A cast to reach the mutations regardless of codegen lag on this branch.
const P = api.placeholderPairing as unknown as {
  updatePlaceholderImageIdentity: typeof api.placeholderPairing.updatePlaceholderImageIdentity;
  manuallyPairPlaceholderImages: typeof api.placeholderPairing.manuallyPairPlaceholderImages;
  unpairPlaceholderImages: typeof api.placeholderPairing.unpairPlaceholderImages;
};

// ---------------------------------------------------------------------------
// updatePlaceholderImageIdentity — the Acuña case
// ---------------------------------------------------------------------------

describe("updatePlaceholderImageIdentity", () => {
  test("correcting a misread front name auto-pairs it to its real back", async () => {
    // The exact reported gap. The front is misread as "Moises Alou Jr", so it
    // does NOT match the "Ronald Acuña" back and the batch finishes with both
    // unmatched. Fixing the name re-pairs them by identity on the scheduled run,
    // even though the job has already succeeded.
    const JOB = "job-acuna";
    const t = convexTest(schema, modules);
    await seedJob(t, JOB, { totalImages: 2, processedImages: 2 });
    await seedDone(t, JOB, 0, FRONT(["Moises Alou Jr"], "Atlanta Braves"));
    await seedDone(t, JOB, 1, BACK(["Ronald Acuña"], "Atlanta Braves", "MA-2"));

    await runAuto(t, JOB); // final → succeeds the job
    expect((await getJob(t, JOB))?.status).toBe("succeeded");
    expect(await getPairs(t, JOB)).toHaveLength(0);
    expect((await getImages(t, JOB)).every((i) => i.pairStatus === "unmatched")).toBe(true);

    const result = await t
      .withIdentity(USER_A)
      .mutation(P.updatePlaceholderImageIdentity, {
        jobId: JOB,
        entryIndex: 0,
        players: ["Ronald Acuña"],
      });
    // The returned row reflects the correction.
    expect(result.players).toEqual(["Ronald Acuña"]);
    expect(result.entryIndex).toBe(0);

    await drain(t); // the scheduled force re-pair runs

    const pairs = await getPairs(t, JOB);
    expect(pairs).toHaveLength(1);
    expect([pairs[0].frontIndex, pairs[0].backIndex]).toEqual([0, 1]);
    expect(pairs[0].mechanism).toBe("pool");
    expect(pairs[0].player).toBe("Ronald Acuña");
    expect(pairs[0].cardNumber).toBe("MA-2");
    // The job stays succeeded — a force re-pair never runs the terminal decision.
    expect((await getJob(t, JOB))?.status).toBe("succeeded");
    expect((await getImages(t, JOB)).map((i) => i.pairStatus)).toEqual(["paired", "paired"]);
  });

  test("only patches the fields provided, and clears with an empty value", async () => {
    const JOB = "job-edit-partial";
    const t = convexTest(schema, modules);
    await seedJob(t, JOB, { totalImages: 1, processedImages: 1 });
    await seedDone(t, JOB, 0, {
      players: ["Wrong Name"],
      team: "Old Team",
      cardNumber: "9",
      textCount: 6,
    });

    // Provide only team; players/cardNumber untouched.
    await t.withIdentity(USER_A).mutation(P.updatePlaceholderImageIdentity, {
      jobId: JOB,
      entryIndex: 0,
      team: "New Team",
    });
    let row = (await getImages(t, JOB))[0];
    expect(row.team).toBe("New Team");
    expect(row.players).toEqual(["Wrong Name"]); // left alone
    expect(row.cardNumber).toBe("9"); // left alone

    // An empty array / empty string CLEARS.
    await t.withIdentity(USER_A).mutation(P.updatePlaceholderImageIdentity, {
      jobId: JOB,
      entryIndex: 0,
      players: [],
      cardNumber: "",
    });
    row = (await getImages(t, JOB))[0];
    expect(row.players).toBeUndefined();
    expect(row.cardNumber).toBeUndefined();
    expect(row.team).toBe("New Team"); // still there
  });

  test("enforces the ingestion caps (≤8 players, strings sliced to 200)", async () => {
    const JOB = "job-edit-caps";
    const t = convexTest(schema, modules);
    await seedJob(t, JOB, { totalImages: 1, processedImages: 1 });
    await seedDone(t, JOB, 0, { players: ["x"], textCount: 6 });

    await t.withIdentity(USER_A).mutation(P.updatePlaceholderImageIdentity, {
      jobId: JOB,
      entryIndex: 0,
      players: Array.from({ length: 20 }, (_, i) => `${"p".repeat(500)}-${i}`),
      team: "t".repeat(900),
      cardNumber: "9".repeat(900),
    });

    const row = (await getImages(t, JOB))[0];
    expect(row.players).toHaveLength(8);
    expect(row.players?.every((p) => p.length === 200)).toBe(true);
    expect(row.team).toHaveLength(200);
    expect(row.cardNumber).toHaveLength(200);
  });

  test("refuses an image that is not done", async () => {
    const JOB = "job-edit-notdone";
    const t = convexTest(schema, modules);
    await seedJob(t, JOB, { status: "processing", totalImages: 1 });
    await t.run(async (ctx) => {
      await ctx.db.insert("placeholderImages", {
        jobId: JOB,
        userId: USER_A.subject,
        entryIndex: 0,
        originalName: "scan-0.jpg",
        status: "processing",
      });
    });
    await expect(
      t.withIdentity(USER_A).mutation(P.updatePlaceholderImageIdentity, {
        jobId: JOB,
        entryIndex: 0,
        players: ["X"],
      }),
    ).rejects.toThrow(/not processed/i);
  });
});

// ---------------------------------------------------------------------------
// manuallyPairPlaceholderImages — the sticky-pair crux
// ---------------------------------------------------------------------------

describe("manuallyPairPlaceholderImages", () => {
  test("forces a pair between identity-disagreeing images, merged front/back", async () => {
    const JOB = "job-manual-basic";
    const t = convexTest(schema, modules);
    await seedJob(t, JOB, { totalImages: 2, processedImages: 2 });
    await seedDone(t, JOB, 0, FRONT(["No Readable Name"], "Team A"));
    await seedDone(t, JOB, 1, BACK(["Different Name"], "Team B", "77"));
    await runAuto(t, JOB);
    // They disagree, so auto left them unmatched.
    expect(await getPairs(t, JOB)).toHaveLength(0);

    const result = await t
      .withIdentity(USER_A)
      .mutation(P.manuallyPairPlaceholderImages, {
        jobId: JOB,
        frontIndex: 0,
        backIndex: 1,
      });
    expect(result).toEqual({ paired: true, frontIndex: 0, backIndex: 1 });

    const pairs = await getPairs(t, JOB);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].mechanism).toBe("manual");
    expect(pairs[0].confidence).toBe("side-only");
    expect(pairs[0].score).toBe(0);
    // Merged: front player, back card number.
    expect(pairs[0].player).toBe("No Readable Name");
    expect(pairs[0].cardNumber).toBe("77");
    expect((await getImages(t, JOB)).map((i) => i.pairStatus)).toEqual(["paired", "paired"]);
  });

  test("a manual pair SURVIVES a subsequent automatic run, and its images are not re-paired", async () => {
    // The load-bearing property. Four images that would auto-pair as
    // 0-1 (Acuña) and 2-3 (Bonds). The user instead forces 0-3 (Acuña front +
    // Bonds back). After a fresh automatic run: the manual pair must still be
    // there, its images must NOT have been pulled back to their identity twins,
    // and the freed twins (1 and 2) must be free to (fail to) re-pair.
    const JOB = "job-manual-survives";
    const t = convexTest(schema, modules);
    await seedJob(t, JOB, { totalImages: 4, processedImages: 4 });
    await seedDone(t, JOB, 0, FRONT(["Ronald Acuña"], "Atlanta Braves"));
    await seedDone(t, JOB, 1, BACK(["Ronald Acuña"], "Atlanta Braves", "1"));
    await seedDone(t, JOB, 2, FRONT(["Barry Bonds"], "San Francisco Giants"));
    await seedDone(t, JOB, 3, BACK(["Barry Bonds"], "San Francisco Giants", "2"));
    await runAuto(t, JOB);
    // Auto paired 0-1 and 2-3.
    expect((await getPairs(t, JOB)).map((p) => [p.frontIndex, p.backIndex])).toEqual([
      [0, 1],
      [2, 3],
    ]);

    // Unpair both, then force the cross pair 0-3.
    await t.withIdentity(USER_A).mutation(P.unpairPlaceholderImages, { jobId: JOB, frontIndex: 0, backIndex: 1 });
    await t.withIdentity(USER_A).mutation(P.unpairPlaceholderImages, { jobId: JOB, frontIndex: 2, backIndex: 3 });
    await t.withIdentity(USER_A).mutation(P.manuallyPairPlaceholderImages, { jobId: JOB, frontIndex: 0, backIndex: 3 });

    const beforeAuto = await getPairs(t, JOB);
    expect(beforeAuto).toHaveLength(1);
    expect([beforeAuto[0].frontIndex, beforeAuto[0].backIndex]).toEqual([0, 3]);
    const manualId = beforeAuto[0]._id;

    // A full automatic run — the exact thing that must not disturb the manual pair.
    await runAuto(t, JOB);

    const afterAuto = await getPairs(t, JOB);
    // (a) the manual pair is still there, same row (not deleted+reinserted).
    expect(afterAuto).toHaveLength(1);
    expect([afterAuto[0].frontIndex, afterAuto[0].backIndex]).toEqual([0, 3]);
    expect(afterAuto[0]._id).toBe(manualId);
    expect(afterAuto[0].mechanism).toBe("manual");
    // (b) image 0 was NOT re-paired to its identity twin (back 1).
    const images = await getImages(t, JOB);
    const byIndex = new Map(images.map((i) => [i.entryIndex, i]));
    expect(byIndex.get(0)?.pairStatus).toBe("paired");
    expect(byIndex.get(3)?.pairStatus).toBe("paired");
    // (c) the freed twins are back in auto — and correctly stay unmatched
    // (Acuña back 1 and Bonds front 2 disagree).
    expect(byIndex.get(1)?.pairStatus).toBe("unmatched");
    expect(byIndex.get(2)?.pairStatus).toBe("unmatched");
  });

  test("refuses to pair an already-paired image", async () => {
    const JOB = "job-manual-refuse";
    const t = convexTest(schema, modules);
    await seedJob(t, JOB, { totalImages: 3, processedImages: 3 });
    await seedDone(t, JOB, 0, FRONT(["Ronald Acuña"], "Atlanta Braves"));
    await seedDone(t, JOB, 1, BACK(["Ronald Acuña"], "Atlanta Braves", "1"));
    await seedDone(t, JOB, 2, BACK(["Someone Else"], "Team X", "2"));
    await runAuto(t, JOB); // pairs 0-1
    expect((await getPairs(t, JOB)).map((p) => [p.frontIndex, p.backIndex])).toEqual([[0, 1]]);

    // 0 is already paired to 1 → cannot force 0-2.
    await expect(
      t.withIdentity(USER_A).mutation(P.manuallyPairPlaceholderImages, {
        jobId: JOB,
        frontIndex: 0,
        backIndex: 2,
      }),
    ).rejects.toThrow(/already paired/i);
    // Nothing changed.
    expect((await getPairs(t, JOB)).map((p) => [p.frontIndex, p.backIndex])).toEqual([[0, 1]]);
  });

  test("refuses an image that is not done, and refuses self-pairing", async () => {
    const JOB = "job-manual-guards";
    const t = convexTest(schema, modules);
    await seedJob(t, JOB, { totalImages: 2, processedImages: 1, failedImages: 1 });
    await seedDone(t, JOB, 0, FRONT(["A"], "T"));
    await t.run(async (ctx) => {
      await ctx.db.insert("placeholderImages", {
        jobId: JOB,
        userId: USER_A.subject,
        entryIndex: 1,
        originalName: "scan-1.jpg",
        status: "failed",
      });
    });

    await expect(
      t.withIdentity(USER_A).mutation(P.manuallyPairPlaceholderImages, { jobId: JOB, frontIndex: 0, backIndex: 1 }),
    ).rejects.toThrow(/must be processed/i);
    await expect(
      t.withIdentity(USER_A).mutation(P.manuallyPairPlaceholderImages, { jobId: JOB, frontIndex: 0, backIndex: 0 }),
    ).rejects.toThrow(/itself/i);
  });
});

// ---------------------------------------------------------------------------
// unpairPlaceholderImages
// ---------------------------------------------------------------------------

describe("unpairPlaceholderImages", () => {
  test("breaks an automatic pair and frees both images for re-pairing", async () => {
    const JOB = "job-unpair-auto";
    const t = convexTest(schema, modules);
    await seedJob(t, JOB, { totalImages: 2, processedImages: 2 });
    await seedDone(t, JOB, 0, FRONT(["Ronald Acuña"], "Atlanta Braves"));
    await seedDone(t, JOB, 1, BACK(["Ronald Acuña"], "Atlanta Braves", "1"));
    await runAuto(t, JOB);
    expect(await getPairs(t, JOB)).toHaveLength(1);

    const result = await t
      .withIdentity(USER_A)
      .mutation(P.unpairPlaceholderImages, { jobId: JOB, frontIndex: 0, backIndex: 1 });
    expect(result).toEqual({ unpaired: true, wasManual: false });
    await drain(t);

    // The pair is gone and both are unmatched...
    expect(await getPairs(t, JOB)).toHaveLength(0);
    expect((await getImages(t, JOB)).every((i) => i.pairStatus === "unmatched")).toBe(true);

    // ...but eligible: a subsequent automatic run re-pairs them (they still match).
    await runAuto(t, JOB);
    expect((await getPairs(t, JOB)).map((p) => [p.frontIndex, p.backIndex])).toEqual([[0, 1]]);
  });

  test("breaks a manual pair, clearing the mark so the images re-enter auto", async () => {
    const JOB = "job-unpair-manual";
    const t = convexTest(schema, modules);
    await seedJob(t, JOB, { totalImages: 2, processedImages: 2 });
    await seedDone(t, JOB, 0, FRONT(["Ronald Acuña"], "Atlanta Braves"));
    await seedDone(t, JOB, 1, BACK(["Ronald Acuña"], "Atlanta Braves", "1"));
    await runAuto(t, JOB);
    await t.withIdentity(USER_A).mutation(P.unpairPlaceholderImages, { jobId: JOB, frontIndex: 0, backIndex: 1 });
    await drain(t);
    await t.withIdentity(USER_A).mutation(P.manuallyPairPlaceholderImages, { jobId: JOB, frontIndex: 1, backIndex: 0 });
    // (manual pair keyed front=1, back=0 — the caller's orientation)
    expect((await getPairs(t, JOB))[0].mechanism).toBe("manual");

    const result = await t
      .withIdentity(USER_A)
      .mutation(P.unpairPlaceholderImages, { jobId: JOB, frontIndex: 1, backIndex: 0 });
    expect(result).toEqual({ unpaired: true, wasManual: true });
    await drain(t);
    expect(await getPairs(t, JOB)).toHaveLength(0);

    // The manual mark is gone (the row WAS the mark) — a fresh auto run now
    // treats them as ordinary images and pairs them by identity.
    await runAuto(t, JOB);
    const pairs = await getPairs(t, JOB);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].mechanism).toBe("pool");
  });

  test("refuses to unpair a pair that does not exist", async () => {
    const JOB = "job-unpair-missing";
    const t = convexTest(schema, modules);
    await seedJob(t, JOB, { totalImages: 2, processedImages: 2 });
    await seedDone(t, JOB, 0, FRONT(["A"], "T"));
    await seedDone(t, JOB, 1, BACK(["A"], "T", "1"));
    await expect(
      t.withIdentity(USER_A).mutation(P.unpairPlaceholderImages, { jobId: JOB, frontIndex: 0, backIndex: 1 }),
    ).rejects.toThrow(/pair not found/i);
  });
});

// ---------------------------------------------------------------------------
// Ownership / auth — all three
// ---------------------------------------------------------------------------

describe("ownership and auth", () => {
  async function seedPairedJob(t: ReturnType<typeof convexTest>, jobId: string) {
    await seedJob(t, jobId, { totalImages: 2, processedImages: 2 });
    await seedDone(t, jobId, 0, FRONT(["Ronald Acuña"], "Atlanta Braves"));
    await seedDone(t, jobId, 1, BACK(["Ronald Acuña"], "Atlanta Braves", "1"));
    await runAuto(t, jobId);
  }

  test("another user cannot edit identity, manual-pair, or unpair — indistinguishable from missing", async () => {
    const JOB = "job-owner";
    const t = convexTest(schema, modules);
    await seedPairedJob(t, JOB);

    for (const call of [
      () => t.withIdentity(USER_B).mutation(P.updatePlaceholderImageIdentity, { jobId: JOB, entryIndex: 0, players: ["X"] }),
      () => t.withIdentity(USER_B).mutation(P.manuallyPairPlaceholderImages, { jobId: JOB, frontIndex: 0, backIndex: 1 }),
      () => t.withIdentity(USER_B).mutation(P.unpairPlaceholderImages, { jobId: JOB, frontIndex: 0, backIndex: 1 }),
    ]) {
      await expect(call()).rejects.toThrow(/job not found/i);
    }
    // USER_A's data is untouched.
    expect((await getPairs(t, JOB)).map((p) => [p.frontIndex, p.backIndex])).toEqual([[0, 1]]);
  });

  test("all three throw when unauthenticated", async () => {
    const JOB = "job-auth";
    const t = convexTest(schema, modules);
    await seedPairedJob(t, JOB);

    await expect(
      t.mutation(P.updatePlaceholderImageIdentity, { jobId: JOB, entryIndex: 0, players: ["X"] }),
    ).rejects.toThrow(/not authenticated/i);
    await expect(
      t.mutation(P.manuallyPairPlaceholderImages, { jobId: JOB, frontIndex: 0, backIndex: 1 }),
    ).rejects.toThrow(/not authenticated/i);
    await expect(
      t.mutation(P.unpairPlaceholderImages, { jobId: JOB, frontIndex: 0, backIndex: 1 }),
    ).rejects.toThrow(/not authenticated/i);
  });
});
