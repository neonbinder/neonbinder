"use node";

/**
 * NEO-481 — turn and crop a card photo by hand, making a NEW saved file.
 *
 * Every public entry point is here, as an action, because two of them need
 * Node: the source check HEADs the scan's `extracted/` original in GCS, and
 * the render calls the preprocess service. The rows are read and written in
 * `photoEditRows.ts` (internal only), so ownership is always checked against
 * a job or copy row on the server, and every GCS and R2 key is built from
 * those rows, never from client input.
 *
 * What an edit starts from (its SOURCE) is decided per open
 * (`photoEditSource`):
 *   - "original": the scan's EXIF-uprighted original, while the placeholder
 *     bucket still holds it (about two days). The crop can go anywhere in the
 *     frame and every edit re-renders from it.
 *   - "stored": the copy photo's stored listing image (a hand photo, or a
 *     scan's photo once its original has aged out). A turn is exact; a crop
 *     can only trim.
 *   - "viewOnly": nothing can be edited now; `reason` says why.
 *
 * Saving is asynchronous (plan amendment, 2026-11-10): the save reserves and
 * returns at once, a scheduled action renders (`renderScanEdit`,
 * `renderCopyEdit`), and a commit mutation writes the new version. The
 * pending or failed state reads back through `listPlaceholderImages`
 * (`pendingEdit`) and `copyPhotos.photosOf` (`edits`).
 */

