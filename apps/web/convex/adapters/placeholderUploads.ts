"use node";

import { action } from "../_generated/server";
import { v } from "convex/values";
import { randomUUID } from "node:crypto";
import { getCurrentUserId } from "../auth";
import { getGCSClient } from "./gcs";
import { internal } from "../_generated/api";

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

// Clerk subject IDs are `user_` followed by a base62-ish ID (see Clerk's own
// docs/JWTs — `getCurrentUserId` just forwards whatever's on the verified
// token). That's an invariant we're currently *inheriting*, not one Convex
// enforces itself. Since this value becomes a literal GCS object-path
// segment, checking the shape here converts "Clerk happens to always send
// this shape" into "this code refuses to build a path if it doesn't."
const CLERK_USER_ID_RE = /^user_[A-Za-z0-9]+$/;

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
    // here.
    const objectPath = `placeholders/${userId}/${jobId}/input.zip`;

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
