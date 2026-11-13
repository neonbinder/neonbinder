import { ConvexError } from "convex/values";

/**
 * Refusals a placeholder client must tell apart by cause (NEO-529).
 *
 * A plain `throw new Error("…")` reaches a production client as "Server
 * Error": Convex redacts the message. A client that has to say WHY a send was
 * refused therefore needs a `ConvexError`, whose `data` survives redaction and
 * survives being rethrown out of `ctx.runMutation` into the calling action.
 *
 * Pure (no server imports), so the web client reads the same code it is
 * checked against: lib/placeholders/upload-run.ts imports `isBatchNotCollecting`.
 */

/** The scan session stopped collecting: it was finished, discarded or swept. */
export const BATCH_NOT_COLLECTING = "BATCH_NOT_COLLECTING";

/**
 * The refusal for a photo sent into a session that is no longer collecting.
 *
 * `message` keeps the wording the scanner CLI and the logs have always shown;
 * `code` is what a client branches on.
 */
export function batchNotCollecting(status: string) {
  return new ConvexError({
    code: BATCH_NOT_COLLECTING,
    status,
    message: `job is ${status}, not collecting`,
  });
}

/**
 * Whether an error is the session-closed refusal.
 *
 * Reads `data.code` rather than `instanceof ConvexError`: the code is the
 * contract, and a check on the class would quietly answer false if a second
 * copy of the `convex` package (or a test double) built the error.
 */
export function isBatchNotCollecting(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("data" in error)) return false;
  const data = (error as { data: unknown }).data;
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { code?: unknown }).code === BATCH_NOT_COLLECTING
  );
}
