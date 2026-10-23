import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { makeFunctionReference, type FunctionReturnType } from "convex/server";
import NeonButton from "@/components/modules/NeonButton";
import { api } from "@/convex/_generated/api";
import {
  formatAbsoluteTime,
  formatRelativeTime,
} from "@/lib/time/relative-time";
import { ConfirmDialog } from "@/components/modules/confirm-dialog";
import { useDocumentTitle } from "@/src/hooks/useDocumentTitle";
import {
  DEFAULT_SORT,
  SORT_OPTIONS,
  STATUS_FILTER_OPTIONS,
  filterRuns,
  progressText,
  sortRuns,
  sourceLabel,
  type RunSource,
  type SortKey,
  type StatusFilter,
} from "./run-view";

/**
 * /admin/pipeline-runs — every user's placeholder pipeline runs, with an abort
 * lever (NEO-170).
 *
 * This page landed top-level at /pipeline-runs, before the NEO-155 /admin
 * section existed, with the move here planned in this very comment. The old
 * URL redirects (src/main.tsx), same as /set-selector — bookmarks from the
 * top-level era keep working, and the page itself did not change.
 *
 * ## What an operator is here to do
 * Answer "is anything wedged, and whose is it", then stop it. That shapes every
 * choice below: newest-first (the server's order — a question about the present
 * is answered at the top of the list), progress as one composed sentence rather
 * than three numbers, and Abort on exactly the runs that can still be stopped.
 *
 * ## Reactivity is the feature, not a nicety
 * `useQuery` holds a live subscription, so a run that finishes, fails, or gets
 * aborted repaints itself without a refresh — an operator watching a stuck batch
 * sees it move the moment it moves. The only thing that does NOT update itself
 * is the relative timestamps, which is what `useNow` below is for.
 *
 * ## Cross-user data on purpose
 * The rows carry other people's `userId`s. That is the whole point of an
 * operator view and it is why the query is `requireAdmin`-gated server-side; see
 * the section comment above `adminListPlaceholderJobs` in
 * convex/placeholderPipeline.ts. The client gate is UX only — `<AdminLayout>`
 * bounces a non-admin to /dashboard and the nav hides the tab, but neither is
 * the boundary.
 */

type PipelineRun = FunctionReturnType<
  typeof api.placeholderPipeline.adminListPlaceholderJobs
>[number];

type RunStatus = PipelineRun["status"];

/** Statuses a run can never leave. Everything else is still abortable. */
const TERMINAL_STATUSES: readonly RunStatus[] = ["succeeded", "failed"];

/**
 * How the badge reads and how it is coloured.
 *
 * Three visual groups, not eight: terminal-good (green), terminal-bad (pink,
 * the app's error colour), and in-flight (yellow for the pipeline stages,
 * blue for the two states that are waiting on a person rather than on us).
 * Colour is never the only carrier — the word is the label.
 */
const STATUS_META: Record<RunStatus, { label: string; className: string }> = {
  pending: { label: "Pending", className: "bg-rule text-ink-2" },
  uploaded: { label: "Uploaded", className: "bg-rule text-ink-2" },
  collecting: {
    label: "Collecting",
    className: "bg-neon-blue/15 text-neon-blue-text",
  },
  extracting: {
    label: "Extracting",
    className: "bg-neon-yellow/15 text-neon-yellow-text",
  },
  processing: {
    label: "Processing",
    className: "bg-neon-yellow/15 text-neon-yellow-text",
  },
  pairing: { label: "Pairing", className: "bg-neon-yellow/15 text-neon-yellow-text" },
  succeeded: {
    label: "Succeeded",
    className: "bg-neon-green/15 text-neon-green-text",
  },
  failed: { label: "Failed", className: "bg-neon-pink/15 text-neon-pink-text" },
};

const MODE_LABELS: Record<PipelineRun["mode"], string> = {
  zip: "Zip upload",
  stream: "Scanner stream",
};