import { isNonRetryableError } from "@convex-dev/workpool";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { action, internalAction, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import {
  callRenderEdit,
  callRenderEditBytes,
  callWarmupFast,
  ENTRY_NOT_FOUND_CODE,
  parsePreprocessErrorCode,
  type RenderEditClassify,
} from "./adapters/preprocess";
import { getGCSClient, objectExists, readObjectWithin } from "./adapters/gcs";
import { requireSignedIn } from "./auth";
import { COLLECTION_ERRORS, refuse } from "./collection";
import { copyPhotoObjectKey, copyPhotoReadUrl, MAX_COPY_PHOTO_BYTES, MAX_COPY_THUMB_BYTES } from "./copyPhotos";
import { PHOTO_EDIT_COPY } from "./photoEditRows";
import { PHOTO_EDIT_RENDER_STALE_MS, type PhotoEdit, type PhotoEditCrop } from "./lib/photoEdit";
import {
  CLERK_USER_ID_RE,
  PLACEHOLDER_JOB_ID_RE,
  PLACEHOLDER_MAX_ENTRY_INDEX,
  PLACEHOLDER_OUTPUT_EXTENSIONS,
  placeholderEditCopyPhotoObject,
  placeholderEditOutputObject,
  placeholderExtractedImageObject,
} from "./lib/placeholderObjects";
import { putObject, r2Config, signedGetUrl, type R2Config } from "./lib/r2";
import { pendingPhotoEditValidator, photoEditCropValidator, photoEditValidator } from "./schema";

const sideValidator = v.union(v.literal("front"), v.literal("back"));
/** What a click edits: a scan of an intake run, or one side of a saved copy. */
export const photoRefValidator = v.union(
  v.object({ kind: v.literal("scan"), jobId: v.string(), entryIndex: v.number() }),
  v.object({ kind: v.literal("copy"), copyId: v.id("collectionCopies"), side: sideValidator }),
);
const imageStatusValidator = v.union(
  v.literal("awaiting_upload"),
  v.literal("queued"),
  v.literal("processing"),
  v.literal("done"),
  v.literal("failed"),
);

/** How long the original's signed read URL works: the editor's session. */
const SOURCE_URL_TTL_MS = 30 * 60 * 1000;
/** Waits between tries at the service: a cold instance can answer 429 while it starts. */
const RENDER_RETRY_DELAYS_MS = [2_000, 8_000];
/** One file's PUT to R2, retries included. */
const R2_PUT_TIMEOUT_MS = 30_000;
/** Reading the stored photo back out of R2 for a bytes-form render. */
const R2_GET_TIMEOUT_MS = 30_000;
/** Codes that say the bytes or the crop cannot make a photo; trying again can't help. */
const UNUSABLE_CODES: ReadonlySet<string | undefined> = new Set([
  "PHOTO_TOO_LARGE",
  "IMAGE_TOO_LARGE",
  "ENTRY_TOO_MANY_PIXELS",
  "IMAGE_UNDECODABLE",
  "UNSUPPORTED_MEDIA_TYPE",
  "INVALID_EDIT",
  "EDIT_FRAME_MISMATCH",
  "EDIT_OUT_OF_FRAME",
]);

const sourceValidator = v.object({
  mode: v.union(v.literal("original"), v.literal("stored"), v.literal("viewOnly")),
  /** Why the photo opens view-only, in the collector's words. */
  reason: v.optional(v.string()),
  /**
   * The editor's opening parameters: the current hand edit, else today's
   * output (the scan's turn from `rotationDegrees`, and its auto crop or the
   * whole frame). On every scan answer, view-only too; a stored copy photo
   * opens on no edit.
   */
  edit: v.optional(photoEditValidator),
  /** The pipeline's own crop box, for Start over. Original mode only. */
  autoCrop: v.optional(photoEditCropValidator),
  /**
   * The source frame, when the server knows it (from the auto crop or the last
   * edit). Absent: measure the loaded `sourceUrl` image.
   */
  srcW: v.optional(v.number()),
  srcH: v.optional(v.number()),
  /** What to draw: the original (signed, short-lived) or the stored listing image. */
  sourceUrl: v.optional(v.string()),
  /** Scan: the edit version the save must still find (`saveScanEdit`). */
  expectVersion: v.optional(v.number()),
  /** Copy: the live photo's token the save must still find (`saveCopyPhotoEdit`). */
  expectToken: v.optional(v.string()),
  /** Original mode: renders left on this scan. */
  editsLeft: v.optional(v.number()),
  /** An edit rendering or failed, as the readers show it. */
  pending: v.optional(pendingPhotoEditValidator),
});
type PhotoSource = typeof sourceValidator.type;

type ScanFacts = {
  imageId: Id<"placeholderImages">;
  jobId: string;
  entryIndex: number;
  block?: string;
  saved: boolean;
  opening: PhotoEdit;
  autoCrop?: PhotoEditCrop;
  expectVersion: number;
  editsLeft: number;
  pendingEdit?: typeof pendingPhotoEditValidator.type;
};

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function placeholderBucket(): string {
  const bucket = process.env.GCS_PLACEHOLDER_BUCKET;
  if (!bucket) throw new Error("GCS_PLACEHOLDER_BUCKET not set");
  return bucket;
}

/** Each part of a key is checked before it becomes a path segment; a bad one throws. */
function checkKeyParts(userId: string, jobId: string, entryIndex: number): void {
  if (
    !CLERK_USER_ID_RE.test(userId) ||
    !PLACEHOLDER_JOB_ID_RE.test(jobId) ||
    !Number.isInteger(entryIndex) ||
    entryIndex < 0 ||
    entryIndex > PLACEHOLDER_MAX_ENTRY_INDEX
  ) {
    throw new Error("identifiers out of shape");
  }
}

/**
 * The scan's original, or null once it has aged out: a HEAD per known
 * extension, in the service's own order. Throws when the bucket cannot be
 * asked, which says nothing about the original.
 */
async function findOriginal(userId: string, jobId: string, entryIndex: number): Promise<string | null> {
  checkKeyParts(userId, jobId, entryIndex);
  const bucket = placeholderBucket();
  for (const extension of PLACEHOLDER_OUTPUT_EXTENSIONS) {
    const key = placeholderExtractedImageObject(userId, jobId, entryIndex, extension);
    if (await objectExists(bucket, key)) return key;
  }
  return null;
}

async function signedOriginalUrl(key: string): Promise<string> {
  const [url] = await getGCSClient()
    .bucket(placeholderBucket())
    .file(key)
    .getSignedUrl({ version: "v4", action: "read", expires: Date.now() + SOURCE_URL_TTL_MS });
  return url;
}

function frameOf(edit: PhotoEdit, autoCrop?: PhotoEditCrop): { srcW?: number; srcH?: number } {
  const frame = edit.crop ?? autoCrop;
  return frame ? { srcW: frame.srcW, srcH: frame.srcH } : {};
}

/** The original-mode answer for a scan whose original exists (without the scan-only fields). */
async function originalSource(facts: ScanFacts, key: string): Promise<PhotoSource> {
  return {
    mode: "original",
    edit: facts.opening,
    ...(facts.autoCrop ? { autoCrop: facts.autoCrop } : {}),
    ...frameOf(facts.opening, facts.autoCrop),
    sourceUrl: await signedOriginalUrl(key),
    editsLeft: facts.editsLeft,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Public
// ───────────────────────────────────────────────────────────────────────────

/**
 * What the viewer opens on for one photo: the source mode and URL, the
 * opening parameters, and what the save must still find. Decided per open,
 * with a HEAD on the scan's original. Also wakes a fast preprocess instance,
 * so the render the save schedules is less likely to start cold.
 */
export const photoEditSource = action({
  args: { ref: photoRefValidator },
  returns: sourceValidator,
  handler: async (ctx, args): Promise<PhotoSource> => {
    const userId = await requireSignedIn(ctx);
    const source = await sourceOf(ctx, userId, args.ref);
    if (source.mode !== "viewOnly") await ctx.scheduler.runAfter(0, internal.photoEdits.warmEditRenderer, {});
    return source;
  },
});

async function sourceOf(
  ctx: ActionCtx,
  userId: string,
  ref: typeof photoRefValidator.type,
): Promise<PhotoSource> {
  const now = Date.now();
  if (ref.kind === "scan") {
    const facts: ScanFacts | null = await ctx.runQuery(internal.photoEditRows.scanSourceFacts, {
      userId,
      jobId: ref.jobId,
      entryIndex: ref.entryIndex,
    });
    if (!facts) refuse(COLLECTION_ERRORS.notFound, "That photo isn't in your batch.");
    // Every answer carries the opening edit (the last hand edit, else the
    // scan's own turn and auto crop, or the whole frame with none), so the
    // client never works out the turn from `rotationDegrees` itself.
    const known = { edit: facts.opening, ...(facts.pendingEdit ? { pending: facts.pendingEdit } : {}) };
    if (facts.saved) return { mode: "viewOnly", reason: PHOTO_EDIT_COPY.savedPair, ...known };
    if (facts.block) return { mode: "viewOnly", reason: facts.block, ...known };
    if (facts.editsLeft === 0) return { mode: "viewOnly", reason: PHOTO_EDIT_COPY.tooManyEdits, ...known };
    const key = await findOriginal(userId, ref.jobId, ref.entryIndex);
    if (!key) return { mode: "viewOnly", reason: PHOTO_EDIT_COPY.scanGone, ...known };
    const pending = facts.pendingEdit ? { pending: facts.pendingEdit } : {};
    return { ...(await originalSource(facts, key)), expectVersion: facts.expectVersion, ...pending };
  }

  const facts: {
    token: string;
    contentType: "image/jpeg" | "image/webp";
    pendingEdit?: typeof pendingPhotoEditValidator.type;
    scan?: ScanFacts;
  } | null = await ctx.runQuery(internal.photoEditRows.copySourceFacts, {
    userId,
    copyId: ref.copyId,
    side: ref.side,
  });
  if (!facts) return { mode: "viewOnly", reason: "There's no photo on this side yet." };
  const pending = facts.pendingEdit ? { pending: facts.pendingEdit } : {};
  if (facts.pendingEdit?.status === "rendering" && now - facts.pendingEdit.requestedAt < PHOTO_EDIT_RENDER_STALE_MS) {
    return { mode: "viewOnly", reason: PHOTO_EDIT_COPY.stillRendering, ...pending };
  }
  // Inside the scan's two days the copy edits from the scan's original; a
  // closed batch or a used-up scan falls through to the stored photo.
  const scan = facts.scan;
  if (scan && !scan.block && scan.editsLeft > 0) {
    const key = await findOriginal(userId, scan.jobId, scan.entryIndex);
    if (key) {
      // The scan's own pending edit is not this copy's; the copy's is.
      return { ...(await originalSource(scan, key)), expectToken: facts.token, ...pending };
    }
  }
  return {
    mode: "stored",
    edit: { turns: 0, crop: null },
    sourceUrl: copyPhotoReadUrl(facts.token, "image"),
    expectToken: facts.token,
    ...pending,
  };
}

/**
 * Save a hand edit of a scan (an unpaired photo, or a pair not saved yet).
 * Returns at once with the version it will render to; the render and the
 * re-read happen in the background. `expectVersion` is the version the
 * viewer opened on (`photoEditSource`): a save over a newer edit is refused.
 * Try again is this same call again; Undo is a save of the previous edit.
 */
export const saveScanEdit = action({
  args: { jobId: v.string(), entryIndex: v.number(), edit: photoEditValidator, expectVersion: v.number() },
  returns: v.object({ version: v.number() }),
  handler: async (ctx, args): Promise<{ version: number }> => {
    const userId = await requireSignedIn(ctx);
    return await ctx.runMutation(internal.photoEditRows.reserveScanEdit, { userId, ...args });
  },
});

/**
 * Save a hand edit of one side of a saved copy's photo. `mode` is the source
 * the viewer opened on, which is the frame `edit.crop` is in. Returns at once
 * with the edit row's id, which `undoCopyPhotoEdit` takes once it has landed.
 */
export const saveCopyPhotoEdit = action({
  args: {
    copyId: v.id("collectionCopies"),
    side: sideValidator,
    edit: photoEditValidator,
    expectToken: v.string(),
    mode: v.union(v.literal("original"), v.literal("stored")),
  },
  returns: v.object({ photoId: v.id("collectionCopyPhotos") }),
  handler: async (ctx, args): Promise<{ photoId: Id<"collectionCopyPhotos"> }> => {
    const userId = await requireSignedIn(ctx);
    return await ctx.runMutation(internal.photoEditRows.reserveCopyEdit, { userId, ...args });
  },
});

/** Undo a copy edit that has landed, within the hour: the photo before it comes back. */
export const undoCopyPhotoEdit = action({
  args: { copyId: v.id("collectionCopies"), photoId: v.id("collectionCopyPhotos") },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const userId = await requireSignedIn(ctx);
    await ctx.runMutation(internal.photoEditRows.undoCopyEdit, { userId, ...args });
    return null;
  },
});

/** Clear a failed edit's message. The photo is unchanged either way. */
export const dismissPhotoEditFailure = action({
  args: { ref: photoRefValidator },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const userId = await requireSignedIn(ctx);
    await ctx.runMutation(internal.photoEditRows.dismissFailure, { userId, ref: args.ref });
    return null;
  },
});

// ───────────────────────────────────────────────────────────────────────────
// Background: the renders
// ───────────────────────────────────────────────────────────────────────────

/** One fast instance up, ahead of the save's render. Never throws. */
export const warmEditRenderer = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx): Promise<null> => {
    await callWarmupFast(ctx);
    return null;
  },
});

