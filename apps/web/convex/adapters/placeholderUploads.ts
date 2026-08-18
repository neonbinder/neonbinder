"use node";

import { action } from "../_generated/server";
import { v } from "convex/values";
import { randomUUID } from "node:crypto";
import { getCurrentUserId } from "../auth";
import { getGCSClient } from "./gcs";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  CLERK_USER_ID_RE,
  MAX_PLACEHOLDER_IMAGE_BYTES,
  PLACEHOLDER_MAX_ENTRY_INDEX,
  PLACEHOLDER_OUTPUT_EXTENSIONS,
  isPlaceholderOutputExtension,
  placeholderExtractedImageObject,
  placeholderImageExtension,
  placeholderInputObject,
  placeholderOutputImageObject,
} from "../lib/placeholderObjects";

// 15 minutes: long enough to cover a slow upload of a 200-500MB zip on a
// mediocre connection, short enough to bound the window in which the policy
// is usable if it leaks — e.g. captured by client-side observability
// (Sentry breadcrumbs / Session Replay / tracing spans all see the request
// URL; see src/sentry.ts's scrubSignedStorageUrls for the mitigation on that
// side) rather than anything to do with browser history, since an XHR
// request never creates a history entry.
const UPLOAD_POLICY_TTL_MS = 15 * 60 * 1000;

// The policy binds to this exact Content-Type — the client's form POST must
// include this field or GCS will reject the request (412).
const UPLOAD_CONTENT_TYPE = "application/zip";

// A signed POST policy's `content-length-range` condition is enforced
// server-side by GCS itself, unlike a client-side size check (which is
// merely advisory — nothing stops a modified client from ignoring it). This
// is a real cap, not the previous "known gap." 500MB matches the upper end
// of the expected raw-scan-zip size this feature was scoped for; there's no
// legitimate placeholder upload larger than that, and it bounds worst-case
// cost during the 7-day bucket lifecycle window even under repeated abuse
// from a single authenticated account.
const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;

// Shorter than the zip policy's fifteen minutes, on purpose. This one covers a
// single image of at most MAX_PLACEHOLDER_IMAGE_BYTES rather than a 500MB
// archive, so five minutes is generous even on a poor connection — and a signed
// policy is a bearer capability, so the window in which a leaked one is usable
// should be no longer than the upload actually needs. A scanner session mints
// one of these per image, which is many more capabilities in flight than the
// zip path ever creates; shortening the individual TTL is what keeps that from
// being a larger exposure.
const IMAGE_UPLOAD_POLICY_TTL_MS = 5 * 60 * 1000;

// How long a signed READ url for a processed crop stays valid.
//
// Fifteen minutes, which is a display budget rather than a transfer budget: the
// review UI (and the streaming CLI) mint one per image and render it, so the URL
// needs to outlive a page the user is scrolling through, not a slow upload. Long
// enough that a link does not expire mid-session; short enough that one copied
// out of a devtools network panel is worthless by the time anyone finds it.
const DOWNLOAD_URL_TTL_MS = 15 * 60 * 1000;

