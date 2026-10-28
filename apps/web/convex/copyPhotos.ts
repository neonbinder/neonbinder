/**
 * NEO-377 — photos of a collector's own copies: one front and one back per
 * copy line (`collectionCopyPhotos`), for the collector's screens, public
 * share pages and, later, marketplace listings.
 *
 * ## Where the bytes live
 *
 * Cloudflare R2 (`lib/r2.ts`). The NEO-377 cost analysis (on the ticket)
 * found storage cheap everywhere and egress the real cost, and R2's egress is
 * free; Jason picked it from the start (2026-10-28). Convex keeps only the
 * row. Every read and write of a photo goes through this module.
 *
 * ## Sizes
 *
 * The browser makes both files from the original and uploads them straight
 * to R2; the original is never kept. `image` has a long edge of
 * `COPY_PHOTO_LONG_EDGE` (1600px, eBay's recommended listing size), `thumb`
 * of `COPY_PHOTO_THUMB_EDGE`. Both JPEG or WebP.
 *
 * ## An upload, start to finish
 *
 * 1. `startUpload` (action): `reserveUpload` checks the copy is the caller's,
 *    the hourly cap and the sizes, and writes a `pending` row with a fresh
 *    random `token`; the action signs two PUT URLs whose type and length are
 *    signed, so R2 takes exactly those bytes.
 * 2. The browser PUTs both files.
 * 3. `finishUpload` (action): HEADs both objects (there, the signed size),
 *    then `commitUpload` makes the row `live`, retires the side's old photo
 *    (its objects deleted) and marks the copy `hasPhotos`.
 *
 * A line with photos never folds (`isOneOfAKind`), so photos are never merged
 * into another line. Removing the copy DETACHES its photos (`detachPhotos`) so
 * the Undo can put them back (`reattachPhotos`, from `restoreCopy`).
 * `sweepCopyPhotos` (hourly) deletes pending and detached rows over an hour
 * old, with their objects.
 *
 * ## Reading
 *
 * A photo's URL is `<site>/copy-photo/<token>/<image|thumb>`, stable for
 * Convex's query cache; `serveCopyPhoto` (HTTP) redirects it to a signed R2
 * GET good for `READ_URL_TTL_SECONDS`. The token is the bearer: it is random,
 * handed only to the owner and to public pages for copies they already show,
 * and the redirect serves live photos only.
 *
 * Every function is signed-in and reads or writes only the caller's rows.
 */

