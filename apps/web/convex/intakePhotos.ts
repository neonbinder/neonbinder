"use node";

/**
 * NEO-427 — a scanned pair's photos, onto the copy saved from it.
 *
 * `saveIntakeMatch` schedules `attachIntakePhotos` and returns; the save never
 * waits on this and nothing here touches the saved copy but its photos. For
 * each side the preprocess service makes the two sizes from the run's processed
 * output, a `source: "intake"` row is reserved, the files go to R2 from here,
 * and `commitUpload` makes the row live (and queues the card's listings). Then
 * `recordIntakePhotos` writes how it ended, which lets the run's listing kick
 * go ahead.
 *
 * The bytes move server side because a browser never holds a scanner run's
 * images, and R2 only takes a PUT signed for a known length, so no service can
 * be handed a URL ahead of knowing the size.
 *
 * Safe to run twice: a side with a live photo is left alone, so a retry fills
 * in only what is missing and a photo the collector added by hand stays.
 * Files of an attempt that dies before its commit belong to a pending row, and
 * `sweepCopyPhotos` removes both within the hour.
 */

import { isNonRetryableError } from "@convex-dev/workpool";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { action, internalAction, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import {
  callDeriveCopyPhotos,
  OUTPUT_NOT_FOUND_CODE,
  parsePreprocessErrorCode,
  type DerivedCopyPhotos,
} from "./adapters/preprocess";
import { requireSignedIn } from "./auth";
import { copyPhotoObjectKey } from "./copyPhotos";
import { putObject, r2Config, type R2Config } from "./lib/r2";

/**
 * Waits between tries at the preprocess service. The fast service also carries
 * the run's processing at its full instance ceiling, so a save can land on a
 * moment with no room (Cloud Run's 429), which clears in seconds.
 */
const DERIVE_RETRY_DELAYS_MS = [2_000, 8_000];
/** One file's PUT, retries included. Files are at most a few MB. */
const R2_PUT_TIMEOUT_MS = 30_000;
/**
 * How long one `reattachIntakeRunPhotos` run starts new rows for. One row can
 * take minutes when the service is down, and an action gets ten.
 */
const REATTACH_BUDGET_MS = 2 * 60 * 1000;

type Side = "front" | "back";
type Work = {
  ownerId: string;
  copyId: Id<"collectionCopies">;
  jobId: string;
  frontIndex: number;
  backIndex: number;
};
type AttachOutcome = { photos: "attached" } | { photos: "failed"; photoFailure: "scanGone" | "error" };

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The sides of the copy that have a live photo right now. */
async function liveSides(ctx: ActionCtx, work: Work): Promise<Set<Side>> {
  const photos = await ctx.runQuery(internal.listingDrain.copyPhotosForListing, {
    ownerId: work.ownerId,
    copyIds: [work.copyId],
  });
  return new Set(photos.map((photo) => photo.side));
}

async function deriveWithRetry(ctx: ActionCtx, work: Work, entryIndex: number): Promise<DerivedCopyPhotos> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await callDeriveCopyPhotos(ctx, { jobId: work.jobId, userId: work.ownerId, entryIndex });
    } catch (err) {
      const delay = DERIVE_RETRY_DELAYS_MS[attempt];
      if (isNonRetryableError(err) || delay === undefined) throw err;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

async function attachSide(
  ctx: ActionCtx,
  config: R2Config,
  work: Work,
  side: Side,
  entryIndex: number,
): Promise<void> {
  const derived = await deriveWithRetry(ctx, work, entryIndex);
  const { photoId, token }: { photoId: Id<"collectionCopyPhotos">; token: string } = await ctx.runMutation(
    internal.copyPhotos.reserveUpload,
    {
      ownerId: work.ownerId,
      copyId: work.copyId,
      side,
      contentType: derived.contentType,
      imageBytes: derived.image.byteLength,
      thumbBytes: derived.thumb.byteLength,
      source: "intake",
    },
  );
  await putObject(
    config,
    copyPhotoObjectKey(token, "image", derived.contentType),
    derived.image,
    derived.contentType,
    R2_PUT_TIMEOUT_MS,
  );
  await putObject(
    config,
    copyPhotoObjectKey(token, "thumb", derived.contentType),
    derived.thumb,
    derived.contentType,
    R2_PUT_TIMEOUT_MS,
  );
  // The derive and the PUTs take seconds, and a collector can add this side by
  // hand meanwhile. Their photo stands; this row is left for the sweep.
  if ((await liveSides(ctx, work)).has(side)) return;
  await ctx.runMutation(internal.copyPhotos.commitUpload, { ownerId: work.ownerId, photoId });
}

/** Fills the copy's missing sides. Throws only on a failure before the sides start. */
async function attachWork(ctx: ActionCtx, matchId: Id<"intakeMatches">, work: Work): Promise<AttachOutcome> {
  const live = await liveSides(ctx, work);
  const missing = (
    [
      ["front", work.frontIndex],
      ["back", work.backIndex],
    ] as const
  ).filter(([side]) => !live.has(side));
  if (missing.length === 0) return { photos: "attached" };

  const config = r2Config();
  if (!config) {
    console.warn(`[attachIntakePhotos] ${matchId}: R2 is not set up on this deployment`);
    return { photos: "failed", photoFailure: "error" };
  }

  let scanGone = false;
  let errored = false;
  for (const [side, entryIndex] of missing) {
    try {
      await attachSide(ctx, config, work, side, entryIndex);
    } catch (err) {
      const message = messageOf(err);
      if (parsePreprocessErrorCode(message) === OUTPUT_NOT_FOUND_CODE) scanGone = true;
      else errored = true;
      console.warn(`[attachIntakePhotos] ${matchId} ${side}: ${message}`);
    }
  }
  // A failure a retry could still fix outranks one it can't: Try again may
  // bring that side in, and then the tile says what is really left.
  if (errored) return { photos: "failed", photoFailure: "error" };
  if (scanGone) return { photos: "failed", photoFailure: "scanGone" };
  return { photos: "attached" };
}

/**
 * One saved row, start to report. Never throws: the row's state is the only way
 * a failure shows, and the saved copy stays as it is. Null when the row has
 * nowhere to put photos.
 */
async function attachMatch(ctx: ActionCtx, matchId: Id<"intakeMatches">): Promise<AttachOutcome | null> {
  let outcome: AttachOutcome;
  try {
    const work: Work | null = await ctx.runQuery(internal.intakeRuns.intakePhotoWork, { matchId });
    if (!work) return null;
    outcome = await attachWork(ctx, matchId, work);
  } catch (err) {
    console.warn(`[attachIntakePhotos] ${matchId}: ${messageOf(err)}`);
    outcome = { photos: "failed", photoFailure: "error" };
  }
  try {
    await ctx.runMutation(internal.intakeRuns.recordIntakePhotos, { matchId, ...outcome });
  } catch (err) {
    // `expireIntakePhotoAttach` still moves a row left pending.
    console.warn(`[attachIntakePhotos] ${matchId}: could not record ${outcome.photos}: ${messageOf(err)}`);
  }
  return outcome;
}

/** A save's photos, scheduled by `saveIntakeMatch`. */
export const attachIntakePhotos = internalAction({
  args: { matchId: v.id("intakeMatches") },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    await attachMatch(ctx, args.matchId);
    return null;
  },
});