/**
 * Mint a v4 signed POST policy the client can use to upload a
 * placeholder-scan zip directly to GCS, bypassing Convex's action-argument
 * size limits.
 *
 * Security properties that matter here:
 *
 * - The object path is built entirely server-side from the caller's
 *   verified (and shape-checked) Clerk identity and a freshly generated
 *   UUID — `jobId` is never accepted as an argument, so there is no
 *   client-controlled path segment. A policy scoped to
 *   `placeholders/{other user's id}/...` is unrepresentable, not merely
 *   something we'd reject if asked for.
 * - `content-length-range` caps the upload at MAX_UPLOAD_BYTES server-side —
 *   GCS itself rejects an oversized POST, this isn't a client-side-only
 *   check.
 * - `x-goog-if-generation-match: 0` makes the write genuinely write-once:
 *   GCS rejects the POST with 412 if an object already exists at that exact
 *   path. Without this, replaying a captured (leaked, logged, or merely
 *   retried) policy would silently overwrite the original upload — the only
 *   thing currently standing in the way of that is `objectCreator` lacking
 *   `storage.objects.delete`, which is an IAM-role accident, not a
 *   deliberate control, and the natural "fix" for a legitimate retry that
 *   needs to rewrite a path (e.g. a preprocess retry) would otherwise be to
 *   grant `objectAdmin`, silently reopening the hole for every other path
 *   too. The generation-match condition makes write-once an explicit
 *   property of the upload itself, independent of which IAM role is
 *   attached to which service account.
 *
 * Two deliberate departures from this file's neighbor, `gcs.ts`:
 *
 * 1. Throws on unauthenticated instead of returning `{ success: false }`
 *    like `uploadPrizeImage` does. A signed policy is a bearer capability —
 *    the moment we mint one we've made an authorization decision, and that
 *    decision should fail loudly (same shape as `requireAdmin`) rather than
 *    risk a caller ignoring a soft `success: false` and using the policy
 *    anyway.
 * 2. Does NOT gate on `GCP_FEATURES_ENABLED`. That flag exists to keep the
 *    (unfinished, prod-only) prizes feature dark outside prod; placeholder
 *    uploads are a dev-through-prod feature from day one and must not be
 *    dark in dev.
 */
export const createPlaceholderUploadUrl = action({
  args: {},
  returns: v.object({
    uploadUrl: v.string(),
    fields: v.record(v.string(), v.string()),
    objectPath: v.string(),
    jobId: v.string(),
    expiresAt: v.number(),
    maxUploadBytes: v.number(),
  }),
  handler: async (ctx) => {
    const userId = await getCurrentUserId(ctx);
    if (!userId) {
      throw new Error("Not authenticated");
    }
    if (!CLERK_USER_ID_RE.test(userId)) {
      // Belt-and-suspenders: if this ever fires it means the identity shape
      // assumption changed upstream (Clerk config, a different auth
      // provider, a test double), and we'd rather fail the mint than build
      // an object path from an unvalidated string.
      throw new Error("Unexpected user id shape");
    }

    // GCS_PLACEHOLDER_BUCKET names the destination bucket — it is a bucket
    // name, not a secret or a credential. The actual GCP credentials come
    // from GOOGLE_APPLICATION_CREDENTIALS_B64 via getGCSClient().
    const bucketName = process.env.GCS_PLACEHOLDER_BUCKET;
    if (!bucketName) {
      throw new Error("GCS_PLACEHOLDER_BUCKET not set");
    }

    const jobId = randomUUID();
    // No part of this path is client-supplied: userId comes from the
    // verified (and shape-checked) Clerk token, jobId is generated right
    // here. Built through the shared layout helper (convex/lib/placeholderObjects.ts)
    // so this key and the ones the streaming path signs cannot drift apart from
    // what the preprocess service derives on its own side.
    const objectPath = placeholderInputObject(userId, jobId);

    const gcs = getGCSClient();
    const bucket = gcs.bucket(bucketName);
    const file = bucket.file(objectPath);

    const expiresAt = Date.now() + UPLOAD_POLICY_TTL_MS;
    const [policy] = await file.generateSignedPostPolicyV4({
      expires: expiresAt,
      conditions: [["content-length-range", 0, MAX_UPLOAD_BYTES]],
      fields: {
        "Content-Type": UPLOAD_CONTENT_TYPE,
        "x-goog-if-generation-match": "0",
      },
    });

    // Ownership record — see the `placeholderJobs` table comment in
    // schema.ts. This is what makes the path confinement enforceable AFTER
    // this action returns: every downstream function looks up this row by
    // `jobId`, checks `row.userId === identity.subject`, and re-derives
    // `objectPath` from the row — never from a client-supplied argument.
    await ctx.runMutation(internal.placeholderJobs.insertPlaceholderJob, {
      jobId,
      userId,
      objectPath,
    });

    return {
      uploadUrl: policy.url,
      fields: policy.fields,
      objectPath,
      jobId,
      expiresAt,
      maxUploadBytes: MAX_UPLOAD_BYTES,
    };
  },
});