import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { action, httpAction, internalAction, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { getCurrentUserId, requireSignedIn } from "./auth";
import { COLLECTION_ERRORS, refuse } from "./collection";
import { deleteObject, headObject, r2Config, signedGetUrl, signedPutUrl } from "./lib/r2";

type PhotoRow = Doc<"collectionCopyPhotos">;
type CopyRow = Doc<"collectionCopies">;

/** The listing-sized photo's long edge, in pixels (eBay recommends 1600). */
export const COPY_PHOTO_LONG_EDGE = 1600;
/** The thumbnail's long edge, in pixels. */
export const COPY_PHOTO_THUMB_EDGE = 360;
/** The listing-sized photo's largest size. */
export const MAX_COPY_PHOTO_BYTES = 3 * 1024 * 1024;
/** The thumbnail's largest size. */
export const MAX_COPY_THUMB_BYTES = 256 * 1024;
/** What the browser writes. Never SVG, never untyped. */
export const COPY_PHOTO_TYPES = ["image/jpeg", "image/webp"] as const;
/** Photo uploads (one side each) one collector may start in an hour. */
export const MAX_COPY_PHOTO_UPLOADS_PER_HOUR = 200;
/** How long an upload may stay unfinished, and a removed copy's photos wait for its Undo. */
export const PHOTO_HOLD_MS = 60 * 60 * 1000;
/** How long a signed upload URL works. */
const UPLOAD_URL_TTL_SECONDS = 5 * 60;
/** How long a signed read URL works (the redirect makes a fresh one each load). */
const READ_URL_TTL_SECONDS = 60 * 60;
/** Copies one `photosOf` call may ask about. */
export const MAX_PHOTOS_OF = 100;
/** Rows one sweep run looks at. */
const SWEEP_BATCH = 100;
/** A token: 32 lowercase hex characters (`newToken`). */
const TOKEN_RE = /^[0-9a-f]{32}$/;

const NOT_SET_UP = "Card photos aren't set up on this server yet.";

const sideValidator = v.union(v.literal("front"), v.literal("back"));
type Side = typeof sideValidator.type;
const contentTypeValidator = v.union(v.literal("image/jpeg"), v.literal("image/webp"));
const sizeValidator = v.union(v.literal("image"), v.literal("thumb"));
type Size = typeof sizeValidator.type;

const photoUrlsValidator = v.object({ imageUrl: v.string(), thumbUrl: v.string() });
type PhotoUrls = typeof photoUrlsValidator.type;

/** A line's photos as its owner reads them. A side with no photo is absent. */
export const copyPhotosValidator = v.object({
  copyId: v.id("collectionCopies"),
  front: v.optional(photoUrlsValidator),
  back: v.optional(photoUrlsValidator),
});

// ───────────────────────────────────────────────────────────────────────────
// Keys, URLs and the shared pieces (also used by collection.ts,
// collectionRequests.ts, publicCollection.ts and the resets)
// ───────────────────────────────────────────────────────────────────────────

/** The R2 key of one size of a photo. Nothing in it is caller-supplied. */
export function copyPhotoObjectKey(token: string, size: Size, contentType: PhotoRow["contentType"]): string {
  return `copy-photos/${token}/${size}.${contentType === "image/webp" ? "webp" : "jpg"}`;
}

/** 128 random bits as hex. */
function newToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The page-facing URL of one size of a photo (`serveCopyPhoto` redirects it). */
function readUrl(token: string, size: Size): string {
  const site = (process.env.CONVEX_SITE_URL ?? "").replace(/\/+$/, "");
  return `${site}/copy-photo/${token}/${size}`;
}

function urlsOf(row: PhotoRow): PhotoUrls {
  return { imageUrl: readUrl(row.token, "image"), thumbUrl: readUrl(row.token, "thumb") };
}

/** The live photo rows of one line. */
async function livePhotosOf(ctx: Pick<QueryCtx, "db">, copyId: Id<"collectionCopies">): Promise<PhotoRow[]> {
  return await ctx.db
    .query("collectionCopyPhotos")
    .withIndex("by_copy_and_status", (q) => q.eq("copyId", copyId).eq("status", "live"))
    .take(2);
}

/** A line's photo URLs, both sides (the owner's read and the public one). */
export async function photoUrlsOf(
  ctx: Pick<QueryCtx, "db">,
  row: Pick<CopyRow, "_id" | "hasPhotos">,
): Promise<{ front?: PhotoUrls; back?: PhotoUrls }> {
  if (!row.hasPhotos) return {};
  const out: { front?: PhotoUrls; back?: PhotoUrls } = {};
  for (const photo of await livePhotosOf(ctx, row._id)) out[photo.side] = urlsOf(photo);
  return out;
}

/** Delete photo rows now, and their objects in the background. */
async function deletePhotoRows(ctx: MutationCtx, rows: readonly PhotoRow[]): Promise<void> {
  if (rows.length === 0) return;
  const keys: string[] = [];
  for (const row of rows) {
    keys.push(copyPhotoObjectKey(row.token, "image", row.contentType));
    keys.push(copyPhotoObjectKey(row.token, "thumb", row.contentType));
    await ctx.db.delete(row._id);
  }
  await ctx.scheduler.runAfter(0, internal.copyPhotos.deleteObjects, { keys });
}

/**
 * A copy line is going away for good (a withdraw): delete its photos.
 * Cheap for a line with none.
 */
export async function dropPhotos(ctx: MutationCtx, row: Pick<CopyRow, "_id" | "hasPhotos">): Promise<void> {
  if (!row.hasPhotos) return;
  await deletePhotoRows(ctx, await livePhotosOf(ctx, row._id));
}

/**
 * A copy line is being removed by its owner: keep its photos for an hour so
 * the Undo can put them back. Returns their ids for the removed payload.
 */
export async function detachPhotos(
  ctx: MutationCtx,
  row: Pick<CopyRow, "_id" | "hasPhotos">,
): Promise<Array<Id<"collectionCopyPhotos">> | undefined> {
  if (!row.hasPhotos) return undefined;
  const photos = await livePhotosOf(ctx, row._id);
  if (photos.length === 0) return undefined;
  const now = Date.now();
  for (const photo of photos) await ctx.db.patch(photo._id, { status: "detached", since: now });
  return photos.map((photo) => photo._id);
}

/**
 * The Undo of a remove: put the caller's detached photos onto the restored
 * line. One already swept, not the caller's, or not detached is skipped.
 */
export async function reattachPhotos(
  ctx: MutationCtx,
  ownerId: string,
  photoIds: ReadonlyArray<Id<"collectionCopyPhotos">>,
  copyId: Id<"collectionCopies">,
): Promise<void> {
  const seen = new Set<Side>();
  const now = Date.now();
  for (const id of photoIds.slice(0, 2)) {
    const photo = await ctx.db.get(id);
    if (!photo || photo.ownerId !== ownerId || photo.status !== "detached" || seen.has(photo.side)) continue;
    seen.add(photo.side);
    await ctx.db.patch(photo._id, { copyId, status: "live", since: now });
  }
  if (seen.size > 0) await ctx.db.patch(copyId, { hasPhotos: true });
}

/** Every one of an owner's photos, any status (the per-account test reset). */
export async function dropOwnerPhotos(ctx: MutationCtx, ownerId: string): Promise<number> {
  const rows = await ctx.db
    .query("collectionCopyPhotos")
    .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
    .collect();
  await deletePhotoRows(ctx, rows);
  return rows.length;
}

/** One batch of every collector's photos, any status (the global reset). */
export async function drainPhotos(ctx: MutationCtx, batch: number): Promise<number> {
  const rows = await ctx.db.query("collectionCopyPhotos").take(batch);
  await deletePhotoRows(ctx, rows);
  return rows.length;
}

// ───────────────────────────────────────────────────────────────────────────
// Upload
// ───────────────────────────────────────────────────────────────────────────

/** Step 1, the database half: check, cap and write the pending row. */
export const reserveUpload = internalMutation({
  args: {
    ownerId: v.string(),
    copyId: v.id("collectionCopies"),
    side: sideValidator,
    contentType: contentTypeValidator,
    imageBytes: v.number(),
    thumbBytes: v.number(),
  },
  returns: v.object({ photoId: v.id("collectionCopyPhotos"), token: v.string() }),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.copyId);
    if (!row || row.ownerId !== args.ownerId) {
      refuse(COLLECTION_ERRORS.notFound, "That copy isn't in your collection.");
    }
    for (const [bytes, max] of [
      [args.imageBytes, MAX_COPY_PHOTO_BYTES],
      [args.thumbBytes, MAX_COPY_THUMB_BYTES],
    ] as const) {
      if (!Number.isInteger(bytes) || bytes < 1 || bytes > max) {
        refuse(COLLECTION_ERRORS.invalid, "That photo is too big. Add it again.");
      }
    }
    const now = Date.now();
    const recent = await ctx.db
      .query("collectionCopyPhotos")
      .withIndex("by_owner", (q) => q.eq("ownerId", args.ownerId).gt("_creationTime", now - PHOTO_HOLD_MS))
      .take(MAX_COPY_PHOTO_UPLOADS_PER_HOUR);
    if (recent.length >= MAX_COPY_PHOTO_UPLOADS_PER_HOUR) {
      refuse(COLLECTION_ERRORS.limit, "That's a lot of photos for one hour. Try again a little later.");
    }
    const token = newToken();
    const photoId = await ctx.db.insert("collectionCopyPhotos", {
      ownerId: args.ownerId,
      copyId: args.copyId,
      side: args.side,
      token,
      contentType: args.contentType,
      imageBytes: args.imageBytes,
      thumbBytes: args.thumbBytes,
      status: "pending",
      since: now,
    });
    return { photoId, token };
  },
});

