/**
 * Unit tests for incremental pairing (NEO-170).
 *
 * Pairing used to run once, after the last image completed. It now runs after
 * image completions too, so pairs reach the client's subscription while the
 * batch is still going. Three things have to be true for that to be an
 * improvement rather than a source of churn and lost verdicts, and this file
 * exists to pin all three:
 *
 *  1. **Convergence.** Every run recomputes `pairBatch` over all done rows in
 *     entry-index order, so the state after the final run is exactly the state a
 *     single end-of-batch run would have produced — no matter how many
 *     provisional runs preceded it, or what order the images completed in.
 *  2. **No churn.** The writes are a diff. A pair that has not changed is not
 *     rewritten, because a rewrite is a re-render for every subscribed client.
 *  3. **No premature verdicts.** A provisional run writes pairs and nothing
 *     else: no status transition, no `markJobFailed`, and a throw inside one
 *     does not take the batch down with it.
 *
 * Two mechanics, both borrowed from existing files in this directory:
 *
 *  - Scheduled functions are drained with `finishAllScheduledFunctions(vi.runAllTimers)`
 *    under fake timers, following convex/backfillCardFeatures.test.ts. That is
 *    what lets a test assert the whole chain — completion → debounce latch →
 *    scheduled run → pair rows — rather than each link in isolation.
 *  - `recordImageOutcomeImpl` is driven directly through `t.run`, following
 *    convex/placeholderPipeline.test.ts, because convex-test cannot mount the
 *    workpool component that would otherwise deliver the completion.
 *
 * Counting pairing RUNS is done by collecting the `placeholder_pairing_done`
 * log line, filtered to the test's own job id. The filter is not cosmetic:
 * vitest runs several test files in one worker, so an unfiltered spy sees other
 * files' output too. (The spy also never throws — an unconditional throwing
 * `console.log` mock takes the shared worker down roughly one run in seven; see
 * the note on the PAIRING_FAILED test in placeholderPipeline.test.ts.)
 *
 * Filename note: lives at the `convex/` root, dotted rather than nested, for the
 * reason given on convex/adapters.placeholderUploads.test.ts — convex-test's
 * module registry only resolves function paths for test files at that level.
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { recordImageOutcomeImpl } from "./placeholderPipeline";
import { mergedRowIdentity } from "./placeholderPairing";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const USER_A = { subject: "user_pairIncrAAAA" };

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * One image's classifier result, in ONE place.
 *
 * The convergence test needs the same image to be describable two ways — as the
 * `/process-entry` wire body a completion carries, and as the row a directly
 * seeded "done" image already has — and a divergence between the two would make
 * the comparison meaningless while still passing. Deriving both from this
 * single spec makes that impossible.
 */
type ImageSpec = {
  entryIndex: number;
  textCount: number;
  /** Omitted entirely when absent, so the row's `side` column stays unset. */
  side?: "front" | "back";
  players?: string[];
  team?: string;
  cardNumber?: string;
  dhash?: string;
};

/** The snake_case body the preprocess service would have returned. */
function wireBody(spec: ImageSpec): Record<string, unknown> {
  return {
    players: spec.players,
    team: spec.team,
    card_number: spec.cardNumber,
    side: spec.side,
    rotation_degrees: 0,
    orient_confidence: 0.9,
    text_count: spec.textCount,
    cropped_source: "tiered",
    dhash: spec.dhash,
    output_written: true,
  };
}

/** The same image as an already-"done" row. */
function doneRowFields(spec: ImageSpec): Partial<Doc<"placeholderImages">> {
  return {
    players: spec.players,
    team: spec.team,
    cardNumber: spec.cardNumber,
    side: spec.side,
    rotationDegrees: 0,
    orientConfidence: 0.9,
    textCount: spec.textCount,
    croppedSource: "tiered",
    dhash: spec.dhash,
  };
}

async function seedJob(
  t: ReturnType<typeof convexTest>,
  jobId: string,
  overrides: Partial<{
    status: string;
    totalImages: number;
    processedImages: number;
    failedImages: number;
  }> = {},
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("placeholderJobs", {
      jobId,
      userId: USER_A.subject,
      objectPath: `placeholders/${USER_A.subject}/${jobId}/input.zip`,
      createdAt: 1_700_000_000_000,
      status: (overrides.status ?? "processing") as Doc<"placeholderJobs">["status"],
      totalImages: overrides.totalImages ?? 0,
      processedImages: overrides.processedImages ?? 0,
      failedImages: overrides.failedImages ?? 0,
    });
  });
}

