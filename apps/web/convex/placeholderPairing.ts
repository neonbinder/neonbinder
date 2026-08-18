/**
 * Front/back pairing pass — the last stage of a placeholder batch (NEO-170).
 *
 * Runs in the DEFAULT runtime, not Node. `pairBatch` is a pure TypeScript port
 * of the algorithm that used to live in services/preprocess/app/pairing/; it
 * touches no Node APIs, and keeping it out of the Node runtime means this
 * action starts without the Node cold-start penalty on every batch.
 *
 * The interesting property of this stage is that it costs nothing. In the
 * Python original, `resolveIdentity` was a Haiku call and was the expensive
 * part of the whole pipeline — the adjacency pre-pass existed specifically to
 * avoid paying it. Here the identity was already produced by `/process-entry`
 * and is sitting on the placeholderImages row, so `resolveIdentity` is a
 * dictionary lookup. `resolverCalls` therefore stops being a spend metric and
 * becomes pure diagnostics: it tells us how often adjacency failed to settle a
 * pair, which is the signal for whether scan order is being preserved.
 *
 * ## Why this runs many times per batch
 *
 * Because pairing is free, it does not have to wait for the batch to finish.
 * `runPairing` is scheduled after image completions (debounced through
 * `placeholderJobs.pairingScheduled`) as well as at the end, so a pair reaches
 * the client's `listPlaceholderPairs` subscription the moment both of its halves
 * have been processed rather than minutes later when the last unrelated image
 * lands. That is what makes a 200-card scanner session feel live.
 *
 * Two properties make repeated runs safe, and both are worth stating plainly:
 *
 *  - **Every run is a full recomputation, and the writes are a DIFF.** The
 *    action recomputes `pairBatch` over all done rows in entry-index order —
 *    never an "add just this pair" shortcut — then compares the result against
 *    what is stored, keyed on (frontIndex, backIndex), and writes only the
 *    difference. Pairs that did not change are not touched, so a subscribed
 *    client re-renders on real changes only. This matters beyond flicker: the
 *    pool's matcher can legitimately revise an earlier decision when a better
 *    candidate arrives, and a diff expresses that as one pair leaving and
 *    another arriving, where an append-only writer would accumulate both.
 *  - **Only the FINAL run decides the batch's fate.** `final: false` runs write
 *    pairs and nothing else — no status transition, no `markJobFailed`, and a
 *    throw is logged rather than failing the job. Everything about the terminal
 *    decision below is exactly as it was when this ran once per batch.
 *
 * Together those give the convergence property the design rests on: the state
 * after the final run is the state a single end-of-batch run would have
 * produced, no matter how many provisional runs preceded it.
 */

import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { pairBatch } from "./lib/pairing/pairBatch";
import type { CardSide, Confidence, Mechanism } from "./lib/pairing/types";
import { findJob, INCREMENTAL_PAIRING_STATUSES } from "./placeholderPipeline";

/** Rows written per applyPairDiff / syncImagePairStatus invocation. */
const PAIR_CHUNK_SIZE = 50;

const CONFIDENCES: readonly string[] = ["exact", "fuzzy", "side-only"];
const MECHANISMS: readonly string[] = ["adjacency", "pool"];

/**
 * Coerce pairBatch's `confidence` / `mechanism` into the schema's unions.
 *
 * These are already typed as literal unions in the pairing module, so the
 * checks are belt-and-braces — but they guard a real failure mode: an
 * unrecognized literal would be rejected by the table's validator at INSERT
 * time, i.e. after the batch has done all its work, and would fail the whole
 * chunk rather than one pair. Degrading to the weakest honest value keeps a
 * vocabulary change from destroying an otherwise-good batch.
 */
function asConfidence(value: unknown): Confidence {
  return typeof value === "string" && CONFIDENCES.includes(value)
    ? (value as Confidence)
    : "side-only";
}

function asMechanism(value: unknown): Mechanism {
  return typeof value === "string" && MECHANISMS.includes(value)
    ? (value as Mechanism)
    : "pool";
}