/**
 * Start putting a photo on one side of a copy line. Returns two upload URLs
 * (PUT, exactly `imageBytes` / `thumbBytes` of `contentType`); then call
 * `finishUpload`.
 */
export const startUpload = action({
  args: {
    copyId: v.id("collectionCopies"),
    side: sideValidator,
    contentType: contentTypeValidator,
    imageBytes: v.number(),
    thumbBytes: v.number(),
  },
  returns: v.object({
    photoId: v.id("collectionCopyPhotos"),
    imageUploadUrl: v.string(),
    thumbUploadUrl: v.string(),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{ photoId: Id<"collectionCopyPhotos">; imageUploadUrl: string; thumbUploadUrl: string }> => {
    const ownerId = await requireSignedIn(ctx);
    const config = r2Config();
    if (!config) refuse(COLLECTION_ERRORS.invalid, NOT_SET_UP);
    const { photoId, token }: { photoId: Id<"collectionCopyPhotos">; token: string } = await ctx.runMutation(
      internal.copyPhotos.reserveUpload,
      { ownerId, ...args },
    );
    const put = (size: Size, bytes: number) =>
      signedPutUrl(config, copyPhotoObjectKey(token, size, args.contentType), args.contentType, bytes, UPLOAD_URL_TTL_SECONDS);
    return {
      photoId,
      imageUploadUrl: await put("image", args.imageBytes),
      thumbUploadUrl: await put("thumb", args.thumbBytes),
    };
  },
});

type PendingUpload = {
  token: string;
  contentType: PhotoRow["contentType"];
  imageBytes: number;
  thumbBytes: number;
};

/** The caller's pending upload, for `finishUpload`. */
export const pendingUpload = internalQuery({
  args: { ownerId: v.string(), photoId: v.id("collectionCopyPhotos") },
  returns: v.union(
    v.null(),
    v.object({ token: v.string(), contentType: contentTypeValidator, imageBytes: v.number(), thumbBytes: v.number() }),
  ),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.photoId);
    if (!row || row.ownerId !== args.ownerId || row.status !== "pending") return null;
    return { token: row.token, contentType: row.contentType, imageBytes: row.imageBytes, thumbBytes: row.thumbBytes };
  },
});

