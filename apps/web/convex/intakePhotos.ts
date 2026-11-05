"use node";

/**
 * NEO-427 — a scanned pair's photos, onto the copy saved from it.
 *
 * `saveIntakeMatch` enqueues `attachIntakePhotos` on `intakePhotoPool` and
 * returns; the save never waits on this and nothing here touches the saved copy
 * but its photos. For each side the two sizes are read from the placeholder
 * bucket, where `/process-entry` stored them beside the run's processed output,
 * a `source: "intake"` row is reserved, the files go to R2 from here,
 * `commitUpload` makes the row live (and queues the card's listings), and
 * `recordIntakePhotoSide` notes the side as done. Then `recordIntakePhotos`
 * writes how it ended, which lets the run's listing kick go ahead.
 *
 * The sides run at the same time, and so do a side's two PUTs, because a collector
 * is watching and the PUTs are nearly all of an attach's time. Nothing here cares
 * which side lands first: every reader goes by a photo's `side`. The fallback's calls
 * to the service are the one thing that stays one at a time (`oneAtATime`).
 *
 * Reading them is the normal path because a call to the preprocess service queues
 * behind all of a run's scanning on the same instances, and a collector is
 * watching for these photos. `/derive-copy-photos` is the fallback for a side
 * whose sizes are not there (a run processed before they were stored, or a size
 * the service could not make) while its output still is. With the output gone as
 * well the scan has aged out, and nothing can bring it back. Outputs are
 * write-once and nothing replaces one, so stored sizes match the output they were
 * made from. The one exception: a retry whose crop comes out in another format
 * writes a second output under another extension and leaves the sizes as they
 * were, so they show the first attempt's crop of the same scan.
 *
 * The bytes move server side because a browser never holds a scanner run's
 * images, and R2 only takes a PUT signed for a known length, so no service can
 * be handed a URL ahead of knowing the size.
 *
 * Safe to run twice: a side already attached is never attempted again, even
 * when its photo is gone (the collector removed it, and it stays removed), and
 * a side with a live photo is left alone, so a photo added by hand stays. Files
 * of an attempt that dies before its commit belong to a pending row, and
 * `sweepCopyPhotos` removes both within the hour.
 */

