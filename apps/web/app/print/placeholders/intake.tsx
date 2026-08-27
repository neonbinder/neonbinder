import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { useAction, useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import NeonButton from "@/components/modules/NeonButton";
import { ConfirmDialog } from "@/components/modules/confirm-dialog";
import { api } from "@/convex/_generated/api";
import { classifyIntake } from "@/lib/placeholders/intake-kind";
import { deriveStage } from "@/lib/placeholders/intake-stage";
import { Dropzone } from "./dropzone";
import { ReviewGrid, type ReviewPair } from "./review-grid";
import { PrintRun, type PrintablePair } from "./print-run";
import { ScanImage } from "./scan-image";
import { usePlaceholderUpload } from "@/src/hooks/usePlaceholderUpload";
import { useWarmPreprocess } from "@/src/hooks/useWarmPreprocess";

/**
 * Card intake — the working front door for placeholder sheets (NEO-152).
 *
 * Replaces the /placeholders stopgap this file grew out of. That page said
 * outright it was temporary ("expect NEO-152 to replace rather than extend
 * it"), and most of what it learned is preserved here rather than rewritten:
 * the addressable job id, the reactive job/images/pairs subscriptions, the
 * cold-start notice and the signed-URL re-minting in ScanImage all arrived
 * there first and all still earn their place.
 *
 * ## One control, two server paths
 * The user drops a zip OR a pile of photos and never picks a mode.
 * `classifyIntake` (lib/placeholders/intake-kind.ts) decides which path runs,
 * and both return the same `UploadOutcome`, so everything from the progress
 * line onward renders identically. A zip is extracted server-side into the same
 * per-image rows a scan produces; from the workpool onward there is one
 * pipeline, not two.
 *
 * ## The job id lives in the URL
 * A batch runs for MINUTES, so it has to survive the tab closing. `?jobId=`
 * makes a run addressable and reloadable; `listMyPlaceholderJobs` covers the
 * other half — returning to the page with no URL and still finding the run.
 * Component state would make a run reachable only by having just created it,
 * which is the one thing intake must not do.
 *
 * ## Why the upload loop lives in lib/placeholders/upload-run.ts
 * Pairing reads adjacency — entry 0 is the front whose back is entry 1 — so the
 * ORDER of the allocate calls is a correctness constraint, not a performance
 * detail. That constraint is testable and is tested there; this file only wires
 * Convex actions into it.
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
  // Added to the backend union when manual pairing landed, and never given a
  // label here — a manually-forced pair rendered `undefined` in the mechanism
  // slot. "you set this" rather than "manual" because the badge sits next to
  // two machine-made explanations and the useful distinction is who decided.
  manual: "you set this",
};

type Notice = { tone: "success" | "info" | "error"; text: string };

const NOTICE_CLASSES: Record<Notice["tone"], string> = {
  success: "border border-neon-green/40 bg-neon-green/10 text-neon-green",
  info: "border border-neon-blue/40 bg-neon-blue/10 text-neon-blue",
  error: "border border-neon-pink/40 bg-neon-pink/10 text-neon-pink",
};


function imageSummary(image: PlaceholderImage): string {
  if (image.status === "failed") {
    return image.errorCode ? `Failed (${image.errorCode})` : "Failed";
  }
  // An escalated image still processing is on the heavy service — surface that
  // it is taking the deeper path rather than showing a bare "Processing" that
  // looks stuck while the heavy model warms.
  if (image.status === "processing" && image.escalated) {
    return "Escalating — deeper processing…";
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


export default function CardIntake() {
  // Warm the model on mount, so it is loading while the user picks files rather
  // than only from the first upload. Best-effort; see the hook.
  useWarmPreprocess();

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
  /**
   * Pairs the user has taken OUT of the print run, keyed `front-back`.
   *
   * Client-side by decision (2026-08-25): a print run is an ephemeral act, and
   * persisting it costs a schema field, a mutation and an auth check to buy
   * surviving a reload of the page you are actively printing from. Lifted to
   * the page rather than kept in the grid because the pocket preview — and the
   * print hand-off in the next stage — both have to read the same set.
   */
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(new Set());
  const toggleExcluded = useCallback((key: string) => {
    setExcluded((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

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

  /**
   * Selecting files IS starting the upload — there is no confirm step.
   *
   * Takes the list as an argument rather than reading `files` state: this runs
   * straight out of the drop/change handler, where a `setFiles` in the same
   * tick has not flushed yet, so reading state here would upload the PREVIOUS
   * selection (nothing, the first time).
   */
  const handleUpload = useCallback(
    async (chosen: File[]) => {
    if (chosen.length === 0 || uploading) return;
    setNotice(null);

    try {
      // Label the run web-originated (NEO-170); the cardlister CLI passes
      // "scanner" on its own start path.
      const outcome = await upload(chosen, { source: "web" });
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
      // Clear the tray: these are on the server now, and leaving them listed
      // as "ready to upload" invites a second, duplicate send.
      setFiles([]);
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
    },
    [setSearchParams, upload, uploading],
  );

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

  // The cold-start notice is now the split-aware `heavyWarming` flag the backend
  // derives (NEO-175, `deriveHeavyWarming`), which replaces the old single-
  // service "queued but nothing started" heuristic. The fast service cold-starts
  // in seconds and every card streams through it independently, so it no longer
  // warrants a prominent notice; the multi-minute wait is the HEAVY service's
  // ~191s warm-up, and this flag is true only while an escalated image is
  // actually waiting on it. Scoped to escalations by construction — a batch that
  // never escalates never shows it, and it clears the instant the first
  // escalated image resolves (proof the heavy service is warm).
  const warmingUp = job?.heavyWarming ?? false;

  const stage = deriveStage({ job, images, uploading, selectedCount: files.length });
  const settledCount = (images ?? []).filter(
    (i) => i.status === "done" || i.status === "failed",
  ).length;
  const totalCount = (images ?? []).length;
  const failedCount = (images ?? []).filter((i) => i.status === "failed").length;
  const inFlight = (images ?? []).filter(
    (i) => i.status !== "done" && i.status !== "failed",
  );

  return (
    <div className="space-y-8">
      <div>
        {/* h3: PrintLayout owns the h1 and the page owns the h2 (NEO-145). */}
        <h3 className="text-2xl font-bold mb-2">Upload your cards</h3>
        <p className="text-slate-400 max-w-2xl">
          Photograph the cards you want placeholders for, then drop them here.
          They are cropped and matched into front/back pairs, nine to a sheet.
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

      {/* Adding is always available while the batch is open — that is what a
          scanner session IS — so the dropzone does not disappear once a run
          starts. It is hidden only when there is nothing left to add to. */}
      {stage !== "done" && stage !== "failed" && stage !== "finishing" && (
        <Dropzone
          files={files}
          disabled={uploading}
          onFiles={(chosen) => {
            setFiles(chosen);
            // A refusal (two zips, or a zip mixed with photos) must NOT upload;
            // the dropzone renders the reason from the same classification.
            if (classifyIntake(chosen).kind === "invalid") return;
            void handleUpload(chosen);
          }}
        />
      )}

      {jobId && (
        <section aria-labelledby="session-heading" className="space-y-4">
          {/* The programmatic focus target after finishing or discarding, so it
              needs a visible ring of its own — `outline-none` with no
              replacement left a keyboard user with no idea where focus had gone
              (WCAG 2.4.7). */}
          <h3
            id="session-heading"
            tabIndex={-1}
            className="text-lg font-semibold focus-visible:ring-2 focus-visible:ring-neon-purple rounded"
          >
            {stage === "done"
              ? "Your cards are ready"
              : stage === "failed"
                ? "This batch stopped"
                : "Your cards"}
          </h3>

          {/* ONE sentence saying what is happening, and one saying what to do.
              This is the whole answer to "how would a new user know to wait?" */}
          <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-4 space-y-2">
            <p role="status" aria-live="polite" className="text-slate-200">
              {stage === "uploading" && "Sending your photos…"}
              {stage === "working" &&
                (totalCount === 0
                  ? "Getting your photos ready…"
                  : `Reading your cards — ${settledCount} of ${totalCount} done.`)}
              {stage === "waiting" &&
                `All ${totalCount} photo${totalCount === 1 ? "" : "s"} read.`}
              {stage === "finishing" && "Matching up the last pairs…"}
              {stage === "done" &&
                `${pairs?.length ?? 0} pair${(pairs?.length ?? 0) === 1 ? "" : "s"} ready to print.`}
              {stage === "failed" && failureHeadline(job)}
            </p>
            <p className="text-sm text-slate-400">
              {stage === "working" &&
                "Pairs appear below as each card finishes. This takes a few minutes — you can close this tab and come back to it."}
              {stage === "waiting" &&
                "Add more photos above, or finish the batch when you have everything."}
              {stage === "finishing" && "Almost done. Nothing else to do."}
              {stage === "done" && "Check the pairs below before you print."}
              {stage === "failed" && failureAdvice(job)}
            </p>

            {/* Finishing is a real decision, so it is offered plainly and only
                becomes the primary action once there is nothing still running.
                While work is in flight it stays secondary — pressing it then is
                legitimate but rarely what someone means. */}
            {canAct && (
              <div className="flex flex-wrap gap-3 pt-1">
                <NeonButton
                  type="button"
                  secondary={stage !== "waiting"}
                  onClick={() => setPendingAction("close")}
                >
                  {stage === "waiting" ? "Finish the batch" : "Finish now"}
                </NeonButton>
                <button
                  type="button"
                  onClick={() => setPendingAction("abort")}
                  className="text-sm text-slate-400 underline hover:text-neon-pink p-2 -m-2"
                >
                  Discard this batch
                </button>
              </div>
            )}
          </div>

          {/* A heavy-service warm-up is expected, not a fault — info-toned, and
              the sentence carries the meaning so it is not colour-only. */}
          {warmingUp && (
            <p
              role="status"
              aria-live="polite"
              className="flex items-center gap-2 rounded-md border border-neon-blue/40 bg-neon-blue/10 p-3 text-sm text-neon-blue"
            >
              <span
                aria-hidden="true"
                className="inline-block h-2 w-2 shrink-0 animate-pulse rounded-full bg-neon-blue"
              />
              A few of these need a closer look, which takes a couple of minutes
              the first time. The rest keep coming in below.
            </p>
          )}

          {/* STILL READING. Only in-flight rows — a finished card appears
              below, as a pair or as an unmatched image, and listing it here too
              was one of the duplications that made this page hard to scan.
              This is also where an escalated card announces itself: without it
              a photo on the slow path looks identical to one that is stuck. */}
          {inFlight.length > 0 && (
            <section aria-labelledby="still-reading-heading" className="space-y-2">
              <h3 id="still-reading-heading" className="text-lg font-semibold">
                Still reading ({inFlight.length})
              </h3>
              <ul className="space-y-1 text-sm list-none p-0">
                {inFlight.map((image) => (
                  <li key={image.entryIndex} className="flex flex-wrap gap-2">
                    <span className="text-slate-300">{image.originalName}</span>
                    <span className="text-slate-500">{imageSummary(image)}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* Review runs DURING processing, not after it.
              A set upload is hundreds of cards and many minutes; nobody waits
              for the batch to finish before starting to correct it. That used
              to be unsafe — `unpairPlaceholderImages` only deleted the pair
              row, so the next incremental pass re-formed it — and is now safe
              because a split is recorded on both images (`unpairedFrom`) and
              hard-rejected by the pool. User decisions are durable while the
              matcher's own guesses stay fluid. */}
          {pairs && (pairs.length > 0 || unmatched.length > 0) && (
            <ReviewGrid
              jobId={jobId}
              pairs={pairs as ReviewPair[]}
              images={images ?? []}
              excluded={excluded}
              onToggleExcluded={toggleExcluded}
            />
          )}

          {/* Print last, and only what survived review — the printable grid IS
              the preview now, so a dropped pair simply leaves it and the
              pockets close up, which is what the sheet does too. There is no
              second grid above to keep in step. */}
          {pairs && pairs.length > 0 && (
            <PrintRun
              jobId={jobId}
              pairs={
                (pairs as PrintablePair[]).filter(
                  (p) => !excluded.has(`${p.frontIndex}-${p.backIndex}`),
                )
              }
            />
          )}

          {/* Photos the cropper could not read at all — distinct from unmatched,
              and actionable in a different way (re-shoot, not re-pair). */}
          {failedCount > 0 && (
            <details className="text-sm text-slate-400">
              <summary className="cursor-pointer">
                {failedCount} photo{failedCount === 1 ? "" : "s"} couldn&apos;t be
                read
              </summary>
              <ul className="mt-2 space-y-1 list-none p-0">
                {(images ?? [])
                  .filter((i) => i.status === "failed")
                  .map((image) => (
                    <li key={image.entryIndex}>{image.originalName}</li>
                  ))}
              </ul>
              <p className="mt-2 text-xs text-slate-500">
                Usually a blurry or very dark photo. Re-shoot those and add them
                to a new batch.
              </p>
            </details>
          )}

          {/* The id is support information, not a heading. Kept, small and
              selectable, because it is what identifies a run in a bug report. */}
          <p className="text-xs text-slate-600 font-mono select-all">{jobId}</p>
        </section>
      )}

      {pendingAction === "close" && (
        <ConfirmDialog
          title="Finish this batch?"
          description="No more photos can be added after this. Everything already uploaded finishes on its own."
          confirmLabel="Finish it"
          busyLabel="Finishing..."
          busy={actionBusy}
          onConfirm={() => void handleConfirmAction()}
          onCancel={() => setPendingAction(null)}
        />
      )}

      {pendingAction === "abort" && (
        <ConfirmDialog
          title="Discard this batch?"
          description="Everything in it is thrown away, including cards already matched. This cannot be undone."
          confirmLabel="Discard it"
          busyLabel="Discarding..."
          busy={actionBusy}
          onConfirm={() => void handleConfirmAction()}
          onCancel={() => setPendingAction(null)}
        />
      )}
    </div>
  );
}

/** Plain-language headline for a stopped batch — never an error code. */
function failureHeadline(job: PlaceholderJob | null | undefined): string {
  if (!job) return "This batch stopped.";
  // Cancelling writes status "failed" with errorCode CANCELED — there is no
  // "canceled" status on the job row. Reading the status here would have
  // shown a discarded batch the generic "stopped before it finished" copy.
  if (job.errorCode === "CANCELED") return "You discarded this batch.";
  switch (job.errorCode) {
    case "CANCELED":
      return "You discarded this batch.";
    case "TOO_MANY_IMAGE_FAILURES":
      return "Most of these photos couldn't be read.";
    case "WEDGED":
      return "This batch stalled and was stopped.";
    case "INPUT_NOT_FOUND":
      return "The upload didn't arrive.";
    default:
      return "This batch stopped before it finished.";
  }
}

/** What to actually do about it. An error that offers no next step is a dead end. */
function failureAdvice(job: PlaceholderJob | null | undefined): string {
  if (!job || job.errorCode === "CANCELED")
    return "Start a new batch when you're ready.";
  switch (job.errorCode) {
    case "TOO_MANY_IMAGE_FAILURES":
      return "Cards need to be in focus and well lit, one card per photo. Re-shoot them and start a new batch.";
    case "INPUT_NOT_FOUND":
      return "Try uploading again — the file never reached us.";
    default:
      return "Start a new batch. If it keeps happening, send us the id below.";
  }
}