/** Step 3, the database half: the pending row goes live on its copy. */
export const commitUpload = internalMutation({
  args: { ownerId: v.string(), photoId: v.id("collectionCopyPhotos") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const photo = await ctx.db.get(args.photoId);
    if (!photo || photo.ownerId !== args.ownerId || photo.status !== "pending") {
      refuse(COLLECTION_ERRORS.notFound, "That photo upload ran out of time. Add it again.");
    }
    const copy = await ctx.db.get(photo.copyId);
    if (!copy || copy.ownerId !== args.ownerId) {
      await deletePhotoRows(ctx, [photo]);
      return null;
    }
    const old = (await livePhotosOf(ctx, copy._id)).filter((row) => row.side === photo.side);
    await deletePhotoRows(ctx, old);
    await ctx.db.patch(photo._id, { status: "live", since: Date.now() });
    if (!copy.hasPhotos) await ctx.db.patch(copy._id, { hasPhotos: true });
    return null;
  },
});

/**
 * Finish a photo upload once both files are in: checks R2 has each at its
 * signed size and type, then puts the photo on its side of the copy
 * (replacing the side's old one).
 */
export const finishUpload = action({
  args: { photoId: v.id("collectionCopyPhotos") },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const ownerId = await requireSignedIn(ctx);
    const config = r2Config();
    if (!config) refuse(COLLECTION_ERRORS.invalid, NOT_SET_UP);
    const pending: PendingUpload | null = await ctx.runQuery(internal.copyPhotos.pendingUpload, {
      ownerId,
      photoId: args.photoId,
    });
    if (!pending) refuse(COLLECTION_ERRORS.notFound, "That photo upload ran out of time. Add it again.");
    for (const [size, bytes] of [
      ["image", pending.imageBytes],
      ["thumb", pending.thumbBytes],
    ] as const) {
      const head = await headObject(config, copyPhotoObjectKey(pending.token, size, pending.contentType));
      if (!head || head.bytes !== bytes || head.contentType !== pending.contentType) {
        refuse(COLLECTION_ERRORS.invalid, "That photo didn't finish uploading. Try adding it again.");
      }
    }
    await ctx.runMutation(internal.copyPhotos.commitUpload, { ownerId, photoId: args.photoId });
    return null;
  },
});

