/**
 * What this CLI relies on from apps/web/convex, in one place with no imports,
 * so apps/web's own tests can check it on every web change
 * (apps/web/convex/scannerContract.test.ts). Renaming one of these functions
 * or rewording the stream's closed-run errors there must change this file too.
 */
export const BACKEND_FUNCTIONS = {
  joinRun: "intakeScanner:joinIntakeRunByScannerCode",
  createUploadUrl: "adapters/placeholderUploads:createPlaceholderImageUploadUrl",
  confirmUpload: "placeholderStream:confirmPlaceholderImageUpload",
} as const;

/** The stream refusing more images: done was pressed, or it went idle and closed. */
export const RUN_CLOSED_ERROR = /not collecting|not a scanner batch|Job not found/i;

/** The fields the CLI reads from a joined run (`JoinedRun` in neonbinder.ts). */
export const JOINED_RUN_FIELDS = ["runId", "jobId", "homeName", "homeKind", "variantName", "collecting"] as const;