/** null → undefined, and anything non-string → undefined. */
function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Narrow the stored `side` column to the pairing module's `CardSide`.
 *
 * The column is a plain string because the vocabulary belongs to the
 * preprocess service's classifier, not to us. Anything outside {front, back}
 * becomes null, which pairing reads as "no side evidence" and answers with the
 * text-count heuristic — the same degradation it applies when the classifier
 * was never run. Coercing an unknown value to "front" instead would be an
 * invented fact.
 */
function asCardSide(value: unknown): CardSide | null {
  return value === "front" || value === "back" ? value : null;
}

/**
 * One pair the current run wants to exist, in the shape the diff compares and
 * the shape `applyPairDiff` inserts.
 *
 * `frontImageId` / `backImageId` are carried alongside the indexes but are NOT
 * stored: they are how the `pairStatus` half of the diff addresses the image
 * rows (see the note on `applyPairDiff` about why writes go by id).
 */
type DesiredPair = {
  frontImageId: Id<"placeholderImages">;
  backImageId: Id<"placeholderImages">;
  frontIndex: number;
  backIndex: number;
  player?: string;
  team?: string;
  cardNumber?: string;
  confidence: Confidence;
  mechanism: Mechanism;
  score: number;
};

/** A revision to an existing pair row — everything except its identity. */
type PairPatch = {
  pairId: Id<"placeholderPairs">;
  player?: string;
  team?: string;
  cardNumber?: string;
  confidence: Confidence;
  mechanism: Mechanism;
  score: number;
};

/**
 * The identity of a pair row, as a map key.
 *
 * (frontIndex, backIndex) and not the document id, because the document id is
 * what the diff is trying to LOOK UP: a run has just recomputed pairs from
 * scratch and needs to know which stored row, if any, is the same pair. Entry
 * indexes are unique within a job and stable across runs, so the same physical
 * card produces the same key every time; the id only exists once the row does.
 *
 * The two halves are joined with a character that cannot appear in a decimal
 * integer, so `(1, 23)` and `(12, 3)` cannot collide.
 */
function pairKey(frontIndex: number, backIndex: number): string {
  return `${frontIndex}:${backIndex}`;
}

/**
 * Pair up a batch and — on the final run only — set its terminal status.
 *
 * The terminal decision is made here rather than at the end of processing
 * because "did this batch work?" is a question about the batch as a whole, and
 * the answer is not simply "did every image succeed". A print sheet with one
 * unreadable scan is a good batch; one where most images failed is not,
 * regardless of whether the failures were individually retryable.
 *
 * `final` defaults to TRUE, so every caller that predates incremental pairing
 * keeps its meaning without being touched: the last-one-done transition in
 * `recordImageOutcomeImpl`, the no-usable-images hand-off in
 * `pruneUnregisteredImages`, and `closePlaceholderStream` all schedule the run
 * that ends the batch. Only the debounced completion hook passes `false`, and
 * that run is purely additive — it writes pairs and returns.
 *
 * The whole body is wrapped in a try/catch that ends in `markJobFailed`,
 * because a FINAL run is the LAST link in the chain: "pairing" is not a
 * terminal status, nothing is scheduled behind this action, and Convex does
 * not retry a scheduled action that throws. Any escape — a pairing bug on a
 * pathological batch, an OCC conflict on a chunk mutation, a validator
 * rejection — would leave the job stuck in "pairing" with no writer left
 * alive to move it, which reads to the user as a spinner that never stops.
 * Failing the job is worse than succeeding and better than hanging: "failed"
 * is startable, so the user has a way forward, and a restart keeps every image
 * that already processed.
 *
 * A PROVISIONAL run must not do that. It is not the last link — more
 * completions are coming, and the final run will recompute everything from
 * scratch — so killing a healthy batch because one intermediate pass hit an OCC
 * conflict would be the cure causing the disease. It logs and returns.
 */