/**
 * How a run was started, read tolerantly.
 *
 * `source` is being added to `adminListPlaceholderJobs`'s validator in a
 * concurrent backend change, so the generated return type does not carry it yet.
 * The cast lets the page render the field the moment the backend ships it,
 * without a follow-up edit here; until then every row reads `undefined` and
 * shows an em dash, which is exactly the "absent" rendering.
 */
function sourceOf(run: PipelineRun): RunSource | undefined {
  return (run as PipelineRun & { source?: RunSource }).source;
}

/**
 * A typed reference to the owner-label resolver, by string.
 *
 * `adminUsers.adminResolveOwnerLabels` exists in convex/ but the generated
 * `api` types do not carry it yet (codegen is a concurrent backend step, and
 * this worktree never runs it). `makeFunctionReference` names the function
 * directly with the signature it will have — so this typechecks now and calls
 * the real action at runtime, rather than reaching through an `any`.
 */
const resolveOwnerLabelsRef = makeFunctionReference<
  "action",
  { userIds: string[] },
  Record<string, string>
>("adminUsers:adminResolveOwnerLabels");

/** How often the relative timestamps re-derive. */
const TICK_MS = 30_000;

/**
 * A job id is a UUID; eight characters is enough to tell runs apart on screen
 * and short enough to read out loud. The full id stays in the row's `title` for
 * anyone correlating with a log line.
 */
function shortJobId(jobId: string): string {
  return jobId.slice(0, 8);
}

/**
 * One instant, re-derived on a timer.
 *
 * Relative labels are the one thing on this page Convex cannot invalidate: a run
 * that stops moving stops producing updates, which is exactly when "how long has
 * it been stuck" matters most. Without this tick, a wedged run's "2m ago" would
 * still read "2m ago" an hour later — the page would look fresh while telling
 * the operator nothing.
 */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

type Notice = { tone: "success" | "info" | "error"; text: string };

const NOTICE_CLASSES: Record<Notice["tone"], string> = {
  success: "border border-neon-green/40 bg-neon-green/10 text-neon-green-text",
  info: "border border-neon-blue/40 bg-neon-blue/10 text-neon-blue-text",
  error: "border border-neon-pink/40 bg-neon-pink/10 text-neon-pink-text",
};

