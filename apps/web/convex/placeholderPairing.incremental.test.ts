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
import {
  computePairingDiff,
  guardedAdjacencyFallback,
  identitiesContradict,
  mergedRowIdentity,
} from "./placeholderPairing";
import type {
  PairingImageRow,
  StoredPairRow,
} from "./placeholderPairing";
import { createPoolCard } from "./lib/pairing/types";

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
// A matching front/back that share an identity. Under the NEO-170 identity-first
// precedence these pair through the identity POOL (mechanism "pool"), not the
// adjacency pre-pass — the clear text counts (1 vs 40) now only decide each
// card's side, they no longer decide the mechanism. Named ADJ_* historically;
// kept because so many streaming/diff tests just need "a front and a back that
// pair".
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

// Ambiguous text counts (3-6) — deliberately in the band where the side is
// decided by the classifier/identity rather than a confident count. Identity is
// what pairs these; 4 reads as a front, 6 as a back.
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

// UNREADABLE identity: the classifier extracted no player/team/cardNumber, only
// a side (from the text count — 1 front, 40 back). These carry nothing for the
// identity pool to match on, so they pair ONLY through the demoted scan-order
// adjacency fallback — which is the whole point of having fixtures for it.
const BLANK_FRONT = (entryIndex: number): ImageSpec => ({ entryIndex, textCount: 1 });
const BLANK_BACK = (entryIndex: number): ImageSpec => ({ entryIndex, textCount: 40 });

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
    // By IDENTITY, not adjacency: the two halves share a player, so the pool
    // matches them regardless of scan order (identity-first precedence).
    expect(pairs[0].mechanism).toBe("pool");

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

  test("an adjacency FALLBACK pair is labelled from its rows", async () => {
    // The scan-order fallback fires only for what identity could not place. A
    // readable front (Sonny Gray) whose true back is absent sits between two
    // unreadable backs. The pool cannot match the front to a blank back (there
    // is nothing to score), and it will not apply its OWN lone-candidate
    // side-only rule either — that rule requires BOTH cards be identity-less, and
    // the front is not — so the decision falls to the guarded scan-order pass.
    //
    // Such a pair carries no algorithm identity (adjacency never resolves one),
    // so `mergedRowIdentity` labels it from the rows — which is what lets the
    // review UI name a card the pool left unlabelled. HOW it was matched stays
    // honest: mechanism "adjacency", confidence "side-only", score 0.
    const JOB = "job-adjacency-fallback-label";
    const t = convexTest(schema, modules);
    await seedJob(t, JOB, { totalImages: 3 });
    const backA = await seedImage(t, JOB, 0, "processing");
    const front = await seedImage(t, JOB, 1, "processing");
    const backB = await seedImage(t, JOB, 2, "processing");

    await complete(t, JOB, backA, BLANK_BACK(0));
    await complete(t, JOB, front, {
      entryIndex: 1,
      textCount: 1,
      players: ["Sonny Gray"],
      team: "Minnesota Twins",
    });
    await complete(t, JOB, backB, BLANK_BACK(2));
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const pairs = await getPairs(t, JOB);
    expect(pairs).toHaveLength(1);
    // The front pairs with its nearest leftover back in scan order (index 0).
    expect([pairs[0].frontIndex, pairs[0].backIndex]).toEqual([1, 0]);

    // HOW it was matched — scan order, no identity consulted between the two.
    expect(pairs[0].mechanism).toBe("adjacency");
    expect(pairs[0].confidence).toBe("side-only");
    expect(pairs[0].score).toBe(0);

    // WHAT the card is — backfilled from the one readable row.
    expect(pairs[0].player).toBe("Sonny Gray");
    expect(pairs[0].team).toBe("Minnesota Twins");
    expect(pairs[0].cardNumber).toBeUndefined();
  });

  test("adjacent cards whose KNOWN identities disagree are left unmatched, never forced together", async () => {
    // The core correctness case, and the exact live failure that motivated the
    // whole precedence flip. A Sonny Gray FRONT sits next to an Eric Hosmer BACK
    // — opposite sides, so the OLD adjacency-first pre-pass grabbed them before
    // identity could weigh in. Neither has its true partner present in this
    // batch. Under identity-first, the pool hard-rejects the player disagreement,
    // and the scan-order fallback is BLOCKED by `identitiesContradict` — so both
    // are correctly left unmatched rather than mispaired.
    const JOB = "job-contradicting-adjacent";
    const t = convexTest(schema, modules);
    await seedJob(t, JOB, { totalImages: 2 });
    const grayFront = await seedImage(t, JOB, 0, "processing");
    const hosmerBack = await seedImage(t, JOB, 1, "processing");

    await complete(t, JOB, grayFront, {
      entryIndex: 0,
      textCount: 1,
      players: ["Sonny Gray"],
      team: "Minnesota Twins",
    });
    await complete(t, JOB, hosmerBack, {
      entryIndex: 1,
      textCount: 40,
      players: ["Eric Hosmer"],
      team: "San Diego Padres",
      cardNumber: "24",
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    // No pair at all — the disagreement is decisive.
    expect(await getPairs(t, JOB)).toHaveLength(0);
    expect((await getImages(t, JOB)).map((i) => i.pairStatus)).toEqual([
      "unmatched",
      "unmatched",
    ]);
  });

  test("team disagreement alone blocks the adjacency fallback", async () => {
    // "name and team should have precedency over adjacency" — team is part of the
    // guard, not just player. Two cards with no player but conflicting teams are
    // known-different, so scan-order proximity must not pair them.
    const JOB = "job-team-conflict";
    const t = convexTest(schema, modules);
    await seedJob(t, JOB, { totalImages: 2 });
    const front = await seedImage(t, JOB, 0, "processing");
    const back = await seedImage(t, JOB, 1, "processing");

    await complete(t, JOB, front, { entryIndex: 0, textCount: 1, team: "Minnesota Twins" });
    await complete(t, JOB, back, { entryIndex: 1, textCount: 40, team: "San Diego Padres" });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(await getPairs(t, JOB)).toHaveLength(0);
  });

  test("front and back of the same card pair by identity even when NOT adjacent", async () => {
    // Order-independence, the flip side of the fix. Gray's front is index 0 and
    // his back is index 3, with two unrelated cards between them. Identity-first
    // pairs them regardless of the distance — the pre-pass could only ever have
    // paired neighbours.
    const JOB = "job-nonadjacent-identity";
    const t = convexTest(schema, modules);
    await seedJob(t, JOB, { totalImages: 4 });
    const ids: Id<"placeholderImages">[] = [];
    for (let i = 0; i < 4; i++) ids.push(await seedImage(t, JOB, i, "processing"));

    await complete(t, JOB, ids[0], POOL_FRONT(0, "Sonny Gray", "Minnesota Twins"));
    await complete(t, JOB, ids[1], POOL_FRONT(1, "Eric Hosmer", "San Diego Padres"));
    await complete(t, JOB, ids[2], POOL_BACK(2, "Eric Hosmer", "San Diego Padres", "7"));
    await complete(t, JOB, ids[3], POOL_BACK(3, "Sonny Gray", "Minnesota Twins", "54"));
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const pairs = await getPairs(t, JOB);
    expect(pairs).toHaveLength(2);
    const byFront = new Map(pairs.map((p) => [p.frontIndex, p]));
    // Gray front(0) ↔ Gray back(3), across the gap.
    expect(byFront.get(0)?.backIndex).toBe(3);
    expect(byFront.get(0)?.player).toBe("Sonny Gray");
    expect(byFront.get(0)?.mechanism).toBe("pool");
    // Hosmer front(1) ↔ Hosmer back(2).
    expect(byFront.get(1)?.backIndex).toBe(2);
    expect(byFront.get(1)?.player).toBe("Eric Hosmer");
  });

  test("the live mispair: a Gray front adjacent to a Hosmer back each pair with their OWN partner", async () => {
    // The complete real-world failure. In scan order the sheet is
    // Gray-front, Hosmer-back, Gray-back, Hosmer-front — so Gray-front(0) sits
    // right next to Hosmer-back(1), which the old pre-pass paired on sight. Under
    // identity-first every card finds its true partner, and the adjacent
    // Gray/Hosmer pair is never made.
    const JOB = "job-live-mispair";
    const t = convexTest(schema, modules);
    await seedJob(t, JOB, { totalImages: 4 });
    const ids: Id<"placeholderImages">[] = [];
    for (let i = 0; i < 4; i++) ids.push(await seedImage(t, JOB, i, "processing"));

    await complete(t, JOB, ids[0], POOL_FRONT(0, "Sonny Gray", "Minnesota Twins"));
    await complete(t, JOB, ids[1], POOL_BACK(1, "Eric Hosmer", "San Diego Padres", "7"));
    await complete(t, JOB, ids[2], POOL_BACK(2, "Sonny Gray", "Minnesota Twins", "54"));
    await complete(t, JOB, ids[3], POOL_FRONT(3, "Eric Hosmer", "San Diego Padres"));
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const pairs = await getPairs(t, JOB);
    expect(pairs).toHaveLength(2);
    const byFront = new Map(pairs.map((p) => [p.frontIndex, p]));
    // Gray-front(0) ↔ Gray-back(2), NOT the adjacent Hosmer-back(1).
    expect(byFront.get(0)?.backIndex).toBe(2);
    expect(byFront.get(0)?.player).toBe("Sonny Gray");
    // Hosmer-front(3) ↔ Hosmer-back(1).
    expect(byFront.get(3)?.backIndex).toBe(1);
    expect(byFront.get(3)?.player).toBe("Eric Hosmer");
    // Nothing paired the adjacent Gray-front(0) ↔ Hosmer-back(1).
    expect(pairs.some((p) => p.frontIndex === 0 && p.backIndex === 1)).toBe(false);
  });

  test("scan-order-scrambled identity partners still pair correctly", async () => {
    // Proves the result does not depend on upload order at all. The same two
    // cards' halves arrive interleaved with a third card's, in a scrambled
    // sequence; identity still assembles them.
    const JOB = "job-scrambled";
    const t = convexTest(schema, modules);
    await seedJob(t, JOB, { totalImages: 4 });
    const ids: Id<"placeholderImages">[] = [];
    for (let i = 0; i < 4; i++) ids.push(await seedImage(t, JOB, i, "processing"));

    // Deliberately jumbled: back before front, partners far apart.
    await complete(t, JOB, ids[0], POOL_BACK(0, "Eric Hosmer", "San Diego Padres", "7"));
    await complete(t, JOB, ids[1], POOL_FRONT(1, "Sonny Gray", "Minnesota Twins"));
    await complete(t, JOB, ids[2], POOL_BACK(2, "Sonny Gray", "Minnesota Twins", "54"));
    await complete(t, JOB, ids[3], POOL_FRONT(3, "Eric Hosmer", "San Diego Padres"));
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const pairs = await getPairs(t, JOB);
    expect(pairs).toHaveLength(2);
    const byFront = new Map(pairs.map((p) => [p.frontIndex, p]));
    expect(byFront.get(1)?.backIndex).toBe(2); // Gray front(1) ↔ Gray back(2)
    expect(byFront.get(3)?.backIndex).toBe(0); // Hosmer front(3) ↔ Hosmer back(0)
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
  test("equals the done-image count for a well-ordered batch — every card is resolved by identity", async () => {
    // Identity-first means the pool sees EVERY card (see `useAdjacency: false`),
    // so the final run resolves one identity per done image. That is exactly the
    // number the release E2E now asserts — it flipped from 0 (adjacency-first
    // never asked) to the image count (identity-first asks about all of them),
    // which is expected and healthy, not a regression.
    const JOB = "job-resolver-count";
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
    // Two pairs (Griffey pairs with Griffey by identity, twice over).
    expect(await getPairs(t, JOB)).toHaveLength(2);
    // Four done images → four identity resolutions in the final run.
    expect(job?.resolverCalls).toBe(4);
    // Exposed to the owner — this is the number the release E2E reads.
    const visible = await t
      .withIdentity(USER_A)
      .query(api.placeholderPipeline.getPlaceholderJob, { jobId: JOB });
    expect(visible?.resolverCalls).toBe(4);
  });

  test("provisional runs record nothing — only the completed batch's count is stored", async () => {
    // Only the FINAL run writes the number, so it always describes the whole
    // batch. An intermediate run over a partial batch resolves a different
    // (smaller) count, and storing that would report a figure that tracks how
    // completions interleaved rather than the batch itself.
    const JOB = "job-resolver-provisional";
    const t = convexTest(schema, modules);
    await seedJob(t, JOB, { totalImages: 4 });
    const ids: Id<"placeholderImages">[] = [];
    for (let i = 0; i < 4; i++) ids.push(await seedImage(t, JOB, i, "processing"));

    // One image done: a provisional run resolves the lone row but records nothing.
    await complete(t, JOB, ids[0], ADJ_FRONT(0));
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await getJob(t, JOB))?.status).toBe("processing");
    expect((await getJob(t, JOB))?.resolverCalls).toBeUndefined();

    for (const [i, spec] of [ADJ_BACK(1), ADJ_FRONT(2), ADJ_BACK(3)].entries()) {
      await complete(t, JOB, ids[i + 1], spec);
      await t.finishAllScheduledFunctions(vi.runAllTimers);
    }

    // The final run saw all four rows and records the batch's full count.
    expect((await getJob(t, JOB))?.status).toBe("succeeded");
    expect((await getJob(t, JOB))?.resolverCalls).toBe(4);
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

    // Two done images → 2, which REPLACES the stale 9 (a set, not an add — an
    // add would read 11).
    expect((await getJob(t, JOB))?.resolverCalls).toBe(2);
  });

  test("a job that never paired defaults resolverCalls to 0", async () => {
    // 0 is stored as absent — nothing writes it on a job that never reached a
    // pairing run — and every reader defaults it back to 0.
    const JOB = "job-resolver-zero-default";
    const t = convexTest(schema, modules);
    await seedJob(t, JOB, { status: "pending" });

    expect((await getJob(t, JOB))?.resolverCalls).toBeUndefined();
    const job = await t
      .withIdentity(USER_A)
      .query(api.placeholderPipeline.getPlaceholderJob, { jobId: JOB });
    expect(job?.resolverCalls).toBe(0);
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

  test("an adjacency fallback pair yields to identity when the real partner arrives, deleting the old row", async () => {
    // The diff's DELETE branch, and the fix in miniature. A readable front and
    // an unreadable back are paired by the scan-order fallback while the front's
    // true back is still processing. When that true back completes, identity
    // claims the front, the fallback pair is withdrawn, and its stored row must
    // be DELETED — not left behind pointing at a pairing identity has overruled.
    const JOB = "job-fallback-yields";
    const t = convexTest(schema, modules);
    await seedJob(t, JOB, { totalImages: 3 });
    const front = await seedImage(t, JOB, 0, "processing");
    const blankBack = await seedImage(t, JOB, 1, "processing");
    const realBack = await seedImage(t, JOB, 2, "processing");

    // Front (Gray) + an unreadable back complete first. Identity can't place the
    // blank back, so the fallback pairs 0-1 by scan order.
    await complete(t, JOB, front, { entryIndex: 0, textCount: 1, players: ["Sonny Gray"], team: "Minnesota Twins" });
    await complete(t, JOB, blankBack, BLANK_BACK(1));
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const firstPass = await getPairs(t, JOB);
    expect(firstPass).toHaveLength(1);
    expect([firstPass[0].frontIndex, firstPass[0].backIndex]).toEqual([0, 1]);
    expect(firstPass[0].mechanism).toBe("adjacency");

    // Gray's real back lands. Identity pairs 0-2, and the adjacency 0-1 must go.
    await complete(t, JOB, realBack, { entryIndex: 2, textCount: 40, players: ["Sonny Gray"], team: "Minnesota Twins", cardNumber: "54" });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const secondPass = await getPairs(t, JOB);
    expect(secondPass).toHaveLength(1);
    expect([secondPass[0].frontIndex, secondPass[0].backIndex]).toEqual([0, 2]);
    expect(secondPass[0].mechanism).toBe("pool");
    // The stale adjacency row is gone, not merely superseded in place.
    expect(secondPass[0]._id).not.toBe(firstPass[0]._id);
    // The blank back that identity could not place is now correctly unmatched.
    expect((await getImages(t, JOB)).map((i) => i.pairStatus)).toEqual([
      "paired",
      "unmatched",
      "paired",
    ]);
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

// ---------------------------------------------------------------------------
// The precedence primitives, unit-tested directly
// ---------------------------------------------------------------------------
//
// The pipeline tests above exercise these through the full flow, but the guard
// and the walk are small pure functions whose edges (a missing field is not a
// contradiction; the stray-recovery advance; opposite-side requirement) are
// clearest — and cheapest to pin against a regression — in isolation.

const card = (key: string, side: "front" | "back", id: Partial<{ player: string; team: string }> = {}) =>
  createPoolCard({ key, side, player: id.player ?? null, team: id.team ?? null });

describe("identitiesContradict", () => {
  test("two known, disagreeing players contradict", () => {
    expect(identitiesContradict(card("0", "front", { player: "Sonny Gray" }), card("1", "back", { player: "Eric Hosmer" }))).toBe(true);
  });
  test("two known, agreeing players do not", () => {
    expect(identitiesContradict(card("0", "front", { player: "Sonny Gray" }), card("1", "back", { player: "Sonny Gray" }))).toBe(false);
  });
  test("a missing player on either side is never a contradiction", () => {
    expect(identitiesContradict(card("0", "front", { player: "Sonny Gray" }), card("1", "back"))).toBe(false);
    expect(identitiesContradict(card("0", "front"), card("1", "back", { player: "Eric Hosmer" }))).toBe(false);
    expect(identitiesContradict(card("0", "front"), card("1", "back"))).toBe(false);
  });
  test("team disagreement contradicts even with no player", () => {
    expect(identitiesContradict(card("0", "front", { team: "Minnesota Twins" }), card("1", "back", { team: "San Diego Padres" }))).toBe(true);
  });
  test("agreeing team, no player, does not contradict", () => {
    expect(identitiesContradict(card("0", "front", { team: "Minnesota Twins" }), card("1", "back", { team: "Minnesota Twins" }))).toBe(false);
  });
});

describe("guardedAdjacencyFallback", () => {
  test("pairs an opposite-side neighbour when nothing contradicts", () => {
    const pairs = guardedAdjacencyFallback([card("0", "front"), card("1", "back")]);
    expect(pairs.map(([a, b]) => [a.key, b.key])).toEqual([["0", "1"]]);
  });
  test("never pairs same-side neighbours", () => {
    expect(guardedAdjacencyFallback([card("0", "front"), card("1", "front")])).toEqual([]);
  });
  test("never pairs contradicting neighbours", () => {
    expect(
      guardedAdjacencyFallback([
        card("0", "front", { player: "Sonny Gray" }),
        card("1", "back", { player: "Eric Hosmer" }),
      ]),
    ).toEqual([]);
  });
  test("advances by one past a stray so the alternation behind it still pairs", () => {
    // [front, front, back]: the first front is a stray (same side as its
    // neighbour); the walk steps past it and pairs the second front with the
    // back, exactly like the ported planAdjacency's recovery.
    const pairs = guardedAdjacencyFallback([card("0", "front"), card("1", "front"), card("2", "back")]);
    expect(pairs.map(([a, b]) => [a.key, b.key])).toEqual([["1", "2"]]);
  });
  test("sorts by entry index before walking, regardless of input order", () => {
    const pairs = guardedAdjacencyFallback([card("2", "back"), card("0", "front")]);
    expect(pairs.map(([a, b]) => [a.key, b.key])).toEqual([["0", "2"]]);
  });
  test("does not reuse a card across two pairs", () => {
    // [front, back, front]: pairs 0-1, then index 2 is alone.
    const pairs = guardedAdjacencyFallback([card("0", "front"), card("1", "back"), card("2", "front")]);
    expect(pairs.map(([a, b]) => [a.key, b.key])).toEqual([["0", "1"]]);
  });
});

// ---------------------------------------------------------------------------
// computePairingDiff — the pure recompute both callers apply (NEO-175)
// ---------------------------------------------------------------------------
//
// `runPairing` (the scheduled action) and `finalizePairingInline` (the inline
// close path) both call this ONE function, which is what guarantees they produce
// byte-identical pairs. These drive it directly, with no ctx: they pin the diff
// shape the two callers rely on.

describe("computePairingDiff (pure)", () => {
  /** A done image row in the shape `listDoneImagesForPairing` returns. */
  function imageRow(
    entryIndex: number,
    fields: Omit<Partial<PairingImageRow>, "_id" | "entryIndex" | "originalName">,
  ): PairingImageRow {
    return {
      _id: `img-${entryIndex}` as unknown as Id<"placeholderImages">,
      entryIndex,
      originalName: `scan-${entryIndex}.jpg`,
      ...fields,
    };
  }

  const griffeyFront = (i: number) =>
    imageRow(i, { side: "front", textCount: 1, players: ["Ken Griffey Jr."], team: "Seattle Mariners" });
  const griffeyBack = (i: number) =>
    imageRow(i, {
      side: "back",
      textCount: 40,
      players: ["Ken Griffey Jr."],
      team: "Seattle Mariners",
      cardNumber: "24",
    });

  test("pairs a clean front/back by identity, inserting the merged row", () => {
    const diff = computePairingDiff([griffeyFront(0), griffeyBack(1)], []);

    expect(diff.deleteIds).toEqual([]);
    expect(diff.patches).toEqual([]);
    expect(diff.insertRows).toHaveLength(1);
    // Merged identity: front-preferred player/team, back-only card number.
    expect(diff.insertRows[0]).toMatchObject({
      frontIndex: 0,
      backIndex: 1,
      player: "Ken Griffey Jr.",
      team: "Seattle Mariners",
      cardNumber: "24",
    });
    // Identity-first resolves one call per done image.
    expect(diff.resolverCalls).toBe(2);
    // Both images move to "paired"; nothing becomes unmatched.
    expect(diff.becomingPaired.sort()).toEqual(
      ["img-0", "img-1"].sort() as unknown as Id<"placeholderImages">[],
    );
    expect(diff.becomingUnmatched).toEqual([]);
  });

  test("a pair already stored identically produces NO writes (a diff, not a rebuild)", () => {
    const rows = [griffeyFront(0), griffeyBack(1)];
    // Compute once to get the exact stored shape, then feed it back as `stored`.
    const first = computePairingDiff(rows, []);
    const stored: StoredPairRow[] = first.insertRows.map((r, idx) => ({
      _id: `pair-${idx}` as unknown as Id<"placeholderPairs">,
      ...r,
    }));
    // And the images already carry the verdict the first run computed.
    const rowsPaired = rows.map((r) => ({ ...r, pairStatus: "paired" as const }));

    const second = computePairingDiff(rowsPaired, stored);
    expect(second.deleteIds).toEqual([]);
    expect(second.patches).toEqual([]);
    expect(second.insertRows).toEqual([]);
    expect(second.becomingPaired).toEqual([]);
    expect(second.becomingUnmatched).toEqual([]);
  });

  test("a stored AUTO pair no longer desired is deleted", () => {
    // Only a lone front is done now, but an auto pair (0,1) is still stored: it
    // is stale and must be removed, and the surviving image goes unmatched.
    const stored: StoredPairRow[] = [
      {
        _id: "pair-stale" as unknown as Id<"placeholderPairs">,
        frontIndex: 0,
        backIndex: 1,
        player: "Ken Griffey Jr.",
        team: "Seattle Mariners",
        confidence: "exact",
        mechanism: "pool",
        score: 1,
      },
    ];
    const diff = computePairingDiff([griffeyFront(0)], stored);
    expect(diff.deleteIds).toEqual(["pair-stale"] as unknown as Id<"placeholderPairs">[]);
    expect(diff.insertRows).toEqual([]);
    expect(diff.becomingUnmatched).toEqual(["img-0"] as unknown as Id<"placeholderImages">[]);
  });

  test("an EXACT pair is sticky — a later, better candidate cannot break it", () => {
    // The behaviour the lock exists for. Pairing recomputes the whole batch on
    // every completion, and the pool was free to revise a settled decision when
    // a later image scored better — so a pair the user had already seen could
    // silently come apart and re-form. An exact match is a certainty, not a
    // guess, so it is now final.
    const stored: StoredPairRow[] = [
      {
        _id: "pair-exact" as unknown as Id<"placeholderPairs">,
        frontIndex: 0,
        backIndex: 3,
        player: "Ken Griffey Jr.",
        team: "Seattle Mariners",
        confidence: "exact",
        mechanism: "pool",
        score: 1,
      },
    ];
    // `true` — the lock only applies once the batch has finished; mid-batch a
    // pair is a verdict on partial data and stays revisable.
    const diff = computePairingDiff(
      [griffeyFront(0), griffeyFront(1), griffeyBack(2), griffeyBack(3)],
      stored,
      true,
    );

    // Never a delete candidate, exactly like a manual pair.
    expect(diff.deleteIds).toEqual([]);
    // The remaining two images pair with each other, not with 0 or 3.
    expect(diff.insertRows).toHaveLength(1);
    expect(diff.insertRows[0]).toMatchObject({ frontIndex: 1, backIndex: 2 });
    const touched = [...diff.becomingPaired, ...diff.becomingUnmatched];
    expect(touched).not.toContain("img-0");
    expect(touched).not.toContain("img-3");
  });

  test("a STALE exact pair is still deleted — the lock requires both halves live", () => {
    // The guard that the "stored AUTO pair no longer desired" test caught the
    // absence of. Locking on confidence alone would strand a pair whose partner
    // was reset to "queued" by a restart: excluded from the diff, so never
    // deleted, pointing at an image that is not processed. Liveness is what
    // keeps "sticky" from meaning "immortal".
    const stored: StoredPairRow[] = [
      {
        _id: "pair-exact-stale" as unknown as Id<"placeholderPairs">,
        frontIndex: 0,
        backIndex: 1,
        player: "Ken Griffey Jr.",
        team: "Seattle Mariners",
        confidence: "exact",
        mechanism: "pool",
        score: 1,
      },
    ];
    // Only index 0 is done; index 1 is gone from the done set.
    const diff = computePairingDiff([griffeyFront(0)], stored);
    expect(diff.deleteIds).toEqual([
      "pair-exact-stale",
    ] as unknown as Id<"placeholderPairs">[]);
  });

  test("a FUZZY pair stays fluid — it is a potential match, not a settled one", () => {
    // The other half of the rule. Anything below exact is what the UI shows as
    // a POTENTIAL match, and those are precisely the ones a later image should
    // be allowed to improve, so they must remain deletable and re-pairable.
    const stored: StoredPairRow[] = [
      {
        _id: "pair-fuzzy" as unknown as Id<"placeholderPairs">,
        frontIndex: 0,
        backIndex: 3,
        player: "Ken Griffey Jr.",
        confidence: "fuzzy",
        mechanism: "pool",
        score: 0.5,
      },
    ];
    const diff = computePairingDiff(
      [griffeyFront(0), griffeyFront(1), griffeyBack(2), griffeyBack(3)],
      stored,
    );
    // Not locked: the matcher reconsidered it, so the stale row goes.
    expect(diff.deleteIds).toEqual([
      "pair-fuzzy",
    ] as unknown as Id<"placeholderPairs">[]);
  });

  test("a MANUAL pair is sticky — its images are excluded and its row untouched", () => {
    // Front 0 and back 3 are manually paired; the automatic pass must not see
    // either image, must not delete the manual row, and must pair the remaining
    // real front/back (1,2).
    const stored: StoredPairRow[] = [
      {
        _id: "pair-manual" as unknown as Id<"placeholderPairs">,
        frontIndex: 0,
        backIndex: 3,
        confidence: "side-only",
        mechanism: "manual",
        score: 0,
      },
    ];
    const diff = computePairingDiff(
      [griffeyFront(0), griffeyFront(1), griffeyBack(2), griffeyBack(3)],
      stored,
    );
    // The manual row is never a delete candidate.
    expect(diff.deleteIds).toEqual([]);
    // Exactly one new auto pair, over the non-manual images (1,2).
    expect(diff.insertRows).toHaveLength(1);
    expect(diff.insertRows[0]).toMatchObject({ frontIndex: 1, backIndex: 2 });
    // The manually-paired images (0,3) are excluded from the pairStatus diff.
    const touched = [...diff.becomingPaired, ...diff.becomingUnmatched];
    expect(touched).not.toContain("img-0");
    expect(touched).not.toContain("img-3");
  });
});
