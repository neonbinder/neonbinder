/**
 * NEO-481 — the database half of a hand photo edit (turn + crop). The public
 * entry points, the source HEAD and the renders are actions in
 * `photoEdits.ts` ("use node"); everything that reads or writes a row is here,
 * internal only, so ownership is checked against the job or copy row and
 * never against anything a client said.
 *
 * ## The save is asynchronous (plan amendment, 2026-11-10)
 *
 * A cold preprocess instance answers in 23-36 s, so a save cannot wait for
 * its render. A save RESERVES (`reserveScanEdit`, `reserveCopyEdit`): it
 * checks, counts the render against its cap, records the edit as
 * `pendingEdit` (status "rendering") and schedules the render, then returns.
 * The render action calls `/render-edit`, and the COMMIT (`commitScanEdit`,
 * `commitCopyEdit`) writes the new version. A failure is recorded on
 * `pendingEdit` (status "failed", with the reason) and the old photo stays
 * live; Try again is the same save again. Listings are queued only in the
 * commit, once the new file exists.
 *
 * ## Versions and races (todos/neo-481-schema.md, section 5)
 *
 * `placeholderImages.edits` is both the cap and the version allocator: OCC
 * serialises reserves, so every render has its own write-once key. A commit
 * re-checks everything the reserve saw: the edit version it started from
 * (first save wins), the row's `status` and `settledAt` (a Try again or a
 * restart in between), and that the pair was not saved meanwhile.
 */

import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { COLLECTION_ERRORS, refuse } from "./collection";
import {
  commitEditedPhoto,
  dismissFailedEdits,
  failEditedPhoto,
  requireLivePhoto,
  reserveEditPhoto,
  undoEditedPhoto,
} from "./copyPhotos";
import { noteIntakePairsChanged } from "./intakeRuns";
import { ENTRY_TOO_MANY_PIXELS } from "./lib/extractRejections";
import {
  EDIT_WARMUP_WINDOW_MS,
  MAX_PHOTO_EDIT_RENDERS_IN_FLIGHT,
  MAX_PHOTO_EDIT_RENDERS_PER_HOUR,
  openingTurns,
  PHOTO_EDIT_RENDER_STALE_MS,
  PHOTO_EDIT_TICKET_WINDOW_MS,
  photoEditOf,
  photoEditProblem,
  PLACEHOLDER_MAX_IMAGE_EDITS,
  type PhotoEdit,
} from "./lib/photoEdit";
import { PLACEHOLDER_JOB_ID_RE, PLACEHOLDER_MAX_ENTRY_INDEX } from "./lib/placeholderObjects";
import { readFieldsFromResult } from "./placeholderPipeline";
import { pendingPhotoEditValidator, photoEditCropValidator, photoEditValidator } from "./schema";

type ImageRow = Doc<"placeholderImages">;
type ImageStatus = ImageRow["status"];
const sideValidator = v.union(v.literal("front"), v.literal("back"));
type Side = typeof sideValidator.type;
const imageStatusValidator = v.union(
  v.literal("awaiting_upload"),
  v.literal("queued"),
  v.literal("processing"),
  v.literal("done"),
  v.literal("failed"),
);

/** Job statuses whose photos can be edited (schema doc 4a). */
const EDITABLE_JOB_STATUSES: ReadonlySet<string> = new Set(["collecting", "processing", "pairing", "succeeded"]);

// ───────────────────────────────────────────────────────────────────────────
// Copy, in the collector's words
// ───────────────────────────────────────────────────────────────────────────

