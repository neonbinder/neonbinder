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
 */

import { internalAction, internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { pairBatch } from "./lib/pairing/pairBatch";
import type { CardSide, Confidence, Mechanism } from "./lib/pairing/types";

/** Rows written per storePairs / markUnmatchedImages invocation. */
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
 * Pair up a finished batch and set its terminal status.
 *
 * The terminal decision is made here rather than at the end of processing
 * because "did this batch work?" is a question about the batch as a whole, and
 * the answer is not simply "did every image succeed". A print sheet with one
 * unreadable scan is a good batch; one where most images failed is not,
 * regardless of whether the failures were individually retryable.
 *
 * The whole body is wrapped in a try/catch that ends in `markJobFailed`,
 * because this action is the LAST link in the chain: "pairing" is not a
 * terminal status, nothing is scheduled behind this action, and Convex does
 * not retry a scheduled action that throws. Any escape — a pairing bug on a
 * pathological batch, an OCC conflict on a chunk mutation, a validator
 * rejection — would leave the job stuck in "pairing" with no writer left
 * alive to move it, which reads to the user as a spinner that never stops.
 * Failing the job is worse than succeeding and better than hanging: "failed"
 * is startable, so the user has a way forward, and a restart keeps every image
 * that already processed.
 */
export const runPairing = internalAction({
  args: { jobId: v.string(), userId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    try {
      const job = await ctx.runQuery(internal.placeholderPipeline.getJobInternal, {
        jobId: args.jobId,
      });
      if (!job) return null;

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

        const pairs: Array<{
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
        }> = [];
        const pairedIds = new Set<string>();
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
          pairs.push({
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

        for (let i = 0; i < pairs.length; i += PAIR_CHUNK_SIZE) {
          await ctx.runMutation(internal.placeholderPairing.storePairs, {
            jobId: args.jobId,
            userId: args.userId,
            pairs: pairs.slice(i, i + PAIR_CHUNK_SIZE),
          });
        }

        // Derived from what was actually STORED, not from `result.unmatched`:
        // a match dropped above must end up marked unmatched, and reading the
        // paired set back is the only way that stays true.
        const unmatchedIds = rows
          .map((r) => r._id)
          .filter((id) => !pairedIds.has(id));
        for (let i = 0; i < unmatchedIds.length; i += PAIR_CHUNK_SIZE) {
          await ctx.runMutation(internal.placeholderPairing.markUnmatchedImages, {
            imageIds: unmatchedIds.slice(i, i + PAIR_CHUNK_SIZE),
          });
        }

        console.log(
          JSON.stringify({
            msg: "placeholder_pairing_done",
            jobId: args.jobId,
            images: rows.length,
            pairs: pairs.length,
            unmatched: unmatchedIds.length,
            resolverCalls: result.resolverCalls,
          }),
        );
      }

      // Terminal decision. `failedImages * 2 > totalImages` rather than a
      // division so the comparison is exact on odd totals (5 images, 3 failures
      // is a failed batch; 5 and 2 is not).
      const noUsableImages = job.totalImages === 0;
      if (noUsableImages || job.failedImages * 2 > job.totalImages) {
        await ctx.runMutation(internal.placeholderPipeline.markJobFailed, {
          jobId: args.jobId,
          errorCode: "TOO_MANY_IMAGE_FAILURES",
          errorDetail: noUsableImages
            ? "no images were accepted from the upload"
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
      console.error(`[runPairing] job=${args.jobId} failed: ${message}`);
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
 * Insert a chunk of pairs and mark their images paired.
 *
 * Chunked because a large sheet produces hundreds of pairs and each one is two
 * writes (the pair row plus a patch on each side's image row); one transaction
 * per batch would be needlessly large and correspondingly conflict-prone.
 *
 * The image patch is keyed on the document ID rather than re-resolved from
 * (jobId, entryIndex). Two reasons, both about the gap between pairing's read
 * and its writes — an action can sit for minutes between them:
 *
 *  - Correctness. If the job was canceled and restarted in that gap, the row
 *    that (jobId, entryIndex) now names is a DIFFERENT attempt's row, and
 *    stamping this run's verdict on it would be a lie. A `ctx.db.get` on the
 *    id either returns the row pairing actually read or returns nothing, and
 *    nothing is the honest answer — so a missing row is skipped, not an error.
 *  - Cost. It is a direct read instead of an index lookup per side per pair.
 *
 * The pair row itself still STORES `frontIndex`/`backIndex`, not ids: the zip
 * entry index is what identifies an image to the user and to the preprocess
 * service, and a stored document id would be a second, redundant identity that
 * a restart would silently invalidate.
 */
export const storePairs = internalMutation({
  args: {
    jobId: v.string(),
    userId: v.string(),
    pairs: v.array(
      v.object({
        frontImageId: v.id("placeholderImages"),
        backImageId: v.id("placeholderImages"),
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
  returns: v.number(),
  handler: async (ctx, args) => {
    for (const pair of args.pairs) {
      await ctx.db.insert("placeholderPairs", {
        jobId: args.jobId,
        userId: args.userId,
        frontIndex: pair.frontIndex,
        backIndex: pair.backIndex,
        player: pair.player,
        team: pair.team,
        cardNumber: pair.cardNumber,
        confidence: pair.confidence,
        mechanism: pair.mechanism,
        score: pair.score,
      });
      for (const imageId of [pair.frontImageId, pair.backImageId]) {
        const image = await ctx.db.get(imageId);
        if (image) await ctx.db.patch(image._id, { pairStatus: "paired" });
      }
    }
    return args.pairs.length;
  },
});

/**
 * Mark a chunk of images as having been through pairing without finding a
 * partner. Distinct from leaving `pairStatus` unset, which means pairing has
 * not run for that row at all.
 *
 * By document ID, and a row that is gone is skipped rather than reported —
 * same reasoning as `storePairs`.
 */
export const markUnmatchedImages = internalMutation({
  args: { imageIds: v.array(v.id("placeholderImages")) },
  returns: v.number(),
  handler: async (ctx, args) => {
    let marked = 0;
    for (const imageId of args.imageIds) {
      const image = await ctx.db.get(imageId);
      if (!image) continue;
      await ctx.db.patch(image._id, { pairStatus: "unmatched" });
      marked += 1;
    }
    return marked;
  },
});