export default function PipelineRunsPage() {
  useDocumentTitle("Pipeline Runs | Neon Binder");

  const runs = useQuery(api.placeholderPipeline.adminListPlaceholderJobs);
  const abortRun = useMutation(
    api.placeholderPipeline.adminCancelPlaceholderBatch,
  );
  const resolveOwnerLabels = useAction(resolveOwnerLabelsRef);

  const [pendingAbort, setPendingAbort] = useState<PipelineRun | null>(null);
  const [aborting, setAborting] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [sortKey, setSortKey] = useState<SortKey>(DEFAULT_SORT);
  const now = useNow(TICK_MS);

  // Owner id → human label (email/username/name), filled by one admin action
  // call per NEW distinct id. The label is a nicety; the id is always the
  // fallback, so a row never renders blank.
  const [ownerLabels, setOwnerLabels] = useState<Record<string, string>>({});
  // Ids already sent to the resolver, so the reactive query's polling does not
  // re-request the same set every tick. A ref, not state — changing it must not
  // itself trigger a render, or that is the render loop.
  const requestedOwnerIds = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!runs) return;
    const unseen = Array.from(new Set(runs.map((run) => run.userId))).filter(
      (id) => !requestedOwnerIds.current.has(id),
    );
    if (unseen.length === 0) return;
    // Mark BEFORE awaiting so a poll landing mid-flight does not re-request the
    // same ids. Only re-resolution of a genuinely new id ever calls out.
    unseen.forEach((id) => requestedOwnerIds.current.add(id));

    let cancelled = false;
    void (async () => {
      try {
        const labels = await resolveOwnerLabels({ userIds: unseen });
        if (!cancelled) {
          setOwnerLabels((previous) => ({ ...previous, ...labels }));
        }
      } catch {
        // The action degrades to ids on its own, but a thrown call (network,
        // auth) resolved nothing — drop these ids from "requested" so a later
        // poll can retry rather than leaving them permanently on the raw id.
        unseen.forEach((id) => requestedOwnerIds.current.delete(id));
      }
    })();
    return () => {
      cancelled = true;
    };
    // `resolveOwnerLabels` is intentionally NOT a dependency: useAction returns
    // a fresh identity each render, and depending on it re-runs this effect in a
    // loop (the documented Convex useAction-in-effect trap). The work is keyed
    // on `runs`, and the ref guard makes a redundant run a no-op.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runs]);

  const visibleRuns = useMemo(
    () => (runs ? sortRuns(filterRuns(runs, statusFilter), sortKey) : []),
    [runs, statusFilter, sortKey],
  );

  const handleConfirmAbort = useCallback(async () => {
    if (!pendingAbort) return;
    const run = pendingAbort;
    const short = shortJobId(run.jobId);
    setAborting(true);
    try {
      const result = await abortRun({ jobId: run.jobId });
      setPendingAbort(null);
      if (result.canceled) {
        const count = result.canceledCount;
        setNotice({
          tone: "success",
          text: `Aborted run ${short} — ${count} queued ${count === 1 ? "image" : "images"} canceled.`,
        });
      } else {
        // A soft no-op, not a failure: the run reached a terminal state between
        // the list painting and the click landing. Colouring that red would tell
        // an operator something is broken when nothing is.
        setNotice({
          tone: "info",
          text: `Run ${short} was not aborted — ${result.reason ?? "it had already finished"}.`,
        });
      }
    } catch (error) {
      console.error("Failed to abort placeholder run", {
        jobId: run.jobId,
        error,
      });
      setPendingAbort(null);
      setNotice({
        tone: "error",
        text: `Couldn't abort run ${short}. Please try again.`,
      });
    } finally {
      setAborting(false);
      // The Abort button the operator was standing on unmounts the moment the
      // row turns terminal, which would drop focus to <body>. The run's own
      // heading is the nearest thing that survives, and it is where their
      // attention already is.
      //
      // Deferred a frame on purpose: closing the dialog and this call happen in
      // the same tick, so a direct call would be undone by the dialog's own
      // unmount cleanup restoring focus to the (still-mounted) Abort button
      // milliseconds later. rAF runs after that commit.
      requestAnimationFrame(() =>
        document.getElementById(`run-${run.jobId}-heading`)?.focus(),
      );
    }
  }, [abortRun, pendingAbort]);

  return (
    <div className="space-y-6">
      <div>
        {/* h2, not h1 — the Admin section layout above owns the page's one
            h1, same as every other admin panel. */}
        <h2 className="text-lg font-semibold mb-2">Pipeline Runs</h2>
        <p className="text-ink-3 max-w-2xl">
          Every user&apos;s placeholder pipeline runs. Abort a run that is
          wedged — the owner can start it again from their upload.
        </p>
      </div>

      {/* Always mounted. A live region inserted at the same moment its text
          appears is unreliably announced (notably VoiceOver), so the node exists
          from first paint and only its content changes. `key` remounts it when
          the tone — and therefore the role — flips, because screen readers do
          not reliably re-evaluate a live region whose role changed in place. */}
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

      {runs === undefined && (
        <p className="text-sm text-ink-3">Loading pipeline runs…</p>
      )}

      {runs !== undefined && runs.length === 0 && (
        <p className="text-sm text-ink-3">
          No pipeline runs yet. Placeholder uploads and scanner sessions appear
          here as soon as they start.
        </p>
      )}

      {runs !== undefined && runs.length > 0 && (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          {/* Status filter as a chip GROUP, not a second <select>: the headless
              E2E driver can only reach the first <select> on a page, so the sort
              control below takes that slot and the filter is buttons — each
              addressable by its visible label. Fixed option set (STATUS_FILTER
              _OPTIONS) so the chips do not change shape as runs come and go. */}
          <div
            role="group"
            aria-label="Filter by status"
            className="flex flex-wrap gap-2"
          >
            {STATUS_FILTER_OPTIONS.map((option) => {
              const active = statusFilter === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setStatusFilter(option.value)}
                  // The shared chip roles (NEO-356): a neutral chip with a
                  // control edge at rest, chip-strong under the pointer, and
                  // the pressed one lit as a neon sign, green with black ink.
                  className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-colors focus-outline ${
                    active
                      ? "border-neon-green bg-neon-green text-on-neon-green font-semibold"
                      : "border-control bg-chip text-ink-2 hover:bg-chip-strong hover:text-ink"
                  }`}
                >
                  {/* A non-colour cue for the active chip (a11y audit, WCAG
                      1.4.1): colour alone must not carry the pressed state.
                      The check is hidden from AT — aria-pressed already
                      carries the state name. */}
                  {active && <span aria-hidden="true">✓ </span>}
                  {option.label}
                </button>
              );
            })}
          </div>

          <div className="flex items-center gap-2">
            <label htmlFor="run-sort" className="text-sm text-ink-3">
              Sort by
            </label>
            <select
              id="run-sort"
              value={sortKey}
              onChange={(event) => setSortKey(event.target.value as SortKey)}
              className="rounded-md border border-field-rule bg-field px-2 py-1 text-sm text-ink-2 focus-outline"
            >
              {SORT_OPTIONS.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      {/* The filter/sort act on the loaded page only — adminListPlaceholderJobs
          returns the most recent runs (capped at 100), so a filtered view can be
          incomplete for a status with older runs off the end of the list. Said
          plainly here rather than left as a trap. */}
      {runs !== undefined && runs.length > 0 && (
        <p className="text-xs text-ink-3">
          Showing the {runs.length} most recent runs (up to 100). Filters and
          sorting apply to these, not the full history.
        </p>
      )}

      {/* A polite live region, always mounted, so selecting a filter that
          matches nothing is ANNOUNCED rather than leaving a screen-reader user
          to discover the emptied list by navigating into it (WCAG 4.1.3). Mirrors
          the notice-banner pattern above. */}
      <div role="status" aria-live="polite" aria-atomic="true">
        {runs !== undefined && runs.length > 0 && visibleRuns.length === 0 && (
          <p className="text-sm text-ink-3">
            No runs match this filter. Choose “All” to see every loaded run.
          </p>
        )}
      </div>

      {runs !== undefined && visibleRuns.length > 0 && (
        // A list of rows rather than a <table>: at the 1024px-wide headless
        // viewport, minus the tab rail, the columns — one of them a Clerk user
        // id — do not fit, and a table that scrolls sideways puts the Abort
        // button somewhere the E2E driver cannot reach (it cannot scroll
        // horizontally). Same data, no horizontal overflow.
        <ul className="space-y-3">
          {visibleRuns.map((run) => {
            const isTerminal = TERMINAL_STATUSES.includes(run.status);
            const status = STATUS_META[run.status];
            const short = shortJobId(run.jobId);
            const ownerLabel = ownerLabels[run.userId] ?? run.userId;
            return (
              <li
                key={run.jobId}
                className="rounded-lg border border-rule bg-raised-deep/40 p-4"
              >
                <div className="flex flex-wrap items-center gap-3 mb-3">
                  <h3
                    id={`run-${run.jobId}-heading`}
                    tabIndex={-1}
                    title={run.jobId}
                    // Focus lands here after every abort attempt, so it needs a
                    // ring of its own — `outline-none` alone left a keyboard
                    // user with no idea where focus went (WCAG 2.4.7).
                    className="font-mono text-base font-semibold outline-none focus-outline"
                  >
                    Run {short}
                  </h3>
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${status.className}`}
                  >
                    {status.label}
                  </span>
                  <span className="ml-auto">
                    {!isTerminal && (
                      <NeonButton
                        variant="negative"
                        size="1"
                        type="button"
                        // The visible word is "Abort" on every row, so the
                        // accessible name has to say WHICH run — otherwise a
                        // screen reader user hears the same button twenty times.
                        aria-label={`Abort run ${short}`}
                        onClick={() => setPendingAbort(run)}
                      >
                        Abort
                      </NeonButton>
                    )}
                  </span>
                </div>

                <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1 text-sm">
                  <div className="flex gap-2">
                    <dt className="text-ink-3">Owner</dt>
                    {/* The resolved human label, with the raw Clerk id kept on
                        `title` for support. Falls back to the id itself until
                        (or if) resolution returns, so it is never blank.

                        When a name resolved, the id is folded into the
                        accessible name too — a `title` tooltip is mouse-only, so
                        a keyboard/AT user correlating a run with a log line
                        would otherwise never reach the id (the `<time>` cells
                        below do the same, for the same reason). When the label
                        IS the id, there is nothing extra to announce. */}
                    <dd
                      className="text-ink-2 break-all"
                      title={run.userId}
                      aria-label={
                        ownerLabel === run.userId
                          ? undefined
                          : `${ownerLabel} (id ${run.userId})`
                      }
                    >
                      {ownerLabel}
                    </dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="text-ink-3">Mode</dt>
                    <dd className="text-ink-2">{MODE_LABELS[run.mode]}</dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="text-ink-3">Source</dt>
                    <dd>
                      {/* Text label, never colour alone. Neutral chip so it
                          reads as metadata, not a status. */}
                      <span className="rounded-full bg-rule px-2 py-0.5 text-xs font-medium text-ink-2">
                        {sourceLabel(sourceOf(run))}
                      </span>
                    </dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="text-ink-3">Progress</dt>
                    <dd className="text-ink-2">{progressText(run)}</dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="text-ink-3">Created</dt>
                    <dd className="text-ink-2">
                      {/* The exact timestamp is in the accessible name as well
                          as the `title`: a native tooltip is mouse-only, and
                          "3h ago" is not enough to line a run up against a log
                          line. */}
                      <time
                        dateTime={new Date(run.createdAt).toISOString()}
                        title={formatAbsoluteTime(run.createdAt)}
                        aria-label={`${formatRelativeTime(run.createdAt, now)} (${formatAbsoluteTime(run.createdAt)})`}
                      >
                        {formatRelativeTime(run.createdAt, now)}
                      </time>
                    </dd>
                  </div>
                  {run.lastActivityAt !== undefined && (
                    <div className="flex gap-2">
                      <dt className="text-ink-3">Last activity</dt>
                      <dd className="text-ink-2">
                        <time
                          dateTime={new Date(run.lastActivityAt).toISOString()}
                          title={formatAbsoluteTime(run.lastActivityAt)}
                          aria-label={`${formatRelativeTime(run.lastActivityAt, now)} (${formatAbsoluteTime(run.lastActivityAt)})`}
                        >
                          {formatRelativeTime(run.lastActivityAt, now)}
                        </time>
                      </dd>
                    </div>
                  )}
                  {run.errorCode !== undefined && (
                    <div className="flex gap-2">
                      <dt className="text-ink-3">Error</dt>
                      <dd className="font-mono text-neon-pink-text">
                        {run.errorCode}
                      </dd>
                    </div>
                  )}
                </dl>
              </li>
            );
          })}
        </ul>
      )}

      {pendingAbort && (
        <ConfirmDialog
          title={`Abort run ${shortJobId(pendingAbort.jobId)}?`}
          description="Every image still queued for this run is canceled and the run is marked failed. The owner can start it again from their upload."
          confirmLabel="Yes, Abort"
          busyLabel="Aborting..."
          busy={aborting}
          onConfirm={() => void handleConfirmAbort()}
          onCancel={() => {
            if (!aborting) setPendingAbort(null);
          }}
        />
      )}
    </div>
  );
}
