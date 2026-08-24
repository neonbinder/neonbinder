/**
 * Where a placeholder job's objects live, and what may be put in them
 * (NEO-170).
 *
 * This module is the Convex-side mirror of the preprocess service's
 * `services/preprocess/app/jobs/layout.py`, plus the three input bounds that
 * service enforces. Both halves are here for the same reason: they are numbers
 * and string shapes owned by ANOTHER repository on another release cadence, and
 * the only thing that keeps them in step is a comment naming the source. Same
 * discipline as convex/preprocessCapacity.ts — and, like that module, this one
 * is deliberately dependency-free so it can be imported from the default
 * runtime (convex/placeholderStream.ts) and from a `"use node"` module
 * (convex/adapters/placeholderUploads.ts) without dragging either into the
 * other.
 *
 * NOTHING here accepts a caller-supplied path. The builders take
 * `(userId, jobId, index)` and produce the key themselves, exactly as the
 * service does — see the `placeholderJobs` table comment in schema.ts for why
 * that is a hard rule rather than a style preference.
 */

// ---------------------------------------------------------------------------
// Identifier shapes and key layout — mirrors app/jobs/layout.py
// ---------------------------------------------------------------------------

/**
 * Clerk subject IDs are `user_` followed by a base62-ish ID (see Clerk's own
 * docs/JWTs — `getCurrentUserId` just forwards whatever's on the verified
 * token). That's an invariant we're currently *inheriting*, not one Convex
 * enforces itself. Since this value becomes a literal GCS object-path segment,
 * checking the shape here converts "Clerk happens to always send this shape"
 * into "this code refuses to build a path if it doesn't."
 *
 * The service's counterpart (`CLERK_USER_ID_PATTERN` in layout.py) is
 * deliberately STRICTER — it bounds the body at 64 characters. The asymmetry
 * fails closed: an id we would happily mint a policy for can still be refused
 * there, never the reverse.
 */
export const CLERK_USER_ID_RE = /^user_[A-Za-z0-9]+$/;

/**
 * Zero-padding width for per-entry object names — `IMAGE_INDEX_DIGITS` in
 * app/jobs/layout.py (currently 4).
 *
 * `/process-entry` locates an extracted object by trying the known extensions
 * against the padded index, so a stream upload written with different padding
 * is an object the service can never find: it would answer 404 ENTRY_NOT_FOUND,
 * which the adapter classifies as terminal, and the image would fail
 * permanently with no hint that the cause was a naming mismatch on our side.
 */
export const PLACEHOLDER_IMAGE_INDEX_DIGITS = 4;

const ROOT_PREFIX = "placeholders";

/** The single prefix every object belonging to one job lives under. */
export function placeholderJobPrefix(userId: string, jobId: string): string {
  return `${ROOT_PREFIX}/${userId}/${jobId}/`;
}

/** The zip a batch-mode job was uploaded as. */
export function placeholderInputObject(userId: string, jobId: string): string {
  return `${placeholderJobPrefix(userId, jobId)}input.zip`;
}

/**
 * One extracted, EXIF-uprighted original — `extracted/{index:04d}.{ext}`.
 *
 * In zip mode the SERVICE writes these (out of the archive). In stream mode the
 * browser writes one directly through a signed POST policy, which is why this
 * builder exists on the Convex side at all: both ingestion paths must produce
 * byte-identical keys or `/process-entry` cannot find the second one.
 */
export function placeholderExtractedImageObject(
  userId: string,
  jobId: string,
  index: number,
  extension: string,
): string {
  const padded = String(index).padStart(PLACEHOLDER_IMAGE_INDEX_DIGITS, "0");
  return `${placeholderJobPrefix(userId, jobId)}extracted/${padded}.${extension}`;
}

/**
 * One processed image — `output/images/{index:04d}.{ext}`, written by
 * `/process-entry` (`layout.output_image_object`).
 *
 * This is the crop the user actually looks at: cropped, deskewed, and with the
 * rotation baked in rather than left to the client.
 */
export function placeholderOutputImageObject(
  userId: string,
  jobId: string,
  index: number,
  extension: string,
): string {
  const padded = String(index).padStart(PLACEHOLDER_IMAGE_INDEX_DIGITS, "0");
  return `${placeholderJobPrefix(userId, jobId)}output/images/${padded}.${extension}`;
}

/**
 * The extensions a processed output can have, in the order to look for them.
 *
 * ====================================================================
 * MIRRORS `_EXTRACTED_EXTENSIONS` in services/preprocess/app/main.py —
 * the same tuple, in the same order, used there to locate an object
 * whose extension the caller does not know.
 * ====================================================================
 *
 * The service does not report which one it wrote: `ProcessEntryResponse`
 * carries the classification and the hash, and the output's format is whatever
 * `sniff_image_type` made of the CROPPED image, which need not match the input's
 * format. So the extension is not derivable from anything we store at
 * completion time, and the object has to be found the same way the service
 * finds an extracted one — by trying these in order. Keeping the order
 * identical matters: if two objects ever existed at one index, both sides must
 * agree on which is "the" output.
 */