/** Take the photo off one side of a copy line, and delete its files. */
export const remove = mutation({
  args: { copyId: v.id("collectionCopies"), side: sideValidator },
  returns: v.null(),
  handler: async (ctx, args) => {
    const ownerId = await requireSignedIn(ctx);
    const row = await ctx.db.get(args.copyId);
    if (!row || row.ownerId !== ownerId) {
      refuse(COLLECTION_ERRORS.notFound, "That copy isn't in your collection.");
    }
    const photos = await livePhotosOf(ctx, row._id);
    const gone = photos.filter((photo) => photo.side === args.side);
    await deletePhotoRows(ctx, gone);
    if (photos.length === gone.length && row.hasPhotos) {
      await ctx.db.patch(row._id, { hasPhotos: undefined });
    }
    return null;
  },
});

/** Trade a line's front and back photos (one side alone moves to the other). */
export const swap = mutation({
  args: { copyId: v.id("collectionCopies") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const ownerId = await requireSignedIn(ctx);
    const row = await ctx.db.get(args.copyId);
    if (!row || row.ownerId !== ownerId) {
      refuse(COLLECTION_ERRORS.notFound, "That copy isn't in your collection.");
    }
    for (const photo of await livePhotosOf(ctx, row._id)) {
      await ctx.db.patch(photo._id, { side: photo.side === "front" ? "back" : "front" });
    }
    return null;
  },
});

// ───────────────────────────────────────────────────────────────────────────
// Reading
// ───────────────────────────────────────────────────────────────────────────

/**
 * The photos of some of the caller's copy lines. A line that is not the
 * caller's, or has none, is left out.
 */
export const photosOf = query({
  args: { copyIds: v.array(v.id("collectionCopies")) },
  returns: v.array(copyPhotosValidator),
  handler: async (ctx, args) => {
    const ownerId = await getCurrentUserId(ctx);
    if (!ownerId) return [];
    if (args.copyIds.length > MAX_PHOTOS_OF) {
      refuse(COLLECTION_ERRORS.limit, `Ask for at most ${MAX_PHOTOS_OF} lines at once.`);
    }
    const out: Array<typeof copyPhotosValidator.type> = [];
    for (const copyId of new Set(args.copyIds)) {
      const row = await ctx.db.get(copyId);
      if (!row || row.ownerId !== ownerId || !row.hasPhotos) continue;
      out.push({ copyId, ...(await photoUrlsOf(ctx, row)) });
    }
    return out;
  },
});

/** Cards `cardPhotos` may ask about at once. */
export const MAX_CARD_PHOTOS = 60;
/** Lines of one card `cardPhotos` looks through. */
const LINES_PER_CARD = 50;

/**
 * The photo that stands for each of some cards in the caller's collection:
 * the first line (oldest) with a front, else the first with a back. A card
 * the caller has no photographed line of is left out; signed out, nothing.
 */