export const PHOTO_EDIT_COPY = {
  stillReading: "This photo is still being read. You can turn or crop it once it's done.",
  tooBig: "This photo is too big for us to read, so it can't be cropped. Add a smaller one.",
  jobClosed: "This batch is closed, so its photos can't be edited.",
  savedPair: "This card is saved. Open it from the Saved tile to edit its photo.",
  savedWhileCropping: "This card was saved while you cropped. Open it from the Saved tile.",
  changedElsewhere: "This photo changed somewhere else. Open it again to see the latest.",
  restarted: "This photo was read again while you cropped. Open it again to crop the new read.",
  stillRendering: "Your last change to this photo is still being made. Give it a moment.",
  tooManyEdits: "That's as many edits as this scan gets. The last one stands.",
  scanGone: "This scan has aged out, so there's nothing left to crop.",
  agedOutMidSave: "The original scan just aged out. Your crop wasn't saved; open it again to crop the saved photo.",
  renderFailed: "We couldn't make that edit just now. Try again.",
  unusable: "We couldn't make a photo from that crop. Try a different crop.",
  tooManyRenders: "Whoa, that's a lot of photo edits for one hour. Take a breather and try again in a bit.",
  tooManyInFlight: "Hang tight, a few of your edits are still being made. Try again once they land.",
} as const;

// ───────────────────────────────────────────────────────────────────────────
// Render tickets: the per-owner rate and in-flight limits (security C1)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Take a render ticket for this owner, or refuse. More than
 * `MAX_PHOTO_EDIT_RENDERS_PER_HOUR` renders in the last hour, or
 * `MAX_PHOTO_EDIT_RENDERS_IN_FLIGHT` unsettled ones newer than the stale
 * window, is refused. A ticket whose render was lost (a crashed action never
 * settles it) stops counting as in flight once it goes stale, so a collector
 * is never stuck behind it; it still counts toward the hour.
 */
async function takeRenderTicket(ctx: MutationCtx, ownerId: string, now: number): Promise<Id<"photoEditTickets">> {
  const recent = await ctx.db
    .query("photoEditTickets")
    .withIndex("by_owner_and_created", (q) => q.eq("ownerId", ownerId).gt("createdAt", now - PHOTO_EDIT_TICKET_WINDOW_MS))
    .take(MAX_PHOTO_EDIT_RENDERS_PER_HOUR);
  if (recent.length >= MAX_PHOTO_EDIT_RENDERS_PER_HOUR) refuse(COLLECTION_ERRORS.limit, PHOTO_EDIT_COPY.tooManyRenders);
  const inFlight = recent.filter((t) => t.settledAt === undefined && now - t.createdAt < PHOTO_EDIT_RENDER_STALE_MS);
  if (inFlight.length >= MAX_PHOTO_EDIT_RENDERS_IN_FLIGHT) refuse(COLLECTION_ERRORS.limit, PHOTO_EDIT_COPY.tooManyInFlight);
  return await ctx.db.insert("photoEditTickets", { ownerId, createdAt: now });
}

/** The render this ticket stood for has committed or failed. */
async function settleTicket(ctx: MutationCtx, ticketId: Id<"photoEditTickets"> | undefined): Promise<void> {
  if (!ticketId) return;
  const ticket = await ctx.db.get(ticketId);
  if (ticket && ticket.settledAt === undefined) await ctx.db.patch(ticket._id, { settledAt: Date.now() });
}

const SWEEP_PAGE = 500;

/** Hourly: drop tickets older than the rate window. Pages itself. */
export const sweepPhotoEditTickets = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const old = await ctx.db
      .query("photoEditTickets")
      .withIndex("by_created", (q) => q.lt("createdAt", Date.now() - PHOTO_EDIT_TICKET_WINDOW_MS))
      .take(SWEEP_PAGE);
    for (const ticket of old) await ctx.db.delete(ticket._id);
    if (old.length === SWEEP_PAGE) await ctx.scheduler.runAfter(0, internal.photoEditRows.sweepPhotoEditTickets, {});
    return null;
  },
});

/** The edit renderer's warm-up row in `preprocessWarmupState` (its timestamp field is shared with the heavy row's). */
export const EDIT_WARMUP_STATE_KEY = "editRendererWarmup";