export const PLACEHOLDER_OUTPUT_EXTENSIONS: readonly string[] = ["jpg", "png", "webp"];

/**
 * Is this a stored extension we are willing to interpolate into an object key?
 *
 * Used on the memoised `placeholderImages.outputExtension` column before it is
 * put back into a path. The value can only have come from
 * PLACEHOLDER_OUTPUT_EXTENSIONS, so this should never fire — but "should never"
 * is not a reason to build a GCS key out of an unchecked stored string.
 */
export function isPlaceholderOutputExtension(value: unknown): value is string {
  return typeof value === "string" && PLACEHOLDER_OUTPUT_EXTENSIONS.includes(value);
}

// ---------------------------------------------------------------------------
// Input bounds — mirrored from the preprocess service, never invented here
// ---------------------------------------------------------------------------

/**
 * Highest entry index the service will accept.
 *
 * ====================================================================
 * MIRRORS `entry_index: int = Field(ge=0, le=zipsafe.MAX_ZIP_ENTRIES)`
 * ON `ProcessEntryRequest` — services/preprocess/app/main.py (the bound
 * resolves to MAX_ZIP_ENTRIES = 1000 in app/jobs/zipsafe.py).
 * ====================================================================
 *
 * In zip mode nothing needs this constant: `/extract` cannot report an ordinal
 * past its own ceiling, so the bound is satisfied by construction. Stream mode
 * removes that guarantee — the index is allocated HERE, one per upload-URL
 * request, and an unbounded counter would eventually mint a policy for
 * `extracted/1001.jpg` that `/process-entry` then rejects with a 422 the user
 * cannot act on. Refusing the allocation instead turns a silent dead entry into
 * a clear "this batch is full".
 *
 * Inclusive, matching `le`: index 1000 is allowed, 1001 is not.
 */
export const PLACEHOLDER_MAX_ENTRY_INDEX = 1000;

/**
 * Largest single image the service will decompress.
 *
 * ====================================================================
 * MIRRORS `MAX_ENTRY_UNCOMPRESSED_BYTES` in
 * services/preprocess/app/jobs/zipsafe.py (32 MiB), which that file
 * asserts equal to `app.main.MAX_IMAGE_BYTES`.
 * ====================================================================
 *
 * Used as the `content-length-range` ceiling on a stream upload's signed POST
 * policy. Being GENEROUS here is the failure that costs: GCS would accept a
 * 64MB object, and `/process-entry` would then refuse to download it past its
 * own cap — a paid round trip to learn what the policy could have refused for
 * free. The policy is the contract; zipsafe.py's own comment says so from the
 * other side.
 */
export const MAX_PLACEHOLDER_IMAGE_BYTES = 32 * 1024 * 1024;

/**
 * Content types a stream upload may declare, and the file extension each one is
 * stored under.
 *
 * ====================================================================
 * MIRRORS `ALLOWED_CONTENT_TYPES` in services/preprocess/app/main.py and
 * `EXTENSION_BY_CONTENT_TYPE` in services/preprocess/app/jobs/zipsafe.py.
 * ====================================================================
 *
 * A `Map`, not an object literal, so a lookup can never walk the prototype
 * chain — `"constructor"` and `"__proto__"` are ordinary misses here, whereas
 * an object would answer them with a function and a prototype respectively, and
 * the truthy result would sail into the object key.
 *
 * The service sniffs the actual magic bytes (`sniff_image_type`) and does not
 * trust this declaration, so a lie here does not get an attacker a decoded
 * image of the wrong type — it gets them an object with a misleading extension
 * that `/process-entry` finds and reads anyway (it tries every known extension
 * at the index). The allowlist's real job is narrower and still worth doing:
 * keep the extension we interpolate into an object key drawn from a fixed set
 * of three, rather than from a client string.
 */
export const PLACEHOLDER_IMAGE_EXTENSION_BY_CONTENT_TYPE: ReadonlyMap<string, string> =
  new Map([
    ["image/jpeg", "jpg"],
    ["image/png", "png"],
    ["image/webp", "webp"],
  ]);

/**
 * Resolve a client-declared content type to its stored extension, or undefined
 * when it is not one of the three the service accepts.
 *
 * Deliberately an EXACT match, where the service's `_validate_content_type`
 * (main.py) splits parameters off first and accepts `image/jpeg; charset=binary`.
 * The asymmetry is not an oversight: the value that passes this check is signed
 * into the POST policy as an exact `Content-Type` condition, and GCS compares it
 * byte-for-byte against what the browser actually sends. Normalising here would
 * mean signing a value the client did not give us, and every such upload would
 * come back as a 412 with nothing on our side explaining why. Requiring the bare
 * type up front makes the refusal happen at mint time, with a message.
 */
export function placeholderImageExtension(contentType: string): string | undefined {
  return PLACEHOLDER_IMAGE_EXTENSION_BY_CONTENT_TYPE.get(contentType);
}
