/**
 * Which intake path a user's file selection takes (NEO-152).
 *
 * The screen offers ONE control and the user does not choose a mode: drop a zip
 * or drop a pile of photos, and the page behaves identically from the progress
 * line onward. This function is the whole of that decision, kept separate from
 * React so the rule is testable without a renderer — the same reason the upload
 * ordering lives in ./upload-run.ts.
 *
 * ## Why a zip is only a zip when it is ALONE
 * A selection of "one archive" and a selection of "some images" are the two
 * real cases. A mixed selection (a zip plus loose photos) has no sensible
 * meaning — the zip would have to be expanded server-side while the loose files
 * streamed, into one job, interleaved in an order nobody specified — and entry
 * order is a correctness constraint for pairing, not a detail. So a mixed
 * selection is refused with an explanation rather than silently half-honoured.
 *
 * Multiple zips are refused for the same reason: each becomes its own job
 * server-side, and quietly turning one drop into three batches would blow
 * through the user's active-batch cap for reasons they never asked for.
 */

/** Matched on the filename, since browsers disagree about the zip MIME type. */
const ZIP_NAME_RE = /\.zip$/i;

export function isZipFile(file: File): boolean {
  return ZIP_NAME_RE.test(file.name);
}

export type IntakeKind =
  | { kind: "zip"; file: File }
  | { kind: "images"; files: File[] }
  | { kind: "invalid"; reason: string };

export function classifyIntake(files: File[]): IntakeKind {
  if (files.length === 0) {
    return { kind: "invalid", reason: "no files selected" };
  }

  const zips = files.filter(isZipFile);

  if (zips.length === 0) {
    return { kind: "images", files };
  }

  if (zips.length === files.length && files.length === 1) {
    return { kind: "zip", file: zips[0] };
  }

  if (zips.length === files.length) {
    return {
      kind: "invalid",
      reason: `select one zip at a time — ${zips.length} were chosen, and each would start its own batch`,
    };
  }

  return {
    kind: "invalid",
    reason:
      "select either a single zip or a set of images, not both — mixing them has no defined scan order",
  };
}