/**
 * Deployment-wide debounce of the edit renderer's FAST warm-up (security N2),
 * the way `enqueueHeavyWarmups` holds the heavy one: only the first open in
 * any `EDIT_WARMUP_WINDOW_MS` schedules it, however many collectors open the
 * viewer. Read and write of the one row are in this transaction, so OCC lets
 * one caller through per window.
 */
export const claimEditWarmup = internalMutation({
  args: {},
  returns: v.boolean(),
  handler: async (ctx) => {
    const now = Date.now();
    const state = await ctx.db
      .query("preprocessWarmupState")
      .withIndex("by_key", (q) => q.eq("key", EDIT_WARMUP_STATE_KEY))
      .unique();
    if (state && now - state.heavyWarmEnqueuedAt < EDIT_WARMUP_WINDOW_MS) return false;
    if (state) await ctx.db.patch(state._id, { heavyWarmEnqueuedAt: now });
    else await ctx.db.insert("preprocessWarmupState", { key: EDIT_WARMUP_STATE_KEY, heavyWarmEnqueuedAt: now });
    await ctx.scheduler.runAfter(0, internal.photoEdits.warmEditRenderer, {});
    return true;
  },
});

// ───────────────────────────────────────────────────────────────────────────
// Shared reads
// ───────────────────────────────────────────────────────────────────────────

async function ownedJob(ctx: Pick<QueryCtx, "db">, jobId: string, userId: string) {
  if (!PLACEHOLDER_JOB_ID_RE.test(jobId)) return null;
  const job = await ctx.db
    .query("placeholderJobs")
    .withIndex("by_job", (q) => q.eq("jobId", jobId))
    .unique();
  return job && job.userId === userId ? job : null;
}

async function imageAt(ctx: Pick<QueryCtx, "db">, jobId: string, entryIndex: number): Promise<ImageRow | null> {
  if (!Number.isInteger(entryIndex) || entryIndex < 0 || entryIndex > PLACEHOLDER_MAX_ENTRY_INDEX) return null;
  return await ctx.db
    .query("placeholderImages")
    .withIndex("by_job_and_index", (q) => q.eq("jobId", jobId).eq("entryIndex", entryIndex))
    .unique();
}

/** The intake row for the pair this image is in, if the job has a run and the image a pair. */
async function matchOfImage(
  ctx: Pick<QueryCtx, "db">,
  jobId: string,
  entryIndex: number,
): Promise<Doc<"intakeMatches"> | null> {
  const pairs = await ctx.db
    .query("placeholderPairs")
    .withIndex("by_job", (q) => q.eq("jobId", jobId))
    .collect();
  const pair = pairs.find((p) => p.frontIndex === entryIndex || p.backIndex === entryIndex);
  if (!pair) return null;
  return await ctx.db
    .query("intakeMatches")
    .withIndex("by_pair", (q) => q.eq("pairId", pair._id))
    .first();
}

/**
 * Why a scan cannot be edited from its original right now, or null. Does not
 * know whether the original still exists: that is the action's HEAD.
 */
function scanBlock(job: Doc<"placeholderJobs">, image: ImageRow, now: number): string | null {
  if (!EDITABLE_JOB_STATUSES.has(job.status)) return PHOTO_EDIT_COPY.jobClosed;
  if (image.status !== "done" && image.status !== "failed") return PHOTO_EDIT_COPY.stillReading;
  if (image.status === "failed" && image.errorCode === ENTRY_TOO_MANY_PIXELS) return PHOTO_EDIT_COPY.tooBig;
  if (renderingNow(image.pendingEdit, now)) return PHOTO_EDIT_COPY.stillRendering;
  return null;
}

function renderingNow(pending: ImageRow["pendingEdit"], now: number): boolean {
  return pending?.status === "rendering" && now - pending.requestedAt < PHOTO_EDIT_RENDER_STALE_MS;
}