async function withRetry<T>(task: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await task();
    } catch (err) {
      const delay = RENDER_RETRY_DELAYS_MS[attempt];
      if (isNonRetryableError(err) || delay === undefined || /\(HTTP 409\)/.test(messageOf(err))) throw err;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

/** A render failure, in the collector's words. */
function failureWords(err: unknown, agedOut: string): string {
  const code = parsePreprocessErrorCode(messageOf(err));
  if (code === ENTRY_NOT_FOUND_CODE) return agedOut;
  if (UNUSABLE_CODES.has(code)) return PHOTO_EDIT_COPY.unusable;
  return PHOTO_EDIT_COPY.renderFailed;
}

/**
 * The scan form, with the one recovery a write-once key allows: a version the
 * service says exists (409, a retry after a response we never got) whose
 * render IS in the bucket is taken as rendered, without its re-read.
 */
async function renderScan(
  ctx: ActionCtx,
  args: { jobId: string; userId: string; entryIndex: number; edit: PhotoEdit; version: number; classify: boolean },
): Promise<{ classified: RenderEditClassify | null }> {
  try {
    return await withRetry(() => callRenderEdit(ctx, args));
  } catch (err) {
    if (!/\(HTTP 409\)/.test(messageOf(err))) throw err;
    checkKeyParts(args.userId, args.jobId, args.entryIndex);
    const rendered = placeholderEditOutputObject(args.userId, args.jobId, args.entryIndex, args.version);
    if (!(await objectExists(placeholderBucket(), rendered))) throw err;
    return { classified: null };
  }
}

const scanRenderArgs = {
  imageId: v.id("placeholderImages"),
  userId: v.string(),
  jobId: v.string(),
  entryIndex: v.number(),
  edit: photoEditValidator,
  version: v.number(),
  expectVersion: v.number(),
  imageStatus: imageStatusValidator,
  settledAt: v.optional(v.number()),
  classify: v.boolean(),
};

/**
 * Render a scan's edit (scheduled by `reserveScanEdit`), then commit it.
 * Never throws: a failure is written onto the scan's `pendingEdit`.
 */
export const renderScanEdit = internalAction({
  args: scanRenderArgs,
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    try {
      const { classified } = await renderScan(ctx, {
        jobId: args.jobId,
        userId: args.userId,
        entryIndex: args.entryIndex,
        edit: args.edit,
        version: args.version,
        classify: args.classify,
      });
      await ctx.runMutation(internal.photoEditRows.commitScanEdit, {
        imageId: args.imageId,
        version: args.version,
        expectVersion: args.expectVersion,
        imageStatus: args.imageStatus,
        ...(args.settledAt !== undefined ? { settledAt: args.settledAt } : {}),
        ...(classified ? { classified } : {}),
      });
    } catch (err) {
      console.warn(`[renderScanEdit] ${args.imageId} v${args.version}: ${messageOf(err)}`);
      await ctx.runMutation(internal.photoEditRows.failScanEdit, {
        imageId: args.imageId,
        version: args.version,
        error: failureWords(err, PHOTO_EDIT_COPY.scanGone),
      });
    }
    return null;
  },
});

