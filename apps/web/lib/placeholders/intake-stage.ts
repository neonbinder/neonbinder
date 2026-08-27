/**
 * What is happening, and what the collector should do about it (NEO-152).
 *
 * The stopgap this replaced showed a database status ("Collecting") and two
 * buttons, and left the reader to infer that work was in flight, that results
 * would appear, and that finishing was their job. Nobody inferred it. This
 * turns the raw job row into the one question a person actually has, and the
 * page renders a single sentence and a single obvious next action from it.
 *
 * `waiting` is the state the old page had no name for and most needed: every
 * photo you uploaded is processed, nothing is in flight, and the batch is
 * STILL open because a scanner session is allowed to keep going. That is the
 * moment to say "add more, or finish" — the close is a real decision, not a
 * formality, so the UI asks for it plainly instead of hiding it behind a
 * button labelled after the database.
 */

export type IntakeStage =
  | "empty"
  | "ready"
  | "uploading"
  | "working"
  | "waiting"
  | "finishing"
  | "done"
  | "failed";

export type StageJob = {
  status: string;
  totalImages: number;
  processedImages: number;
  failedImages: number;
} | null | undefined;

export type StageImage = { status: string };

/** Statuses in which more images can still be added. */
const OPEN_STATUSES = new Set(["pending", "uploaded", "collecting"]);
/** Statuses that mean the server is still finishing on its own. */
const CLOSING_STATUSES = new Set(["extracting", "processing", "pairing"]);

export function deriveStage(args: {
  job: StageJob;
  images: StageImage[] | undefined;
  uploading: boolean;
  selectedCount: number;
}): IntakeStage {
  const { job, images, uploading, selectedCount } = args;

  if (uploading) return "uploading";
  if (!job) return selectedCount > 0 ? "ready" : "empty";

  if (job.status === "succeeded") return "done";
  // NOTE: there is no "canceled" status. Cancelling writes "failed" with
  // errorCode CANCELED, so the distinction is made from the code, not here.
  if (job.status === "failed") return "failed";

  // Closed and draining: the user has already said "that's everything", so
  // there is no decision left to prompt for.
  if (CLOSING_STATUSES.has(job.status)) return "finishing";

  if (OPEN_STATUSES.has(job.status)) {
    // Still open. The distinction that matters is whether anything is actually
    // in flight — an open batch with nothing left to process is waiting on the
    // PERSON, and saying so is the entire point of this function.
    const rows = images ?? [];
    const settled = rows.filter(
      (i) => i.status === "done" || i.status === "failed",
    ).length;
    const anyInFlight = rows.length > settled;
    if (rows.length > 0 && !anyInFlight) return "waiting";
    return "working";
  }

  return "working";
}