/** The saved tile's Try again. Refuses unless the row is the caller's and failed. */
export const retryIntakePhotos = action({
  args: { matchId: v.id("intakeMatches") },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const ownerId = await requireSignedIn(ctx);
    await ctx.runMutation(internal.intakeRuns.beginIntakePhotoRetry, { matchId: args.matchId, ownerId });
    await attachMatch(ctx, args.matchId);
    return null;
  },
});

/**
 * Puts photos on every saved row of a run saved before NEO-427, or one whose
 * scans are worth another try. Run by hand. Rows that already have both sides
 * cost one read each, and no row goes back to "pending", so this never holds a
 * run's listing kick. Continues itself when a long run outlasts its budget.
 */
export const reattachIntakeRunPhotos = internalAction({
  args: { runId: v.id("intakeRuns"), offset: v.optional(v.number()) },
  returns: v.object({
    matches: v.number(),
    attached: v.number(),
    failed: v.number(),
    continued: v.boolean(),
  }),
  handler: async (ctx, args): Promise<{ matches: number; attached: number; failed: number; continued: boolean }> => {
    const matchIds: Array<Id<"intakeMatches">> = await ctx.runQuery(internal.intakeRuns.intakeRunSavedMatches, {
      runId: args.runId,
    });
    const startedAt = Date.now();
    const report = { matches: 0, attached: 0, failed: 0, continued: false };
    for (let i = args.offset ?? 0; i < matchIds.length; i++) {
      if (Date.now() - startedAt > REATTACH_BUDGET_MS) {
        await ctx.scheduler.runAfter(0, internal.intakePhotos.reattachIntakeRunPhotos, {
          runId: args.runId,
          offset: i,
        });
        report.continued = true;
        break;
      }
      const outcome = await attachMatch(ctx, matchIds[i]);
      report.matches += 1;
      if (outcome?.photos === "attached") report.attached += 1;
      else if (outcome?.photos === "failed") report.failed += 1;
    }
    return report;
  },
});