export const runPairing = internalAction({
  args: {
    jobId: v.string(),
    userId: v.string(),
    /**
     * Absent means final. See the note above on why the default is this way
     * round rather than the safer-looking `final: v.boolean()`.
     */
    final: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const final = args.final ?? true;
    try {
      // FIRST, before anything is read. Clearing the debounce latch up front is
      // what makes the sequence converge: a completion landing while this run is
      // still working finds the latch clear, sets it, and schedules a successor
      // that will see the row this run missed. Clearing it at the END would let
      // that completion find the latch still set, schedule nothing, and leave
      // its image unpaired until the final run — which is the whole bug the
      // ordering exists to prevent.
      await ctx.runMutation(internal.placeholderPairing.clearPairingScheduled, {
        jobId: args.jobId,
      });

      const job = await ctx.runQuery(internal.placeholderPipeline.getJobInternal, {
        jobId: args.jobId,
      });
      if (!job) return null;

      // A provisional run is scheduled and then arrives some time later, by
      // which point the job may have been canceled, restarted, or closed and
      // handed to its final run. Writing pairs into any of those would be a
      // stale writer fighting the live one. The final run has no equivalent
      // guard, and must not grow one: it is the only thing that can move a job
      // out of "pairing", so refusing to act on an unexpected status is exactly
      // how a batch gets stuck.
      if (!final && !INCREMENTAL_PAIRING_STATUSES.has(job.status)) return null;

      const rows = await ctx.runQuery(
        internal.placeholderPipeline.listDoneImagesForPairing,
        { jobId: args.jobId },
      );

      // Key by zip index. It is stable, unique within the batch, and — unlike
      // the original filename — cannot collide, which matters because the pool
      // uses the key as a dictionary key. The VALUE carries `_id`, which is
      // what the write-back is keyed on; see the note on
      // `listDoneImagesForPairing`.
      const byKey = new Map(rows.map((r) => [String(r.entryIndex), r] as const));

      // The desired state, recomputed from scratch every run. `pairBatch` is a
      // pure function of the done rows in entry-index order, so two runs over
      // the same rows produce the same answer — which is what lets the writes
      // below be a diff rather than a rebuild.
      const desired: DesiredPair[] = [];
      const pairedIds = new Set<string>();
      let resolverCalls = 0;

      if (rows.length > 0) {
        const result = pairBatch(
          rows.map((r) => ({
            key: String(r.entryIndex),
            textCount: r.textCount ?? 0,
            originalFilename: r.originalName,
            side: asCardSide(r.side),
          })),
          {
            // Already-resolved identity, straight off the row — see the module
            // comment. Returning null for a key we do not have lets pairing
            // degrade to the text-count side heuristic instead of throwing.
            resolveIdentity: (key: string) => {
              const row = byKey.get(key);
              if (!row) return null;
              return {
                // `players` is the canonical list. `player` is derived from it
                // here rather than read from a column, because the row has no
                // such column — the service computes its `player` field as
                // `players[0]` and a stored copy could only go stale.
                // CardIdentity is an interface and cannot derive one from the
                // other, so both are supplied.
                players: row.players ?? [],
                player: row.players?.[0] ?? null,
                team: row.team ?? null,
                cardNumber: row.cardNumber ?? null,
                side: asCardSide(row.side),
              };
            },
            // The perceptual hash `/process-entry` already computed. Null when
            // the service could not produce one (or produced a malformed one —
            // see `asDhash` in placeholderPipeline.ts); pairing treats that as
            // "cannot compare these two images" rather than "they differ".
            hashImage: (key: string) => byKey.get(key)?.dhash ?? null,
            useAdjacency: true,
          },
        );

        resolverCalls = result.resolverCalls;
        for (const match of result.matches) {
          const front =
            typeof match.front?.key === "string" ? byKey.get(match.front.key) : undefined;
          const back =
            typeof match.back?.key === "string" ? byKey.get(match.back.key) : undefined;
          // A match whose keys don't resolve back to rows we read is unusable —
          // dropping it leaves both images "unmatched", which is accurate,
          // rather than writing a pair row pointing at images that don't exist.
          if (!front || !back) continue;
          pairedIds.add(front._id);
          pairedIds.add(back._id);
          desired.push({
            frontImageId: front._id,
            backImageId: back._id,
            frontIndex: front.entryIndex,
            backIndex: back.entryIndex,
            player: optionalString(match.player),
            team: optionalString(match.team),
            cardNumber: optionalString(match.cardNumber),
            confidence: asConfidence(match.confidence),
            mechanism: asMechanism(match.mechanism),
            score: typeof match.score === "number" ? match.score : 0,
          });
        }
      }

      // ---- Diff the desired state against what is stored ----------------
      //
      // Runs on every pass, including the first (where `stored` is empty and the
      // diff degenerates to the insert-everything behaviour this used to have)
      // and including a pass over zero done rows (where every stored pair is
      // stale and goes). One code path, no special cases.
      const stored = await ctx.runQuery(internal.placeholderPairing.listPairsForDiff, {
        jobId: args.jobId,
      });
      const storedByKey = new Map(stored.map((p) => [pairKey(p.frontIndex, p.backIndex), p]));

      const inserts: DesiredPair[] = [];
      const patches: PairPatch[] = [];
      const desiredKeys = new Set<string>();
      for (const pair of desired) {
        const key = pairKey(pair.frontIndex, pair.backIndex);
        desiredKeys.add(key);
        const current = storedByKey.get(key);
        if (!current) {
          inserts.push(pair);
        } else if (
          // Identity of a pair row is (frontIndex, backIndex); everything else
          // is revisable. An untouched row is the common case by far — most
          // pairs are settled by the first run that sees both halves — and NOT
          // writing it is the point: a patch is a change the client's
          // subscription re-renders on.
          current.player !== pair.player ||
          current.team !== pair.team ||
          current.cardNumber !== pair.cardNumber ||
          current.confidence !== pair.confidence ||
          current.mechanism !== pair.mechanism ||
          current.score !== pair.score
        ) {
          patches.push({
            pairId: current._id,
            player: pair.player,
            team: pair.team,
            cardNumber: pair.cardNumber,
            confidence: pair.confidence,
            mechanism: pair.mechanism,
            score: pair.score,
          });
        }
      }
      const deleteIds = stored
        .filter((p) => !desiredKeys.has(pairKey(p.frontIndex, p.backIndex)))
        .map((p) => p._id);

      // Deletes first, then patches, then inserts. The three sets are disjoint
      // by construction so the order cannot change the outcome — but it does
      // change what a client subscribed to `listPlaceholderPairs` sees in
      // between, and "the superseded pair disappears before its replacement
      // appears" is the honest intermediate state. The reverse order briefly
      // shows the same image paired twice.
      for (let i = 0; i < deleteIds.length; i += PAIR_CHUNK_SIZE) {
        await ctx.runMutation(internal.placeholderPairing.applyPairDiff, {
          jobId: args.jobId,
          userId: args.userId,
          deleteIds: deleteIds.slice(i, i + PAIR_CHUNK_SIZE),
          patches: [],
          inserts: [],
        });
      }
      for (let i = 0; i < patches.length; i += PAIR_CHUNK_SIZE) {
        await ctx.runMutation(internal.placeholderPairing.applyPairDiff, {
          jobId: args.jobId,
          userId: args.userId,
          deleteIds: [],
          patches: patches.slice(i, i + PAIR_CHUNK_SIZE),
          inserts: [],
        });
      }
      // `frontImageId` / `backImageId` are dropped on the way in: they address
      // the IMAGE rows for the pairStatus half of the diff and are not columns
      // on a pair row, which stores entry indexes (see `applyPairDiff`).
      const insertRows = inserts.map((pair) => ({
        frontIndex: pair.frontIndex,
        backIndex: pair.backIndex,
        player: pair.player,
        team: pair.team,
        cardNumber: pair.cardNumber,
        confidence: pair.confidence,
        mechanism: pair.mechanism,
        score: pair.score,
      }));
      for (let i = 0; i < insertRows.length; i += PAIR_CHUNK_SIZE) {
        await ctx.runMutation(internal.placeholderPairing.applyPairDiff, {
          jobId: args.jobId,
          userId: args.userId,
          deleteIds: [],
          patches: [],
          inserts: insertRows.slice(i, i + PAIR_CHUNK_SIZE),
        });
      }

      // The same diff, applied to `placeholderImages.pairStatus`. Derived from
      // what was actually PAIRED above rather than from `result.unmatched`: a
      // match dropped for an unresolvable key must end up marked unmatched, and
      // reading the paired set back is the only way that stays true. Rows whose
      // verdict is unchanged are excluded here rather than inside the mutation
      // so an unchanged batch costs zero mutations, not one per chunk.
      const becomingPaired: Array<Id<"placeholderImages">> = [];
      const becomingUnmatched: Array<Id<"placeholderImages">> = [];
      for (const row of rows) {
        const want = pairedIds.has(row._id) ? "paired" : "unmatched";
        if (row.pairStatus === want) continue;
        (want === "paired" ? becomingPaired : becomingUnmatched).push(row._id);
      }
      for (let i = 0; i < becomingPaired.length; i += PAIR_CHUNK_SIZE) {
        await ctx.runMutation(internal.placeholderPairing.syncImagePairStatus, {
          jobId: args.jobId,
          pairStatus: "paired",
          imageIds: becomingPaired.slice(i, i + PAIR_CHUNK_SIZE),
        });
      }
      for (let i = 0; i < becomingUnmatched.length; i += PAIR_CHUNK_SIZE) {
        await ctx.runMutation(internal.placeholderPairing.syncImagePairStatus, {
          jobId: args.jobId,
          pairStatus: "unmatched",
          imageIds: becomingUnmatched.slice(i, i + PAIR_CHUNK_SIZE),
        });
      }

      if (rows.length > 0) {
        console.log(
          JSON.stringify({
            msg: "placeholder_pairing_done",
            jobId: args.jobId,
            final,
            images: rows.length,
            pairs: desired.length,
            unmatched: rows.length - pairedIds.size,
            inserted: inserts.length,
            revised: patches.length,
            removed: deleteIds.length,
            resolverCalls,
          }),
        );
      }

      // Everything above is what a provisional run does, and it stops here. The
      // batch is not over: more images may still complete, and the run that
      // observes the last of them will redo all of it before deciding anything.
      if (!final) return null;

      // Terminal decision. `failedImages * 2 > totalImages` rather than a
      // division so the comparison is exact on odd totals (5 images, 3 failures
      // is a failed batch; 5 and 2 is not).
      const noUsableImages = job.totalImages === 0;
      if (noUsableImages || job.failedImages * 2 > job.totalImages) {
        await ctx.runMutation(internal.placeholderPipeline.markJobFailed, {
          jobId: args.jobId,
          errorCode: "TOO_MANY_IMAGE_FAILURES",
          errorDetail: noUsableImages
            ? // The two modes reach zero usable images by different routes, and
              // telling a scanner user their "upload" was rejected sends them
              // looking for a file they never chose.
              job.mode === "stream"
              ? "no images were uploaded before the batch was closed"
              : "no images were accepted from the upload"
            : `${job.failedImages} of ${job.totalImages} images failed to process`,
        });
        return null;
      }

      await ctx.runMutation(internal.placeholderPipeline.markJobSucceeded, {
        jobId: args.jobId,
      });
      return null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[runPairing] job=${args.jobId} final=${final} failed: ${message}`,
      );
      // A provisional run failing is not the batch failing. Nothing downstream
      // depends on it having succeeded — the final run recomputes the whole
      // diff — so it stays out of the terminal path entirely. Only the run that
      // owns the terminal decision may make one.
      if (!final) return null;
      await ctx.runMutation(internal.placeholderPipeline.markJobFailed, {
        jobId: args.jobId,
        errorCode: "PAIRING_FAILED",
        errorDetail: message.slice(0, 1000),
      });
      return null;
    }
  },
});

/**
 * Clear the incremental-pairing debounce latch.
 *
 * Its own mutation rather than part of a larger one because of WHEN it has to
 * happen: `runPairing` is an action and must clear the latch before its first
 * read, in a transaction of its own, so a completion arriving one millisecond
 * later already sees a clear latch. Folding this into a later write would
 * shrink the window but not close it.
 *
 * A no-op when the latch is already clear — the final run calls this too, and on
 * a batch that never triggered an incremental pass there is nothing to clear.
 * Skipping the patch in that case keeps the job row from being written (and
 * every `getPlaceholderJob` subscriber from being woken) for no reason.
 */
export const clearPairingScheduled = internalMutation({
  args: { jobId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const job = await findJob(ctx, args.jobId);
    if (!job) return null;
    if (job.pairingScheduled === undefined) return null;
    await ctx.db.patch(job._id, { pairingScheduled: undefined });
    return null;
  },
});

/**
 * Every pair currently stored for a job, in the shape the diff compares on.
 *
 * Unbounded `.collect()` on purpose, and bounded in practice by the same thing
 * that bounds `getPlaceholderJob`'s pair count: a job holds at most
 * MAX_ZIP_ENTRIES entries and therefore at most half that many pairs. The diff
 * needs the WHOLE stored set in one place — a pair missing from a partial read
 * looks exactly like a pair that needs inserting, and inserting it would produce
 * the duplicate the (frontIndex, backIndex) key exists to prevent.
 */
export const listPairsForDiff = internalQuery({
  args: { jobId: v.string() },
  returns: v.array(
    v.object({
      _id: v.id("placeholderPairs"),
      frontIndex: v.number(),
      backIndex: v.number(),
      player: v.optional(v.string()),
      team: v.optional(v.string()),
      cardNumber: v.optional(v.string()),
      confidence: v.union(
        v.literal("exact"),
        v.literal("fuzzy"),
        v.literal("side-only"),
      ),
      mechanism: v.union(v.literal("adjacency"), v.literal("pool")),
      score: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const pairs = await ctx.db
      .query("placeholderPairs")
      .withIndex("by_job", (q) => q.eq("jobId", args.jobId))
      .collect();
    return pairs.map((p) => ({
      _id: p._id,
      frontIndex: p.frontIndex,
      backIndex: p.backIndex,
      player: p.player,
      team: p.team,
      cardNumber: p.cardNumber,
      confidence: p.confidence,
      mechanism: p.mechanism,
      score: p.score,
    }));
  },
});

/**
 * Apply one chunk of the pair diff: delete stale rows, revise changed ones,
 * insert new ones.
 *
 * Chunked because a large sheet produces hundreds of pairs and one transaction
 * per batch would be needlessly large and correspondingly conflict-prone. The
 * caller passes exactly one of the three lists per call, so a chunk is bounded
 * by PAIR_CHUNK_SIZE writes whichever kind of work it is doing.
 *
 * Deletes and patches are keyed on the document ID rather than re-resolved from
 * (jobId, frontIndex, backIndex). Two reasons, both about the gap between
 * pairing's read and its writes — an action can sit for minutes between them:
 *
 *  - Correctness. If the job was canceled and restarted in that gap, the row
 *    that key now names is a DIFFERENT attempt's row, and stamping this run's
 *    verdict on it would be a lie. A `ctx.db.get` on the id either returns the
 *    row pairing actually read or returns nothing, and nothing is the honest
 *    answer — so a missing row is skipped, not an error.
 *  - Cost. It is a direct read instead of an index lookup per row.
 *
 * The `jobId` re-check on each row is not redundant with that. An id resolves to
 * a document regardless of which job it belongs to, and this mutation is what
 * stands between a caller's diff and the pairs table; confirming the row is
 * actually this job's keeps a bug in the diff arithmetic from deleting a
 * different (possibly another user's) job's pairs. Cheap guard, expensive
 * failure — the same trade `pruneUnregisteredImages` makes.
 *
 * Pair rows still STORE `frontIndex`/`backIndex`, not image ids: the entry index
 * is what identifies an image to the user and to the preprocess service, and a
 * stored document id would be a second, redundant identity that a restart would
 * silently invalidate.
 */
export const applyPairDiff = internalMutation({
  args: {
    jobId: v.string(),
    userId: v.string(),
    deleteIds: v.array(v.id("placeholderPairs")),
    patches: v.array(
      v.object({
        pairId: v.id("placeholderPairs"),
        player: v.optional(v.string()),
        team: v.optional(v.string()),
        cardNumber: v.optional(v.string()),
        confidence: v.union(
          v.literal("exact"),
          v.literal("fuzzy"),
          v.literal("side-only"),
        ),
        mechanism: v.union(v.literal("adjacency"), v.literal("pool")),
        score: v.number(),
      }),
    ),
    inserts: v.array(
      v.object({
        frontIndex: v.number(),
        backIndex: v.number(),
        player: v.optional(v.string()),
        team: v.optional(v.string()),
        cardNumber: v.optional(v.string()),
        confidence: v.union(
          v.literal("exact"),
          v.literal("fuzzy"),
          v.literal("side-only"),
        ),
        mechanism: v.union(v.literal("adjacency"), v.literal("pool")),
        score: v.number(),
      }),
    ),
  },
  returns: v.object({
    deleted: v.number(),
    revised: v.number(),
    inserted: v.number(),
  }),
  handler: async (ctx, args) => {
    let deleted = 0;
    for (const pairId of args.deleteIds) {
      const pair = await ctx.db.get(pairId);
      if (!pair || pair.jobId !== args.jobId) continue;
      await ctx.db.delete(pair._id);
      deleted += 1;
    }

    let revised = 0;
    for (const patch of args.patches) {
      const pair = await ctx.db.get(patch.pairId);
      if (!pair || pair.jobId !== args.jobId) continue;
      await ctx.db.patch(pair._id, {
        player: patch.player,
        team: patch.team,
        cardNumber: patch.cardNumber,
        confidence: patch.confidence,
        mechanism: patch.mechanism,
        score: patch.score,
      });
      revised += 1;
    }

    for (const insert of args.inserts) {
      await ctx.db.insert("placeholderPairs", {
        jobId: args.jobId,
        userId: args.userId,
        frontIndex: insert.frontIndex,
        backIndex: insert.backIndex,
        player: insert.player,
        team: insert.team,
        cardNumber: insert.cardNumber,
        confidence: insert.confidence,
        mechanism: insert.mechanism,
        score: insert.score,
      });
    }

    return { deleted, revised, inserted: args.inserts.length };
  },
});

/**
 * Stamp one verdict onto a chunk of image rows.
 *
 * "unmatched" means pairing ran for this row and found no partner — distinct
 * from leaving `pairStatus` unset, which means pairing has not looked at it at
 * all. While a batch is still collecting or processing, "unmatched" additionally
 * carries "…as of the images done so far", which is why `listPlaceholderPairs`
 * documents both fields as provisional until the job is terminal.
 *
 * The caller has already filtered out rows whose stored verdict matches, so
 * every id here is a genuine change; the VERDICT is not re-checked, because
 * that would be a second read of a row the action already read. The `jobId`
 * IS re-checked — the same defence-in-depth `applyPairDiff` keeps: a bug in
 * the diff arithmetic must not be able to stamp a different (possibly another
 * user's) job's images. By document ID, and a row that is gone is skipped
 * rather than reported.
 */
export const syncImagePairStatus = internalMutation({
  args: {
    jobId: v.string(),
    pairStatus: v.union(v.literal("paired"), v.literal("unmatched")),
    imageIds: v.array(v.id("placeholderImages")),
  },
  returns: v.number(),
  handler: async (ctx, args) => {
    let marked = 0;
    for (const imageId of args.imageIds) {
      const image = await ctx.db.get(imageId);
      if (!image) continue;
      if (image.jobId !== args.jobId) continue;
      await ctx.db.patch(image._id, { pairStatus: args.pairStatus });
      marked += 1;
    }
    return marked;
  },
});
