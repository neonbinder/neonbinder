import { useCallback, useState } from "react";
import { useAction, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import {
  postSignedForm,
  runPlaceholderUpload,
  type FileProgress,
} from "@/lib/placeholders/upload-run";
import { classifyIntake } from "@/lib/placeholders/intake-kind";

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
  // The zip half of the same front door. Separate Convex functions, identical
  // outcome shape — see the `classifyIntake` branch below.
  const createZipUploadUrl = useAction(
    api.adapters.placeholderUploads.createPlaceholderUploadUrl,
  );
  const startBatch = useMutation(api.placeholderPipeline.startPlaceholderBatch);

  const [progress, setProgress] = useState<FileProgress[]>([]);
  const [uploading, setUploading] = useState(false);

  const reset = useCallback(() => setProgress([]), []);

  const upload = useCallback(
    async (files: File[], options?: UploadOptions): Promise<UploadOutcome> => {
      if (files.length === 0) {
        return { ok: false, reason: "no files to upload" };
      }

      // ONE control, two server paths. The user picked files; they did not pick
      // a mode. Everything after this returns the same `UploadOutcome`, so the
      // page renders a zip run and a scan run identically — which is the whole
      // requirement (NEO-152).
      const intake = classifyIntake(files);
      if (intake.kind === "invalid") {
        return { ok: false, reason: intake.reason };
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
        if (intake.kind === "zip") {
          // Mint first: the job row is created by the mint, so a refusal here
          // costs nothing and the user is told before the bytes move. This is
          // also where the submission rate limit bites for zips, because the
          // limit counts `createdAt` — see jobStartRateLimitReason.
          const ticket = await createZipUploadUrl({});

          if (intake.file.size > ticket.maxUploadBytes) {
            const limitMb = Math.floor(ticket.maxUploadBytes / (1024 * 1024));
            setProgress([
              { position: 0, name: intake.file.name, state: "failed", error: "too large" },
            ]);
            return {
              ok: false,
              reason: `that zip is larger than the ${limitMb}MB limit`,
            };
          }

          setProgress([{ position: 0, name: intake.file.name, state: "uploading" }]);
          await postSignedForm(
            { uploadUrl: ticket.uploadUrl, fields: ticket.fields },
            intake.file,
          );
          setProgress([{ position: 0, name: intake.file.name, state: "uploaded" }]);

          // Extraction is server-side from here. `started: false` is a refusal
          // with a reason (the caps), not an error — same shape the stream
          // start uses, so the page's one error path covers both.
          const started = await startBatch({ jobId: ticket.jobId, source: "web" });
          if (!started.started) {
            return { ok: false, reason: started.reason ?? "try again" };
          }

          // `uploaded: 1` counts the ARCHIVE, not the cards inside it — the
          // image count is not known until /extract has run, and the page reads
          // it from the job's `totalImages` like it does for a scan.
          return {
            ok: true,
            jobId: ticket.jobId,
            uploaded: 1,
            failed: 0,
            total: 1,
          };
        }

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
    [confirmUpload, createUploadUrl, createZipUploadUrl, startBatch, startStream],
  );

  return { progress, uploading, reset, upload };
}