async function seedImage(
  t: ReturnType<typeof convexTest>,
  jobId: string,
  entryIndex: number,
  status: "queued" | "processing" | "done" | "failed",
  extra: Partial<Doc<"placeholderImages">> = {},
): Promise<Id<"placeholderImages">> {
  return t.run(async (ctx) =>
    ctx.db.insert("placeholderImages", {
      jobId,
      userId: USER_A.subject,
      entryIndex,
      originalName: `scan-${entryIndex}.jpg`,
      status,
      ...extra,
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
    return rows
      .filter((r) => r.jobId === jobId)
      .sort((a, b) => a.entryIndex - b.entryIndex);
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

/**
 * The comparable content of a job's pairing outcome — everything except the
 * document ids and creation times, which are the two things a diff-based writer
 * is ALLOWED to differ on (an unchanged pair keeps its original `_creationTime`,
 * which a single-shot run would have set later).
 */
function pairingShape(pairs: Doc<"placeholderPairs">[], images: Doc<"placeholderImages">[]) {
  return {
    pairs: pairs.map((p) => ({
      frontIndex: p.frontIndex,
      backIndex: p.backIndex,
      player: p.player,
      team: p.team,
      cardNumber: p.cardNumber,
      confidence: p.confidence,
      mechanism: p.mechanism,
      score: p.score,
    })),
    pairStatus: images.map((i) => [i.entryIndex, i.pairStatus] as const),
  };
}

/** Deliver one image's success outcome through the completion seam. */
async function complete(
  t: ReturnType<typeof convexTest>,
  jobId: string,
  imageId: Id<"placeholderImages">,
  spec: ImageSpec,
) {
  await t.run(async (ctx) =>
    recordImageOutcomeImpl(
      ctx,
      { jobId, imageId },
      { kind: "success", returnValue: wireBody(spec) },
    ),
  );
}

/**
 * Collect `placeholder_pairing_done` lines for one job.
 *
 * Returns a live array plus a restore function. Never throws from inside the
 * mock — see the file header.
 */
function watchPairingRuns(jobId: string) {
  const runs: Array<Record<string, unknown>> = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...logArgs: unknown[]) => {
    if (typeof logArgs[0] !== "string") return;
    try {
      const parsed = JSON.parse(logArgs[0]) as Record<string, unknown>;
      if (parsed.msg === "placeholder_pairing_done" && parsed.jobId === jobId) {
        runs.push(parsed);
      }
    } catch {
      // Not our JSON log line. Ignore it rather than failing another file's log.
    }
  });
  return { runs, restore: () => spy.mockRestore() };
}

// A front/back pair the ADJACENCY pre-pass claims for free: both sides carry a
// confident text count (<= 2 is confidently a front, >= 7 confidently a back).
const ADJ_FRONT = (entryIndex: number): ImageSpec => ({
  entryIndex,
  textCount: 1,
  players: ["Ken Griffey Jr."],
  team: "Seattle Mariners",
});
const ADJ_BACK = (entryIndex: number): ImageSpec => ({
  entryIndex,
  textCount: 40,
  players: ["Ken Griffey Jr."],
  team: "Seattle Mariners",
  cardNumber: "24",
});

// Ambiguous text counts (3-6) keep the adjacency pre-pass out of it and force
// the scoring pool, which is where identity actually gets compared. 4 reads as a
// front, 6 as a back, and neither is confident enough for adjacency.
const POOL_FRONT = (entryIndex: number, player: string, team: string): ImageSpec => ({
  entryIndex,
  textCount: 4,
  players: [player],
  team,
});
const POOL_BACK = (
  entryIndex: number,
  player: string,
  team: string,
  cardNumber: string,
): ImageSpec => ({
  entryIndex,
  textCount: 6,
  players: [player],
  team,
  cardNumber,
});

// ---------------------------------------------------------------------------
// Pairs stream in
// ---------------------------------------------------------------------------

describe("pairs stream in as images complete", () => {
  test("a pair appears on the completion that finishes its second half", async () => {
    const JOB = "job-stream-pairs";
    const t = convexTest(schema, modules);
    await seedJob(t, JOB, { totalImages: 4 });
    const ids = [
      await seedImage(t, JOB, 0, "processing"),
      await seedImage(t, JOB, 1, "processing"),
      await seedImage(t, JOB, 2, "processing"),
      await seedImage(t, JOB, 3, "processing"),
    ];

    // One half of a card. Nothing to pair with yet.
    await complete(t, JOB, ids[0], ADJ_FRONT(0));
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await getPairs(t, JOB)).toHaveLength(0);
    expect((await getImages(t, JOB))[0].pairStatus).toBe("unmatched");

    // The other half. The pair must be readable NOW, not at the end of the
    // batch — two images are still processing.
    await complete(t, JOB, ids[1], ADJ_BACK(1));
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const pairs = await getPairs(t, JOB);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].frontIndex).toBe(0);
    expect(pairs[0].backIndex).toBe(1);
    expect(pairs[0].mechanism).toBe("adjacency");

    const images = await getImages(t, JOB);
    expect(images.map((i) => i.pairStatus)).toEqual([
      "paired",
      "paired",
      undefined,
      undefined,
    ]);

    // Still provisional: the batch has not finished and no verdict was reached.
    const job = await getJob(t, JOB);
    expect(job?.status).toBe("processing");
    expect(job?.finishedAt).toBeUndefined();
  });

  test("the owner's reactive query sees the provisional pairs, with their merged identity", async () => {
    // The whole point of writing pairs early is that `listPlaceholderPairs`
    // delivers them, so the public query is what this asserts — not the table.
    //
    // Pool specs rather than adjacency ones, because only the pool resolves
    // identity: an adjacency pair is produced WITHOUT ever asking who is on the
    // card (that saving is the pre-pass's entire reason to exist), so its row
    // legitimately carries no player, team or card number.
    const JOB = "job-stream-query";
    const t = convexTest(schema, modules);
    await seedJob(t, JOB, { totalImages: 4 });
    const front = await seedImage(t, JOB, 0, "processing");
    const back = await seedImage(t, JOB, 1, "processing");
    await seedImage(t, JOB, 2, "processing");
    await seedImage(t, JOB, 3, "processing");

    await complete(t, JOB, front, POOL_FRONT(0, "Ken Griffey Jr.", "Seattle Mariners"));
    await complete(t, JOB, back, POOL_BACK(1, "Ken Griffey Jr.", "Seattle Mariners", "24"));
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const visible = await t
      .withIdentity(USER_A)
      .query(api.placeholderPipeline.listPlaceholderPairs, { jobId: JOB });
    expect(visible).toHaveLength(1);
    expect(visible[0].mechanism).toBe("pool");
    // Merged asymmetrically: player/team prefer the front, card number is the
    // back's alone.
    expect(visible[0].player).toBe("Ken Griffey Jr.");
    expect(visible[0].team).toBe("Seattle Mariners");
    expect(visible[0].cardNumber).toBe("24");
  });

  test("an adjacency pair is labelled from its rows, without the resolver ever being called", async () => {
    // This test used to assert the OPPOSITE — that an adjacency pair carried no
    // identity at all — and it was right about the algorithm while being wrong
    // about what we should store. The pre-pass genuinely never asks the resolver
    // (`adjacencyCard` sets `identityResolved: false`), because in the original
    // asking cost a Haiku call. Here the identity is already sitting on the row,
    // so declining to read it just left the review UI unable to name a card it
    // could perfectly well name. `mergedRowIdentity` backfills it at the wrapper
    // level; see the comment there for why that does not touch the port.
    //
    // The property the old assertion was really protecting — "the free pre-pass
    // has not quietly started paying" — is now pinned directly by
    // `resolverCalls`, which is a far more honest guard than the absence of a
    // label.
    const JOB = "job-adjacency-identity";
    const t = convexTest(schema, modules);
    await seedJob(t, JOB, { totalImages: 3 });
    const front = await seedImage(t, JOB, 0, "processing");
    const back = await seedImage(t, JOB, 1, "processing");
    await seedImage(t, JOB, 2, "processing");

    await complete(t, JOB, front, ADJ_FRONT(0));
    await complete(t, JOB, back, ADJ_BACK(1));
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const pairs = await getPairs(t, JOB);
    expect(pairs).toHaveLength(1);

    // HOW the match was made is reported exactly as the algorithm found it —
    // untouched by the backfill, because side evidence really is all that was
    // consulted.
    expect(pairs[0].mechanism).toBe("adjacency");
    expect(pairs[0].confidence).toBe("side-only");
    expect(pairs[0].score).toBe(0);

    // WHAT the card is now comes from the rows.
    expect(pairs[0].player).toBe("Ken Griffey Jr.");
    expect(pairs[0].team).toBe("Seattle Mariners");
    expect(pairs[0].cardNumber).toBe("24");

    // And it cost nothing — zero resolver calls, which is the entire point of
    // the pre-pass and what the release E2E asserts.
    expect((await getJob(t, JOB))?.resolverCalls ?? 0).toBe(0);
  });

  test("the merge prefers the FRONT's player and team, and the BACK's card number", async () => {
    // The conflict case, and the one that decides whether the merge is the same
    // asymmetry the rest of the design uses. Adjacency pairs on side evidence
    // alone and never compares identity, so two neighbours with confidently
    // opposite sides pair even when their rows disagree about who is on the
    // card — which is exactly how this situation arises in a real scan.
    const JOB = "job-identity-conflict";
    const t = convexTest(schema, modules);
    await seedJob(t, JOB, { totalImages: 3 });
    const front = await seedImage(t, JOB, 0, "processing");
    const back = await seedImage(t, JOB, 1, "processing");
    await seedImage(t, JOB, 2, "processing");

    await complete(t, JOB, front, {
      entryIndex: 0,
      textCount: 1, // confidently a front
      players: ["Ken Griffey Jr."],
      team: "Seattle Mariners",
      // A front's card number is a misread — a jersey number, a copyright year,
      // a subset code — and must never win.
      cardNumber: "99",
    });
    await complete(t, JOB, back, {
      entryIndex: 1,
      textCount: 40, // confidently a back
      players: ["Barry Bonds"],
      team: "San Francisco Giants",
      cardNumber: "24",
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const pairs = await getPairs(t, JOB);
    expect(pairs).toHaveLength(1);
    // Front wins the name and the team: fronts print them large, in a display
    // face, against a clean background.
    expect(pairs[0].player).toBe("Ken Griffey Jr.");
    expect(pairs[0].team).toBe("Seattle Mariners");
    // Back wins the card number outright — and the front's "99" appears
    // nowhere, because there is deliberately no fall back to it.
    expect(pairs[0].cardNumber).toBe("24");
  });

  test("a front's card number is discarded when the back has none", async () => {
    // The invariant the back-only rule exists for. Card numbers are printed on
    // BACKS; what a model reads as one on a front is a jersey number, a
    // copyright year or a subset code. So a pair whose back carries no number
    // must carry none — falling back to the front's would re-import exactly the
    // value `poolCardFromIdentity` and `makeMatchResult` both throw away.
    const JOB = "job-front-number-only";
    const t = convexTest(schema, modules);
    await seedJob(t, JOB, { totalImages: 3 });
    const front = await seedImage(t, JOB, 0, "processing");
    const back = await seedImage(t, JOB, 1, "processing");
    await seedImage(t, JOB, 2, "processing");

    await complete(t, JOB, front, {
      entryIndex: 0,
      textCount: 1,
      players: ["Ken Griffey Jr."],
      team: "Seattle Mariners",
      cardNumber: "99", // a jersey number misread off the photo
    });
    await complete(t, JOB, back, {
      entryIndex: 1,
      textCount: 40,
      players: ["Ken Griffey Jr."],
      team: "Seattle Mariners",
      // no cardNumber
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const pairs = await getPairs(t, JOB);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].player).toBe("Ken Griffey Jr.");
    // Not "99". No number is better than the wrong number.
    expect(pairs[0].cardNumber).toBeUndefined();
  });

  test("mergedRowIdentity fills gaps and never overrides the algorithm", async () => {
    // Tested directly because the precedence is almost unobservable end-to-end:
    // for a pool match the algorithm's merge and the naive row merge agree by
    // construction (`poolCardFromIdentity` builds its cards from these same
    // fields), so an implementation that wrongly preferred the rows would pass
    // every pipeline test. The ordering still matters — the ported algorithm is
    // the authority on identity whenever it has an opinion — so it is pinned
    // here where a disagreement can actually be constructed.
    const rows = {
      front: { players: ["Row Front"], team: "Row Front Team", cardNumber: "11" },
      back: { players: ["Row Back"], team: "Row Back Team", cardNumber: "22" },
    };

    // The algorithm answered: its answer stands, untouched.
    expect(
      mergedRowIdentity(
        { player: "Algo Player", team: "Algo Team", cardNumber: "99" },
        rows.front,
        rows.back,
      ),
    ).toEqual({ player: "Algo Player", team: "Algo Team", cardNumber: "99" });

    // The algorithm answered nothing (an adjacency pair): the rows fill in,
    // front-preferred for player/team, back-only for the card number.
    expect(
      mergedRowIdentity({ player: null, team: null, cardNumber: null }, rows.front, rows.back),
    ).toEqual({ player: "Row Front", team: "Row Front Team", cardNumber: "22" });

    // Field by field, not all-or-nothing.
    expect(
      mergedRowIdentity(
        { player: "Algo Player", team: null, cardNumber: null },
        rows.front,
        rows.back,
      ),
    ).toEqual({ player: "Algo Player", team: "Row Front Team", cardNumber: "22" });

    // Nothing anywhere stays nothing — no invented values.
    expect(mergedRowIdentity({}, {}, {})).toEqual({
      player: undefined,
      team: undefined,
      cardNumber: undefined,
    });
  });

  test("a pool pair keeps the resolver's own answer rather than the rows'", async () => {
    // The backfill fills a GAP; it does not override. A pool match already
    // carries a resolved identity, and that answer — merged by the ported
    // algorithm — must survive untouched.
    const JOB = "job-pool-identity";
    const t = convexTest(schema, modules);
    await seedJob(t, JOB, { totalImages: 3 });
    const ids = [
      await seedImage(t, JOB, 0, "processing"),
      await seedImage(t, JOB, 1, "processing"),
      await seedImage(t, JOB, 2, "processing"),
    ];

    await complete(t, JOB, ids[0], POOL_FRONT(0, "Ken Griffey Jr.", "Seattle Mariners"));
    await complete(t, JOB, ids[1], POOL_BACK(1, "Ken Griffey Jr.", "Seattle Mariners", "24"));
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const pairs = await getPairs(t, JOB);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].mechanism).toBe("pool");
    expect(pairs[0].player).toBe("Ken Griffey Jr.");
    expect(pairs[0].cardNumber).toBe("24");
  });
});