function startsLikeJpeg(bytes: Uint8Array): boolean {
  return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

/** The stored listing image's bytes, at most `MAX_COPY_PHOTO_BYTES`. */
async function readStoredPhoto(
  config: R2Config,
  token: string,
  contentType: "image/jpeg" | "image/webp",
): Promise<Uint8Array<ArrayBuffer>> {
  const url = await signedGetUrl(config, copyPhotoObjectKey(token, "image", contentType), 300);
  const response = await fetch(url, { signal: AbortSignal.timeout(R2_GET_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`stored photo read failed (HTTP ${response.status})`);
  const length = Number(response.headers.get("content-length") ?? "0");
  if (length > MAX_COPY_PHOTO_BYTES) throw new Error("stored photo is over the size cap");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_COPY_PHOTO_BYTES) throw new Error("stored photo is out of bounds");
  return bytes;
}

/**
 * Render a copy photo's edit (scheduled by `reserveCopyEdit`), put the files
 * in R2 under the edit row's token, then commit. From the scan's original
 * when `scan` is set (render only, no re-read), else from the stored photo.
 * Never throws: a failure is written onto the edit row, and its files (if
 * any) go with it at the sweep.
 */
export const renderCopyEdit = internalAction({
  args: {
    ownerId: v.string(),
    photoId: v.id("collectionCopyPhotos"),
    token: v.string(),
    expectToken: v.string(),
    liveContentType: v.union(v.literal("image/jpeg"), v.literal("image/webp")),
    edit: photoEditValidator,
    scan: v.optional(
      v.object({
        imageId: v.id("placeholderImages"),
        jobId: v.string(),
        entryIndex: v.number(),
        version: v.number(),
        expectVersion: v.number(),
        imageStatus: imageStatusValidator,
        settledAt: v.optional(v.number()),
      }),
    ),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const fail = async (error: string) => {
      await ctx.runMutation(internal.photoEditRows.failCopyEdit, { photoId: args.photoId, error });
    };
    const config = r2Config();
    if (!config) {
      await fail(PHOTO_EDIT_COPY.renderFailed);
      return null;
    }
    try {
      let sizes: { image: Uint8Array<ArrayBuffer>; thumb: Uint8Array<ArrayBuffer>; contentType: "image/jpeg" | "image/webp" };
      if (args.scan) {
        const scan = args.scan;
        await renderScan(ctx, {
          jobId: scan.jobId,
          userId: args.ownerId,
          entryIndex: scan.entryIndex,
          edit: args.edit,
          version: scan.version,
          classify: false,
        });
        const bucket = placeholderBucket();
        const [image, thumb] = await Promise.all([
          readObjectWithin(
            bucket,
            placeholderEditCopyPhotoObject(args.ownerId, scan.jobId, scan.entryIndex, scan.version, "image"),
            MAX_COPY_PHOTO_BYTES,
          ),
          readObjectWithin(
            bucket,
            placeholderEditCopyPhotoObject(args.ownerId, scan.jobId, scan.entryIndex, scan.version, "thumb"),
            MAX_COPY_THUMB_BYTES,
          ),
        ]);
        if (!image || !thumb || !startsLikeJpeg(image) || !startsLikeJpeg(thumb)) {
          await fail(PHOTO_EDIT_COPY.unusable);
          return null;
        }
        sizes = { image, thumb, contentType: "image/jpeg" };
      } else {
        const stored = await readStoredPhoto(config, args.expectToken, args.liveContentType);
        sizes = await withRetry(() =>
          callRenderEditBytes(ctx, { image: stored, contentType: args.liveContentType, edit: args.edit }),
        );
      }
      const sent = await Promise.allSettled(
        (["image", "thumb"] as const).map((size) =>
          putObject(config, copyPhotoObjectKey(args.token, size, sizes.contentType), sizes[size], sizes.contentType, R2_PUT_TIMEOUT_MS),
        ),
      );
      for (const put of sent) if (put.status === "rejected") throw put.reason;
      await ctx.runMutation(internal.photoEditRows.commitCopyEdit, {
        ownerId: args.ownerId,
        photoId: args.photoId,
        expectToken: args.expectToken,
        contentType: sizes.contentType,
        imageBytes: sizes.image.byteLength,
        thumbBytes: sizes.thumb.byteLength,
        ...(args.scan
          ? {
              scan: {
                imageId: args.scan.imageId,
                version: args.scan.version,
                expectVersion: args.scan.expectVersion,
                imageStatus: args.scan.imageStatus,
                ...(args.scan.settledAt !== undefined ? { settledAt: args.scan.settledAt } : {}),
              },
            }
          : {}),
      });
    } catch (err) {
      console.warn(`[renderCopyEdit] ${args.photoId}: ${messageOf(err)}`);
      await fail(failureWords(err, PHOTO_EDIT_COPY.agedOutMidSave));
    }
    return null;
  },
});