/**
 * Mint a v4 signed POST policy for ONE image in an open scanner session
 * (NEO-170 streaming intake).
 *
 * The zip action's sibling, and the differences are all consequences of one
 * thing: this runs per image, into a job that already exists, so `jobId` is an
 * argument where the other one generates it. That is the only client-supplied
 * handle here, and it buys the caller nothing — `allocateStreamEntry` resolves
 * the job row from it and refuses unless `row.userId` is the verified Clerk
 * subject, which is the same check every other function in this feature makes.
 *
 * What the path is built from, in order: the verified (and shape-checked) Clerk
 * subject, the job id whose ownership was just proved, and an index the SERVER
 * allocated. No segment is chosen by the caller, so a policy scoped to another
 * user's prefix — or to a second object at an index this session already used —
 * is unrepresentable rather than merely refused.
 *
 * The key is `extracted/{index:04d}.{ext}`, which is where `/extract` writes in
 * zip mode. That is deliberate and is what makes streaming free downstream:
 * `/process-entry` looks for an extracted object at the index it is given and
 * does not care who put it there. (It EXIF-uprights unconditionally before
 * hashing for exactly this reason — a zip-extracted object was already
 * normalised, a direct upload was not. See the comment in
 * services/preprocess/app/main.py.)
 *
 * Three bounds are enforced by the policy itself, all mirrored from the service
 * rather than chosen here (convex/lib/placeholderObjects.ts names the source of
 * each):
 *
 * - `content-length-range` caps the object at MAX_PLACEHOLDER_IMAGE_BYTES, the
 *   same 32MiB `/process-entry` will refuse to download past. GCS enforces it;
 *   a modified client cannot talk its way around it.
 * - the exact `Content-Type` field binds the upload to one of the three types
 *   the service accepts. GCS compares it byte-for-byte, which is why the
 *   allowlist lookup is exact rather than parameter-tolerant.
 * - `x-goog-if-generation-match: 0` makes the write genuinely write-once — the
 *   POST fails with a 412 if anything already exists at that key. It is
 *   expressible in a V4 POST policy (it is a signed form field, not a header we
 *   would need the client to set), so streaming uploads get the same property
 *   the zip upload has: replaying a captured policy cannot overwrite the
 *   original. The cost is that a genuinely failed upload cannot be retried at
 *   the same index — the client asks for a new URL, which allocates a new index,
 *   and the abandoned row is deleted when the session closes.
 *
 * `objectPath` is deliberately NOT returned, unlike the zip action's response.
 * The client does not need it: `fields.key` already carries the key it must
 * POST, and every subsequent call about this image is made with
 * `{jobId, entryIndex}`. Returning a second copy would be one more place the
 * "never a client-supplied path" rule has to be re-argued.
 *
 * A failure BETWEEN allocation and signing (a GCS outage, a credentials
 * problem) leaves an `awaiting_upload` row at an index nothing will ever fill,
 * and a gap in the index sequence. Both are fine and neither is compensated
 * for: the row is deleted by close/cancel, gaps are legal (zip mode produces
 * them too, wherever an entry was rejected), and `/process-entry` is only ever
 * asked about indexes that reached "queued". Unwinding the counter instead
 * would need a second transaction that can itself fail, trading a harmless
 * artefact for a real one.
 */