export const cardPhotos = query({
  args: { cardIds: v.array(v.string()) },
  returns: v.array(v.object({ cardId: v.string(), front: v.optional(photoUrlsValidator), back: v.optional(photoUrlsValidator) })),
  handler: async (ctx, args) => {
    const ownerId = await getCurrentUserId(ctx);
    if (!ownerId) return [];
    if (args.cardIds.length > MAX_CARD_PHOTOS) {
      refuse(COLLECTION_ERRORS.limit, `Ask for at most ${MAX_CARD_PHOTOS} cards at once.`);
    }
    const out: Array<{ cardId: string; front?: PhotoUrls; back?: PhotoUrls }> = [];
    for (const cardId of new Set(args.cardIds)) {
      // A catalog card or the caller's own (private) card (NEO-361).
      const id = ctx.db.normalizeId("cardChecklist", cardId) ?? ctx.db.normalizeId("privateCards", cardId);
      if (!id) continue;
      const lines = await ctx.db
        .query("collectionCopies")
        .withIndex("by_owner_and_card", (q) => q.eq("ownerId", ownerId).eq("cardId", id))
        .take(LINES_PER_CARD);
      let pick: { front?: PhotoUrls; back?: PhotoUrls } | null = null;
      for (const line of lines) {
        if (!line.hasPhotos) continue;
        const urls = await photoUrlsOf(ctx, line);
        if (urls.front) {
          pick = urls;
          break;
        }
        if (!pick && urls.back) pick = urls;
      }
      if (pick) out.push({ cardId, ...pick });
    }
    return out;
  },
});

/** A live photo by its token, for the redirect. */
export const liveByToken = internalQuery({
  args: { token: v.string() },
  returns: v.union(v.null(), v.object({ contentType: contentTypeValidator })),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("collectionCopyPhotos")
      .withIndex("by_token", (q) => q.eq("token", args.token))
      .unique();
    return row && row.status === "live" ? { contentType: row.contentType } : null;
  },
});

/**
 * `GET /copy-photo/<token>/<image|thumb>`: a 302 to a signed R2 URL for a
 * live photo; 404 for anything else. The shape is checked before any read.
 */
export const serveCopyPhoto = httpAction(async (ctx, request) => {
  const parts = new URL(request.url).pathname.split("/").filter(Boolean);
  const [, token, size] = parts;
  const notFound = () => new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
  if (parts.length !== 3 || !TOKEN_RE.test(token ?? "") || (size !== "image" && size !== "thumb")) {
    return notFound();
  }
  const config = r2Config();
  if (!config) return notFound();
  const photo: { contentType: PhotoRow["contentType"] } | null = await ctx.runQuery(
    internal.copyPhotos.liveByToken,
    { token },
  );
  if (!photo) return notFound();
  const location = await signedGetUrl(config, copyPhotoObjectKey(token, size, photo.contentType), READ_URL_TTL_SECONDS);
  // The browser may reuse the redirect for a while, never past the signature.
  return new Response(null, {
    status: 302,
    headers: { location, "cache-control": `private, max-age=${READ_URL_TTL_SECONDS - 300}` },
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Cleanup
// ───────────────────────────────────────────────────────────────────────────

/** Delete R2 objects (scheduled by every row delete above). */
export const deleteObjects = internalAction({
  args: { keys: v.array(v.string()) },
  returns: v.null(),
  handler: async (_ctx, args) => {
    const config = r2Config();
    if (!config) return null;
    for (const key of args.keys) await deleteObject(config, key);
    return null;
  },
});

/**
 * Hourly: delete pending uploads never finished and removed copies' photos
 * never undone, once over `PHOTO_HOLD_MS` old, with their objects.
 */
export const sweepCopyPhotos = internalMutation({
  args: {},
  returns: v.object({ pending: v.number(), detached: v.number() }),
  handler: async (ctx) => {
    const cutoff = Date.now() - PHOTO_HOLD_MS;
    const stale = async (status: "pending" | "detached") =>
      await ctx.db
        .query("collectionCopyPhotos")
        .withIndex("by_status_and_since", (q) => q.eq("status", status).lt("since", cutoff))
        .take(SWEEP_BATCH);
    const pending = await stale("pending");
    const detached = await stale("detached");
    await deletePhotoRows(ctx, [...pending, ...detached]);
    if (pending.length === SWEEP_BATCH || detached.length === SWEEP_BATCH) {
      await ctx.scheduler.runAfter(0, internal.copyPhotos.sweepCopyPhotos, {});
    }
    return { pending: pending.length, detached: detached.length };
  },
});