// ---------------------------------------------------------------------------
// resolverCalls
// ---------------------------------------------------------------------------

describe("resolverCalls", () => {
  test("stays 0 across a whole well-ordered batch — the release-E2E assertion", async () => {
    // The property the metric exists for: a scan in front/back order is paired
    // entirely by the free pre-pass, and the identity resolver is never
    // consulted for a single image, on any run.
    const JOB = "job-resolver-zero";
    const t = convexTest(schema, modules);
    await seedJob(t, JOB, { totalImages: 4 });
    const ids: Id<"placeholderImages">[] = [];
    for (let i = 0; i < 4; i++) ids.push(await seedImage(t, JOB, i, "processing"));

    for (const [i, spec] of [ADJ_FRONT(0), ADJ_BACK(1), ADJ_FRONT(2), ADJ_BACK(3)].entries()) {
      await complete(t, JOB, ids[i], spec);
      await t.finishAllScheduledFunctions(vi.runAllTimers);
    }

    const job = await getJob(t, JOB);
    expect(job?.status).toBe("succeeded");
    expect(await getPairs(t, JOB)).toHaveLength(2);
    // Never written at all on the healthy path — absent reads as 0, and not
    // writing keeps every subscriber from being woken to hear nothing changed.
    expect(job?.resolverCalls).toBeUndefined();
  });

  test("provisional runs record nothing — only the completed batch counts", async () => {
    // The reason the metric is not cumulative. Every intermediate run over an
    // odd-length prefix has a trailing image with no partner YET, which goes to
    // the pool and costs a call. Summing those would report a non-zero total for
    // a perfectly ordered scan and make "assert 0" meaningless.
    const JOB = "job-resolver-provisional";
    const t = convexTest(schema, modules);
    await seedJob(t, JOB, { totalImages: 4 });
    const ids: Id<"placeholderImages">[] = [];
    for (let i = 0; i < 4; i++) ids.push(await seedImage(t, JOB, i, "processing"));

    // One image done: the run pairs nothing and resolves the lone row.
    await complete(t, JOB, ids[0], ADJ_FRONT(0));
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await getJob(t, JOB))?.status).toBe("processing");
    // Nothing recorded — that call was an artifact of an incomplete batch.
    expect((await getJob(t, JOB))?.resolverCalls).toBeUndefined();

    for (const [i, spec] of [ADJ_BACK(1), ADJ_FRONT(2), ADJ_BACK(3)].entries()) {
      await complete(t, JOB, ids[i + 1], spec);
      await t.finishAllScheduledFunctions(vi.runAllTimers);
    }

    // The final run saw all four rows, paired them all, and needed the resolver
    // for none of them.
    expect((await getJob(t, JOB))?.status).toBe("succeeded");
    expect((await getJob(t, JOB))?.resolverCalls).toBeUndefined();
  });

  test("the final run's count replaces a stale one rather than adding to it", async () => {
    const JOB = "job-resolver-replace";
    const t = convexTest(schema, modules);
    await seedJob(t, JOB, { status: "pairing", totalImages: 2, processedImages: 2 });
    await seedImage(t, JOB, 0, "done", doneRowFields(ADJ_FRONT(0)));
    await seedImage(t, JOB, 1, "done", doneRowFields(ADJ_BACK(1)));
    await t.run(async (ctx) => {
      const jobs = await ctx.db.query("placeholderJobs").collect();
      const row = jobs.find((j) => j.jobId === JOB)!;
      await ctx.db.patch(row._id, { resolverCalls: 9 });
    });

    await t.action(internal.placeholderPairing.runPairing, {
      jobId: JOB,
      userId: USER_A.subject,
      final: true,
    });

    // This batch pairs by adjacency, so the honest answer is 0 — stored as
    // absent, which is how a stale 9 is cleared rather than added to.
    expect((await getJob(t, JOB))?.resolverCalls).toBeUndefined();
  });

  test("a batch that genuinely needed the pool records what the final run cost", async () => {
    const JOB = "job-resolver-paid";
    const t = convexTest(schema, modules);
    await seedJob(t, JOB, { status: "pairing", totalImages: 2, processedImages: 2 });
    // Ambiguous text counts keep the free pre-pass out, so both rows reach the
    // scoring pool and each costs a resolver call.
    await seedImage(
      t,
      JOB,
      0,
      "done",
      doneRowFields(POOL_FRONT(0, "Ken Griffey Jr.", "Seattle Mariners")),
    );
    await seedImage(
      t,
      JOB,
      1,
      "done",
      doneRowFields(POOL_BACK(1, "Ken Griffey Jr.", "Seattle Mariners", "24")),
    );

    await t.action(internal.placeholderPairing.runPairing, {
      jobId: JOB,
      userId: USER_A.subject,
      final: true,
    });

    expect((await getJob(t, JOB))?.resolverCalls).toBe(2);
    // And it is visible to the owner, which is what the E2E reads.
    const job = await t
      .withIdentity(USER_A)
      .query(api.placeholderPipeline.getPlaceholderJob, { jobId: JOB });
    expect(job?.resolverCalls).toBe(2);
  });

  test("is reset when a failed batch is restarted", async () => {
    // The previous attempt's pairs are swept on restart, so its resolver spend
    // describes work that no longer exists.
    const JOB = "job-resolver-reset";
    const t = convexTest(schema, modules);
    await seedJob(t, JOB, { status: "failed", totalImages: 1 });
    await t.run(async (ctx) => {
      const jobs = await ctx.db.query("placeholderJobs").collect();
      const row = jobs.find((j) => j.jobId === JOB)!;
      await ctx.db.patch(row._id, { resolverCalls: 7 });
    });

    await t
      .withIdentity(USER_A)
      .mutation(api.placeholderPipeline.startPlaceholderBatch, { jobId: JOB });

    expect((await getJob(t, JOB))?.resolverCalls).toBeUndefined();
  });

  test("getPlaceholderJob defaults it to 0 for a job that never paired", async () => {
    const JOB = "job-resolver-default";
    const t = convexTest(schema, modules);
    await seedJob(t, JOB, { status: "pending" });

    const job = await t
      .withIdentity(USER_A)
      .query(api.placeholderPipeline.getPlaceholderJob, { jobId: JOB });
    expect(job?.resolverCalls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Revision
// ---------------------------------------------------------------------------

describe("a later arrival revises an earlier verdict", () => {
  test("an out-of-order completion supersedes a pool pair, and both images flip", async () => {
    // Images run three-wide through the pool, so they finish out of order as a
    // matter of course: index 2 can be done while index 1 is still in flight.
    // Pairing over {0, 2} legitimately matches them; pairing over {0, 1, 2} —
    // which feeds the pool in entry-index order — legitimately does not. The
    // superseded pair has to GO, and image 2 has to stop claiming to be paired.
    const JOB = "job-revise";
    const t = convexTest(schema, modules);
    await seedJob(t, JOB, { totalImages: 3 });
    const ids = [
      await seedImage(t, JOB, 0, "processing"),
      await seedImage(t, JOB, 1, "processing"),
      await seedImage(t, JOB, 2, "processing"),
    ];

    await complete(t, JOB, ids[0], POOL_FRONT(0, "Ken Griffey Jr.", "Seattle Mariners"));
    await complete(t, JOB, ids[2], POOL_BACK(2, "Ken Griffey Jr.", "Seattle Mariners", "24"));
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const firstPass = await getPairs(t, JOB);
    expect(firstPass).toHaveLength(1);
    expect([firstPass[0].frontIndex, firstPass[0].backIndex]).toEqual([0, 2]);
    // The pool, not adjacency: ambiguous text counts kept the free pre-pass out.
    expect(firstPass[0].mechanism).toBe("pool");
    expect((await getImages(t, JOB)).map((i) => i.pairStatus)).toEqual([
      "paired",
      undefined,
      "paired",
    ]);

    // The straggler lands, and it is the better partner for image 0.
    await complete(t, JOB, ids[1], POOL_BACK(1, "Ken Griffey Jr.", "Seattle Mariners", "24"));
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const secondPass = await getPairs(t, JOB);
    expect(secondPass).toHaveLength(1);
    expect([secondPass[0].frontIndex, secondPass[0].backIndex]).toEqual([0, 1]);
    // A genuinely different pair, so a genuinely different row — the old one was
    // deleted rather than edited into the new one.
    expect(secondPass[0]._id).not.toBe(firstPass[0]._id);
    expect((await getImages(t, JOB)).map((i) => i.pairStatus)).toEqual([
      "paired",
      "paired",
      "unmatched",
    ]);
  });

  test("a pair that disappears entirely leaves no row behind", async () => {
    // Two identity-free images pair on the side-only fallback, which requires
    // exactly ONE opposite-side candidate. A third image makes it two, the
    // fallback stops firing, and the pair must be withdrawn rather than left
    // stale.
    const JOB = "job-withdraw";
    const t = convexTest(schema, modules);
    await seedJob(t, JOB, { totalImages: 3 });
    const ids = [
      await seedImage(t, JOB, 0, "processing"),
      await seedImage(t, JOB, 1, "processing"),
      await seedImage(t, JOB, 2, "processing"),
    ];

    await complete(t, JOB, ids[1], { entryIndex: 1, textCount: 4 });
    await complete(t, JOB, ids[2], { entryIndex: 2, textCount: 6 });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await getPairs(t, JOB)).toHaveLength(1);

    await complete(t, JOB, ids[0], { entryIndex: 0, textCount: 4 });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(await getPairs(t, JOB)).toHaveLength(0);
    expect((await getImages(t, JOB)).every((i) => i.pairStatus === "unmatched")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// No churn
// ---------------------------------------------------------------------------

describe("unchanged rows are not rewritten", () => {
  test("a re-run over the same images writes nothing at all", async () => {
    const JOB = "job-nochurn";
    const t = convexTest(schema, modules);
    await seedJob(t, JOB, { totalImages: 4 });
    const front = await seedImage(t, JOB, 0, "processing");
    const back = await seedImage(t, JOB, 1, "processing");
    await seedImage(t, JOB, 2, "processing");
    await seedImage(t, JOB, 3, "processing");

    await complete(t, JOB, front, ADJ_FRONT(0));
    await complete(t, JOB, back, ADJ_BACK(1));
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const before = await getPairs(t, JOB);
    expect(before).toHaveLength(1);

    const watcher = watchPairingRuns(JOB);
    try {
      await t.action(internal.placeholderPairing.runPairing, {
        jobId: JOB,
        userId: USER_A.subject,
        final: false,
      });
    } finally {
      watcher.restore();
    }

    // The run happened and decided to do nothing — not "the run was skipped".
    expect(watcher.runs).toHaveLength(1);
    expect(watcher.runs[0]).toMatchObject({
      pairs: 1,
      inserted: 0,
      revised: 0,
      removed: 0,
    });

    const after = await getPairs(t, JOB);
    // Same document, same creation time: the row was never deleted and
    // re-inserted, which is what a subscribed client would have re-rendered on.
    expect(after[0]._id).toBe(before[0]._id);
    expect(after[0]._creationTime).toBe(before[0]._creationTime);
  });

  test("applyPairDiff revises a pair in place rather than replacing it", async () => {
    // Same (frontIndex, backIndex), different evidence. Reached in production
    // when the same two images stay each other's best match but the route to
    // that conclusion changes; exercised directly here because constructing it
    // through `pairBatch` needs a contrived batch, and what matters is that the
    // row survives with its identity intact.
    const JOB = "job-patch";
    const t = convexTest(schema, modules);
    const pairId = await t.run(async (ctx) =>
      ctx.db.insert("placeholderPairs", {
        jobId: JOB,
        userId: USER_A.subject,
        frontIndex: 0,
        backIndex: 1,
        player: "Ken Griffey Jr.",
        confidence: "side-only",
        mechanism: "adjacency",
        score: 0,
      }),
    );
    const before = await t.run(async (ctx) => ctx.db.get(pairId));

    const result = await t.mutation(internal.placeholderPairing.applyPairDiff, {
      jobId: JOB,
      userId: USER_A.subject,
      deleteIds: [],
      patches: [
        {
          pairId,
          player: "Ken Griffey Jr.",
          team: "Seattle Mariners",
          cardNumber: "24",
          confidence: "exact",
          mechanism: "pool",
          score: 3500,
        },
      ],
      inserts: [],
    });

    expect(result).toEqual({ deleted: 0, revised: 1, inserted: 0 });
    const after = await t.run(async (ctx) => ctx.db.get(pairId));
    expect(after?._creationTime).toBe(before?._creationTime);
    expect(after?.confidence).toBe("exact");
    expect(after?.mechanism).toBe("pool");
    expect(after?.score).toBe(3500);
    expect(after?.cardNumber).toBe("24");
  });

  test("applyPairDiff refuses to touch another job's pair row", async () => {
    // The ids come from a diff this action computed, not from a client — but an
    // id resolves to a document regardless of whose job it belongs to, so a bug
    // in the arithmetic must not be able to delete someone else's pairs.
    const t = convexTest(schema, modules);
    const foreignId = await t.run(async (ctx) =>
      ctx.db.insert("placeholderPairs", {
        jobId: "job-someone-else",
        userId: "user_other",
        frontIndex: 0,
        backIndex: 1,
        confidence: "exact",
        mechanism: "pool",
        score: 1,
      }),
    );

    const result = await t.mutation(internal.placeholderPairing.applyPairDiff, {
      jobId: "job-mine",
      userId: USER_A.subject,
      deleteIds: [foreignId],
      patches: [],
      inserts: [],
    });

    expect(result.deleted).toBe(0);
    expect(await t.run(async (ctx) => ctx.db.get(foreignId))).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Convergence
// ---------------------------------------------------------------------------

describe("convergence", () => {
  test("the state after the final run equals a single end-of-batch run", async () => {
    // The property the whole design rests on. Job A is paired incrementally,
    // with completions arriving out of order so intermediate runs reach WRONG
    // conclusions and have to be revised. Job B is the control: identical
    // images, seeded straight to "done", paired exactly once. The two outcomes
    // must be indistinguishable.
    const specs: ImageSpec[] = [
      POOL_FRONT(0, "Ken Griffey Jr.", "Seattle Mariners"),
      POOL_BACK(1, "Ken Griffey Jr.", "Seattle Mariners", "24"),
      ADJ_FRONT(2),
      ADJ_BACK(3),
      POOL_FRONT(4, "Barry Bonds", "San Francisco Giants"),
      POOL_BACK(5, "Barry Bonds", "San Francisco Giants", "301"),
    ];

    const t = convexTest(schema, modules);

    // ---- A: incremental, completing in a deliberately awkward order --------
    const JOB_A = "job-converge-incremental";
    await seedJob(t, JOB_A, { totalImages: specs.length });
    const idsA: Id<"placeholderImages">[] = [];
    for (const spec of specs) {
      idsA.push(await seedImage(t, JOB_A, spec.entryIndex, "processing"));
    }
    for (const index of [5, 0, 3, 2, 4, 1]) {
      await complete(t, JOB_A, idsA[index], specs[index]);
      await t.finishAllScheduledFunctions(vi.runAllTimers);
    }

    // The last completion is the one that finishes the batch, so it scheduled
    // the FINAL run rather than another provisional one.
    const jobA = await getJob(t, JOB_A);
    expect(jobA?.status).toBe("succeeded");

    // ---- B: one shot over the same images ---------------------------------
    const JOB_B = "job-converge-single";
    await seedJob(t, JOB_B, {
      status: "pairing",
      totalImages: specs.length,
      processedImages: specs.length,
    });
    for (const spec of specs) {
      await seedImage(t, JOB_B, spec.entryIndex, "done", doneRowFields(spec));
    }
    await t.action(internal.placeholderPairing.runPairing, {
      jobId: JOB_B,
      userId: USER_A.subject,
      final: true,
    });
    expect((await getJob(t, JOB_B))?.status).toBe("succeeded");

    expect(pairingShape(await getPairs(t, JOB_A), await getImages(t, JOB_A))).toEqual(
      pairingShape(await getPairs(t, JOB_B), await getImages(t, JOB_B)),
    );
    // Guard against the comparison being vacuous — a batch that paired nothing
    // would satisfy the equality above for the wrong reason.
    expect((await getPairs(t, JOB_A)).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Debounce
// ---------------------------------------------------------------------------

describe("debounce", () => {
  test("a burst of completions costs one pairing run, not one each", async () => {
    const JOB = "job-debounce";
    const t = convexTest(schema, modules);
    await seedJob(t, JOB, { totalImages: 6 });
    const ids: Id<"placeholderImages">[] = [];
    for (let i = 0; i < 6; i++) ids.push(await seedImage(t, JOB, i, "processing"));

    const watcher = watchPairingRuns(JOB);
    try {
      await complete(t, JOB, ids[0], ADJ_FRONT(0));
      await complete(t, JOB, ids[1], ADJ_BACK(1));
      await complete(t, JOB, ids[2], ADJ_FRONT(2));

      // The latch is what suppresses the second and third schedules.
      expect((await getJob(t, JOB))?.pairingScheduled).toBe(true);

      await t.finishAllScheduledFunctions(vi.runAllTimers);
      expect(watcher.runs).toHaveLength(1);
      // Cleared by the run itself, before it read anything — so the next
      // completion is free to schedule a successor.
      expect((await getJob(t, JOB))?.pairingScheduled).toBeUndefined();

      // And it does.
      await complete(t, JOB, ids[3], ADJ_BACK(3));
      expect((await getJob(t, JOB))?.pairingScheduled).toBe(true);
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      expect(watcher.runs).toHaveLength(2);
    } finally {
      watcher.restore();
    }

    // Every image that completed is accounted for, so the debounce cost
    // scheduling, never coverage.
    expect(await getPairs(t, JOB)).toHaveLength(2);
  });

  test("the completion that finishes the batch does not schedule a second run of its own", async () => {
    const JOB = "job-final-only";
    const t = convexTest(schema, modules);
    await seedJob(t, JOB, { totalImages: 2 });
    const front = await seedImage(t, JOB, 0, "processing");
    const back = await seedImage(t, JOB, 1, "processing");

    const watcher = watchPairingRuns(JOB);
    try {
      await complete(t, JOB, front, ADJ_FRONT(0));
      await complete(t, JOB, back, ADJ_BACK(1));

      const midJob = await getJob(t, JOB);
      expect(midJob?.status).toBe("pairing");

      await t.finishAllScheduledFunctions(vi.runAllTimers);

      // TWO runs were scheduled — the provisional one the FIRST completion
      // latched, and the final one the second completion triggered — but only
      // one of them wrote anything. The provisional run arrives to find the job
      // already in "pairing", which is not an incremental status, and returns
      // before reading a single row. That is the status guard doing its job: two
      // writers over the same rows is exactly what it exists to prevent.
      expect(watcher.runs).toHaveLength(1);
      expect(watcher.runs[0].final).toBe(true);
    } finally {
      watcher.restore();
    }

    const job = await getJob(t, JOB);
    expect(job?.status).toBe("succeeded");
    // Whichever run went first, the latch is clear afterwards — both clear it
    // before doing anything else, so a finished job never keeps one set.
    expect(job?.pairingScheduled).toBeUndefined();
    expect(await getPairs(t, JOB)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Provisional runs make no verdicts
// ---------------------------------------------------------------------------

describe("a provisional run never decides the batch's fate", () => {
  test("it leaves a mostly-failed batch alone for the final run to judge", async () => {
    // `failedImages * 2 > totalImages` is already true here. A provisional run
    // applying that rule would fail a batch that is still processing perfectly
    // good images.
    const JOB = "job-provisional-verdict";
    const t = convexTest(schema, modules);
    await seedJob(t, JOB, {
      totalImages: 5,
      processedImages: 1,
      failedImages: 3,
    });
    await seedImage(t, JOB, 0, "done", doneRowFields(ADJ_FRONT(0)));

    await t.action(internal.placeholderPairing.runPairing, {
      jobId: JOB,
      userId: USER_A.subject,
      final: false,
    });

    const job = await getJob(t, JOB);
    expect(job?.status).toBe("processing");
    expect(job?.errorCode).toBeUndefined();
    expect(job?.finishedAt).toBeUndefined();
  });

  test("a throw inside a provisional run does not fail the job", async () => {
    // A provisional run is not the last link in the chain, so it has no business
    // making the job terminal when it stumbles — the final run recomputes
    // everything anyway. The fault is injected at the summary log line, matching
    // the technique (and the one-shot guard) used for the PAIRING_FAILED test in
    // placeholderPipeline.test.ts.
    const JOB = "job-provisional-throw";
    const t = convexTest(schema, modules);
    await seedJob(t, JOB, { totalImages: 3, processedImages: 1 });
    await seedImage(t, JOB, 0, "done", doneRowFields(ADJ_FRONT(0)));

    let injected = false;
    const log = vi.spyOn(console, "log").mockImplementation((...logArgs: unknown[]) => {
      if (injected) return;
      if (typeof logArgs[0] !== "string" || !logArgs[0].includes(JOB)) return;
      if (!logArgs[0].includes("placeholder_pairing_done")) return;
      injected = true;
      throw new Error("Documents read from or written to the table changed");
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        t.action(internal.placeholderPairing.runPairing, {
          jobId: JOB,
          userId: USER_A.subject,
          final: false,
        }),
      ).resolves.toBeNull();
    } finally {
      log.mockRestore();
      error.mockRestore();
    }

    expect(injected).toBe(true);
    const job = await getJob(t, JOB);
    expect(job?.status).toBe("processing");
    expect(job?.errorCode).toBeUndefined();
  });

  test("a provisional run that lands after a cancel writes nothing", async () => {
    // Cancel makes the job terminal immediately, but a pairing run scheduled
    // moments earlier is still on its way. Writing pairs into a canceled job
    // would resurrect part of it.
    const JOB = "job-provisional-late";
    const t = convexTest(schema, modules);
    await seedJob(t, JOB, { totalImages: 2, processedImages: 2 });
    await seedImage(t, JOB, 0, "done", doneRowFields(ADJ_FRONT(0)));
    await seedImage(t, JOB, 1, "done", doneRowFields(ADJ_BACK(1)));

    await t
      .withIdentity(USER_A)
      .mutation(api.placeholderPipeline.cancelPlaceholderBatch, { jobId: JOB });

    await t.action(internal.placeholderPairing.runPairing, {
      jobId: JOB,
      userId: USER_A.subject,
      final: false,
    });

    expect(await getPairs(t, JOB)).toHaveLength(0);
    const job = await getJob(t, JOB);
    expect(job?.status).toBe("failed");
    expect(job?.errorCode).toBe("CANCELED");
  });
});