export const createPlaceholderImageUploadUrl = action({
  args: {
    jobId: v.string(),
    contentType: v.string(),
    originalName: v.optional(v.string()),
  },
  returns: v.object({
    uploadUrl: v.string(),
    fields: v.record(v.string(), v.string()),
    entryIndex: v.number(),
    expiresAt: v.number(),
    maxUploadBytes: v.number(),
  }),
  // The handler's return type is written out rather than inferred, and the
  // `runMutation` result below is annotated for the same reason: this action
  // both calls an internal function and returns a value derived from it, which
  // is a cycle TypeScript cannot break on its own (TS7022/TS7023). Stating the
  // shape — which mirrors the `returns` validator above, so the two cannot
  // drift silently — breaks it.
  handler: async (
    ctx,
    args,
  ): Promise<{
    uploadUrl: string;
    fields: Record<string, string>;
    entryIndex: number;
    expiresAt: number;
    maxUploadBytes: number;
  }> => {
    const userId = await getCurrentUserId(ctx);
    if (!userId) {
      // Throws rather than returning `{success:false}`, for the reason given on
      // `createPlaceholderUploadUrl`: minting a bearer capability IS the
      // authorization decision, and it should fail loudly.
      throw new Error("Not authenticated");
    }
    if (!CLERK_USER_ID_RE.test(userId)) {
      throw new Error("Unexpected user id shape");
    }

    // Both cheap refusals happen BEFORE the allocation, so a bad content type or
    // a misconfigured deployment costs nothing — no consumed entry index, no
    // orphan row. Only failures that cannot be predicted (the signing call
    // itself) are allowed to strand one.
    const extension = placeholderImageExtension(args.contentType);
    if (!extension) {
      throw new Error(`Unsupported image type: ${args.contentType}`);
    }

    const bucketName = process.env.GCS_PLACEHOLDER_BUCKET;
    if (!bucketName) {
      throw new Error("GCS_PLACEHOLDER_BUCKET not set");
    }

    // Ownership, mode and status are all checked inside this mutation, which
    // throws if any of them fails — so nothing below it can run for a job the
    // caller does not own or one that has stopped collecting.
    const { entryIndex }: { entryIndex: number } = await ctx.runMutation(
      internal.placeholderStream.allocateStreamEntry,
      {
        jobId: args.jobId,
        userId,
        originalName: args.originalName,
      },
    );

    const objectPath = placeholderExtractedImageObject(
      userId,
      args.jobId,
      entryIndex,
      extension,
    );

    const gcs = getGCSClient();
    const bucket = gcs.bucket(bucketName);
    const file = bucket.file(objectPath);

    const expiresAt = Date.now() + IMAGE_UPLOAD_POLICY_TTL_MS;
    const [policy] = await file.generateSignedPostPolicyV4({
      expires: expiresAt,
      conditions: [["content-length-range", 0, MAX_PLACEHOLDER_IMAGE_BYTES]],
      fields: {
        "Content-Type": args.contentType,
        "x-goog-if-generation-match": "0",
      },
    });

    return {
      uploadUrl: policy.url,
      fields: policy.fields,
      entryIndex,
      expiresAt,
      maxUploadBytes: MAX_PLACEHOLDER_IMAGE_BYTES,
    };
  },
});

/**
 * Mint a short-lived signed READ url for one image's PROCESSED crop.
 *
 * The first consumer is the streaming CLI, which has to show the operator what
 * it just produced; the NEO-152 review UI will use the same call. Neither can
 * fetch the object directly — the bucket is private, and the only principals
 * with read access are the Convex service account and the preprocess runtime —
 * so a signed url is how a browser sees a crop at all.
 *
 * `{jobId, entryIndex}` and nothing else. The object key is derived here from
 * the verified Clerk subject plus the row the ownership check resolved, so this
 * action cannot be pointed at another user's object no matter what it is asked
 * for. That rule is doing more work on THIS action than on the upload ones: both
 * SAs hold bucket-wide `objectViewer`, so a path argument here would turn a
 * signed-url minter into a cross-user read oracle for every object in the
 * bucket. See the `placeholderJobs` table comment in schema.ts.
 *
 * Nothing about the bucket or the key is returned either. The signed url
 * necessarily contains the key, and there is no way around that — but a separate
 * `objectPath` / `bucket` field would be a second, structured copy that callers
 * would start storing and passing around, and the first function to accept one
 * back is the one that breaks the rule.
 *
 * **Finding the object.** The extension is not knowable from the row: the
 * service's `ProcessEntryResponse` does not report it, and the output's format
 * is whatever the CROPPED image sniffed as rather than the input's. So the
 * object is located the way the service locates an extracted one — try the known
 * extensions in `_EXTRACTED_EXTENSIONS` order — and the answer is memoised on the
 * row, so a job's review page pays at most one probe per image ever rather than
 * up to three per render. `exists()` (a HEAD) rather than a prefix listing on
 * purpose: it needs only `storage.objects.get`, where listing would additionally
 * exercise `storage.objects.list`, and the permission set on a bucket this
 * sensitive should stay as narrow as the job allows.
 */