/** The editor's opening parameters for a scan (contract rule Q5). */
function openingEditOf(image: ImageRow): PhotoEdit {
  if (image.edit) return photoEditOf(image.edit);
  return { turns: openingTurns(image.rotationDegrees), crop: image.autoCrop ?? null };
}

const scanFactsValidator = v.object({
  imageId: v.id("placeholderImages"),
  jobId: v.string(),
  entryIndex: v.number(),
  /** Why this scan opens view-only, before the HEAD; absent = editable if the original exists. */
  block: v.optional(v.string()),
  /** The pair this scan is in was saved. */
  saved: v.boolean(),
  opening: photoEditValidator,
  autoCrop: v.optional(photoEditCropValidator),
  expectVersion: v.number(),
  editsLeft: v.number(),
  pendingEdit: v.optional(pendingPhotoEditValidator),
});
type ScanFacts = typeof scanFactsValidator.type;

async function scanFacts(
  ctx: Pick<QueryCtx, "db">,
  userId: string,
  jobId: string,
  entryIndex: number,
): Promise<ScanFacts | null> {
  const job = await ownedJob(ctx, jobId, userId);
  if (!job) return null;
  const image = await imageAt(ctx, jobId, entryIndex);
  if (!image) return null;
  const match = await matchOfImage(ctx, jobId, entryIndex);
  const block = scanBlock(job, image, Date.now());
  return {
    imageId: image._id,
    jobId,
    entryIndex,
    ...(block ? { block } : {}),
    saved: match?.savedAt !== undefined,
    opening: openingEditOf(image),
    ...(image.autoCrop ? { autoCrop: image.autoCrop } : {}),
    expectVersion: image.edit?.version ?? 0,
    editsLeft: Math.max(0, PLACEHOLDER_MAX_IMAGE_EDITS - (image.edits ?? 0)),
    ...(image.pendingEdit ? { pendingEdit: image.pendingEdit } : {}),
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Source facts (for `photoEdits.photoEditSource`)
// ───────────────────────────────────────────────────────────────────────────

/** What opening a scan needs to know, or null when it is not the caller's. */
export const scanSourceFacts = internalQuery({
  args: { userId: v.string(), jobId: v.string(), entryIndex: v.number() },
  returns: v.union(v.null(), scanFactsValidator),
  handler: async (ctx, args) => await scanFacts(ctx, args.userId, args.jobId, args.entryIndex),
});

/**
 * What opening a copy's photo needs to know: its live row, its newest edit
 * in flight, and (when it was made from a scan the caller still owns) that
 * scan's facts. Null when the copy is not the caller's or has no photo there.
 */
export const copySourceFacts = internalQuery({
  args: { userId: v.string(), copyId: v.id("collectionCopies"), side: sideValidator },
  returns: v.union(
    v.null(),
    v.object({
      token: v.string(),
      contentType: v.union(v.literal("image/jpeg"), v.literal("image/webp")),
      pendingEdit: v.optional(pendingPhotoEditValidator),
      scan: v.optional(scanFactsValidator),
    }),
  ),
  handler: async (ctx, args) => {
    const copy = await ctx.db.get(args.copyId);
    if (!copy || copy.ownerId !== args.userId) return null;
    const photos = await ctx.db
      .query("collectionCopyPhotos")
      .withIndex("by_copy_and_status", (q) => q.eq("copyId", args.copyId).eq("status", "live"))
      .take(2);
    const live = photos.find((row) => row.side === args.side);
    if (!live) return null;
    const pending = await ctx.db
      .query("collectionCopyPhotos")
      .withIndex("by_copy_and_status", (q) => q.eq("copyId", args.copyId).eq("status", "pending"))
      .take(20);
    const newest = pending.filter((row) => row.source === "edit" && row.side === args.side && row.pendingEdit).at(-1);
    const scan = live.scan ? await scanFacts(ctx, args.userId, live.scan.jobId, live.scan.entryIndex) : null;
    return {
      token: live.token,
      contentType: live.contentType,
      ...(newest?.pendingEdit ? { pendingEdit: newest.pendingEdit } : {}),
      ...(scan ? { scan } : {}),
    };
  },
});

// ───────────────────────────────────────────────────────────────────────────
// Scan edits
// ───────────────────────────────────────────────────────────────────────────

function requireRenderable(edit: PhotoEdit): void {
  const problem = photoEditProblem(edit);
  if (problem) refuse(COLLECTION_ERRORS.invalid, problem);
}

/**
 * Reserve one render of a scan: the checks, the cap, the version, the pending
 * state, and the scheduled render. Refuses a pair that is saved: its photo is
 * the saved line's now (`reserveCopyEdit`).
 */
export const reserveScanEdit = internalMutation({
  args: {
    userId: v.string(),
    jobId: v.string(),
    entryIndex: v.number(),
    edit: photoEditValidator,
    expectVersion: v.number(),
  },
  returns: v.object({ version: v.number() }),
  handler: async (ctx, args) => {
    requireRenderable(args.edit);
    const job = await ownedJob(ctx, args.jobId, args.userId);
    const image = job ? await imageAt(ctx, args.jobId, args.entryIndex) : null;
    if (!job || !image) refuse(COLLECTION_ERRORS.notFound, "That photo isn't in your batch.");
    const now = Date.now();
    const block = scanBlock(job, image, now);
    if (block) refuse(COLLECTION_ERRORS.invalid, block);
    if ((image.edit?.version ?? 0) !== args.expectVersion) refuse(COLLECTION_ERRORS.invalid, PHOTO_EDIT_COPY.changedElsewhere);
    const match = await matchOfImage(ctx, args.jobId, args.entryIndex);
    if (match?.savedAt !== undefined) refuse(COLLECTION_ERRORS.invalid, PHOTO_EDIT_COPY.savedPair);
    const version = (image.edits ?? 0) + 1;
    if (version > PLACEHOLDER_MAX_IMAGE_EDITS) refuse(COLLECTION_ERRORS.limit, PHOTO_EDIT_COPY.tooManyEdits);
    // A pair the collector picked by hand or set aside is never matched again,
    // so its crop is rendered without the paid re-read.
    const classify = !(match?.byUser || match?.setAside);
    const ticketId = await takeRenderTicket(ctx, args.userId, now);
    await ctx.db.patch(image._id, {
      edits: version,
      pendingEdit: { ...photoEditOf(args.edit), version, requestedAt: now, status: "rendering" },
    });
    await ctx.scheduler.runAfter(0, internal.photoEdits.renderScanEdit, {
      imageId: image._id,
      userId: args.userId,
      jobId: args.jobId,
      entryIndex: args.entryIndex,
      edit: photoEditOf(args.edit),
      version,
      expectVersion: args.expectVersion,
      imageStatus: image.status,
      ...(image.settledAt !== undefined ? { settledAt: image.settledAt } : {}),
      classify,
      ticketId,
    });
    return { version };
  },
});

/**
 * Why a commit of this scan render must not land, or null. Read only, so a
 * refused commit writes nothing but its failure.
 */
async function scanCommitBlock(
  ctx: Pick<QueryCtx, "db">,
  image: ImageRow | null,
  args: { expectVersion: number; imageStatus: ImageStatus; settledAt?: number },
): Promise<string | null> {
  if (!image) return PHOTO_EDIT_COPY.restarted;
  if ((image.edit?.version ?? 0) !== args.expectVersion) return PHOTO_EDIT_COPY.changedElsewhere;
  if (image.status !== "done" && image.status !== "failed") return PHOTO_EDIT_COPY.restarted;
  if (image.status !== args.imageStatus || image.settledAt !== args.settledAt) return PHOTO_EDIT_COPY.restarted;
  return null;
}

/** Write a failure onto the scan's pending edit, if it is still this render's. */
async function failScan(ctx: MutationCtx, imageId: Id<"placeholderImages">, version: number, error: string): Promise<void> {
  const image = await ctx.db.get(imageId);
  if (!image?.pendingEdit || image.pendingEdit.version !== version) return;
  await ctx.db.patch(image._id, { pendingEdit: { ...image.pendingEdit, status: "failed", error } });
}

/**
 * The render is in the bucket: make it the scan's current edit. Applies the
 * re-read by the first-read rule (schema doc 4a): `players`, `team` and
 * `cardNumber` always; `side`, `textCount`, `dhash` and `orientConfidence`
 * only where the row has none, so a done photo's side never flips. Never
 * orientation: the edit's turns are the orientation now. A failed photo
 * becomes done (rescued), its job's counters move one from failed to
 * processed, and pairing runs again, forced, so even a finished batch pairs
 * it. Returns the refusal written, or null.
 */
export const commitScanEdit = internalMutation({
  args: {
    imageId: v.id("placeholderImages"),
    version: v.number(),
    expectVersion: v.number(),
    imageStatus: imageStatusValidator,
    settledAt: v.optional(v.number()),
    /** The service's classify fields, untouched; narrowed here. Absent = render only. */
    classified: v.optional(v.any()),
    ticketId: v.optional(v.id("photoEditTickets")),
  },
  returns: v.union(v.null(), v.string()),
  handler: async (ctx, args) => {
    await settleTicket(ctx, args.ticketId);
    const image = await ctx.db.get(args.imageId);
    const blocked = await scanCommitBlock(ctx, image, args);
    if (blocked || !image) {
      await failScan(ctx, args.imageId, args.version, blocked ?? PHOTO_EDIT_COPY.restarted);
      return blocked ?? PHOTO_EDIT_COPY.restarted;
    }
    // A newer reserve took over (this one went stale): the newer render owns the row.
    if (image.pendingEdit?.version !== args.version) return PHOTO_EDIT_COPY.changedElsewhere;
    const match = await matchOfImage(ctx, image.jobId, image.entryIndex);
    if (match?.savedAt !== undefined) {
      await failScan(ctx, image._id, args.version, PHOTO_EDIT_COPY.savedWhileCropping);
      return PHOTO_EDIT_COPY.savedWhileCropping;
    }
    const now = Date.now();
    const pending = image.pendingEdit;
    const patch: Partial<ImageRow> = {
      edit: { turns: pending.turns, crop: pending.crop, version: args.version, editedAt: now },
      pendingEdit: undefined,
    };
    const read = args.classified !== undefined && args.classified !== null ? readFieldsFromResult(args.classified) : null;
    if (read) {
      patch.players = read.players;
      patch.team = read.team;
      patch.cardNumber = read.cardNumber;
      if (image.side === undefined && read.side !== undefined) patch.side = read.side;
      if (image.textCount === undefined && read.textCount !== undefined) patch.textCount = read.textCount;
      if (image.dhash === undefined && read.dhash !== undefined) patch.dhash = read.dhash;
      if (image.orientConfidence === undefined && read.orientConfidence !== undefined) {
        patch.orientConfidence = read.orientConfidence;
      }
    }
    const rescued = image.status === "failed";
    if (rescued) {
      patch.status = "done";
      patch.errorCode = undefined;
      patch.errorDetail = undefined;
      patch.settledAt = now;
    }
    await ctx.db.patch(image._id, patch);

    const job = await ctx.db
      .query("placeholderJobs")
      .withIndex("by_job", (q) => q.eq("jobId", image.jobId))
      .unique();
    if (job && rescued) {
      // One photo moves from failed to processed: the sum, and so whether the
      // batch is complete, is unchanged.
      await ctx.db.patch(job._id, {
        processedImages: (job.processedImages ?? 0) + 1,
        failedImages: Math.max(0, (job.failedImages ?? 0) - 1),
        lastActivityAt: now,
      });
    }
    if (job && (read || rescued)) {
      // The pair's merged identity, its readKey and its match all follow.
      await ctx.scheduler.runAfter(0, internal.placeholderPairing.runPairing, {
        jobId: job.jobId,
        userId: job.userId,
        final: false,
        force: true,
      });
      await noteIntakePairsChanged(ctx, job.jobId);
    }
    return null;
  },
});

/** The render failed: the scan keeps its old photo and says why. */
export const failScanEdit = internalMutation({
  args: {
    imageId: v.id("placeholderImages"),
    version: v.number(),
    error: v.string(),
    ticketId: v.optional(v.id("photoEditTickets")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await settleTicket(ctx, args.ticketId);
    await failScan(ctx, args.imageId, args.version, args.error);
    return null;
  },
});

// ───────────────────────────────────────────────────────────────────────────
// Copy edits
// ───────────────────────────────────────────────────────────────────────────

/**
 * Reserve an edit of a saved copy's photo. `original` renders from the scan
 * the photo was made from (still the caller's, still editable, under its own
 * cap; the scan's version is allocated here) and `stored` from the stored
 * photo itself. Either way a pending `source: "edit"` row holds the edit
 * until its render lands.
 */
export const reserveCopyEdit = internalMutation({
  args: {
    userId: v.string(),
    copyId: v.id("collectionCopies"),
    side: sideValidator,
    edit: photoEditValidator,
    expectToken: v.string(),
    mode: v.union(v.literal("original"), v.literal("stored")),
  },
  returns: v.object({ photoId: v.id("collectionCopyPhotos") }),
  handler: async (ctx, args) => {
    requireRenderable(args.edit);
    const now = Date.now();
    let scan:
      | { imageId: Id<"placeholderImages">; jobId: string; entryIndex: number; version: number; expectVersion: number; imageStatus: ImageStatus; settledAt?: number }
      | undefined;
    if (args.mode === "original") {
      const { photo: live } = await requireLivePhoto(ctx, args.userId, args.copyId, args.side);
      const job = live.scan ? await ownedJob(ctx, live.scan.jobId, args.userId) : null;
      const image = job && live.scan ? await imageAt(ctx, live.scan.jobId, live.scan.entryIndex) : null;
      if (!job || !image || !live.scan) refuse(COLLECTION_ERRORS.invalid, PHOTO_EDIT_COPY.scanGone);
      if (!EDITABLE_JOB_STATUSES.has(job.status) || image.status !== "done") refuse(COLLECTION_ERRORS.invalid, PHOTO_EDIT_COPY.scanGone);
      const version = (image.edits ?? 0) + 1;
      if (version > PLACEHOLDER_MAX_IMAGE_EDITS) refuse(COLLECTION_ERRORS.limit, PHOTO_EDIT_COPY.tooManyEdits);
      await ctx.db.patch(image._id, { edits: version });
      scan = {
        imageId: image._id,
        jobId: live.scan.jobId,
        entryIndex: live.scan.entryIndex,
        version,
        expectVersion: image.edit?.version ?? 0,
        imageStatus: image.status,
        ...(image.settledAt !== undefined ? { settledAt: image.settledAt } : {}),
      };
    }
    // Both modes render on the service (scan form or bytes form): one ticket.
    // A refusal anywhere below rolls it back with the rest of the reserve.
    const ticketId = await takeRenderTicket(ctx, args.userId, now);
    const { photoId, token, live } = await reserveEditPhoto(ctx, {
      ownerId: args.userId,
      copyId: args.copyId,
      side: args.side,
      expectToken: args.expectToken,
      pendingEdit: { ...photoEditOf(args.edit), version: scan?.version ?? 0, requestedAt: now, status: "rendering" },
    });
    await ctx.scheduler.runAfter(0, internal.photoEdits.renderCopyEdit, {
      ownerId: args.userId,
      photoId,
      token,
      expectToken: args.expectToken,
      liveContentType: live.contentType,
      edit: photoEditOf(args.edit),
      ...(scan ? { scan } : {}),
      ticketId,
    });
    return { photoId };
  },
});

/**
 * The render's files are in R2: land the edit on the copy, and on the scan
 * path the scan's new `edit` with it, in this one mutation so neither lands
 * without the other. Every check runs before the first write. Returns the
 * refusal written onto the pending row, or null.
 */
export const commitCopyEdit = internalMutation({
  args: {
    ownerId: v.string(),
    photoId: v.id("collectionCopyPhotos"),
    expectToken: v.string(),
    contentType: v.union(v.literal("image/jpeg"), v.literal("image/webp")),
    imageBytes: v.number(),
    thumbBytes: v.number(),
    scan: v.optional(
      v.object({
        imageId: v.id("placeholderImages"),
        version: v.number(),
        expectVersion: v.number(),
        imageStatus: imageStatusValidator,
        settledAt: v.optional(v.number()),
      }),
    ),
    ticketId: v.optional(v.id("photoEditTickets")),
  },
  returns: v.union(v.null(), v.string()),
  handler: async (ctx, args) => {
    await settleTicket(ctx, args.ticketId);
    const photo = await ctx.db.get(args.photoId);
    if (!photo?.pendingEdit) return PHOTO_EDIT_COPY.changedElsewhere;
    const image = args.scan ? await ctx.db.get(args.scan.imageId) : null;
    if (args.scan) {
      const blocked = await scanCommitBlock(ctx, image, args.scan);
      if (blocked) {
        await failEditedPhoto(ctx, photo._id, blocked);
        return blocked;
      }
    }
    const result = await commitEditedPhoto(ctx, {
      ownerId: args.ownerId,
      photoId: args.photoId,
      expectToken: args.expectToken,
      contentType: args.contentType,
      imageBytes: args.imageBytes,
      thumbBytes: args.thumbBytes,
    });
    if (!result.ok) {
      await failEditedPhoto(ctx, photo._id, result.error);
      return result.error;
    }
    if (args.scan && image) {
      await ctx.db.patch(image._id, {
        edit: {
          turns: photo.pendingEdit.turns,
          crop: photo.pendingEdit.crop,
          version: args.scan.version,
          editedAt: Date.now(),
        },
      });
    }
    return null;
  },
});

/** The render failed: the copy keeps its live photo and the edit row says why. */
export const failCopyEdit = internalMutation({
  args: { photoId: v.id("collectionCopyPhotos"), error: v.string(), ticketId: v.optional(v.id("photoEditTickets")) },
  returns: v.null(),
  handler: async (ctx, args) => {
    await settleTicket(ctx, args.ticketId);
    await failEditedPhoto(ctx, args.photoId, args.error);
    return null;
  },
});

/** Undo a landed copy edit (inside the replaced row's hour). */
export const undoCopyEdit = internalMutation({
  args: { userId: v.string(), copyId: v.id("collectionCopies"), photoId: v.id("collectionCopyPhotos") },
  returns: v.null(),
  handler: async (ctx, args) => await undoEditedPhoto(ctx, { ownerId: args.userId, copyId: args.copyId, photoId: args.photoId }),
});

/** Clear a failed edit's message, on a scan or on one side of a copy. */
export const dismissFailure = internalMutation({
  args: {
    userId: v.string(),
    ref: v.union(
      v.object({ kind: v.literal("scan"), jobId: v.string(), entryIndex: v.number() }),
      v.object({ kind: v.literal("copy"), copyId: v.id("collectionCopies"), side: sideValidator }),
    ),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (args.ref.kind === "copy") {
      await dismissFailedEdits(ctx, args.userId, args.ref.copyId, args.ref.side as Side);
      return null;
    }
    const job = await ownedJob(ctx, args.ref.jobId, args.userId);
    const image = job ? await imageAt(ctx, args.ref.jobId, args.ref.entryIndex) : null;
    if (image?.pendingEdit?.status === "failed") await ctx.db.patch(image._id, { pendingEdit: undefined });
    return null;
  },
});
