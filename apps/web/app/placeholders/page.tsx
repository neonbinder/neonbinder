import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { useAction, useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import NeonButton from "@/components/modules/NeonButton";
import { ConfirmDialog } from "@/components/modules/confirm-dialog";
import { api } from "@/convex/_generated/api";
import { useDocumentTitle } from "@/src/hooks/useDocumentTitle";
import { usePlaceholderUpload } from "@/src/hooks/usePlaceholderUpload";

/**
 * /placeholders — scan in, cropped pairs out (NEO-170).
 *
 * ## This is a stopgap, deliberately
 * NEO-152 owns the real intake UI: a scanner-shaped workflow with review,
 * re-pairing, corrections and print hand-off. Until it lands, the streaming
 * pipeline built in NEO-170 has no front door at all — it is exercised by
 * cardlister and by tests, and a person with a folder of scans cannot use it.
 * This page is that front door and nothing more: pick files, watch them land,
 * look at what came back. Expect NEO-152 to replace rather than extend it, and
 * do not grow features here on the assumption that it will not.
 *
 * ## Why the upload loop lives in ./upload-run.ts
 * Pairing reads adjacency — entry 0 is the front whose back is entry 1 — so the
 * ORDER of the allocate calls is a correctness constraint, not a performance
 * detail. That constraint is testable and is tested there; this file only wires
 * Convex actions into it.
 *
 * ## What is not here
 * The job id lives in component state only, so a reload loses sight of a running
 * session (the session itself keeps going server-side, and the idle sweep closes
 * it). Persisting it is NEO-152's problem, along with resuming one.
 */

type PlaceholderJob = NonNullable<
  FunctionReturnType<typeof api.placeholderPipeline.getPlaceholderJob>
>;
type PlaceholderImage = FunctionReturnType<
  typeof api.placeholderPipeline.listPlaceholderImages
>[number];
type PlaceholderPair = FunctionReturnType<
  typeof api.placeholderPipeline.listPlaceholderPairs
>[number];

/** Statuses in which the session can still be closed or aborted. */
const ACTIVE_STATUSES = new Set([
  "pending",
  "uploaded",
  "collecting",
  "extracting",
  "processing",
  "pairing",
]);

const CONFIDENCE_LABELS: Record<PlaceholderPair["confidence"], string> = {
  exact: "exact match",
  fuzzy: "fuzzy match",
  "side-only": "front/back only",
};

const MECHANISM_LABELS: Record<PlaceholderPair["mechanism"], string> = {
  adjacency: "by scan order",
  pool: "by image pool",
};

type Notice = { tone: "success" | "info" | "error"; text: string };

const NOTICE_CLASSES: Record<Notice["tone"], string> = {
  success: "border border-neon-green/40 bg-neon-green/10 text-neon-green",
  info: "border border-neon-blue/40 bg-neon-blue/10 text-neon-blue",
  error: "border border-neon-pink/40 bg-neon-pink/10 text-neon-pink",
};

/**
 * One cropped scan, behind a signed GET that expires in ~15 minutes.
 *
 * The URL is fetched when the image is first rendered rather than alongside the
 * pair list, because a list fetched at page load is a list of URLs that have
 * already started expiring — a user who leaves the tab open and comes back to
 * broken images is the exact failure this avoids. `onError` re-mints once, which
 * covers the same expiry from the other direction.
 */
function ScanImage({
  jobId,
  entryIndex,
  alt,
}: {
  jobId: string;
  entryIndex: number;
  alt: string;
}) {
  const createDownloadUrl = useAction(
    api.adapters.placeholderUploads.createPlaceholderImageDownloadUrl,
  );
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await createDownloadUrl({ jobId, entryIndex });
        if (!cancelled) setUrl(result.url);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
    // `createDownloadUrl` is deliberately NOT a dependency: `useAction` returns
    // a new function identity on every render, so including it re-runs this
    // effect forever — the render loop documented for Convex actions in
    // effects. The fetch is keyed on the arguments that actually identify the
    // object, plus `attempt` for the re-mint.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, entryIndex, attempt]);

  if (failed) {
    return (
      <div className="flex h-40 items-center justify-center rounded border border-slate-800 bg-slate-900/60 p-2 text-xs text-slate-400">
        Image unavailable
      </div>
    );
  }

  if (!url) {
    return (
      <div className="flex h-40 items-center justify-center rounded border border-slate-800 bg-slate-900/60 p-2 text-xs text-slate-400">
        Loading image…
      </div>
    );
  }

  return (
    <img
      src={url}
      alt={alt}
      className="h-40 w-auto rounded border border-slate-800 object-contain"
      onError={() => {
        // One retry: a signed URL that expired while the tab sat open mints a
        // fresh one. A second failure is a real problem, not an expiry, and
        // retrying it forever would hammer the action.
        if (attempt < 1) {
          setAttempt((previous) => previous + 1);
          setUrl(null);
        } else {
          setFailed(true);
        }
      }}
    />
  );
}

function imageSummary(image: PlaceholderImage): string {
  if (image.status === "failed") {
    return image.errorCode ? `Failed (${image.errorCode})` : "Failed";
  }
  if (image.status !== "done") return statusLabel(image.status);
  const parts = [
    image.side ? `${image.side} side` : null,
    image.players?.length ? image.players.join(", ") : null,
    image.cardNumber ? `#${image.cardNumber}` : null,
  ].filter(Boolean);
  return parts.length > 0 ? `Done — ${parts.join(" · ")}` : "Done";
}

function statusLabel(status: string): string {
  if (status === "awaiting_upload") return "Awaiting upload";
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function jobSummary(job: PlaceholderJob): string {
  const done = job.processedImages + job.failedImages;
  return `${statusLabel(job.status)} — ${done} of ${job.totalImages} images processed, ${job.failedImages} failed, ${job.pairCount} pairs`;
}

/**
 * How many times pairing had to ask the name resolver — the spend signal for a
 * run, since adjacency and the image pool are free and the resolver is not.
 *
 * Rendered on its own line rather than folded into the summary sentence so a
 * flow can assert it exactly. The `?? 0` is belt and braces for a row written
 * before the counter existed; the server already defaults it.
 */
function resolverCallsOf(job: PlaceholderJob): number {
  return job.resolverCalls ?? 0;
}

export default function PlaceholderScansPage() {
  useDocumentTitle("Placeholder Scans | Neon Binder");

  const closeStream = useMutation(api.placeholderStream.closePlaceholderStream);
  const cancelBatch = useMutation(
    api.placeholderPipeline.cancelPlaceholderBatch,
  );
  const { progress, uploading, upload } = usePlaceholderUpload();

  // The session id lives in the URL, not in state. That is what makes this page
  // addressable: /placeholders?jobId=… reopens a run that is still going (or
  // already finished), which is where the upload flow lands itself and where the
  // /testing entry point redirects the E2E suite. State would have made the run
  // view reachable only by having just created it.
  const [searchParams, setSearchParams] = useSearchParams();
  const jobId = searchParams.get("jobId");

  const [files, setFiles] = useState<File[]>([]);
  const [pendingAction, setPendingAction] = useState<"close" | "abort" | null>(
    null,
  );
  const [actionBusy, setActionBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  const job = useQuery(
    api.placeholderPipeline.getPlaceholderJob,
    jobId ? { jobId } : "skip",
  );
  const images = useQuery(
    api.placeholderPipeline.listPlaceholderImages,
    jobId ? { jobId } : "skip",
  );
  const pairs = useQuery(
    api.placeholderPipeline.listPlaceholderPairs,
    jobId ? { jobId } : "skip",
  );

  const handleUpload = useCallback(async () => {
    if (files.length === 0 || uploading) return;
    setNotice(null);

    try {
      // Label the run web-originated (NEO-170); the cardlister CLI passes
      // "scanner" on its own start path.
      const outcome = await upload(files, { source: "web" });
      if (!outcome.ok) {
        setNotice({
          tone: "error",
          text: `Couldn't start a scan session — ${outcome.reason}.`,
        });
        return;
      }

      // Put the new session in the URL so the run view is shareable and
      // survives a reload, and so the back button leaves the run rather than
      // silently keeping it.
      setSearchParams({ jobId: outcome.jobId });
      setNotice(
        outcome.failed === 0
          ? {
              tone: "success",
              text: `Uploaded ${outcome.uploaded} of ${outcome.total} images.`,
            }
          : {
              tone: "error",
              text: `Uploaded ${outcome.uploaded} of ${outcome.total} images — ${outcome.failed} failed.`,
            },
      );
    } catch (error) {
      console.error("Placeholder upload failed", error);
      setNotice({
        tone: "error",
        text: "Couldn't upload these scans. Please try again.",
      });
    }
  }, [files, setSearchParams, upload, uploading]);

  const handleConfirmAction = useCallback(async () => {
    if (!jobId || !pendingAction) return;
    const action = pendingAction;
    setActionBusy(true);
    try {
      if (action === "close") {
        const result = await closeStream({ jobId });
        setNotice(
          result.closed
            ? {
                tone: "success",
                text: "Session closed. Processing and pairing finish on their own.",
              }
            : {
                tone: "info",
                text: `Session not closed — ${result.reason ?? "it is no longer collecting"}.`,
              },
        );
      } else {
        const result = await cancelBatch({ jobId });
        setNotice(
          result.canceled
            ? {
                tone: "success",
                text: `Session aborted — ${result.canceledCount} queued ${result.canceledCount === 1 ? "image" : "images"} canceled.`,
              }
            : {
                tone: "info",
                text: `Session not aborted — ${result.reason ?? "it had already finished"}.`,
              },
        );
      }
    } catch (error) {
      console.error("Placeholder session action failed", { action, error });
      setNotice({
        tone: "error",
        text:
          action === "close"
            ? "Couldn't close the session. Please try again."
            : "Couldn't abort the session. Please try again.",
      });
    } finally {
      setActionBusy(false);
      setPendingAction(null);
      // The button just pressed disappears when the session leaves its active
      // states, so park focus on the section heading rather than letting it
      // fall to <body>. Deferred a frame: the dialog's unmount cleanup restores
      // focus to its trigger in the same commit, and this has to land after it.
      requestAnimationFrame(() =>
        document.getElementById("session-heading")?.focus(),
      );
    }
  }, [cancelBatch, closeStream, jobId, pendingAction]);

  const canAct = job !== undefined && job !== null && ACTIVE_STATUSES.has(job.status);
  const doneImages = (images ?? []).filter((image) => image.status === "done");
  const unmatched = doneImages.filter(
    (image) => image.pairStatus !== "paired",
  );

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold mb-2">Placeholder Scans</h1>
        <p className="text-slate-400 max-w-2xl">
          Upload scanned card images and see them cropped and matched into
          front/back pairs. Upload them in scan order — front, back, front,
          back — because that order is what pairs them.
        </p>
      </div>

      {/* Always mounted: a live region inserted at the same moment its text
          appears is unreliably announced. `key` remounts it when the tone — and
          therefore the role — changes. */}
      <div
        key={notice?.tone ?? "idle"}
        role={notice?.tone === "error" ? "alert" : "status"}
        aria-live={notice?.tone === "error" ? undefined : "polite"}
        aria-atomic="true"
        className={
          notice ? `rounded-md p-3 text-sm ${NOTICE_CLASSES[notice.tone]}` : ""
        }
      >
        {notice?.text ?? ""}
      </div>

      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          void handleUpload();
        }}
      >
        <label
          htmlFor="scan-files"
          className="block text-sm font-medium text-slate-300"
        >
          Scan images (JPEG)
        </label>
        {/* A raw file input: the Input primitive exists to give TEXT fields a
            document-unique class for the E2E driver, and a file picker is not a
            field it types into. */}
        <input
          id="scan-files"
          type="file"
          accept="image/jpeg"
          multiple
          disabled={uploading}
          onChange={(event) =>
            setFiles(Array.from(event.target.files ?? []))
          }
          className="block w-full text-sm text-slate-300 file:mr-3 file:rounded file:border-0 file:bg-slate-800 file:px-3 file:py-2 file:text-slate-200"
        />
        <p className="text-xs text-slate-400">
          {files.length === 0
            ? "No files selected."
            : `${files.length} file${files.length === 1 ? "" : "s"} selected.`}
        </p>
        <NeonButton type="submit" disabled={files.length === 0 || uploading}>
          {/* Same condition as `disabled` (NEO-128) — the label is the only
              evidence the E2E driver has that a control is inert. */}
          {uploading ? "Uploading..." : "Start Upload"}
        </NeonButton>
      </form>

      {progress.length > 0 && (
        <section aria-labelledby="upload-progress-heading" className="space-y-2">
          <h2 id="upload-progress-heading" className="text-lg font-semibold">
            Upload progress
          </h2>
          <ul className="space-y-1 text-sm">
            {progress.map((row) => (
              <li key={row.position} className="flex flex-wrap gap-2">
                <span className="text-slate-200">{row.name}</span>
                <span className="text-slate-400">
                  {row.state === "pending" && "Waiting"}
                  {row.state === "uploading" && "Uploading…"}
                  {row.state === "uploaded" && `Uploaded (entry ${row.entryIndex})`}
                  {row.state === "failed" && `Failed — ${row.error ?? "unknown error"}`}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {jobId && (
        <section aria-labelledby="session-heading" className="space-y-3">
          {/* The programmatic focus target after Close/Abort, so it needs a
              visible ring of its own — `outline-none` with no replacement left
              a keyboard user with no idea where focus had gone (WCAG 2.4.7). */}
          <h2
            id="session-heading"
            tabIndex={-1}
            className="text-lg font-semibold outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neon-blue"
          >
            Session {jobId.slice(0, 8)}
          </h2>
          <p className="text-sm text-slate-300">
            {job === undefined
              ? "Loading session…"
              : job === null
                ? "Session not found."
                : jobSummary(job)}
          </p>
          {job && (
            <p className="text-sm text-slate-400">
              resolver calls: {resolverCallsOf(job)}
            </p>
          )}
          {job?.errorCode && (
            <p className="text-sm text-neon-pink">Error: {job.errorCode}</p>
          )}
          {canAct && (
            <div className="flex gap-3">
              <NeonButton
                secondary
                type="button"
                onClick={() => setPendingAction("close")}
              >
                Close Session
              </NeonButton>
              <NeonButton
                cancel
                type="button"
                onClick={() => setPendingAction("abort")}
              >
                Abort Session
              </NeonButton>
            </div>
          )}
        </section>
      )}

      {jobId && (
        <section aria-labelledby="images-heading" className="space-y-2">
          <h2 id="images-heading" className="text-lg font-semibold">
            Images
          </h2>
          {images === undefined && (
            <p className="text-sm text-slate-400">Loading images…</p>
          )}
          {images?.length === 0 && (
            <p className="text-sm text-slate-400">
              No images yet. They appear here as each upload is confirmed.
            </p>
          )}
          {images && images.length > 0 && (
            <ul className="space-y-1 text-sm">
              {images.map((image) => (
                <li key={image.entryIndex} className="flex flex-wrap gap-2">
                  <span className="text-slate-400">#{image.entryIndex}</span>
                  <span className="text-slate-200">{image.originalName}</span>
                  <span className="text-slate-400">{imageSummary(image)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {jobId && (
        <section aria-labelledby="pairs-heading" className="space-y-3">
          <h2 id="pairs-heading" className="text-lg font-semibold">
            Matched pairs
          </h2>
          {pairs === undefined && (
            <p className="text-sm text-slate-400">Loading pairs…</p>
          )}
          {pairs?.length === 0 && (
            <p className="text-sm text-slate-400">
              No pairs yet. Pairing runs as images finish processing.
            </p>
          )}
          {pairs && pairs.length > 0 && (
            <ul className="space-y-4">
              {pairs.map((pair) => {
                const identity = [
                  pair.player ?? "Unidentified",
                  pair.cardNumber ? `#${pair.cardNumber}` : null,
                  CONFIDENCE_LABELS[pair.confidence],
                  MECHANISM_LABELS[pair.mechanism],
                ]
                  .filter(Boolean)
                  .join(" · ");
                return (
                  <li
                    key={`${pair.frontIndex}-${pair.backIndex}`}
                    className="rounded-lg border border-slate-800 bg-slate-900/40 p-3"
                  >
                    <p className="mb-2 text-sm text-slate-200">{identity}</p>
                    <div className="flex flex-wrap gap-3">
                      <ScanImage
                        jobId={jobId}
                        entryIndex={pair.frontIndex}
                        alt={`Front of ${pair.player ?? "unidentified card"}`}
                      />
                      <ScanImage
                        jobId={jobId}
                        entryIndex={pair.backIndex}
                        alt={`Back of ${pair.player ?? "unidentified card"}`}
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {unmatched.length > 0 && (
            <div className="space-y-1">
              <h3 className="text-sm font-semibold text-slate-300">
                Unmatched images
              </h3>
              <ul className="space-y-1 text-sm text-slate-400">
                {unmatched.map((image) => (
                  <li key={image.entryIndex}>
                    #{image.entryIndex} {image.originalName}
                    {image.side ? ` — ${image.side} side` : ""}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      {pendingAction === "close" && (
        <ConfirmDialog
          title="Close this scan session?"
          description="No more images can be added. Everything already uploaded finishes processing and pairing on its own."
          confirmLabel="Yes, Close"
          busyLabel="Closing..."
          busy={actionBusy}
          onConfirm={() => void handleConfirmAction()}
          onCancel={() => {
            if (!actionBusy) setPendingAction(null);
          }}
        />
      )}

      {pendingAction === "abort" && (
        <ConfirmDialog
          title="Abort this scan session?"
          description="Every image still queued is canceled and the session is marked failed. You can start a new one straight away."
          confirmLabel="Yes, Abort"
          busyLabel="Aborting..."
          busy={actionBusy}
          onConfirm={() => void handleConfirmAction()}
          onCancel={() => {
            if (!actionBusy) setPendingAction(null);
          }}
        />
      )}
    </div>
  );
}