export const createPlaceholderImageDownloadUrl = action({
  args: { jobId: v.string(), entryIndex: v.number() },
  returns: v.object({
    url: v.string(),
    entryIndex: v.number(),
    expiresAt: v.number(),
  }),
  handler: async (ctx, args) => {
    const userId = await getCurrentUserId(ctx);
    if (!userId) {
      throw new Error("Not authenticated");
    }
    if (!CLERK_USER_ID_RE.test(userId)) {
      throw new Error("Unexpected user id shape");
    }
    // Bounds before anything else: this value is interpolated into a GCS key
    // below, so it gets the same ge=0/le=MAX bound the service's own request
    // model enforces — the row lookup should be the second thing standing
    // between a caller and a key segment, not the only one. Same error shape
    // as a missing row on purpose.
    if (
      !Number.isInteger(args.entryIndex) ||
      args.entryIndex < 0 ||
      args.entryIndex > PLACEHOLDER_MAX_ENTRY_INDEX
    ) {
      throw new Error("Image not found");
    }

    const bucketName = process.env.GCS_PLACEHOLDER_BUCKET;
    if (!bucketName) {
      throw new Error("GCS_PLACEHOLDER_BUCKET not set");
    }

    // One error for "no such job", "not your job", "no such entry" and "that
    // entry has no output yet" — see `getImageForDownload`. Annotated for the
    // same reason as the mint above: the shape mirrors that query's `returns`
    // validator, so the two cannot drift apart unnoticed.
    const image: { imageId: Id<"placeholderImages">; outputExtension?: string } | null =
      await ctx.runQuery(internal.placeholderPipeline.getImageForDownload, {
        jobId: args.jobId,
        userId,
        entryIndex: args.entryIndex,
      });
    if (!image) {
      throw new Error("Image not found");
    }

    const gcs = getGCSClient();
    const bucket = gcs.bucket(bucketName);

    // The memoised extension is re-checked against the allowlist before it goes
    // anywhere near a key. It can only ever have been written from that list, so
    // this should not fire — but a stored string that becomes a path segment
    // gets validated on the way out, not trusted because of where it came from.
    const cached = isPlaceholderOutputExtension(image.outputExtension)
      ? image.outputExtension
      : undefined;
    const candidates = cached ? [cached] : PLACEHOLDER_OUTPUT_EXTENSIONS;

    let objectPath: string | undefined;
    let resolvedExtension: string | undefined;
    for (const extension of candidates) {
      const candidate = placeholderOutputImageObject(
        userId,
        args.jobId,
        args.entryIndex,
        extension,
      );
      const [exists] = await bucket.file(candidate).exists();
      if (!exists) continue;
      objectPath = candidate;
      resolvedExtension = extension;
      break;
    }

    if (!objectPath || !resolvedExtension) {
      // The row says "done" but the object is not there. That is a real
      // inconsistency (a lifecycle rule that aged the object out, a bucket
      // restored from a partial backup), not something the caller did — but it
      // is still "there is no image here to hand you", so it gets the same
      // answer rather than an error that invites a retry loop.
      //
      // A cached extension that no longer resolves deliberately does NOT fall
      // back to probing the other two: the cache is only ever written from a
      // successful probe, so a miss means the object is gone, not that the cache
      // is wrong.
      throw new Error("Image not found");
    }

    if (resolvedExtension !== cached) {
      await ctx.runMutation(internal.placeholderPipeline.recordOutputExtension, {
        imageId: image.imageId,
        extension: resolvedExtension as "jpg" | "png" | "webp",
      });
    }

    const expiresAt = Date.now() + DOWNLOAD_URL_TTL_MS;
    const [url] = await bucket.file(objectPath).getSignedUrl({
      version: "v4",
      action: "read",
      expires: expiresAt,
    });

    return { url, entryIndex: args.entryIndex, expiresAt };
  },
});
