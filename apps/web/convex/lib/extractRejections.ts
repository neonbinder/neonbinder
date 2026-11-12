/**
 * NEO-446 — why the entries of an uploaded zip were rejected, as a collector
 * can act on it. `/extract` answers with a machine reason per entry; the job
 * row keeps three counts and a few example file names, so the intake screen
 * can say what went wrong without a row per rejected entry (a row would join
 * the counters, the prune and the lanes, none of which want it).
 *
 * Pure, with no Convex runtime, so the default-runtime pipeline, the Node
 * `runExtract` action, schema.ts and the client can all import it.
 */

import { v, type Infer } from "convex/values";

export const rejectionKindValidator = v.union(
  v.literal("tooBig"),
  v.literal("wrongFormat"),
  v.literal("unreadable"),
);
export type RejectionKind = Infer<typeof rejectionKindValidator>;

export const rejectedSummaryValidator = v.object({
  tooBig: v.number(),
  wrongFormat: v.number(),
  unreadable: v.number(),
  examples: v.array(v.object({ name: v.string(), kind: rejectionKindValidator })),
});
export type RejectedSummary = Infer<typeof rejectedSummaryValidator>;

export const MAX_REJECTION_EXAMPLES = 5;
export const MAX_REJECTION_EXAMPLE_CHARS = 80;

/**
 * The error code `/process-entry` sends for a raster over the pixel ceiling
 * (services/preprocess/app/main.py). It reaches the image row so a loose photo
 * can say it is too big, and so the screen offers no Try again: the same bytes
 * can never pass.
 */
export const ENTRY_TOO_MANY_PIXELS = "ENTRY_TOO_MANY_PIXELS";

/**
 * NEO-484: the error code `/process-entry` sends (HTTP 422) for an entry that
 * is not a decodable image. Terminal like the pixel ceiling: the same bytes
 * can never decode, so the photo says so and offers no Try again.
 */
export const ENTRY_UNDECODABLE = "ENTRY_UNDECODABLE";

// Reasons come from services/preprocess: `_prepare_member` in app/main.py and
// `_name_rejection` / `_metadata_rejection` / `iter_zip_members` in
// app/jobs/zipsafe.py. HEIC lands in `unsupported_image_type`.
const TOO_BIG_REASONS = new Set(["image_too_many_pixels", "entry_too_large"]);
const WRONG_FORMAT_REASONS = new Set(["unsupported_image_type", "unsupported_output_type"]);
const UNREADABLE_REASONS = new Set([
  "no_data",
  "entry_undecodable",
  "entry_unreadable",
  "symlink_entry",
  "encrypted_entry",
]);
const WHOLE_NAME_REASONS = new Set([
  "absolute_entry_name",
  "drive_letter_entry_name",
  "empty_entry_name",
]);

/** The entry's NAME failed validation: it may hold control or bidi characters. */
function isNameRejection(reason: string): boolean {
  return reason.startsWith("entry_name_") || WHOLE_NAME_REASONS.has(reason);
}

function isKnownReason(reason: string): boolean {
  return (
    TOO_BIG_REASONS.has(reason) ||
    WRONG_FORMAT_REASONS.has(reason) ||
    UNREADABLE_REASONS.has(reason) ||
    isNameRejection(reason)
  );
}

/** Which bucket a raw reason falls in. Anything not recognised reads as unreadable, and never throws. */
export function rejectionKind(reason: string | null | undefined): RejectionKind {
  if (reason && TOO_BIG_REASONS.has(reason)) return "tooBig";
  if (reason && WRONG_FORMAT_REASONS.has(reason)) return "wrongFormat";
  return "unreadable";
}

/**
 * The file name to show for a rejected entry: its last path segment, clipped,
 * or null when there is nothing to show. Clipped by code point so a long name
 * never ends on half a surrogate pair.
 *
 * Any Unicode "other" character (`\p{C}`: controls, format characters, the rest)
 * means no name at all, wherever it sits. The service's own forbidden list stops
 * well short of that: U+200E, U+200F, U+061C, U+200B, C1 controls, U+FEFF and tag
 * characters all pass it, and any of them can make one name read as another.
 */
export function rejectionExampleName(name: string): string | null {
  if (/\p{C}/u.test(name)) return null;
  const base = name.split(/[/\\]/).pop() ?? "";
  if (!base) return null;
  return Array.from(base).slice(0, MAX_REJECTION_EXAMPLE_CHARS).join("");
}

/**
 * Whether this entry's name may reach a screen. A name rejection failed
 * validation, so it is counted and never shown. So is an unknown reason: the
 * service checks the name first, but only a reason listed here is known to
 * have come after that check.
 */
function nameIsShowable(reason: string | null | undefined): boolean {
  return !!reason && isKnownReason(reason) && !isNameRejection(reason);
}

/**
 * The job row's summary of what `/extract` turned away, or undefined when it
 * turned nothing away. Worked out from the whole entry list, so it needs no
 * state across registration chunks and its counts always add up to
 * `rejectedEntries`.
 */
export function summarizeRejections(
  entries: ReadonlyArray<{ name: string; accepted: boolean; reason?: string | null }>,
): RejectedSummary | undefined {
  const rejected = entries.filter((entry) => !entry.accepted);
  if (rejected.length === 0) return undefined;
  const summary: RejectedSummary = { tooBig: 0, wrongFormat: 0, unreadable: 0, examples: [] };
  for (const entry of rejected) {
    const kind = rejectionKind(entry.reason);
    summary[kind] += 1;
    if (summary.examples.length >= MAX_REJECTION_EXAMPLES || !nameIsShowable(entry.reason)) continue;
    const name = rejectionExampleName(entry.name);
    if (name) summary.examples.push({ name, kind });
  }
  return summary;
}

/** The reasons in this response nothing here recognises, once each, for the log. */
export function unknownRejectionReasons(
  entries: ReadonlyArray<{ accepted: boolean; reason?: string | null }>,
): string[] {
  const unknown = new Set<string>();
  for (const entry of entries) {
    if (!entry.accepted && entry.reason && !isKnownReason(entry.reason)) unknown.add(entry.reason);
  }
  return [...unknown];
}

/**
 * Whether a settled photo's error is the pixel ceiling's 413. The adapter
 * throws `preprocess ENTRY_TOO_MANY_PIXELS (HTTP 413): …`, and the workpool
 * hands the hook that text as a string, possibly wrapped in a JSON envelope or
 * prefixed by the runtime, so the marker is searched for anywhere in it. Same
 * shape `parsePreprocessErrorCode` reads; that one lives in a Node module the
 * settle cannot import.
 */
export function isRasterTooLargeError(error: string): boolean {
  return terminalEntryErrorCode(error) === ENTRY_TOO_MANY_PIXELS;
}

/**
 * NEO-484: the terminal per-entry code in a settled photo's error, or
 * undefined when it carries none. Covers the pixel ceiling's 413 and the
 * not-an-image 422; read the same way as `isRasterTooLargeError`, anywhere in
 * the (possibly wrapped) text.
 */
export function terminalEntryErrorCode(error: string): string | undefined {
  return /\bpreprocess (ENTRY_TOO_MANY_PIXELS|ENTRY_UNDECODABLE) \(HTTP \d+\)/.exec(error)?.[1];
}
