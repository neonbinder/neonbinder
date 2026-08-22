import { useCallback, useState } from "react";
import { useAction, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import {
  postSignedForm,
  runPlaceholderUpload,
  type FileProgress,
} from "@/lib/placeholders/upload-run";

/**
 * Open a scan session and push files into it — the whole intake path, in one
 * hook (NEO-170).
 *
 * Two pages need this: /placeholders, where a person picks files, and
 * /testing/seed-placeholder-upload, where the release E2E enters because
 * maestro-web cannot drive a file input at all. The second one exists ONLY to
 * skip the file picker, so it has to run the identical network sequence —
 * `startPlaceholderStream`, then per file `createPlaceholderImageUploadUrl` →
 * form-POST → `confirmPlaceholderImageUpload`. A test path with its own copy of
 * that sequence would be a test of the copy: the flow could stay green while the
 * page a user actually touches was broken, which is the failure mode that makes
 * an E2E suite worse than none.
 *
 * The hook owns the Convex wiring and the per-file progress state. It owns no
 * copy and no layout — each page words its own outcome, because "Uploaded 6 of 6
 * images." and a test harness's status line are not the same sentence.
 *
 * The ordering guarantee (strictly sequential, confirm only after the bytes
 * land) lives in lib/placeholders/upload-run.ts, where it is tested without a
 * React renderer.
 */

export type UploadOutcome =
  | {
      ok: true;
      jobId: string;
      /** Files whose bytes landed AND were confirmed. */
      uploaded: number;
      failed: number;
      total: number;
    }
  | {
      ok: false;
      /** Server-supplied where there is one (e.g. the active-batch cap). */
      reason: string;
    };

/** How a run was started, recorded on the job so admins can tell scans from web
 * uploads. The cardlister CLI passes "scanner"; the web app passes "web". */
export type UploadSource = "scanner" | "web";

export interface UploadOptions {
  /**
   * Labels the run's origin. Omitted, the start call carries no `source` — which
   * keeps this hook working against a `startPlaceholderStream` whose validator
   * has not yet grown the optional `source` arg (a concurrent backend change).
   * Only a caller that passes a source takes on that dependency.
   */
  source?: UploadSource;
}

export interface PlaceholderUpload {
  /** One row per selected file, in selection order. */
  progress: FileProgress[];
  uploading: boolean;
  /** Clears progress from a previous run. */
  reset: () => void;
  upload: (files: File[], options?: UploadOptions) => Promise<UploadOutcome>;
}

export function usePlaceholderUpload(): PlaceholderUpload {
  const startStream = useMutation(api.placeholderStream.startPlaceholderStream);
  const confirmUpload = useMutation(
    api.placeholderStream.confirmPlaceholderImageUpload,
  );
  const createUploadUrl = useAction(
    api.adapters.placeholderUploads.createPlaceholderImageUploadUrl,
  );

  const [progress, setProgress] = useState<FileProgress[]>([]);
  const [uploading, setUploading] = useState(false);

  const reset = useCallback(() => setProgress([]), []);

  const upload = useCallback(
    async (files: File[], options?: UploadOptions): Promise<UploadOutcome> => {
      if (files.length === 0) {
        return { ok: false, reason: "no files to upload" };
      }

      setUploading(true);
      setProgress(
        files.map((file, position) => ({
          position,
          name: file.name,
          state: "pending" as const,
        })),
      );

      try {
        // Only include `source` when a caller asks for it, so a no-source upload
        // sends `{}` and stays compatible with the current validator. `{source}`
        // is assignable to the empty-args type, so no cast is needed; the
        // runtime dependency is on the backend accepting the optional field.
        const startArgs = options?.source ? { source: options.source } : {};
        // Cast to the current (empty) args type: `startPlaceholderStream`'s
        // validator has not grown the optional `source` field yet, so the
        // generated type is `EmptyObject`. `{source}` is dropped by that
        // validator until the backend change lands, at which point the field is
        // read — no code change here.
        const session = await startStream(
          startArgs as Parameters<typeof startStream>[0],
        );
        if (!session.started || !session.jobId) {
          return { ok: false, reason: session.reason ?? "try again" };
        }

        const result = await runPlaceholderUpload(session.jobId, files, {
          createUploadUrl,
          postToStorage: postSignedForm,
          confirmUpload,
          onProgress: (update) =>
            setProgress((previous) =>
              previous.map((row) =>
                row.position === update.position ? update : row,
              ),
            ),
        });

        return {
          ok: true,
          jobId: session.jobId,
          uploaded: result.uploaded,
          failed: result.failed,
          total: files.length,
        };
      } finally {
        setUploading(false);
      }
    },
    [confirmUpload, createUploadUrl, startStream],
  );

  return { progress, uploading, reset, upload };
}