import { isNonRetryableError } from "@convex-dev/workpool";
import { ConvexError, v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { action, internalAction, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import {
  callDeriveCopyPhotos,
  OUTPUT_NOT_FOUND_CODE,
  parsePreprocessErrorCode,
  type DerivedCopyPhotos,
} from "./adapters/preprocess";
import { objectExists, readObjectWithin } from "./adapters/gcs";
import { requireSignedIn } from "./auth";
import { copyPhotoObjectKey, MAX_COPY_PHOTO_BYTES, MAX_COPY_THUMB_BYTES } from "./copyPhotos";
import {
  CLERK_USER_ID_RE,
  PLACEHOLDER_JOB_ID_RE,
  PLACEHOLDER_MAX_ENTRY_INDEX,
  PLACEHOLDER_OUTPUT_EXTENSIONS,
  placeholderCopyPhotoObject,
  placeholderOutputImageObject,
} from "./lib/placeholderObjects";
import { putObject, r2Config, type R2Config } from "./lib/r2";

/**
 * Waits between tries at the preprocess service. The fast service also carries
 * the run's processing at its full instance ceiling, so a save can land on a
 * moment with no room (Cloud Run's 429), which clears in seconds.
 */
const DERIVE_RETRY_DELAYS_MS = [2_000, 8_000];
/**
 * How long one side's look in the placeholder bucket gets. Past this the attach
 * asks the service instead, which has its own storage path and its own tries.
 */
const STORAGE_LOOK_TIMEOUT_MS = 5_000;
/** One file's PUT, retries included. Files are at most a few MB. */
const R2_PUT_TIMEOUT_MS = 30_000;
/**
 * How long one `reattachIntakeRunPhotos` run starts new rows for. One row can
 * take minutes when the service is down, and an action gets ten.
 */
const REATTACH_BUDGET_MS = 2 * 60 * 1000;
/** The exact string a `reattachIntakeRunPhotos` run must carry in `confirm`. */
export const REATTACH_CONFIRM_PHRASE = "REATTACH INTAKE PHOTOS";
/** The per-deployment arm for it. Only the literal `"true"` arms it. */
export const REATTACH_ENV_FLAG = "ALLOW_REATTACH_INTAKE_PHOTOS";
/**
 * The service's verdicts on a scan's bytes. The same bytes fail the same way, so
 * Try again can't help; the collector adds a photo instead.
 */
const UNUSABLE_SCAN_CODES: ReadonlySet<string | undefined> = new Set([
  "PHOTO_TOO_LARGE",
  "OUTPUT_TOO_MANY_PIXELS",
  "OUTPUT_UNDECODABLE",
]);

type Side = "front" | "back";
type Work = {
  ownerId: string;
  copyId: Id<"collectionCopies">;
  jobId: string;
  frontIndex: number;
  backIndex: number;
  photoSidesAttached?: Side[];
};
type PhotoFailure = "scanGone" | "unusable" | "error";
type AttachOutcome = { photos: "attached" } | { photos: "failed"; photoFailure: PhotoFailure };
/** Runs each task once the one asked for before it has finished, however that went. */
type Lane = <T>(task: () => Promise<T>) => Promise<T>;
type ReattachReport = { matches: number; attached: number; failed: number; skipped: number; continued: boolean };
/** What the placeholder bucket holds for one entry. */
type StoredEntry = { sizes: DerivedCopyPhotos } | "outputOnly" | "nothing";

/** The bucket holds neither the sizes nor the output they are made from. */
class ScanGoneError extends Error {
  constructor() {
    super("the processed scan is no longer in the bucket");
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** An error's status or errno, never its message. Anything else reads as "none". */
function codeOf(err: unknown): string {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  if (typeof code === "number") return String(code);
  return typeof code === "string" && /^[A-Z0-9_]{1,32}$/.test(code) ? code : "none";
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

/**
 * An attach's lane to the service. `intakePhotoPool`'s width is sized on an attach
 * holding one FAST instance, so two sides falling back must not ask at once: on a
 * preview, two attaches would be four calls against a ceiling of 3.
 */
function oneAtATime(): Lane {
  let last: Promise<unknown> = Promise.resolve();
  return (task) => {
    const run = last.then(task, task);
    last = run;
    return run;
  };
}

function startsLikeJpeg(bytes: Uint8Array): boolean {
  return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

/**
 * The key comes from the job row (`intakePhotoWork`), never from a client, and
 * each part is checked before it becomes a path segment. A value that fails throws,
 * so the service answers for it (`INVALID_IDENTIFIER`).
 */
async function lookInBucket(work: Work, entryIndex: number): Promise<StoredEntry> {
  if (
    !CLERK_USER_ID_RE.test(work.ownerId) ||
    !PLACEHOLDER_JOB_ID_RE.test(work.jobId) ||
    !Number.isInteger(entryIndex) ||
    entryIndex < 0 ||
    entryIndex > PLACEHOLDER_MAX_ENTRY_INDEX
  ) {
    throw new Error("identifiers out of shape");
  }
  const bucket = process.env.GCS_PLACEHOLDER_BUCKET;
  if (!bucket) throw new Error("GCS_PLACEHOLDER_BUCKET not set");
  const [image, thumb] = await Promise.all([
    readObjectWithin(
      bucket,
      placeholderCopyPhotoObject(work.ownerId, work.jobId, entryIndex, "image"),
      MAX_COPY_PHOTO_BYTES,
    ),
    readObjectWithin(
      bucket,
      placeholderCopyPhotoObject(work.ownerId, work.jobId, entryIndex, "thumb"),
      MAX_COPY_THUMB_BYTES,
    ),
  ]);
  if (image && thumb && startsLikeJpeg(image) && startsLikeJpeg(thumb)) {
    return { sizes: { image, thumb, contentType: "image/jpeg" } };
  }
  for (const extension of PLACEHOLDER_OUTPUT_EXTENSIONS) {
    const output = placeholderOutputImageObject(work.ownerId, work.jobId, entryIndex, extension);
    if (await objectExists(bucket, output)) return "outputOnly";
  }
  return "nothing";
}

/** Rejects when `work` outlasts `ms`. */
async function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer in ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One side's two sizes: the stored ones, or the service's when they are not
 * there. A bucket that can't be read says nothing about the scan, so that goes to
 * the service too, which answers for itself, rather than calling the scan gone.
 *
 * Only the error's code is logged. A storage error's message can carry the object's
 * URL (bucket, user id, job id), a credential parse error's can quote the key, and
 * warnings reach public CI artifacts.
 */
async function copyPhotosOf(
  ctx: ActionCtx,
  work: Work,
  entryIndex: number,
  serviceLane: Lane,
): Promise<DerivedCopyPhotos> {
  let stored: StoredEntry = "outputOnly";
  try {
    stored = await within(lookInBucket(work, entryIndex), STORAGE_LOOK_TIMEOUT_MS);
  } catch (err) {
    console.warn(`[attachIntakePhotos] could not read stored sizes, asking the service (code ${codeOf(err)})`);
  }
  if (stored === "nothing") throw new ScanGoneError();
  if (stored === "outputOnly") return await serviceLane(() => deriveWithRetry(ctx, work, entryIndex));
  return stored.sizes;
}

async function attachSide(
  ctx: ActionCtx,
  config: R2Config,
  matchId: Id<"intakeMatches">,
  work: Work,
  side: Side,
  entryIndex: number,
  serviceLane: Lane,
): Promise<void> {
  const sizes = await copyPhotosOf(ctx, work, entryIndex, serviceLane);
  const { photoId, token }: { photoId: Id<"collectionCopyPhotos">; token: string } = await ctx.runMutation(
    internal.copyPhotos.reserveUpload,
    {
      ownerId: work.ownerId,
      copyId: work.copyId,
      side,
      contentType: sizes.contentType,
      imageBytes: sizes.image.byteLength,
      thumbBytes: sizes.thumb.byteLength,
      source: "intake",
    },
  );
  // Settled rather than `Promise.all`, so a failed PUT doesn't leave the other one
  // running past the end of the action.
  const sent = await Promise.allSettled(
    (["image", "thumb"] as const).map((size) =>
      putObject(
        config,
        copyPhotoObjectKey(token, size, sizes.contentType),
        sizes[size],
        sizes.contentType,
        R2_PUT_TIMEOUT_MS,
      ),
    ),
  );
  for (const put of sent) if (put.status === "rejected") throw put.reason;
  // Getting the sizes and the PUTs take time, and a collector can add this side by
  // hand meanwhile. Their photo stands; this row is left for the sweep.
  if ((await liveSides(ctx, work)).has(side)) return;
  await ctx.runMutation(internal.copyPhotos.commitUpload, { ownerId: work.ownerId, photoId });
  await ctx.runMutation(internal.intakeRuns.recordIntakePhotoSide, { matchId, side });
}

/** Fills the copy's missing sides. Throws only on a failure before the sides start. */
async function attachWork(ctx: ActionCtx, matchId: Id<"intakeMatches">, work: Work): Promise<AttachOutcome> {
  const live = await liveSides(ctx, work);
  const attached = new Set(work.photoSidesAttached ?? []);
  const missing = (
    [
      ["front", work.frontIndex],
      ["back", work.backIndex],
    ] as const
  ).filter(([side]) => !attached.has(side) && !live.has(side));
  if (missing.length === 0) return { photos: "attached" };

  const config = r2Config();
  if (!config) {
    console.warn(`[attachIntakePhotos] ${matchId}: R2 is not set up on this deployment`);
    return { photos: "failed", photoFailure: "error" };
  }

  const serviceLane = oneAtATime();
  // Each side answers for itself, so one failing can't stop the other.
  const failures = await Promise.all(
    missing.map(async ([side, entryIndex]): Promise<PhotoFailure | null> => {
      try {
        await attachSide(ctx, config, matchId, work, side, entryIndex, serviceLane);
        return null;
      } catch (err) {
        const message = messageOf(err);
        const code = parsePreprocessErrorCode(message);
        console.warn(`[attachIntakePhotos] ${matchId} ${side}: ${message}`);
        if (err instanceof ScanGoneError || code === OUTPUT_NOT_FOUND_CODE) return "scanGone";
        return UNUSABLE_SCAN_CODES.has(code) ? "unusable" : "error";
      }
    }),
  );
  // A failure a retry could still fix outranks one it can't: Try again may
  // bring that side in, and then the tile says what is really left.
  if (failures.includes("error")) return { photos: "failed", photoFailure: "error" };
  if (failures.includes("unusable")) return { photos: "failed", photoFailure: "unusable" };
  if (failures.includes("scanGone")) return { photos: "failed", photoFailure: "scanGone" };
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

/**
 * A save's photos, or a Try again's. Enqueued on `intakePhotoPool`. Never throws
 * (`attachMatch`), so the pool's own retries have nothing to act on and a
 * fallback derive's two tries are the only ones.
 */
export const attachIntakePhotos = internalAction({
  args: { matchId: v.id("intakeMatches") },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    await attachMatch(ctx, args.matchId);
    return null;
  },
});

/**
 * The saved tile's Try again. Refuses unless the row is the caller's and failed;
 * `beginIntakePhotoRetry` puts the attach back on the pool.
 */
export const retryIntakePhotos = action({
  args: { matchId: v.id("intakeMatches") },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const ownerId = await requireSignedIn(ctx);
    await ctx.runMutation(internal.intakeRuns.beginIntakePhotoRetry, { matchId: args.matchId, ownerId });
    return null;
  },
});

/**
 * Puts photos on the saved rows of a run saved before NEO-427. Run by hand from
 * a terminal, armed: `REATTACH_ENV_FLAG` on the deployment and `confirm`.
 *
 * Skips a row already attached, and a line whose quantity is not what the row
 * saved: before NEO-427 a save could fold into a stack, and one scan must not
 * stand for every copy on it. No row goes back to "pending", so this never
 * holds a run's listing kick.
 *
 * Continues itself when a long run outlasts its budget. `cursor` is the row to
 * start from. A cursor row removed in between starts the walk over, which skips
 * what is attached and never skips what isn't. The log line is the only place a
 * continuation's outcome shows.
 */
export const reattachIntakeRunPhotos = internalAction({
  args: {
    confirm: v.literal(REATTACH_CONFIRM_PHRASE),
    runId: v.id("intakeRuns"),
    cursor: v.optional(v.id("intakeMatches")),
  },
  returns: v.object({
    matches: v.number(),
    attached: v.number(),
    failed: v.number(),
    skipped: v.number(),
    continued: v.boolean(),
  }),
  handler: async (ctx, args): Promise<ReattachReport> => {
    if (process.env[REATTACH_ENV_FLAG] !== "true") {
      throw new ConvexError({
        code: "REATTACH_NOT_ARMED",
        message: `Set ${REATTACH_ENV_FLAG}=true on this deployment to run this, and unset it after.`,
      });
    }
    const matchIds: Array<Id<"intakeMatches">> = await ctx.runQuery(internal.intakeRuns.intakeRunSavedMatches, {
      runId: args.runId,
    });
    const startedAt = Date.now();
    const report: ReattachReport = { matches: 0, attached: 0, failed: 0, skipped: 0, continued: false };
    const start = args.cursor === undefined ? 0 : Math.max(matchIds.indexOf(args.cursor), 0);
    for (let i = start; i < matchIds.length; i++) {
      const matchId = matchIds[i];
      if (Date.now() - startedAt > REATTACH_BUDGET_MS) {
        await ctx.scheduler.runAfter(0, internal.intakePhotos.reattachIntakeRunPhotos, {
          confirm: REATTACH_CONFIRM_PHRASE,
          runId: args.runId,
          cursor: matchId,
        });
        report.continued = true;
        break;
      }
      const facts = await ctx.runQuery(internal.intakePhotoReattach.reattachRowFacts, { matchId });
      if (!facts || facts.attached || !facts.sameQuantity) {
        report.skipped += 1;
        continue;
      }
      const outcome = await attachMatch(ctx, matchId);
      report.matches += 1;
      if (outcome?.photos === "attached") report.attached += 1;
      else if (outcome?.photos === "failed") report.failed += 1;
    }
    console.log(JSON.stringify({ event: "reattachIntakeRunPhotos", runId: args.runId, ...report }));
    return report;
  },
});
